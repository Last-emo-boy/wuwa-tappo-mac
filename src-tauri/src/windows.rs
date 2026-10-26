use crate::{
    geometry::{work_area_insets, HitRegion},
    session::SessionStore,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex, RwLock,
    },
    time::Duration,
};
use tauri::{
    AppHandle, Emitter, Listener, LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

pub const COMMANDS: &[&str] = &[
    "apply_main_window_position",
    "close_about_window",
    "close_login_window",
    "close_oss_notice_window",
    "close_panel_window",
    "close_update_window",
    "ensure_main_taskbar_icon",
    "exit_app",
    "finish_main_window_monitor_switch",
    "get_app_update_detail",
    "get_main_desktop_safe_area",
    "get_main_taskbar_insets",
    "get_maintenance_notice_payload",
    "has_maintenance_notice",
    "hide_main_after_maintenance_notice_ready",
    "is_force_update_locked",
    "open_about_window",
    "open_login_window",
    "open_maintenance_notice",
    "open_oss_notice_window",
    "open_panel_window",
    "open_update_window",
    "popup_main_dock_context_menu",
    "raise_panel_window_above_pets",
    "resize_login_window_to_content",
    "set_main_force_cursor_ignore",
    "set_main_hit_region",
    "set_main_swallow_mouse",
    "set_main_window_content_bounds",
    "set_main_window_fullscreen_shell",
    "set_main_window_monitor_bounds",
    "set_native_input_cursor",
    "set_overlay_cursor",
    "set_panel_window_collapsed",
    "show_toast_overlay",
    "sync_aux_windows_to_main_monitor",
    "sync_main_window_to_current_monitor",
    "sync_native_menu",
    "login_window_ready",
];

#[derive(Default)]
pub struct WindowState {
    hit: RwLock<HitState>,
    update: Mutex<Value>,
    maintenance: Mutex<Option<Value>>,
    panel_collapsed: Mutex<bool>,
    pending_login: Mutex<Option<Value>>,
    login_ready: AtomicBool,
    auxiliary: RwLock<BTreeMap<String, HitRegion>>,
    main_geometry: RwLock<MainGeometry>,
    stop: AtomicBool,
}

#[derive(Default)]
struct MainGeometry {
    left: f64,
    top: f64,
    scale: f64,
}

#[derive(Default)]
struct HitState {
    regions: Vec<HitRegion>,
    input_regions: Vec<HitRegion>,
    window_passthrough: bool,
    force_ignore: bool,
    swallow: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HitUpdate {
    regions: Vec<HitRegion>,
    #[serde(default)]
    input_regions: Vec<HitRegion>,
    #[serde(default)]
    update_native_input: bool,
    #[serde(default)]
    window_passthrough: bool,
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

fn main_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    app.get_webview_window("main")
        .ok_or_else(|| "Main window is unavailable".into())
}

fn initialize(app: &AppHandle, label: &str) -> Result<String, String> {
    let script = app.state::<SessionStore>().initialization_script()?;
    let mut initialization = format!(
        "{script}\n{}\n{}",
        include_str!("../../scripts/mac-websocket.js"),
        include_str!("../../scripts/mac-platform.js")
    );
    if label == "main" && cfg!(debug_assertions) && std::env::args().any(|arg| arg == "--self-test")
    {
        initialization.push_str(include_str!("../../scripts/runtime-smoke.js"));
    }
    Ok(initialization)
}

fn refresh_geometry(app: &AppHandle, label: &str) -> Result<(), String> {
    let window = app
        .get_webview_window(label)
        .ok_or("Window geometry unavailable")?;
    let scale = window.scale_factor().map_err(err)?;
    let pos = window.inner_position().map_err(err)?;
    let state = app.state::<WindowState>();
    if label == "main" {
        *state.main_geometry.write().map_err(err)? = MainGeometry {
            left: pos.x as f64 / scale,
            top: pos.y as f64 / scale,
            scale,
        };
    } else if label != "toast" {
        let pos = window.outer_position().map_err(err)?;
        let size = window.outer_size().map_err(err)?;
        state.auxiliary.write().map_err(err)?.insert(
            label.to_string(),
            HitRegion {
                left: pos.x as f64 / scale,
                top: pos.y as f64 / scale,
                width: size.width as f64 / scale,
                height: size.height as f64 / scale,
                member_id: None,
            },
        );
    }
    Ok(())
}

fn build_window(
    app: &AppHandle,
    label: &str,
    route: &str,
    size: (f64, f64),
    focus: bool,
) -> Result<WebviewWindow, String> {
    let window = WebviewWindowBuilder::new(
        app,
        label,
        WebviewUrl::App(format!("index.html#{route}").into()),
    )
    .title(if label == "main" {
        "Wuwa Tappo CN Mac"
    } else {
        "Wuwa Tappo"
    })
    .initialization_script(initialize(app, label)?)
    .on_page_load(|window, payload| {
        if matches!(payload.event(), tauri::webview::PageLoadEvent::Started) {
            crate::socket::close_window(window.app_handle(), window.label());
        }
    })
    .inner_size(size.0, size.1)
    .transparent(true)
    .decorations(false)
    .shadow(false)
    .resizable(label == "panel")
    .maximizable(false)
    .visible(false)
    .focused(focus)
    .focusable(focus)
    .always_on_top(true)
    .disable_drag_drop_handler()
    .build()
    .map_err(err)?;
    window.set_visible_on_all_workspaces(true).map_err(err)?;
    if label == "panel" {
        window
            .set_min_size(Some(LogicalSize::new(1100., 760.)))
            .map_err(err)?;
    }
    window.on_window_event({
        let app = app.clone();
        let label = label.to_string();
        move |event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                crate::socket::close_window(&app, &label);
            }
            if matches!(
                event,
                tauri::WindowEvent::Moved(_)
                    | tauri::WindowEvent::Resized(_)
                    | tauri::WindowEvent::ScaleFactorChanged { .. }
            ) {
                let tracked = label == "main"
                    || app
                        .state::<WindowState>()
                        .auxiliary
                        .read()
                        .is_ok_and(|windows| windows.contains_key(&label));
                if tracked {
                    if let Err(error) = refresh_geometry(&app, &label) {
                        eprintln!("Could not refresh {label} geometry: {error}");
                    }
                }
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                if let Ok(mut windows) = app.state::<WindowState>().auxiliary.write() {
                    windows.remove(&label);
                }
                if let Some(w) = app.get_webview_window(&label) {
                    if let Err(error) = w.hide() {
                        eprintln!("Could not hide {label}: {error}");
                    }
                }
                if label == "panel" {
                    if let Err(error) = app.emit("cat-panel-window-closed", ()) {
                        eprintln!("Panel close event failed: {error}");
                    }
                }
                if label == "login" {
                    if let Err(error) = app.emit("cat-login-overlay", json!({"open":false})) {
                        eprintln!("Login close event failed: {error}");
                    }
                }
            }
        }
    });
    Ok(window)
}

