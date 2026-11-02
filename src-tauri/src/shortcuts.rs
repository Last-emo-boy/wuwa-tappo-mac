use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::ErrorKind,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{
    Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutEvent, ShortcutState,
};

pub const COMMANDS: &[&str] = &[
    "get_app_shortcuts",
    "set_app_shortcuts",
    "set_shortcut_capture",
    "get_shortcut_status",
];

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Binding {
    modifiers: u8,
    key: u16,
}

impl Binding {
    fn shortcut(self) -> Result<Option<Shortcut>, String> {
        if self.key == 0 {
            return if self.modifiers == 0 {
                Ok(None)
            } else {
                Err("unavailable".into())
            };
        }
        // Preserve the official Windows-VK wire format and modifier bits. The
        // physical key mapping below is the macOS equivalent of DOM event.code.
        if self.modifiers & !15 != 0 || (self.key < 112 && self.modifiers & 11 == 0) {
            return Err("unavailable".into());
        }
        let code = match self.key {
            32 => Code::Space,
            33 => Code::PageUp,
            34 => Code::PageDown,
            35 => Code::End,
            36 => Code::Home,
            37 => Code::ArrowLeft,
            38 => Code::ArrowUp,
            39 => Code::ArrowRight,
            40 => Code::ArrowDown,
            45 => Code::Insert,
            46 => Code::Delete,
            48..=57 => format!("Digit{}", char::from(self.key as u8))
                .parse()
                .map_err(|_| "unavailable")?,
            65..=90 => format!("Key{}", char::from(self.key as u8))
                .parse()
                .map_err(|_| "unavailable")?,
            // Carbon has physical scan codes for F1–F20, not F21–F24.
            112..=131 => format!("F{}", self.key - 111)
                .parse()
                .map_err(|_| "unavailable")?,
            186 => Code::Semicolon,
            187 => Code::Equal,
            188 => Code::Comma,
            189 => Code::Minus,
            190 => Code::Period,
            191 => Code::Slash,
            192 => Code::Backquote,
            219 => Code::BracketLeft,
            220 => Code::Backslash,
            221 => Code::BracketRight,
            222 => Code::Quote,
            _ => return Err("unavailable".into()),
        };
        let mut modifiers = Modifiers::empty();
        for (bit, modifier) in [
            (1, Modifiers::ALT),
            (2, Modifiers::CONTROL),
            (4, Modifiers::SHIFT),
            (8, Modifiers::SUPER),
        ] {
            if self.modifiers & bit != 0 {
                modifiers |= modifier;
            }
        }
        Ok(Some(Shortcut::new(Some(modifiers), code)))
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    game_mode: Binding,
    switch_screen: Binding,
    toggle_pet: Binding,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            game_mode: Binding {
                modifiers: 0,
                key: 118,
            },
            switch_screen: Binding {
                modifiers: 0,
                key: 119,
            },
            toggle_pet: Binding {
                modifiers: 0,
                key: 120,
            },
        }
    }
}

impl Config {
    fn shortcuts(&self) -> Result<BTreeMap<u32, (&'static str, Shortcut)>, String> {
        let mut shortcuts = BTreeMap::new();
        for (action, binding) in [
            ("gameMode", self.game_mode),
            ("switchScreen", self.switch_screen),
            ("togglePet", self.toggle_pet),
        ] {
            if let Some(shortcut) = binding.shortcut()? {
                if shortcuts
                    .insert(shortcut.id(), (action, shortcut))
                    .is_some()
                {
                    return Err("duplicate".into());
                }
            }
        }
        Ok(shortcuts)
    }
}

trait Registry {
    fn register(&self, shortcut: Shortcut) -> Result<(), String>;
    fn unregister(&self, shortcut: Shortcut) -> Result<(), String>;
}

struct NativeRegistry<'a>(&'a AppHandle);

impl Registry for NativeRegistry<'_> {
    fn register(&self, shortcut: Shortcut) -> Result<(), String> {
        self.0
            .global_shortcut()
            .register(shortcut)
            .map_err(|error| {
                eprintln!("Global shortcut registration failed: {error}");
                match error {
                    tauri_plugin_global_shortcut::Error::GlobalHotkey(_) => "occupied".into(),
                    _ => "unavailable".into(),
                }
            })
    }

    fn unregister(&self, shortcut: Shortcut) -> Result<(), String> {
        self.0
            .global_shortcut()
            .unregister(shortcut)
            .map_err(|error| {
                eprintln!("Global shortcut removal failed: {error}");
                "unavailable".into()
            })
    }
}

