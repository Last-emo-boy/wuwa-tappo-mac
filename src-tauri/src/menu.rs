use serde::Deserialize;
use serde_json::Value;
use std::sync::Mutex;
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, MenuItemKind, PredefinedMenuItem, Submenu},
    tray::{TrayIcon, TrayIconBuilder},
    AppHandle, Emitter, LogicalPosition, Manager, WebviewWindow,
};

const TRAY_ID: &str = "wuwatappo-mac-tray";
const SCALE_PRESETS: [u32; 7] = [50, 75, 100, 125, 150, 175, 200];
const OPACITY_PRESETS: [u32; 5] = [0, 25, 50, 75, 100];

#[derive(Clone, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct Labels {
    open_bag: String,
    open_atlas: String,
    open_exchange: String,
    open_room: String,
    hide_pet: String,
    show_pet: String,
    tray_open_settings: String,
    dock_settings: String,
    window_size: String,
    window_passthrough: String,
    window_opacity: String,
    restart: String,
    quit: String,
    tray_tooltip: String,
}

impl Default for Labels {
    fn default() -> Self {
        Self {
            open_bag: "背包".into(),
            open_atlas: "图鉴".into(),
            open_exchange: "合成".into(),
            open_room: "联机".into(),
            hide_pet: "隐藏桌宠".into(),
            show_pet: "显示桌宠".into(),
            tray_open_settings: "设置".into(),
            dock_settings: "设置".into(),
            window_size: "桌宠大小".into(),
            window_passthrough: "鼠标穿透".into(),
            window_opacity: "不透明度".into(),
            restart: "重新启动".into(),
            quit: "退出 Wuwa Tappo".into(),
            tray_tooltip: "Wuwa Tappo".into(),
        }
    }
}

#[derive(Clone, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct MenuOptions {
    labels: Labels,
    pet_dock_visible: bool,
    pet_scale: u32,
    window_opacity: u32,
    window_passthrough: bool,
}

impl Default for MenuOptions {
    fn default() -> Self {
        Self {
            labels: Labels::default(),
            pet_dock_visible: true,
            pet_scale: 100,
            window_opacity: 100,
            window_passthrough: false,
        }
    }
}

impl MenuOptions {
    fn from_args(args: &Value) -> Result<Self, String> {
        let options: Self = serde_json::from_value(args.clone()).map_err(|e| e.to_string())?;
        if !(50..=200).contains(&options.pet_scale) {
            return Err("petScale must be between 50 and 200".into());
        }
        if options.window_opacity > 100 {
            return Err("windowOpacity must be between 0 and 100".into());
        }
        Ok(options)
    }
}

struct MenuState {
    context: Mutex<Menu<tauri::Wry>>,
    tray: TrayIcon,
}

fn normal(app: &AppHandle, id: &str, title: &str) -> tauri::Result<MenuItemKind<tauri::Wry>> {
    Ok(MenuItemKind::MenuItem(MenuItem::with_id(
        app,
        id,
        title,
        true,
        None::<&str>,
    )?))
}

fn checked(
    app: &AppHandle,
    id: &str,
    title: &str,
    value: bool,
) -> tauri::Result<MenuItemKind<tauri::Wry>> {
    Ok(MenuItemKind::Check(CheckMenuItem::with_id(
        app,
        id,
        title,
        true,
        value,
        None::<&str>,
    )?))
}

fn selection_menu(
    app: &AppHandle,
    title: &str,
    prefix: &str,
    presets: &[u32],
    selected: u32,
) -> tauri::Result<MenuItemKind<tauri::Wry>> {
    let submenu = Submenu::new(app, title, true)?;
    for preset in presets {
        submenu.append(&CheckMenuItem::with_id(
            app,
            format!("{prefix}-{preset}"),
            format!("{preset}%"),
            true,
            selected == *preset,
            None::<&str>,
        )?)?;
    }
    if !presets.contains(&selected) {
        submenu.append(&CheckMenuItem::with_id(
            app,
            format!("{prefix}-{selected}"),
            format!("{selected}%"),
            true,
            true,
            None::<&str>,
        )?)?;
    }
    Ok(MenuItemKind::Submenu(submenu))
}