fn show_aux(
    app: &AppHandle,
    label: &str,
    route: &str,
    size: (f64, f64),
) -> Result<(WebviewWindow, bool), String> {
    let existing = app.get_webview_window(label);
    let existed = existing.is_some();
    let window = match existing {
        Some(w) => w,
        None => build_window(app, label, route, size, true)?,
    };
    center_on_main(app, &window)?;
    window.show().map_err(err)?;
    window.set_focus().map_err(err)?;
    refresh_geometry(app, label)?;
    Ok((window, existed))
}

fn center_on_main(app: &AppHandle, window: &WebviewWindow) -> Result<(), String> {
    let main = main_window(app)?;
    let monitor = main
        .current_monitor()
        .map_err(err)?
        .or(main.primary_monitor().map_err(err)?)
        .ok_or("No display is available")?;
    let size = window
        .outer_size()
        .map_err(err)?
        .to_logical::<f64>(window.scale_factor().map_err(err)?);
    let work = monitor.work_area();
    let scale = monitor.scale_factor();
    window
        .set_position(LogicalPosition::new(
            work.position.x as f64 / scale + (work.size.width as f64 / scale - size.width) / 2.,
            work.position.y as f64 / scale + (work.size.height as f64 / scale - size.height) / 2.,
        ))
        .map_err(err)
}

fn fullscreen_shell(app: &AppHandle) -> Result<(), String> {
    let w = main_window(app)?;
    let monitor = w
        .current_monitor()
        .map_err(err)?
        .or(w.primary_monitor().map_err(err)?)
        .ok_or("No display is available")?;
    w.set_position(*monitor.position()).map_err(err)?;
    w.set_size(*monitor.size()).map_err(err)?;
    Ok(())
}