type Registered = BTreeMap<u32, Shortcut>;

// Register additions first. A conflict never removes working old bindings.
fn replace_registered(
    registry: &impl Registry,
    current: &mut Registered,
    desired: &Registered,
) -> Result<(), String> {
    let previous = current.clone();
    let result = (|| {
        for (&id, &shortcut) in desired {
            if !current.contains_key(&id) {
                registry.register(shortcut)?;
                current.insert(id, shortcut);
            }
        }
        for (&id, &shortcut) in &previous {
            if !desired.contains_key(&id) {
                registry.unregister(shortcut)?;
                current.remove(&id);
            }
        }
        Ok(())
    })();
    if let Err(error) = result {
        let mut recovery_failed = false;
        for (&id, &shortcut) in &previous {
            if !current.contains_key(&id) {
                if registry.register(shortcut).is_ok() {
                    current.insert(id, shortcut);
                } else {
                    recovery_failed = true;
                }
            }
        }
        for (id, shortcut) in current.clone() {
            if !previous.contains_key(&id) {
                if registry.unregister(shortcut).is_ok() {
                    current.remove(&id);
                } else {
                    recovery_failed = true;
                }
            }
        }
        return Err(if recovery_failed {
            "unavailable".into()
        } else {
            error
        });
    }
    Ok(())
}

fn load_config(path: &Path) -> Result<Config, String> {
    let config = match fs::read(path) {
        Ok(bytes) => {
            serde_json::from_slice(&bytes).map_err(|error| format!("快捷键配置无效：{error}"))?
        }
        Err(error) if error.kind() == ErrorKind::NotFound => Config::default(),
        Err(error) => return Err(format!("无法读取快捷键配置：{error}")),
    };
    config.shortcuts()?;
    Ok(config)
}

fn save_config(path: &Path, config: &Config) -> Result<(), String> {
    let parent = path.parent().ok_or("快捷键配置目录不可用")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temporary = path.with_extension(format!("{}.tmp", std::process::id()));
    let bytes = serde_json::to_vec(config).map_err(|error| error.to_string())?;
    fs::write(&temporary, bytes).map_err(|error| error.to_string())?;
    fs::rename(&temporary, path).map_err(|error| error.to_string())
}

#[derive(Clone, Serialize)]
pub struct Status {
    error: Option<String>,
}

struct Runtime {
    config: Config,
    registered: Registered,
    pressed: BTreeSet<u32>,
    capture_owner: Option<String>,
    error: Option<String>,
}

impl Runtime {
    fn update(
        &mut self,
        registry: &impl Registry,
        config: Config,
        persist: impl FnOnce(&Config) -> Result<(), String>,
    ) -> Result<(), String> {
        let desired = registered_config(&config)?;
        let previous = self.registered.clone();
        let result = replace_registered(registry, &mut self.registered, &desired).and_then(|()| {
            if self.capture_owner.is_some() {
                replace_registered(registry, &mut self.registered, &Registered::new())?;
            }
            persist(&config)
        });
        if let Err(error) = result {
            if let Err(recovery) = replace_registered(registry, &mut self.registered, &previous) {
                self.error = Some(recovery);
                return Err("unavailable".into());
            }
            return Err(error);
        }
        self.config = config;
        self.error = None;
        self.pressed.clear();
        Ok(())
    }

    fn capture(
        &mut self,
        registry: &impl Registry,
        label: &str,
        active: bool,
    ) -> Result<(), String> {
        if self
            .capture_owner
            .as_deref()
            .is_some_and(|owner| owner != label)
        {
            return Err("unavailable".into());
        }
        if !active {
            self.capture_owner = None;
            return self.restore(registry);
        }
        let result = replace_registered(registry, &mut self.registered, &Registered::new());
        if result.is_ok() {
            self.capture_owner = Some(label.to_owned());
        }
        record_result(self, &result);
        result
    }

    fn restore(&mut self, registry: &impl Registry) -> Result<(), String> {
        let desired = registered_config(&self.config)?;
        let mut failure = None;
        // A conflict must not disable other available shortcuts or prevent
        // opening Settings to assign a different binding.
        for (id, shortcut) in desired {
            if !self.registered.contains_key(&id) {
                match registry.register(shortcut) {
                    Ok(()) => {
                        self.registered.insert(id, shortcut);
                    }
                    Err(error) => {
                        failure = Some(error);
                    }
                }
            }
        }
        let result = failure.map_or(Ok(()), Err);
        record_result(self, &result);
        result
    }