fn context_items(
    app: &AppHandle,
    options: &MenuOptions,
    tray: bool,
) -> tauri::Result<Vec<MenuItemKind<tauri::Wry>>> {
    let labels = &options.labels;
    let visibility = if options.pet_dock_visible {
        &labels.hide_pet
    } else {
        &labels.show_pet
    };
    let settings = if tray {
        &labels.tray_open_settings
    } else {
        &labels.dock_settings
    };
    Ok(vec![
        normal(app, "open-bag", &labels.open_bag)?,
        normal(app, "open-atlas", &labels.open_atlas)?,
        normal(app, "open-exchange", &labels.open_exchange)?,
        normal(app, "open-room", &labels.open_room)?,
        normal(app, "open-setting", settings)?,
        MenuItemKind::Predefined(PredefinedMenuItem::separator(app)?),
        normal(app, "toggle-pet", visibility)?,
        selection_menu(
            app,
            &labels.window_size,
            "pet-scale",
            &SCALE_PRESETS,
            options.pet_scale,
        )?,
        selection_menu(
            app,
            &labels.window_opacity,
            "window-opacity",
            &OPACITY_PRESETS,
            options.window_opacity,
        )?,
        checked(
            app,
            "toggle-passthrough",
            &labels.window_passthrough,
            options.window_passthrough,
        )?,
        MenuItemKind::Predefined(PredefinedMenuItem::separator(app)?),
        normal(app, "input-access", "启用键鼠监听…")?,
        normal(app, "open-logs", "查看日志")?,
        MenuItemKind::Predefined(PredefinedMenuItem::separator(app)?),
        normal(app, "restart", &labels.restart)?,
        normal(app, "quit", &labels.quit)?,
    ])
}

fn context_menu(
    app: &AppHandle,
    options: &MenuOptions,
    tray: bool,
) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::new(app)?;
    for item in context_items(app, options, tray)? {
        menu.append(&item)?;
    }
    Ok(menu)
}

