use crate::profile::Region;
use reqwest::Url;
use std::sync::Mutex;
use tauri::{plugin::TauriPlugin, Emitter, Manager, State, WebviewWindow};

const CALLBACK_READY_EVENT: &str = "mac-oauth-callback-ready";

#[derive(Default)]
struct CallbackState(Mutex<Vec<String>>);

impl CallbackState {
    fn receive(&self, urls: &[Url]) -> Result<Option<Vec<String>>, String> {
        let callbacks: Vec<String> = urls
            .iter()
            .filter(|url| is_callback(url))
            .map(ToString::to_string)
            .collect();
        if callbacks.is_empty() {
            return Ok(None);
        }
        self.0
            .lock()
            .map_err(|_| "OAuth callback state is unavailable")?
            .extend(callbacks.iter().cloned());
        Ok(Some(callbacks))
    }

    fn take_pending(
        &self,
        region: Region,
        label: &str,
        url: &Url,
    ) -> Result<Option<Vec<String>>, String> {
        if !trusted_consumer(region, label, url) {
            return Err("OAuth callbacks require the trusted Global main window".into());
        }
        let mut pending = self
            .0
            .lock()
            .map_err(|_| "OAuth callback state is unavailable")?;
        if pending.is_empty() {
            Ok(None)
        } else {
            Ok(Some(std::mem::take(&mut *pending)))
        }
    }
}

fn trusted_consumer(region: Region, label: &str, url: &Url) -> bool {
    region == Region::Global
        && label == "main"
        && ((url.scheme() == "tauri"
            && url.host_str() == Some("localhost")
            && url.port().is_none())
            || (matches!(url.scheme(), "http" | "https")
                && url.host_str() == Some("tauri.localhost")
                && url.port().is_none()))
}

fn is_callback(url: &Url) -> bool {
    url.scheme() == "wuwa-buddy"
        && url.host_str() == Some("auth")
        && url.path() == "/callback"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
        && url.fragment().is_none()
        && url
            .query_pairs()
            .any(|(name, value)| name == "state" && !value.is_empty())
        && url.query_pairs().any(|(name, value)| {
            matches!(name.as_ref(), "access_token" | "token" | "code") && !value.is_empty()
        })
}

#[tauri::command]
fn get_current(
    window: WebviewWindow,
    state: State<'_, CallbackState>,
) -> Result<Option<Vec<String>>, String> {
    let url = window.url().map_err(|_| "Window location is unavailable")?;
    state.take_pending(Region::from_app(window.app_handle()), window.label(), &url)
}

