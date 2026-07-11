use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::Path,
    sync::atomic::{AtomicBool, AtomicU64, Ordering},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

mod agent;
pub mod ui_update;

#[cfg(desktop)]
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, WindowEvent,
};

#[cfg(any(target_os = "linux", all(debug_assertions, windows)))]
use tauri_plugin_deep_link::DeepLinkExt;

const CREDENTIAL_SERVICE: &str = "com.agentparty.desktop";
const CREDENTIAL_ACCOUNT: &str = "desktop-session";
const UPDATER_DIAGNOSTIC_FILE: &str = "updater-diagnostic.json";
static UPDATER_DIAGNOSTIC_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum UpdaterDiagnosticStatus {
    Attempt,
    Success,
    Failure,
    Pending,
}

#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum UpdaterDiagnosticSource {
    Auto,
    Manual,
}

#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum UpdaterDiagnosticStage {
    Check,
    Install,
    Relaunch,
}

#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum UpdaterDiagnosticCategory {
    Offline,
    Timeout,
    Verification,
    Install,
    Relaunch,
    Generic,
}

#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UpdaterDiagnostic {
    status: UpdaterDiagnosticStatus,
    source: Option<UpdaterDiagnosticSource>,
    stage: UpdaterDiagnosticStage,
    category: Option<UpdaterDiagnosticCategory>,
    timestamp: u64,
    app_version: Option<String>,
    target_version: Option<String>,
}

fn valid_diagnostic_version(version: &str) -> bool {
    version.len() <= 64
        && regex::Regex::new(r"^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$")
            .expect("valid updater version pattern")
            .is_match(version)
}

fn validate_updater_diagnostic(diagnostic: &UpdaterDiagnostic) -> Result<(), String> {
    if diagnostic.timestamp == 0 {
        return Err("updater diagnostic timestamp is invalid".to_string());
    }
    for version in [
        diagnostic.app_version.as_deref(),
        diagnostic.target_version.as_deref(),
    ]
    .into_iter()
    .flatten()
    {
        if !valid_diagnostic_version(version) {
            return Err("updater diagnostic version is invalid".to_string());
        }
    }
    if diagnostic.target_version.is_some() && diagnostic.stage != UpdaterDiagnosticStage::Relaunch {
        return Err("updater diagnostic target version is invalid".to_string());
    }
    match diagnostic.stage {
        UpdaterDiagnosticStage::Check if diagnostic.source.is_none() => {
            return Err("updater check diagnostic source is required".to_string());
        }
        UpdaterDiagnosticStage::Install | UpdaterDiagnosticStage::Relaunch
            if diagnostic.source.is_some() =>
        {
            return Err("updater diagnostic source is invalid".to_string());
        }
        _ => {}
    }
    match diagnostic.status {
        UpdaterDiagnosticStatus::Failure if diagnostic.category.is_none() => {
            return Err("updater failure diagnostic category is required".to_string());
        }
        UpdaterDiagnosticStatus::Attempt
        | UpdaterDiagnosticStatus::Success
        | UpdaterDiagnosticStatus::Pending
            if diagnostic.category.is_some() =>
        {
            return Err("updater diagnostic category is invalid".to_string());
        }
        _ => {}
    }
    if diagnostic.status == UpdaterDiagnosticStatus::Pending
        && (diagnostic.stage != UpdaterDiagnosticStage::Relaunch
            || diagnostic.app_version.is_none()
            || diagnostic.target_version.is_none())
    {
        return Err("pending updater receipt is incomplete".to_string());
    }
    if diagnostic.status == UpdaterDiagnosticStatus::Success
        && diagnostic.stage == UpdaterDiagnosticStage::Relaunch
        && (diagnostic.app_version.is_none() || diagnostic.app_version != diagnostic.target_version)
    {
        return Err("completed updater receipt does not match its target".to_string());
    }
    Ok(())
}

