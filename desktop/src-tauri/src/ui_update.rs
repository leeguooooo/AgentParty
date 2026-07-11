use std::{
    collections::HashSet,
    fs::{self, OpenOptions},
    io::{self, Cursor, Read, Write},
    path::{Component, Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use flate2::read::GzDecoder;
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use time::{format_description::well_known::Rfc3339, OffsetDateTime};

pub const OFFICIAL_UI_MANIFEST_ENDPOINT: &str =
    "https://github.com/leeguooooo/agentparty/releases/download/desktop-ui/desktop-ui.json";
pub const SUPPORTED_MANIFEST_SCHEMA: u32 = 1;
pub const SUPPORTED_UI_ABI: u32 = 1;
pub const MAX_MANIFEST_ENVELOPE_BYTES: usize = 512 * 1024;
pub const MAX_MANIFEST_PAYLOAD_BYTES: usize = 256 * 1024;

const OFFICIAL_ARCHIVE_PREFIX: &str =
    "https://github.com/leeguooooo/agentparty/releases/download/desktop-ui/";
const UI_DIRECTORY: &str = "ui";
const METADATA_FILE: &str = "state.json";
static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct UiManifest {
    pub schema: u32,
    pub version: String,
    pub ui_abi: u32,
    pub min_shell_version: String,
    pub build_id: String,
    pub published_at: String,
    pub archive: UiArchive,
    #[serde(default = "default_entrypoint")]
    pub entrypoint: String,
}

fn default_entrypoint() -> String {
    "index.html".to_string()
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct UiArchive {
    pub name: String,
    pub url: String,
    #[serde(rename = "sizeBytes")]
    pub size_bytes: u64,
    #[serde(rename = "fileCount")]
    pub file_count: usize,
    pub sha256: String,
    pub signature: String,
}

impl UiManifest {
    pub fn signing_bytes(&self) -> Result<Vec<u8>, ManifestError> {
        serde_json::to_vec(self).map_err(|_| ManifestError::Invalid)
    }
}

#[derive(Clone, Debug)]
pub struct SignedUiManifest {
    manifest: UiManifest,
    signature: String,
    signed_bytes: Vec<u8>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SignedUiManifestEnvelope {
    payload: String,
    signature: String,
}

impl SignedUiManifest {
    pub fn new(manifest: UiManifest, signature: impl Into<String>) -> Result<Self, ManifestError> {
        let signed_bytes = manifest.signing_bytes()?;
        Ok(Self {
            manifest,
            signature: signature.into(),
            signed_bytes,
        })
    }

    pub fn parse(
        manifest_json: &[u8],
        signature: impl Into<String>,
    ) -> Result<Self, ManifestError> {
        Self::parse_signed_envelope(manifest_json, signature)
    }

    pub fn parse_signed_envelope(
        payload: &[u8],
        signature: impl Into<String>,
    ) -> Result<Self, ManifestError> {
        let manifest = serde_json::from_slice(payload).map_err(|_| ManifestError::Invalid)?;
        Ok(Self {
            manifest,
            signature: signature.into(),
            signed_bytes: payload.to_vec(),
        })
    }

    pub fn parse_envelope_json(envelope_json: &[u8]) -> Result<Self, ManifestError> {
        if envelope_json.len() > MAX_MANIFEST_ENVELOPE_BYTES {
            return Err(ManifestError::Invalid);
        }
        let envelope: SignedUiManifestEnvelope =
            serde_json::from_slice(envelope_json).map_err(|_| ManifestError::Invalid)?;
        if envelope.signature.trim().is_empty() {
            return Err(ManifestError::Invalid);
        }
        let payload = STANDARD
            .decode(envelope.payload.as_bytes())
            .map_err(|_| ManifestError::Invalid)?;
        if payload.is_empty() || payload.len() > MAX_MANIFEST_PAYLOAD_BYTES {
            return Err(ManifestError::Invalid);
        }
        Self::parse_signed_envelope(&payload, envelope.signature)
    }

    pub fn manifest(&self) -> &UiManifest {
        &self.manifest
    }

    pub fn verify_for_core<V: SignatureVerifier>(
        &self,
        shell_version: &str,
        ui_abi: u32,
        verifier: &V,
    ) -> Result<VerifiedManifest, ManifestError> {
        self.verify_for_core_with_limits(shell_version, ui_abi, verifier, &UpdateLimits::default())
    }

    pub fn verify_for_core_with_limits<V: SignatureVerifier>(
        &self,
        shell_version: &str,
        ui_abi: u32,
        verifier: &V,
        limits: &UpdateLimits,
    ) -> Result<VerifiedManifest, ManifestError> {
        let signed_manifest: UiManifest =
            serde_json::from_slice(&self.signed_bytes).map_err(|_| ManifestError::Signature)?;
        if signed_manifest != self.manifest
            || self.signature.trim().is_empty()
            || verifier
                .verify(&self.signed_bytes, &self.signature)
                .is_err()
        {
            return Err(ManifestError::Signature);
        }
        validate_manifest(&self.manifest, shell_version, ui_abi, limits)?;
        Ok(VerifiedManifest {
            manifest: self.manifest.clone(),
        })
    }
}

fn validate_manifest(
    manifest: &UiManifest,
    shell_version: &str,
    ui_abi: u32,
    limits: &UpdateLimits,
) -> Result<(), ManifestError> {
    if manifest.schema != SUPPORTED_MANIFEST_SCHEMA {
        return Err(ManifestError::UnsupportedSchema);
    }
    if manifest.ui_abi != ui_abi {
        return Err(ManifestError::IncompatibleUiAbi);
    }
    let current = Version::parse(shell_version).map_err(|_| ManifestError::InvalidCoreVersion)?;
    let minimum =
        Version::parse(&manifest.min_shell_version).map_err(|_| ManifestError::Invalid)?;
    Version::parse(&manifest.version).map_err(|_| ManifestError::Invalid)?;
    if current < minimum {
        return Err(ManifestError::IncompatibleCore);
    }
    if !valid_build_id(&manifest.build_id)
        || !valid_published_at(&manifest.published_at)
        || !valid_sha256(&manifest.archive.sha256)
        || manifest.archive.signature.trim().is_empty()
    {
        return Err(ManifestError::Invalid);
    }
    validate_relative_path(Path::new(&manifest.entrypoint)).map_err(|_| ManifestError::Invalid)?;
    let expected_name = format!("agentparty-desktop-ui-v{}.tar.gz", manifest.version);
    if manifest.archive.name != expected_name {
        return Err(ManifestError::Invalid);
    }
    let expected_url = format!("{OFFICIAL_ARCHIVE_PREFIX}{expected_name}");
    if manifest.archive.url != expected_url {
        return Err(ManifestError::UnofficialArchiveUrl);
    }
    if manifest.archive.size_bytes == 0 || manifest.archive.size_bytes > limits.max_download_bytes {
        return Err(ManifestError::DownloadTooLarge);
    }
    if manifest.archive.file_count == 0 || manifest.archive.file_count > limits.max_files {
        return Err(ManifestError::TooManyFiles);
    }
    Ok(())
}

fn valid_build_id(value: &str) -> bool {
    matches!(value.len(), 40 | 64)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn valid_published_at(value: &str) -> bool {
    OffsetDateTime::parse(value, &Rfc3339).is_ok()
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

pub trait SignatureVerifier {
    fn verify(&self, message: &[u8], signature: &str) -> Result<(), VerifyError>;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VerifyError {
    Signature,
}

#[derive(Clone, Debug)]
pub struct VerifiedManifest {
    manifest: UiManifest,
}

impl VerifiedManifest {
    pub fn build_id(&self) -> &str {
        &self.manifest.build_id
    }

    pub fn manifest(&self) -> &UiManifest {
        &self.manifest
    }

    pub fn verify_archive<V: SignatureVerifier>(
        &self,
        bytes: &[u8],
        verifier: &V,
    ) -> Result<VerifiedUpdate, ArchiveVerifyError> {
        if self.manifest.archive.size_bytes != bytes.len() as u64 {
            return Err(ArchiveVerifyError::Size);
        }
        if sha256_hex(bytes) != self.manifest.archive.sha256 {
            return Err(ArchiveVerifyError::Sha256);
        }
        if verifier
            .verify(bytes, &self.manifest.archive.signature)
            .is_err()
        {
            return Err(ArchiveVerifyError::Signature);
        }
        Ok(VerifiedUpdate {
            manifest: self.manifest.clone(),
        })
    }
}

#[derive(Clone, Debug)]
pub struct VerifiedUpdate {
    manifest: UiManifest,
}

impl VerifiedUpdate {
    pub fn build_id(&self) -> &str {
        &self.manifest.build_id
    }

    pub fn ui_abi(&self) -> u32 {
        self.manifest.ui_abi
    }
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct UpdateLimits {
    pub max_download_bytes: u64,
    pub max_files: usize,
    pub max_unpacked_bytes: u64,
}

impl Default for UpdateLimits {
    fn default() -> Self {
        Self {
            max_download_bytes: 32 * 1024 * 1024,
            max_files: 4_096,
            max_unpacked_bytes: 128 * 1024 * 1024,
        }
    }
}

pub fn read_download<R: Read>(
    reader: R,
    content_length: Option<u64>,
    limits: &UpdateLimits,
) -> Result<Vec<u8>, DownloadError> {
    if content_length.is_some_and(|size| size > limits.max_download_bytes) {
        return Err(DownloadError::TooLarge);
    }
    let mut bytes = Vec::new();
    reader
        .take(limits.max_download_bytes.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|_| DownloadError::Io)?;
    if bytes.len() as u64 > limits.max_download_bytes {
        return Err(DownloadError::TooLarge);
    }
    if content_length.is_some_and(|size| size != bytes.len() as u64) {
        return Err(DownloadError::LengthMismatch);
    }
    Ok(bytes)
}

pub fn extract_verified_archive(
    update: &VerifiedUpdate,
    bytes: &[u8],
    destination: &Path,
    limits: &UpdateLimits,
) -> Result<(), ExtractError> {
    if sha256_hex(bytes) != update.manifest.archive.sha256 {
        return Err(ExtractError::UnverifiedArchive);
    }
    let file_count = extract_archive_inner(bytes, destination, limits)?;
    if update.manifest.archive.file_count != file_count {
        return Err(ExtractError::FileCountMismatch);
    }
    Ok(())
}

pub fn extract_archive(
    bytes: &[u8],
    destination: &Path,
    limits: &UpdateLimits,
) -> Result<(), ExtractError> {
    extract_archive_inner(bytes, destination, limits).map(|_| ())
}

fn extract_archive_inner(
    bytes: &[u8],
    destination: &Path,
    limits: &UpdateLimits,
) -> Result<usize, ExtractError> {
    if bytes.len() as u64 > limits.max_download_bytes {
        return Err(ExtractError::TooLarge);
    }
    match fs::symlink_metadata(destination) {
        Ok(metadata) if metadata.file_type().is_symlink() => return Err(ExtractError::Symlink),
        Ok(metadata) if !metadata.is_dir() => return Err(ExtractError::Io),
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            fs::create_dir_all(destination).map_err(|_| ExtractError::Io)?;
        }
        Err(_) => return Err(ExtractError::Io),
    }
    let mut archive = tar::Archive::new(GzDecoder::new(Cursor::new(bytes)));
    let entries = archive
        .entries()
        .map_err(|_| ExtractError::InvalidArchive)?;
    let mut count = 0usize;
    let mut file_count = 0usize;
    let mut unpacked = 0u64;
    let mut paths = HashSet::new();

    for entry in entries {
        let mut entry = entry.map_err(|_| ExtractError::InvalidArchive)?;
        count = count.checked_add(1).ok_or(ExtractError::TooManyFiles)?;
        if count > limits.max_files {
            return Err(ExtractError::TooManyFiles);
        }
        let path = entry.path().map_err(|_| ExtractError::UnsafePath)?;
        validate_relative_path(&path)?;
        if !paths.insert(path.to_path_buf()) {
            return Err(ExtractError::DuplicatePath);
        }

        let entry_type = entry.header().entry_type();
        if entry_type.is_symlink() || entry_type.is_hard_link() {
            return Err(ExtractError::Symlink);
        }
        if !entry_type.is_file() && !entry_type.is_dir() {
            return Err(ExtractError::UnsupportedEntry);
        }
        if entry_type.is_file() {
            file_count = file_count
                .checked_add(1)
                .ok_or(ExtractError::TooManyFiles)?;
        }

        let size = entry
            .header()
            .size()
            .map_err(|_| ExtractError::InvalidArchive)?;
        unpacked = unpacked.checked_add(size).ok_or(ExtractError::TooLarge)?;
        if unpacked > limits.max_unpacked_bytes {
            return Err(ExtractError::TooLarge);
        }

        let target = destination.join(path.as_ref());
        if entry_type.is_dir() {
            create_safe_directories(destination, path.as_ref())?;
            continue;
        }
        let parent = path.parent().unwrap_or_else(|| Path::new(""));
        create_safe_directories(destination, parent)?;
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
            .map_err(|_| ExtractError::Io)?;
        io::copy(&mut entry, &mut output).map_err(|_| ExtractError::InvalidArchive)?;
        output.sync_all().map_err(|_| ExtractError::Io)?;
    }
    Ok(file_count)
}

fn validate_relative_path(path: &Path) -> Result<(), ExtractError> {
    if path.as_os_str().is_empty() || path.to_string_lossy().contains('\\') {
        return Err(ExtractError::UnsafePath);
    }
    for component in path.components() {
        match component {
            Component::Normal(_) => {}
            Component::CurDir
            | Component::ParentDir
            | Component::RootDir
            | Component::Prefix(_) => return Err(ExtractError::UnsafePath),
        }
    }
    Ok(())
}

fn create_safe_directories(root: &Path, relative: &Path) -> Result<(), ExtractError> {
    let mut current = root.to_path_buf();
    for component in relative.components() {
        let Component::Normal(name) = component else {
            return Err(ExtractError::UnsafePath);
        };
        current.push(name);
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => return Err(ExtractError::Symlink),
            Ok(metadata) if !metadata.is_dir() => return Err(ExtractError::Io),
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                fs::create_dir(&current).map_err(|_| ExtractError::Io)?;
            }
            Err(_) => return Err(ExtractError::Io),
        }
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum UpdateStatus {
    Ready,
    Pending,
    Failed,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FailureReason {
    BootFailed,
    ReadyTimeout,
    LoadFailed,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UiUpdateMetadata {
    pub current: Option<String>,
    pub previous: Option<String>,
    pub pending: Option<String>,
    pub pending_ui_abi: Option<u32>,
    pub status: UpdateStatus,
    pub failed: Option<String>,
    pub failure: Option<FailureReason>,
    pub failure_count: u32,
    pub highest_published_at: Option<i64>,
}

impl Default for UiUpdateMetadata {
    fn default() -> Self {
        Self {
            current: None,
            previous: None,
            pending: None,
            pending_ui_abi: None,
            status: UpdateStatus::Ready,
            failed: None,
            failure: None,
            failure_count: 0,
            highest_published_at: None,
        }
    }
}

#[derive(Clone, Debug)]
pub struct StagedUpdate {
    build_id: String,
    ui_abi: u32,
    published_at: i64,
    path: PathBuf,
}

#[derive(Clone, Debug)]
pub struct UiUpdateStore {
    root: PathBuf,
}

impl UiUpdateStore {
    pub fn new(app_data: impl AsRef<Path>) -> Self {
        Self {
            root: app_data.as_ref().join(UI_DIRECTORY),
        }
    }

    pub fn metadata_path(&self) -> PathBuf {
        self.root.join(METADATA_FILE)
    }

    pub fn release_path(&self, build_id: &str) -> PathBuf {
        self.root.join("builds").join(build_id)
    }

    pub fn load_metadata(&self) -> Result<UiUpdateMetadata, StoreError> {
        match fs::read(self.metadata_path()) {
            Ok(bytes) => {
                let metadata: UiUpdateMetadata =
                    serde_json::from_slice(&bytes).map_err(|_| StoreError::CorruptMetadata)?;
                validate_metadata(&metadata)?;
                Ok(metadata)
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                Ok(UiUpdateMetadata::default())
            }
            Err(_) => Err(StoreError::Io),
        }
    }

    pub fn stage(
        &self,
        update: &VerifiedUpdate,
        bytes: &[u8],
        limits: &UpdateLimits,
    ) -> Result<StagedUpdate, StoreError> {
        let staging = self.root.join("staging");
        fs::create_dir_all(&staging).map_err(|_| StoreError::Io)?;
        let final_path = staging.join(update.build_id());
        if final_path.exists() || self.release_path(update.build_id()).exists() {
            return Err(StoreError::AlreadyExists);
        }
        let temporary = staging.join(temp_name(update.build_id(), "tmp"));
        let result = (|| {
            fs::create_dir(&temporary).map_err(|_| StoreError::Io)?;
            extract_verified_archive(update, bytes, &temporary, limits)
                .map_err(|_| StoreError::Extraction)?;
            let entrypoint = temporary.join(&update.manifest.entrypoint);
            if !entrypoint.is_file() {
                return Err(StoreError::MissingEntrypoint);
            }
            fs::rename(&temporary, &final_path).map_err(|_| StoreError::Io)?;
            sync_directory(&staging).map_err(|_| StoreError::Io)?;
            Ok(StagedUpdate {
                build_id: update.build_id().to_string(),
                ui_abi: update.ui_abi(),
                published_at: OffsetDateTime::parse(&update.manifest.published_at, &Rfc3339)
                    .map_err(|_| StoreError::Extraction)?
                    .unix_timestamp(),
                path: final_path,
            })
        })();
        if result.is_err() {
            let _ = fs::remove_dir_all(&temporary);
        }
        result
    }

    pub fn activate(&self, staged: &StagedUpdate) -> Result<(), StoreError> {
        let expected = self.root.join("staging").join(&staged.build_id);
        if staged.path != expected || !staged.path.is_dir() {
            return Err(StoreError::InvalidStaging);
        }
        let mut metadata = self.load_metadata()?;
        if metadata.status == UpdateStatus::Pending {
            return Err(StoreError::InvalidTransition);
        }
        if metadata
            .highest_published_at
            .is_some_and(|highest| staged.published_at < highest)
        {
            return Err(StoreError::RollbackRejected);
        }
        let builds = self.root.join("builds");
        fs::create_dir_all(&builds).map_err(|_| StoreError::Io)?;
        let release = self.release_path(&staged.build_id);
        if release.exists() {
            return Err(StoreError::AlreadyExists);
        }
        fs::rename(&staged.path, &release).map_err(|_| StoreError::Io)?;
        sync_directory(&builds).map_err(|_| StoreError::Io)?;

        metadata.previous = metadata.current.take();
        metadata.current = Some(staged.build_id.clone());
        metadata.pending = Some(staged.build_id.clone());
        metadata.pending_ui_abi = Some(staged.ui_abi);
        metadata.status = UpdateStatus::Pending;
        metadata.failed = None;
        metadata.failure = None;
        metadata.highest_published_at = Some(
            metadata
                .highest_published_at
                .map_or(staged.published_at, |highest| {
                    highest.max(staged.published_at)
                }),
        );
        self.write_metadata(&metadata)
    }

    pub fn mark_ready(&self, build_id: &str, ui_abi: u32) -> Result<(), StoreError> {
        let mut metadata = self.load_metadata()?;
        if metadata.status != UpdateStatus::Pending
            || metadata.current.as_deref() != Some(build_id)
            || metadata.pending.as_deref() != Some(build_id)
            || metadata.pending_ui_abi != Some(ui_abi)
        {
            return Err(StoreError::InvalidTransition);
        }
        metadata.pending = None;
        metadata.pending_ui_abi = None;
        metadata.status = UpdateStatus::Ready;
        metadata.failed = None;
        metadata.failure = None;
        metadata.failure_count = 0;
        self.write_metadata(&metadata)
    }

    pub fn fail_and_rollback(
        &self,
        build_id: &str,
        reason: FailureReason,
    ) -> Result<(), StoreError> {
        let mut metadata = self.load_metadata()?;
        if metadata.status != UpdateStatus::Pending
            || metadata.current.as_deref() != Some(build_id)
            || metadata.pending.as_deref() != Some(build_id)
        {
            return Err(StoreError::InvalidTransition);
        }
        metadata.failed = Some(build_id.to_string());
        metadata.failure = Some(reason);
        metadata.failure_count = metadata.failure_count.saturating_add(1);
        metadata.current = metadata.previous.take();
        metadata.pending = None;
        metadata.pending_ui_abi = None;
        metadata.status = UpdateStatus::Failed;
        self.write_metadata(&metadata)
    }

    fn write_metadata(&self, metadata: &UiUpdateMetadata) -> Result<(), StoreError> {
        fs::create_dir_all(&self.root).map_err(|_| StoreError::Io)?;
        let path = self.metadata_path();
        let temporary = self.root.join(temp_name(METADATA_FILE, "tmp"));
        let encoded = serde_json::to_vec(metadata).map_err(|_| StoreError::CorruptMetadata)?;
        let result = (|| {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)
                .map_err(|_| StoreError::Io)?;
            file.write_all(&encoded).map_err(|_| StoreError::Io)?;
            file.sync_all().map_err(|_| StoreError::Io)?;
            replace_file_atomically(&temporary, &path).map_err(|_| StoreError::Io)?;
            sync_directory(&self.root).map_err(|_| StoreError::Io)
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result
    }
}

fn validate_metadata(metadata: &UiUpdateMetadata) -> Result<(), StoreError> {
    for build_id in [
        metadata.current.as_deref(),
        metadata.previous.as_deref(),
        metadata.pending.as_deref(),
        metadata.failed.as_deref(),
    ]
    .into_iter()
    .flatten()
    {
        if !valid_build_id(build_id) {
            return Err(StoreError::CorruptMetadata);
        }
    }
    let valid_state = match metadata.status {
        UpdateStatus::Ready => {
            metadata.pending.is_none()
                && metadata.pending_ui_abi.is_none()
                && metadata.failure.is_none()
        }
        UpdateStatus::Pending => {
            metadata.pending.is_some()
                && metadata.pending == metadata.current
                && metadata.pending_ui_abi.is_some()
                && metadata.failure.is_none()
        }
        UpdateStatus::Failed => {
            metadata.pending.is_none()
                && metadata.pending_ui_abi.is_none()
                && metadata.failed.is_some()
                && metadata.failure.is_some()
        }
    };
    if !valid_state {
        return Err(StoreError::CorruptMetadata);
    }
    Ok(())
}

fn temp_name(stem: &str, suffix: &str) -> String {
    let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    format!(".{stem}.{}.{sequence}.{suffix}", std::process::id())
}

fn sync_directory(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        std::fs::File::open(path)?.sync_all()
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        Ok(())
    }
}

#[cfg(not(windows))]
fn replace_file_atomically(source: &Path, destination: &Path) -> io::Result<()> {
    fs::rename(source, destination)
}

#[cfg(windows)]
fn replace_file_atomically(source: &Path, destination: &Path) -> io::Result<()> {
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
    let moved = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if moved == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

macro_rules! error_enum {
    ($name:ident { $($variant:ident),+ $(,)? }) => {
        #[derive(Clone, Copy, Debug, PartialEq, Eq)]
        pub enum $name { $($variant),+ }

        impl std::fmt::Display for $name {
            fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                write!(formatter, "{:?}", self)
            }
        }

        impl std::error::Error for $name {}
    };
}

error_enum!(ManifestError {
    Invalid,
    InvalidCoreVersion,
    UnsupportedSchema,
    IncompatibleCore,
    IncompatibleUiAbi,
    UnofficialArchiveUrl,
    DownloadTooLarge,
    TooManyFiles,
    Signature,
});
error_enum!(ArchiveVerifyError {
    Size,
    Sha256,
    Signature,
});
error_enum!(DownloadError {
    TooLarge,
    LengthMismatch,
    Io,
});
error_enum!(ExtractError {
    InvalidArchive,
    UnsafePath,
    Symlink,
    UnsupportedEntry,
    DuplicatePath,
    TooManyFiles,
    TooLarge,
    FileCountMismatch,
    UnverifiedArchive,
    Io,
});
error_enum!(StoreError {
    Io,
    CorruptMetadata,
    Extraction,
    MissingEntrypoint,
    AlreadyExists,
    InvalidStaging,
    InvalidTransition,
    RollbackRejected,
});

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use flate2::{write::GzEncoder, Compression};
    use tar::{Builder, EntryType, Header};
    use tempfile::tempdir;

    use super::*;

    #[derive(Default)]
    struct RecordingVerifier {
        calls: std::cell::RefCell<Vec<(Vec<u8>, String)>>,
        reject: bool,
    }

    impl SignatureVerifier for RecordingVerifier {
        fn verify(&self, message: &[u8], signature: &str) -> Result<(), VerifyError> {
            self.calls
                .borrow_mut()
                .push((message.to_vec(), signature.to_string()));
            if self.reject {
                Err(VerifyError::Signature)
            } else {
                Ok(())
            }
        }
    }

    fn archive(entries: &[(&str, &[u8], Option<EntryType>)]) -> Vec<u8> {
        let output = Vec::new();
        {
            let encoder = GzEncoder::new(output, Compression::default());
            let mut writer = Builder::new(encoder);
            for (name, body, entry_type) in entries {
                let mut header = Header::new_gnu();
                set_raw_tar_path(&mut header, name);
                header.set_mode(0o644);
                header.set_entry_type(entry_type.unwrap_or(EntryType::Regular));
                if entry_type.is_some_and(|kind| kind.is_symlink()) {
                    header.set_size(0);
                    header.set_link_name("target").unwrap();
                } else {
                    header.set_size(body.len() as u64);
                }
                header.set_cksum();
                writer.append(&header, *body).unwrap();
            }
            writer.into_inner().unwrap().finish().unwrap()
        }
    }

    fn set_raw_tar_path(header: &mut Header, name: &str) {
        let bytes = header.as_mut_bytes();
        bytes[..100].fill(0);
        bytes[..name.len()].copy_from_slice(name.as_bytes());
    }

    fn signed_manifest(bundle: &[u8]) -> SignedUiManifest {
        SignedUiManifest::new(
            UiManifest {
                schema: SUPPORTED_MANIFEST_SCHEMA,
                version: "1.4.0".to_string(),
                ui_abi: SUPPORTED_UI_ABI,
                min_shell_version: "0.2.90".to_string(),
                build_id: "933a665e06f3b3dcb1d45f9cccbad0be83581637".to_string(),
                published_at: "2026-07-11T07:30:00Z".to_string(),
                archive: UiArchive {
                    name: "agentparty-desktop-ui-v1.4.0.tar.gz".to_string(),
                    url: "https://github.com/leeguooooo/agentparty/releases/download/desktop-ui/agentparty-desktop-ui-v1.4.0.tar.gz".to_string(),
                    size_bytes: bundle.len() as u64,
                    file_count: 2,
                    sha256: sha256_hex(bundle),
                    signature: "archive-signature".to_string(),
                },
                entrypoint: "index.html".to_string(),
            },
            "manifest-signature",
        )
        .unwrap()
    }

    #[test]
    fn exposes_one_fixed_official_manifest_endpoint() {
        assert_eq!(
            OFFICIAL_UI_MANIFEST_ENDPOINT,
            "https://github.com/leeguooooo/agentparty/releases/download/desktop-ui/desktop-ui.json"
        );
    }

    #[test]
    fn verifies_manifest_signature_and_core_compatibility() {
        let bundle = archive(&[("index.html", b"ok", None), ("assets/app.js", b"js", None)]);
        let signed = signed_manifest(&bundle);
        let canonical = signed.manifest.signing_bytes().unwrap();
        let verifier = RecordingVerifier::default();

        let verified = signed
            .verify_for_core("0.2.94", SUPPORTED_UI_ABI, &verifier)
            .unwrap();

        assert_eq!(
            verified.build_id(),
            "933a665e06f3b3dcb1d45f9cccbad0be83581637"
        );
        assert_eq!(
            verifier.calls.borrow().as_slice(),
            &[(canonical, "manifest-signature".to_string())]
        );
    }

    #[test]
    fn rejects_manifest_mutation_after_signing() {
        let bundle = archive(&[("index.html", b"ok", None), ("assets/app.js", b"js", None)]);
        let mut signed = signed_manifest(&bundle);
        signed.manifest.build_id = "a33a665e06f3b3dcb1d45f9cccbad0be83581637".to_string();

        assert_eq!(
            signed
                .verify_for_core("0.2.94", SUPPORTED_UI_ABI, &RecordingVerifier::default())
                .unwrap_err(),
            ManifestError::Signature
        );
    }

    #[test]
    fn manifest_validation_fails_closed() {
        let bundle = archive(&[("index.html", b"ok", None), ("assets/app.js", b"js", None)]);
        let verifier = RecordingVerifier::default();

        let mut signed = signed_manifest(&bundle);
        signed.manifest.schema += 1;
        let signed = SignedUiManifest::new(signed.manifest, "manifest-signature").unwrap();
        assert_eq!(
            signed
                .verify_for_core("0.2.94", SUPPORTED_UI_ABI, &verifier)
                .unwrap_err(),
            ManifestError::UnsupportedSchema
        );

        let mut signed = signed_manifest(&bundle);
        signed.manifest.min_shell_version = "0.3.0".to_string();
        let signed = SignedUiManifest::new(signed.manifest, "manifest-signature").unwrap();
        assert_eq!(
            signed
                .verify_for_core("0.2.94", SUPPORTED_UI_ABI, &verifier)
                .unwrap_err(),
            ManifestError::IncompatibleCore
        );

        let mut signed = signed_manifest(&bundle);
        signed.manifest.ui_abi = 2;
        let signed = SignedUiManifest::new(signed.manifest, "manifest-signature").unwrap();
        assert_eq!(
            signed
                .verify_for_core("0.2.94", SUPPORTED_UI_ABI, &verifier)
                .unwrap_err(),
            ManifestError::IncompatibleUiAbi
        );

        let mut signed = signed_manifest(&bundle);
        signed.manifest.archive.url = "https://example.com/ui.zip".to_string();
        let signed = SignedUiManifest::new(signed.manifest, "manifest-signature").unwrap();
        assert_eq!(
            signed
                .verify_for_core("0.2.94", SUPPORTED_UI_ABI, &verifier)
                .unwrap_err(),
            ManifestError::UnofficialArchiveUrl
        );

        let verifier = RecordingVerifier {
            reject: true,
            ..Default::default()
        };
        assert_eq!(
            signed_manifest(&bundle)
                .verify_for_core("0.2.94", SUPPORTED_UI_ABI, &verifier)
                .unwrap_err(),
            ManifestError::Signature
        );
    }

    #[test]
    fn rejects_unknown_manifest_fields() {
        let raw = r#"{
            "schema": 1,
            "version": "1.4.0",
            "ui_abi": 1,
            "min_shell_version": "0.2.90",
            "build_id": "933a665e06f3b3dcb1d45f9cccbad0be83581637",
            "published_at": "2026-07-11T07:30:00Z",
            "archive": {
              "name":"agentparty-desktop-ui-v1.4.0.tar.gz",
              "url":"https://github.com/leeguooooo/agentparty/releases/download/desktop-ui/agentparty-desktop-ui-v1.4.0.tar.gz",
              "sizeBytes":1,"fileCount":1,"sha256":"00","signature":"sig"
            },
            "entrypoint":"index.html",
            "unexpected":true
        }"#;
        assert!(SignedUiManifest::parse(raw.as_bytes(), "sig").is_err());
    }

    #[test]
    fn parses_the_release_manifest_and_verifies_its_exact_bytes() {
        let raw = format!(
            "{{\n  \"schema\": 1,\n  \"version\": \"1.4.0\",\n  \"ui_abi\": 1,\n  \"min_shell_version\": \"0.2.94\",\n  \"build_id\": \"933a665e06f3b3dcb1d45f9cccbad0be83581637\",\n  \"published_at\": \"2026-07-11T07:30:00Z\",\n  \"archive\": {{\n    \"name\": \"agentparty-desktop-ui-v1.4.0.tar.gz\",\n    \"url\": \"https://github.com/leeguooooo/agentparty/releases/download/desktop-ui/agentparty-desktop-ui-v1.4.0.tar.gz\",\n    \"sizeBytes\": 123,\n    \"fileCount\": 2,\n    \"sha256\": \"{}\",\n    \"signature\": \"archive-signature\\n\"\n  }},\n  \"entrypoint\": \"index.html\"\n}}\n",
            "0".repeat(64)
        );
        let verifier = RecordingVerifier::default();
        let signed =
            SignedUiManifest::parse_signed_envelope(raw.as_bytes(), "manifest-signature").unwrap();

        signed
            .verify_for_core("0.2.94", SUPPORTED_UI_ABI, &verifier)
            .unwrap();

        assert_eq!(signed.manifest().schema, SUPPORTED_MANIFEST_SCHEMA);
        assert_eq!(signed.manifest().entrypoint, "index.html");
        assert_eq!(
            verifier.calls.borrow().as_slice(),
            &[(raw.into_bytes(), "manifest-signature".to_string())]
        );
    }

    #[test]
    fn parses_the_base64_signed_manifest_envelope() {
        use base64::{engine::general_purpose::STANDARD, Engine as _};

        let payload = signed_manifest(&archive(&[
            ("index.html", b"ok", None),
            ("assets/app.js", b"js", None),
        ]))
        .manifest
        .signing_bytes()
        .unwrap();
        let envelope = serde_json::json!({
            "payload": STANDARD.encode(&payload),
            "signature": "manifest-signature"
        });
        let encoded = serde_json::to_vec(&envelope).unwrap();
        let verifier = RecordingVerifier::default();

        SignedUiManifest::parse_envelope_json(&encoded)
            .unwrap()
            .verify_for_core("0.2.94", SUPPORTED_UI_ABI, &verifier)
            .unwrap();

        assert_eq!(verifier.calls.borrow()[0].0, payload);
        for invalid in [
            br#"{"payload":"%%%","signature":"sig"}"#.as_slice(),
            br#"{"payload":"e30=","signature":""}"#.as_slice(),
            br#"{"payload":"e30=","signature":"sig","extra":true}"#.as_slice(),
        ] {
            assert!(SignedUiManifest::parse_envelope_json(invalid).is_err());
        }
    }

    #[test]
    fn rejects_manifest_missing_required_schema_size_or_file_count() {
        let bundle = archive(&[("index.html", b"ok", None), ("assets/app.js", b"js", None)]);
        let manifest = signed_manifest(&bundle).manifest;
        let mut value = serde_json::to_value(manifest).unwrap();

        for path in [
            ["schema", ""],
            ["archive", "sizeBytes"],
            ["archive", "fileCount"],
        ] {
            let mut candidate = value.clone();
            if path[1].is_empty() {
                candidate.as_object_mut().unwrap().remove(path[0]);
            } else {
                candidate[path[0]].as_object_mut().unwrap().remove(path[1]);
            }
            assert!(SignedUiManifest::parse_signed_envelope(
                &serde_json::to_vec(&candidate).unwrap(),
                "manifest-signature"
            )
            .is_err());
        }
        value
            .as_object_mut()
            .unwrap()
            .insert("ui_abi".to_string(), serde_json::json!("1"));
        assert!(SignedUiManifest::parse_signed_envelope(
            &serde_json::to_vec(&value).unwrap(),
            "manifest-signature"
        )
        .is_err());
    }

    #[test]
    fn enforces_declared_and_actual_download_limits() {
        let limits = UpdateLimits {
            max_download_bytes: 8,
            max_files: 2,
            max_unpacked_bytes: 16,
        };
        assert_eq!(
            read_download(Cursor::new(b"1234"), Some(9), &limits).unwrap_err(),
            DownloadError::TooLarge
        );
        assert_eq!(
            read_download(Cursor::new(b"123456789"), None, &limits).unwrap_err(),
            DownloadError::TooLarge
        );
        assert_eq!(
            read_download(Cursor::new(b"1234"), Some(4), &limits).unwrap(),
            b"1234"
        );
    }

    #[test]
    fn verifies_archive_hash_and_signature_before_installation() {
        let bundle = archive(&[("index.html", b"ok", None), ("assets/app.js", b"js", None)]);
        let signed = signed_manifest(&bundle);
        let verifier = RecordingVerifier::default();
        let manifest = signed
            .verify_for_core("0.2.94", SUPPORTED_UI_ABI, &verifier)
            .unwrap();

        let update = manifest.verify_archive(&bundle, &verifier).unwrap();
        assert_eq!(
            update.build_id(),
            "933a665e06f3b3dcb1d45f9cccbad0be83581637"
        );
        assert_eq!(verifier.calls.borrow().len(), 2);

        let mut tampered = bundle.clone();
        tampered[0] ^= 1;
        assert_eq!(
            manifest.verify_archive(&tampered, &verifier).unwrap_err(),
            ArchiveVerifyError::Sha256
        );
    }

    #[test]
    fn safely_extracts_a_verified_archive() {
        let bundle = archive(&[("index.html", b"ok", None), ("assets/app.js", b"js", None)]);
        let verifier = RecordingVerifier::default();
        let update = signed_manifest(&bundle)
            .verify_for_core("0.2.94", SUPPORTED_UI_ABI, &verifier)
            .unwrap()
            .verify_archive(&bundle, &verifier)
            .unwrap();
        let root = tempdir().unwrap();

        extract_verified_archive(&update, &bundle, root.path(), &UpdateLimits::default()).unwrap();

        assert_eq!(
            std::fs::read(root.path().join("index.html")).unwrap(),
            b"ok"
        );
        assert_eq!(
            std::fs::read(root.path().join("assets/app.js")).unwrap(),
            b"js"
        );
    }

    #[test]
    fn rejects_archive_when_signed_file_count_does_not_match() {
        let bundle = archive(&[("index.html", b"ok", None), ("assets/app.js", b"js", None)]);
        let mut signed = signed_manifest(&bundle);
        signed.manifest.archive.file_count = 1;
        let signed = SignedUiManifest::new(signed.manifest, "manifest-signature").unwrap();
        let verifier = RecordingVerifier::default();
        let update = signed
            .verify_for_core("0.2.94", SUPPORTED_UI_ABI, &verifier)
            .unwrap()
            .verify_archive(&bundle, &verifier)
            .unwrap();

        assert_eq!(
            extract_verified_archive(
                &update,
                &bundle,
                tempdir().unwrap().path(),
                &UpdateLimits::default()
            )
            .unwrap_err(),
            ExtractError::FileCountMismatch
        );
    }

    #[test]
    fn rejects_traversal_absolute_symlink_and_limit_violations() {
        let root = tempdir().unwrap();
        let limits = UpdateLimits {
            max_download_bytes: 1024 * 1024,
            max_files: 1,
            max_unpacked_bytes: 4,
        };

        for (bundle, expected) in [
            (
                archive(&[("../escape", b"x", None)]),
                ExtractError::UnsafePath,
            ),
            (
                archive(&[("/absolute", b"x", None)]),
                ExtractError::UnsafePath,
            ),
            (
                archive(&[("link", b"", Some(EntryType::Symlink))]),
                ExtractError::Symlink,
            ),
            (
                archive(&[("one", b"1", None), ("two", b"2", None)]),
                ExtractError::TooManyFiles,
            ),
            (
                archive(&[("large", b"12345", None)]),
                ExtractError::TooLarge,
            ),
        ] {
            assert_eq!(
                extract_archive(&bundle, root.path(), &limits).unwrap_err(),
                expected
            );
        }
        assert!(!root.path().parent().unwrap().join("escape").exists());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_a_symlinked_extraction_destination() {
        use std::os::unix::fs::symlink;

        let parent = tempdir().unwrap();
        let outside = tempdir().unwrap();
        let destination = parent.path().join("destination");
        symlink(outside.path(), &destination).unwrap();
        let bundle = archive(&[("index.html", b"bad", None)]);

        assert_eq!(
            extract_archive(&bundle, &destination, &UpdateLimits::default()).unwrap_err(),
            ExtractError::Symlink
        );
        assert!(!outside.path().join("index.html").exists());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_a_symlink_extraction_root() {
        use std::os::unix::fs::symlink;

        let parent = tempdir().unwrap();
        let actual = parent.path().join("actual");
        let linked = parent.path().join("linked");
        std::fs::create_dir(&actual).unwrap();
        symlink(&actual, &linked).unwrap();
        let bundle = archive(&[("index.html", b"unsafe", None)]);

        assert_eq!(
            extract_archive(&bundle, &linked, &UpdateLimits::default()).unwrap_err(),
            ExtractError::Symlink
        );
        assert!(!actual.join("index.html").exists());
    }

    #[test]
    fn rejects_corrupt_or_path_traversing_metadata() {
        let app_data = tempdir().unwrap();
        let store = UiUpdateStore::new(app_data.path());
        std::fs::create_dir_all(store.metadata_path().parent().unwrap()).unwrap();
        std::fs::write(
            store.metadata_path(),
            r#"{"current":"../escape","previous":null,"pending":null,"pendingUiAbi":null,"status":"ready","failed":null,"failure":null,"failureCount":0,"highestPublishedAt":null}"#,
        )
        .unwrap();

        assert_eq!(
            store.load_metadata().unwrap_err(),
            StoreError::CorruptMetadata
        );
    }

    #[test]
    fn stages_activates_marks_ready_and_rolls_back_failed_updates() {
        let app_data = tempdir().unwrap();
        let store = UiUpdateStore::new(app_data.path());
        let verifier = RecordingVerifier::default();
        let limits = UpdateLimits::default();

        let first_bundle = archive(&[("index.html", b"v1", None), ("assets/app.js", b"1", None)]);
        let first = signed_manifest(&first_bundle)
            .verify_for_core("0.2.94", SUPPORTED_UI_ABI, &verifier)
            .unwrap()
            .verify_archive(&first_bundle, &verifier)
            .unwrap();
        let first_staged = store.stage(&first, &first_bundle, &limits).unwrap();
        store.activate(&first_staged).unwrap();
        assert_eq!(store.load_metadata().unwrap().status, UpdateStatus::Pending);

        let blocked_bundle = archive(&[
            ("index.html", b"blocked", None),
            ("assets/app.js", b"b", None),
        ]);
        let mut blocked_manifest = signed_manifest(&blocked_bundle).manifest;
        blocked_manifest.version = "1.4.1".to_string();
        blocked_manifest.build_id = "b33a665e06f3b3dcb1d45f9cccbad0be83581637".to_string();
        blocked_manifest.archive.name = "agentparty-desktop-ui-v1.4.1.tar.gz".to_string();
        blocked_manifest.archive.url = "https://github.com/leeguooooo/agentparty/releases/download/desktop-ui/agentparty-desktop-ui-v1.4.1.tar.gz".to_string();
        let blocked = SignedUiManifest::new(blocked_manifest, "manifest-signature")
            .unwrap()
            .verify_for_core("0.2.94", SUPPORTED_UI_ABI, &verifier)
            .unwrap()
            .verify_archive(&blocked_bundle, &verifier)
            .unwrap();
        let blocked_staged = store.stage(&blocked, &blocked_bundle, &limits).unwrap();
        assert_eq!(
            store.activate(&blocked_staged).unwrap_err(),
            StoreError::InvalidTransition
        );
        assert!(blocked_staged.path.is_dir());

        store
            .mark_ready("933a665e06f3b3dcb1d45f9cccbad0be83581637", SUPPORTED_UI_ABI)
            .unwrap();
        assert_eq!(store.load_metadata().unwrap().status, UpdateStatus::Ready);

        let second_bundle = archive(&[("index.html", b"v2", None), ("assets/app.js", b"2", None)]);
        let mut second_manifest = signed_manifest(&second_bundle);
        second_manifest.manifest.version = "1.5.0".to_string();
        second_manifest.manifest.build_id = "a33a665e06f3b3dcb1d45f9cccbad0be83581637".to_string();
        second_manifest.manifest.archive.name = "agentparty-desktop-ui-v1.5.0.tar.gz".to_string();
        second_manifest.manifest.archive.url = "https://github.com/leeguooooo/agentparty/releases/download/desktop-ui/agentparty-desktop-ui-v1.5.0.tar.gz".to_string();
        let second_manifest =
            SignedUiManifest::new(second_manifest.manifest, "manifest-signature").unwrap();
        let second = second_manifest
            .verify_for_core("0.2.94", SUPPORTED_UI_ABI, &verifier)
            .unwrap()
            .verify_archive(&second_bundle, &verifier)
            .unwrap();
        let second_staged = store.stage(&second, &second_bundle, &limits).unwrap();
        store.activate(&second_staged).unwrap();

        let pending = store.load_metadata().unwrap();
        assert_eq!(
            pending.current.as_deref(),
            Some("a33a665e06f3b3dcb1d45f9cccbad0be83581637")
        );
        assert_eq!(
            pending.previous.as_deref(),
            Some("933a665e06f3b3dcb1d45f9cccbad0be83581637")
        );
        assert_eq!(pending.status, UpdateStatus::Pending);

        store
            .fail_and_rollback(
                "a33a665e06f3b3dcb1d45f9cccbad0be83581637",
                FailureReason::BootFailed,
            )
            .unwrap();
        let failed = store.load_metadata().unwrap();
        assert_eq!(
            failed.current.as_deref(),
            Some("933a665e06f3b3dcb1d45f9cccbad0be83581637")
        );
        assert_eq!(failed.previous, None);
        assert_eq!(failed.status, UpdateStatus::Failed);
        assert_eq!(
            failed.failed.as_deref(),
            Some("a33a665e06f3b3dcb1d45f9cccbad0be83581637")
        );
        assert_eq!(failed.failure, Some(FailureReason::BootFailed));
        assert!(store
            .release_path("933a665e06f3b3dcb1d45f9cccbad0be83581637")
            .join("index.html")
            .is_file());
        assert!(!store.metadata_path().with_extension("json.tmp").exists());
    }

    #[test]
    fn rejects_a_signed_manifest_older_than_the_accepted_high_water_mark() {
        let app_data = tempdir().unwrap();
        let store = UiUpdateStore::new(app_data.path());
        let verifier = RecordingVerifier::default();
        let limits = UpdateLimits::default();
        let current_bundle = archive(&[
            ("index.html", b"current", None),
            ("assets/app.js", b"c", None),
        ]);
        let current = signed_manifest(&current_bundle)
            .verify_for_core("0.2.94", SUPPORTED_UI_ABI, &verifier)
            .unwrap()
            .verify_archive(&current_bundle, &verifier)
            .unwrap();
        let current_staged = store.stage(&current, &current_bundle, &limits).unwrap();
        store.activate(&current_staged).unwrap();
        store
            .mark_ready(current.build_id(), SUPPORTED_UI_ABI)
            .unwrap();

        let old_bundle = archive(&[("index.html", b"old", None), ("assets/app.js", b"o", None)]);
        let mut old_manifest = signed_manifest(&old_bundle).manifest;
        old_manifest.version = "1.3.0".to_string();
        old_manifest.build_id = "c33a665e06f3b3dcb1d45f9cccbad0be83581637".to_string();
        old_manifest.published_at = "2026-07-10T07:30:00Z".to_string();
        old_manifest.archive.name = "agentparty-desktop-ui-v1.3.0.tar.gz".to_string();
        old_manifest.archive.url = "https://github.com/leeguooooo/agentparty/releases/download/desktop-ui/agentparty-desktop-ui-v1.3.0.tar.gz".to_string();
        let old = SignedUiManifest::new(old_manifest, "manifest-signature")
            .unwrap()
            .verify_for_core("0.2.94", SUPPORTED_UI_ABI, &verifier)
            .unwrap()
            .verify_archive(&old_bundle, &verifier)
            .unwrap();
        let old_staged = store.stage(&old, &old_bundle, &limits).unwrap();

        assert_eq!(
            store.activate(&old_staged).unwrap_err(),
            StoreError::RollbackRejected
        );
        assert_eq!(
            store.load_metadata().unwrap().current.as_deref(),
            Some(current.build_id())
        );
        assert!(old_staged.path.is_dir());
    }

    #[test]
    fn state_machine_rejects_invalid_transitions() {
        let app_data = tempdir().unwrap();
        let store = UiUpdateStore::new(app_data.path());
        assert_eq!(
            store
                .mark_ready("933a665e06f3b3dcb1d45f9cccbad0be83581637", SUPPORTED_UI_ABI)
                .unwrap_err(),
            StoreError::InvalidTransition
        );
        assert_eq!(
            store
                .fail_and_rollback(
                    "933a665e06f3b3dcb1d45f9cccbad0be83581637",
                    FailureReason::BootFailed,
                )
                .unwrap_err(),
            StoreError::InvalidTransition
        );
    }
}
