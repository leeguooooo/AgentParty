use std::{
    collections::{HashSet, VecDeque},
    env, fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};

use regex::Regex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[cfg(desktop)]
use tauri::{AppHandle, State};
#[cfg(desktop)]
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};

const LOG_CAPACITY: usize = 500;
const LOG_LINE_BYTES: usize = 2_048;
const ERROR_BYTES: usize = 512;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentConfigSummary {
    pub(crate) config_id: String,
    pub(crate) name: String,
    pub(crate) server_origin: String,
    pub(crate) channel: Option<String>,
    pub(crate) kind: String,
    pub(crate) role: String,
}

#[derive(Debug, Deserialize)]
struct AgentConfig {
    server: String,
    token: String,
    identity: Option<AgentIdentity>,
}

#[derive(Debug, Deserialize)]
struct AgentIdentity {
    name: Option<String>,
    kind: Option<String>,
    role: Option<String>,
    channel_scope: Option<String>,
}

#[derive(Debug, Clone, Copy, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum AgentPhase {
    #[default]
    Stopped,
    Starting,
    Running,
    Stopping,
    Failed,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentRuntime {
    #[serde(rename = "state")]
    pub(crate) phase: AgentPhase,
    pub(crate) pid: Option<u32>,
    pub(crate) config_id: Option<String>,
    pub(crate) name: Option<String>,
    pub(crate) channel: Option<String>,
    pub(crate) runner: Option<String>,
    pub(crate) started_at: Option<u64>,
    pub(crate) exit_code: Option<i32>,
    pub(crate) last_error: Option<String>,
}

impl AgentRuntime {
    fn begin_start(&mut self, config_id: &str, name: &str, channel: &str, runner: &str) {
        self.phase = AgentPhase::Starting;
        self.pid = None;
        self.config_id = Some(config_id.to_string());
        self.name = Some(name.to_string());
        self.channel = Some(channel.to_string());
        self.runner = Some(runner.to_string());
        self.started_at = Some(now_millis());
        self.exit_code = None;
        self.last_error = None;
    }

    fn mark_running(&mut self, pid: u32) {
        self.phase = AgentPhase::Running;
        self.pid = Some(pid);
    }

    fn mark_exited(&mut self, exit_code: Option<i32>, error: Option<&str>) {
        self.pid = None;
        self.exit_code = exit_code;
        if exit_code == Some(0) && error.is_none() {
            self.phase = AgentPhase::Stopped;
            self.last_error = None;
        } else {
            self.phase = AgentPhase::Failed;
            self.last_error = error.map(|value| bound_text(&redact_line(value), ERROR_BYTES));
            if self.last_error.is_none() {
                self.last_error = Some(match exit_code {
                    Some(code) => format!("party sidecar exited with code {code}"),
                    None => "party sidecar exited unexpectedly".to_string(),
                });
            }
        }
    }

    fn mark_stopped(&mut self) {
        *self = Self::default();
    }
}

#[cfg(desktop)]
#[derive(Default)]
struct ManagedAgent {
    runtime: AgentRuntime,
    child: Option<CommandChild>,
    logs: VecDeque<String>,
    generation: u64,
    stop_requested: bool,
}

#[cfg(desktop)]
#[derive(Clone, Default)]
pub(crate) struct AgentManager(Arc<Mutex<ManagedAgent>>);

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn agentparty_home() -> Result<PathBuf, String> {
    if let Some(home) = env::var_os("AGENTPARTY_HOME") {
        return Ok(PathBuf::from(home));
    }
    env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .map(|home| PathBuf::from(home).join(".agentparty"))
        .ok_or_else(|| "cannot locate the AgentParty config directory".to_string())
}

fn candidate_config_paths(home: &Path) -> Vec<PathBuf> {
    let mut paths = vec![home.join("config.json")];
    if let Ok(entries) = fs::read_dir(home.join("state")) {
        for entry in entries.flatten() {
            if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                paths.push(entry.path().join("config.json"));
            }
        }
    }
    paths
}

