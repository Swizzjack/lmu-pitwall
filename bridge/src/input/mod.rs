//! Input monitoring — keyboard and joystick polling for electronics button counting.

pub mod joystick;
pub mod keyboard;

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use crate::app_config::{ButtonBinding, ElectronicsBindings};
use joystick::JoystickMonitor;
use keyboard::KeyboardMonitor;

// Re-export capture-mode scan functions
pub use keyboard::{scan_pressed_vks, vk_to_name};
pub use joystick::scan_all_devices;
pub use joystick::JoystickControllerInfo;

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ElectronicsEvent {
    TcIncrease,
    TcDecrease,
    TcCutIncrease,
    TcCutDecrease,
    TcSlipIncrease,
    TcSlipDecrease,
    AbsIncrease,
    AbsDecrease,
    EngineMapIncrease,
    EngineMapDecrease,
    FrontArbIncrease,
    FrontArbDecrease,
    RearArbIncrease,
    RearArbDecrease,
    BrakeBiasIncrease,
    BrakeBiasDecrease,
    RegenIncrease,
    RegenDecrease,
    BrakeMigrationIncrease,
    BrakeMigrationDecrease,
}

// ---------------------------------------------------------------------------
// InputMonitor — keyboard only (joystick is handled by the 500 Hz thread)
// ---------------------------------------------------------------------------

pub struct InputMonitor {
    bindings: ElectronicsBindings,
    keyboard: KeyboardMonitor,
    /// Legacy joystick monitor — kept so `poll()` (used in capture mode) still
    /// advances edge-detection state. The 500 Hz joystick poller is separate.
    joystick: JoystickMonitor,
}

impl InputMonitor {
    pub fn new(bindings: &ElectronicsBindings) -> Self {
        let mut keyboard = KeyboardMonitor::new();
        let mut joystick = JoystickMonitor::new();

        let all: &[&Option<ButtonBinding>] = &[
            &bindings.tc_increase,
            &bindings.tc_decrease,
            &bindings.tc_cut_increase,
            &bindings.tc_cut_decrease,
            &bindings.tc_slip_increase,
            &bindings.tc_slip_decrease,
            &bindings.abs_increase,
            &bindings.abs_decrease,
            &bindings.engine_map_increase,
            &bindings.engine_map_decrease,
            &bindings.farb_increase,
            &bindings.farb_decrease,
            &bindings.rarb_increase,
            &bindings.rarb_decrease,
            &bindings.brake_bias_increase,
            &bindings.brake_bias_decrease,
            &bindings.regen_increase,
            &bindings.regen_decrease,
            &bindings.brake_migration_increase,
            &bindings.brake_migration_decrease,
        ];

        for binding in all {
            match binding {
                Some(ButtonBinding::Keyboard { key }) => keyboard.register(key),
                Some(ButtonBinding::Joystick { device_index, button }) => {
                    joystick.register(*device_index, *button);
                }
                None => {}
            }
        }

        Self {
            bindings: bindings.clone(),
            keyboard,
            joystick,
        }
    }

    /// Poll keyboard inputs only and return rising-edge events. Call at ~50 Hz.
    ///
    /// Joystick events come from the dedicated 500 Hz joystick poller thread —
    /// drain `joy_rx` separately in the main loop.
    pub fn poll_keyboard_only(&mut self) -> Vec<ElectronicsEvent> {
        self.keyboard.update();

        let kb = &self.keyboard;
        let b  = &self.bindings;
        let mut events = Vec::new();

        macro_rules! check_kb {
            ($binding:expr, $event:expr) => {
                if let Some(ButtonBinding::Keyboard { key }) = $binding.as_ref() {
                    if kb.is_just_pressed(key) {
                        events.push($event);
                    }
                }
            };
        }

        check_kb!(b.tc_increase,              ElectronicsEvent::TcIncrease);
        check_kb!(b.tc_decrease,              ElectronicsEvent::TcDecrease);
        check_kb!(b.tc_cut_increase,          ElectronicsEvent::TcCutIncrease);
        check_kb!(b.tc_cut_decrease,          ElectronicsEvent::TcCutDecrease);
        check_kb!(b.tc_slip_increase,         ElectronicsEvent::TcSlipIncrease);
        check_kb!(b.tc_slip_decrease,         ElectronicsEvent::TcSlipDecrease);
        check_kb!(b.abs_increase,             ElectronicsEvent::AbsIncrease);
        check_kb!(b.abs_decrease,             ElectronicsEvent::AbsDecrease);
        check_kb!(b.engine_map_increase,      ElectronicsEvent::EngineMapIncrease);
        check_kb!(b.engine_map_decrease,      ElectronicsEvent::EngineMapDecrease);
        check_kb!(b.farb_increase,            ElectronicsEvent::FrontArbIncrease);
        check_kb!(b.farb_decrease,            ElectronicsEvent::FrontArbDecrease);
        check_kb!(b.rarb_increase,            ElectronicsEvent::RearArbIncrease);
        check_kb!(b.rarb_decrease,            ElectronicsEvent::RearArbDecrease);
        check_kb!(b.brake_bias_increase,      ElectronicsEvent::BrakeBiasIncrease);
        check_kb!(b.brake_bias_decrease,      ElectronicsEvent::BrakeBiasDecrease);
        check_kb!(b.regen_increase,           ElectronicsEvent::RegenIncrease);
        check_kb!(b.regen_decrease,           ElectronicsEvent::RegenDecrease);
        check_kb!(b.brake_migration_increase, ElectronicsEvent::BrakeMigrationIncrease);
        check_kb!(b.brake_migration_decrease, ElectronicsEvent::BrakeMigrationDecrease);

        events
    }

