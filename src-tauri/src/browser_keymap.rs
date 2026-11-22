//! Matching state for trusted native browser keyboard events.

use std::collections::HashSet;
static FOCUS_IDENTITY: std::sync::Mutex<(isize, u64)> = std::sync::Mutex::new((0, 0));
static PENDING: std::sync::Mutex<Vec<(u64, u64, String)>> = std::sync::Mutex::new(Vec::new());

pub fn queue_command(focus_generation: u64, map_generation: u64, command: String) -> bool {
    let Ok(mut pending) = PENDING.try_lock() else { return false; };
    if pending.len() >= 32 { return false; }
    pending.push((focus_generation, map_generation, command));
    true
}

pub fn take_commands() -> Vec<(u64, u64, String)> {
    PENDING.lock().map(|mut pending| std::mem::take(&mut *pending)).unwrap_or_default()
}

pub fn set_browser_focus_identity(hwnd: isize) -> u64 {
    let mut identity = FOCUS_IDENTITY.lock().unwrap_or_else(|error| error.into_inner());
    if identity.0 != hwnd { *identity = (hwnd, identity.1.wrapping_add(1)); }
    identity.1
}

pub fn browser_focus_identity() -> (isize, u64) {
    FOCUS_IDENTITY.try_lock().map(|identity| *identity).unwrap_or((0, 0))
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Deserialize)]
pub struct Binding {
    pub command: String,
    pub key: u32,
    pub modifiers: Vec<Vec<u32>>,
    pub repeat: bool,
}

#[derive(Default)]
pub struct BrowserKeymapState(pub std::sync::Mutex<BrowserKeymap>, [std::sync::atomic::AtomicU64; 4]);

impl BrowserKeymapState {
    pub fn focused_generation(&self) -> Option<u64> {
        self.0.try_lock().ok().and_then(|state| state.focused.then_some(state.generation))
    }

    pub fn active_command(&self, command: &str, key: u32) -> Option<u64> {
        let state = self.0.try_lock().ok()?;
        if !state.focused { return None; }
        let mut pressed = state.pressed.clone();
        pressed.insert(key);
        state.bindings.iter().any(|binding| {
            if binding.command != command || binding.key != key { return false; }
            let mut used = HashSet::from([key]);
            match_modifiers(&binding.modifiers, &pressed, &mut used)
        }).then_some(state.generation)
    }

    #[cfg(debug_assertions)]
    pub fn supports_probe_chord(&self, keys: &[u32]) -> bool {
        if keys.is_empty() || keys.len() > 4 || keys.iter().any(|key| *key > 0xFF || matches!(*key, 0 | 0x5b | 0x5c)) {
            return false;
        }
        let Ok(state) = self.0.try_lock() else { return false; };
        if !state.focused || keys.contains(&0x14) && !state.caps_term { return false; }
        let pressed: HashSet<u32> = keys.iter().copied().collect();
        if pressed.len() != keys.len() { return false; }
        let Some(key) = keys.last() else { return false; };
        state.bindings.iter().any(|binding| {
            if binding.key != *key { return false; }
            let mut used = HashSet::from([*key]);
            match_modifiers(&binding.modifiers, &pressed, &mut used) && used == pressed
        })
    }

    pub fn uses_caps_term(&self) -> bool {
        self.0.try_lock().is_ok_and(|state| state.focused && state.caps_term)
    }
    pub fn release_consumed(&self, key: u32) {
        self.clear_latch(key);
        if let Ok(mut state) = self.0.try_lock() {
            state.consumed.remove(&key);
        }
    }
    fn clear_latch(&self, key: u32) -> bool {
        use std::sync::atomic::Ordering;
        let Some(word) = self.1.get((key / 64) as usize) else { return false; };
        let mask = 1u64 << (key % 64);
        word.fetch_and(!mask, Ordering::AcqRel) & mask != 0
    }
    fn latch(&self, key: u32) {
        if let Some(word) = self.1.get((key / 64) as usize) {
            word.fetch_or(1u64 << (key % 64), std::sync::atomic::Ordering::Release);
        }
    }
    pub fn clear_pressed(&self) {
        if let Ok(mut state) = self.0.try_lock() {
            state.pressed.clear();
        }
    }
    pub fn take_consumed_up(&self, key: u32) -> bool {
        if !self.clear_latch(key) { return false; }
        if let Ok(mut state) = self.0.try_lock() {
                state.consumed.remove(&key);
                state.pressed.remove(&key);
        }
        true
    }
    pub fn key(&self, focus_generation: u64, key: u32, down: bool) -> (bool, u64, Option<String>) {
        let Ok(mut state) = self.0.try_lock() else { return (false, 0, None); };
        let released: Vec<u32> = state.consumed.iter().copied().filter(|key| {
            self.1.get((*key / 64) as usize).is_none_or(|word| {
                word.load(std::sync::atomic::Ordering::Acquire) & (1u64 << (*key % 64)) == 0
            })
        }).collect();
        for key in released {
            state.consumed.remove(&key);
            state.pressed.remove(&key);
        }
        if state.focus_generation != focus_generation {
            state.pressed.clear();
            state.focus_generation = focus_generation;
        }
        let generation = state.generation;
        let (consumed, command) = state.key(generation, key, down);
        let command = command.map(str::to_owned);
        if down && consumed {
            self.latch(key);
            if state.consumed.contains(&0x5d) { self.latch(0x5d); }
        }
        (consumed, generation, command)
    }
}

