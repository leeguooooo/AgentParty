use std::{
    fs,
    path::{Path, PathBuf},
};

#[cfg(any(test, all(desktop, target_os = "macos")))]
use std::{
    collections::{BTreeMap, BTreeSet},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

#[cfg(all(desktop, target_os = "macos"))]
use std::{
    io::Write as _,
    os::unix::fs::{MetadataExt as _, OpenOptionsExt as _},
    process::{Command, Output, Stdio},
    sync::atomic::{AtomicBool, Ordering},
    time::Instant,
};

use super::{duty_plist_path, instance_id_from_label, xml_escape};

#[cfg(all(desktop, target_os = "macos"))]
use super::{duty_log_path, gui_domain, home_dir, launchctl};

const DUTY_BLOCKED_MARKER_SCHEMA: &str = "agentparty.duty-blocked.v1";

#[cfg(all(desktop, target_os = "macos"))]
const DUTY_RECONCILE_INTERVAL: Duration = Duration::from_secs(30);

#[cfg(all(desktop, target_os = "macos"))]
const DUTY_RELEASE_SYNC_ATTEMPTS: usize = 8;

#[cfg(all(desktop, target_os = "macos"))]
const DUTY_RELEASE_RETRY_INTERVAL: Duration = Duration::from_millis(25);

#[cfg(all(desktop, target_os = "macos"))]
const DUTY_PROCESS_PROBE_TIMEOUT: Duration = Duration::from_secs(2);

#[cfg(all(desktop, target_os = "macos"))]
const DUTY_PROCESS_PROBE_POLL_INTERVAL: Duration = Duration::from_millis(10);

#[cfg(all(desktop, target_os = "macos"))]
static DUTY_OPERATION_ACTIVE: AtomicBool = AtomicBool::new(false);

#[cfg(all(desktop, target_os = "macos"))]
pub(super) struct DutyOperationGuard;

#[cfg(all(desktop, target_os = "macos"))]
impl DutyOperationGuard {
    fn try_acquire() -> Option<Self> {
        DUTY_OPERATION_ACTIVE
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .ok()
            .map(|_| Self)
    }
}

#[cfg(all(desktop, target_os = "macos"))]
impl Drop for DutyOperationGuard {
    fn drop(&mut self) {
        DUTY_OPERATION_ACTIVE.store(false, Ordering::Release);
    }
}

#[cfg(all(desktop, target_os = "macos"))]
pub(super) async fn acquire_duty_operation() -> DutyOperationGuard {
    loop {
        if let Some(guard) = DutyOperationGuard::try_acquire() {
            return guard;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

#[cfg(all(desktop, target_os = "macos"))]
pub(super) fn acquire_duty_operation_blocking() -> Result<DutyOperationGuard, String> {
    for _ in 0..100 {
        if let Some(guard) = DutyOperationGuard::try_acquire() {
            return Ok(guard);
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    Err("another duty install/reconcile operation is still running; retry shortly".to_string())
}

#[cfg(all(desktop, target_os = "macos"))]
pub(super) struct DutyFilesystemLock {
    path: PathBuf,
    owner: String,
    device: u64,
    inode: u64,
}

#[cfg(all(desktop, target_os = "macos"))]
impl Drop for DutyFilesystemLock {
    fn drop(&mut self) {
        release_or_defer_owned_duty_filesystem_lock(
            &self.path,
            &self.owner,
            (self.device, self.inode),
        );
    }
}

#[cfg(all(desktop, target_os = "macos"))]
#[derive(Debug, Clone, PartialEq, Eq)]
enum ProcessStartIdentity {
    Alive(String),
    Dead,
    Unknown,
}

#[cfg(all(desktop, target_os = "macos"))]
fn command_output_with_timeout(command: &mut Command, timeout: Duration) -> Option<Output> {
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .ok()?;
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return child.wait_with_output().ok(),
            Ok(None) if started.elapsed() < timeout => {
                std::thread::sleep(DUTY_PROCESS_PROBE_POLL_INTERVAL);
            }
            Ok(None) | Err(_) => {
                // `kill` 后必须 `wait` 回收子进程；超时/探测错误都不是 owner 已死的证据。
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}

#[cfg(all(desktop, target_os = "macos"))]
fn process_start_identity(pid: u32) -> ProcessStartIdentity {
    let mut command = Command::new("ps");
    command
        .args(["-o", "lstart=", "-p", &pid.to_string()])
        // Node sidecar 使用完全相同的固定 locale；否则同一启动时间会在英文/日文环境下
        // 变成不同字符串，双方误判 PID 已复用并强拆对方的活锁。
        .env("LC_ALL", "C")
        .env("LC_TIME", "C");
    let Some(output) = command_output_with_timeout(&mut command, DUTY_PROCESS_PROBE_TIMEOUT) else {
        return ProcessStartIdentity::Unknown;
    };
    let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if output.status.success() {
        return if value.is_empty() {
            ProcessStartIdentity::Unknown
        } else {
            ProcessStartIdentity::Alive(value)
        };
    }
    // macOS `ps -p <dead-pid>` 的明确“没有匹配行”是非零 + stdout/stderr 都空；
    // 其它失败（权限、PATH、瞬时系统错误）都不能证明 owner 已死，必须 fail closed。
    if value.is_empty() && output.stderr.is_empty() {
        ProcessStartIdentity::Dead
    } else {
        ProcessStartIdentity::Unknown
    }
}

#[cfg(all(desktop, target_os = "macos"))]
fn process_identity_is_stale(identity: &ProcessStartIdentity, expected_start: &str) -> bool {
    match identity {
        ProcessStartIdentity::Alive(started_at) => started_at != expected_start,
        ProcessStartIdentity::Dead => true,
        ProcessStartIdentity::Unknown => false,
    }
}

#[cfg(all(desktop, target_os = "macos"))]
fn write_private_new_file(path: &Path, value: &str) -> std::io::Result<()> {
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)?;
    file.write_all(value.as_bytes())
}

#[cfg(all(desktop, target_os = "macos"))]
fn duty_lock_path_is_stale_with_fallback(
    path: &Path,
    fallback_modified: Option<SystemTime>,
) -> bool {
    let fallback_is_stale = || {
        fallback_modified
            .or_else(|| {
                fs::metadata(path)
                    .and_then(|metadata| metadata.modified())
                    .ok()
            })
            .and_then(|modified| modified.elapsed().ok())
            .is_some_and(|age| age > Duration::from_secs(10))
    };
    match fs::read_to_string(path.join("owner")) {
        Ok(owner) => {
            let mut parts = owner.trim().splitn(3, '|');
            match (
                parts.next().and_then(|pid| pid.parse::<u32>().ok()),
                parts.next(),
                parts.next(),
            ) {
                (Some(pid), Some(expected_start), Some(_token)) => {
                    process_identity_is_stale(&process_start_identity(pid), expected_start)
                }
                _ => fallback_is_stale(),
            }
        }
        Err(_) => fallback_is_stale(),
    }
}

#[cfg(all(desktop, target_os = "macos"))]
fn duty_lock_path_is_stale(path: &Path) -> bool {
    duty_lock_path_is_stale_with_fallback(path, None)
}

#[cfg(all(desktop, target_os = "macos"))]
struct DutyLockReclaimGuard {
    path: PathBuf,
    owner: String,
}

#[cfg(all(desktop, target_os = "macos"))]
impl Drop for DutyLockReclaimGuard {
    fn drop(&mut self) {
        let owner_path = self.path.join("owner");
        if fs::read_to_string(&owner_path).is_ok_and(|owner| owner.trim() == self.owner.as_str()) {
            let _ = fs::remove_file(owner_path);
            let _ = fs::remove_dir(&self.path);
        }
    }
}

#[cfg(all(desktop, target_os = "macos"))]
fn try_clear_stale_duty_reclaim_claim(path: &Path) -> bool {
    let owner_path = path.join("owner");
    let expected_owner = fs::read_to_string(&owner_path)
        .ok()
        .map(|owner| owner.trim().to_string());
    if !duty_lock_path_is_stale(path) {
        return false;
    }
    if let Some(expected_owner) = expected_owner {
        // 两个清理者可能同时观察到旧 claim；删除前再比对，绝不 unlink 后来者的新 owner。
        if !fs::read_to_string(&owner_path)
            .is_ok_and(|owner| owner.trim() == expected_owner.as_str())
        {
            return false;
        }
        match fs::remove_file(&owner_path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return false,
        }
    }
    // 只删除空目录。若后来者刚 create_dir 但还没写 owner，它的写入会失败并放弃本轮，
    // 不会拿着一个被旧清理者移除的 claim 继续操作 canonical lock。
    fs::remove_dir(path).is_ok()
}

#[cfg(all(desktop, target_os = "macos"))]
fn try_acquire_duty_internal_claim_with_process_start(
    path: &Path,
    process_start: &str,
) -> Result<Option<DutyLockReclaimGuard>, String> {
    let reclaim_path = path.join(".reclaim");
    match fs::create_dir(&reclaim_path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            let _ = try_clear_stale_duty_reclaim_claim(&reclaim_path);
            return Ok(None);
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("cannot acquire duty internal claim: {error}")),
    }
    let claim_owner = format!(
        "{}|{}|{}",
        std::process::id(),
        process_start,
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    );
    if let Err(error) = write_private_new_file(&reclaim_path.join("owner"), &claim_owner) {
        let _ = fs::remove_dir(&reclaim_path);
        if matches!(
            error.kind(),
            std::io::ErrorKind::NotFound | std::io::ErrorKind::AlreadyExists
        ) {
            return Ok(None);
        }
        return Err(format!("cannot initialize duty internal claim: {error}"));
    }
    Ok(Some(DutyLockReclaimGuard {
        path: reclaim_path,
        owner: claim_owner,
    }))
}

#[cfg(all(desktop, target_os = "macos"))]
fn try_acquire_duty_internal_claim(path: &Path) -> Result<Option<DutyLockReclaimGuard>, String> {
    let ProcessStartIdentity::Alive(process_start) = process_start_identity(std::process::id())
    else {
        return Err(
            "cannot identify current process start time for duty internal claim".to_string(),
        );
    };
    try_acquire_duty_internal_claim_with_process_start(path, &process_start)
}

#[cfg(all(desktop, target_os = "macos"))]
fn duty_lock_owner_process_start(owner: &str) -> Option<&str> {
    let mut parts = owner.trim().splitn(3, '|');
    let pid = parts.next()?.parse::<u32>().ok()?;
    let process_start = parts.next()?;
    let token = parts.next()?;
    (pid == std::process::id() && !process_start.is_empty() && !token.is_empty())
        .then_some(process_start)
}

#[cfg(all(desktop, target_os = "macos"))]
fn try_release_owned_duty_filesystem_lock(
    path: &Path,
    owner: &str,
    acquired_identity: (u64, u64),
) -> bool {
    let owner_path = path.join("owner");
    let same_owner_and_directory = fs::metadata(path).ok().is_some_and(|metadata| {
        (metadata.dev(), metadata.ino()) == acquired_identity
            && fs::read_to_string(&owner_path).is_ok_and(|current| current.trim() == owner)
    });
    if !same_owner_and_directory {
        return true;
    }
    // canonical owner 是本 guard 取得锁时已经验证过的 pid|start|token；release 复用该
    // start identity，不能因之后 `ps` 瞬时或持续不可用而永远遗留 live owner。
    let Some(process_start) = duty_lock_owner_process_start(owner) else {
        return false;
    };
    let claim = match try_acquire_duty_internal_claim_with_process_start(path, process_start) {
        Ok(Some(claim)) => claim,
        Ok(None) | Err(_) => return false,
    };
    let still_owned = fs::metadata(path).ok().is_some_and(|metadata| {
        (metadata.dev(), metadata.ino()) == acquired_identity
            && fs::read_to_string(&owner_path).is_ok_and(|current| current.trim() == owner)
    });
    if !still_owned {
        return true;
    }
    let tombstone = path.with_extension(format!(
        "lock.released-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    ));
    if fs::rename(path, &tombstone).is_ok() {
        // rename 后只删除绑定旧 inode 的私有 tombstone；canonical 可安全交给后来者。
        let _ = fs::remove_dir_all(tombstone);
        drop(claim);
        return true;
    }
    drop(claim);
    // rename 失败后再看一次；若 canonical 已换代或 owner 已变，旧 guard 已无需清理。
    !fs::metadata(path).ok().is_some_and(|metadata| {
        (metadata.dev(), metadata.ino()) == acquired_identity
            && fs::read_to_string(&owner_path).is_ok_and(|current| current.trim() == owner)
    })
}

#[cfg(all(desktop, target_os = "macos"))]
fn release_owned_duty_filesystem_lock(
    path: &Path,
    owner: &str,
    acquired_identity: (u64, u64),
) -> bool {
    for attempt in 0..DUTY_RELEASE_SYNC_ATTEMPTS {
        if try_release_owned_duty_filesystem_lock(path, owner, acquired_identity) {
            return true;
        }
        if attempt + 1 < DUTY_RELEASE_SYNC_ATTEMPTS {
            std::thread::sleep(DUTY_RELEASE_RETRY_INTERVAL);
        }
    }
    false
}

#[cfg(all(desktop, target_os = "macos"))]
fn release_owned_duty_filesystem_lock_until_complete(
    path: &Path,
    owner: &str,
    acquired_identity: (u64, u64),
) {
    loop {
        if try_release_owned_duty_filesystem_lock(path, owner, acquired_identity) {
            return;
        }
        std::thread::sleep(DUTY_RELEASE_RETRY_INTERVAL);
    }
}

#[cfg(all(desktop, target_os = "macos"))]
fn release_or_defer_owned_duty_filesystem_lock(
    path: &Path,
    owner: &str,
    acquired_identity: (u64, u64),
) {
    if release_owned_duty_filesystem_lock(path, owner, acquired_identity) {
        return;
    }
    let path = path.to_path_buf();
    let owner = owner.to_string();
    let deferred_path = path.clone();
    let deferred_owner = owner.clone();
    if let Err(error) = std::thread::Builder::new()
        .name("agentparty-duty-lock-release".to_string())
        .spawn(move || {
            // 长事务可以暂时持有内部 claim；不阻塞桌面调用线程，但也不遗留一个由
            // 长寿 desktop PID 持有、之后永远不会被判 stale 的 canonical owner。
            release_owned_duty_filesystem_lock_until_complete(
                &deferred_path,
                &deferred_owner,
                acquired_identity,
            );
        })
    {
        eprintln!(
            "desktop duty lock deferred release thread unavailable ({error}); retrying synchronously"
        );
        // 资源耗尽导致线程创建失败时不能静默遗留 live owner。仍只走 inode/owner、
        // internal claim、rename tombstone 这套协议；代价是极端情况下阻塞当前 Drop。
        release_owned_duty_filesystem_lock_until_complete(&path, &owner, acquired_identity);
    }
}

#[cfg(all(desktop, target_os = "macos"))]
fn try_reclaim_stale_duty_lock_with<F>(path: &Path, is_stale: F) -> Result<bool, String>
where
    F: FnOnce(Option<SystemTime>) -> bool,
{
    let observed = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => {
            return Err(format!(
                "cannot inspect duty lock before reclamation: {error}"
            ))
        }
    };
    let observed_modified = observed.modified().ok();
    let observed_identity = (observed.dev(), observed.ino());
    let Some(claim) = try_acquire_duty_internal_claim(path)? else {
        return Ok(false);
    };

    let current = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => {
            return Err(format!(
                "cannot recheck duty lock before reclamation: {error}"
            ))
        }
    };
    if (current.dev(), current.ino()) != observed_identity {
        return Ok(false);
    }
    // 内部 claim 会让普通 owner 的 remove_dir 失败，从而钉住同一个目录 inode。
    // 创建 claim 会更新目录 mtime；损坏/缺失 owner 的兜底必须使用 claim 前快照。
    if !is_stale(observed_modified) {
        return Ok(false);
    }

    let tombstone = path.with_extension(format!(
        "lock.stale-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    ));
    match fs::rename(path, &tombstone) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(format!("cannot quarantine stale duty lock: {error}")),
    }
    // canonical path 已经原子空出；后来者可以取得新锁，回收者从此只删除自己的 tombstone。
    fs::remove_dir_all(&tombstone)
        .map_err(|error| format!("cannot remove quarantined stale duty lock: {error}"))?;
    drop(claim);
    Ok(true)
}

#[cfg(all(desktop, target_os = "macos"))]
fn wait_for_duty_lock_publication(path: &Path, owner: &str, acquired_identity: (u64, u64)) -> bool {
    let owner_path = path.join("owner");
    let reclaim_path = path.join(".reclaim");
    for _ in 0..200 {
        let same_owner_and_directory = fs::metadata(path).ok().is_some_and(|metadata| {
            (metadata.dev(), metadata.ino()) == acquired_identity
                && fs::read_to_string(&owner_path).is_ok_and(|current| current.trim() == owner)
        });
        if !same_owner_and_directory {
            return false;
        }
        if !reclaim_path.exists() {
            // claim pathname 也会随 canonical rename 到 tombstone；absence 后必须再核对，
            // 否则可能在“第一次 stat 成功、随后被 rename”窗口误报发布成功。
            return fs::metadata(path).ok().is_some_and(|metadata| {
                (metadata.dev(), metadata.ino()) == acquired_identity
                    && fs::read_to_string(&owner_path).is_ok_and(|current| current.trim() == owner)
            });
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    false
}

#[cfg(all(desktop, target_os = "macos"))]
fn try_acquire_duty_filesystem_lock(
    home: &Path,
    label: &str,
) -> Result<Option<DutyFilesystemLock>, String> {
    let dir = home.join(".agentparty/desktop/duty-locks");
    fs::create_dir_all(&dir)
        .map_err(|error| format!("cannot create duty lock directory: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("cannot secure duty lock directory: {error}"))?;
    }
    let path = dir.join(format!("{label}.lock"));
    match fs::create_dir(&path) {
        Ok(()) => {
            let ProcessStartIdentity::Alive(process_start) =
                process_start_identity(std::process::id())
            else {
                let _ = fs::remove_dir(&path);
                return Err("cannot identify current process start time for duty lock".to_string());
            };
            let owner = format!(
                "{}|{}|{}",
                std::process::id(),
                process_start,
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos()
            );
            if let Err(error) = write_private_new_file(&path.join("owner"), &owner) {
                let _ = fs::remove_dir(&path);
                if error.kind() == std::io::ErrorKind::AlreadyExists {
                    return Ok(None);
                }
                return Err(format!("cannot initialize duty lock owner: {error}"));
            }
            let metadata = match fs::metadata(&path) {
                Ok(metadata) => metadata,
                Err(error) => {
                    if fs::read_to_string(path.join("owner"))
                        .is_ok_and(|current| current.trim() == owner)
                    {
                        let _ = fs::remove_file(path.join("owner"));
                        let _ = fs::remove_dir(&path);
                    }
                    return Err(format!("cannot inspect acquired duty lock: {error}"));
                }
            };
            let acquired_identity = (metadata.dev(), metadata.ino());
            if !wait_for_duty_lock_publication(&path, &owner, acquired_identity) {
                release_or_defer_owned_duty_filesystem_lock(&path, &owner, acquired_identity);
                return Ok(None);
            }
            Ok(Some(DutyFilesystemLock {
                path,
                owner,
                device: acquired_identity.0,
                inode: acquired_identity.1,
            }))
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            if duty_lock_path_is_stale(&path) {
                let _ = try_reclaim_stale_duty_lock_with(&path, |fallback_modified| {
                    duty_lock_path_is_stale_with_fallback(&path, fallback_modified)
                })?;
            }
            Ok(None)
        }
        Err(error) => Err(format!("cannot acquire duty lock: {error}")),
    }
}

#[cfg(all(desktop, target_os = "macos"))]
pub(super) async fn acquire_duty_filesystem_lock(
    home: &Path,
    label: &str,
) -> Result<DutyFilesystemLock, String> {
    for _ in 0..200 {
        if let Some(guard) = try_acquire_duty_filesystem_lock(home, label)? {
            return Ok(guard);
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    Err("another duty process is still changing this resident job; retry shortly".to_string())
}

#[cfg(all(desktop, target_os = "macos"))]
pub(super) fn acquire_duty_filesystem_lock_blocking(
    home: &Path,
    label: &str,
) -> Result<DutyFilesystemLock, String> {
    for _ in 0..200 {
        if let Some(guard) = try_acquire_duty_filesystem_lock(home, label)? {
            return Ok(guard);
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    Err("another duty process is still changing this resident job; retry shortly".to_string())
}

/// serve 在熔断 / token 撤销后自 bootout 前写入；reconcile 必须尊重这个持久停机意图。
fn duty_blocked_marker_path(home: &Path, label: &str) -> PathBuf {
    home.join(".agentparty/desktop/duty-blocked")
        .join(format!("{label}.json"))
}

pub(super) fn duty_quarantined_plist_path(home: &Path, label: &str) -> PathBuf {
    home.join("Library/LaunchAgents")
        .join(format!("{label}.plist.terminal-disabled"))
}

/// 标记文件本身就是安全边界：即使 JSON 因磁盘损坏不可读，也宁可要求 owner 显式 repair，
/// 不能把一次终局停机误判成普通掉线而自动复活。
fn plist_string_for_key(value: &str, key: &str) -> Option<String> {
    let marker = format!("<key>{}</key>", xml_escape(key));
    let rest = value.split_once(&marker)?.1;
    let rest = rest.split_once("<string>")?.1;
    let value = rest.split_once("</string>")?.0;
    Some(
        value
            .replace("&quot;", "\"")
            .replace("&gt;", ">")
            .replace("&lt;", "<")
            .replace("&amp;", "&"),
    )
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum DutyGeneration {
    Managed(String),
    Legacy,
    Unreadable(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum DutyIdentity {
    Known(String),
    Unreadable(String),
}

impl DutyGeneration {
    fn as_deref(&self) -> Option<&str> {
        match self {
            Self::Managed(generation) => Some(generation),
            Self::Legacy | Self::Unreadable(_) => None,
        }
    }

    fn recovery_block(&self) -> Option<String> {
        match self {
            Self::Managed(_) => None,
            Self::Legacy => Some("legacy-duty-needs-repair".to_string()),
            Self::Unreadable(reason) => Some(reason.clone()),
        }
    }
}

fn plist_generation(path: &Path) -> DutyGeneration {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) => {
            return DutyGeneration::Unreadable(format!("duty-plist-unreadable:{error}"));
        }
    };
    if metadata.len() > 1024 * 1024 {
        return DutyGeneration::Unreadable("duty-plist-oversized".to_string());
    }
    let plist = match fs::read_to_string(path) {
        Ok(plist) => plist,
        Err(error) => {
            return DutyGeneration::Unreadable(format!("duty-plist-unreadable:{error}"));
        }
    };
    plist_string_for_key(&plist, "AP_DUTY_GENERATION")
        .filter(|generation| !generation.is_empty())
        .map_or(DutyGeneration::Legacy, DutyGeneration::Managed)
}

/// 与 CLI `instanceLockTarget(server, token, channel)` 保持同一身份边界。token 只参与
/// 不可逆摘要，绝不进入 plist、日志或错误文本。
fn config_instance_target(config_path: &Path, channel: &str) -> Result<String, String> {
    let metadata = fs::metadata(config_path)
        .map_err(|error| format!("AGENTPARTY_CONFIG is unavailable: {error}"))?;
    if metadata.len() > 1024 * 1024 {
        return Err("AGENTPARTY_CONFIG is oversized".to_string());
    }
    let raw = fs::read_to_string(config_path)
        .map_err(|error| format!("AGENTPARTY_CONFIG is unreadable: {error}"))?;
    let config: serde_json::Value =
        serde_json::from_str(&raw).map_err(|_| "AGENTPARTY_CONFIG is invalid".to_string())?;
    let server = config
        .get("server")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "AGENTPARTY_CONFIG server is missing".to_string())?;
    let token = config
        .get("token")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "AGENTPARTY_CONFIG token is missing".to_string())?;
    let mut identity = Vec::with_capacity(server.len() + token.len() + 1);
    identity.extend_from_slice(server.as_bytes());
    identity.push(0);
    identity.extend_from_slice(token.as_bytes());
    let digest = crate::ui_update::sha256_hex(&identity);
    Ok(format!("{}-{channel}", &digest[..24]))
}

fn plist_instance_identity(path: &Path, channel: &str) -> DutyIdentity {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) => {
            return DutyIdentity::Unreadable(format!("duty-plist-unreadable:{error}"));
        }
    };
    if metadata.len() > 1024 * 1024 {
        return DutyIdentity::Unreadable("duty-plist-oversized".to_string());
    }
    let plist = match fs::read_to_string(path) {
        Ok(plist) => plist,
        Err(error) => {
            return DutyIdentity::Unreadable(format!("duty-plist-unreadable:{error}"));
        }
    };
    let Some(config_path) = plist_string_for_key(&plist, "AGENTPARTY_CONFIG")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
    else {
        return DutyIdentity::Unreadable("duty-config-path-missing".to_string());
    };
    if !config_path.is_absolute() {
        return DutyIdentity::Unreadable("duty-config-path-not-absolute".to_string());
    }
    match config_instance_target(&config_path, channel) {
        Ok(target) => DutyIdentity::Known(target),
        Err(error) => DutyIdentity::Unreadable(format!("duty-config-identity-unavailable:{error}")),
    }
}

fn duty_blocked_reason_for_generation(
    home: &Path,
    label: &str,
    plist_generation: &DutyGeneration,
) -> Option<String> {
    let path = duty_blocked_marker_path(home, label);
    if fs::metadata(&path).is_ok_and(|metadata| metadata.len() > 16 * 1024) {
        return Some("terminal-stop-marker-oversized".to_string());
    }
    let body = match fs::read_to_string(&path) {
        Ok(body) => body,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return None,
        Err(_) => return Some("terminal-stop-marker-unreadable".to_string()),
    };
    let Ok(marker) = serde_json::from_str::<serde_json::Value>(&body) else {
        return Some("terminal-stop-marker-invalid".to_string());
    };
    let valid = marker.get("schema").and_then(serde_json::Value::as_str)
        == Some(DUTY_BLOCKED_MARKER_SCHEMA)
        && marker.get("label").and_then(serde_json::Value::as_str) == Some(label);
    if !valid {
        return Some("terminal-stop-marker-invalid".to_string());
    }
    let marker_generation = marker.get("generation").and_then(serde_json::Value::as_str);
    if matches!(plist_generation, DutyGeneration::Unreadable(_)) {
        return Some("terminal-stop-plist-unreadable".to_string());
    }
    // 旧 plist + 旧 marker 都没有 generation 时仍兼容；只要一端有 generation，就必须精确
    // 匹配。重配时旧 serve 晚到的 marker 因代次不同而不会封死新 job。
    if marker_generation != plist_generation.as_deref() {
        return None;
    }
    marker
        .get("reason")
        .and_then(serde_json::Value::as_str)
        .filter(|reason| !reason.is_empty())
        .map(|reason| reason.chars().take(128).collect())
        .or_else(|| Some("terminal-stop".to_string()))
}

fn duty_blocked_reason(home: &Path, label: &str) -> Option<String> {
    duty_blocked_reason_for_generation(
        home,
        label,
        &plist_generation(&duty_plist_path(home, label)),
    )
}

pub(super) fn duty_repair_reason(
    home: &Path,
    label: &str,
    loaded: bool,
    disabled: bool,
) -> Option<String> {
    if let Some(reason) = duty_blocked_reason(home, label) {
        return Some(reason);
    }
    if disabled {
        return Some("launchd-disabled".to_string());
    }
    if !loaded {
        return plist_generation(&duty_plist_path(home, label)).recovery_block();
    }
    None
}

pub(super) fn clear_duty_blocked_marker(home: &Path, label: &str) -> Result<(), String> {
    let path = duty_blocked_marker_path(home, label);
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("cannot clear terminal duty marker: {error}")),
    }
}

#[cfg(all(desktop, target_os = "macos"))]
#[derive(Debug)]
pub(super) struct DutyInstallSnapshot {
    plist: Option<Vec<u8>>,
    marker: Option<Vec<u8>>,
    loaded: bool,
    disabled: bool,
}

#[cfg(all(desktop, target_os = "macos"))]
fn read_optional_file(path: &Path, description: &str) -> Result<Option<Vec<u8>>, String> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("cannot back up {description}: {error}")),
    }
}

#[cfg(all(desktop, target_os = "macos"))]
fn atomic_restore(path: &Path, bytes: &[u8], mode: u32, description: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("{description} path has no parent"))?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("cannot create {description} directory: {error}"))?;
    let staged = path.with_extension(format!(
        "restore-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    ));
    let result = (|| {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(mode);
        }
        let mut file = options
            .open(&staged)
            .map_err(|error| format!("cannot stage {description}: {error}"))?;
        file.write_all(bytes)
            .map_err(|error| format!("cannot write staged {description}: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("cannot sync staged {description}: {error}"))?;
        fs::rename(&staged, path).map_err(|error| format!("cannot restore {description}: {error}"))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&staged);
    }
    result
}

#[cfg(all(desktop, target_os = "macos"))]
pub(super) fn capture_duty_install(
    home: &Path,
    label: &str,
) -> Result<DutyInstallSnapshot, String> {
    Ok(DutyInstallSnapshot {
        plist: read_optional_file(&duty_plist_path(home, label), "existing duty plist")?,
        marker: read_optional_file(
            &duty_blocked_marker_path(home, label),
            "terminal duty marker",
        )?,
        loaded: duty_loaded_checked(label)?,
        disabled: duty_disabled_checked(label)?,
    })
}

#[cfg(all(desktop, target_os = "macos"))]
pub(super) fn prepare_duty_reinstall(
    label: &str,
    snapshot: &DutyInstallSnapshot,
) -> Result<(), String> {
    if !snapshot.loaded {
        return Ok(());
    }
    launchctl_action(
        &["bootout", &format!("{}/{label}", gui_domain())],
        "launchctl duty reinstall bootout",
    )?;
    if duty_loaded_checked(label)? {
        return Err(
            "launchctl bootout succeeded but the old duty job is still loaded; install was not changed"
                .to_string(),
        );
    }
    Ok(())
}

#[cfg(all(desktop, target_os = "macos"))]
pub(super) fn enable_duty_for_repair(label: &str) -> Result<(), String> {
    if !duty_disabled_checked(label)? {
        return Ok(());
    }
    launchctl_action(
        &["enable", &format!("{}/{label}", gui_domain())],
        "launchctl duty repair enable",
    )
}

#[cfg(all(desktop, target_os = "macos"))]
pub(super) fn finish_duty_reinstall(home: &Path, label: &str) -> Result<(), String> {
    let quarantined = duty_quarantined_plist_path(home, label);
    match fs::remove_file(quarantined) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("cannot remove repaired duty quarantine: {error}")),
    }
}

#[cfg(all(desktop, target_os = "macos"))]
pub(super) async fn rollback_duty_install(
    home: &Path,
    label: &str,
    snapshot: DutyInstallSnapshot,
    reason: String,
) -> String {
    let mut rollback_errors = Vec::new();
    let unloaded = match duty_loaded_checked(label) {
        Ok(true) => {
            match launchctl_action(
                &["bootout", &format!("{}/{label}", gui_domain())],
                "launchctl failed-install bootout",
            ) {
                Ok(()) => match duty_loaded_checked(label) {
                    Ok(false) => true,
                    Ok(true) => {
                        rollback_errors.push(
                            "failed-install job is still loaded after bootout; active plist was preserved"
                                .to_string(),
                        );
                        false
                    }
                    Err(error) => {
                        rollback_errors.push(format!(
                            "cannot verify failed-install bootout; active plist was preserved: {error}"
                        ));
                        false
                    }
                },
                Err(error) => {
                    rollback_errors.push(format!(
                        "{error}; active failed-install plist was preserved"
                    ));
                    false
                }
            }
        }
        Ok(false) => true,
        Err(error) => {
            rollback_errors.push(format!(
                "cannot verify failed-install job state; active plist was preserved: {error}"
            ));
            false
        }
    };
    // loaded G1 与磁盘 G0/无 plist 是不可恢复的 split-brain。只有严格确认 G1 已卸载，
    // 才允许覆盖/删除 active plist；否则保留整个失败现场给下一次显式 repair。
    if !unloaded {
        return format!(
            "{reason}; ALSO failed to restore previous duty state: {}",
            rollback_errors.join("; ")
        );
    }

    let plist_path = duty_plist_path(home, label);
    match &snapshot.plist {
        Some(bytes) => {
            if let Err(error) = atomic_restore(&plist_path, bytes, 0o644, "previous duty plist") {
                rollback_errors.push(error);
            }
        }
        None => match fs::remove_file(&plist_path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => rollback_errors.push(format!("cannot remove failed duty plist: {error}")),
        },
    }

    // 旧 G0 在 teardown 期间可能晚写 marker。先把旧 plist 恢复，再判断磁盘上当前 marker
    // 是否匹配 G0；匹配/损坏都保留并 fail closed。只有当前 marker 对 G0 无效时才恢复事务
    // 开始时的快照，避免无条件覆盖掉晚到的真实终局停机意图。
    let mut terminal_reason = duty_blocked_reason(home, label);
    if terminal_reason.is_none() {
        let marker_path = duty_blocked_marker_path(home, label);
        match &snapshot.marker {
            Some(bytes) => {
                if let Err(error) =
                    atomic_restore(&marker_path, bytes, 0o600, "previous terminal duty marker")
                {
                    rollback_errors.push(error);
                }
            }
            None => match fs::remove_file(&marker_path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => rollback_errors
                    .push(format!("cannot remove stale terminal duty marker: {error}")),
            },
        }
        terminal_reason = duty_blocked_reason(home, label);
    }

    let should_disable = snapshot.disabled || terminal_reason.is_some();
    let disabled_now = duty_disabled_checked(label);
    match (should_disable, disabled_now) {
        (true, Ok(false)) => {
            if let Err(error) = launchctl_action(
                &["disable", &format!("{}/{label}", gui_domain())],
                "launchctl rollback disable",
            ) {
                rollback_errors.push(error);
            }
        }
        (false, Ok(true)) => {
            if let Err(error) = launchctl_action(
                &["enable", &format!("{}/{label}", gui_domain())],
                "launchctl rollback enable",
            ) {
                rollback_errors.push(error);
            }
        }
        (_, Ok(_)) => {}
        (_, Err(error)) => rollback_errors.push(error),
    }

    if snapshot.loaded
        && !snapshot.disabled
        && terminal_reason.is_none()
        && snapshot.plist.is_some()
        && rollback_errors.is_empty()
    {
        let domain = gui_domain();
        if let Err(error) = launchctl_action(
            &["bootstrap", &domain, &plist_path.to_string_lossy()],
            "launchctl rollback bootstrap",
        ) {
            rollback_errors.push(error);
        } else {
            let mut restored = false;
            for _ in 0..10 {
                match duty_loaded_checked(label) {
                    Ok(true) => {
                        restored = true;
                        break;
                    }
                    Ok(false) => tokio::time::sleep(Duration::from_millis(200)).await,
                    Err(error) => {
                        rollback_errors.push(error);
                        break;
                    }
                }
            }
            if !restored && rollback_errors.is_empty() {
                rollback_errors
                    .push("previous duty job did not reload during rollback".to_string());
            }
        }
    }

    if rollback_errors.is_empty() {
        reason
    } else {
        format!(
            "{reason}; ALSO failed to fully restore previous duty state: {}",
            rollback_errors.join("; ")
        )
    }
}

#[cfg(all(desktop, target_os = "macos"))]
pub(super) fn duty_loaded_checked(label: &str) -> Result<bool, String> {
    let output = launchctl(&["print", &format!("{}/{label}", gui_domain())])?;
    launchctl_print_loaded(
        output.status.success(),
        output.status.code(),
        &String::from_utf8_lossy(&output.stderr),
    )
}

#[cfg(any(test, all(desktop, target_os = "macos")))]
fn launchctl_print_loaded(success: bool, code: Option<i32>, stderr: &str) -> Result<bool, String> {
    if success {
        return Ok(true);
    }
    // macOS launchctl 用 EX_UNAVAILABLE(113) 表示目标 service 不存在。其它非零（坏 domain、
    // IPC/权限错误等）不是 absent；若误判成 false，unpersist 会删掉仍可能 loaded 的 plist。
    if code == Some(113) && stderr.contains("Could not find service") {
        return Ok(false);
    }
    let detail = stderr.trim().chars().take(200).collect::<String>();
    Err(if detail.is_empty() {
        format!(
            "launchctl print failed with exit {}",
            code.map_or_else(|| "signal".to_string(), |v| v.to_string())
        )
    } else {
        format!("launchctl print failed: {detail}")
    })
}

#[cfg(all(desktop, target_os = "macos"))]
pub(super) fn duty_disabled_checked(label: &str) -> Result<bool, String> {
    Ok(duty_disabled_labels_checked()?.contains(label))
}

#[cfg(all(desktop, target_os = "macos"))]
pub(super) fn duty_disabled_labels_checked() -> Result<BTreeSet<String>, String> {
    let output = launchctl(&["print-disabled", &gui_domain()])?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "launchctl print-disabled failed: {}",
            detail.trim().chars().take(200).collect::<String>()
        ));
    }
    Ok(launchctl_disabled_labels_from_text(
        &String::from_utf8_lossy(&output.stdout),
    ))
}

#[cfg(any(test, all(desktop, target_os = "macos")))]
fn launchctl_disabled_labels_from_text(value: &str) -> BTreeSet<String> {
    value
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            let label = line.strip_prefix('"')?.strip_suffix("\" => disabled")?;
            Some(label.to_string())
        })
        .collect()
}