// Tauri events are observable across windows. Broadcast only a neutral signal;
// the trusted Global main window reads credential-bearing URLs through IPC.
pub fn plugin() -> TauriPlugin<tauri::Wry, Option<serde_json::Value>> {
    tauri::plugin::Builder::new("deep-link")
        .invoke_handler(tauri::generate_handler![get_current])
        .setup(|app, _api| {
            app.manage(CallbackState::default());
            Ok(())
        })
        .on_event(|app, event| {
            if let tauri::RunEvent::Opened { urls } = event {
                let state = app.state::<CallbackState>();
                match state.receive(urls) {
                    Ok(Some(_)) => {}
                    Ok(None) => return,
                    Err(error) => {
                        eprintln!("{error}");
                        return;
                    }
                };
                if let Err(error) = app.emit(CALLBACK_READY_EVENT, ()) {
                    eprintln!("Could not signal OAuth callback availability: {error}");
                }
            }
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn callbacks_accept_only_the_official_scheme_route_and_stateful_auth_response() {
        for key in ["access_token", "token", "code"] {
            let url = Url::parse(&format!(
                "wuwa-buddy://auth/callback?state=synthetic&{key}=synthetic&cuid=synthetic"
            ))
            .unwrap();
            assert!(is_callback(&url));
        }
        for value in [
            "other://auth/callback?state=synthetic&token=synthetic",
            "wuwa-buddy://other/callback?state=synthetic&token=synthetic",
            "wuwa-buddy://auth/other?state=synthetic&token=synthetic",
            "wuwa-buddy://auth/callback?token=synthetic",
            "wuwa-buddy://auth/callback?state=&token=synthetic",
            "wuwa-buddy://auth/callback?state=synthetic",
            "wuwa-buddy://auth/callback?state=synthetic&token=synthetic#fragment",
        ] {
            assert!(!is_callback(&Url::parse(value).unwrap()));
        }
    }

    #[test]
    fn callback_access_is_global_local_main_only() {
        let local = Url::parse("tauri://localhost/index.html").unwrap();
        assert!(trusted_consumer(Region::Global, "main", &local));
        assert!(!trusted_consumer(Region::Cn, "main", &local));
        for label in ["login", "panel", "bootstrap"] {
            assert!(!trusted_consumer(Region::Global, label, &local));
        }
        for value in [
            "https://example.com",
            "tauri://foreign/index.html",
            "http://tauri.localhost:1234",
        ] {
            assert!(!trusted_consumer(
                Region::Global,
                "main",
                &Url::parse(value).unwrap()
            ));
        }
    }

    #[test]
    fn callback_notification_carries_no_credentials() {
        assert_eq!(CALLBACK_READY_EVENT, "mac-oauth-callback-ready");
        assert_eq!(serde_json::to_value(()).unwrap(), serde_json::Value::Null);
        let source = include_str!("auth.rs");
        assert!(source.contains("app.emit(CALLBACK_READY_EVENT, ())"));
        assert!(!source.contains("window.emit(\"deep-link://new-url\""));
    }

    #[test]
    fn callbacks_are_queued_before_a_main_window_exists_and_delivered_once() {
        let state = CallbackState::default();
        let local = Url::parse("tauri://localhost/index.html").unwrap();
        assert_eq!(
            state.take_pending(Region::Global, "main", &local).unwrap(),
            None
        );
        let first = Url::parse("wuwa-buddy://auth/callback?state=first&token=synthetic").unwrap();
        assert_eq!(
            state.receive(&[first.clone()]).unwrap(),
            Some(vec![first.to_string()])
        );
        assert_eq!(
            state
                .receive(&[Url::parse("https://example.com").unwrap()])
                .unwrap(),
            None
        );
        let second =
            Url::parse("wuwa-buddy://auth/callback?state=second&access_token=synthetic").unwrap();
        state.receive(&[second.clone()]).unwrap();
        assert_eq!(
            state.take_pending(Region::Global, "main", &local).unwrap(),
            Some(vec![first.to_string(), second.to_string()])
        );
        assert_eq!(
            state.take_pending(Region::Global, "main", &local).unwrap(),
            None
        );
    }

    #[test]
    fn a_late_stale_callback_does_not_overwrite_an_unconsumed_valid_response() {
        let state = CallbackState::default();
        let local = Url::parse("tauri://localhost/index.html").unwrap();
        let valid_b = Url::parse("wuwa-buddy://auth/callback?state=B&token=synthetic-B").unwrap();
        let stale_a = Url::parse("wuwa-buddy://auth/callback?state=A&token=synthetic-A").unwrap();
        state.receive(&[valid_b.clone()]).unwrap();
        state.receive(&[stale_a.clone()]).unwrap();
        let batch = state
            .take_pending(Region::Global, "main", &local)
            .unwrap()
            .unwrap();
        assert_eq!(batch, vec![valid_b.to_string(), stale_a.to_string()]);
        assert_eq!(
            state.take_pending(Region::Global, "main", &local).unwrap(),
            None
        );
    }

    #[test]
    fn unauthorized_readers_cannot_drain_the_pending_batch() {
        let state = CallbackState::default();
        let local = Url::parse("tauri://localhost/index.html").unwrap();
        let callback = Url::parse("wuwa-buddy://auth/callback?state=B&token=synthetic").unwrap();
        state.receive(&[callback.clone()]).unwrap();
        for (region, label, url) in [
            (Region::Cn, "main", local.clone()),
            (Region::Global, "panel", local.clone()),
            (Region::Global, "login", local.clone()),
            (
                Region::Global,
                "main",
                Url::parse("https://example.com").unwrap(),
            ),
        ] {
            assert!(state.take_pending(region, label, &url).is_err());
        }
        assert_eq!(
            state.take_pending(Region::Global, "main", &local).unwrap(),
            Some(vec![callback.to_string()])
        );
    }
}