fn safe_area(app: &AppHandle) -> Result<Value, String> {
    let w = main_window(app)?;
    let m = w
        .current_monitor()
        .map_err(err)?
        .ok_or("No current display")?;
    let p = m.position();
    let s = m.size();
    let a = m.work_area();
    let insets = work_area_insets(
        (p.x as f64, p.y as f64, s.width as f64, s.height as f64),
        (
            a.position.x as f64,
            a.position.y as f64,
            a.size.width as f64,
            a.size.height as f64,
        ),
        m.scale_factor(),
    );
    Ok(
        json!({"insets": insets, "autoHideEdge": null, "foregroundFullscreen": foreground_fullscreen(app)?}),
    )
}

// Other applications' window content is never inspected. macOS supplies the
// current Space's fullscreen presentation state through the application's menu.
fn foreground_fullscreen(_app: &AppHandle) -> Result<bool, String> {
    use objc2_app_kit::{NSApplication, NSApplicationPresentationOptions};
    let mtm =
        objc2::MainThreadMarker::new().ok_or("Screen state must be read on the main thread")?;
    Ok(NSApplication::sharedApplication(mtm)
        .currentSystemPresentationOptions()
        .contains(NSApplicationPresentationOptions::FullScreen))
}

fn payload(args: &Value) -> &Value {
    args.get("payload").unwrap_or(args)
}
fn number(args: &Value, name: &str) -> Result<f64, String> {
    args.get(name)
        .and_then(Value::as_f64)
        .filter(|v| v.is_finite())
        .ok_or_else(|| format!("Invalid {name}"))
}

fn close(app: &AppHandle, label: &str) -> Result<Value, String> {
    app.state::<WindowState>()
        .auxiliary
        .write()
        .map_err(err)?
        .remove(label);
    if let Some(w) = app.get_webview_window(label) {
        w.hide().map_err(err)?;
    }
    if label == "panel" {
        app.emit("cat-panel-window-closed", ()).map_err(err)?;
    }
    if label == "login" {
        app.emit("cat-login-overlay", json!({"open": false}))
            .map_err(err)?;
    }
    Ok(Value::Null)
}