#[cfg(all(desktop, target_os = "macos"))]
pub(super) fn launchctl_action(args: &[&str], action: &str) -> Result<(), String> {
    let output = launchctl(args)?;
    if output.status.success() {
        return Ok(());
    }
    let detail = String::from_utf8_lossy(&output.stderr);
    let detail = detail.trim().chars().take(200).collect::<String>();
    if detail.is_empty() {
        Err(format!("{action} failed"))
    } else {
        Err(format!("{action} failed: {detail}"))
    }
}

#[cfg(any(test, all(desktop, target_os = "macos")))]
#[derive(Debug, Clone, PartialEq, Eq)]
struct DutyCandidate {
    label: String,
    channel: String,
    plist_path: PathBuf,
    modified_at: u128,
    generation: DutyGeneration,
    identity: DutyIdentity,
}

#[cfg(any(test, all(desktop, target_os = "macos")))]
fn duty_candidates(home: &Path) -> Result<Vec<DutyCandidate>, String> {
    let agents_dir = home.join("Library/LaunchAgents");
    let dir = match fs::read_dir(&agents_dir) {
        Ok(dir) => dir,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("cannot read LaunchAgents dir: {error}")),
    };
    let mut candidates = Vec::new();
    for item in dir {
        let item = item.map_err(|error| format!("cannot read LaunchAgents entry: {error}"))?;
        let name = item.file_name();
        let Some(name) = name.to_str() else { continue };
        let Some(label) = name.strip_suffix(".plist") else {
            continue;
        };
        let Some(instance_id) = instance_id_from_label(label) else {
            continue;
        };
        // 不跟随符号链接去 bootstrap 任意文件；duty plist 都是本模块原子写出的普通文件。
        let metadata = fs::symlink_metadata(item.path())
            .map_err(|error| format!("cannot inspect duty plist {label}: {error}"))?;
        if !metadata.file_type().is_file() {
            continue;
        }
        let Some((_, channel)) = instance_id.rsplit_once(':') else {
            continue;
        };
        let modified_at = metadata
            .modified()
            .unwrap_or(SystemTime::UNIX_EPOCH)
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        candidates.push(DutyCandidate {
            label: label.to_string(),
            channel: channel.to_string(),
            plist_path: item.path(),
            modified_at,
            generation: plist_generation(&item.path()),
            identity: plist_instance_identity(&item.path(), channel),
        });
    }
    candidates.sort_by(|left, right| left.label.cmp(&right.label));
    Ok(candidates)
}

