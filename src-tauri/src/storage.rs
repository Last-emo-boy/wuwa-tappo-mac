use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
};

pub const MAX_SAFE_COUNT: u64 = 9_007_199_254_740_991;
static WRITE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CumulativeClickCount {
    pub count: u64,
    pub cuid: String,
    pub environment: String,
}

#[derive(Default, Serialize, Deserialize)]
struct EnvironmentCounters {
    key_press: u64,
    active_cuid: Option<String>,
    cumulative: BTreeMap<String, u64>,
}

#[derive(Serialize, Deserialize)]
struct CounterData {
    version: u32,
    environments: BTreeMap<String, EnvironmentCounters>,
}

impl Default for CounterData {
    fn default() -> Self {
        Self {
            version: 1,
            environments: BTreeMap::new(),
        }
    }
}

pub struct CounterStore {
    path: PathBuf,
    transaction: Mutex<()>,
}

impl CounterStore {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            transaction: Mutex::new(()),
        }
    }

    pub fn load_key_press(&self, environment: &str) -> Result<u64, String> {
        validate_environment(environment)?;
        let _transaction = self
            .transaction
            .lock()
            .map_err(|_| "counter_store_lock_poisoned")?;
        Ok(self
            .read()?
            .environments
            .get(environment)
            .map_or(0, |entry| entry.key_press))
    }

    pub fn save_key_press(&self, environment: &str, count: u64) -> Result<(), String> {
        validate_environment(environment)?;
        validate_count(count)?;
        let _transaction = self
            .transaction
            .lock()
            .map_err(|_| "counter_store_lock_poisoned")?;
        let mut data = self.read()?;
        data.environments
            .entry(environment.to_owned())
            .or_default()
            .key_press = count;
        self.write(&data)
    }

    pub fn load_cumulative(&self, environment: &str) -> Result<CumulativeClickCount, String> {
        validate_environment(environment)?;
        let _transaction = self
            .transaction
            .lock()
            .map_err(|_| "counter_store_lock_poisoned")?;
        let data = self.read()?;
        let entry = data.environments.get(environment);
        let cuid = entry
            .and_then(|entry| entry.active_cuid.as_deref())
            .unwrap_or("");
        let count = entry
            .and_then(|entry| entry.cumulative.get(cuid))
            .copied()
            .unwrap_or(0);
        Ok(CumulativeClickCount {
            count,
            cuid: cuid.to_owned(),
            environment: environment.to_owned(),
        })
    }

    pub fn save_cumulative(&self, environment: &str, cuid: &str, count: u64) -> Result<(), String> {
        validate_environment(environment)?;
        validate_count(count)?;
        if cuid.trim().is_empty() {
            return Err("counter_account_required".into());
        }
        let _transaction = self
            .transaction
            .lock()
            .map_err(|_| "counter_store_lock_poisoned")?;
        let mut data = self.read()?;
        let entry = data.environments.entry(environment.to_owned()).or_default();
        entry.cumulative.insert(cuid.to_owned(), count);
        entry.active_cuid = Some(cuid.to_owned());
        self.write(&data)
    }

    fn read(&self) -> Result<CounterData, String> {
        let file = match File::open(&self.path) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Ok(CounterData::default())
            }
            Err(error) => return Err(format!("counter_store_read_failed: {error}")),
        };
        let data: CounterData = serde_json::from_reader(file)
            .map_err(|error| format!("counter_store_invalid_json: {error}"))?;
        if data.version != 1 {
            return Err(format!(
                "counter_store_unsupported_version: {}",
                data.version
            ));
        }
        for (environment, entry) in &data.environments {
            validate_environment(environment)?;
            validate_count(entry.key_press)?;
            for (cuid, count) in &entry.cumulative {
                if cuid.trim().is_empty() {
                    return Err("counter_store_invalid_account".into());
                }
                validate_count(*count)?;
            }
            if let Some(cuid) = &entry.active_cuid {
                if !entry.cumulative.contains_key(cuid) {
                    return Err("counter_store_active_account_missing".into());
                }
            }
        }
        Ok(data)
    }

    fn write(&self, data: &CounterData) -> Result<(), String> {
        let directory = self
            .path
            .parent()
            .ok_or("counter_store_directory_missing")?;
        create_private_directory(directory)
            .map_err(|error| format!("counter_store_directory_failed: {error}"))?;
        let temporary = directory.join(format!(
            ".counters-{}-{}.tmp",
            std::process::id(),
            WRITE_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        let result = (|| {
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options
                .open(&temporary)
                .map_err(|error| format!("counter_store_write_failed: {error}"))?;
            serde_json::to_writer(&mut file, data)
                .map_err(|error| format!("counter_store_serialize_failed: {error}"))?;
            file.write_all(b"\n")
                .and_then(|_| file.sync_all())
                .map_err(|error| format!("counter_store_sync_failed: {error}"))?;
            fs::rename(&temporary, &self.path)
                .map_err(|error| format!("counter_store_replace_failed: {error}"))
        })();
        match result {
            Ok(()) => Ok(()),
            Err(original) => {
                if let Err(error) = fs::remove_file(&temporary) {
                    if error.kind() != io::ErrorKind::NotFound {
                        return Err(format!("{original}; counter_store_cleanup_failed: {error}"));
                    }
                }
                Err(original)
            }
        }
    }
}

fn validate_environment(environment: &str) -> Result<(), String> {
    if environment.trim().is_empty() {
        Err("counter_environment_required".into())
    } else {
        Ok(())
    }
}

fn validate_count(count: u64) -> Result<(), String> {
    if count > MAX_SAFE_COUNT {
        Err("counter_exceeds_javascript_safe_integer".into())
    } else {
        Ok(())
    }
}

fn create_private_directory(path: &Path) -> io::Result<()> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path)
}