    /// Poll both keyboard and joystick. Used in capture mode to advance
    /// edge-detection state (return value is intentionally ignored).
    pub fn poll(&mut self) -> Vec<ElectronicsEvent> {
        self.keyboard.update();
        self.joystick.update();

        let kb = &self.keyboard;
        let js = &self.joystick;
        let b  = &self.bindings;

        let mut events = Vec::new();

        macro_rules! check {
            ($binding:expr, $event:expr) => {
                if is_pressed(&$binding, kb, js) {
                    events.push($event);
                }
            };
        }

        check!(b.tc_increase,              ElectronicsEvent::TcIncrease);
        check!(b.tc_decrease,              ElectronicsEvent::TcDecrease);
        check!(b.tc_cut_increase,          ElectronicsEvent::TcCutIncrease);
        check!(b.tc_cut_decrease,          ElectronicsEvent::TcCutDecrease);
        check!(b.tc_slip_increase,         ElectronicsEvent::TcSlipIncrease);
        check!(b.tc_slip_decrease,         ElectronicsEvent::TcSlipDecrease);
        check!(b.abs_increase,             ElectronicsEvent::AbsIncrease);
        check!(b.abs_decrease,             ElectronicsEvent::AbsDecrease);
        check!(b.engine_map_increase,      ElectronicsEvent::EngineMapIncrease);
        check!(b.engine_map_decrease,      ElectronicsEvent::EngineMapDecrease);
        check!(b.farb_increase,            ElectronicsEvent::FrontArbIncrease);
        check!(b.farb_decrease,            ElectronicsEvent::FrontArbDecrease);
        check!(b.rarb_increase,            ElectronicsEvent::RearArbIncrease);
        check!(b.rarb_decrease,            ElectronicsEvent::RearArbDecrease);
        check!(b.brake_bias_increase,      ElectronicsEvent::BrakeBiasIncrease);
        check!(b.brake_bias_decrease,      ElectronicsEvent::BrakeBiasDecrease);
        check!(b.regen_increase,           ElectronicsEvent::RegenIncrease);
        check!(b.regen_decrease,           ElectronicsEvent::RegenDecrease);
        check!(b.brake_migration_increase, ElectronicsEvent::BrakeMigrationIncrease);
        check!(b.brake_migration_decrease, ElectronicsEvent::BrakeMigrationDecrease);

        events
    }
}

// ---------------------------------------------------------------------------
// Helper: check a single binding (free fn avoids double-borrow of self)
// ---------------------------------------------------------------------------

fn is_pressed(
    binding:  &Option<ButtonBinding>,
    keyboard: &KeyboardMonitor,
    joystick: &JoystickMonitor,
) -> bool {
    match binding {
        None => false,
        Some(ButtonBinding::Keyboard { key }) => keyboard.is_just_pressed(key),
        Some(ButtonBinding::Joystick { device_index, button }) => {
            joystick.is_just_pressed(*device_index, *button)
        }
    }
}

// ---------------------------------------------------------------------------
// 500 Hz joystick poller — runs in a dedicated OS thread
// ---------------------------------------------------------------------------

/// Handle to the background joystick polling thread.
///
/// Dropping this handle signals the thread to stop (within ~2 ms).
pub struct JoystickPollHandle {
    stop: Arc<AtomicBool>,
}