pub fn dispatch(
    app: &AppHandle,
    label: &str,
    command: &str,
    args: &Value,
) -> Result<Value, String> {
    let state = app.state::<WindowState>();
    match command {
        "open_about_window" => {
            let (w, existed) = show_aux(app, "about", "/about", (680., 700.))?;
            if existed {
                w.emit("about-open", ()).map_err(err)?;
            }
        }
        "open_oss_notice_window" => {
            let (w, existed) = show_aux(app, "oss-notice", "/oss-notice", (780., 680.))?;
            if existed {
                w.emit("oss-notice-open", ()).map_err(err)?;
            }
        }
        "open_login_window" => {
            let intent = args
                .get("intent")
                .and_then(Value::as_str)
                .unwrap_or("login");
            if !["login", "show"].contains(&intent) {
                return Err("Unknown login intent".into());
            }
            *state.pending_login.lock().map_err(err)? =
                Some(json!({"intent":intent,"compact":args.get("compact")}));
            let (w, _) = show_aux(app, "login", "/login", (600., 660.))?;
            app.emit("cat-login-overlay", json!({"open": true}))
                .map_err(err)?;
            if state.login_ready.load(Ordering::Acquire) {
                if let Some(pending) = state.pending_login.lock().map_err(err)?.take() {
                    w.emit("login-modal-open", pending).map_err(err)?;
                }
            }
        }
        "login_window_ready" => {
            if label != "login" {
                return Err("Login readiness requires the login window".into());
            }
            state.login_ready.store(true, Ordering::Release);
            if let Some(pending) = state.pending_login.lock().map_err(err)?.take() {
                app.get_webview_window("login")
                    .ok_or("Login window is unavailable")?
                    .emit("login-modal-open", pending)
                    .map_err(err)?;
            }
        }
        "open_panel_window" => {
            let tab = payload(args)
                .get("tab")
                .and_then(Value::as_str)
                .unwrap_or("bag");
            if !["bag", "atlas", "exchange", "room", "setting"].contains(&tab) {
                return Err("Unknown panel tab".into());
            }
            let (w, existed) = show_aux(app, "panel", &format!("/panel?tab={tab}"), (1100., 760.))?;
            if existed {
                w.emit("panel-open-tab", tab).map_err(err)?;
            }
        }
        "open_update_window" => {
            *state.update.lock().map_err(err)? = args.get("detail").cloned().unwrap_or(Value::Null);
            let (w, _) = show_aux(app, "update", "/update", (600., 500.))?;
            w.emit("update-modal-open", ()).map_err(err)?;
            w.emit(
                "cat-app-update-available",
                args.get("detail").cloned().unwrap_or(Value::Null),
            )
            .map_err(err)?;
        }
        "open_maintenance_notice" => {
            let notice = args.get("payload").cloned().filter(|v| !v.is_null());
            *state.maintenance.lock().map_err(err)? = Some(notice.clone().unwrap_or(Value::Null));
            let (w, _) = show_aux(app, "update", "/update", (600., 500.))?;
            w.emit("maintenance-notice-open", notice).map_err(err)?;
        }
        "close_about_window" => return close(app, "about"),
        "close_oss_notice_window" => return close(app, "oss-notice"),
        "close_login_window" => return close(app, "login"),
        "close_panel_window" => return close(app, "panel"),
        "close_update_window" => return close(app, "update"),
        "get_app_update_detail" => return Ok(state.update.lock().map_err(err)?.clone()),
        "get_maintenance_notice_payload" => {
            return Ok(state
                .maintenance
                .lock()
                .map_err(err)?
                .clone()
                .unwrap_or(Value::Null))
        }
        "has_maintenance_notice" => {
            return Ok(json!(state.maintenance.lock().map_err(err)?.is_some()))
        }
        "is_force_update_locked" => {
            let detail = state.update.lock().map_err(err)?;
            return Ok(json!(detail
                .get("forceUpdate")
                .or_else(|| detail.get("forced"))
                .and_then(Value::as_bool)
                .unwrap_or(false)));
        }
        "hide_main_after_maintenance_notice_ready" => main_window(app)?.hide().map_err(err)?,
        "resize_login_window_to_content" => {
            let p = payload(args);
            let width = number(p, "width")?;
            let height = number(p, "height")?;
            if width <= 0. || height <= 0. {
                return Err("Login dimensions must be positive".into());
            }
            let w = app
                .get_webview_window("login")
                .ok_or("Login window is unavailable")?;
            w.set_size(LogicalSize::new(width, height)).map_err(err)?;
            center_on_main(app, &w)?;
        }
        "raise_panel_window_above_pets" => {
            let w = app
                .get_webview_window("panel")
                .ok_or("Panel window is unavailable")?;
            w.set_always_on_top(true).map_err(err)?;
            w.set_focus().map_err(err)?;
        }
        "set_panel_window_collapsed" => {
            let w = app
                .get_webview_window("panel")
                .ok_or("Panel window is unavailable")?;
            let collapsed = payload(args)
                .get("collapsed")
                .and_then(Value::as_bool)
                .ok_or("Missing collapsed state")?;
            let mut previous = state.panel_collapsed.lock().map_err(err)?;
            if *previous != collapsed {
                let size = w
                    .inner_size()
                    .map_err(err)?
                    .to_logical::<f64>(w.scale_factor().map_err(err)?);
                let min_width = if collapsed { 958. } else { 1100. };
                w.set_min_size(Some(LogicalSize::new(min_width, 760.)))
                    .map_err(err)?;
                let width = (size.width + if collapsed { -142. } else { 142. }).max(min_width);
                w.set_size(LogicalSize::new(width, size.height.max(760.)))
                    .map_err(err)?;
                *previous = collapsed;
            }
        }
        "set_main_hit_region" => {
            let update: HitUpdate = serde_json::from_value(payload(args).clone()).map_err(err)?;
            if update
                .regions
                .iter()
                .chain(update.input_regions.iter())
                .any(|r| !r.is_valid())
            {
                return Err("Invalid hit region geometry".into());
            }
            let mut hit = state.hit.write().map_err(err)?;
            hit.regions = update.regions;
            if update.update_native_input {
                hit.input_regions = update.input_regions;
            }
            hit.window_passthrough = update.window_passthrough;
            hit.force_ignore = false;
        }
        "set_main_force_cursor_ignore" => {
            state.hit.write().map_err(err)?.force_ignore = args
                .get("enabled")
                .and_then(Value::as_bool)
                .ok_or("Missing enabled state")?;
            main_window(app)?
                .set_ignore_cursor_events(true)
                .map_err(err)?;
        }
        "set_main_swallow_mouse" => {
            let enabled = args
                .get("enabled")
                .and_then(Value::as_bool)
                .ok_or("Missing enabled state")?;
            state.hit.write().map_err(err)?.swallow = enabled;
            if enabled {
                main_window(app)?
                    .set_ignore_cursor_events(false)
                    .map_err(err)?;
            }
        }
        "set_main_window_fullscreen_shell" => fullscreen_shell(app)?,
        "set_main_window_monitor_bounds" => {
            let p = payload(args);
            let x = number(p, "x")?;
            let y = number(p, "y")?;
            let width = number(p, "width")?;
            let height = number(p, "height")?;
            if width <= 0. || height <= 0. {
                return Err("Monitor dimensions must be positive".into());
            }
            let w = main_window(app)?;
            state.hit.write().map_err(err)?.force_ignore = true;
            w.set_ignore_cursor_events(true).map_err(err)?;
            let target = w
                .available_monitors()
                .map_err(err)?
                .into_iter()
                .find(|m| {
                    m.position().x == x as i32
                        && m.position().y == y as i32
                        && m.size().width == width as u32
                        && m.size().height == height as u32
                })
                .ok_or("Selected display is no longer available")?;
            let scale = target.scale_factor();
            w.set_position(LogicalPosition::new(x / scale, y / scale))
                .map_err(err)?;
            w.set_size(LogicalSize::new(width / scale, height / scale))
                .map_err(err)?;
        }
        "finish_main_window_monitor_switch" => {
            state.hit.write().map_err(err)?.force_ignore = false;
        }
        "set_main_window_content_bounds" => {
            let p = payload(args);
            let width = number(p, "width")?;
            let height = number(p, "height")?;
            if width <= 0. || height <= 0. {
                return Err("Window dimensions must be positive".into());
            }
            let w = main_window(app)?;
            if p.get("x").is_some() || p.get("y").is_some() {
                w.set_position(LogicalPosition::new(number(p, "x")?, number(p, "y")?))
                    .map_err(err)?;
            }
            w.set_size(LogicalSize::new(width, height)).map_err(err)?;
        }
        "apply_main_window_position" => {
            let top = payload(args)
                .get("alwaysOnTop")
                .and_then(Value::as_bool)
                .unwrap_or(true);
            main_window(app)?.set_always_on_top(top).map_err(err)?;
            // In the original fullscreen shell the Vue dock, not the OS window,
            // applies the selected corner; moving this window would move it twice.
            fullscreen_shell(app)?;
        }
        "sync_main_window_to_current_monitor" => {
            let w = main_window(app)?;
            w.set_visible_on_all_workspaces(true).map_err(err)?;
        }
        "sync_aux_windows_to_main_monitor" => {
            for (name, w) in app.webview_windows() {
                if name != "main" && name != "toast" {
                    center_on_main(app, &w)?;
                }
            }
        }
        "get_main_desktop_safe_area" => return safe_area(app),
        "get_main_taskbar_insets" => return Ok(safe_area(app)?["insets"].clone()),
        "set_overlay_cursor" | "set_native_input_cursor" => {
            let kind = args
                .get("kind")
                .and_then(Value::as_str)
                .unwrap_or("default");
            let cursor = match kind {
                "pointer" => tauri::CursorIcon::Hand,
                "grab" => tauri::CursorIcon::Grab,
                "grabbing" => tauri::CursorIcon::Grabbing,
                "default" => tauri::CursorIcon::Default,
                _ => return Err("Unsupported cursor".into()),
            };
            main_window(app)?.set_cursor_icon(cursor).map_err(err)?;
        }
        "ensure_main_taskbar_icon" => {
            app.set_dock_visibility(true).map_err(err)?;
            main_window(app)?.set_skip_taskbar(false).map_err(err)?;
        }
        "show_toast_overlay" => {
            let w = if let Some(w) = app.get_webview_window("toast") {
                w
            } else {
                build_window(app, "toast", "/toast", (620., 160.), false)?
            };
            center_on_main(app, &w)?;
            w.set_ignore_cursor_events(true).map_err(err)?;
            w.show().map_err(err)?;
        }
        "sync_native_menu" => return crate::menu::sync(app, args),
        "popup_main_dock_context_menu" => {
            return crate::menu::popup(
                app,
                &main_window(app)?,
                number(args, "x")?,
                number(args, "y")?,
            )
        }
        "exit_app" => {
            state.stop.store(true, Ordering::Release);
            app.exit(0);
        }
        _ => return Err(format!("Unsupported native command {command} from {label}")),
    }
    Ok(Value::Null)
}

