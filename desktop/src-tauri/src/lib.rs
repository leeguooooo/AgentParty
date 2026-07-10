use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};

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
fn credential_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(CREDENTIAL_SERVICE, CREDENTIAL_ACCOUNT)
        .map_err(|error| format!("secure credential store unavailable: {error}"))
}

#[cfg(desktop)]
#[tauri::command]
fn desktop_credential_write(credential: String) -> Result<(), String> {
    parse_stored_credential(&credential)?;
    credential_entry()?
        .set_password(&credential)
        .map_err(|error| format!("secure credential write failed: {error}"))
}

#[cfg(desktop)]
#[tauri::command]
fn desktop_credential_read() -> Result<Option<String>, String> {
    match credential_entry()?.get_password() {
        Ok(credential) => {
            parse_stored_credential(&credential)?;
            Ok(Some(credential))
        }
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(format!("secure credential read failed: {error}")),
    }
}

#[cfg(desktop)]
#[tauri::command]
fn desktop_credential_delete() -> Result<(), String> {
    match credential_entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!("secure credential delete failed: {error}")),
    }
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
    let builder = builder
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main(app);
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--hidden"]),
        ))
        .invoke_handler(tauri::generate_handler![
            desktop_credential_read,
            desktop_credential_write,
            desktop_credential_delete
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
            #[cfg(target_os = "macos")]
            if matches!(event, tauri::RunEvent::Reopen { .. }) {
                show_main(app);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::{parse_stored_credential, tray_action, ExitGuard, TrayAction};

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
}