impl Drop for JoystickPollHandle {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

/// Spawn a 500 Hz joystick polling thread and return its handle + event receiver.
///
/// The thread maps joystick button presses to `ElectronicsEvent` values using the
/// current `bindings`. When bindings change, drop the old handle and call this
/// again with the updated bindings.
///
/// On non-Windows platforms no thread is spawned; the receiver will never
/// produce events (channel is immediately disconnected).
pub fn start_joystick_poller(
    bindings: &ElectronicsBindings,
) -> (JoystickPollHandle, std::sync::mpsc::Receiver<ElectronicsEvent>, Vec<JoystickControllerInfo>) {
    let (tx, rx) = std::sync::mpsc::channel::<ElectronicsEvent>();
    let stop = Arc::new(AtomicBool::new(false));

    // Build (device_index, button, event) mapping from bindings.
    let mut mappings: Vec<(u32, u32, ElectronicsEvent)> = Vec::new();
    macro_rules! joy_map {
        ($field:expr, $event:expr) => {
            if let Some(ButtonBinding::Joystick { device_index, button }) = &$field {
                mappings.push((*device_index, *button, $event));
            }
        };
    }
    joy_map!(bindings.tc_increase,              ElectronicsEvent::TcIncrease);
    joy_map!(bindings.tc_decrease,              ElectronicsEvent::TcDecrease);
    joy_map!(bindings.tc_cut_increase,          ElectronicsEvent::TcCutIncrease);
    joy_map!(bindings.tc_cut_decrease,          ElectronicsEvent::TcCutDecrease);
    joy_map!(bindings.tc_slip_increase,         ElectronicsEvent::TcSlipIncrease);
    joy_map!(bindings.tc_slip_decrease,         ElectronicsEvent::TcSlipDecrease);
    joy_map!(bindings.abs_increase,             ElectronicsEvent::AbsIncrease);
    joy_map!(bindings.abs_decrease,             ElectronicsEvent::AbsDecrease);
    joy_map!(bindings.engine_map_increase,      ElectronicsEvent::EngineMapIncrease);
    joy_map!(bindings.engine_map_decrease,      ElectronicsEvent::EngineMapDecrease);
    joy_map!(bindings.farb_increase,            ElectronicsEvent::FrontArbIncrease);
    joy_map!(bindings.farb_decrease,            ElectronicsEvent::FrontArbDecrease);
    joy_map!(bindings.rarb_increase,            ElectronicsEvent::RearArbIncrease);
    joy_map!(bindings.rarb_decrease,            ElectronicsEvent::RearArbDecrease);
    joy_map!(bindings.brake_bias_increase,      ElectronicsEvent::BrakeBiasIncrease);
    joy_map!(bindings.brake_bias_decrease,      ElectronicsEvent::BrakeBiasDecrease);
    joy_map!(bindings.regen_increase,           ElectronicsEvent::RegenIncrease);
    joy_map!(bindings.regen_decrease,           ElectronicsEvent::RegenDecrease);
    joy_map!(bindings.brake_migration_increase, ElectronicsEvent::BrakeMigrationIncrease);
    joy_map!(bindings.brake_migration_decrease, ElectronicsEvent::BrakeMigrationDecrease);

    #[cfg(target_os = "windows")]
    {
        let stop2 = stop.clone();
        let mut monitor = JoystickMonitor::new();
        for &(dev, btn, _) in &mappings {
            monitor.register(dev, btn);
        }
        // Initialize now (blocking HID enumeration) to capture controller info
        // before moving the monitor into the thread.
        let found_controllers = monitor.controller_info();
        std::thread::spawn(move || {
            loop {
                if stop2.load(Ordering::Relaxed) {
                    break;
                }
                monitor.update();
                for &(dev, btn, event) in &mappings {
                    if monitor.is_just_pressed(dev, btn) {
                        if tx.send(event).is_err() {
                            return; // receiver dropped — exit thread
                        }
                    }
                }
                std::thread::sleep(std::time::Duration::from_millis(2)); // 500 Hz
            }
        });
        return (JoystickPollHandle { stop }, rx, found_controllers);
    }

    // On non-Windows: tx drops here → channel disconnects; rx.try_recv() returns
    // TryRecvError::Disconnected immediately, so no events are ever produced.
    #[cfg(not(target_os = "windows"))]
    drop(tx);

    (JoystickPollHandle { stop }, rx, vec![])
}