fn trusted_configs(home: &Path) -> Result<Vec<(PathBuf, AgentConfigSummary)>, String> {
    if !home.exists() {
        return Ok(Vec::new());
    }
    let canonical_home = home
        .canonicalize()
        .map_err(|_| "AgentParty config directory is unavailable".to_string())?;
    let mut seen = HashSet::new();
    let mut seen_identities = HashSet::new();
    let mut configs = Vec::new();
    for candidate in candidate_config_paths(home) {
        let Ok(canonical) = candidate.canonicalize() else {
            continue;
        };
        if !canonical.starts_with(&canonical_home) || !seen.insert(canonical.clone()) {
            continue;
        }
        if let Ok(summary) = parse_config_summary(&canonical) {
            let Some(identity_key) = config_identity_key(&canonical, &summary.server_origin) else {
                continue;
            };
            if !seen_identities.insert(identity_key) {
                continue;
            }
            configs.push((canonical, summary));
        }
    }
    configs.sort_by(|left, right| {
        left.1
            .name
            .cmp(&right.1.name)
            .then_with(|| left.1.config_id.cmp(&right.1.config_id))
    });
    Ok(configs)
}

fn config_identity_key(path: &Path, server_origin: &str) -> Option<String> {
    let raw = fs::read_to_string(path).ok()?;
    let config: AgentConfig = serde_json::from_str(&raw).ok()?;
    if !config.token.starts_with("ap_") || config.token.len() <= 3 {
        return None;
    }
    Some(format!(
        "{}:{:x}",
        server_origin,
        Sha256::digest(config.token.as_bytes())
    ))
}

pub(crate) fn config_id(path: &Path) -> Result<String, String> {
    let canonical = path
        .canonicalize()
        .map_err(|_| "AgentParty config path is unavailable".to_string())?;
    Ok(format!(
        "{:x}",
        Sha256::digest(canonical.as_os_str().as_encoded_bytes())
    ))
}

pub(crate) fn parse_config_summary(path: &Path) -> Result<AgentConfigSummary, String> {
    let raw =
        fs::read_to_string(path).map_err(|_| "AgentParty config is unreadable".to_string())?;
    let config: AgentConfig =
        serde_json::from_str(&raw).map_err(|_| "AgentParty config is invalid".to_string())?;
    if !config.token.starts_with("ap_") || config.token.len() <= 3 {
        return Err("AgentParty config does not contain an agent token".to_string());
    }
    let parsed = url::Url::parse(&config.server)
        .map_err(|_| "AgentParty config server is invalid".to_string())?;
    let local_http = parsed.scheme() == "http"
        && parsed.host_str().is_some_and(|host| {
            host.eq_ignore_ascii_case("localhost")
                || host
                    .parse::<std::net::IpAddr>()
                    .is_ok_and(|address| address.is_loopback())
        });
    if !matches!(parsed.scheme(), "http" | "https")
        || (parsed.scheme() == "http" && !local_http)
        || parsed.host_str().is_none()
        || parsed.username() != ""
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || parsed.path() != "/"
    {
        return Err("AgentParty config server is invalid".to_string());
    }
    let identity = config
        .identity
        .ok_or_else(|| "AgentParty config identity is not cached".to_string())?;
    let kind = identity
        .kind
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "AgentParty config identity kind is missing".to_string())?;
    let role = identity
        .role
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "AgentParty config identity role is missing".to_string())?;
    if kind != "agent" || role != "agent" {
        return Err("AgentParty config is not an agent identity".to_string());
    }
    let name = identity
        .name
        .filter(|name| !name.trim().is_empty())
        .ok_or_else(|| "AgentParty config identity name is missing".to_string())?;

    Ok(AgentConfigSummary {
        config_id: config_id(path)?,
        name,
        server_origin: parsed.origin().ascii_serialization(),
        channel: identity.channel_scope,
        kind,
        role,
    })
}

