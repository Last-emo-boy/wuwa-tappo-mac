mod geometry;
mod input;
mod menu;
mod session;
mod socket;
mod startup;
mod storage;
mod system;
mod windows;

use serde_json::Value;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use tauri::{
    ipc::{Invoke, InvokeBody},
    Emitter, Listener, Manager,
};

#[derive(Default)]
struct StartupState {
    loading: AtomicBool,
    error: Mutex<Option<String>>,
    mode: Mutex<Option<startup::SessionMode>>,
}

fn startup_status(app: &tauri::AppHandle) -> Value {
    let state = app.state::<StartupState>();
    let error = state
        .error
        .lock()
        .map(|error| error.clone())
        .unwrap_or_else(|_| Some("Startup status is unavailable".into()));
    let loading = state.loading.load(Ordering::Acquire);
    let mode = *state
        .mode
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let message=error.unwrap_or_else(||match (loading,mode) {
        (true,Some(startup::SessionMode::Keychain))=>"正在读取登录信息…\n请在 macOS 的钥匙串提示中自行处理授权。".into(),
        (true,_)=>"正在启动，仅本次会话保存登录信息…".into(),
        _=>"仅本次会话：登录信息只保存在内存，退出后清除。\n记住登录：使用 macOS 钥匙串，需要系统授权。".into(),
    });
    serde_json::json!({"loading":loading,"message":message,"mode":mode})
}

fn begin_session(
    app: tauri::AppHandle,
    mode: startup::SessionMode,
    remember_choice: bool,
) -> Result<(), String> {
    if app.try_state::<session::SessionStore>().is_some() {
        return Err("已有登录会话。请先退出应用，再重新启动并选择登录信息保存方式。".into());
    }
    if app
        .state::<StartupState>()
        .loading
        .swap(true, Ordering::AcqRel)
    {
        return Err("Sign-in information is already loading".into());
    }
    if remember_choice {
        let saved = app
            .path()
            .app_config_dir()
            .map_err(|error| error.to_string())
            .and_then(|dir| startup::save_mode(&dir.join("session-mode.json"), mode));
        if let Err(error) = saved {
            app.state::<StartupState>()
                .loading
                .store(false, Ordering::Release);
            return Err(error);
        }
    }
    *app.state::<StartupState>()
        .mode
        .lock()
        .map_err(|_| "Startup state lock failed")? = Some(mode);
    *app.state::<StartupState>()
        .error
        .lock()
        .map_err(|_| "Startup state lock failed")? = None;
    if let Some(window) = app.get_webview_window("bootstrap") {
        window
            .emit("mac-startup-status", startup_status(&app))
            .map_err(|error| error.to_string())?;
    }
    let identifier = app.config().identifier.clone();
    tauri::async_runtime::spawn(async move {
        let session = if mode == startup::SessionMode::Memory {
            Ok(session::SessionStore::ephemeral())
        } else {
            tauri::async_runtime::spawn_blocking(move || session::SessionStore::open(identifier))
                .await
                .map_err(|error| error.to_string())
                .and_then(|session| session)
        };
        let handle = app.clone();
        let scheduling = app.run_on_main_thread(move || {
            let result = (|| -> Result<(), String> {
                if !handle.manage(session?) {
                    return Err("已有登录会话，无法更换保存方式。请退出应用后重试。".into());
                }
                windows::setup(&handle)?;
                if let Err(error) = input::start(handle.clone()) {
                    eprintln!("Global input unavailable: {error}");
                }
                if let Some(bootstrap) = handle.get_webview_window("bootstrap") {
                    bootstrap.close().map_err(|error| error.to_string())?;
                }
                Ok(())
            })();
            let state = handle.state::<StartupState>();
            state.loading.store(false, Ordering::Release);
            if let Err(error) = result {
                eprintln!("App startup failed: {error}");
                let message = format!("无法读取登录信息或启动应用。\n{error}");
                if let Ok(mut failure) = state.error.lock() {
                    *failure = Some(message.clone());
                }
                if let Some(bootstrap) = handle.get_webview_window("bootstrap") {
                    if let Err(error) =
                        bootstrap.emit("mac-startup-status", startup_status(&handle))
                    {
                        eprintln!("Could not show startup error: {error}");
                    }
                }
            }
        });
        if let Err(error) = scheduling {
            eprintln!("Could not complete app startup: {error}");
        }
    });
    Ok(())
}

const SYSTEM_COMMANDS: &[&str] = &[
    "write_app_log",
    "get_track_os_info",
    "get_boot_diagnostics",
    "check_app_update",
    "is_devtools_hotkeys_build",
    "is_internal_testing_build",
    "is_elevated_autostart_enabled",
    "set_elevated_autostart",
];

