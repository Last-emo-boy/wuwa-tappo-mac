use serde_json::{json, Value};
use std::{
    ffi::c_void,
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::Path,
    process::Command,
    ptr::NonNull,
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_opener::OpenerExt;

const MAX_LOG_BYTES: u64 = 2 * 1024 * 1024;
const MAX_MESSAGE_CHARS: usize = 32 * 1024;
const MAX_MANIFEST_BYTES: u64 = 2 * 1024 * 1024;
static LOG_WRITE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

// These describe the recovered global-prod frontend, not Rust's compilation profile.
const INTERNAL_TESTING_BUILD: bool = false;
const DEVTOOLS_HOTKEYS_BUILD: bool = false;

const REACHABLE: u32 = 1 << 1;
const CONNECTION_REQUIRED: u32 = 1 << 2;
const CONNECTION_ON_TRAFFIC: u32 = 1 << 3;
const INTERVENTION_REQUIRED: u32 = 1 << 4;
const CONNECTION_ON_DEMAND: u32 = 1 << 5;

fn route_available(flags: u32) -> bool {
    let reachable = flags & REACHABLE != 0;
    let connection_required = flags & CONNECTION_REQUIRED != 0;
    let automatic = flags & (CONNECTION_ON_TRAFFIC | CONNECTION_ON_DEMAND) != 0;
    let intervention_required = flags & INTERVENTION_REQUIRED != 0;
    reachable && (!connection_required || (automatic && !intervention_required))
}

#[derive(Default)]
struct RouteState {
    families: [Option<bool>; 2],
    emitted: Option<bool>,
}

impl RouteState {
    fn observe(&mut self, family: usize, available: bool) -> Option<bool> {
        self.families[family] = Some(available);
        let [Some(ipv4), Some(ipv6)] = self.families else {
            return None;
        };
        let internet_access = ipv4 || ipv6;
        if self.emitted == Some(internet_access) {
            return None;
        }
        self.emitted = Some(internet_access);
        Some(internet_access)
    }
}

#[repr(C)]
struct ReachabilityContext {
    version: isize,
    info: *mut c_void,
    retain: Option<unsafe extern "C" fn(*const c_void) -> *const c_void>,
    release: Option<unsafe extern "C" fn(*const c_void)>,
    copy_description: Option<unsafe extern "C" fn(*const c_void) -> *const c_void>,
}

#[repr(C, align(4))]
struct RouteAddress {
    length: u8,
    family: u8,
    data: [u8; 26],
}

#[link(name = "SystemConfiguration", kind = "framework")]
extern "C" {
    fn SCNetworkReachabilityCreateWithAddress(
        allocator: *const c_void,
        address: *const RouteAddress,
    ) -> *const c_void;
    fn SCNetworkReachabilityGetFlags(target: *const c_void, flags: *mut u32) -> u8;
    fn SCNetworkReachabilitySetCallback(
        target: *const c_void,
        callback: Option<unsafe extern "C" fn(*const c_void, u32, *mut c_void)>,
        context: *mut ReachabilityContext,
    ) -> u8;
    fn SCNetworkReachabilityScheduleWithRunLoop(
        target: *const c_void,
        run_loop: *const c_void,
        mode: *const c_void,
    ) -> u8;
    fn SCNetworkReachabilityUnscheduleFromRunLoop(
        target: *const c_void,
        run_loop: *const c_void,
        mode: *const c_void,
    ) -> u8;
    fn SCError() -> i32;
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFRunLoopGetMain() -> *mut c_void;
    fn CFRunLoopGetCurrent() -> *mut c_void;
    fn CFRelease(value: *mut c_void);
    static kCFRunLoopCommonModes: *mut c_void;
}

struct RouteCallback {
    app: AppHandle,
    family: usize,
    state: Arc<Mutex<RouteState>>,
}

unsafe extern "C" fn retain_route_callback(info: *const c_void) -> *const c_void {
    Arc::<RouteCallback>::increment_strong_count(info.cast());
    info
}

unsafe extern "C" fn release_route_callback(info: *const c_void) {
    Arc::<RouteCallback>::decrement_strong_count(info.cast());
}

unsafe extern "C" fn route_changed(_target: *const c_void, flags: u32, info: *mut c_void) {
    // SystemConfiguration retains this Arc through the context retain/release callbacks.
    let callback = &*info.cast::<RouteCallback>();
    let transition = match callback.state.lock() {
        Ok(mut state) => state.observe(callback.family, route_available(flags)),
        Err(_) => {
            eprintln!("native network monitor state poisoned");
            return;
        }
    };
    if let Some(internet_access) = transition {
        if let Err(error) = callback.app.emit(
            "cat-native-network-status-changed",
            json!({ "internetAccess": internet_access }),
        ) {
            eprintln!("native network event failed: {error}");
        }
    }
}

struct ReachabilityTarget {
    target: NonNull<c_void>,
    scheduled: bool,
}

// SCNetworkReachability is a retained CoreFoundation object. The Mutex in SystemMonitor
// serializes ownership and teardown; callbacks run on the main CFRunLoop and own their Arc.
unsafe impl Send for ReachabilityTarget {}

impl ReachabilityTarget {
    fn unschedule(&mut self) -> Result<(), String> {
        if !self.scheduled {
            return Ok(());
        }
        let removed = unsafe {
            SCNetworkReachabilityUnscheduleFromRunLoop(
                self.target.as_ptr(),
                CFRunLoopGetMain(),
                kCFRunLoopCommonModes,
            )
        };
        if removed == 0 {
            return Err(format!(
                "native network monitor unschedule failed ({})",
                unsafe { SCError() }
            ));
        }
        self.scheduled = false;
        Ok(())
    }
}

impl Drop for ReachabilityTarget {
    fn drop(&mut self) {
        if let Err(error) = self.unschedule() {
            eprintln!("{error}");
        }
        unsafe {
            // Removing the callback releases its retained Arc before releasing the target.
            if SCNetworkReachabilitySetCallback(self.target.as_ptr(), None, std::ptr::null_mut())
                == 0
            {
                eprintln!("native network callback removal failed ({})", SCError());
            }
            CFRelease(self.target.as_ptr());
        }
    }
}

pub struct SystemMonitor {
    targets: Mutex<Vec<ReachabilityTarget>>,
}

impl SystemMonitor {
    pub fn stop(&self) -> Result<(), String> {
        let mut targets = {
            let mut targets = self
                .targets
                .lock()
                .map_err(|_| "network monitor lock poisoned")?;
            std::mem::take(&mut *targets)
        };
        let mut errors = Vec::new();
        for target in &mut targets {
            if let Err(error) = target.unschedule() {
                errors.push(error);
            }
        }
        drop(targets);
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("; "))
        }
    }
}