fn resolve_config(config_id: &str) -> Result<(PathBuf, AgentConfigSummary), String> {
    trusted_configs(&agentparty_home()?)?
        .into_iter()
        .find(|(_, summary)| summary.config_id == config_id)
        .ok_or_else(|| "unknown AgentParty config ID".to_string())
}

pub(crate) fn validate_channel(channel: &str) -> Result<&str, String> {
    let bytes = channel.as_bytes();
    let first_valid = bytes
        .first()
        .is_some_and(|value| value.is_ascii_lowercase() || value.is_ascii_digit());
    let all_valid = bytes
        .iter()
        .all(|value| value.is_ascii_lowercase() || value.is_ascii_digit() || *value == b'-');
    if !(1..=64).contains(&bytes.len()) || !first_valid || !all_valid {
        return Err("channel must be a valid slug".to_string());
    }
    Ok(channel)
}

pub(crate) fn validate_runner(runner: &str) -> Result<&str, String> {
    match runner {
        "codex" | "claude" | "codex-sdk" => Ok(runner),
        _ => Err("runner must be codex, claude, or codex-sdk".to_string()),
    }
}

fn redaction_patterns() -> &'static (Regex, Regex) {
    static PATTERNS: OnceLock<(Regex, Regex)> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        (
            Regex::new(r#"(?i)(bearer\s+)[^\s,;\"']+"#)
                .expect("valid bearer redaction regex"),
            Regex::new(
                r#"(?i)(\"?(?:access[_-]?token|refresh[_-]?token|token|device[_-]?secret|authorization)\"?\s*[:=]\s*\"?)[^\"'\s,;]+"#,
            )
            .expect("valid key redaction regex"),
        )
    })
}

pub(crate) fn redact_line(line: &str) -> String {
    redact_line_with_secrets(line, &[])
}

fn redact_line_with_secrets(line: &str, secrets: &[String]) -> String {
    let mut redacted = line.to_string();
    for secret in secrets.iter().filter(|value| !value.is_empty()) {
        redacted = redacted.replace(secret, "[REDACTED]");
    }
    let (bearer, keyed) = redaction_patterns();
    let redacted = bearer.replace_all(&redacted, "$1[REDACTED]");
    let redacted = keyed.replace_all(&redacted, "$1[REDACTED]");
    bound_text(&redacted, LOG_LINE_BYTES)
}

fn bound_text(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_string();
    }
    let mut end = max_bytes;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}...", &value[..end])
}

fn config_secrets(path: &Path) -> Vec<String> {
    let mut secrets = Vec::new();
    if let Ok(canonical) = path.canonicalize() {
        secrets.push(canonical.to_string_lossy().into_owned());
    }
    let Ok(raw) = fs::read_to_string(path) else {
        return secrets;
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return secrets;
    };
    secrets.extend(
        [
            "token",
            "accessToken",
            "access_token",
            "refreshToken",
            "refresh_token",
        ]
        .into_iter()
        .filter_map(|key| value.get(key).and_then(serde_json::Value::as_str))
        .filter(|value| !value.is_empty())
        .map(str::to_string),
    );
    secrets
}

fn push_bounded_log(logs: &mut VecDeque<String>, line: String) {
    if logs.len() == LOG_CAPACITY {
        logs.pop_front();
    }
    logs.push_back(line);
}

