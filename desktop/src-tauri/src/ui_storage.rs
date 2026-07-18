use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        LazyLock,
    },
};

use regex::Regex;
use serde_json::{Map, Value};
use url::Url;

const MAX_ENTRIES: usize = 512;
const MAX_KEY_BYTES: usize = 160;
const MAX_VALUE_BYTES: usize = 64 * 1024;
const MAX_SNAPSHOT_BYTES: u64 = 256 * 1024;
const SNAPSHOT_FILE: &str = "storage-snapshot.json";
static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);
static SAFE_VERSION_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$").unwrap()
});
static SAFE_SLUG_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[a-z0-9][a-z0-9-]{0,63}$").unwrap());
static SAFE_IDENTITY_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$").unwrap());

fn valid_non_negative_integer(value: &str) -> bool {
    let canonical = value == "0"
        || value
            .strip_prefix(|character: char| matches!(character, '1'..='9'))
            .is_some_and(|rest| rest.bytes().all(|byte| byte.is_ascii_digit()));
    canonical
        && value
            .parse::<u64>()
            .is_ok_and(|number| number <= 9_007_199_254_740_991)
}

fn is_loopback_host(host: &str) -> bool {
    let host = host.trim_matches(['[', ']']).to_ascii_lowercase();
    if matches!(host.as_str(), "localhost" | "::1") {
        return true;
    }
    let parts: Vec<_> = host.split('.').collect();
    parts.len() == 4 && parts.iter().all(|part| part.parse::<u8>().is_ok()) && parts[0] == "127"
}

fn valid_origin(value: &str, allow_empty: bool) -> bool {
    if allow_empty && value.is_empty() {
        return true;
    }
    let Ok(url) = Url::parse(value) else {
        return false;
    };
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return false;
    }
    let transport_allowed = url.scheme() == "https"
        || (url.scheme() == "http" && url.host_str().is_some_and(is_loopback_host));
    transport_allowed && url.origin().ascii_serialization() == value
}

fn valid_server_profiles(value: &str) -> bool {
    let Ok(Value::Array(profiles)) = serde_json::from_str::<Value>(value) else {
        return false;
    };
    profiles.iter().all(|profile| {
        let Some(profile) = profile.as_object() else {
            return false;
        };
        if profile.len() != 2 || !profile.contains_key("label") || !profile.contains_key("origin") {
            return false;
        }
        let (Some(label), Some(origin)) = (
            profile.get("label").and_then(Value::as_str),
            profile.get("origin").and_then(Value::as_str),
        ) else {
            return false;
        };
        let normalized_label = label.split_whitespace().collect::<Vec<_>>().join(" ");
        !label.is_empty()
            && label.encode_utf16().count() <= 80
            && !label.chars().any(char::is_control)
            && normalized_label == label
            && valid_origin(origin, false)
    })
}

fn has_only_diagnostic_keys(diagnostic: &Map<String, Value>) -> bool {
    diagnostic.keys().all(|key| {
        matches!(
            key.as_str(),
            "status"
                | "source"
                | "stage"
                | "category"
                | "timestamp"
                | "appVersion"
                | "targetVersion"
        )
    }) && [
        "status",
        "source",
        "stage",
        "category",
        "timestamp",
        "appVersion",
    ]
    .iter()
    .all(|key| diagnostic.contains_key(*key))
}

fn valid_nullable_version(value: Option<&Value>) -> bool {
    value.is_some_and(|value| {
        value.is_null()
            || value
                .as_str()
                .is_some_and(|version| SAFE_VERSION_PATTERN.is_match(version))
    })
}

fn valid_target_version(value: Option<&Value>) -> bool {
    value.is_none_or(|value| {
        value
            .as_str()
            .is_some_and(|version| SAFE_VERSION_PATTERN.is_match(version))
    })
}