pub fn start_network_monitor(app: AppHandle) -> Result<SystemMonitor, String> {
    if unsafe { CFRunLoopGetCurrent() != CFRunLoopGetMain() } {
        return Err("native network monitor must be started on the main thread".into());
    }
    let state = Arc::new(Mutex::new(RouteState::default()));
    let mut targets = Vec::new();
    for (index, family, length) in [(0, 2, 16), (1, 30, 28)] {
        // Unspecified IPv4/IPv6 socket addresses observe the default routes without
        // DNS or HTTP requests. Browser health checks still determine service health.
        let address = RouteAddress {
            length,
            family,
            data: [0; 26],
        };
        let raw = unsafe { SCNetworkReachabilityCreateWithAddress(std::ptr::null(), &address) };
        let pointer =
            NonNull::new(raw.cast_mut()).ok_or("could not create native network monitor")?;
        let mut target = ReachabilityTarget {
            target: pointer,
            scheduled: false,
        };
        let callback = Arc::new(RouteCallback {
            app: app.clone(),
            family: index,
            state: state.clone(),
        });
        let mut context = ReachabilityContext {
            version: 0,
            info: Arc::as_ptr(&callback).cast_mut().cast(),
            retain: Some(retain_route_callback),
            release: Some(release_route_callback),
            copy_description: None,
        };
        if unsafe { SCNetworkReachabilitySetCallback(raw, Some(route_changed), &mut context) } == 0
        {
            return Err(format!(
                "could not register native network callback ({})",
                unsafe { SCError() }
            ));
        }
        let mut flags = 0;
        if unsafe { SCNetworkReachabilityGetFlags(raw, &mut flags) } == 0 {
            return Err(format!(
                "could not read native network route ({})",
                unsafe { SCError() }
            ));
        }
        if unsafe {
            SCNetworkReachabilityScheduleWithRunLoop(raw, CFRunLoopGetMain(), kCFRunLoopCommonModes)
        } == 0
        {
            return Err(format!(
                "could not schedule native network monitor ({})",
                unsafe { SCError() }
            ));
        }
        target.scheduled = true;
        let transition = state
            .lock()
            .map_err(|_| "network route state poisoned")?
            .observe(index, route_available(flags));
        targets.push(target);
        if let Some(internet_access) = transition {
            app.emit(
                "cat-native-network-status-changed",
                json!({ "internetAccess": internet_access }),
            )
            .map_err(|e| e.to_string())?;
        }
    }
    Ok(SystemMonitor {
        targets: Mutex::new(targets),
    })
}

