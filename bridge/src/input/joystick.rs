//! Joystick / gamepad button polling via the Windows HID API.
//!
//! Uses Win32 HID functions (SetupDi + HidD/HidP) which enumerate all HID
//! game-controllers and expose up to 128 buttons — unlike the legacy
//! joyGetPosEx / WinMM API which only exposes 32 buttons.
//!
//! Input reports are read with overlapped (async) ReadFile so the 500 Hz
//! polling thread never blocks. HidD_GetInputReport is intentionally NOT used
//! because the HID spec makes it optional and most controllers don't support it.
//!
//! Button index mapping (1-based, matching Fred's Controller Tester):
//!   config.json `"button": N`  →  HID Usage = N  →  bit (N-1) in u128 mask
//!   Example: "button": 15  →  HID Usage 15  →  bit 14

/// Info about a single found HID game controller (returned by JoystickMonitor::controller_info()).
#[derive(Clone, Debug)]
pub struct JoystickControllerInfo {
    pub index: u32,
    pub name: String,
    pub button_count: u32, // max button usage number seen in caps
    pub connected: bool,   // was found and opened successfully
}

// =============================================================================
// Windows implementation
// =============================================================================

#[cfg(target_os = "windows")]
mod imp {
    use std::collections::HashMap;
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;

    use windows_sys::Win32::{
        Devices::{
            DeviceAndDriverInstallation::{
                SetupDiDestroyDeviceInfoList, SetupDiEnumDeviceInterfaces,
                SetupDiGetClassDevsW, SetupDiGetDeviceInterfaceDetailW,
                SP_DEVICE_INTERFACE_DATA, SP_DEVICE_INTERFACE_DETAIL_DATA_W,
                DIGCF_DEVICEINTERFACE, DIGCF_PRESENT,
            },
            HumanInterfaceDevice::{
                HidD_FreePreparsedData, HidD_GetPreparsedData, HidD_GetProductString,
                HidP_GetButtonCaps, HidP_GetCaps, HidP_GetUsages,
                HidP_Input, HIDP_BUTTON_CAPS, HIDP_CAPS, PHIDP_PREPARSED_DATA,
            },
        },
        Foundation::{CloseHandle, GetLastError, HANDLE, INVALID_HANDLE_VALUE},
        Storage::FileSystem::{
            CreateFileW, ReadFile, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
        },
        System::{
            IO::{CancelIo, GetOverlappedResult, OVERLAPPED},
            Threading::{CreateEventW, ResetEvent, WaitForSingleObject},
        },
    };

    // GUID_DEVINTERFACE_HID = {4D1E55B2-F16F-11CF-88CB-001111000030}
    const GUID_DEVINTERFACE_HID: windows_sys::core::GUID = windows_sys::core::GUID {
        data1: 0x4D1E_55B2,
        data2: 0xF16F,
        data3: 0x11CF,
        data4: [0x88, 0xCB, 0x00, 0x11, 0x11, 0x00, 0x00, 0x30],
    };

    const HID_USAGE_PAGE_GENERIC: u16 = 0x01;
    const HID_USAGE_JOYSTICK: u16    = 0x04;
    const HID_USAGE_GAMEPAD: u16     = 0x05;
    const HID_USAGE_PAGE_BUTTON: u16 = 0x09;
    const HIDP_STATUS_SUCCESS: i32   = 0x0011_0000u32 as i32;
    // HIDP_STATUS_BUFFER_TOO_SMALL — means fewer buttons than capacity were pressed; still valid.
    const HIDP_STATUS_BUFFER_TOO_SMALL: i32 = 0x0011_0003u32 as i32;

    const GENERIC_READ: u32       = 0x8000_0000;
    const FILE_FLAG_OVERLAPPED: u32 = 0x4000_0000;
    const ERROR_IO_PENDING: u32    = 997;
    const ERROR_IO_INCOMPLETE: u32 = 996;
    const WAIT_OBJECT_0: u32       = 0;

    // -------------------------------------------------------------------------
    // Internal HID device handle (overlapped I/O)
    // -------------------------------------------------------------------------

    struct HidJoystick {
        handle:      HANDLE,
        preparsed:   PHIDP_PREPARSED_DATA,
        report_len:  u32,
        button_caps: Vec<HIDP_BUTTON_CAPS>,
        button_count: u32,  // max button usage number seen in caps
        name:        String,
        // Overlapped I/O — Box keeps OVERLAPPED at a fixed heap address while
        // a ReadFile is in flight.
        overlapped:   Box<OVERLAPPED>,
        event_handle: HANDLE,
        read_buf:     Vec<u8>,
        read_pending: bool,
        pub last_mask: u128,
    }