fn valid_updater_diagnostic(value: &str) -> bool {
    let Ok(Value::Object(diagnostic)) = serde_json::from_str::<Value>(value) else {
        return false;
    };
    has_only_diagnostic_keys(&diagnostic)
        && matches!(
            diagnostic.get("status").and_then(Value::as_str),
            Some("attempt" | "success" | "failure" | "pending")
        )
        && diagnostic.get("source").is_some_and(|value| {
            value.is_null() || matches!(value.as_str(), Some("auto" | "manual"))
        })
        && matches!(
            diagnostic.get("stage").and_then(Value::as_str),
            Some("check" | "install" | "relaunch")
        )
        && diagnostic.get("category").is_some_and(|value| {
            value.is_null()
                || matches!(
                    value.as_str(),
                    Some(
                        "offline" | "timeout" | "verification" | "install" | "relaunch" | "generic"
                    )
                )
        })
        && diagnostic
            .get("timestamp")
            .and_then(Value::as_u64)
            .is_some_and(|timestamp| timestamp <= 9_007_199_254_740_991)
        && valid_nullable_version(diagnostic.get("appVersion"))
        && valid_target_version(diagnostic.get("targetVersion"))
}

fn valid_value(key: &str, value: &str) -> bool {
    if let Some(suffix) = key.strip_prefix("ap_seen:v1:") {
        let mut parts = suffix.split(':');
        return parts
            .next()
            .is_some_and(|slug| SAFE_SLUG_PATTERN.is_match(slug))
            && parts
                .next()
                .is_some_and(|identity| SAFE_IDENTITY_PATTERN.is_match(identity))
            && parts.next().is_none()
            && valid_non_negative_integer(value);
    }
    if let Some(slug) = key.strip_prefix("ap_charter_seen:") {
        return SAFE_SLUG_PATTERN.is_match(slug) && valid_non_negative_integer(value);
    }
    match key {
        "ap_active_server_origin_v1" => valid_origin(value, false),
        "ap_api_base" => valid_origin(value, true),
        "ap_channel_tools_expanded" | "ap_notify_optin" | "ap_presence_expanded" => {
            matches!(value, "0" | "1")
        }
        "ap_onboarded" => value == "1",
        "ap_desktop_updater_diagnostic" => valid_updater_diagnostic(value),
        "ap_desktop_updater_last_success" => valid_non_negative_integer(value),
        // 与 web/src/lib/desktopStorage.ts 的 validValue 对齐：更新器写入的两个版本键
        // （notified/shown），漏掉任意一个都会让整个 settings 快照校验失败并静默丢弃。
        "ap_desktop_updater_notified_version" | "ap_desktop_updater_shown_version" => {
            SAFE_VERSION_PATTERN.is_match(value)
        }
        "ap_locale" => matches!(value, "en" | "zh"),
        "ap_server_profiles_v1" => valid_server_profiles(value),
        "ap_theme" => matches!(value, "doodle" | "midnight"),
        _ => false,
    }
}

fn validate_entries(entries: &BTreeMap<String, String>) -> Result<(), String> {
    if entries.len() > MAX_ENTRIES {
        return Err("desktop UI storage snapshot has too many entries".to_string());
    }
    for (key, value) in entries {
        if !valid_value(key, value)
            || key.len() > MAX_KEY_BYTES
            || value.len() > MAX_VALUE_BYTES
            || key.bytes().any(|byte| byte.is_ascii_control())
        {
            return Err("desktop UI storage snapshot contains an invalid entry".to_string());
        }
    }
    Ok(())
}

fn ui_directory(app_data: &Path) -> Result<PathBuf, String> {
    let directory = app_data.join("ui");
    match fs::symlink_metadata(&directory) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            Err("desktop UI storage directory is unsafe".to_string())
        }
        Ok(_) => Ok(directory),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            fs::create_dir_all(&directory)
                .map_err(|_| "desktop UI storage directory is unavailable".to_string())?;
            Ok(directory)
        }
        Err(_) => Err("desktop UI storage directory is unavailable".to_string()),
    }
}

pub fn read_snapshot(app_data: &Path) -> Result<BTreeMap<String, String>, String> {
    let path = app_data.join("ui").join(SNAPSHOT_FILE);
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(BTreeMap::new()),
        Err(_) => return Err("desktop UI storage snapshot is unavailable".to_string()),
    };
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() > MAX_SNAPSHOT_BYTES
    {
        return Err("desktop UI storage snapshot is invalid".to_string());
    }
    let encoded =
        fs::read(path).map_err(|_| "desktop UI storage snapshot is unavailable".to_string())?;
    let entries: BTreeMap<String, String> = serde_json::from_slice(&encoded)
        .map_err(|_| "desktop UI storage snapshot is invalid".to_string())?;
    validate_entries(&entries)?;
    Ok(entries)
}

