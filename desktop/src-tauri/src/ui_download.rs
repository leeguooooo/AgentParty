use std::{io::Read, time::Duration};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use minisign_verify::{PublicKey, Signature};

use crate::ui_update::{
    ArchiveVerifyError, ManifestError, SignatureVerifier, SignedUiManifest, StoreError,
    UiUpdateStore, UpdateLimits, VerifyError, MAX_MANIFEST_ENVELOPE_BYTES,
    OFFICIAL_UI_MANIFEST_ENDPOINT,
};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_REDIRECTS: usize = 3;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HttpResponse {
    pub status: u16,
    pub content_length: Option<u64>,
    pub body: Vec<u8>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HttpError {
    InvalidUrl,
    Request,
    TooLarge,
    LengthMismatch,
}

impl std::fmt::Display for HttpError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{self:?}")
    }
}

impl std::error::Error for HttpError {}

pub trait HttpClient {
    fn get(&self, url: &str, max_bytes: u64) -> Result<HttpResponse, HttpError>;
}

pub struct OfficialHttpClient {
    client: reqwest::blocking::Client,
}

impl OfficialHttpClient {
    pub fn new() -> Result<Self, HttpError> {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let redirect = reqwest::redirect::Policy::custom(|attempt| {
            if attempt.url().scheme() != "https" {
                attempt.error("redirect target must use HTTPS")
            } else if attempt.previous().len() > MAX_REDIRECTS {
                attempt.error("too many redirects")
            } else {
                attempt.follow()
            }
        });
        let client = reqwest::blocking::Client::builder()
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(REQUEST_TIMEOUT)
            .redirect(redirect)
            .build()
            .map_err(|_| HttpError::Request)?;
        Ok(Self { client })
    }
}

impl HttpClient for OfficialHttpClient {
    fn get(&self, url: &str, max_bytes: u64) -> Result<HttpResponse, HttpError> {
        let parsed = reqwest::Url::parse(url).map_err(|_| HttpError::InvalidUrl)?;
        if parsed.scheme() != "https" {
            return Err(HttpError::InvalidUrl);
        }
        let mut response = self
            .client
            .get(parsed)
            .send()
            .map_err(|_| HttpError::Request)?;
        let status = response.status().as_u16();
        let content_length = response.content_length();
        let body = if (200..300).contains(&status) {
            read_limited(&mut response, content_length, max_bytes)?
        } else {
            Vec::new()
        };
        Ok(HttpResponse {
            status,
            content_length,
            body,
        })
    }
}

fn read_limited(
    reader: impl Read,
    content_length: Option<u64>,
    max_bytes: u64,
) -> Result<Vec<u8>, HttpError> {
    if content_length.is_some_and(|length| length > max_bytes) {
        return Err(HttpError::TooLarge);
    }
    let mut body = Vec::new();
    reader
        .take(max_bytes.saturating_add(1))
        .read_to_end(&mut body)
        .map_err(|_| HttpError::Request)?;
    if body.len() as u64 > max_bytes {
        return Err(HttpError::TooLarge);
    }
    if content_length.is_some_and(|length| length != body.len() as u64) {
        return Err(HttpError::LengthMismatch);
    }
    Ok(body)
}

#[derive(Clone, Debug)]
pub struct MinisignVerifier {
    public_key: PublicKey,
}

impl MinisignVerifier {
    pub fn from_updater_pubkey_base64(encoded: &str) -> Result<Self, PublicKeyError> {
        let decoded = STANDARD
            .decode(encoded.as_bytes())
            .map_err(|_| PublicKeyError::InvalidBase64)?;
        let text = std::str::from_utf8(&decoded).map_err(|_| PublicKeyError::InvalidUtf8)?;
        let public_key = PublicKey::decode(text).map_err(|_| PublicKeyError::InvalidMinisignKey)?;
        Ok(Self { public_key })
    }
}

impl SignatureVerifier for MinisignVerifier {
    fn verify(&self, message: &[u8], signature: &str) -> Result<(), VerifyError> {
        let decoded = STANDARD
            .decode(signature.as_bytes())
            .map_err(|_| VerifyError::Signature)?;
        let text = std::str::from_utf8(&decoded).map_err(|_| VerifyError::Signature)?;
        let signature = Signature::decode(text).map_err(|_| VerifyError::Signature)?;
        self.public_key
            .verify(message, &signature, false)
            .map_err(|_| VerifyError::Signature)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PublicKeyError {
    InvalidBase64,
    InvalidUtf8,
    InvalidMinisignKey,
}

impl std::fmt::Display for PublicKeyError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{self:?}")
    }
}