    impl Drop for HidJoystick {
        fn drop(&mut self) {
            unsafe {
                if self.read_pending {
                    CancelIo(self.handle);
                }
                if !self.event_handle.is_null() && self.event_handle != INVALID_HANDLE_VALUE {
                    CloseHandle(self.event_handle);
                }
                if self.preparsed != 0 {
                    HidD_FreePreparsedData(self.preparsed);
                }
                if !self.handle.is_null() && self.handle != INVALID_HANDLE_VALUE {
                    CloseHandle(self.handle);
                }
            }
        }
    }

    // SAFETY: HANDLE is just a pointer; we ensure exclusive access via the
    // single 500 Hz polling thread.
    unsafe impl Send for HidJoystick {}

    // -------------------------------------------------------------------------
    // Parse button bitmask from a filled HID input report buffer.
    // -------------------------------------------------------------------------

    fn parse_buttons(
        buf:         &[u8],
        button_caps: &[HIDP_BUTTON_CAPS],
        preparsed:   PHIDP_PREPARSED_DATA,
        report_len:  u32,
    ) -> u128 {
        let mut mask: u128 = 0;
        unsafe {
            for cap in button_caps {
                if cap.UsagePage != HID_USAGE_PAGE_BUTTON {
                    continue;
                }

                let (usage_min, usage_max) = if cap.IsRange != 0 {
                    (cap.Anonymous.Range.UsageMin, cap.Anonymous.Range.UsageMax)
                } else {
                    (cap.Anonymous.NotRange.Usage, cap.Anonymous.NotRange.Usage)
                };

                let count = usage_max.saturating_sub(usage_min) as u32 + 1;
                let mut usages = vec![0u16; count as usize];
                let mut usage_len = count;

                let status = HidP_GetUsages(
                    HidP_Input,
                    HID_USAGE_PAGE_BUTTON,
                    0,                        // LinkCollection = 0 → all
                    usages.as_mut_ptr(),
                    &mut usage_len,
                    preparsed,
                    buf.as_ptr() as *mut u8,  // HidP only reads, cast is safe
                    report_len,
                );

                if status == HIDP_STATUS_SUCCESS || status == HIDP_STATUS_BUFFER_TOO_SMALL {
                    for &usage in &usages[..usage_len as usize] {
                        if usage >= 1 && usage <= 128 {
                            mask |= 1u128 << (usage - 1);
                        }
                    }
                }
            }
        }
        mask
    }

    // -------------------------------------------------------------------------
    // Submit an overlapped ReadFile; on synchronous completion update last_mask.
    // -------------------------------------------------------------------------

    fn submit_read(dev: &mut HidJoystick) {
        if dev.read_pending {
            return;
        }
        unsafe {
            ResetEvent(dev.event_handle);
            dev.read_buf.fill(0);
            let mut bytes: u32 = 0;
            let ok = ReadFile(
                dev.handle,
                dev.read_buf.as_mut_ptr() as *mut _,
                dev.report_len,
                &mut bytes,
                dev.overlapped.as_mut(),
            );
            if ok != 0 {
                // Completed synchronously (device has data queued in the driver)
                dev.last_mask =
                    parse_buttons(&dev.read_buf, &dev.button_caps, dev.preparsed, dev.report_len);
                tracing::trace!(
                    "[HID] \"{}\" sync read OK, mask={:#034x}",
                    dev.name,
                    dev.last_mask
                );
                dev.read_pending = false;
            } else {
                let err = GetLastError();
                if err == ERROR_IO_PENDING {
                    dev.read_pending = true;
                } else {
                    tracing::warn!(
                        "[HID] \"{}\" ReadFile submit failed: err={:#010x}",
                        dev.name,
                        err
                    );
                    dev.read_pending = false;
                }
            }
        }
    }

    // -------------------------------------------------------------------------
    // Non-blocking poll: check if the pending read completed; if so, parse and
    // resubmit. Always returns the most-recent known button mask.
    // -------------------------------------------------------------------------