fn write_updater_diagnostic(path: &Path, diagnostic: &UpdaterDiagnostic) -> Result<(), String> {
    validate_updater_diagnostic(diagnostic)?;
    let parent = path
        .parent()
        .ok_or_else(|| "updater diagnostic path is invalid".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|_| "updater diagnostic directory is unavailable".to_string())?;
    let sequence = UPDATER_DIAGNOSTIC_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let temporary = path.with_extension(format!("json.{}.{sequence}.tmp", std::process::id()));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&temporary)
        .map_err(|_| "updater diagnostic file is unavailable".to_string())?;
    let mut encoded = serde_json::to_vec(diagnostic)
        .map_err(|_| "updater diagnostic serialization failed".to_string())?;
    encoded.push(b'\n');
    let committed = file
        .write_all(&encoded)
        .and_then(|_| file.sync_all())
        .map_err(|_| "updater diagnostic write failed".to_string())
        .and_then(|_| {
            fs::rename(&temporary, path).map_err(|_| "updater diagnostic commit failed".to_string())
        });
    if let Err(error) = committed {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    #[cfg(unix)]
    fs::File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| "updater diagnostic directory sync failed".to_string())?;
    Ok(())
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredDesktopCredential {
    refresh_token: String,
    device_secret: String,
    server_origin: String,
    session_id: Option<String>,
}

fn parse_stored_credential(input: &str) -> Result<StoredDesktopCredential, String> {
    let credential: StoredDesktopCredential = serde_json::from_str(input)
        .map_err(|_| "desktop credential has an invalid shape".to_string())?;
    if credential.refresh_token.is_empty() || credential.device_secret.is_empty() {
        return Err("desktop credential is incomplete".to_string());
    }
    let origin = url::Url::parse(&credential.server_origin)
        .map_err(|_| "desktop credential server is invalid".to_string())?;
    let local_http = origin.scheme() == "http"
        && origin.host_str().is_some_and(|host| {
            host.eq_ignore_ascii_case("localhost")
                || host
                    .parse::<std::net::IpAddr>()
                    .is_ok_and(|address| address.is_loopback())
        });
    if !matches!(origin.scheme(), "https" | "http")
        || (origin.scheme() == "http" && !local_http)
        || origin.host_str().is_none()
        || origin.username() != ""
        || origin.password().is_some()
        || origin.query().is_some()
        || origin.fragment().is_some()
        || origin.path() != "/"
    {
        return Err("desktop credential server is invalid".to_string());
    }
    Ok(credential)
}

#[cfg(desktop)]
fn credential_entry(account: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(CREDENTIAL_SERVICE, account)
        .map_err(|error| format!("secure credential store unavailable: {error}"))
}

fn credential_account_for_origin(origin: &str) -> Result<String, String> {
    let parsed =
        url::Url::parse(origin).map_err(|_| "desktop credential server is invalid".to_string())?;
    if parsed.origin().ascii_serialization() != origin {
        return Err("desktop credential server is not normalized".to_string());
    }
    let digest = Sha256::digest(origin.as_bytes());
    Ok(format!("desktop-session:{digest:x}"))
}

trait CredentialBackend {
    fn read(&self, account: &str) -> Result<Option<String>, String>;
    fn write(&self, account: &str, credential: &str) -> Result<(), String>;
    fn delete(&self, account: &str) -> Result<(), String>;
}

#[cfg(desktop)]
struct NativeCredentialBackend;