#[tauri::command]
pub fn set_browser_keymap(
    state: tauri::State<'_, BrowserKeymapState>,
    generation: u64,
    focused: bool,
    caps_term: bool,
    bindings: Vec<Binding>,
) -> Result<(), String> {
    if !valid_bindings(&bindings) {
        return Err("invalid browser keymap".into());
    }
    let mut current = state.0.lock().map_err(|_| "browser keymap is unavailable")?;
    // Invocations can complete out of order during a focus change or config reload.
    // Keep the newer snapshot and treat the superseded request as successfully ignored.
    current.update_if_newer(generation, focused, caps_term, bindings);
    Ok(())
}

fn valid_bindings(bindings: &[Binding]) -> bool {
    bindings.len() <= 256 && bindings.iter().all(|binding|
        !binding.command.is_empty() && binding.command.len() <= 128 && binding.modifiers.len() <= 8
            && binding.modifiers.iter().all(|keys| !keys.is_empty() && keys.len() <= 3))
}

#[derive(Default)]
pub struct BrowserKeymap {
    generation: u64,
    focus_generation: u64,
    focused: bool,
    caps_term: bool,
    pressed: HashSet<u32>,
    consumed: HashSet<u32>,
    bindings: Vec<Binding>,
}

fn match_modifiers(groups: &[Vec<u32>], pressed: &HashSet<u32>, used: &mut HashSet<u32>) -> bool {
    let Some((first, rest)) = groups.split_first() else { return pressed.iter().all(|key| used.contains(key)); };
    for key in first {
        if pressed.contains(key) && used.insert(*key) {
            if match_modifiers(rest, pressed, used) { return true; }
            used.remove(key);
        }
    }
    false
}

impl BrowserKeymap {
    fn update_if_newer(&mut self, generation: u64, focused: bool, caps_term: bool, bindings: Vec<Binding>) -> bool {
        if generation < self.generation { return false; }
        self.reset(generation, focused, bindings);
        self.caps_term = caps_term;
        true
    }

    pub fn reset(&mut self, generation: u64, focused: bool, bindings: Vec<Binding>) {
        self.generation = generation;
        self.focused = focused;
        self.pressed.clear();
        self.bindings = bindings;
    }