    fn poll_buttons(dev: &mut HidJoystick) -> u128 {
        unsafe {
            if dev.read_pending {
                let mut bytes: u32 = 0;
                let ok = GetOverlappedResult(
                    dev.handle,
                    dev.overlapped.as_mut(),
                    &mut bytes,
                    0, // bWait = FALSE → never block
                );
                if ok != 0 {
                    // Read completed
                    let m = parse_buttons(
                        &dev.read_buf,
                        &dev.button_caps,
                        dev.preparsed,
                        dev.report_len,
                    );
                    // Log the very first successful read (last_mask starts at 0 and read_pending was true)
                    if bytes > 0 && dev.last_mask == 0 {
                        tracing::info!(
                            "[HID] \"{}\" first successful read — {} bytes, initial mask={:#034x}",
                            dev.name, bytes, m
                        );
                    }
                    if m != dev.last_mask {
                        tracing::debug!(
                            "[HID] \"{}\" buttons changed: {:#034x} → {:#034x}",
                            dev.name,
                            dev.last_mask,
                            m
                        );
                    }
                    dev.last_mask = m;
                    dev.read_pending = false;
                    // Immediately queue next read so we never miss a report
                    submit_read(dev);
                } else {
                    let err = GetLastError();
                    if err != ERROR_IO_INCOMPLETE {
                        // Device was likely disconnected
                        tracing::warn!(
                            "[HID] \"{}\" GetOverlappedResult err={:#010x} — device may be disconnected",
                            dev.name,
                            err
                        );
                        dev.read_pending = false;
                    }
                    // ERROR_IO_INCOMPLETE → still pending; return last_mask
                }
            } else {
                // No read in flight — start one
                submit_read(dev);
            }
        }
        dev.last_mask
    }

    // -------------------------------------------------------------------------
    // Enumerate all HID device paths via SetupDi
    // -------------------------------------------------------------------------

    fn enumerate_hid_paths() -> Vec<String> {
        let mut paths = Vec::new();
        unsafe {
            let devs = SetupDiGetClassDevsW(
                &GUID_DEVINTERFACE_HID,
                std::ptr::null(),
                std::ptr::null_mut(),
                DIGCF_PRESENT | DIGCF_DEVICEINTERFACE,
            );
            if (devs as isize) == -1 {
                tracing::warn!("[HID] SetupDiGetClassDevsW returned INVALID_HANDLE_VALUE");
                return paths;
            }

            let guid = GUID_DEVINTERFACE_HID;
            let mut iface = SP_DEVICE_INTERFACE_DATA {
                cbSize: std::mem::size_of::<SP_DEVICE_INTERFACE_DATA>() as u32,
                InterfaceClassGuid: guid,
                Flags: 0,
                Reserved: 0,
            };

            let mut idx = 0u32;
            loop {
                let ok = SetupDiEnumDeviceInterfaces(
                    devs,
                    std::ptr::null_mut(),
                    &GUID_DEVINTERFACE_HID,
                    idx,
                    &mut iface,
                );
                if ok == 0 {
                    break;
                }

                let mut required = 0u32;
                SetupDiGetDeviceInterfaceDetailW(
                    devs,
                    &mut iface,
                    std::ptr::null_mut(),
                    0,
                    &mut required,
                    std::ptr::null_mut(),
                );

                if required >= 6 {
                    let mut buf = vec![0u8; required as usize];
                    let cbsize_ptr = buf.as_mut_ptr() as *mut u32;
                    // On 64-bit Windows sizeof(SP_DEVICE_INTERFACE_DETAIL_DATA_W) = 8.
                    // Windows rejects the call if cbSize != sizeof(struct) for the target arch.
                    *cbsize_ptr = std::mem::size_of::<SP_DEVICE_INTERFACE_DETAIL_DATA_W>() as u32;

                    let ok2 = SetupDiGetDeviceInterfaceDetailW(
                        devs,
                        &mut iface,
                        buf.as_mut_ptr() as *mut _,
                        required,
                        &mut required,
                        std::ptr::null_mut(),
                    );

                    if ok2 != 0 {
                        let path_ptr = buf.as_ptr().add(4) as *const u16; // skip u32 cbSize
                        let path_len =
                            (0..).find(|&i| *path_ptr.add(i) == 0).unwrap_or(0);
                        let slice = std::slice::from_raw_parts(path_ptr, path_len);
                        paths.push(
                            OsString::from_wide(slice).to_string_lossy().into_owned(),
                        );
                    }
                }

                idx += 1;
            }

            SetupDiDestroyDeviceInfoList(devs);
        }
        tracing::debug!("[HID] enumerate_hid_paths: found {} total HID paths", paths.len());
        paths
    }