#[cfg(desktop)]
impl CredentialBackend for NativeCredentialBackend {
    fn read(&self, account: &str) -> Result<Option<String>, String> {
        match credential_entry(account)?.get_password() {
            Ok(credential) => Ok(Some(credential)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(format!("secure credential read failed: {error}")),
        }
    }

    fn write(&self, account: &str, credential: &str) -> Result<(), String> {
        credential_entry(account)?
            .set_password(credential)
            .map_err(|error| format!("secure credential write failed: {error}"))
    }

    fn delete(&self, account: &str) -> Result<(), String> {
        match credential_entry(account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(format!("secure credential delete failed: {error}")),
        }
    }
}

fn migrate_legacy_credential<B: CredentialBackend>(backend: &B) -> Result<Option<String>, String> {
    let Some(raw) = backend.read(CREDENTIAL_ACCOUNT)? else {
        return Ok(None);
    };
    let credential = parse_stored_credential(&raw)?;
    let account = credential_account_for_origin(&credential.server_origin)?;
    if backend.read(&account)?.is_none() {
        backend.write(&account, &raw)?;
    }
    backend.delete(CREDENTIAL_ACCOUNT)?;
    Ok(Some(credential.server_origin))
}

#[cfg(desktop)]
#[tauri::command]
fn desktop_credential_write(origin: String, credential: String) -> Result<(), String> {
    let parsed = parse_stored_credential(&credential)?;
    if parsed.server_origin != origin {
        return Err("desktop credential origin does not match its slot".to_string());
    }
    let account = credential_account_for_origin(&origin)?;
    NativeCredentialBackend.write(&account, &credential)
}

#[cfg(desktop)]
#[tauri::command]
fn desktop_credential_read(origin: String) -> Result<Option<String>, String> {
    let account = credential_account_for_origin(&origin)?;
    let credential = NativeCredentialBackend.read(&account)?;
    if let Some(raw) = credential.as_deref() {
        let parsed = parse_stored_credential(raw)?;
        if parsed.server_origin != origin {
            return Err("desktop credential origin does not match its slot".to_string());
        }
    }
    Ok(credential)
}

#[cfg(desktop)]
#[tauri::command]
fn desktop_credential_delete(origin: String) -> Result<(), String> {
    let account = credential_account_for_origin(&origin)?;
    NativeCredentialBackend.delete(&account)
}

#[cfg(desktop)]
#[tauri::command]
fn desktop_credential_migrate() -> Result<Option<String>, String> {
    migrate_legacy_credential(&NativeCredentialBackend)
}

#[cfg(desktop)]
#[tauri::command]
fn desktop_updater_record_diagnostic(
    app: tauri::AppHandle,
    diagnostic: UpdaterDiagnostic,
) -> Result<(), String> {
    let path = app
        .path()
        .app_data_dir()
        .map_err(|_| "desktop app data directory is unavailable".to_string())?
        .join(UPDATER_DIAGNOSTIC_FILE);
    write_updater_diagnostic(&path, &diagnostic)
}

#[derive(Debug, PartialEq, Eq)]
enum TrayAction {
    Show,
    CheckUpdates,
    Quit,
}

fn tray_action(id: &str) -> Option<TrayAction> {
    match id {
        "show" => Some(TrayAction::Show),
        "check-updates" => Some(TrayAction::CheckUpdates),
        "quit" => Some(TrayAction::Quit),
        _ => None,
    }
}

#[derive(Default)]
struct ExitGuard(AtomicBool);

impl ExitGuard {
    fn begin_quit(&self) {
        self.0.store(true, Ordering::Release);
    }

    fn is_quitting(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }
}

#[cfg(desktop)]
fn show_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg(desktop)]
#[tauri::command]
fn desktop_ui_ready(app: tauri::AppHandle, build_id: String, ui_abi: u32) -> Result<(), String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|_| "desktop UI data directory is unavailable".to_string())?;
    ui_update::UiUpdateStore::new(app_data)
        .mark_ready(&build_id, ui_abi)
        .map_err(|_| "desktop UI ready receipt was rejected".to_string())
}