pub fn setup(app: &AppHandle) -> Result<(), String> {
    let w = build_window(app, "main", "/", (900., 650.), false)?;
    fullscreen_shell(app)?;
    refresh_geometry(app, "main")?;
    w.set_ignore_cursor_events(true).map_err(err)?;
    w.show().map_err(err)?;
    if cfg!(debug_assertions) && std::env::args().any(|arg| arg == "--inspect") {
        w.open_devtools();
    }
    let app_for_input = app.clone();
    app.state::<crate::input::InputMonitor>()
        .set_member_resolver(move |x, y| {
            let state = app_for_input.state::<WindowState>();
            let geometry = state.main_geometry.read().ok()?;
            let (x, y) = (
                x / geometry.scale - geometry.left,
                y / geometry.scale - geometry.top,
            );
            let hit = state.hit.read().ok()?;
            hit.input_regions
                .iter()
                .chain(hit.regions.iter())
                .rev()
                .find(|r| r.contains(x, y))
                .and_then(|r| r.member_id)
        })?;
    let app_for_auxiliary = app.clone();
    app.state::<crate::input::InputMonitor>()
        .set_auxiliary_hit_test(move |x, y| {
            let state = app_for_auxiliary.state::<WindowState>();
            let Ok(geometry) = state.main_geometry.read() else {
                return false;
            };
            let (x, y) = (x / geometry.scale, y / geometry.scale);
            state
                .auxiliary
                .read()
                .is_ok_and(|regions| regions.values().any(|region| region.contains(x, y)))
        })?;
    let app_for_permission = app.clone();
    app.listen("mac-request-input-access", move |_| {
        let app = app_for_permission.clone();
        let handle = app.clone();
        if let Err(error) = app.run_on_main_thread(move || {
            if let Err(error) = crate::input::request_input_access(handle) {
                eprintln!("Input access request failed: {error}");
            }
        }) {
            eprintln!("Could not schedule input access request: {error}");
        }
    });
    std::thread::spawn({
        let app = app.clone();
        move || {
            let mut previous = None;
            loop {
                if app.state::<WindowState>().stop.load(Ordering::Acquire) {
                    break;
                }
                if let Some(w) = app.get_webview_window("main") {
                    let result = (|| -> Result<(), String> {
                        let scale = w.scale_factor().map_err(err)?;
                        let origin = w.inner_position().map_err(err)?;
                        let cursor = w.cursor_position().map_err(err)?;
                        let primary_scale = w
                            .primary_monitor()
                            .map_err(err)?
                            .ok_or("No primary display")?
                            .scale_factor();
                        let x = cursor.x / primary_scale - origin.x as f64 / scale;
                        let y = cursor.y / primary_scale - origin.y as f64 / scale;
                        let state = app.state::<WindowState>();
                        let h = state.hit.read().map_err(err)?;
                        let ignored = if h.swallow {
                            false
                        } else if h.force_ignore {
                            true
                        } else {
                            let regions = if h.window_passthrough {
                                &h.input_regions
                            } else {
                                &h.regions
                            };
                            !regions.iter().any(|r| r.contains(x, y))
                        };
                        drop(h);
                        if previous != Some(ignored) {
                            w.set_ignore_cursor_events(ignored).map_err(err)?;
                            previous = Some(ignored);
                        }
                        Ok(())
                    })();
                    if let Err(error) = result {
                        eprintln!("Hit region update stopped: {error}");
                        break;
                    }
                } else {
                    break;
                }
                std::thread::sleep(Duration::from_millis(16));
            }
        }
    });
    Ok(())
}