    // -------------------------------------------------------------------------
    // Open one HID device for overlapped I/O.
    // Returns None if not a joystick/gamepad or if any setup step fails.
    // -------------------------------------------------------------------------

    fn open_hid_joystick(path: &str) -> Option<HidJoystick> {
        let wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();

        unsafe {
            // Open with FILE_FLAG_OVERLAPPED so ReadFile never blocks
            let handle = CreateFileW(
                wide.as_ptr(),
                GENERIC_READ,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                std::ptr::null(),
                OPEN_EXISTING,
                FILE_FLAG_OVERLAPPED,
                std::ptr::null_mut(),
            );

            if handle == INVALID_HANDLE_VALUE || handle.is_null() {
                // Expected for keyboard/mouse/system HID — not an error worth logging
                return None;
            }

            // Preparsed data (HID descriptor)
            let mut preparsed: PHIDP_PREPARSED_DATA = 0;
            if HidD_GetPreparsedData(handle, &mut preparsed) == 0 || preparsed == 0 {
                tracing::trace!("[HID] {}: HidD_GetPreparsedData failed", &path[..path.len().min(50)]);
                CloseHandle(handle);
                return None;
            }

            // Top-level caps
            let mut caps: HIDP_CAPS = std::mem::zeroed();
            if HidP_GetCaps(preparsed, &mut caps) != HIDP_STATUS_SUCCESS {
                tracing::trace!("[HID] {}: HidP_GetCaps failed", &path[..path.len().min(50)]);
                HidD_FreePreparsedData(preparsed);
                CloseHandle(handle);
                return None;
            }

            // Filter: joysticks and gamepads only (Usage Page 1, Usage 4 or 5)
            if caps.UsagePage != HID_USAGE_PAGE_GENERIC
                || (caps.Usage != HID_USAGE_JOYSTICK && caps.Usage != HID_USAGE_GAMEPAD)
            {
                HidD_FreePreparsedData(preparsed);
                CloseHandle(handle);
                return None;
            }

            if caps.NumberInputButtonCaps == 0 || caps.InputReportByteLength == 0 {
                tracing::debug!(
                    "[HID] {}: joystick/gamepad but no buttons or empty report; skipped",
                    &path[..path.len().min(50)]
                );
                HidD_FreePreparsedData(preparsed);
                CloseHandle(handle);
                return None;
            }

            // Button caps
            let mut num_caps: u16 = caps.NumberInputButtonCaps;
            let mut button_caps: Vec<HIDP_BUTTON_CAPS> =
                vec![std::mem::zeroed(); num_caps as usize];

            if HidP_GetButtonCaps(
                HidP_Input,
                button_caps.as_mut_ptr(),
                &mut num_caps,
                preparsed,
            ) != HIDP_STATUS_SUCCESS
            {
                tracing::warn!("[HID] {}: HidP_GetButtonCaps failed", &path[..path.len().min(50)]);
                HidD_FreePreparsedData(preparsed);
                CloseHandle(handle);
                return None;
            }
            button_caps.truncate(num_caps as usize);

            // Compute max button usage (= highest button number; used for display)
            let button_count = button_caps.iter().map(|cap| {
                if cap.IsRange != 0 {
                    cap.Anonymous.Range.UsageMax as u32
                } else {
                    cap.Anonymous.NotRange.Usage as u32
                }
            }).max().unwrap_or(0);

            // Device name
            let mut name_buf = [0u16; 256];
            let name = if HidD_GetProductString(
                handle,
                name_buf.as_mut_ptr() as *mut _,
                (name_buf.len() * 2) as u32,
            ) != 0
            {
                let len = name_buf.iter().position(|&c| c == 0).unwrap_or(name_buf.len());
                OsString::from_wide(&name_buf[..len]).to_string_lossy().into_owned()
            } else {
                format!("HID({})", &path.get(..30).unwrap_or(path))
            };

            // Create manual-reset event for overlapped I/O
            let event_handle = CreateEventW(
                std::ptr::null(),
                1,                    // bManualReset = TRUE
                0,                    // bInitialState = non-signaled
                std::ptr::null(),
            );
            if event_handle.is_null() || event_handle == INVALID_HANDLE_VALUE {
                tracing::warn!("[HID] \"{}\": CreateEventW failed err={:#010x}", name, GetLastError());
                HidD_FreePreparsedData(preparsed);
                CloseHandle(handle);
                return None;
            }

            let mut ov: OVERLAPPED = std::mem::zeroed();
            ov.hEvent = event_handle;
            let overlapped = Box::new(ov);

            let report_len = caps.InputReportByteLength as u32;
            let read_buf   = vec![0u8; report_len as usize];

            let mut joy = HidJoystick {
                handle,
                preparsed,
                report_len,
                button_caps,
                button_count,
                name: name.clone(),
                overlapped,
                event_handle,
                read_buf,
                read_pending: false,
                last_mask: 0,
            };

            // Queue the first read immediately
            submit_read(&mut joy);

            tracing::debug!(
                "[HID] Opened \"{}\": report_len={}, button_caps={}, pending={}",
                name,
                report_len,
                num_caps,
                joy.read_pending
            );

            Some(joy)
        }
    }