fn output(program: &str, args: &[&str]) -> Result<String, String> {
    let result = Command::new(program)
        .args(args)
        .output()
        .map_err(|e| e.to_string())?;
    if !result.status.success() {
        return Err(format!("{program} exited with {}", result.status));
    }
    let text = String::from_utf8(result.stdout).map_err(|e| e.to_string())?;
    Ok(text.trim().to_owned())
}

fn sysctl(name: &str) -> Result<String, String> {
    output("/usr/sbin/sysctl", &["-n", name])
}

fn system_version() -> Result<String, String> {
    output("/usr/bin/sw_vers", &["-productVersion"])
}

fn optional_number(result: Result<String, String>) -> Value {
    match result.and_then(|v| v.parse::<u64>().map_err(|e| e.to_string())) {
        Ok(value) => json!(value),
        Err(_) => Value::Null,
    }
}

fn boot_diagnostics(app: &AppHandle) -> Value {
    let monitors = app.available_monitors();
    let display_names = match monitors {
        Ok(monitors) => Some(
            monitors
                .iter()
                .map(|monitor| json!({ "device_name": monitor.name(), "name": monitor.name() }))
                .collect::<Vec<_>>(),
        ),
        Err(_) => None,
    };
    json!({
        "system": {
            "os": "macOS",
            "os_version": system_version().ok(),
            "os_build": output("/usr/bin/sw_vers", &["-buildVersion"]).ok(),
            "architecture": std::env::consts::ARCH,
            "model": sysctl("hw.model").ok(),
        },
        "runtime": {
            "webview_engine": "WKWebView",
            "webview_version": null,
            "tauri": tauri::VERSION,
            "reconstructed_backend": true,
        },
        "cpu": {
            "name": sysctl("machdep.cpu.brand_string").ok(),
            "physical_cores": optional_number(sysctl("hw.physicalcpu")),
            "logical_cores": optional_number(sysctl("hw.logicalcpu")),
        },
        "memory": { "total_bytes": optional_number(sysctl("hw.memsize")) },
        "gpus": null,
        "display_names": display_names,
    })
}

fn is_secret_separator(byte: u8) -> bool {
    matches!(byte, b' ' | b'\t' | b'=' | b':' | b'"' | b'\'')
}

fn is_value_terminator(byte: u8) -> bool {
    byte.is_ascii_whitespace()
        || matches!(
            byte,
            b'"' | b'\'' | b'&' | b';' | b',' | b'}' | b'>' | b'\\'
        )
}

