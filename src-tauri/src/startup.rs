use serde::{Deserialize, Serialize};
use std::{fs, io::ErrorKind, path::Path};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SessionMode {
    Memory,
    Keychain,
}

pub fn load_mode(path: &Path) -> Result<Option<SessionMode>, String> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|error| format!("登录信息保存方式配置无效：{error}")),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("无法读取登录信息保存方式：{error}")),
    }
}

pub fn save_mode(path: &Path, mode: SessionMode) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or("Session preference directory is unavailable")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let bytes = serde_json::to_vec(&mode).map_err(|error| error.to_string())?;
    let temporary = path.with_extension(format!("{}.tmp", std::process::id()));
    fs::write(&temporary, bytes).map_err(|error| error.to_string())?;
    fs::rename(&temporary, path).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mode_names_are_explicit_and_unknown_modes_are_not_fallbacks() {
        assert_eq!(
            serde_json::from_str::<SessionMode>("\"memory\"").unwrap(),
            SessionMode::Memory
        );
        assert_eq!(
            serde_json::from_str::<SessionMode>("\"keychain\"").unwrap(),
            SessionMode::Keychain
        );
        assert!(serde_json::from_str::<SessionMode>("\"plaintext\"").is_err());
    }

    #[test]
    fn preferences_keep_the_selected_mode_and_report_corruption() {
        let root = std::env::temp_dir().join(format!("wuwa-mode-test-{}", std::process::id()));
        let path = root.join("session-mode.json");
        assert_eq!(load_mode(&path).unwrap(), None);
        save_mode(&path, SessionMode::Memory).unwrap();
        assert_eq!(load_mode(&path).unwrap(), Some(SessionMode::Memory));
        save_mode(&path, SessionMode::Keychain).unwrap();
        assert_eq!(load_mode(&path).unwrap(), Some(SessionMode::Keychain));
        fs::write(&path, b"broken").unwrap();
        assert!(load_mode(&path).is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