    fn action(
        &mut self,
        shortcut: &Shortcut,
        state: ShortcutState,
    ) -> Result<Option<&'static str>, String> {
        if state == ShortcutState::Released {
            self.pressed.remove(&shortcut.id());
            return Ok(None);
        }
        if self.capture_owner.is_some()
            || !self.registered.contains_key(&shortcut.id())
            || !self.pressed.insert(shortcut.id())
        {
            return Ok(None);
        }
        Ok(self
            .config
            .shortcuts()?
            .get(&shortcut.id())
            .map(|&(action, _)| action))
    }
}

pub struct ShortcutStore {
    path: PathBuf,
    runtime: Mutex<Runtime>,
}

impl ShortcutStore {
    pub fn open(path: PathBuf) -> Result<Self, String> {
        Ok(Self {
            runtime: Mutex::new(Runtime {
                config: load_config(&path)?,
                registered: BTreeMap::new(),
                pressed: BTreeSet::new(),
                capture_owner: None,
                error: None,
            }),
            path,
        })
    }
}

fn registered_config(config: &Config) -> Result<Registered, String> {
    Ok(config
        .shortcuts()?
        .into_iter()
        .map(|(id, (_, shortcut))| (id, shortcut))
        .collect())
}

fn record_result(runtime: &mut Runtime, result: &Result<(), String>) {
    runtime.error = result.as_ref().err().cloned();
    runtime.pressed.clear();
}

fn emit_status(app: &AppHandle) -> Result<(), String> {
    let store = app.state::<ShortcutStore>();
    let error = store
        .runtime
        .lock()
        .map_err(|_| "shortcut_state_lock_poisoned")?
        .error
        .clone();
    app.emit("mac-shortcut-status", Status { error })
        .map_err(|error| error.to_string())
}

pub fn start(app: &AppHandle) -> Result<(), String> {
    let store = app.state::<ShortcutStore>();
    let mut runtime = store
        .runtime
        .lock()
        .map_err(|_| "shortcut_state_lock_poisoned")?;
    let result = runtime.restore(&NativeRegistry(app));
    drop(runtime);
    emit_status(app)?;
    result
}