#[cfg(desktop)]
impl AgentManager {
    fn lock(&self) -> Result<std::sync::MutexGuard<'_, ManagedAgent>, String> {
        self.0
            .lock()
            .map_err(|_| "desktop agent state is unavailable".to_string())
    }

    fn push_log(agent: &mut ManagedAgent, line: String) {
        push_bounded_log(&mut agent.logs, line);
    }

    async fn stop(&self) -> Result<AgentRuntime, String> {
        let child = {
            let mut agent = self.lock()?;
            let child = agent.child.take();
            if child.is_none() {
                agent.runtime.mark_stopped();
                return Ok(agent.runtime.clone());
            }
            agent.stop_requested = true;
            agent.runtime.phase = AgentPhase::Stopping;
            child
        };

        let kill_error = child.and_then(|child| child.kill().err());
        if let Some(error) = kill_error {
            let mut agent = self.lock()?;
            agent.stop_requested = false;
            if agent.runtime.phase == AgentPhase::Stopping {
                let message = redact_line(&format!("failed to stop party sidecar: {error}"));
                agent.runtime.mark_exited(None, Some(&message));
                Self::push_log(&mut agent, message);
            }
            return Ok(agent.runtime.clone());
        }

        for _ in 0..80 {
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
            let agent = self.lock()?;
            if agent.runtime.phase != AgentPhase::Stopping {
                return Ok(agent.runtime.clone());
            }
        }

        let mut agent = self.lock()?;
        if agent.runtime.phase == AgentPhase::Stopping {
            agent.stop_requested = false;
            agent.runtime.mark_exited(
                None,
                Some("party sidecar did not exit within the stop timeout"),
            );
            Self::push_log(
                &mut agent,
                "party sidecar did not exit within the stop timeout".to_string(),
            );
        }
        Ok(agent.runtime.clone())
    }

    pub(crate) fn kill_on_exit(&self) {
        if let Ok(mut agent) = self.0.lock() {
            agent.generation = agent.generation.wrapping_add(1);
            if let Some(child) = agent.child.take() {
                let _ = child.kill();
            }
            agent.runtime.mark_stopped();
            agent.stop_requested = false;
        }
    }
}

#[cfg(desktop)]
#[tauri::command]
pub(crate) fn desktop_agent_list_configs() -> Result<Vec<AgentConfigSummary>, String> {
    Ok(trusted_configs(&agentparty_home()?)?
        .into_iter()
        .map(|(_, summary)| summary)
        .collect())
}

#[cfg(desktop)]
#[tauri::command]
pub(crate) fn desktop_agent_status(state: State<'_, AgentManager>) -> Result<AgentRuntime, String> {
    Ok(state.lock()?.runtime.clone())
}

#[cfg(desktop)]
#[tauri::command]
pub(crate) fn desktop_agent_logs(state: State<'_, AgentManager>) -> Result<Vec<String>, String> {
    Ok(state.lock()?.logs.iter().cloned().collect())
}

#[cfg(desktop)]
#[tauri::command]
pub(crate) async fn desktop_agent_stop(
    state: State<'_, AgentManager>,
) -> Result<AgentRuntime, String> {
    state.stop().await
}