fn redact(message: &str) -> String {
    let lower = message.to_ascii_lowercase();
    let bytes = message.as_bytes();
    let mut ranges = Vec::new();

    for scheme in ["https://", "http://", "wuwa-buddy://"] {
        let mut from = 0;
        while let Some(offset) = lower[from..].find(scheme) {
            let start = from + offset;
            let end = bytes[start..]
                .iter()
                .position(|byte| is_value_terminator(*byte) && *byte != b'&')
                .map_or(bytes.len(), |offset| start + offset);
            if let Some(offset) = bytes[start..end]
                .iter()
                .position(|b| matches!(b, b'?' | b'#'))
            {
                ranges.push((start + offset, end));
            }
            from = end.max(start + scheme.len());
        }
    }
    for key in [
        "access_token",
        "refresh_token",
        "kuro_infotoken",
        "authorization",
        "password",
        "token",
    ] {
        let mut from = 0;
        while let Some(offset) = lower[from..].find(key) {
            let start = from + offset;
            let key_end = start + key.len();
            from = key_end;
            if start > 0 && (bytes[start - 1].is_ascii_alphanumeric() || bytes[start - 1] == b'_') {
                continue;
            }
            if key_end < bytes.len()
                && (bytes[key_end].is_ascii_alphanumeric() || bytes[key_end] == b'_')
            {
                continue;
            }
            let mut value_start = key_end;
            let mut separator_seen = false;
            while value_start < bytes.len() && is_secret_separator(bytes[value_start]) {
                separator_seen |= matches!(bytes[value_start], b'=' | b':');
                value_start += 1;
            }
            if !separator_seen {
                continue;
            }
            let value_end = bytes[value_start..]
                .iter()
                .position(|byte| is_value_terminator(*byte))
                .map_or(bytes.len(), |offset| value_start + offset);
            if value_end > value_start {
                ranges.push((value_start, value_end));
            }
        }
    }
    let mut from = 0;
    while let Some(offset) = lower[from..].find("bearer ") {
        let start = from + offset + "bearer ".len();
        let end = bytes[start..]
            .iter()
            .position(|byte| is_value_terminator(*byte))
            .map_or(bytes.len(), |offset| start + offset);
        if end > start {
            ranges.push((start, end));
        }
        from = end.max(start);
    }

    ranges.sort_unstable();
    let mut merged: Vec<(usize, usize)> = Vec::new();
    for (start, end) in ranges {
        if let Some(last) = merged.last_mut() {
            if start <= last.1 {
                last.1 = last.1.max(end);
                continue;
            }
        }
        merged.push((start, end));
    }
    let mut safe = String::with_capacity(message.len());
    let mut cursor = 0;
    for (start, end) in merged {
        safe.push_str(&message[cursor..start]);
        safe.push_str("[REDACTED]");
        cursor = end;
    }
    safe.push_str(&message[cursor..]);
    safe.replace('\r', "\\r").replace('\n', "\\n")
}

fn write_log_file(directory: &Path, level: &str, message: &str) -> Result<(), String> {
    if !matches!(level, "trace" | "debug" | "info" | "warn" | "error") {
        return Err("unsupported log level".into());
    }
    let safe = redact(message);
    let safe: String = safe.chars().take(MAX_MESSAGE_CHARS).collect();
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis();
    let line = format!("{timestamp} {level} {safe}\n");
    let _guard = LOG_WRITE_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "log lock poisoned")?;
    fs::create_dir_all(directory).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(directory, fs::Permissions::from_mode(0o700))
            .map_err(|e| e.to_string())?;
    }
    let path = directory.join("app.log");
    match fs::metadata(&path) {
        Ok(metadata) if metadata.len() + line.len() as u64 > MAX_LOG_BYTES => {
            fs::rename(&path, directory.join("app.log.1")).map_err(|e| e.to_string())?;
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.to_string()),
    }
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
        .open(path)
        .and_then(|mut file| file.write_all(line.as_bytes()))
        .map_err(|e| e.to_string())
}

pub fn write_message(app: &AppHandle, level: &str, message: &str) -> Result<(), String> {
    let directory = app.path().app_log_dir().map_err(|e| e.to_string())?;
    write_log_file(&directory, level, message)
}

pub fn open_log_dir(app: &AppHandle) -> Result<(), String> {
    let directory = app.path().app_log_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    app.opener()
        .open_path(directory.to_string_lossy().into_owned(), None::<&str>)
        .map_err(|e| e.to_string())
}

fn validate_manifest_endpoint(endpoint: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(endpoint).map_err(|_| "invalid update manifest URL")?;
    let host = url.host_str().ok_or("update manifest URL has no host")?;
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
        return Err("update manifest must use HTTPS without credentials".into());
    }
    if !(host.ends_with(".kurogames-global.com")
        || host.ends_with(".kurogames.com")
        || host.ends_with(".kurogame.com"))
    {
        return Err("update manifest is outside the official Kuro distribution hosts".into());
    }
    Ok(url)
}