    // -------------------------------------------------------------------------
    // Public: snapshot all game-controller button states (used in capture mode).
    //
    // Opens each device, waits up to 80 ms for the first input report, closes.
    // Returns device_index → u128 bitmask (bit N = button index N pressed).
    // -------------------------------------------------------------------------

    pub fn scan_all_devices() -> HashMap<u32, u128> {
        let paths = enumerate_hid_paths();
        let mut result = HashMap::new();
        let mut joy_idx = 0u32;

        for path in &paths {
            if let Some(mut dev) = open_hid_joystick(path) {
                // Wait up to 80 ms for the first report (covers 12 Hz devices)
                if dev.read_pending {
                    let wait_result = unsafe { WaitForSingleObject(dev.event_handle, 80) };
                    if wait_result == WAIT_OBJECT_0 {
                        unsafe {
                            let mut bytes: u32 = 0;
                            let ok = GetOverlappedResult(
                                dev.handle,
                                dev.overlapped.as_mut(),
                                &mut bytes,
                                0,
                            );
                            if ok != 0 {
                                dev.last_mask = parse_buttons(
                                    &dev.read_buf,
                                    &dev.button_caps,
                                    dev.preparsed,
                                    dev.report_len,
                                );
                                dev.read_pending = false;
                            }
                        }
                    }
                }

                tracing::debug!(
                    "[HID] scan device {}: \"{}\" mask={:#034x}",
                    joy_idx,
                    dev.name,
                    dev.last_mask
                );
                result.insert(joy_idx, dev.last_mask);
                joy_idx += 1;
            }
        }

        if joy_idx == 0 {
            tracing::warn!("[HID] scan_all_devices: no joystick/gamepad devices found");
        }
        result
    }

    // -------------------------------------------------------------------------
    // JoystickMonitor — keeps devices open for the 500 Hz thread
    // -------------------------------------------------------------------------

    struct ButtonState {
        prev: bool,
        edge: bool,
    }

    pub struct JoystickMonitor {
        states:      HashMap<(u32, u32), ButtonState>,
        watched:     HashMap<u32, Vec<u32>>,
        devices:     HashMap<u32, Option<HidJoystick>>,
        initialized: bool,
        controller_info: Vec<super::JoystickControllerInfo>,
    }

    unsafe impl Send for JoystickMonitor {}

    impl JoystickMonitor {
        pub fn new() -> Self {
            Self {
                states:          HashMap::new(),
                watched:         HashMap::new(),
                devices:         HashMap::new(),
                initialized:     false,
                controller_info: Vec::new(),
            }
        }

        pub fn register(&mut self, device_index: u32, button: u32) {
            self.watched.entry(device_index).or_default().push(button);
            self.states.insert(
                (device_index, button),
                ButtonState { prev: false, edge: false },
            );
        }

