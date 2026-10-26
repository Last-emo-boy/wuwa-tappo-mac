use security_framework::passwords::{
    delete_generic_password, get_generic_password, set_generic_password,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

const ACCOUNT: &str = "webview-session-v1";
const ITEM_NOT_FOUND: i32 = -25300;
const CHANGE_EVENT: &str = "session://changed";
const SECURE_STORAGE_KEYS: [&str; 3] = [
    "__KrSDK_USER_TOKEN__",
    "__KrSDK_USER_INFO__",
    "overseas-pending-role-select",
];

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionCookie {
    name: String,
    value: String,
    path: String,
    expires_at: Option<i64>,
    secure: bool,
    same_site: Option<String>,
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSnapshot {
    revision: u64,
    cookies: Vec<SessionCookie>,
    storage: BTreeMap<String, String>,
    #[serde(default)]
    persistence: SessionPersistence,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
enum SessionPersistence {
    Memory,
    #[default]
    Keychain,
}

#[derive(Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SessionMutation {
    SetCookie { cookie: SessionCookie },
    SetStorage { key: String, value: Option<String> },
    ClearStorage,
}

#[derive(Clone)]
pub struct SessionStore {
    backend: SessionBackend,
    inner: Arc<Mutex<SessionSnapshot>>,
}

#[derive(Clone)]
enum SessionBackend {
    Memory,
    Keychain { service: Arc<str> },
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn remove_expired(snapshot: &mut SessionSnapshot, now: i64) {
    snapshot
        .cookies
        .retain(|cookie| cookie.expires_at.is_none_or(|expiry| expiry > now));
}

fn apply_mutation(
    snapshot: &mut SessionSnapshot,
    mutation: SessionMutation,
    now: i64,
) -> Result<(), String> {
    remove_expired(snapshot, now);
    match mutation {
        SessionMutation::SetCookie { cookie } => {
            if cookie.name.is_empty()
                || cookie
                    .name
                    .bytes()
                    .any(|byte| byte <= 0x20 || b"()<>@,;:\\\"/[]?={}".contains(&byte))
                || cookie
                    .value
                    .bytes()
                    .any(|byte| byte < 0x20 || byte == 0x7f || byte == b';')
                || !cookie.path.starts_with('/')
                || cookie.path.bytes().any(|byte| byte < 0x20 || byte == b';')
            {
                return Err("Invalid app session cookie".to_owned());
            }
            if let Some(same_site) = &cookie.same_site {
                if !matches!(same_site.as_str(), "none" | "lax" | "strict")
                    || (same_site == "none" && !cookie.secure)
                {
                    return Err("Invalid app session cookie SameSite attributes".to_owned());
                }
            }
            snapshot
                .cookies
                .retain(|current| current.name != cookie.name || current.path != cookie.path);
            if cookie.expires_at.is_none_or(|expiry| expiry > now) {
                snapshot.cookies.push(cookie);
            }
        }
        SessionMutation::SetStorage { key, value } => {
            if !SECURE_STORAGE_KEYS.contains(&key.as_str()) {
                return Err("This key is not app secure session storage".to_owned());
            }
            if let Some(value) = value {
                snapshot.storage.insert(key, value);
            } else {
                snapshot.storage.remove(&key);
            }
        }
        SessionMutation::ClearStorage => snapshot.storage.clear(),
    }
    snapshot.revision += 1;
    Ok(())
}

fn transaction(
    current: &mut SessionSnapshot,
    mutation: SessionMutation,
    now: i64,
    persist: impl FnOnce(&SessionSnapshot) -> Result<(), String>,
) -> Result<SessionSnapshot, String> {
    let mut next = current.clone();
    apply_mutation(&mut next, mutation, now)?;
    if next.persistence == SessionPersistence::Keychain {
        let mut durable = next.clone();
        durable.cookies.retain(|cookie| cookie.expires_at.is_some());
        persist(&durable)?;
    }
    *current = next.clone();
    Ok(next)
}

fn persist_snapshot(
    snapshot: &SessionSnapshot,
    write: impl FnOnce(&[u8]) -> Result<(), String>,
    remove: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    if snapshot.cookies.is_empty() && snapshot.storage.is_empty() {
        return remove();
    }
    let bytes =
        serde_json::to_vec(snapshot).map_err(|_| "Cannot serialize app sign-in data".to_owned())?;
    write(&bytes)
}

fn deletion_result(result: Result<(), security_framework::base::Error>) -> Result<(), String> {
    match result {
        Ok(()) => Ok(()),
        Err(error) if error.code() == ITEM_NOT_FOUND => Ok(()),
        Err(error) => Err(format!(
            "Cannot remove empty app sign-in data from Keychain (OSStatus {})",
            error.code()
        )),
    }
}

impl SessionStore {
    pub fn ephemeral() -> Self {
        Self {
            backend: SessionBackend::Memory,
            inner: Arc::new(Mutex::new(SessionSnapshot {
                persistence: SessionPersistence::Memory,
                ..SessionSnapshot::default()
            })),
        }
    }

    pub fn is_ephemeral(&self) -> bool {
        matches!(&self.backend, SessionBackend::Memory)
    }

    pub fn open(identifier: impl Into<String>) -> Result<Self, String> {
        let service = format!("{}.session", identifier.into());
        let mut snapshot = match get_generic_password(&service, ACCOUNT) {
            Ok(bytes) => serde_json::from_slice::<SessionSnapshot>(&bytes).map_err(|_| {
                "Secure sign-in data in the app keychain item is invalid".to_owned()
            })?,
            Err(error) if error.code() == ITEM_NOT_FOUND => SessionSnapshot::default(),
            Err(error) => {
                return Err(format!(
                    "Cannot open the app sign-in keychain item (OSStatus {})",
                    error.code()
                ))
            }
        };
        remove_expired(&mut snapshot, now_millis());
        snapshot
            .storage
            .retain(|key, _| SECURE_STORAGE_KEYS.contains(&key.as_str()));
        snapshot.persistence = SessionPersistence::Keychain;
        Ok(Self {
            backend: SessionBackend::Keychain {
                service: Arc::from(service),
            },
            inner: Arc::new(Mutex::new(snapshot)),
        })
    }

    pub fn snapshot(&self) -> Result<SessionSnapshot, String> {
        let mut snapshot = self
            .inner
            .lock()
            .map_err(|_| "App sign-in session lock failed".to_owned())?
            .clone();
        remove_expired(&mut snapshot, now_millis());
        Ok(snapshot)
    }

    pub fn initialization_script(&self) -> Result<String, String> {
        let snapshot = serde_json::to_string(&self.snapshot()?)
            .map_err(|_| "Cannot initialize the app sign-in session".to_owned())?;
        Ok(include_str!("../../scripts/mac-session.js")
            .replace("__WUWATAPPO_SESSION_SNAPSHOT__", &snapshot))
    }

    fn apply(&self, mutation: SessionMutation) -> Result<SessionSnapshot, String> {
        let mut current = self
            .inner
            .lock()
            .map_err(|_| "App sign-in session lock failed".to_owned())?;
        transaction(
            &mut current,
            mutation,
            now_millis(),
            |snapshot| match &self.backend {
                SessionBackend::Memory => Ok(()),
                SessionBackend::Keychain { service } => persist_snapshot(
                    snapshot,
                    |bytes| {
                        set_generic_password(service, ACCOUNT, bytes).map_err(|error| {
                            format!(
                                "Cannot save app sign-in data in Keychain (OSStatus {})",
                                error.code()
                            )
                        })
                    },
                    || deletion_result(delete_generic_password(service, ACCOUNT)),
                ),
            },
        )
    }
}

fn trusted_window(window: &WebviewWindow) -> bool {
    window.url().is_ok_and(|url| {
        (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
            || (matches!(url.scheme(), "http" | "https")
                && matches!(
                    url.host_str(),
                    Some("localhost" | "127.0.0.1" | "tauri.localhost")
                ))
    })
}

fn require_app_window(window: &WebviewWindow) -> Result<(), String> {
    if trusted_window(window) {
        Ok(())
    } else {
        Err("App sign-in data is only available to local app windows".to_owned())
    }
}

#[tauri::command]
pub fn session_snapshot(
    window: WebviewWindow,
    store: State<'_, SessionStore>,
) -> Result<SessionSnapshot, String> {
    require_app_window(&window)?;
    store.snapshot()
}

#[tauri::command]
pub async fn session_apply(
    app: AppHandle,
    window: WebviewWindow,
    store: State<'_, SessionStore>,
    mutation: SessionMutation,
) -> Result<SessionSnapshot, String> {
    require_app_window(&window)?;
    let store = store.inner().clone();
    let snapshot = tauri::async_runtime::spawn_blocking(move || store.apply(mutation))
        .await
        .map_err(|_| "App sign-in keychain worker failed".to_owned())??;
    for window in app
        .webview_windows()
        .values()
        .filter(|window| trusted_window(window))
    {
        window.emit(CHANGE_EVENT, &snapshot).map_err(|_| {
            "App sign-in data was saved but could not be synchronized to an app window".to_owned()
        })?;
    }
    Ok(snapshot)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};

    #[derive(Default)]
    struct MockKeychain {
        value: RefCell<Option<Vec<u8>>>,
        writes: Cell<usize>,
        deletes: Cell<usize>,
        delete_error: bool,
    }

    impl MockKeychain {
        fn persist(&self, snapshot: &SessionSnapshot) -> Result<(), String> {
            persist_snapshot(
                snapshot,
                |bytes| {
                    self.writes.set(self.writes.get() + 1);
                    *self.value.borrow_mut() = Some(bytes.to_vec());
                    Ok(())
                },
                || {
                    self.deletes.set(self.deletes.get() + 1);
                    if self.delete_error {
                        return Err("synthetic Keychain deletion denied".to_owned());
                    }
                    *self.value.borrow_mut() = None;
                    Ok(())
                },
            )
        }
    }

    fn cookie(expiry: Option<i64>) -> SessionCookie {
        SessionCookie {
            name: "kuro_infoToken".to_owned(),
            value: "synthetic-test-value".to_owned(),
            path: "/".to_owned(),
            expires_at: expiry,
            secure: true,
            same_site: Some("none".to_owned()),
        }
    }

    #[test]
    fn persists_cookie_attributes_and_expires_without_revealing_values() {
        let mut state = SessionSnapshot::default();
        transaction(
            &mut state,
            SessionMutation::SetCookie {
                cookie: cookie(Some(2000)),
            },
            1000,
            |saved| {
                assert_eq!(saved.cookies, vec![cookie(Some(2000))]);
                Ok(())
            },
        )
        .unwrap();
        remove_expired(&mut state, 2000);
        assert!(state.cookies.is_empty());
    }

    #[test]
    fn a_keychain_failure_does_not_commit_memory_state() {
        let mut state = SessionSnapshot::default();
        let result = transaction(
            &mut state,
            SessionMutation::SetCookie {
                cookie: cookie(Some(2000)),
            },
            1000,
            |_| Err("locked".to_owned()),
        );
        assert!(result.is_err());
        assert!(state.cookies.is_empty());
        assert_eq!(state.revision, 0);
    }

    #[test]
    fn session_cookies_are_not_written_to_keychain() {
        let mut state = SessionSnapshot::default();
        transaction(
            &mut state,
            SessionMutation::SetCookie {
                cookie: cookie(None),
            },
            1000,
            |saved| {
                assert!(saved.cookies.is_empty());
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(state.cookies.len(), 1);
    }

    #[test]
    fn expired_cookie_deletes_only_the_matching_path() {
        let mut state = SessionSnapshot::default();
        let mut nested = cookie(Some(3000));
        nested.path = "/panel".to_owned();
        apply_mutation(
            &mut state,
            SessionMutation::SetCookie {
                cookie: cookie(Some(3000)),
            },
            1000,
        )
        .unwrap();
        apply_mutation(
            &mut state,
            SessionMutation::SetCookie {
                cookie: nested.clone(),
            },
            1000,
        )
        .unwrap();
        apply_mutation(
            &mut state,
            SessionMutation::SetCookie {
                cookie: cookie(Some(500)),
            },
            1000,
        )
        .unwrap();
        assert_eq!(state.cookies, vec![nested]);
    }

    #[test]
    fn secure_storage_rejects_unknown_keys_and_removes_known_credentials() {
        let mut state = SessionSnapshot::default();
        assert!(apply_mutation(
            &mut state,
            SessionMutation::SetStorage {
                key: "settings".to_owned(),
                value: Some("x".to_owned())
            },
            1000
        )
        .is_err());
        let key = SECURE_STORAGE_KEYS[0].to_owned();
        apply_mutation(
            &mut state,
            SessionMutation::SetStorage {
                key: key.clone(),
                value: Some("synthetic".to_owned()),
            },
            1000,
        )
        .unwrap();
        apply_mutation(
            &mut state,
            SessionMutation::SetStorage { key, value: None },
            1000,
        )
        .unwrap();
        assert!(state.storage.is_empty());
    }

    #[test]
    fn deleting_the_last_persistent_cookie_removes_the_keychain_item() {
        let keychain = MockKeychain::default();
        let mut state = SessionSnapshot::default();
        transaction(
            &mut state,
            SessionMutation::SetCookie {
                cookie: cookie(Some(2000)),
            },
            1000,
            |saved| keychain.persist(saved),
        )
        .unwrap();
        assert!(keychain.value.borrow().is_some());
        transaction(
            &mut state,
            SessionMutation::SetCookie {
                cookie: cookie(Some(500)),
            },
            1000,
            |saved| keychain.persist(saved),
        )
        .unwrap();
        assert!(state.cookies.is_empty());
        assert!(keychain.value.borrow().is_none());
        assert_eq!(keychain.writes.get(), 1);
        assert_eq!(keychain.deletes.get(), 1);
    }

    #[test]
    fn clearing_last_secure_storage_removes_item_but_preserves_session_only_cookies() {
        let keychain = MockKeychain::default();
        let mut state = SessionSnapshot {
            revision: 4,
            cookies: vec![cookie(None)],
            storage: BTreeMap::from([(SECURE_STORAGE_KEYS[0].to_owned(), "synthetic".to_owned())]),
            ..SessionSnapshot::default()
        };
        transaction(&mut state, SessionMutation::ClearStorage, 1000, |saved| {
            keychain.persist(saved)
        })
        .unwrap();
        assert_eq!(state.cookies, vec![cookie(None)]);
        assert!(state.storage.is_empty());
        assert!(keychain.value.borrow().is_none());
        assert_eq!(keychain.writes.get(), 0);
        assert_eq!(keychain.deletes.get(), 1);
    }

    #[test]
    fn a_keychain_deletion_failure_does_not_commit_logout_state() {
        let original = cookie(Some(2000));
        let mut state = SessionSnapshot {
            revision: 7,
            cookies: vec![original.clone()],
            storage: BTreeMap::new(),
            ..SessionSnapshot::default()
        };
        let persisted = serde_json::to_vec(&state).unwrap();
        let keychain = MockKeychain {
            value: RefCell::new(Some(persisted.clone())),
            delete_error: true,
            ..MockKeychain::default()
        };
        let error = transaction(
            &mut state,
            SessionMutation::SetCookie {
                cookie: cookie(Some(500)),
            },
            1000,
            |saved| keychain.persist(saved),
        )
        .err()
        .unwrap();
        assert_eq!(error, "synthetic Keychain deletion denied");
        assert_eq!(state.cookies, vec![original]);
        assert_eq!(state.revision, 7);
        assert_eq!(keychain.deletes.get(), 1);
        assert_eq!(
            keychain.value.borrow().as_deref(),
            Some(persisted.as_slice())
        );
    }

    #[test]
    fn any_remaining_secure_storage_keeps_the_keychain_item() {
        let keychain = MockKeychain::default();
        let state = SessionSnapshot {
            storage: BTreeMap::from([(
                SECURE_STORAGE_KEYS[1].to_owned(),
                "synthetic-sdk-profile".to_owned(),
            )]),
            ..SessionSnapshot::default()
        };
        keychain.persist(&state).unwrap();
        assert!(keychain.value.borrow().is_some());
        assert_eq!(keychain.writes.get(), 1);
        assert_eq!(keychain.deletes.get(), 0);
    }

    #[test]
    fn deleting_an_absent_item_succeeds_but_other_os_errors_remain_explicit() {
        assert!(
            deletion_result(Err(security_framework::base::Error::from_code(
                ITEM_NOT_FOUND
            )))
            .is_ok()
        );
        let error = deletion_result(Err(security_framework::base::Error::from_code(-25293)))
            .err()
            .unwrap();
        assert!(error.contains("OSStatus -25293"));
    }

    #[test]
    fn memory_mode_never_invokes_the_persistence_backend() {
        let calls = Cell::new(0);
        let mut state = SessionSnapshot {
            persistence: SessionPersistence::Memory,
            ..SessionSnapshot::default()
        };
        let mutations = vec![
            SessionMutation::SetCookie {
                cookie: cookie(Some(2000)),
            },
            SessionMutation::SetCookie {
                cookie: cookie(None),
            },
            SessionMutation::SetStorage {
                key: SECURE_STORAGE_KEYS[0].to_owned(),
                value: Some("synthetic-sdk-token".to_owned()),
            },
            SessionMutation::SetStorage {
                key: SECURE_STORAGE_KEYS[1].to_owned(),
                value: Some("synthetic-sdk-profile".to_owned()),
            },
            SessionMutation::SetStorage {
                key: SECURE_STORAGE_KEYS[2].to_owned(),
                value: Some("synthetic-role-selection".to_owned()),
            },
            SessionMutation::SetCookie {
                cookie: cookie(Some(500)),
            },
            SessionMutation::ClearStorage,
        ];
        for mutation in mutations {
            transaction(&mut state, mutation, 1000, |_| {
                calls.set(calls.get() + 1);
                Err("No persistence API is authorized".to_owned())
            })
            .unwrap();
        }
        assert_eq!(calls.get(), 0);
        assert_eq!(state.revision, 7);
        assert!(state.cookies.is_empty());
        assert!(state.storage.is_empty());
        assert_eq!(state.persistence, SessionPersistence::Memory);
    }

    #[test]
    fn ephemeral_stores_share_memory_with_clones_and_restart_empty() {
        let store = SessionStore::ephemeral();
        assert!(store.is_ephemeral());
        let mut value = cookie(Some(now_millis() + 60000));
        value.value = "synthetic-memory-cookie".to_owned();
        store
            .apply(SessionMutation::SetCookie {
                cookie: value.clone(),
            })
            .unwrap();
        store
            .apply(SessionMutation::SetStorage {
                key: SECURE_STORAGE_KEYS[0].to_owned(),
                value: Some("synthetic-memory-sdk-token".to_owned()),
            })
            .unwrap();
        let other_window = store.clone().snapshot().unwrap();
        assert_eq!(other_window.cookies, vec![value]);
        assert_eq!(
            other_window.storage.get(SECURE_STORAGE_KEYS[0]).unwrap(),
            "synthetic-memory-sdk-token"
        );
        assert_eq!(other_window.revision, 2);
        assert_eq!(other_window.persistence, SessionPersistence::Memory);
        let restart = SessionStore::ephemeral().snapshot().unwrap();
        assert!(restart.cookies.is_empty());
        assert!(restart.storage.is_empty());
        assert_eq!(restart.revision, 0);
        assert_eq!(restart.persistence, SessionPersistence::Memory);
    }

    #[test]
    fn legacy_snapshots_remain_keychain_mode_and_new_snapshots_expose_explicit_mode() {
        let legacy: SessionSnapshot =
            serde_json::from_str(r#"{"revision":3,"cookies":[],"storage":{}}"#).unwrap();
        assert_eq!(legacy.persistence, SessionPersistence::Keychain);
        let store = SessionStore::ephemeral();
        let encoded = serde_json::to_value(store.snapshot().unwrap()).unwrap();
        assert_eq!(encoded["persistence"], "memory");
        assert!(store
            .initialization_script()
            .unwrap()
            .contains("\"persistence\":\"memory\""));
    }
}
