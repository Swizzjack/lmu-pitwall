//! Keyboard input polling via GetAsyncKeyState (Windows only).
//!
//! Non-Windows builds compile to a no-op stub so the rest of the codebase
//! builds without platform guards everywhere (same pattern as shared_memory/reader.rs).

// =============================================================================
// Windows implementation
// =============================================================================

#[cfg(target_os = "windows")]
mod imp {
    use std::collections::{HashMap, HashSet};
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;

    /// All tracked (VK_code, name) pairs — used for capture scanning and reverse lookup.
    const ALL_TRACKED_KEYS: &[(i32, &str)] = &[
        (0x70, "F1"),  (0x71, "F2"),  (0x72, "F3"),  (0x73, "F4"),
        (0x74, "F5"),  (0x75, "F6"),  (0x76, "F7"),  (0x77, "F8"),
        (0x78, "F9"),  (0x79, "F10"), (0x7A, "F11"), (0x7B, "F12"),
        (0x7C, "F13"), (0x7D, "F14"), (0x7E, "F15"), (0x7F, "F16"),
        (0x80, "F17"), (0x81, "F18"), (0x82, "F19"), (0x83, "F20"),
        (0x84, "F21"), (0x85, "F22"), (0x86, "F23"), (0x87, "F24"),
        (0x30, "0"), (0x31, "1"), (0x32, "2"), (0x33, "3"), (0x34, "4"),
        (0x35, "5"), (0x36, "6"), (0x37, "7"), (0x38, "8"), (0x39, "9"),
        (0x20, "Space"), (0x0D, "Return"), (0x1B, "Escape"), (0x09, "Tab"),
        (0x10, "Shift"), (0x11, "Ctrl"),   (0x12, "Alt"),
        (0x41, "A"), (0x42, "B"), (0x43, "C"), (0x44, "D"), (0x45, "E"),
        (0x46, "F"), (0x47, "G"), (0x48, "H"), (0x49, "I"), (0x4A, "J"),
        (0x4B, "K"), (0x4C, "L"), (0x4D, "M"), (0x4E, "N"), (0x4F, "O"),
        (0x50, "P"), (0x51, "Q"), (0x52, "R"), (0x53, "S"), (0x54, "T"),
        (0x55, "U"), (0x56, "V"), (0x57, "W"), (0x58, "X"), (0x59, "Y"),
        (0x5A, "Z"),
    ];

    /// Scan all tracked keys and return the set of currently pressed VK codes.
    /// Used for capture mode — snapshot before capture starts.
    pub fn scan_pressed_vks() -> HashSet<i32> {
        let mut pressed = HashSet::new();
        for &(vk, _) in ALL_TRACKED_KEYS {
            if unsafe { GetAsyncKeyState(vk) as u16 } & 0x8000 != 0 {
                pressed.insert(vk);
            }
        }
        pressed
    }

    /// Map a VK code back to a canonical key name string.
    pub fn vk_to_name(vk: i32) -> Option<&'static str> {
        ALL_TRACKED_KEYS.iter()
            .find(|&&(k, _)| k == vk)
            .map(|&(_, name)| name)
    }

    /// Map a config key string (e.g. "F5", "A", "1") to a Windows virtual key code.
    pub(super) fn vk_from_str(key: &str) -> Option<i32> {
        match key.to_uppercase().as_str() {
            "F1"  => Some(0x70), "F2"  => Some(0x71), "F3"  => Some(0x72),
            "F4"  => Some(0x73), "F5"  => Some(0x74), "F6"  => Some(0x75),
            "F7"  => Some(0x76), "F8"  => Some(0x77), "F9"  => Some(0x78),
            "F10" => Some(0x79), "F11" => Some(0x7A), "F12" => Some(0x7B),
            "F13" => Some(0x7C), "F14" => Some(0x7D), "F15" => Some(0x7E),
            "F16" => Some(0x7F), "F17" => Some(0x80), "F18" => Some(0x81),
            "F19" => Some(0x82), "F20" => Some(0x83), "F21" => Some(0x84),
            "F22" => Some(0x85), "F23" => Some(0x86), "F24" => Some(0x87),
            "0" => Some(0x30), "1" => Some(0x31), "2" => Some(0x32),
            "3" => Some(0x33), "4" => Some(0x34), "5" => Some(0x35),
            "6" => Some(0x36), "7" => Some(0x37), "8" => Some(0x38),
            "9" => Some(0x39),
            "SPACE"  => Some(0x20),
            "RETURN" | "ENTER" => Some(0x0D),
            "ESCAPE" | "ESC"   => Some(0x1B),
            "TAB"    => Some(0x09),
            "SHIFT"  => Some(0x10),
            "CTRL" | "CONTROL" => Some(0x11),
            "ALT"    => Some(0x12),
            // Single letter A-Z
            s if s.len() == 1 => {
                let c = s.chars().next()? as i32;
                if (0x41..=0x5A).contains(&c) { Some(c) } else { None }
            }
            _ => None,
        }
    }

    pub struct KeyboardMonitor {
        /// VK → was-pressed on previous poll tick.
        prev: HashMap<i32, bool>,
        /// VK → just transitioned not-pressed → pressed this tick.
        edge: HashMap<i32, bool>,
    }

    impl KeyboardMonitor {
        pub fn new() -> Self {
            Self {
                prev: HashMap::new(),
                edge: HashMap::new(),
            }
        }

        /// Register a key string so it is included in future polls.
        pub fn register(&mut self, key: &str) {
            if let Some(vk) = vk_from_str(key) {
                self.prev.entry(vk).or_insert(false);
            }
        }

        /// Poll current key states and compute rising-edge flags.
        /// Call once per tick before querying `is_just_pressed`.
        pub fn update(&mut self) {
            self.edge.clear();
            for (&vk, prev_state) in &mut self.prev {
                // GetAsyncKeyState: high bit set = key is down right now.
                let now = unsafe { GetAsyncKeyState(vk) as u16 } & 0x8000 != 0;
                if now && !*prev_state {
                    self.edge.insert(vk, true);
                }
                *prev_state = now;
            }
        }

        /// Returns `true` if the given key had a rising edge on this tick.
        pub fn is_just_pressed(&self, key: &str) -> bool {
            vk_from_str(key)
                .map(|vk| self.edge.get(&vk).copied().unwrap_or(false))
                .unwrap_or(false)
        }
    }
}

// =============================================================================
// Non-Windows stub
// =============================================================================

#[cfg(not(target_os = "windows"))]
mod imp {
    use std::collections::HashSet;

    pub struct KeyboardMonitor;

    impl KeyboardMonitor {
        pub fn new() -> Self { Self }
        pub fn register(&mut self, _key: &str) {}
        pub fn update(&mut self) {}
        pub fn is_just_pressed(&self, _key: &str) -> bool { false }
    }

    pub fn scan_pressed_vks() -> HashSet<i32> { HashSet::new() }
    pub fn vk_to_name(_vk: i32) -> Option<&'static str> { None }
}

// ---------------------------------------------------------------------------
// Public re-export (works for both cfg branches since exactly one mod imp exists)
// ---------------------------------------------------------------------------

pub use imp::{KeyboardMonitor, scan_pressed_vks, vk_to_name};