        fn initialize(&mut self) {
            if self.initialized {
                return;
            }
            self.initialized = true;

            let needed: Vec<u32> = self.watched.keys().copied().collect();
            if needed.is_empty() {
                tracing::debug!("[HID] JoystickMonitor: no joystick bindings configured");
                return;
            }

            let paths = enumerate_hid_paths();
            let mut joy_idx = 0u32;

            tracing::info!(
                "[HID] Initializing JoystickMonitor — {} total HID paths, watching device indices: {:?}",
                paths.len(),
                needed
            );

            for path in &paths {
                if let Some(dev) = open_hid_joystick(path) {
                    let watching = needed.contains(&joy_idx);
                    // Record ALL found controllers (watched or not) for diagnostics
                    self.controller_info.push(super::JoystickControllerInfo {
                        index: joy_idx,
                        name: dev.name.clone(),
                        button_count: dev.button_count,
                        connected: true,
                    });
                    if watching {
                        let btns: Vec<String> = self
                            .watched
                            .get(&joy_idx)
                            .map(|v| v.iter().map(|b| b.to_string()).collect())
                            .unwrap_or_default();
                        tracing::info!(
                            "[HID]   Device {}: \"{}\" ← monitoring buttons [{}], report_len={}",
                            joy_idx,
                            dev.name,
                            btns.join(", "),
                            dev.report_len
                        );
                        self.devices.insert(joy_idx, Some(dev));
                    } else {
                        tracing::info!(
                            "[HID]   Device {}: \"{}\" (not monitored)",
                            joy_idx,
                            dev.name
                        );
                        // drop dev → closes handle + event
                    }
                    joy_idx += 1;
                }
            }

            if joy_idx == 0 {
                tracing::warn!("[HID] JoystickMonitor: no joystick/gamepad HID devices found at all");
            }

            for &idx in &needed {
                if !self.devices.contains_key(&idx) {
                    tracing::warn!(
                        "[HID] Device index {} not found ({} controllers detected). \
                         Check config.json device_index. Available indices: 0..{}",
                        idx,
                        joy_idx,
                        joy_idx.saturating_sub(1)
                    );
                    self.devices.insert(idx, None);
                    // If not already in controller_info, add as disconnected
                    if !self.controller_info.iter().any(|c| c.index == idx) {
                        self.controller_info.push(super::JoystickControllerInfo {
                            index: idx,
                            name: format!("Device {} (not found)", idx),
                            button_count: 0,
                            connected: false,
                        });
                    }
                }
            }
        }

        pub fn update(&mut self) {
            self.initialize();

            for state in self.states.values_mut() {
                state.edge = false;
            }

            for (&device_idx, buttons) in &self.watched {
                let dev = match self.devices.get_mut(&device_idx).and_then(|d| d.as_mut()) {
                    Some(d) => d,
                    None => continue,
                };

                let mask = poll_buttons(dev);

                for &button in buttons {
                    // Config button numbers are 1-based (matching Fred's Controller Tester).
                    // HID Usage N → bit (N-1) in mask. So button=1 → bit 0, button=128 → bit 127.
                    let pressed = button >= 1 && button <= 128 && ((mask >> (button - 1)) & 1) == 1;
                    if let Some(state) = self.states.get_mut(&(device_idx, button)) {
                        if pressed && !state.prev {
                            state.edge = true;
                            tracing::info!(
                                "[HID] Device {} \"{}\", Button {} PRESSED (mask={:#034x})",
                                device_idx,
                                dev.name,
                                button,
                                mask
                            );
                        }
                        state.prev = pressed;
                    }
                }
            }
        }

        pub fn is_just_pressed(&self, device_index: u32, button: u32) -> bool {
            self.states
                .get(&(device_index, button))
                .map(|s| s.edge)
                .unwrap_or(false)
        }

        /// Returns info about all HID game controllers found during initialization.
        /// Triggers initialization on first call.
        pub fn controller_info(&mut self) -> Vec<super::JoystickControllerInfo> {
            self.initialize();
            self.controller_info.clone()
        }
    }
}

// =============================================================================
// Non-Windows stub
// =============================================================================

#[cfg(not(target_os = "windows"))]
mod imp {
    pub struct JoystickMonitor;

    impl JoystickMonitor {
        pub fn new() -> Self { Self }
        pub fn register(&mut self, _device_index: u32, _button: u32) {}
        pub fn update(&mut self) {}
        pub fn is_just_pressed(&self, _device_index: u32, _button: u32) -> bool { false }
        pub fn controller_info(&mut self) -> Vec<super::JoystickControllerInfo> {
            vec![]
        }
    }

    pub fn scan_all_devices() -> std::collections::HashMap<u32, u128> {
        std::collections::HashMap::new()
    }
}

// ---------------------------------------------------------------------------
// Public re-export
// ---------------------------------------------------------------------------

pub use imp::{JoystickMonitor, scan_all_devices};