impl std::error::Error for PublicKeyError {}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DownloadOutcome {
    NoUpdate,
    Activated { build_id: String, ui_abi: u32 },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UiDownloadError {
    Http(HttpError),
    HttpStatus(u16),
    ResponseTooLarge,
    LengthMismatch,
    Manifest(ManifestError),
    Archive(ArchiveVerifyError),
    Store(StoreError),
}

impl std::fmt::Display for UiDownloadError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{self:?}")
    }
}

impl std::error::Error for UiDownloadError {}

pub fn download_and_activate<C: HttpClient, V: SignatureVerifier>(
    client: &C,
    verifier: &V,
    store: &UiUpdateStore,
    current_build_id: Option<&str>,
    shell_version: &str,
    ui_abi: u32,
    limits: &UpdateLimits,
) -> Result<DownloadOutcome, UiDownloadError> {
    let manifest_response = client
        .get(
            OFFICIAL_UI_MANIFEST_ENDPOINT,
            MAX_MANIFEST_ENVELOPE_BYTES as u64,
        )
        .map_err(map_http_error)?;
    let envelope = successful_body(manifest_response, MAX_MANIFEST_ENVELOPE_BYTES as u64)?;
    let signed =
        SignedUiManifest::parse_envelope_json(&envelope).map_err(UiDownloadError::Manifest)?;
    let verified = signed
        .verify_for_core_with_limits(shell_version, ui_abi, verifier, limits)
        .map_err(UiDownloadError::Manifest)?;

    if current_build_id == Some(verified.build_id()) {
        return Ok(DownloadOutcome::NoUpdate);
    }

    let archive = &verified.manifest().archive;
    let archive_response = client
        .get(&archive.url, archive.size_bytes)
        .map_err(map_http_error)?;
    let bytes = successful_body(archive_response, limits.max_download_bytes)?;
    let update = verified
        .verify_archive(&bytes, verifier)
        .map_err(UiDownloadError::Archive)?;
    let build_id = update.build_id().to_string();
    let ui_abi = update.ui_abi();
    let staged = store
        .stage(&update, &bytes, limits)
        .map_err(UiDownloadError::Store)?;
    store.activate(&staged).map_err(UiDownloadError::Store)?;
    Ok(DownloadOutcome::Activated { build_id, ui_abi })
}

fn successful_body(response: HttpResponse, max_bytes: u64) -> Result<Vec<u8>, UiDownloadError> {
    if !(200..300).contains(&response.status) {
        return Err(UiDownloadError::HttpStatus(response.status));
    }
    if response
        .content_length
        .is_some_and(|length| length > max_bytes)
        || response.body.len() as u64 > max_bytes
    {
        return Err(UiDownloadError::ResponseTooLarge);
    }
    if response
        .content_length
        .is_some_and(|length| length != response.body.len() as u64)
    {
        return Err(UiDownloadError::LengthMismatch);
    }
    Ok(response.body)
}

fn map_http_error(error: HttpError) -> UiDownloadError {
    match error {
        HttpError::TooLarge => UiDownloadError::ResponseTooLarge,
        HttpError::LengthMismatch => UiDownloadError::LengthMismatch,
        error => UiDownloadError::Http(error),
    }
}

#[cfg(test)]
mod tests {
    use std::{cell::RefCell, collections::VecDeque};

    use flate2::{write::GzEncoder, Compression};
    use tar::{Builder, Header};
    use tempfile::tempdir;

    use super::*;
    use crate::ui_update;
    use crate::ui_update::{
        sha256_hex, SignatureVerifier, UiUpdateStore, UpdateLimits, VerifyError,
    };

    const BUILD_ID: &str = "933a665e06f3b3dcb1d45f9cccbad0be83581637";

    #[test]
    fn constructs_the_official_https_client_with_a_crypto_provider() {
        OfficialHttpClient::new().expect("official HTTPS client");
    }

    struct FakeHttpClient {
        responses: RefCell<VecDeque<Result<HttpResponse, HttpError>>>,
        requests: RefCell<Vec<(String, u64)>>,
    }

    impl FakeHttpClient {
        fn new(responses: Vec<HttpResponse>) -> Self {
            Self {
                responses: RefCell::new(responses.into_iter().map(Ok).collect()),
                requests: RefCell::new(Vec::new()),
            }
        }
    }

    impl HttpClient for FakeHttpClient {
        fn get(&self, url: &str, max_bytes: u64) -> Result<HttpResponse, HttpError> {
            self.requests
                .borrow_mut()
                .push((url.to_string(), max_bytes));
            self.responses
                .borrow_mut()
                .pop_front()
                .expect("fake response")
        }
    }