#[tauri::command]
pub fn load_key_press_count(
    store: tauri::State<'_, CounterStore>,
    environment: String,
) -> Result<u64, String> {
    store.load_key_press(&environment)
}

#[tauri::command]
pub fn save_key_press_count(
    store: tauri::State<'_, CounterStore>,
    count: u64,
    environment: String,
) -> Result<(), String> {
    store.save_key_press(&environment, count)
}

#[tauri::command]
pub fn load_cumulative_click_count(
    store: tauri::State<'_, CounterStore>,
    environment: String,
) -> Result<CumulativeClickCount, String> {
    store.load_cumulative(&environment)
}

#[tauri::command]
pub fn save_cumulative_click_count(
    store: tauri::State<'_, CounterStore>,
    count: u64,
    cuid: String,
    environment: String,
) -> Result<(), String> {
    store.save_cumulative(&environment, &cuid, count)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestDirectory(PathBuf);
    impl TestDirectory {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "wuwatappo-counters-test-{}-{}",
                std::process::id(),
                WRITE_SEQUENCE.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
        fn store(&self) -> CounterStore {
            CounterStore::new(self.0.join("counters.json"))
        }
    }
    impl Drop for TestDirectory {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    #[test]
    fn missing_store_returns_zero_with_requested_environment() {
        let directory = TestDirectory::new();
        let store = directory.store();
        assert_eq!(store.load_key_press("global-global-prod").unwrap(), 0);
        assert_eq!(
            store.load_cumulative("global-global-prod").unwrap(),
            CumulativeClickCount {
                count: 0,
                cuid: String::new(),
                environment: "global-global-prod".into()
            }
        );
    }

    #[test]
    fn counters_survive_reopen_and_force_zero() {
        let directory = TestDirectory::new();
        directory
            .store()
            .save_key_press("global-global-prod", 123)
            .unwrap();
        assert_eq!(
            directory
                .store()
                .load_key_press("global-global-prod")
                .unwrap(),
            123
        );
        directory
            .store()
            .save_key_press("global-global-prod", 0)
            .unwrap();
        assert_eq!(
            directory
                .store()
                .load_key_press("global-global-prod")
                .unwrap(),
            0
        );
    }

    #[test]
    fn environments_are_isolated_without_filename_interpolation() {
        let directory = TestDirectory::new();
        let store = directory.store();
        store.save_key_press("global-global-prod", 20).unwrap();
        store.save_key_press("cn-prod", 30).unwrap();
        store.save_key_press("../literal-environment", 40).unwrap();
        assert_eq!(store.load_key_press("global-global-prod").unwrap(), 20);
        assert_eq!(store.load_key_press("cn-prod").unwrap(), 30);
        assert_eq!(store.load_key_press("../literal-environment").unwrap(), 40);
        assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 1);
    }

    #[test]
    fn cumulative_counts_keep_separate_account_records() {
        let directory = TestDirectory::new();
        let store = directory.store();
        store
            .save_cumulative("global-global-prod", "account-a", 100)
            .unwrap();
        store
            .save_cumulative("global-global-prod", "account-b", 200)
            .unwrap();
        let result = store.load_cumulative("global-global-prod").unwrap();
        assert_eq!(result.cuid, "account-b");
        assert_eq!(result.count, 200);
        let data = store.read().unwrap();
        assert_eq!(
            data.environments["global-global-prod"].cumulative["account-a"],
            100
        );
        assert_eq!(store.load_cumulative("cn-prod").unwrap().count, 0);
    }

    #[test]
    fn rejects_out_of_range_counts_without_replacing_valid_data() {
        let directory = TestDirectory::new();
        let store = directory.store();
        store
            .save_key_press("global-global-prod", MAX_SAFE_COUNT)
            .unwrap();
        let original = fs::read(&store.path).unwrap();
        assert!(store
            .save_key_press("global-global-prod", MAX_SAFE_COUNT + 1)
            .is_err());
        assert!(store
            .save_cumulative("global-global-prod", "account-a", MAX_SAFE_COUNT + 1)
            .is_err());
        assert!(store
            .save_cumulative("global-global-prod", "  ", 1)
            .is_err());
        assert!(store.save_key_press("  ", 1).is_err());
        assert_eq!(fs::read(&store.path).unwrap(), original);
    }

    #[test]
    fn malformed_store_is_not_reset_by_a_save() {
        let directory = TestDirectory::new();
        let store = directory.store();
        fs::write(&store.path, b"{broken-json").unwrap();
        assert!(store
            .load_key_press("global-global-prod")
            .unwrap_err()
            .contains("invalid_json"));
        assert!(store.save_key_press("global-global-prod", 42).is_err());
        assert_eq!(fs::read(&store.path).unwrap(), b"{broken-json");
    }

    #[test]
    fn rejects_unknown_schema_and_inconsistent_account_records() {
        let directory = TestDirectory::new();
        let store = directory.store();
        fs::write(&store.path, r#"{"version":2,"environments":{}}"#).unwrap();
        assert!(store
            .load_key_press("env")
            .unwrap_err()
            .contains("unsupported_version"));
        fs::write(&store.path, r#"{"version":1,"environments":{"env":{"key_press":0,"active_cuid":"missing","cumulative":{}}}}"#).unwrap();
        assert!(store
            .load_cumulative("env")
            .unwrap_err()
            .contains("active_account_missing"));
    }

    #[test]
    fn persisted_values_use_a_private_atomic_file() {
        let directory = TestDirectory::new();
        let store = directory.store();
        store
            .save_cumulative("global-global-prod", "account-a", MAX_SAFE_COUNT)
            .unwrap();
        let encoded =
            serde_json::to_value(store.load_cumulative("global-global-prod").unwrap()).unwrap();
        assert_eq!(encoded["environment"], "global-global-prod");
        assert_eq!(encoded["cuid"], "account-a");
        assert_eq!(encoded["count"].as_u64(), Some(MAX_SAFE_COUNT));
        assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 1);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&store.path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }
}