#[cfg(desktop)]
fn install_tray(app: &tauri::App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show AgentParty", true, None::<&str>)?;
    let check_updates = MenuItem::with_id(
        app,
        "check-updates",
        "Check for Updates...",
        true,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "quit", "Quit AgentParty", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &check_updates, &quit])?;

    let mut tray = TrayIconBuilder::new()
        .tooltip("AgentParty")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match tray_action(event.id.as_ref()) {
            Some(TrayAction::Show) => show_main(app),
            Some(TrayAction::CheckUpdates) => {
                show_main(app);
                let _ = app.emit("agentparty://check-for-updates", ());
            }
            Some(TrayAction::Quit) => {
                app.state::<ExitGuard>().begin_quit();
                app.exit(0);
            }
            None => {}
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                show_main(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default().manage(ExitGuard::default());

    #[cfg(desktop)]
    let builder = builder.manage(agent::AgentManager::default());

    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main(app);
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--hidden"]),
        ))
        .invoke_handler(tauri::generate_handler![
            desktop_credential_read,
            desktop_credential_write,
            desktop_credential_delete,
            desktop_credential_migrate,
            desktop_updater_record_diagnostic,
            desktop_ui_ready,
            agent::desktop_agent_list_configs,
            agent::desktop_agent_status,
            agent::desktop_agent_start,
            agent::desktop_agent_stop,
            agent::desktop_agent_logs
        ]);

    #[cfg(mobile)]
    let builder = builder
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init());

    builder
        .setup(|app| {
            #[cfg(desktop)]
            {
                install_tray(app)?;
                #[cfg(any(target_os = "linux", all(debug_assertions, windows)))]
                app.deep_link().register_all()?;
                if !std::env::args().any(|arg| arg == "--hidden") {
                    show_main(app.handle());
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            #[cfg(desktop)]
            if window.label() == "main" && !window.app_handle().state::<ExitGuard>().is_quitting() {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building AgentParty desktop")
        .run(|app, event| {
            #[cfg(desktop)]
            if matches!(
                &event,
                tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }
            ) {
                app.state::<agent::AgentManager>().kill_on_exit();
            }
            #[cfg(target_os = "macos")]
            if matches!(&event, tauri::RunEvent::Reopen { .. }) {
                show_main(app);
            }
        });
}

#[cfg(test)]
mod tests {
    use std::{cell::RefCell, collections::HashMap};

    use base64::{engine::general_purpose::STANDARD, Engine};
    use minisign_verify::{PublicKey, Signature};
    use tempfile::TempDir;

    use super::{
        credential_account_for_origin, migrate_legacy_credential, parse_stored_credential,
        tray_action, validate_updater_diagnostic, write_updater_diagnostic, CredentialBackend,
        ExitGuard, TrayAction, UpdaterDiagnostic, UpdaterDiagnosticCategory,
        UpdaterDiagnosticStage, UpdaterDiagnosticStatus, CREDENTIAL_ACCOUNT,
    };

    fn pending_updater_receipt() -> UpdaterDiagnostic {
        UpdaterDiagnostic {
            status: UpdaterDiagnosticStatus::Pending,
            source: None,
            stage: UpdaterDiagnosticStage::Relaunch,
            category: None,
            timestamp: 123_456,
            app_version: Some("0.2.90".to_string()),
            target_version: Some("0.2.91".to_string()),
        }
    }

    #[test]
    fn updater_diagnostic_rejects_unknown_or_inconsistent_fields() {
        let raw = r#"{
            "status":"failure",
            "source":null,
            "stage":"relaunch",
            "category":"verification",
            "timestamp":123456,
            "appVersion":"0.2.90",
            "targetVersion":"0.2.91",
            "rawError":"token=must-not-persist"
        }"#;
        assert!(serde_json::from_str::<UpdaterDiagnostic>(raw).is_err());

        let mut diagnostic = pending_updater_receipt();
        diagnostic.category = Some(UpdaterDiagnosticCategory::Verification);
        assert!(validate_updater_diagnostic(&diagnostic).is_err());
        diagnostic.category = None;
        diagnostic.target_version = Some("../../secret".to_string());
        assert!(validate_updater_diagnostic(&diagnostic).is_err());
    }

    #[test]
    fn updater_diagnostic_is_atomically_persisted_without_a_temp_file() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("updater-diagnostic.json");
        let diagnostic = pending_updater_receipt();

        write_updater_diagnostic(&path, &diagnostic).unwrap();

        let stored: UpdaterDiagnostic =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(stored, diagnostic);
        assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 1);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }

    #[derive(Default)]
    struct MemoryCredentials(RefCell<HashMap<String, String>>);

    impl CredentialBackend for MemoryCredentials {
        fn read(&self, account: &str) -> Result<Option<String>, String> {
            Ok(self.0.borrow().get(account).cloned())
        }

        fn write(&self, account: &str, credential: &str) -> Result<(), String> {
            self.0
                .borrow_mut()
                .insert(account.to_string(), credential.to_string());
            Ok(())
        }

        fn delete(&self, account: &str) -> Result<(), String> {
            self.0.borrow_mut().remove(account);
            Ok(())
        }
    }

    #[test]
    fn maps_known_tray_actions() {
        assert_eq!(tray_action("show"), Some(TrayAction::Show));
        assert_eq!(tray_action("check-updates"), Some(TrayAction::CheckUpdates));
        assert_eq!(tray_action("quit"), Some(TrayAction::Quit));
        assert_eq!(tray_action("unknown"), None);
    }

    #[test]
    fn exit_guard_only_allows_explicit_quit() {
        let guard = ExitGuard::default();
        assert!(!guard.is_quitting());

        guard.begin_quit();
        assert!(guard.is_quitting());
    }

    #[test]
    fn configured_updater_key_verifies_the_v2_probe() {
        const PROBE: &[u8] = b"AgentParty updater v2 key probe\n";
        const PROBE_SIGNATURE_B64: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVTaFhBUlJFam9nMURVUGRiTDRXRTVTUU44amViWVhJUGQvNVRxN09ZK01reFc3aldyZzNNeTk4WmZ3Z2J6Wkp1RmxyZUtKOG5BdHo4cmxXaWRYYzhpOGpKNTVDN3RNZ1FVPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzgzNjk5NTgwCWZpbGU6dG1wLjNpNHNNUHZQZU4KVSt6YnFHSk1pUEs3cnFCSUZ3MW53cDkrNVBGTHMxMWU4Z3hXM1dqVjE5Y3lrWCt5OE1MMWhzVlk0WVdZbjZUYXBqRk9vdlJSTTBwSHdpQkJWNWlzRFE9PQo=";

        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).expect("valid Tauri config");
        let encoded_public_key = config["plugins"]["updater"]["pubkey"]
            .as_str()
            .expect("configured updater public key");
        let public_key_text = String::from_utf8(
            STANDARD
                .decode(encoded_public_key)
                .expect("base64-encoded updater public key"),
        )
        .expect("UTF-8 minisign public key");
        let public_key = PublicKey::decode(&public_key_text).expect("parseable updater public key");

        let signature_text = String::from_utf8(
            STANDARD
                .decode(PROBE_SIGNATURE_B64)
                .expect("base64-encoded updater signature"),
        )
        .expect("UTF-8 minisign signature");
        let signature = Signature::decode(&signature_text).expect("parseable updater signature");

        public_key
            .verify(PROBE, &signature, false)
            .expect("v2 updater key verifies its probe signature");
    }

    #[test]
    fn accepts_only_the_refresh_and_device_credential_shape() {
        let credential = parse_stored_credential(
            r#"{"refreshToken":"refresh","deviceSecret":"device-secret","serverOrigin":"https://agentparty.leeguoo.com","sessionId":"session-1"}"#,
        )
        .expect("valid desktop credential");

        assert_eq!(credential.refresh_token, "refresh");
        assert_eq!(credential.device_secret, "device-secret");
        assert_eq!(credential.server_origin, "https://agentparty.leeguoo.com");
        assert_eq!(credential.session_id.as_deref(), Some("session-1"));
    }

    #[test]
    fn rejects_access_tokens_and_incomplete_credentials_before_keyring_io() {
        assert!(parse_stored_credential(
            r#"{"refreshToken":"refresh","deviceSecret":"device-secret","serverOrigin":"https://agentparty.leeguoo.com","sessionId":null,"accessToken":"must-not-persist"}"#,
        )
        .is_err());
        assert!(parse_stored_credential(
            r#"{"refreshToken":"refresh","serverOrigin":"https://agentparty.leeguoo.com","sessionId":null}"#,
        )
        .is_err());
        assert!(parse_stored_credential(
            r#"{"refreshToken":"refresh","deviceSecret":"device-secret","serverOrigin":"http://evil.example","sessionId":null}"#,
        )
        .is_err());
    }

    #[test]
    fn derives_a_stable_sha256_account_from_the_origin() {
        assert_eq!(
            credential_account_for_origin("https://agentparty.leeguoo.com").unwrap(),
            "desktop-session:a54553e56c5db33ab39807028be8b3c039c7694a6382d1520644c72dc63918be"
        );
    }

    #[test]
    fn migrates_the_legacy_slot_once_and_removes_it() {
        let store = MemoryCredentials::default();
        let credential = r#"{"refreshToken":"refresh","deviceSecret":"device-secret","serverOrigin":"https://party.example.com","sessionId":null}"#;
        store.write(CREDENTIAL_ACCOUNT, credential).unwrap();

        assert_eq!(
            migrate_legacy_credential(&store).unwrap().as_deref(),
            Some("https://party.example.com")
        );
        let account = credential_account_for_origin("https://party.example.com").unwrap();
        assert_eq!(store.read(&account).unwrap().as_deref(), Some(credential));
        assert_eq!(store.read(CREDENTIAL_ACCOUNT).unwrap(), None);
        assert_eq!(migrate_legacy_credential(&store).unwrap(), None);
    }
}