#[cfg(desktop)]
#[tauri::command]
pub(crate) fn desktop_agent_start(
    app: AppHandle,
    state: State<'_, AgentManager>,
    config_id: String,
    channel: String,
    runner: String,
) -> Result<AgentRuntime, String> {
    validate_channel(&channel)?;
    validate_runner(&runner)?;
    let (config_path, summary) = resolve_config(&config_id)?;
    let secrets = config_secrets(&config_path);

    let generation = {
        let mut agent = state.lock()?;
        if matches!(
            agent.runtime.phase,
            AgentPhase::Starting | AgentPhase::Running
        ) {
            return Err("a desktop agent is already running".to_string());
        }
        agent.generation = agent.generation.wrapping_add(1);
        agent.logs.clear();
        agent.stop_requested = false;
        agent
            .runtime
            .begin_start(&config_id, &summary.name, &channel, &runner);
        agent.generation
    };

    let spawn_result = app.shell().sidecar("party").and_then(|command| {
        command
            .args(["serve", channel.as_str(), "--runner", runner.as_str()])
            .env("AGENTPARTY_CONFIG", &config_path)
            .spawn()
    });

    let (mut events, child) = match spawn_result {
        Ok(value) => value,
        Err(error) => {
            let message = redact_line_with_secrets(
                &format!("failed to start party sidecar: {error}"),
                &secrets,
            );
            let mut agent = state.lock()?;
            if agent.generation == generation {
                agent.runtime.mark_exited(None, Some(&message));
                AgentManager::push_log(&mut agent, message);
            }
            return Ok(agent.runtime.clone());
        }
    };

    let pid = child.pid();
    {
        let mut agent = state.lock()?;
        if agent.generation != generation {
            let _ = child.kill();
            return Err("desktop agent start was cancelled".to_string());
        }
        agent.child = Some(child);
        agent.runtime.mark_running(pid);
        AgentManager::push_log(&mut agent, format!("party sidecar started (pid {pid})"));
    }

    let manager = state.inner().clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = events.recv().await {
            let mut agent = match manager.lock() {
                Ok(agent) => agent,
                Err(_) => return,
            };
            if agent.generation != generation {
                return;
            }
            match event {
                CommandEvent::Stdout(bytes) | CommandEvent::Stderr(bytes) => {
                    for line in String::from_utf8_lossy(&bytes).lines() {
                        AgentManager::push_log(
                            &mut agent,
                            redact_line_with_secrets(line, &secrets),
                        );
                    }
                }
                CommandEvent::Error(error) => {
                    let message = redact_line_with_secrets(&error, &secrets);
                    agent.runtime.last_error = Some(bound_text(&message, ERROR_BYTES));
                    AgentManager::push_log(&mut agent, message);
                }
                CommandEvent::Terminated(payload) => {
                    agent.child = None;
                    let requested = agent.stop_requested;
                    agent.stop_requested = false;
                    let message = if requested {
                        agent.runtime.mark_stopped();
                        "party sidecar stopped".to_string()
                    } else {
                        let prior_error = agent.runtime.last_error.clone();
                        agent
                            .runtime
                            .mark_exited(payload.code, prior_error.as_deref());
                        match payload.code {
                            Some(code) => format!("party sidecar exited (code {code})"),
                            None => "party sidecar exited".to_string(),
                        }
                    };
                    AgentManager::push_log(&mut agent, message);
                    return;
                }
                _ => {}
            }
        }
        if let Ok(mut agent) = manager.lock() {
            if agent.generation == generation
                && matches!(
                    agent.runtime.phase,
                    AgentPhase::Running | AgentPhase::Stopping
                )
            {
                agent.child = None;
                if agent.stop_requested {
                    agent.stop_requested = false;
                    agent.runtime.mark_stopped();
                    AgentManager::push_log(&mut agent, "party sidecar stopped".to_string());
                } else {
                    agent
                        .runtime
                        .mark_exited(None, Some("party sidecar event stream closed unexpectedly"));
                    AgentManager::push_log(
                        &mut agent,
                        "party sidecar event stream closed unexpectedly".to_string(),
                    );
                }
            }
        }
    });

    Ok(state.lock()?.runtime.clone())
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::TempDir;

    use super::{
        config_id, config_secrets, parse_config_summary, push_bounded_log, redact_line,
        redact_line_with_secrets, trusted_configs, validate_channel, validate_runner, AgentPhase,
        AgentRuntime, LOG_CAPACITY,
    };

    #[test]
    fn config_summary_uses_canonical_path_id_and_never_serializes_token() {
        let temp = TempDir::new().unwrap();
        let config_path = temp.path().join("config.json");
        fs::write(
            &config_path,
            r#"{
                "server":"https://party.example.com",
                "token":"ap_super-secret-token",
                "identity":{
                    "name":"worker-one",
                    "kind":"agent",
                    "role":"agent",
                    "channel_scope":"native-r4"
                }
            }"#,
        )
        .unwrap();

        let summary = parse_config_summary(&config_path).unwrap();
        assert_eq!(summary.config_id, config_id(&config_path).unwrap());
        assert_eq!(summary.name, "worker-one");
        assert_eq!(summary.server_origin, "https://party.example.com");
        assert_eq!(summary.channel.as_deref(), Some("native-r4"));
        assert_eq!(summary.kind, "agent");
        assert_eq!(summary.role, "agent");

        let serialized = serde_json::to_string(&summary).unwrap();
        assert!(!serialized.contains("super-secret-token"));
        assert!(!serialized.to_ascii_lowercase().contains("token"));
        let serialized: serde_json::Value = serde_json::from_str(&serialized).unwrap();
        assert!(serialized["kind"].is_string());
        assert!(serialized["role"].is_string());
    }

    #[test]
    fn config_id_changes_with_the_canonical_path_not_file_contents() {
        let temp = TempDir::new().unwrap();
        let first = temp.path().join("first.json");
        let second = temp.path().join("second.json");
        fs::write(&first, "{}").unwrap();
        fs::write(&second, "{}").unwrap();

        let first_id = config_id(&first).unwrap();
        fs::write(&first, r#"{"token":"changed"}"#).unwrap();
        assert_eq!(config_id(&first).unwrap(), first_id);
        assert_ne!(config_id(&second).unwrap(), first_id);
        assert_eq!(first_id.len(), 64);
    }

    #[test]
    fn config_summary_rejects_missing_or_non_agent_cached_identity() {
        let temp = TempDir::new().unwrap();
        let config_path = temp.path().join("config.json");
        fs::write(
            &config_path,
            r#"{"server":"https://party.example.com","token":"ap_secret"}"#,
        )
        .unwrap();

        assert!(parse_config_summary(&config_path).is_err());
        fs::write(
            &config_path,
            r#"{
                "server":"https://party.example.com",
                "token":"ap_secret",
                "identity":{"name":"human","kind":"human","role":"member"}
            }"#,
        )
        .unwrap();
        assert!(parse_config_summary(&config_path).is_err());
    }

    #[test]
    fn config_summary_rejects_remote_plaintext_http_but_allows_loopback() {
        let temp = TempDir::new().unwrap();
        let config_path = temp.path().join("config.json");
        let write = |server: &str| {
            fs::write(
                &config_path,
                format!(
                    r#"{{"server":"{server}","token":"ap_secret","identity":{{"name":"worker","kind":"agent","role":"agent"}}}}"#
                ),
            )
            .unwrap();
        };

        write("http://party.example.com");
        assert!(parse_config_summary(&config_path).is_err());
        write("http://127.0.0.1:8787");
        assert!(parse_config_summary(&config_path).is_ok());
        write("https://party.example.com");
        assert!(parse_config_summary(&config_path).is_ok());
    }

    #[test]
    fn validates_channel_slugs_and_runner_allowlist() {
        for channel in ["agentparty", "native-r4", "team2"] {
            assert_eq!(validate_channel(channel).unwrap(), channel);
        }
        for channel in ["", "-bad", "bad/slug", "space here", &"a".repeat(65)] {
            assert!(validate_channel(channel).is_err(), "accepted {channel:?}");
        }
        assert!(validate_channel("bad.slug").is_err());
        assert!(validate_channel("bad_slug").is_err());

        for runner in ["codex", "claude", "codex-sdk"] {
            assert_eq!(validate_runner(runner).unwrap(), runner);
        }
        assert!(validate_runner("sh").is_err());
        assert!(validate_runner("codex --dangerously-bypass").is_err());
    }

    #[test]
    fn redacts_secrets_and_bounds_each_log_line() {
        let redacted = redact_line(
            "Authorization: Bearer abc.def token=secret refresh_token=refresh deviceSecret=device",
        );
        assert!(!redacted.contains("abc.def"));
        assert!(!redacted.contains("secret"));
        assert!(!redacted.contains("=refresh"));
        assert!(!redacted.contains("=device"));
        assert!(redacted.contains("[REDACTED]"));

        let bounded = redact_line(&"x".repeat(10_000));
        assert!(bounded.len() <= 2_051);
    }

    #[test]
    fn native_redaction_hides_the_canonical_config_path() {
        let temp = TempDir::new().unwrap();
        let config_path = temp.path().join("config.json");
        fs::write(
            &config_path,
            r#"{"server":"https://party.example.com","token":"ap_secret"}"#,
        )
        .unwrap();
        let canonical = config_path.canonicalize().unwrap();
        let redacted = redact_line_with_secrets(
            &format!("failed to read AGENTPARTY_CONFIG={}", canonical.display()),
            &config_secrets(&config_path),
        );

        assert!(!redacted.contains(canonical.to_string_lossy().as_ref()));
        assert!(redacted.contains("[REDACTED]"));
    }

    #[test]
    fn trusted_scan_rejects_missing_or_empty_tokens() {
        let temp = TempDir::new().unwrap();
        fs::write(
            temp.path().join("config.json"),
            r#"{"server":"https://party.example.com","token":""}"#,
        )
        .unwrap();
        let state = temp.path().join("state").join("workspace");
        fs::create_dir_all(&state).unwrap();
        fs::write(
            state.join("config.json"),
            r#"{"server":"https://party.example.com"}"#,
        )
        .unwrap();

        assert!(trusted_configs(temp.path()).unwrap().is_empty());
    }

    #[test]
    fn trusted_scan_deduplicates_cli_global_and_workspace_copies() {
        let temp = TempDir::new().unwrap();
        let body = r#"{
            "server":"https://party.example.com",
            "token":"ap_same-agent",
            "identity":{"name":"worker","kind":"agent","role":"agent","channel_scope":"team"}
        }"#;
        fs::write(temp.path().join("config.json"), body).unwrap();
        let state = temp.path().join("state").join("workspace");
        fs::create_dir_all(&state).unwrap();
        fs::write(state.join("config.json"), body).unwrap();

        let configs = trusted_configs(temp.path()).unwrap();
        assert_eq!(configs.len(), 1);
        assert_eq!(
            configs[0].0,
            temp.path().join("config.json").canonicalize().unwrap()
        );
    }

    #[test]
    fn trusted_scan_treats_a_missing_agentparty_home_as_empty() {
        let temp = TempDir::new().unwrap();
        assert!(trusted_configs(&temp.path().join("not-created"))
            .unwrap()
            .is_empty());
    }

    #[test]
    fn runtime_transitions_start_run_fail_and_stop() {
        let mut runtime = AgentRuntime::default();
        assert_eq!(runtime.phase, AgentPhase::Stopped);

        runtime.begin_start("config-id", "worker", "native-r4", "codex");
        assert_eq!(runtime.phase, AgentPhase::Starting);
        let serialized = serde_json::to_value(&runtime).unwrap();
        assert_eq!(serialized["state"], "starting");
        assert!(serialized.get("status").is_none());
        assert!(serialized.get("phase").is_none());
        runtime.mark_running(42);
        assert_eq!(runtime.phase, AgentPhase::Running);
        assert_eq!(runtime.pid, Some(42));

        runtime.mark_exited(Some(7), Some("token=must-not-leak"));
        assert_eq!(runtime.phase, AgentPhase::Failed);
        assert_eq!(runtime.exit_code, Some(7));
        assert!(!runtime
            .last_error
            .as_deref()
            .unwrap()
            .contains("must-not-leak"));

        runtime.mark_stopped();
        assert_eq!(runtime.phase, AgentPhase::Stopped);
        assert_eq!(runtime.pid, None);
        assert_eq!(runtime.exit_code, None);
        assert_eq!(runtime.last_error, None);

        let serialized = serde_json::to_value(&runtime).unwrap();
        assert_eq!(serialized["state"], "stopped");
        assert!(serialized.get("status").is_none());
    }

    #[test]
    fn log_buffer_evicts_oldest_lines_at_capacity() {
        let mut logs = std::collections::VecDeque::new();
        for index in 0..=LOG_CAPACITY {
            push_bounded_log(&mut logs, format!("line-{index}"));
        }

        assert_eq!(logs.len(), LOG_CAPACITY);
        assert_eq!(logs.front().map(String::as_str), Some("line-1"));
        assert_eq!(
            logs.back().map(String::as_str),
            Some(format!("line-{LOG_CAPACITY}").as_str())
        );
    }
}