fn mac_update_status(manifest: &Value, target: &str) -> Result<Value, String> {
    let platforms = manifest
        .get("platforms")
        .and_then(Value::as_object)
        .ok_or("更新清单缺少平台信息")?;
    let Some(platform) = platforms.get(target) else {
        return Err("官方更新清单没有适用于此 Mac 的版本；请手动更新 Mac 应用。".into());
    };
    let url = platform
        .get("url")
        .and_then(Value::as_str)
        .ok_or("macOS 更新清单缺少下载地址")?;
    let url = validate_manifest_endpoint(url)?;
    if url.path().to_ascii_lowercase().ends_with(".exe")
        || url.path().to_ascii_lowercase().ends_with(".msi")
    {
        return Err("更新清单中的 macOS 资源实际是 Windows 安装包，已拒绝安装。".into());
    }
    if platform
        .get("signature")
        .and_then(Value::as_str)
        .is_none_or(str::is_empty)
    {
        return Err("macOS 更新资源缺少签名，已拒绝安装。".into());
    }
    Err("检测到 macOS 更新，但此重建版尚未配置可信更新签名；请手动更新 Mac 应用。".into())
}

fn check_app_update(endpoint: &str) -> Result<Value, String> {
    let url = validate_manifest_endpoint(endpoint)?;
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())?;
    let response = client.get(url).send().map_err(|_| "读取官方更新清单失败")?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("读取官方更新清单失败（HTTP {}）", status.as_u16()));
    }
    if response
        .content_length()
        .is_some_and(|size| size > MAX_MANIFEST_BYTES)
    {
        return Err("官方更新清单超出大小限制".into());
    }
    let mut bytes = Vec::new();
    response
        .take(MAX_MANIFEST_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "读取官方更新清单失败")?;
    if bytes.len() as u64 > MAX_MANIFEST_BYTES {
        return Err("官方更新清单超出大小限制".into());
    }
    let manifest: Value = serde_json::from_slice(&bytes).map_err(|_| "官方更新清单格式无效")?;
    let target = match std::env::consts::ARCH {
        "aarch64" => "darwin-aarch64",
        "x86_64" => "darwin-x86_64",
        _ => return Err("此 Mac 架构没有更新通道".into()),
    };
    mac_update_status(&manifest, target)
}