fn application_menu(app: &AppHandle, options: &MenuOptions) -> tauri::Result<Menu<tauri::Wry>> {
    let application = Submenu::new(app, crate::profile::Region::from_app(app).name(), true)?;
    application.append(&MenuItem::with_id(
        app,
        "open-about",
        "关于 Wuwa Tappo",
        true,
        None::<&str>,
    )?)?;
    let session_label = match app.try_state::<crate::session::SessionStore>() {
        Some(session) if session.is_ephemeral() => "登录信息：仅本次会话",
        Some(_) => "登录信息：钥匙串",
        None => "登录信息：尚未选择",
    };
    application.append(&MenuItem::with_id(
        app,
        "session-mode",
        session_label,
        false,
        None::<&str>,
    )?)?;
    application.append(&PredefinedMenuItem::separator(app)?)?;
    application.append(&MenuItem::with_id(
        app,
        "open-setting",
        &options.labels.tray_open_settings,
        true,
        Some("CmdOrCtrl+,"),
    )?)?;
    application.append(&MenuItem::with_id(
        app,
        "input-access",
        "启用键鼠监听…",
        true,
        None::<&str>,
    )?)?;
    application.append(&PredefinedMenuItem::separator(app)?)?;
    application.append(&PredefinedMenuItem::hide(app, None)?)?;
    application.append(&PredefinedMenuItem::hide_others(app, None)?)?;
    application.append(&PredefinedMenuItem::show_all(app, None)?)?;
    application.append(&PredefinedMenuItem::separator(app)?)?;
    application.append(&MenuItem::with_id(
        app,
        "quit",
        &options.labels.quit,
        true,
        Some("CmdOrCtrl+Q"),
    )?)?;

    let edit = Submenu::with_items(
        app,
        "编辑",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let pet = Submenu::new(app, "Wuwa Tappo", true)?;
    for item in context_items(app, options, false)? {
        pet.append(&item)?;
    }
    Menu::with_items(app, &[&application, &edit, &pet])
}

fn event_for_id(id: &str) -> Option<(&'static str, Value)> {
    let event = match id {
        "open-bag" => ("dock-open-panel", Value::from("bag")),
        "open-atlas" => ("dock-open-panel", Value::from("atlas")),
        "open-exchange" => ("dock-open-panel", Value::from("exchange")),
        "open-room" => ("dock-open-panel", Value::from("room")),
        "open-setting" => ("dock-open-panel", Value::from("setting")),
        "toggle-pet" => ("tray-toggle-pet-visibility", Value::Null),
        "toggle-passthrough" => ("tray-toggle-window-passthrough", Value::Null),
        "restart" => ("tray-restart", Value::Null),
        "quit" => ("tray-quit", Value::Null),
        "input-access" => ("mac-request-input-access", Value::Null),
        "open-about" => ("mac-open-about", Value::Null),
        _ => {
            if let Some(value) = id.strip_prefix("pet-scale-") {
                let value = value.parse::<u32>().ok()?;
                if !(50..=200).contains(&value) {
                    return None;
                }
                return Some(("tray-set-pet-scale", Value::from(value)));
            }
            if let Some(value) = id.strip_prefix("window-opacity-") {
                let value = value.parse::<u32>().ok()?;
                if value > 100 {
                    return None;
                }
                return Some(("tray-set-window-opacity", Value::from(value)));
            }
            return None;
        }
    };
    Some(event)
}

pub fn setup(app: &AppHandle) -> Result<(), String> {
    let options = MenuOptions::default();
    let tray_menu = context_menu(app, &options, true).map_err(|e| e.to_string())?;
    let context = context_menu(app, &options, false).map_err(|e| e.to_string())?;
    let icon = app.default_window_icon().cloned().ok_or("Application icon is unavailable")?;
    let tray = TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .tooltip(crate::profile::Region::from_app(app).name())
        .menu(&tray_menu)
        .show_menu_on_left_click(true)
        .build(app)
        .map_err(|e| e.to_string())?;
    app.set_menu(application_menu(app, &options).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    if !app.manage(MenuState {
        context: Mutex::new(context),
        tray,
    }) {
        return Err("native menu already initialized".into());
    }
    app.on_menu_event(|app, event| {
        let id = event.id().as_ref();
        if app.get_webview_window("main").is_none() {
            match id {
                "quit" => {
                    app.exit(0);
                    return;
                }
                "restart" => app.restart(),
                _ => {}
            }
        }
        let result = if id == "open-logs" {
            crate::system::open_log_dir(app)
        } else if let Some((name, payload)) = event_for_id(id) {
            app.emit(name, payload).map_err(|e| e.to_string())
        } else {
            Ok(())
        };
        if let Err(error) = result {
            eprintln!("native menu action failed: {error}");
        }
    });
    Ok(())
}

pub fn sync(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let options = MenuOptions::from_args(args)?;
    let tray_menu = context_menu(app, &options, true).map_err(|e| e.to_string())?;
    let context = context_menu(app, &options, false).map_err(|e| e.to_string())?;
    let state = app
        .try_state::<MenuState>()
        .ok_or("native menu not initialized")?;
    state
        .tray
        .set_menu(Some(tray_menu))
        .map_err(|e| e.to_string())?;
    state
        .tray
        .set_tooltip(Some(&options.labels.tray_tooltip))
        .map_err(|e| e.to_string())?;
    app.set_menu(application_menu(app, &options).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    *state
        .context
        .lock()
        .map_err(|_| "native menu state poisoned")? = context;
    Ok(Value::Null)
}

pub fn popup(app: &AppHandle, window: &WebviewWindow, x: f64, y: f64) -> Result<Value, String> {
    if !x.is_finite() || !y.is_finite() {
        return Err("context menu coordinates must be finite".into());
    }
    let state = app
        .try_state::<MenuState>()
        .ok_or("native menu not initialized")?;
    let menu = state
        .context
        .lock()
        .map_err(|_| "native menu state poisoned")?
        .clone();
    window
        .popup_menu_at(&menu, LogicalPosition::new(x, y))
        .map_err(|e| e.to_string())?;
    Ok(Value::Null)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn normal_shutdown_actions_preserve_frontend_flush_events() {
        assert_eq!(event_for_id("quit"), Some(("tray-quit", Value::Null)));
        assert_eq!(event_for_id("restart"), Some(("tray-restart", Value::Null)));
    }

    #[test]
    fn native_panel_events_match_frontend_tab_validator() {
        for (id, tab) in [
            ("open-bag", "bag"),
            ("open-atlas", "atlas"),
            ("open-exchange", "exchange"),
            ("open-room", "room"),
            ("open-setting", "setting"),
        ] {
            assert_eq!(event_for_id(id), Some(("dock-open-panel", json!(tab))));
        }
    }

    #[test]
    fn scale_and_opacity_payloads_are_numbers() {
        assert_eq!(
            event_for_id("pet-scale-125"),
            Some(("tray-set-pet-scale", json!(125)))
        );
        assert_eq!(
            event_for_id("window-opacity-0"),
            Some(("tray-set-window-opacity", json!(0)))
        );
        assert!(event_for_id("pet-scale-201").is_none());
        assert!(event_for_id("window-opacity-101").is_none());
        assert!(event_for_id("pet-scale-nan").is_none());
    }

    #[test]
    fn options_preserve_original_percentage_limits() {
        let options = MenuOptions::from_args(&json!({
            "labels": { "openBag": "Backpack" },
            "petDockVisible": false,
            "petScale": 51,
            "windowOpacity": 0,
            "windowPassthrough": true
        }))
        .unwrap();
        assert_eq!(options.labels.open_bag, "Backpack");
        assert_eq!(options.labels.open_atlas, "图鉴");
        assert!(!options.pet_dock_visible);
        assert_eq!(options.pet_scale, 51);
        assert_eq!(options.window_opacity, 0);
        assert!(options.window_passthrough);
        assert!(MenuOptions::from_args(&json!({ "petScale": 49 })).is_err());
        assert!(MenuOptions::from_args(&json!({ "windowOpacity": 101 })).is_err());
    }
}