    struct FakeVerifier {
        reject: bool,
    }

    impl SignatureVerifier for FakeVerifier {
        fn verify(&self, _message: &[u8], _signature: &str) -> Result<(), VerifyError> {
            if self.reject {
                Err(VerifyError::Signature)
            } else {
                Ok(())
            }
        }
    }

    struct RejectArchiveVerifier {
        calls: std::cell::Cell<usize>,
    }

    impl SignatureVerifier for RejectArchiveVerifier {
        fn verify(&self, _message: &[u8], _signature: &str) -> Result<(), VerifyError> {
            let call = self.calls.get() + 1;
            self.calls.set(call);
            if call == 2 {
                Err(VerifyError::Signature)
            } else {
                Ok(())
            }
        }
    }

    fn archive() -> Vec<u8> {
        let encoder = GzEncoder::new(Vec::new(), Compression::default());
        let mut writer = Builder::new(encoder);
        let body = b"<html>official ui</html>";
        let mut header = Header::new_gnu();
        header.set_path("index.html").unwrap();
        header.set_mode(0o644);
        header.set_size(body.len() as u64);
        header.set_cksum();
        writer.append(&header, body.as_slice()).unwrap();
        writer.into_inner().unwrap().finish().unwrap()
    }

    fn manifest_envelope(bundle: &[u8], build_id: &str) -> Vec<u8> {
        use base64::{engine::general_purpose::STANDARD, Engine as _};

        let payload = serde_json::json!({
            "schema": 1,
            "version": "1.4.0",
            "ui_abi": 1,
            "min_shell_version": "0.2.90",
            "build_id": build_id,
            "published_at": "2026-07-11T07:30:00Z",
            "archive": {
                "name": "agentparty-desktop-ui-v1.4.0.tar.gz",
                "url": "https://github.com/leeguooooo/AgentParty/releases/download/desktop-ui/agentparty-desktop-ui-v1.4.0.tar.gz",
                "sizeBytes": bundle.len(),
                "fileCount": 1,
                "sha256": sha256_hex(bundle),
                "signature": "archive-signature"
            },
            "entrypoint": "index.html"
        });
        serde_json::to_vec(&serde_json::json!({
            "payload": STANDARD.encode(serde_json::to_vec(&payload).unwrap()),
            "signature": "manifest-signature"
        }))
        .unwrap()
    }

    fn response(status: u16, body: Vec<u8>) -> HttpResponse {
        HttpResponse {
            status,
            content_length: Some(body.len() as u64),
            body,
        }
    }

    fn run(
        client: &FakeHttpClient,
        verifier: &FakeVerifier,
        current_build_id: Option<&str>,
    ) -> Result<DownloadOutcome, UiDownloadError> {
        let root = tempdir().unwrap();
        download_and_activate(
            client,
            verifier,
            &UiUpdateStore::new(root.path()),
            current_build_id,
            "0.2.94",
            1,
            &UpdateLimits::default(),
        )
    }

    #[test]
    fn rejects_manifest_http_non_success() {
        let client = FakeHttpClient::new(vec![response(503, b"unavailable".to_vec())]);
        let error = run(&client, &FakeVerifier { reject: false }, None).unwrap_err();
        assert_eq!(error, UiDownloadError::HttpStatus(503));
    }

    #[test]
    fn rejects_manifest_over_512_kib() {
        let body = vec![b'x'; ui_update::MAX_MANIFEST_ENVELOPE_BYTES + 1];
        let client = FakeHttpClient::new(vec![response(200, body)]);
        let error = run(&client, &FakeVerifier { reject: false }, None).unwrap_err();
        assert_eq!(error, UiDownloadError::ResponseTooLarge);
    }

    #[test]
    fn rejects_manifest_signature_failure_before_archive_download() {
        let bundle = archive();
        let client = FakeHttpClient::new(vec![response(200, manifest_envelope(&bundle, BUILD_ID))]);
        let error = run(&client, &FakeVerifier { reject: true }, None).unwrap_err();
        assert_eq!(
            error,
            UiDownloadError::Manifest(ui_update::ManifestError::Signature)
        );
        assert_eq!(client.requests.borrow().len(), 1);
    }

    #[test]
    fn current_build_is_a_no_op_without_archive_download() {
        let bundle = archive();
        let client = FakeHttpClient::new(vec![response(200, manifest_envelope(&bundle, BUILD_ID))]);
        let outcome = run(&client, &FakeVerifier { reject: false }, Some(BUILD_ID)).unwrap();
        assert_eq!(outcome, DownloadOutcome::NoUpdate);
        assert_eq!(client.requests.borrow().len(), 1);
    }