#[cfg(any(test, all(desktop, target_os = "macos")))]
pub(super) fn conflicting_duty_labels(
    home: &Path,
    target_label: &str,
    target_config_path: &Path,
    channel: &str,
) -> Result<Vec<String>, String> {
    let target_identity = config_instance_target(target_config_path, channel)?;
    let mut conflicts = Vec::new();
    for candidate in duty_candidates(home)?
        .into_iter()
        .filter(|candidate| candidate.channel == channel && candidate.label != target_label)
    {
        match candidate.identity {
            DutyIdentity::Known(identity) if identity == target_identity => {
                conflicts.push(candidate.label);
            }
            DutyIdentity::Known(_) => {}
            DutyIdentity::Unreadable(reason) => {
                return Err(format!(
                    "cannot safely compare resident duty {} identity ({reason}); repair or remove it first",
                    candidate.label
                ));
            }
        }
    }
    conflicts.sort();
    Ok(conflicts)
}

#[cfg(any(test, all(desktop, target_os = "macos")))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DutyReconcileDisposition {
    Healthy,
    Reloaded,
    TerminalBlocked,
    Superseded,
    Failed,
}

#[cfg(any(test, all(desktop, target_os = "macos")))]
#[derive(Debug, Clone, PartialEq, Eq)]
struct DutyReconcileRecord {
    label: String,
    disposition: DutyReconcileDisposition,
    detail: String,
}