pub fn dispatch(app: &AppHandle, command: &str, args: &Value) -> Option<Result<Value, String>> {
    let result = match command {
        "get_track_os_info" => {
            system_version().map(|version| json!({ "os": "macOS", "osVersion": version }))
        }
        "get_boot_diagnostics" => Ok(boot_diagnostics(app)),
        "write_app_log" => {
            let level = args.get("level").and_then(Value::as_str);
            let message = args.get("message").and_then(Value::as_str);
            match (level, message) {
                (Some(level), Some(message)) => {
                    write_message(app, level, message).map(|_| Value::Null)
                }
                _ => Err("write_app_log requires string level and message".into()),
            }
        }
        "check_app_update" => match args.get("endpoint").and_then(Value::as_str) {
            Some(endpoint) => check_app_update(endpoint),
            None => Err("check_app_update requires a manifest endpoint".into()),
        },
        "is_devtools_hotkeys_build" => Ok(json!(DEVTOOLS_HOTKEYS_BUILD)),
        "is_internal_testing_build" => Ok(json!(INTERNAL_TESTING_BUILD)),
        "is_elevated_autostart_enabled" => app
            .autolaunch()
            .is_enabled()
            .map(Value::from)
            .map_err(|e| e.to_string()),
        "set_elevated_autostart" => match args.get("enabled").and_then(Value::as_bool) {
            Some(true) => app
                .autolaunch()
                .enable()
                .map(|_| Value::Null)
                .map_err(|e| e.to_string()),
            Some(false) => app
                .autolaunch()
                .disable()
                .map(|_| Value::Null)
                .map_err(|e| e.to_string()),
            None => Err("set_elevated_autostart requires boolean enabled".into()),
        },
        "open_app_log_dir" => open_log_dir(app).map(|_| Value::Null),
        _ => return None,
    };
    Some(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn port_preserves_global_production_frontend_identity() {
        assert_eq!(INTERNAL_TESTING_BUILD, false);
        assert_eq!(DEVTOOLS_HOTKEYS_BUILD, false);
    }

    #[test]
    fn reachability_flags_require_a_route_and_no_manual_connection() {
        for (flags, available) in [
            (0, false),
            (REACHABLE, true),
            (CONNECTION_ON_DEMAND, false),
            (REACHABLE | CONNECTION_REQUIRED, false),
            (
                REACHABLE | CONNECTION_REQUIRED | CONNECTION_ON_TRAFFIC,
                true,
            ),
            (REACHABLE | CONNECTION_REQUIRED | CONNECTION_ON_DEMAND, true),
            (
                REACHABLE | CONNECTION_REQUIRED | CONNECTION_ON_DEMAND | INTERVENTION_REQUIRED,
                false,
            ),
            (REACHABLE | INTERVENTION_REQUIRED, true),
        ] {
            assert_eq!(route_available(flags), available, "flags={flags}");
        }
    }

    #[test]
    fn dual_stack_routes_emit_only_aggregate_state_changes() {
        let mut state = RouteState::default();
        assert_eq!(state.observe(0, false), None);
        assert_eq!(state.observe(1, false), Some(false));
        assert_eq!(state.observe(1, false), None);
        assert_eq!(state.observe(0, true), Some(true));
        assert_eq!(state.observe(0, true), None);
        assert_eq!(state.observe(1, true), None);
        assert_eq!(state.observe(0, false), None);
        assert_eq!(state.observe(1, false), Some(false));
        assert_eq!(state.observe(0, false), None);
        assert_eq!(state.observe(1, true), Some(true));
    }

    #[test]
    fn log_redaction_removes_login_material_without_losing_diagnostics() {
        let input = r#"[AUTH] url=wuwa-buddy://callback?state=secret&code=authorization-code token=abc123 Authorization: Bearer top-secret {"access_token":"json-secret"} code=401 中文"#;
        let safe = redact(input);
        for secret in [
            "secret",
            "authorization-code",
            "abc123",
            "top-secret",
            "json-secret",
        ] {
            assert!(!safe.contains(secret), "{safe}");
        }
        assert!(safe.contains("code=401"));
        assert!(safe.contains("中文"));
    }

    #[test]
    fn logs_cannot_inject_lines_and_are_bounded() {
        let directory = std::env::temp_dir().join(format!(
            "wuwatappo-logs-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&directory).unwrap();
        fs::write(
            directory.join("app.log"),
            vec![b'x'; MAX_LOG_BYTES as usize],
        )
        .unwrap();
        write_log_file(&directory, "info", "line one\nline two\rline three").unwrap();
        assert!(directory.join("app.log.1").exists());
        let text = fs::read_to_string(directory.join("app.log")).unwrap();
        assert_eq!(text.lines().count(), 1);
        assert!(text.contains("line one\\nline two\\rline three"));
        assert!(write_log_file(&directory, "fake", "message").is_err());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(directory.join("app.log"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn windows_update_never_becomes_a_mac_update() {
        let manifest = json!({ "version": "1.0.0", "platforms": { "windows-x86_64": { "url": "https://wutheringwaves-wuwatappo.kurogames-global.com/setup.exe", "signature": "signature" } } });
        let error = mac_update_status(&manifest, "darwin-aarch64").unwrap_err();
        assert!(error.contains("没有适用于此 Mac"));
        let disguised = json!({ "platforms": { "darwin-aarch64": { "url": "https://wutheringwaves-wuwatappo.kurogames-global.com/setup.exe", "signature": "signature" } } });
        assert!(mac_update_status(&disguised, "darwin-aarch64")
            .unwrap_err()
            .contains("Windows 安装包"));
    }

    #[test]
    fn malformed_and_unsigned_manifests_fail_explicitly() {
        assert!(mac_update_status(&json!({}), "darwin-aarch64").is_err());
        let unsigned = json!({ "platforms": { "darwin-aarch64": { "url": "https://wutheringwaves-wuwatappo.kurogames-global.com/mac.tar.gz" } } });
        assert!(mac_update_status(&unsigned, "darwin-aarch64")
            .unwrap_err()
            .contains("缺少签名"));
    }

    #[test]
    fn manifest_endpoints_require_official_https_hosts() {
        assert!(validate_manifest_endpoint(
            "https://wutheringwaves-wuwatappo.kurogames-global.com/app/latest.json"
        )
        .is_ok());
        assert!(validate_manifest_endpoint(
            "https://kurogames-global.com.evil.example/latest.json"
        )
        .is_err());
        assert!(validate_manifest_endpoint(
            "http://wutheringwaves-wuwatappo.kurogames-global.com/latest.json"
        )
        .is_err());
        assert!(validate_manifest_endpoint(
            "https://user:pass@wutheringwaves-wuwatappo.kurogames-global.com/latest.json"
        )
        .is_err());
    }
}