fn handle(invoke: Invoke) -> bool {
    let command = invoke.message.command().to_string();
    if command == "start_session" || command == "get_startup_status" {
        let app = invoke.message.webview().app_handle().clone();
        if invoke.message.webview().label() != "bootstrap" {
            invoke
                .resolver
                .reject("Startup actions require the startup window");
            return true;
        }
        if command == "get_startup_status" {
            invoke.resolver.resolve(startup_status(&app));
            return true;
        }
        let mode = match invoke.message.payload() {
            InvokeBody::Json(value) => value
                .get("mode")
                .cloned()
                .ok_or_else(|| "Choose a session mode".to_string())
                .and_then(|value| {
                    serde_json::from_value(value)
                        .map_err(|error| format!("Invalid session mode: {error}"))
                }),
            _ => Err("Session mode requires JSON arguments".to_string()),
        };
        let result = mode.and_then(|mode| begin_session(app, mode, true));
        invoke
            .resolver
            .respond(result.map_err(tauri::ipc::InvokeError::from));
        return true;
    }
    if windows::COMMANDS.contains(&command.as_str()) || SYSTEM_COMMANDS.contains(&command.as_str())
    {
        let args = match invoke.message.payload() {
            InvokeBody::Json(value) => value.clone(),
            InvokeBody::Raw(_) => {
                invoke
                    .resolver
                    .reject("Native commands require JSON arguments");
                return true;
            }
        };
        let app = invoke.message.webview().app_handle().clone();
        let label = invoke.message.webview().label().to_string();
        #[cfg(debug_assertions)]
        eprintln!("[native] begin {label}:{command}");
        if SYSTEM_COMMANDS.contains(&command.as_str()) {
            invoke.resolver.respond_async(async move {
                tauri::async_runtime::spawn_blocking(move || {
                    system::dispatch(&app, &command, &args)
                        .unwrap_or_else(|| Err(format!("Unhandled system command {command}")))
                })
                .await
                .map_err(|error| tauri::ipc::InvokeError::from(error.to_string()))?
                .map_err(tauri::ipc::InvokeError::from)
            });
        } else {
            let handle = app.clone();
            let resolver = invoke.resolver;
            let fallback = resolver.clone();
            if let Err(error) = app.run_on_main_thread(move || {
                let result = windows::dispatch(&handle, &label, &command, &args);
                #[cfg(debug_assertions)]
                eprintln!(
                    "[native] end {label}:{command}: {}",
                    if result.is_ok() { "ok" } else { "error" }
                );
                resolver.respond(result.map_err(tauri::ipc::InvokeError::from));
            }) {
                fallback.reject(error.to_string());
            }
        }
        return true;
    }
    let handler: fn(Invoke) -> bool = tauri::generate_handler![
        storage::load_key_press_count,
        storage::save_key_press_count,
        storage::load_cumulative_click_count,
        storage::save_cumulative_click_count,
        input::get_input_status,
        input::request_input_access,
        input::resume_input_monitor,
        session::session_snapshot,
        session::session_apply,
        socket::native_ws_connect,
        socket::native_ws_send,
        socket::native_ws_close,
    ];
    handler(invoke)
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .macos_launcher(tauri_plugin_autostart::MacosLauncher::LaunchAgent)
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .manage(windows::WindowState::default())
        .manage(StartupState::default())
        .manage(input::InputMonitor::new())
        .manage(socket::SocketState::default())
        .invoke_handler(handle)
        .setup(|app| {
            let handle = app.handle().clone();
            app.manage(storage::CounterStore::new(
                app.path().app_data_dir()?.join("counters.json"),
            ));
            menu::setup(&handle)?;
            app.manage(system::start_network_monitor(handle.clone())?);
            tauri::WebviewWindowBuilder::new(
                app,
                "bootstrap",
                tauri::WebviewUrl::App("bootstrap.html".into()),
            )
            .title("Wuwa Tappo CN Mac")
            .inner_size(520., 260.)
            .resizable(false)
            .center()
            .build()?;
            let about = handle.clone();
            app.listen("mac-open-about", move |_| {
                let app = about.clone();
                let h = app.clone();
                if let Err(error) = app.run_on_main_thread(move || {
                    if let Err(error) =
                        windows::dispatch(&h, "main", "open_about_window", &Value::Null)
                    {
                        eprintln!("About window failed: {error}");
                    }
                }) {
                    eprintln!("Could not schedule About window: {error}");
                }
            });
            let explicit_memory = std::env::args().any(|arg| arg == "--session-only");
            let choose = std::env::args().any(|arg| arg == "--choose-session");
            if explicit_memory {
                begin_session(handle, startup::SessionMode::Memory, true)?;
            } else if !choose {
                match startup::load_mode(&app.path().app_config_dir()?.join("session-mode.json")) {
                    Ok(Some(mode)) => begin_session(handle, mode, false)?,
                    Ok(None) => {}
                    Err(error) => {
                        *app.state::<StartupState>()
                            .error
                            .lock()
                            .map_err(|_| "Startup state lock failed")? = Some(error)
                    }
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!());
    let app = match app {
        Ok(app) => app,
        Err(error) => {
            eprintln!("Could not start Wuwa Tappo Mac: {error}");
            if let Some(mtm) = objc2::MainThreadMarker::new() {
                let alert = objc2_app_kit::NSAlert::new(mtm);
                alert.setMessageText(&objc2_foundation::NSString::from_str(
                    "Wuwa Tappo Mac 无法启动",
                ));
                alert.setInformativeText(&objc2_foundation::NSString::from_str(&error.to_string()));
                alert.runModal();
            }
            return;
        }
    };
    app.run(|app, event| {
        if let tauri::RunEvent::Exit = event {
            socket::shutdown(app);
            if let Some(monitor) = app.try_state::<system::SystemMonitor>() {
                if let Err(error) = monitor.stop() {
                    eprintln!("Network monitor shutdown failed: {error}");
                }
            }
            if let Err(error) = app.state::<input::InputMonitor>().stop() {
                eprintln!("Input shutdown failed: {error}");
            }
        }
    });
}