pub fn snapshot_exists(app_data: &Path) -> bool {
    let path = app_data.join("ui").join(SNAPSHOT_FILE);
    fs::symlink_metadata(path)
        .is_ok_and(|metadata| metadata.is_file() && !metadata.file_type().is_symlink())
}

pub fn write_snapshot(app_data: &Path, entries: &BTreeMap<String, String>) -> Result<(), String> {
    validate_entries(entries)?;
    let encoded = serde_json::to_vec(entries)
        .map_err(|_| "desktop UI storage snapshot serialization failed".to_string())?;
    if encoded.len() as u64 > MAX_SNAPSHOT_BYTES {
        return Err("desktop UI storage snapshot is too large".to_string());
    }
    let directory = ui_directory(app_data)?;
    let path = directory.join(SNAPSHOT_FILE);
    let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let temporary = directory.join(format!(
        ".{SNAPSHOT_FILE}.{}.{sequence}.tmp",
        std::process::id()
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
            .map_err(|_| "desktop UI storage snapshot is unavailable".to_string())?;
        file.write_all(&encoded)
            .and_then(|_| file.sync_all())
            .map_err(|_| "desktop UI storage snapshot write failed".to_string())?;
        replace_file(&temporary, &path)
            .map_err(|_| "desktop UI storage snapshot commit failed".to_string())?;
        sync_directory(&directory)
            .map_err(|_| "desktop UI storage directory sync failed".to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(not(windows))]
fn replace_file(source: &Path, destination: &Path) -> io::Result<()> {
    fs::rename(source, destination)
}

#[cfg(windows)]
fn replace_file(source: &Path, destination: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    if unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    } == 0
    {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn sync_directory(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    return fs::File::open(path)?.sync_all();
    #[cfg(not(unix))]
    {
        let _ = path;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use tempfile::tempdir;

    use super::{read_snapshot, write_snapshot};

    fn safe_entries() -> BTreeMap<String, String> {
        BTreeMap::from([
            ("ap_theme".to_string(), "midnight".to_string()),
            ("ap_locale".to_string(), "zh".to_string()),
            ("ap_notify_optin".to_string(), "1".to_string()),
            ("ap_onboarded".to_string(), "1".to_string()),
            ("ap_presence_expanded".to_string(), "0".to_string()),
            ("ap_channel_tools_expanded".to_string(), "1".to_string()),
            (
                "ap_desktop_updater_last_success".to_string(),
                "1720000000000".to_string(),
            ),
            (
                "ap_desktop_updater_diagnostic".to_string(),
                r#"{"status":"success","source":"manual","stage":"check","category":null,"timestamp":1720000000000,"appVersion":"0.2.94"}"#.to_string(),
            ),
            (
                "ap_desktop_updater_notified_version".to_string(),
                "0.2.130".to_string(),
            ),
            (
                "ap_desktop_updater_shown_version".to_string(),
                "0.2.130".to_string(),
            ),
            (
                "ap_active_server_origin_v1".to_string(),
                "https://private.example".to_string(),
            ),
            (
                "ap_api_base".to_string(),
                "http://localhost:8787".to_string(),
            ),
            (
                "ap_server_profiles_v1".to_string(),
                r#"[{"label":"Private","origin":"https://private.example"}]"#.to_string(),
            ),
            ("ap_seen:v1:agentparty:leo".to_string(), "42".to_string()),
            ("ap_charter_seen:agentparty".to_string(), "7".to_string()),
        ])
    }

    #[test]
    fn persists_and_reads_only_bounded_safe_preferences() {
        let root = tempdir().unwrap();
        write_snapshot(root.path(), &safe_entries()).unwrap();

        assert_eq!(read_snapshot(root.path()).unwrap(), safe_entries());
        let path = root.path().join("ui").join("storage-snapshot.json");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        assert_eq!(
            std::fs::read_dir(root.path().join("ui")).unwrap().count(),
            1
        );
    }

    #[test]
    fn rejects_tokens_sessions_pairing_state_and_oversized_values() {
        let root = tempdir().unwrap();
        for key in [
            "ap_token",
            "ap_share_token",
            "ap_oidc_session",
            "ap_agent_token_vault:v1",
            "ap_pending_pair_code",
            "unrelated",
        ] {
            let entries = BTreeMap::from([(key.to_string(), "secret".to_string())]);
            assert!(
                write_snapshot(root.path(), &entries).is_err(),
                "accepted {key}"
            );
        }
        let oversized = BTreeMap::from([("ap_theme".to_string(), "x".repeat(65 * 1024))]);
        assert!(write_snapshot(root.path(), &oversized).is_err());
        assert!(!root.path().join("ui/storage-snapshot.json").exists());
    }

    #[test]
    fn rejects_secret_looking_or_malformed_values_for_allowed_keys() {
        let root = tempdir().unwrap();
        for (key, value) in [
            ("ap_theme", "ghp_secret_access_token"),
            ("ap_locale", "en\nsecret"),
            ("ap_notify_optin", "Bearer secret-token"),
            ("ap_onboarded", "true"),
            ("ap_presence_expanded", "2"),
            ("ap_channel_tools_expanded", "yes"),
            (
                "ap_active_server_origin_v1",
                "https://token@private.example",
            ),
            ("ap_api_base", "https://private.example/api?token=secret"),
            (
                "ap_server_profiles_v1",
                r#"[{"label":"Private","origin":"https://private.example","token":"secret"}]"#,
            ),
            ("ap_server_profiles_v1", "not-json"),
            (
                "ap_server_profiles_v1",
                r#"[{"label":"","origin":"https://private.example"}]"#,
            ),
            ("ap_seen:v1:agentparty:leo", "secret-token"),
            ("ap_seen:v1:agentparty:leo", "4.2"),
            ("ap_seen:v1:agentparty:leo:ghp_secret", "42"),
            ("ap_charter_seen:agentparty", "-1"),
            ("ap_charter_seen:agentparty?token=secret", "7"),
            ("ap_desktop_updater_last_success", "NaN"),
            (
                "ap_desktop_updater_diagnostic",
                r#"{"status":"success","source":"manual","stage":"check","category":null,"timestamp":42,"appVersion":"0.2.94","token":"secret"}"#,
            ),
            (
                "ap_desktop_updater_diagnostic",
                r#"{"status":"success","source":"manual","stage":"check","category":null,"timestamp":42,"appVersion":"0.2.94","targetVersion":null}"#,
            ),
        ] {
            let entries = BTreeMap::from([(key.to_string(), value.to_string())]);
            assert!(
                write_snapshot(root.path(), &entries).is_err(),
                "accepted {key}={value}"
            );
        }
    }

    #[test]
    fn accepts_updater_notified_and_shown_version_keys_and_rejects_bad_versions() {
        let root = tempdir().unwrap();
        // 两个键必须与 TS 侧一样接受合法 semver 并原样往返，否则更新器一跑快照就全废。
        for key in [
            "ap_desktop_updater_notified_version",
            "ap_desktop_updater_shown_version",
        ] {
            for version in ["0.2.130", "1.4.0", "0.2.130-beta.1+build.7"] {
                let entries = BTreeMap::from([(key.to_string(), version.to_string())]);
                write_snapshot(root.path(), &entries).unwrap();
                assert_eq!(read_snapshot(root.path()).unwrap(), entries);
            }
            for bad in ["latest", "1.2", "1.2.3.4", "not a version", ""] {
                let entries = BTreeMap::from([(key.to_string(), bad.to_string())]);
                assert!(
                    write_snapshot(root.path(), &entries).is_err(),
                    "accepted {key}={bad}"
                );
            }
        }
    }

    #[test]
    fn rejects_corrupt_or_tampered_snapshot_files() {
        let root = tempdir().unwrap();
        std::fs::create_dir_all(root.path().join("ui")).unwrap();
        let path = root.path().join("ui/storage-snapshot.json");
        std::fs::write(&path, br#"{"ap_token":"secret"}"#).unwrap();
        assert!(read_snapshot(root.path()).is_err());
        std::fs::write(&path, vec![b'x'; 257 * 1024]).unwrap();
        assert!(read_snapshot(root.path()).is_err());
    }

    #[test]
    fn missing_snapshot_is_an_empty_restore() {
        assert!(read_snapshot(tempdir().unwrap().path()).unwrap().is_empty());
    }
}