/// launchctl 不能在单测安全运行，故把 probe / disabled / bootout / bootstrap / archive / sleep
/// 全部注入。选择 winner 时先排除终局停机，再优先保住已 loaded 的健康 job；只有没有健康 job
/// 时才拉起最新、带 generation 的新式 plist。loser 仅在确认 unloaded 后移出扫描目录。
#[cfg(any(test, all(desktop, target_os = "macos")))]
fn reconcile_duties_with<Loaded, Disabled, Bootout, Bootstrap, Archive, Sleep>(
    home: &Path,
    mut loaded: Loaded,
    mut disabled: Disabled,
    mut bootout: Bootout,
    mut bootstrap: Bootstrap,
    mut archive: Archive,
    mut sleep: Sleep,
) -> Result<Vec<DutyReconcileRecord>, String>
where
    Loaded: FnMut(&str) -> Result<bool, String>,
    Disabled: FnMut(&str) -> Result<bool, String>,
    Bootout: FnMut(&str) -> Result<(), String>,
    Bootstrap: FnMut(&str, &Path) -> Result<(), String>,
    Archive: FnMut(&str, &Path, &str) -> Result<PathBuf, String>,
    Sleep: FnMut(Duration),
{
    let mut records = Vec::new();
    let mut by_instance: BTreeMap<String, Vec<DutyCandidate>> = BTreeMap::new();
    for candidate in duty_candidates(home)? {
        let identity = match &candidate.identity {
            DutyIdentity::Known(identity) => identity.clone(),
            DutyIdentity::Unreadable(reason) => {
                records.push(DutyReconcileRecord {
                    label: candidate.label,
                    disposition: DutyReconcileDisposition::Failed,
                    detail: format!(
                        "cannot determine duty instance identity; preserving it unchanged: {reason}"
                    ),
                });
                continue;
            }
        };
        by_instance.entry(identity).or_default().push(candidate);
    }

    for mut group in by_instance.into_values() {
        group.sort_by(|left, right| {
            left.modified_at
                .cmp(&right.modified_at)
                .then_with(|| left.label.cmp(&right.label))
        });

        // 任一 probe 失败都让整个实例组 fail closed：不知道某个 job 是否 loaded/disabled，
        // 就不能 bootstrap 或清理其它候选，避免双跑或复活显式 disabled 的 duty。
        let mut loaded_states = BTreeMap::new();
        let mut disabled_states = BTreeMap::new();
        let mut probe_failed = false;
        for candidate in &group {
            match loaded(&candidate.label) {
                Ok(value) => {
                    loaded_states.insert(candidate.label.clone(), value);
                }
                Err(error) => {
                    probe_failed = true;
                    records.push(DutyReconcileRecord {
                        label: candidate.label.clone(),
                        disposition: DutyReconcileDisposition::Failed,
                        detail: format!("cannot inspect launchd loaded state: {error}"),
                    });
                }
            }
            match disabled(&candidate.label) {
                Ok(value) => {
                    disabled_states.insert(candidate.label.clone(), value);
                }
                Err(error) => {
                    probe_failed = true;
                    records.push(DutyReconcileRecord {
                        label: candidate.label.clone(),
                        disposition: DutyReconcileDisposition::Failed,
                        detail: format!("cannot inspect launchd disabled state: {error}"),
                    });
                }
            }
        }
        if probe_failed {
            continue;
        }

        let mut terminal_reasons = BTreeMap::new();
        for candidate in &group {
            if let Some(reason) =
                duty_blocked_reason_for_generation(home, &candidate.label, &candidate.generation)
            {
                terminal_reasons.insert(candidate.label.clone(), reason);
            } else if disabled_states.get(&candidate.label) == Some(&true) {
                terminal_reasons.insert(candidate.label.clone(), "launchd-disabled".to_string());
            }
        }

        // terminal marker / launchctl disable 的候选永不参与 winner。若旧 bootout 曾失败而它仍
        // loaded，先再次卸载并二次 probe；确认不了就禁止本频道再 bootstrap 新 job。
        let mut terminal_still_loaded = false;
        for candidate in &group {
            let Some(reason) = terminal_reasons.get(&candidate.label) else {
                continue;
            };
            if loaded_states.get(&candidate.label) == Some(&true) {
                match bootout(&candidate.label) {
                    Ok(()) => match loaded(&candidate.label) {
                        Ok(false) => {
                            loaded_states.insert(candidate.label.clone(), false);
                            records.push(DutyReconcileRecord {
                                label: candidate.label.clone(),
                                disposition: DutyReconcileDisposition::TerminalBlocked,
                                detail: format!("honored terminal stop state: {reason}"),
                            });
                        }
                        Ok(true) => {
                            terminal_still_loaded = true;
                            records.push(DutyReconcileRecord {
                                label: candidate.label.clone(),
                                disposition: DutyReconcileDisposition::Failed,
                                detail: format!(
                                    "terminal stop state exists ({reason}) but job is still loaded after bootout"
                                ),
                            });
                        }
                        Err(error) => {
                            terminal_still_loaded = true;
                            records.push(DutyReconcileRecord {
                                label: candidate.label.clone(),
                                disposition: DutyReconcileDisposition::Failed,
                                detail: format!(
                                    "terminal stop state exists ({reason}) but bootout verification failed: {error}"
                                ),
                            });
                        }
                    },
                    Err(error) => {
                        terminal_still_loaded = true;
                        records.push(DutyReconcileRecord {
                            label: candidate.label.clone(),
                            disposition: DutyReconcileDisposition::Failed,
                            detail: format!(
                                "terminal stop state exists ({reason}) but job could not be unloaded: {error}"
                            ),
                        });
                    }
                }
            } else {
                records.push(DutyReconcileRecord {
                    label: candidate.label.clone(),
                    disposition: DutyReconcileDisposition::TerminalBlocked,
                    detail: format!("terminal stop state: {reason}"),
                });
            }
        }

        // legacy/损坏 plist 若还 loaded 则不打断已有服务；但它们没 generation，无法证明旧
        // sidecar 会写终局 marker，所以一旦 unloaded 只提示显式 repair，绝不自动复活。
        for candidate in &group {
            if terminal_reasons.contains_key(&candidate.label)
                || loaded_states.get(&candidate.label) == Some(&true)
            {
                continue;
            }
            if let Some(reason) = candidate.generation.recovery_block() {
                records.push(DutyReconcileRecord {
                    label: candidate.label.clone(),
                    disposition: DutyReconcileDisposition::TerminalBlocked,
                    detail: format!("automatic recovery blocked: {reason}"),
                });
            }
        }

        let mut eligible = group
            .iter()
            .filter(|candidate| {
                !terminal_reasons.contains_key(&candidate.label)
                    && (loaded_states.get(&candidate.label) == Some(&true)
                        || matches!(candidate.generation, DutyGeneration::Managed(_)))
            })
            .cloned()
            .collect::<Vec<_>>();
        eligible.sort_by(|left, right| {
            let left_loaded = loaded_states.get(&left.label) == Some(&true);
            let right_loaded = loaded_states.get(&right.label) == Some(&true);
            let generation_rank = |candidate: &DutyCandidate| match &candidate.generation {
                DutyGeneration::Managed(_) => 2u8,
                DutyGeneration::Legacy => 1u8,
                DutyGeneration::Unreadable(_) => 0u8,
            };
            left_loaded
                .cmp(&right_loaded)
                .then_with(|| generation_rank(left).cmp(&generation_rank(right)))
                .then_with(|| left.modified_at.cmp(&right.modified_at))
                .then_with(|| left.label.cmp(&right.label))
        });
        let Some(winner) = eligible.pop() else {
            continue;
        };

        let winner_was_loaded = loaded_states.get(&winner.label) == Some(&true);
        if !winner_was_loaded {
            if terminal_still_loaded {
                records.push(DutyReconcileRecord {
                    label: winner.label,
                    disposition: DutyReconcileDisposition::Failed,
                    detail:
                        "refusing to bootstrap while a terminal-blocked duplicate may still be loaded"
                            .to_string(),
                });
                continue;
            }
            if let Err(error) = bootstrap(&winner.label, &winner.plist_path) {
                records.push(DutyReconcileRecord {
                    label: winner.label,
                    disposition: DutyReconcileDisposition::Failed,
                    detail: format!("launchctl bootstrap failed: {error}"),
                });
                continue;
            }
            let mut visible = false;
            let mut verify_error = None;
            for attempt in 0..10 {
                match loaded(&winner.label) {
                    Ok(true) => {
                        visible = true;
                        break;
                    }
                    Ok(false) => {}
                    Err(error) => {
                        verify_error = Some(error);
                        break;
                    }
                }
                if attempt < 9 {
                    sleep(Duration::from_millis(200));
                }
            }
            if !visible {
                records.push(DutyReconcileRecord {
                    label: winner.label,
                    disposition: DutyReconcileDisposition::Failed,
                    detail: verify_error.map_or_else(
                        || "bootstrap succeeded but launchd job is still not loaded".to_string(),
                        |error| format!("cannot verify launchd job after bootstrap: {error}"),
                    ),
                });
                continue;
            }
            // 新 sidecar 可能启动即触发 auth/circuit 终局退出并写 marker。清理 duplicates 前再
            // 查一次；若它已经终局停机，就绝不把它当 winner。
            if let Some(reason) =
                duty_blocked_reason_for_generation(home, &winner.label, &winner.generation)
            {
                let _ = bootout(&winner.label);
                records.push(DutyReconcileRecord {
                    label: winner.label,
                    disposition: DutyReconcileDisposition::TerminalBlocked,
                    detail: format!("duty entered terminal stop during recovery: {reason}"),
                });
                continue;
            }
            loaded_states.insert(winner.label.clone(), true);
        }

        records.push(DutyReconcileRecord {
            label: winner.label.clone(),
            disposition: if winner_was_loaded {
                DutyReconcileDisposition::Healthy
            } else {
                DutyReconcileDisposition::Reloaded
            },
            detail: if winner_was_loaded {
                "kept the already-loaded channel duty as winner".to_string()
            } else {
                "reloaded missing launchd job from persisted plist".to_string()
            },
        });

        // winner 已确认 loaded 后才清理其它同实例 plist。每个 loser 必须 bootout + 二次
        // probe 明确 false 才能移出扫描目录；archive 失败则保留原 plist 并记 Failed。
        for candidate in group
            .iter()
            .filter(|candidate| candidate.label != winner.label)
        {
            if loaded_states.get(&candidate.label) == Some(&true) {
                if let Err(error) = bootout(&candidate.label) {
                    records.push(DutyReconcileRecord {
                        label: candidate.label.clone(),
                        disposition: DutyReconcileDisposition::Failed,
                        detail: format!(
                            "cannot unload duplicate channel duty before archiving: {error}"
                        ),
                    });
                    continue;
                }
                match loaded(&candidate.label) {
                    Ok(false) => {
                        loaded_states.insert(candidate.label.clone(), false);
                    }
                    Ok(true) => {
                        records.push(DutyReconcileRecord {
                            label: candidate.label.clone(),
                            disposition: DutyReconcileDisposition::Failed,
                            detail:
                                "duplicate duty is still loaded after bootout; plist was preserved"
                                    .to_string(),
                        });
                        continue;
                    }
                    Err(error) => {
                        records.push(DutyReconcileRecord {
                            label: candidate.label.clone(),
                            disposition: DutyReconcileDisposition::Failed,
                            detail: format!(
                                "cannot verify duplicate duty after bootout; plist was preserved: {error}"
                            ),
                        });
                        continue;
                    }
                }
            }
            match archive(&candidate.label, &candidate.plist_path, &winner.label) {
                Ok(destination) => records.push(DutyReconcileRecord {
                    label: candidate.label.clone(),
                    disposition: DutyReconcileDisposition::Superseded,
                    detail: format!(
                        "archived duplicate channel duty {} -> {}; winner is {}",
                        candidate.plist_path.display(),
                        destination.display(),
                        winner.label
                    ),
                }),
                Err(error) => records.push(DutyReconcileRecord {
                    label: candidate.label.clone(),
                    disposition: DutyReconcileDisposition::Failed,
                    detail: format!(
                        "duplicate duty is unloaded but its plist could not be archived: {error}"
                    ),
                }),
            }
        }
    }
    Ok(records)
}