    #[test]
    fn rejects_archive_signature_before_staging() {
        let bundle = archive();
        let root = tempdir().unwrap();
        let store = UiUpdateStore::new(root.path());
        let client = FakeHttpClient::new(vec![
            response(200, manifest_envelope(&bundle, BUILD_ID)),
            response(200, bundle),
        ]);
        let verifier = RejectArchiveVerifier {
            calls: std::cell::Cell::new(0),
        };

        let error = download_and_activate(
            &client,
            &verifier,
            &store,
            None,
            "0.2.94",
            1,
            &UpdateLimits::default(),
        )
        .unwrap_err();

        assert_eq!(
            error,
            UiDownloadError::Archive(ui_update::ArchiveVerifyError::Signature)
        );
        assert!(!store.release_path(BUILD_ID).exists());
    }

    #[test]
    fn downloads_verifies_stages_and_activates_official_ui() {
        let bundle = archive();
        let root = tempdir().unwrap();
        let store = UiUpdateStore::new(root.path());
        let client = FakeHttpClient::new(vec![
            response(200, manifest_envelope(&bundle, BUILD_ID)),
            response(200, bundle.clone()),
        ]);

        let outcome = download_and_activate(
            &client,
            &FakeVerifier { reject: false },
            &store,
            None,
            "0.2.94",
            1,
            &UpdateLimits::default(),
        )
        .unwrap();

        assert_eq!(
            outcome,
            DownloadOutcome::Activated {
                build_id: BUILD_ID.to_string(),
                ui_abi: 1,
            }
        );
        assert!(store.release_path(BUILD_ID).join("index.html").is_file());
        assert_eq!(
            store.load_metadata().unwrap().current.as_deref(),
            Some(BUILD_ID)
        );
        assert_eq!(
            client.requests.borrow()[0].0,
            ui_update::OFFICIAL_UI_MANIFEST_ENDPOINT
        );
        assert_eq!(client.requests.borrow()[1].1, bundle.len() as u64);
    }

    #[test]
    fn adapts_tauri_updater_pubkey_and_signature_base64() {
        const PROBE: &[u8] = b"AgentParty updater v2 key probe\n";
        const PROBE_SIGNATURE_B64: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVTaFhBUlJFam9nMURVUGRiTDRXRTVTUU44amViWVhJUGQvNVRxN09ZK01reFc3aldyZzNNeTk4WmZ3Z2J6Wkp1RmxyZUtKOG5BdHo4cmxXaWRYYzhpOGpKNTVDN3RNZ1FVPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzgzNjk5NTgwCWZpbGU6dG1wLjNpNHNNUHZQZU4KVSt6YnFHSk1pUEs3cnFCSUZ3MW53cDkrNVBGTHMxMWU4Z3hXM1dqVjE5Y3lrWCt5OE1MMWhzVlk0WVdZbjZUYXBqRk9vdlJSTTBwSHdpQkJWNWlzRFE9PQo=";

        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let encoded_key = config["plugins"]["updater"]["pubkey"].as_str().unwrap();
        let verifier = MinisignVerifier::from_updater_pubkey_base64(encoded_key).unwrap();

        verifier.verify(PROBE, PROBE_SIGNATURE_B64).unwrap();
    }

    #[test]
    #[ignore = "requires access to the official GitHub desktop-ui release"]
    fn downloads_and_activates_the_live_official_ui_release() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let encoded_key = config["plugins"]["updater"]["pubkey"].as_str().unwrap();
        let verifier = MinisignVerifier::from_updater_pubkey_base64(encoded_key).unwrap();
        let client = OfficialHttpClient::new().unwrap();
        let root = tempdir().unwrap();
        let store = UiUpdateStore::new(root.path());

        let outcome = download_and_activate(
            &client,
            &verifier,
            &store,
            None,
            "0.2.94",
            1,
            &UpdateLimits::default(),
        )
        .unwrap();

        let DownloadOutcome::Activated { build_id, ui_abi } = outcome else {
            panic!("an empty store must activate the live release");
        };
        assert_eq!(ui_abi, 1);
        assert!(store.release_path(&build_id).join("index.html").is_file());
        assert_eq!(
            store.load_metadata().unwrap().current.as_deref(),
            Some(build_id.as_str())
        );
        let verified = store
            .verified_current_archive("0.2.94", 1, &verifier, &UpdateLimits::default())
            .unwrap()
            .unwrap();
        assert_eq!(verified.build_id(), build_id);
    }
}