fn set_config(app: &AppHandle, config: Config) -> Result<(), String> {
    let store = app.state::<ShortcutStore>();
    let mut runtime = store
        .runtime
        .lock()
        .map_err(|_| "shortcut_state_lock_poisoned")?;
    // Even during recording, test native registration before accepting a new
    // binding, then release it so subsequent DOM key capture remains available.
    let result = runtime.update(&NativeRegistry(app), config.clone(), |config| {
        save_config(&store.path, config)
    });
    drop(runtime);
    emit_status(app)?;
    result?;
    app.emit("app-shortcuts-changed", config)
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn capture(app: &AppHandle, label: &str, active: bool) -> Result<(), String> {
    let store = app.state::<ShortcutStore>();
    let mut runtime = store
        .runtime
        .lock()
        .map_err(|_| "shortcut_state_lock_poisoned")?;
    let result = runtime.capture(&NativeRegistry(app), label, active);
    drop(runtime);
    emit_status(app)?;
    result
}

pub fn release_capture(app: &AppHandle, label: &str) -> Result<(), String> {
    let owner = app
        .state::<ShortcutStore>()
        .runtime
        .lock()
        .map_err(|_| "shortcut_state_lock_poisoned")?
        .capture_owner
        .clone();
    if owner.as_deref() == Some(label) {
        capture(app, label, false)?;
    }
    Ok(())
}

pub fn dispatch(
    app: &AppHandle,
    label: &str,
    command: &str,
    args: &Value,
) -> Result<Value, String> {
    let store = app.state::<ShortcutStore>();
    match command {
        "get_app_shortcuts" => serde_json::to_value(
            &store
                .runtime
                .lock()
                .map_err(|_| "shortcut_state_lock_poisoned")?
                .config,
        )
        .map_err(|error| error.to_string()),
        "get_shortcut_status" => Ok(serde_json::json!({"error":store.runtime.lock()
            .map_err(|_| "shortcut_state_lock_poisoned")?.error})),
        "set_app_shortcuts" | "set_shortcut_capture" if label != "panel" => {
            Err("unavailable".into())
        }
        "set_app_shortcuts" => {
            let config = serde_json::from_value(args.get("config").cloned().ok_or("unavailable")?)
                .map_err(|_| "unavailable")?;
            set_config(app, config).map(|()| Value::Null)
        }
        "set_shortcut_capture" => capture(
            app,
            label,
            args.get("active")
                .and_then(Value::as_bool)
                .ok_or("unavailable")?,
        )
        .map(|()| Value::Null),
        _ => Err(format!("Unknown shortcut command {command}")),
    }
}

fn handle_event(app: &AppHandle, shortcut: &Shortcut, event: ShortcutEvent) {
    let Some(store) = app.try_state::<ShortcutStore>() else {
        return;
    };
    let action = (|| {
        let mut runtime = store
            .runtime
            .lock()
            .map_err(|_| "shortcut_state_lock_poisoned")?;
        runtime.action(shortcut, event.state)
    })();
    match action {
        Ok(Some(action)) => {
            if let Err(error) = app.emit("app-shortcut", action) {
                eprintln!("Global shortcut event delivery failed: {error}");
            }
        }
        Ok(None) => {}
        Err(error) => eprintln!("Global shortcut state failed: {error}"),
    }
}

pub fn plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(handle_event)
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[derive(Default)]
    struct FakeRegistry {
        registered: RefCell<Registered>,
        occupied: RefCell<BTreeSet<u32>>,
        unregister_failure: RefCell<BTreeSet<u32>>,
    }

    impl Registry for FakeRegistry {
        fn register(&self, shortcut: Shortcut) -> Result<(), String> {
            if self.occupied.borrow().contains(&shortcut.id()) {
                return Err("occupied".into());
            }
            if self
                .registered
                .borrow_mut()
                .insert(shortcut.id(), shortcut)
                .is_some()
            {
                return Err("already registered".into());
            }
            Ok(())
        }

        fn unregister(&self, shortcut: Shortcut) -> Result<(), String> {
            if self.unregister_failure.borrow().contains(&shortcut.id()) {
                return Err("unavailable".into());
            }
            self.registered.borrow_mut().remove(&shortcut.id());
            Ok(())
        }
    }

    fn runtime(registry: &FakeRegistry) -> Runtime {
        let config = Config::default();
        let registered = registered_config(&config).unwrap();
        *registry.registered.borrow_mut() = registered.clone();
        Runtime {
            config,
            registered,
            pressed: BTreeSet::new(),
            capture_owner: None,
            error: None,
        }
    }

    #[test]
    fn official_defaults_and_modifier_bits_keep_the_windows_wire_contract() {
        let config = Config::default();
        assert_eq!(
            serde_json::to_value(&config).unwrap(),
            serde_json::json!({
                "gameMode":{"modifiers":0,"key":118},
                "switchScreen":{"modifiers":0,"key":119},
                "togglePet":{"modifiers":0,"key":120}
            })
        );
        for (bit, modifier) in [
            (1, Modifiers::ALT),
            (2, Modifiers::CONTROL),
            (4, Modifiers::SHIFT),
            (8, Modifiers::SUPER),
        ] {
            assert_eq!(
                Binding {
                    modifiers: bit,
                    key: 118
                }
                .shortcut()
                .unwrap()
                .unwrap(),
                Shortcut::new(Some(modifier), Code::F7)
            );
        }
        assert_eq!(
            Binding {
                modifiers: 15,
                key: 65
            }
            .shortcut()
            .unwrap()
            .unwrap(),
            Shortcut::new(
                Some(Modifiers::ALT | Modifiers::CONTROL | Modifiers::SHIFT | Modifiers::SUPER),
                Code::KeyA
            )
        );
    }

    #[test]
    fn keys_match_dom_physical_codes_and_clear_is_explicit() {
        for (key, code) in [
            (32, Code::Space),
            (37, Code::ArrowLeft),
            (48, Code::Digit0),
            (90, Code::KeyZ),
            (112, Code::F1),
            (131, Code::F20),
            (186, Code::Semicolon),
            (220, Code::Backslash),
            (222, Code::Quote),
        ] {
            assert_eq!(
                Binding { modifiers: 2, key }.shortcut().unwrap().unwrap(),
                Shortcut::new(Some(Modifiers::CONTROL), code)
            );
        }
        assert_eq!(
            Binding {
                modifiers: 0,
                key: 0
            }
            .shortcut()
            .unwrap(),
            None
        );
        for binding in [
            Binding {
                modifiers: 1,
                key: 0,
            },
            Binding {
                modifiers: 16,
                key: 118,
            },
            Binding {
                modifiers: 0,
                key: 65,
            },
            Binding {
                modifiers: 4,
                key: 65,
            },
            Binding {
                modifiers: 0,
                key: 132,
            },
            Binding {
                modifiers: 0,
                key: 10,
            },
        ] {
            assert_eq!(binding.shortcut().unwrap_err(), "unavailable");
        }
        // The official recorder permits unmodified OEM punctuation (VK >=112).
        assert!(Binding {
            modifiers: 0,
            key: 186
        }
        .shortcut()
        .unwrap()
        .is_some());
    }

    #[test]
    fn duplicate_bindings_fail_but_multiple_cleared_actions_are_valid() {
        let mut config = Config::default();
        config.game_mode = config.toggle_pet;
        assert_eq!(config.shortcuts().unwrap_err(), "duplicate");
        config.game_mode = Binding {
            modifiers: 0,
            key: 0,
        };
        config.toggle_pet = config.game_mode;
        assert_eq!(config.shortcuts().unwrap().len(), 1);
        assert!(serde_json::from_value::<Config>(
            serde_json::json!({"gameMode":{"key":118,"modifiers":0}})
        )
        .is_err());
        assert!(
            serde_json::from_value::<Binding>(serde_json::json!({"key":118.5,"modifiers":0}))
                .is_err()
        );
    }

    #[test]
    fn conflicts_preserve_previous_config_and_native_registrations() {
        let registry = FakeRegistry::default();
        let mut runtime = runtime(&registry);
        let previous = runtime.config.clone();
        let old_registered = runtime.registered.clone();
        let mut candidate = previous.clone();
        candidate.toggle_pet = Binding {
            modifiers: 8,
            key: 84,
        };
        let blocked = candidate.toggle_pet.shortcut().unwrap().unwrap();
        registry.occupied.borrow_mut().insert(blocked.id());
        let error = runtime
            .update(&registry, candidate, |_| {
                panic!("conflicting config cannot persist")
            })
            .unwrap_err();
        assert_eq!(error, "occupied");
        assert_eq!(runtime.config, previous);
        assert_eq!(runtime.registered, old_registered);
        assert_eq!(*registry.registered.borrow(), old_registered);
    }

    #[test]
    fn failed_persistence_rolls_back_changed_registration_and_configuration() {
        let registry = FakeRegistry::default();
        let mut runtime = runtime(&registry);
        let previous = runtime.config.clone();
        let registered = runtime.registered.clone();
        let mut candidate = previous.clone();
        candidate.game_mode = Binding {
            modifiers: 8,
            key: 71,
        };
        assert_eq!(
            runtime
                .update(&registry, candidate, |_| Err("disk write failed".into()))
                .unwrap_err(),
            "disk write failed"
        );
        assert_eq!(runtime.config, previous);
        assert_eq!(runtime.registered, registered);
        assert_eq!(*registry.registered.borrow(), registered);
    }

    #[test]
    fn reassigning_existing_keys_between_actions_does_not_reregister_them() {
        let registry = FakeRegistry::default();
        let mut runtime = runtime(&registry);
        let old = runtime.registered.clone();
        let mut candidate = runtime.config.clone();
        std::mem::swap(&mut candidate.game_mode, &mut candidate.toggle_pet);
        runtime
            .update(&registry, candidate.clone(), |_| Ok(()))
            .unwrap();
        assert_eq!(runtime.registered, old);
        let key = candidate.game_mode.shortcut().unwrap().unwrap();
        assert_eq!(
            runtime.action(&key, ShortcutState::Pressed).unwrap(),
            Some("gameMode")
        );
    }

    #[test]
    fn capture_releases_shortcuts_tests_candidate_conflicts_then_restores() {
        let registry = FakeRegistry::default();
        let mut runtime = runtime(&registry);
        let previous = runtime.config.clone();
        runtime.capture(&registry, "panel", true).unwrap();
        assert!(registry.registered.borrow().is_empty());
        assert_eq!(runtime.capture_owner.as_deref(), Some("panel"));
        let mut candidate = previous.clone();
        candidate.toggle_pet = Binding {
            modifiers: 8,
            key: 84,
        };
        let blocked = candidate.toggle_pet.shortcut().unwrap().unwrap();
        registry.occupied.borrow_mut().insert(blocked.id());
        assert_eq!(
            runtime
                .update(&registry, candidate.clone(), |_| panic!(
                    "must not accept conflict during recording"
                ))
                .unwrap_err(),
            "occupied"
        );
        assert_eq!(runtime.config, previous);
        assert!(runtime.registered.is_empty());
        registry.occupied.borrow_mut().clear();
        runtime
            .update(&registry, candidate.clone(), |_| Ok(()))
            .unwrap();
        assert!(runtime.registered.is_empty());
        assert!(registry.registered.borrow().is_empty());
        assert_eq!(runtime.config, candidate);
        runtime.capture(&registry, "panel", false).unwrap();
        assert!(runtime.capture_owner.is_none());
        assert_eq!(runtime.registered, registered_config(&candidate).unwrap());
        assert_eq!(*registry.registered.borrow(), runtime.registered);
    }

    #[test]
    fn capture_ownership_and_failed_resume_can_recover_without_stealing() {
        let registry = FakeRegistry::default();
        let mut runtime = runtime(&registry);
        runtime.capture(&registry, "panel", true).unwrap();
        assert_eq!(
            runtime.capture(&registry, "other", false).unwrap_err(),
            "unavailable"
        );
        assert_eq!(runtime.capture_owner.as_deref(), Some("panel"));
        let key = runtime.config.toggle_pet.shortcut().unwrap().unwrap();
        registry.occupied.borrow_mut().insert(key.id());
        assert_eq!(
            runtime.capture(&registry, "panel", false).unwrap_err(),
            "occupied"
        );
        assert!(runtime.capture_owner.is_none());
        assert_eq!(runtime.error.as_deref(), Some("occupied"));
        assert_eq!(runtime.registered.len(), 2);
        registry.occupied.borrow_mut().clear();
        runtime.capture(&registry, "panel", false).unwrap();
        assert!(runtime.error.is_none());
        assert_eq!(runtime.registered.len(), 3);
    }

    #[test]
    fn a_press_emits_one_action_and_repeats_release_capture_emit_none() {
        let registry = FakeRegistry::default();
        let mut runtime = runtime(&registry);
        let key = runtime.config.toggle_pet.shortcut().unwrap().unwrap();
        assert_eq!(
            runtime.action(&key, ShortcutState::Pressed).unwrap(),
            Some("togglePet")
        );
        assert_eq!(runtime.action(&key, ShortcutState::Pressed).unwrap(), None);
        assert_eq!(runtime.action(&key, ShortcutState::Released).unwrap(), None);
        assert_eq!(
            runtime.action(&key, ShortcutState::Pressed).unwrap(),
            Some("togglePet")
        );
        runtime.capture(&registry, "panel", true).unwrap();
        assert_eq!(runtime.action(&key, ShortcutState::Pressed).unwrap(), None);
        runtime.capture(&registry, "panel", false).unwrap();
        assert_eq!(
            runtime.action(&key, ShortcutState::Pressed).unwrap(),
            Some("togglePet")
        );
        let unregistered = Shortcut::new(Some(Modifiers::SUPER), Code::KeyZ);
        assert_eq!(
            runtime
                .action(&unregistered, ShortcutState::Pressed)
                .unwrap(),
            None
        );
    }

    #[test]
    fn failed_unregistration_restores_previously_removed_shortcuts() {
        let registry = FakeRegistry::default();
        let mut runtime = runtime(&registry);
        let previous = runtime.registered.clone();
        let last = *previous.keys().last().unwrap();
        registry.unregister_failure.borrow_mut().insert(last);
        assert_eq!(
            runtime.capture(&registry, "panel", true).unwrap_err(),
            "unavailable"
        );
        assert!(runtime.capture_owner.is_none());
        assert_eq!(runtime.registered, previous);
        assert_eq!(*registry.registered.borrow(), previous);
    }

    #[test]
    fn regional_paths_persist_independently_and_corrupt_configs_are_explicit() {
        let root = std::env::temp_dir().join(format!("wuwa-shortcuts-{}", std::process::id()));
        let cn = root.join("cn/shortcuts.json");
        let global = root.join("global/shortcuts.json");
        assert_eq!(load_config(&cn).unwrap(), Config::default());
        let mut custom = Config::default();
        custom.toggle_pet = Binding {
            modifiers: 8,
            key: 84,
        };
        save_config(&cn, &custom).unwrap();
        assert_eq!(load_config(&cn).unwrap(), custom);
        assert_eq!(load_config(&global).unwrap(), Config::default());
        fs::write(&cn, b"broken").unwrap();
        assert!(load_config(&cn).is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