#[cfg(all(desktop, target_os = "macos"))]
fn append_duty_reconcile_log(home: &Path, record: &DutyReconcileRecord) {
    if matches!(
        record.disposition,
        DutyReconcileDisposition::Healthy | DutyReconcileDisposition::TerminalBlocked
    ) {
        return;
    }
    let path = duty_log_path(home, &record.label);
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(
            file,
            "desktop duty reconcile: ts={timestamp} state={:?} {}",
            record.disposition, record.detail
        );
    }
}

#[cfg(all(desktop, target_os = "macos"))]
fn archive_superseded_plist(
    home: &Path,
    label: &str,
    plist_path: &Path,
) -> Result<PathBuf, String> {
    let dir = home.join(".agentparty/desktop/superseded-duty-plists");
    fs::create_dir_all(&dir)
        .map_err(|error| format!("cannot create superseded duty archive: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("cannot secure superseded duty archive: {error}"))?;
    }
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let destination = dir.join(format!("{label}.{timestamp}.plist"));
    fs::rename(plist_path, &destination)
        .map_err(|error| format!("cannot archive {}: {error}", plist_path.display()))?;
    Ok(destination)
}

#[cfg(all(desktop, target_os = "macos"))]
fn reconcile_duties() -> Result<Vec<DutyReconcileRecord>, String> {
    let Some(_operation) = DutyOperationGuard::try_acquire() else {
        // persist/unpersist owns the launchd transaction; the next 30s tick will reconcile.
        return Ok(Vec::new());
    };
    let home = home_dir()?;
    let domain = gui_domain();
    let disabled_labels = duty_disabled_labels_checked()?;
    let records = reconcile_duties_with(
        &home,
        duty_loaded_checked,
        |label| Ok(disabled_labels.contains(label)),
        |label| {
            let _filesystem_lock = acquire_duty_filesystem_lock_blocking(&home, label)?;
            launchctl_action(
                &["bootout", &format!("{domain}/{label}")],
                "launchctl reconcile bootout",
            )
        },
        |label, path| {
            let _filesystem_lock = acquire_duty_filesystem_lock_blocking(&home, label)?;
            launchctl_action(
                &["bootstrap", &domain, &path.to_string_lossy()],
                "launchctl reconcile bootstrap",
            )
        },
        |label, path, _winner| {
            let _filesystem_lock = acquire_duty_filesystem_lock_blocking(&home, label)?;
            archive_superseded_plist(&home, label, path)
        },
        std::thread::sleep,
    )?;
    for record in &records {
        append_duty_reconcile_log(&home, record);
        if matches!(
            record.disposition,
            DutyReconcileDisposition::Reloaded | DutyReconcileDisposition::Failed
        ) {
            eprintln!(
                "AgentParty duty reconcile {:?} {}: {}",
                record.disposition, record.label, record.detail
            );
        }
    }
    Ok(records)
}

/// App 启动立即 reconcile，并在 App 存活时定期复查。launchd 自身能拉起普通崩溃，但无法
/// 修复外部 bootout；这个低频控制环负责填上「plist 在盘、job 不在」的静默空洞。
#[cfg(all(desktop, target_os = "macos"))]
pub(crate) fn start_duty_reconciler() {
    std::thread::spawn(|| loop {
        if let Err(error) = reconcile_duties() {
            eprintln!("AgentParty duty reconcile failed: {error}");
        }
        std::thread::sleep(DUTY_RECONCILE_INTERVAL);
    });
}

#[cfg(test)]
mod tests {
    use super::{
        conflicting_duty_labels, duty_blocked_marker_path, duty_plist_path,
        launchctl_disabled_labels_from_text, launchctl_print_loaded, reconcile_duties_with,
        DutyReconcileDisposition,
    };
    use crate::duty::duty_label;

    fn write_test_config(
        home: &std::path::Path,
        name: &str,
        server: &str,
        token: &str,
    ) -> std::path::PathBuf {
        let path = home
            .join(".agentparty/test-configs")
            .join(format!("{name}.json"));
        std::fs::create_dir_all(path.parent().expect("config parent")).expect("config dir");
        std::fs::write(
            &path,
            serde_json::to_vec(&serde_json::json!({
                "server": server,
                "token": token,
            }))
            .expect("config json"),
        )
        .expect("config");
        path
    }

    fn write_test_plist_with_identity(
        home: &std::path::Path,
        label: &str,
        config_name: &str,
        server: &str,
        token: &str,
        generation: Option<&str>,
    ) {
        let path = duty_plist_path(home, label);
        std::fs::create_dir_all(path.parent().expect("plist parent")).expect("LaunchAgents");
        let config_path = write_test_config(home, config_name, server, token);
        let generation = generation
            .map(|value| format!("<key>AP_DUTY_GENERATION</key>\n<string>{value}</string>\n"))
            .unwrap_or_default();
        std::fs::write(
            path,
            format!(
                "<key>AGENTPARTY_CONFIG</key>\n<string>{}</string>\n{generation}",
                config_path.display()
            ),
        )
        .expect("duty plist");
    }

    fn write_test_plist(home: &std::path::Path, label: &str) {
        write_test_plist_with_identity(
            home,
            label,
            "shared",
            "https://party.example.com",
            "ap_shared",
            Some("test-install"),
        );
    }

    #[test]
    fn reloads_unmarked_missing_job_and_verifies_loaded() {
        use std::cell::{Cell, RefCell};

        let temp = tempfile::tempdir().expect("tempdir");
        let label = duty_label("abc:ops");
        write_test_plist(temp.path(), &label);
        let loaded = Cell::new(false);
        let bootstraps = RefCell::new(Vec::new());
        let records = reconcile_duties_with(
            temp.path(),
            |_| Ok(loaded.get()),
            |_| Ok(false),
            |_| panic!("healthy single candidate must not bootout"),
            |candidate, path| {
                bootstraps
                    .borrow_mut()
                    .push((candidate.to_string(), path.to_path_buf()));
                loaded.set(true);
                Ok(())
            },
            |_, _, _| panic!("single duty must not be archived"),
            |_| {},
        )
        .expect("reconcile");

        assert_eq!(bootstraps.borrow().len(), 1);
        assert_eq!(bootstraps.borrow()[0].0, label);
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].disposition, DutyReconcileDisposition::Reloaded);
    }

    #[test]
    fn honors_terminal_marker_and_never_bootstraps() {
        use std::cell::Cell;

        let temp = tempfile::tempdir().expect("tempdir");
        let label = duty_label("abc:ops");
        write_test_plist(temp.path(), &label);
        let marker = duty_blocked_marker_path(temp.path(), &label);
        std::fs::create_dir_all(marker.parent().expect("marker parent")).expect("marker dir");
        std::fs::write(
            marker,
            format!(
                "{{\"schema\":\"agentparty.duty-blocked.v1\",\"label\":\"{label}\",\"reason\":\"auth-revoked\",\"code\":4,\"generation\":\"test-install\"}}\n"
            ),
        )
        .expect("marker");
        let bootstrapped = Cell::new(false);
        let records = reconcile_duties_with(
            temp.path(),
            |_| Ok(false),
            |_| Ok(false),
            |_| panic!("already unloaded terminal duty must not bootout"),
            |_, _| {
                bootstrapped.set(true);
                Ok(())
            },
            |_, _, _| panic!("single terminal duty must not be archived"),
            |_| {},
        )
        .expect("reconcile");

        assert!(!bootstrapped.get());
        assert_eq!(records.len(), 1);
        assert_eq!(
            records[0].disposition,
            DutyReconcileDisposition::TerminalBlocked
        );
        assert!(records[0].detail.contains("auth-revoked"));
    }

    #[test]
    fn corrupt_terminal_marker_fails_closed() {
        use std::cell::Cell;

        let temp = tempfile::tempdir().expect("tempdir");
        let label = duty_label("abc:ops");
        write_test_plist(temp.path(), &label);
        let marker = duty_blocked_marker_path(temp.path(), &label);
        std::fs::create_dir_all(marker.parent().expect("marker parent")).expect("marker dir");
        std::fs::write(marker, b"partial-json").expect("marker");
        let bootstrapped = Cell::new(false);
        let records = reconcile_duties_with(
            temp.path(),
            |_| Ok(false),
            |_| Ok(false),
            |_| Ok(()),
            |_, _| {
                bootstrapped.set(true);
                Ok(())
            },
            |_, _, _| panic!("single terminal duty must not be archived"),
            |_| {},
        )
        .expect("reconcile");

        assert!(!bootstrapped.get());
        assert_eq!(
            records[0].disposition,
            DutyReconcileDisposition::TerminalBlocked
        );
        assert!(records[0].detail.contains("marker-invalid"));
    }

    #[test]
    fn stale_terminal_marker_from_previous_install_generation_is_ignored() {
        use std::cell::Cell;

        let temp = tempfile::tempdir().expect("tempdir");
        let label = duty_label("abc:ops");
        write_test_plist_with_identity(
            temp.path(),
            &label,
            "shared",
            "https://party.example.com",
            "ap_shared",
            Some("new-install"),
        );
        let marker = duty_blocked_marker_path(temp.path(), &label);
        std::fs::create_dir_all(marker.parent().expect("marker parent")).expect("marker dir");
        std::fs::write(
            marker,
            format!(
                "{{\"schema\":\"agentparty.duty-blocked.v1\",\"label\":\"{label}\",\"reason\":\"auth-revoked\",\"generation\":\"old-install\"}}\n"
            ),
        )
        .expect("marker");
        let loaded = Cell::new(false);
        let bootstrapped = Cell::new(false);
        let records = reconcile_duties_with(
            temp.path(),
            |_| Ok(loaded.get()),
            |_| Ok(false),
            |_| Ok(()),
            |_, _| {
                bootstrapped.set(true);
                loaded.set(true);
                Ok(())
            },
            |_, _, _| panic!("single duty must not be archived"),
            |_| {},
        )
        .expect("reconcile");

        assert!(bootstrapped.get());
        assert_eq!(records[0].disposition, DutyReconcileDisposition::Reloaded);
    }

    #[test]
    fn unloads_older_duplicate_and_keeps_one_channel_winner() {
        use std::{cell::RefCell, collections::BTreeMap, thread, time::Duration};

        let temp = tempfile::tempdir().expect("tempdir");
        let older = duty_label("aaa:ops");
        let winner = duty_label("zzz:ops");
        write_test_plist(temp.path(), &older);
        thread::sleep(Duration::from_millis(5));
        write_test_plist(temp.path(), &winner);
        let states = RefCell::new(BTreeMap::from([
            (older.clone(), true),
            (winner.clone(), true),
        ]));
        let unloaded = RefCell::new(Vec::new());
        let records = reconcile_duties_with(
            temp.path(),
            |label| Ok(*states.borrow().get(label).unwrap_or(&false)),
            |_| Ok(false),
            |label| {
                states.borrow_mut().insert(label.to_string(), false);
                unloaded.borrow_mut().push(label.to_string());
                Ok(())
            },
            |_, _| panic!("loaded winner must not bootstrap"),
            |_, path, _| {
                let destination = path.with_extension("archived");
                std::fs::rename(path, &destination).expect("archive duplicate");
                Ok(destination)
            },
            |_| {},
        )
        .expect("reconcile");

        assert_eq!(unloaded.into_inner(), vec![older.clone()]);
        assert_eq!(
            records
                .iter()
                .find(|record| record.label == older)
                .expect("older record")
                .disposition,
            DutyReconcileDisposition::Superseded
        );
        assert_eq!(
            records
                .iter()
                .find(|record| record.label == winner)
                .expect("winner record")
                .disposition,
            DutyReconcileDisposition::Healthy
        );
    }

    #[test]
    fn legacy_unloaded_duty_requires_explicit_repair_and_never_bootstraps() {
        use std::cell::Cell;

        let temp = tempfile::tempdir().expect("tempdir");
        let label = duty_label("legacy:ops");
        write_test_plist_with_identity(
            temp.path(),
            &label,
            "legacy",
            "https://party.example.com",
            "ap_legacy",
            None,
        );
        let bootstrapped = Cell::new(false);

        let records = reconcile_duties_with(
            temp.path(),
            |_| Ok(false),
            |_| Ok(false),
            |_| panic!("unloaded legacy duty must not bootout"),
            |_, _| {
                bootstrapped.set(true);
                Ok(())
            },
            |_, _, _| panic!("single legacy duty must remain visible for repair"),
            |_| {},
        )
        .expect("reconcile");

        assert!(!bootstrapped.get());
        assert_eq!(records.len(), 1);
        assert_eq!(
            records[0].disposition,
            DutyReconcileDisposition::TerminalBlocked
        );
        assert!(records[0].detail.contains("legacy-duty-needs-repair"));
    }

    #[test]
    fn already_loaded_older_job_beats_newer_unloaded_plist() {
        use std::{cell::RefCell, collections::BTreeMap, thread, time::Duration};

        let temp = tempfile::tempdir().expect("tempdir");
        let healthy = duty_label("healthy:ops");
        let broken_newer = duty_label("broken:ops");
        write_test_plist(temp.path(), &healthy);
        thread::sleep(Duration::from_millis(5));
        write_test_plist(temp.path(), &broken_newer);
        let states = RefCell::new(BTreeMap::from([
            (healthy.clone(), true),
            (broken_newer.clone(), false),
        ]));
        let archived = RefCell::new(Vec::new());

        let records = reconcile_duties_with(
            temp.path(),
            |label| Ok(*states.borrow().get(label).unwrap_or(&false)),
            |_| Ok(false),
            |_| panic!("healthy winner and unloaded loser need no bootout"),
            |_, _| panic!("newer unloaded plist must not replace healthy loaded job"),
            |label, path, _| {
                let destination = path.with_extension("archived");
                std::fs::rename(path, &destination).expect("archive newer loser");
                archived.borrow_mut().push(label.to_string());
                Ok(destination)
            },
            |_| {},
        )
        .expect("reconcile");

        assert_eq!(archived.into_inner(), vec![broken_newer.clone()]);
        assert_eq!(
            records
                .iter()
                .find(|record| record.label == healthy)
                .expect("healthy record")
                .disposition,
            DutyReconcileDisposition::Healthy
        );
        assert_eq!(
            records
                .iter()
                .find(|record| {
                    record.label == broken_newer
                        && record.disposition == DutyReconcileDisposition::Superseded
                })
                .expect("superseded newer record")
                .disposition,
            DutyReconcileDisposition::Superseded
        );
    }

    #[test]
    fn unreadable_identity_is_preserved_without_guessing_it_is_a_duplicate() {
        use std::{cell::RefCell, collections::BTreeMap, thread, time::Duration};

        let temp = tempfile::tempdir().expect("tempdir");
        let managed = duty_label("managed:ops");
        let unreadable = duty_label("corrupt:ops");
        write_test_plist(temp.path(), &managed);
        thread::sleep(Duration::from_millis(5));
        let unreadable_path = duty_plist_path(temp.path(), &unreadable);
        std::fs::write(&unreadable_path, [0xff, 0xfe]).expect("invalid utf8 plist");
        let states = RefCell::new(BTreeMap::from([
            (managed.clone(), true),
            (unreadable.clone(), true),
        ]));

        let records = reconcile_duties_with(
            temp.path(),
            |label| Ok(*states.borrow().get(label).unwrap_or(&false)),
            |_| Ok(false),
            |_| panic!("unknown identity must not be booted out"),
            |_, _| panic!("managed loaded winner must not bootstrap"),
            |_, _, _| panic!("unknown identity must not be archived"),
            |_| {},
        )
        .expect("reconcile");

        assert_eq!(
            records
                .iter()
                .find(|record| record.label == managed)
                .expect("managed winner")
                .disposition,
            DutyReconcileDisposition::Healthy
        );
        assert!(records.iter().any(|record| {
            record.label == unreadable && record.disposition == DutyReconcileDisposition::Failed
        }));
        assert!(duty_plist_path(temp.path(), &unreadable).exists());
    }

    #[test]
    fn disabled_loaded_job_is_terminal_and_cannot_be_winner() {
        use std::cell::{Cell, RefCell};

        let temp = tempfile::tempdir().expect("tempdir");
        let label = duty_label("disabled:ops");
        write_test_plist(temp.path(), &label);
        let loaded = Cell::new(true);
        let bootouts = RefCell::new(Vec::new());

        let records = reconcile_duties_with(
            temp.path(),
            |_| Ok(loaded.get()),
            |_| Ok(true),
            |candidate| {
                bootouts.borrow_mut().push(candidate.to_string());
                loaded.set(false);
                Ok(())
            },
            |_, _| panic!("disabled duty must never bootstrap"),
            |_, _, _| panic!("single terminal duty remains visible for repair"),
            |_| {},
        )
        .expect("reconcile");

        assert_eq!(bootouts.into_inner(), vec![label]);
        assert_eq!(records.len(), 1);
        assert_eq!(
            records[0].disposition,
            DutyReconcileDisposition::TerminalBlocked
        );
        assert!(records[0].detail.contains("launchd-disabled"));
    }

    #[test]
    fn archive_failure_preserves_unloaded_loser_plist() {
        use std::{cell::RefCell, collections::BTreeMap, thread, time::Duration};

        let temp = tempfile::tempdir().expect("tempdir");
        let loser = duty_label("loser:ops");
        let winner = duty_label("winner:ops");
        write_test_plist(temp.path(), &loser);
        thread::sleep(Duration::from_millis(5));
        write_test_plist(temp.path(), &winner);
        let states = RefCell::new(BTreeMap::from([
            (loser.clone(), true),
            (winner.clone(), true),
        ]));

        let records = reconcile_duties_with(
            temp.path(),
            |label| Ok(*states.borrow().get(label).unwrap_or(&false)),
            |_| Ok(false),
            |label| {
                states.borrow_mut().insert(label.to_string(), false);
                Ok(())
            },
            |_, _| panic!("loaded winner must not bootstrap"),
            |_, _, _| Err("archive read-only".to_string()),
            |_| {},
        )
        .expect("reconcile");

        assert!(duty_plist_path(temp.path(), &loser).exists());
        assert!(records.iter().any(|record| {
            record.label == loser && record.disposition == DutyReconcileDisposition::Failed
        }));
    }

    #[test]
    fn launchctl_state_parsing_distinguishes_absent_from_real_errors() {
        assert_eq!(launchctl_print_loaded(true, Some(0), "").unwrap(), true);
        assert_eq!(
            launchctl_print_loaded(
                false,
                Some(113),
                "Bad request.\nCould not find service \"x\" in domain for user gui: 501",
            )
            .unwrap(),
            false
        );
        assert!(launchctl_print_loaded(
            false,
            Some(125),
            "Domain does not support specified action"
        )
        .is_err());
        assert!(launchctl_print_loaded(false, Some(113), "permission denied").is_err());

        let disabled = launchctl_disabled_labels_from_text(
            "disabled services = {\n  \"com.agentparty.duty.a.ops\" => disabled\n  \"other\" => enabled\n}\n",
        );
        assert!(disabled.contains("com.agentparty.duty.a.ops"));
        assert!(!disabled.contains("other"));
    }

    #[test]
    fn persist_guard_only_conflicts_with_same_identity_and_channel() {
        let temp = tempfile::tempdir().expect("tempdir");
        let target = duty_label("target:ops");
        let same_identity = duty_label("same:ops");
        let other_identity = duty_label("other:ops");
        let other_channel = duty_label("other:dev");
        let target_config = write_test_config(
            temp.path(),
            "target",
            "https://party.example.com",
            "ap_same",
        );
        write_test_plist_with_identity(
            temp.path(),
            &same_identity,
            "same",
            "https://party.example.com",
            "ap_same",
            Some("same"),
        );
        write_test_plist_with_identity(
            temp.path(),
            &other_identity,
            "other",
            "https://party.example.com",
            "ap_other",
            Some("other"),
        );
        write_test_plist_with_identity(
            temp.path(),
            &other_channel,
            "same-dev",
            "https://party.example.com",
            "ap_same",
            Some("same-dev"),
        );

        assert_eq!(
            conflicting_duty_labels(temp.path(), &target, &target_config, "ops")
                .expect("conflicts"),
            vec![same_identity]
        );
        assert!(
            conflicting_duty_labels(temp.path(), &target, &target_config, "qa")
                .expect("no conflict")
                .is_empty()
        );
    }

    #[test]
    fn distinct_identities_on_same_channel_are_reconciled_independently() {
        use std::{cell::RefCell, collections::BTreeMap};

        let temp = tempfile::tempdir().expect("tempdir");
        let alice = duty_label("alice:ops");
        let bob = duty_label("bob:ops");
        write_test_plist_with_identity(
            temp.path(),
            &alice,
            "alice",
            "https://party.example.com",
            "ap_alice",
            Some("alice"),
        );
        write_test_plist_with_identity(
            temp.path(),
            &bob,
            "bob",
            "https://party.example.com",
            "ap_bob",
            Some("bob"),
        );
        let states = RefCell::new(BTreeMap::from([(alice.clone(), true), (bob.clone(), true)]));

        let records = reconcile_duties_with(
            temp.path(),
            |label| Ok(*states.borrow().get(label).unwrap_or(&false)),
            |_| Ok(false),
            |_| panic!("different identities must not boot each other out"),
            |_, _| panic!("both identities are already loaded"),
            |_, _, _| panic!("different identities must not archive each other"),
            |_| {},
        )
        .expect("reconcile");

        assert_eq!(
            records
                .iter()
                .filter(|record| record.disposition == DutyReconcileDisposition::Healthy)
                .count(),
            2
        );
    }

    #[test]
    fn persist_guard_fails_closed_when_same_channel_identity_is_unreadable() {
        let temp = tempfile::tempdir().expect("tempdir");
        let target = duty_label("target:ops");
        let unknown = duty_label("unknown:ops");
        let target_config = write_test_config(
            temp.path(),
            "target",
            "https://party.example.com",
            "ap_target",
        );
        let unknown_plist = duty_plist_path(temp.path(), &unknown);
        std::fs::create_dir_all(unknown_plist.parent().expect("plist parent"))
            .expect("LaunchAgents");
        std::fs::write(
            unknown_plist,
            b"<key>AGENTPARTY_CONFIG</key><string>/missing/config.json</string>",
        )
        .expect("unknown plist");

        let error = conflicting_duty_labels(temp.path(), &target, &target_config, "ops")
            .expect_err("unknown same-channel identity must fail closed");
        assert!(error.contains(&unknown));
        assert!(error.contains("repair or remove"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn duty_lock_process_probe_is_locale_stable_and_unknown_fails_closed() {
        use super::{process_identity_is_stale, process_start_identity, ProcessStartIdentity};

        let ProcessStartIdentity::Alive(started_at) = process_start_identity(std::process::id())
        else {
            panic!("current process must be positively identified");
        };
        assert!(
            ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
                .iter()
                .any(|weekday| started_at.starts_with(weekday)),
            "ps start identity must use the shared C locale: {started_at}"
        );
        assert!(!process_identity_is_stale(
            &ProcessStartIdentity::Unknown,
            &started_at
        ));
        assert!(process_identity_is_stale(
            &ProcessStartIdentity::Dead,
            &started_at
        ));
        assert!(!process_identity_is_stale(
            &ProcessStartIdentity::Alive(started_at.clone()),
            &started_at
        ));
        assert!(process_identity_is_stale(
            &ProcessStartIdentity::Alive("different-start".to_string()),
            &started_at
        ));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn duty_lock_process_probe_timeout_kills_and_reaps_child() {
        use super::command_output_with_timeout;
        use std::{
            process::Command,
            time::{Duration, Instant},
        };

        let mut command = Command::new("/bin/sleep");
        command.arg("5");
        let started = Instant::now();
        assert!(
            command_output_with_timeout(&mut command, Duration::from_millis(25)).is_none(),
            "timed-out probe must not report process output"
        );
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "timed-out probe must kill and reap the child promptly"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn internal_reclaim_claim_pins_old_inode_until_recheck_finishes() {
        use super::try_reclaim_stale_duty_lock_with;

        let temp = tempfile::tempdir().expect("tempdir");
        let lock_path = temp.path().join("duty.lock");
        std::fs::create_dir(&lock_path).expect("old canonical lock");
        std::fs::write(lock_path.join("owner"), "old-stale-owner").expect("old owner");

        assert!(try_reclaim_stale_duty_lock_with(&lock_path, |_| {
            // 旧 owner 在回收者重判期间正常 release：内部 claim 令 remove_dir 失败，
            // 所以后来的 owner 还不能在 canonical pathname 发布新锁。
            std::fs::remove_file(lock_path.join("owner")).expect("old owner release");
            assert!(std::fs::remove_dir(&lock_path).is_err());
            assert!(std::fs::create_dir(&lock_path).is_err());
            true
        })
        .expect("stale reclaim"));

        std::fs::create_dir(&lock_path).expect("new canonical lock");
        std::fs::write(lock_path.join("owner"), "new-live-owner").expect("new owner");
        assert_eq!(
            std::fs::read_to_string(lock_path.join("owner")).expect("preserved owner"),
            "new-live-owner"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn initializer_publication_loses_to_an_already_decided_reclaimer() {
        use super::{
            try_reclaim_stale_duty_lock_with, wait_for_duty_lock_publication,
            write_private_new_file,
        };
        use std::{os::unix::fs::MetadataExt as _, sync::mpsc};

        let temp = tempfile::tempdir().expect("tempdir");
        let lock_path = temp.path().join("duty.lock");
        std::fs::create_dir(&lock_path).expect("ownerless canonical");
        let (stale_read_tx, stale_read_rx) = mpsc::channel();
        let (publish_tx, publish_rx) = mpsc::channel();
        let reclaim_path = lock_path.clone();
        let reclaimer = std::thread::spawn(move || {
            try_reclaim_stale_duty_lock_with(&reclaim_path, |_| {
                stale_read_tx.send(()).expect("stale decision ready");
                publish_rx.recv().expect("initializer published");
                true
            })
            .expect("reclaim result")
        });

        stale_read_rx
            .recv()
            .expect("reclaimer holds internal claim");
        assert!(lock_path.join(".reclaim").exists());
        let owner = format!("{}|late-initializer|token", std::process::id());
        write_private_new_file(&lock_path.join("owner"), &owner).expect("late owner publish");
        let metadata = std::fs::metadata(&lock_path).expect("published canonical");
        let identity = (metadata.dev(), metadata.ino());
        publish_tx.send(()).expect("release reclaimer");

        let publication_won = wait_for_duty_lock_publication(&lock_path, &owner, identity);
        let reclaimed = reclaimer.join().expect("reclaimer thread");
        assert!(
            !publication_won,
            "publication escaped claim: reclaimed={reclaimed} path_exists={} claim_exists={}",
            lock_path.exists(),
            lock_path.join(".reclaim").exists()
        );
        assert!(reclaimed);
        assert!(!lock_path.exists());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn owner_publication_is_exclusive_for_lock_and_reclaim_claim() {
        use super::write_private_new_file;

        let temp = tempfile::tempdir().expect("tempdir");
        let owner_path = temp.path().join("owner");
        write_private_new_file(&owner_path, "winner").expect("first publisher");
        let error = write_private_new_file(&owner_path, "late-writer")
            .expect_err("late publisher must lose");
        assert_eq!(error.kind(), std::io::ErrorKind::AlreadyExists);
        assert_eq!(
            std::fs::read_to_string(owner_path).expect("winner preserved"),
            "winner"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn crashed_internal_reclaim_claim_is_recoverable() {
        use super::try_reclaim_stale_duty_lock_with;

        let temp = tempfile::tempdir().expect("tempdir");
        let lock_path = temp.path().join("duty.lock");
        let reclaim_path = lock_path.join(".reclaim");
        std::fs::create_dir(&lock_path).expect("canonical lock");
        std::fs::write(lock_path.join("owner"), "old-stale-owner").expect("old owner");
        std::fs::create_dir(&reclaim_path).expect("crashed claim");
        std::fs::write(
            reclaim_path.join("owner"),
            format!("{}|different-start|crashed", std::process::id()),
        )
        .expect("crashed claim owner");

        // 第一次只安全清掉 stale 内部 claim；下一轮再取得 claim 并回收 canonical。
        assert!(
            !try_reclaim_stale_duty_lock_with(&lock_path, |_| true).expect("clear crashed claim")
        );
        assert!(!reclaim_path.exists());
        assert!(try_reclaim_stale_duty_lock_with(&lock_path, |_| true).expect("reclaim canonical"));
        assert!(!lock_path.exists());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn deferred_release_cleans_canonical_after_live_claim_finishes() {
        use super::{try_acquire_duty_internal_claim, DutyFilesystemLock, ProcessStartIdentity};
        use std::os::unix::fs::MetadataExt as _;

        let temp = tempfile::tempdir().expect("tempdir");
        let lock_path = temp.path().join("duty.lock");
        std::fs::create_dir(&lock_path).expect("canonical lock");
        let owner = match super::process_start_identity(std::process::id()) {
            ProcessStartIdentity::Alive(started_at) => {
                format!("{}|{started_at}|deferred-release-test", std::process::id())
            }
            identity => panic!("current process must be identifiable: {identity:?}"),
        };
        std::fs::write(lock_path.join("owner"), &owner).expect("canonical owner");
        let metadata = std::fs::metadata(&lock_path).expect("canonical metadata");
        let identity = (metadata.dev(), metadata.ino());
        let live_claim = try_acquire_duty_internal_claim(&lock_path)
            .expect("claim attempt")
            .expect("live internal claim");

        drop(DutyFilesystemLock {
            path: lock_path.clone(),
            owner,
            device: identity.0,
            inode: identity.1,
        });
        assert!(
            lock_path.exists(),
            "live internal claim must pin canonical during synchronous release"
        );

        drop(live_claim);
        for _ in 0..200 {
            if !lock_path.exists() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert!(
            !lock_path.exists(),
            "deferred release must remove the owned canonical after the claim finishes"
        );
    }
}