    pub fn key(&mut self, generation: u64, key: u32, down: bool) -> (bool, Option<&str>) {
        if !self.focused || generation != self.generation {
            return (false, None);
        }
        if !down {
            self.pressed.remove(&key);
            return (self.consumed.remove(&key), None);
        }
        let repeated = !self.pressed.insert(key);
        let matched = self.bindings.iter().find(|binding| {
            if binding.key != key { return false; }
            let mut used = HashSet::from([key]);
            match_modifiers(&binding.modifiers, &self.pressed, &mut used)
        });
        if let Some(binding) = matched {
            self.consumed.insert(key);
            if self.pressed.contains(&0x5d) { self.consumed.insert(0x5d); }
            return (true, (!repeated || binding.repeat).then_some(binding.command.as_str()));
        }
        if self.consumed.contains(&key) { return (true, None); }
        (false, None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_modifiers_and_balances_consumed_release() {
        let mut map = BrowserKeymap::default();
        map.reset(3, true, vec![Binding { command: "settings.toggle".into(), key: 83, modifiers: vec![vec![1, 2], vec![3]], repeat: false }]);
        assert_eq!(map.key(3, 2, true), (false, None));
        assert_eq!(map.key(3, 3, true), (false, None));
        assert_eq!(map.key(3, 83, true), (true, Some("settings.toggle")));
        assert_eq!(map.key(3, 83, true), (true, None));
        assert_eq!(map.key(3, 83, false), (true, None));
        map.reset(4, false, vec![]);
        assert_eq!(map.key(3, 83, true), (false, None));
    }

    #[test]
    fn finds_distinct_modifier_assignment() {
        let mut map = BrowserKeymap::default();
        map.reset(1, true, vec![Binding { command: "test".into(), key: 83, modifiers: vec![vec![1, 2], vec![1]], repeat: false }]);
        map.key(1, 1, true);
        map.key(1, 2, true);
        assert_eq!(map.key(1, 83, true), (true, Some("test")));
    }

    #[test]
    fn consumed_key_repeats_stay_consumed_after_modifier_release() {
        let mut map = BrowserKeymap::default();
        map.reset(1, true, vec![Binding { command: "settings.toggle".into(), key: 83, modifiers: vec![vec![0x5d]], repeat: false }]);
        map.key(1, 0x5d, true);
        assert_eq!(map.key(1, 83, true), (true, Some("settings.toggle")));
        map.key(1, 0x5d, false);
        assert_eq!(map.key(1, 83, true), (true, None));
        assert_eq!(map.key(1, 83, false), (true, None));
    }

    #[test]
    fn consumed_key_stays_consumed_when_map_resets_while_held() {
        let mut map = BrowserKeymap::default();
        map.reset(1, true, vec![Binding { command: "test".into(), key: 83, modifiers: vec![], repeat: false }]);
        assert_eq!(map.key(1, 83, true), (true, Some("test")));
        map.reset(2, true, vec![]);
        assert_eq!(map.key(2, 83, true), (true, None));
        assert_eq!(map.key(2, 83, false), (true, None));
        assert_eq!(map.key(2, 83, true), (false, None));
    }

    #[test]
    fn failed_dispatch_releases_key_for_normal_input() {
        let state = BrowserKeymapState::default();
        state.0.lock().unwrap().reset(1, true, vec![Binding { command: "test".into(), key: 83, modifiers: vec![], repeat: false }]);
        assert_eq!(state.key(1, 83, true).0, true);
        state.release_consumed(83);
        assert_eq!(state.key(1, 83, false).0, false);
    }

    #[test]
    fn consumed_release_survives_focus_and_map_changes() {
        let state = BrowserKeymapState::default();
        state.0.lock().unwrap().reset(1, true, vec![Binding { command: "test".into(), key: 83, modifiers: vec![], repeat: false }]);
        assert!(state.key(1, 83, true).0);
        state.clear_pressed();
        state.0.lock().unwrap().reset(2, false, vec![]);
        assert!(state.take_consumed_up(83));
        assert!(!state.take_consumed_up(83));
    }

    #[test]
    fn consumed_release_survives_a_busy_matcher() {
        let state = BrowserKeymapState::default();
        state.0.lock().unwrap().reset(1, true, vec![Binding { command: "test".into(), key: 83, modifiers: vec![], repeat: false }]);
        assert!(state.key(1, 83, true).0);
        let guard = state.0.lock().unwrap();
        assert!(state.take_consumed_up(83));
        drop(guard);
        assert!(state.key(1, 83, true).0);
    }

    #[test]
    fn stale_snapshot_does_not_replace_the_newer_browser_keymap() {
        let mut map = BrowserKeymap::default();
        assert!(map.update_if_newer(2, true, false, vec![Binding { command: "new".into(), key: 83, modifiers: vec![], repeat: false }]));
        assert_eq!(map.key(2, 83, true), (true, Some("new")));

        assert!(!map.update_if_newer(1, false, false, vec![Binding { command: "old".into(), key: 65, modifiers: vec![], repeat: false }]));
        assert_eq!(map.key(2, 65, true), (false, None));
        map.key(2, 65, false);
        map.key(2, 83, false);
        assert_eq!(map.key(2, 83, true), (true, Some("new")));
    }

    #[test]
    fn accepts_the_three_alt_variants_and_rejects_four() {
        let binding = Binding { command: "fullscreen".into(), key: 0x0d, modifiers: vec![vec![0xa4, 0xa5, 0x12]], repeat: false };
        assert!(valid_bindings(&[binding.clone()]));
        assert!(!valid_bindings(&[Binding { modifiers: vec![vec![0xa4, 0xa5, 0x12, 0x11]], ..binding }]));
    }

    #[test]
    fn active_command_uses_the_held_alt_variant() {
        let state = BrowserKeymapState::default();
        state.0.lock().unwrap().reset(1, true, vec![Binding { command: "window.toggle_fullscreen".into(), key: 0x0d, modifiers: vec![vec![0xa4, 0xa5, 0x12]], repeat: false }]);
        assert_eq!(state.active_command("window.toggle_fullscreen", 0x0d), None);
        state.key(1, 0xa5, true);
        assert_eq!(state.active_command("window.toggle_fullscreen", 0x0d), Some(1));
    }

    #[test]
    fn probe_chord_requires_an_active_exact_binding_and_rejects_system_keys() {
        let state = BrowserKeymapState::default();
        state.0.lock().unwrap().reset(1, true, vec![Binding {
            command: "test".into(), key: 83, modifiers: vec![vec![0xA2], vec![0xA0]], repeat: false,
        }]);
        assert!(state.supports_probe_chord(&[0xA2, 0xA0, 83]));
        assert!(!state.supports_probe_chord(&[0xA2, 83]));
        assert!(!state.supports_probe_chord(&[0x5B, 83]));
        assert!(!state.supports_probe_chord(&[0xA2, 0xA2, 83]));
        assert!(!state.supports_probe_chord(&[0x14, 83]));
        {
            let mut map = state.0.lock().unwrap();
            map.caps_term = true;
            map.bindings = vec![Binding { command: "caps-test".into(), key: 83, modifiers: vec![vec![0x14]], repeat: false }];
        }
        assert!(state.supports_probe_chord(&[0x14, 83]));
    }
}
