use std::{
    collections::HashMap,
    io::{Cursor, Read},
    path::{Path, PathBuf},
    sync::Mutex,
};

#[cfg(test)]
use std::{
    fs::{self, File},
    io,
};

use flate2::read::GzDecoder;

#[cfg(test)]
use crate::ui_update::CurrentUiBuild;
use crate::ui_update::{SignatureVerifier, UiUpdateStore, UpdateLimits, VerifiedCurrentUiArchive};

pub const MAX_ASSET_BYTES: usize = 16 * 1024 * 1024;

const META_PATH: &str = "__agentparty_ui_meta.js";
const META_SCRIPT_TAG: &str = "<script src=\"/__agentparty_ui_meta.js\"></script>";
const CONTENT_SECURITY_POLICY: &str = "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: blob: https: http://127.0.0.1:* http://localhost:* http://[::1]:*; connect-src 'self' ipc: http://ipc.localhost https: wss: http://127.0.0.1:* http://localhost:* http://[::1]:* ws://127.0.0.1:* ws://localhost:* ws://[::1]:*";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UiProtocolResponse {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

#[derive(Default)]
pub struct UiProtocolCache {
    current: Option<CachedUiBuild>,
}

struct CachedUiBuild {
    build_id: String,
    ui_abi: u32,
    entrypoint: PathBuf,
    assets: HashMap<PathBuf, Vec<u8>>,
}

impl UiProtocolResponse {
    #[cfg(test)]
    pub fn status(&self) -> u16 {
        self.status
    }

    #[cfg(test)]
    pub fn headers(&self) -> &[(String, String)] {
        &self.headers
    }

    #[cfg(test)]
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }

    #[cfg(test)]
    pub fn body(&self) -> &[u8] {
        &self.body
    }

    pub fn into_parts(self) -> (u16, Vec<(String, String)>, Vec<u8>) {
        (self.status, self.headers, self.body)
    }
}

#[cfg(test)]
pub fn serve(store: &UiUpdateStore, url_path: &str) -> UiProtocolResponse {
    let path = match normalize_url_path(url_path) {
        Ok(path) => path,
        Err(()) => return response(400, "text/plain; charset=utf-8", b"Bad Request".to_vec()),
    };
    let build = match store.current_build() {
        Ok(Some(build)) => build,
        Ok(None) => return not_found(),
        Err(_) => {
            return response(
                500,
                "text/plain; charset=utf-8",
                b"Internal Server Error".to_vec(),
            )
        }
    };

    if path == Path::new(META_PATH) {
        return metadata_response(&build);
    }

    let requested_index = path.as_os_str().is_empty() || path.extension().is_none();
    let asset_path = if requested_index {
        Path::new("index.html")
    } else {
        path.as_path()
    };
    let body = match read_asset(&build, asset_path) {
        Ok(body) => body,
        Err(AssetError::NotFound) => return not_found(),
        Err(AssetError::TooLarge) => {
            return response(
                413,
                "text/plain; charset=utf-8",
                b"Payload Too Large".to_vec(),
            )
        }
        Err(AssetError::Io) => {
            return response(
                500,
                "text/plain; charset=utf-8",
                b"Internal Server Error".to_vec(),
            )
        }
    };
    if asset_path == Path::new("index.html") {
        let body = match inject_metadata_script(body) {
            Ok(body) => body,
            Err(()) => {
                return response(
                    500,
                    "text/plain; charset=utf-8",
                    b"Internal Server Error".to_vec(),
                )
            }
        };
        response(200, "text/html; charset=utf-8", body)
    } else {
        response(200, mime_type(asset_path), body)
    }
}

pub fn serve_verified<V: SignatureVerifier>(
    cache: &Mutex<UiProtocolCache>,
    store: &UiUpdateStore,
    shell_version: &str,
    ui_abi: u32,
    verifier: &V,
    url_path: &str,
) -> UiProtocolResponse {
    let identity = match store.current_build() {
        Ok(Some(build)) => (build.build_id().to_string(), build.ui_abi()),
        Ok(None) => return not_found(),
        Err(_) => return internal_error(),
    };
    let mut cache = match cache.lock() {
        Ok(cache) => cache,
        Err(_) => return internal_error(),
    };
    let cached_matches = cache
        .current
        .as_ref()
        .is_some_and(|current| current.build_id == identity.0 && current.ui_abi == identity.1);
    if !cached_matches {
        let archive = match store.verified_current_archive(
            shell_version,
            ui_abi,
            verifier,
            &UpdateLimits::default(),
        ) {
            Ok(Some(archive)) => archive,
            Ok(None) => return not_found(),
            Err(_) => return internal_error(),
        };
        let loaded = match load_verified_assets(&archive, &UpdateLimits::default()) {
            Ok(loaded) => loaded,
            Err(_) => return internal_error(),
        };
        cache.current = Some(loaded);
    }
    serve_cached(
        cache
            .current
            .as_ref()
            .expect("verified UI cache is populated"),
        url_path,
    )
}

fn load_verified_assets(
    archive: &VerifiedCurrentUiArchive,
    limits: &UpdateLimits,
) -> Result<CachedUiBuild, ()> {
    let mut reader = tar::Archive::new(GzDecoder::new(Cursor::new(archive.bytes())));
    let entries = reader.entries().map_err(|_| ())?;
    let mut count = 0usize;
    let mut file_count = 0usize;
    let mut unpacked = 0u64;
    let mut assets = HashMap::new();
    for entry in entries {
        let mut entry = entry.map_err(|_| ())?;
        count = count.checked_add(1).ok_or(())?;
        if count > limits.max_files {
            return Err(());
        }
        let path = entry.path().map_err(|_| ())?.to_path_buf();
        validate_archive_path(&path)?;
        let entry_type = entry.header().entry_type();
        if entry_type.is_symlink() || entry_type.is_hard_link() {
            return Err(());
        }
        if entry_type.is_dir() {
            continue;
        }
        if !entry_type.is_file() || assets.contains_key(&path) {
            return Err(());
        }
        file_count = file_count.checked_add(1).ok_or(())?;
        let size = entry.header().size().map_err(|_| ())?;
        unpacked = unpacked.checked_add(size).ok_or(())?;
        if unpacked > limits.max_unpacked_bytes || size > MAX_ASSET_BYTES as u64 {
            return Err(());
        }
        let mut body = Vec::with_capacity(size as usize);
        entry.read_to_end(&mut body).map_err(|_| ())?;
        if body.len() as u64 != size {
            return Err(());
        }
        assets.insert(path, body);
    }
    if file_count != archive.file_count() {
        return Err(());
    }
    let entrypoint = PathBuf::from(archive.entrypoint());
    if !assets.contains_key(&entrypoint) {
        return Err(());
    }
    Ok(CachedUiBuild {
        build_id: archive.build_id().to_string(),
        ui_abi: archive.ui_abi(),
        entrypoint,
        assets,
    })
}

fn validate_archive_path(path: &Path) -> Result<(), ()> {
    if path.as_os_str().is_empty() || path.to_string_lossy().contains('\\') {
        return Err(());
    }
    if path
        .components()
        .any(|component| !matches!(component, std::path::Component::Normal(_)))
    {
        return Err(());
    }
    Ok(())
}

fn serve_cached(build: &CachedUiBuild, url_path: &str) -> UiProtocolResponse {
    let path = match normalize_url_path(url_path) {
        Ok(path) => path,
        Err(()) => return response(400, "text/plain; charset=utf-8", b"Bad Request".to_vec()),
    };
    if path == Path::new(META_PATH) {
        return metadata_values_response(&build.build_id, build.ui_abi);
    }
    let requested_index = path.as_os_str().is_empty() || path.extension().is_none();
    let asset_path = if requested_index {
        &build.entrypoint
    } else {
        &path
    };
    let Some(body) = build.assets.get(asset_path).cloned() else {
        return not_found();
    };
    if asset_path == &build.entrypoint {
        match inject_metadata_script(body) {
            Ok(body) => response(200, "text/html; charset=utf-8", body),
            Err(()) => internal_error(),
        }
    } else {
        response(200, mime_type(asset_path), body)
    }
}

#[cfg(test)]
fn metadata_response(build: &CurrentUiBuild) -> UiProtocolResponse {
    metadata_values_response(build.build_id(), build.ui_abi())
}

fn metadata_values_response(build_id: &str, ui_abi: u32) -> UiProtocolResponse {
    let value = serde_json::json!({
        "buildId": build_id,
        "uiAbi": ui_abi,
    });
    response(
        200,
        "application/javascript; charset=utf-8",
        format!("window.__AGENTPARTY_DESKTOP_UI__={value};").into_bytes(),
    )
}

fn internal_error() -> UiProtocolResponse {
    response(
        500,
        "text/plain; charset=utf-8",
        b"Internal Server Error".to_vec(),
    )
}

fn normalize_url_path(url_path: &str) -> Result<PathBuf, ()> {
    if url_path.len() > 8 * 1024
        || !url_path.starts_with('/')
        || url_path.contains(['\\', '?', '#'])
    {
        return Err(());
    }
    let decoded = percent_decode(url_path.as_bytes())?;
    let decoded = std::str::from_utf8(&decoded).map_err(|_| ())?;
    if decoded.contains(['\\', '%', '?', '#'])
        || decoded.chars().any(char::is_control)
        || !decoded.starts_with('/')
        || decoded[1..].starts_with('/')
    {
        return Err(());
    }

    let mut normalized = PathBuf::new();
    let relative = &decoded[1..];
    if relative.is_empty() {
        return Ok(normalized);
    }
    for segment in relative.split('/') {
        if segment.is_empty() || segment == "." || segment == ".." || segment.contains(':') {
            return Err(());
        }
        normalized.push(segment);
    }
    Ok(normalized)
}

fn percent_decode(input: &[u8]) -> Result<Vec<u8>, ()> {
    let mut decoded = Vec::with_capacity(input.len());
    let mut index = 0;
    while index < input.len() {
        if input[index] != b'%' {
            decoded.push(input[index]);
            index += 1;
            continue;
        }
        if index + 2 >= input.len() {
            return Err(());
        }
        let high = hex_value(input[index + 1]).ok_or(())?;
        let low = hex_value(input[index + 2]).ok_or(())?;
        let value = (high << 4) | low;
        if matches!(value, b'/' | b'\\' | b'%') {
            return Err(());
        }
        decoded.push(value);
        index += 3;
    }
    Ok(decoded)
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AssetError {
    NotFound,
    TooLarge,
    Io,
}

#[cfg(test)]
fn read_asset(build: &CurrentUiBuild, relative: &Path) -> Result<Vec<u8>, AssetError> {
    if fs::symlink_metadata(build.root())
        .map_err(|_| AssetError::NotFound)?
        .file_type()
        .is_symlink()
    {
        return Err(AssetError::NotFound);
    }
    let root = fs::canonicalize(build.root()).map_err(|_| AssetError::NotFound)?;
    let candidate = fs::canonicalize(build.root().join(relative)).map_err(map_asset_io)?;
    if !candidate.starts_with(&root) || !candidate.is_file() {
        return Err(AssetError::NotFound);
    }

    let file = File::open(candidate).map_err(map_asset_io)?;
    if file.metadata().map_err(|_| AssetError::Io)?.len() > MAX_ASSET_BYTES as u64 {
        return Err(AssetError::TooLarge);
    }
    let mut body = Vec::new();
    file.take((MAX_ASSET_BYTES + 1) as u64)
        .read_to_end(&mut body)
        .map_err(|_| AssetError::Io)?;
    if body.len() > MAX_ASSET_BYTES {
        return Err(AssetError::TooLarge);
    }
    Ok(body)
}

#[cfg(test)]
fn map_asset_io(error: io::Error) -> AssetError {
    if error.kind() == io::ErrorKind::NotFound {
        AssetError::NotFound
    } else {
        AssetError::Io
    }
}

fn inject_metadata_script(body: Vec<u8>) -> Result<Vec<u8>, ()> {
    let mut html = String::from_utf8(body).map_err(|_| ())?;
    if let Some(metadata_index) = html.find(META_SCRIPT_TAG) {
        if find_module_script(&html).is_none_or(|module_index| metadata_index < module_index) {
            return Ok(html.into_bytes());
        }
        html.replace_range(metadata_index..metadata_index + META_SCRIPT_TAG.len(), "");
    }
    let injected = if let Some(index) = find_module_script(&html) {
        format!("{}{META_SCRIPT_TAG}{}", &html[..index], &html[index..])
    } else if let Some(index) = html.find("</head>") {
        format!("{}{META_SCRIPT_TAG}{}", &html[..index], &html[index..])
    } else if let Some(index) = html.find("</body>") {
        format!("{}{META_SCRIPT_TAG}{}", &html[..index], &html[index..])
    } else {
        format!("{META_SCRIPT_TAG}{html}")
    };
    Ok(injected.into_bytes())
}

fn find_module_script(html: &str) -> Option<usize> {
    let mut offset = 0;
    while let Some(relative_start) = html[offset..].find("<script") {
        let start = offset + relative_start;
        let end = start + html[start..].find('>')?;
        let opening_tag = &html[start..=end];
        if opening_tag.contains("type=\"module\"") || opening_tag.contains("type='module'") {
            return Some(start);
        }
        offset = end + 1;
    }
    None
}

fn mime_type(path: &Path) -> &'static str {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    match extension.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "js" | "mjs" => "application/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json; charset=utf-8",
        "webmanifest" => "application/manifest+json; charset=utf-8",
        "txt" => "text/plain; charset=utf-8",
        "xml" => "application/xml; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "wasm" => "application/wasm",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        _ => "application/octet-stream",
    }
}

fn not_found() -> UiProtocolResponse {
    response(404, "text/plain; charset=utf-8", b"Not Found".to_vec())
}

fn response(status: u16, content_type: &str, body: Vec<u8>) -> UiProtocolResponse {
    let content_length = body.len().to_string();
    UiProtocolResponse {
        status,
        headers: vec![
            ("content-type".to_string(), content_type.to_string()),
            ("content-length".to_string(), content_length),
            ("x-content-type-options".to_string(), "nosniff".to_string()),
            ("cache-control".to_string(), "no-store".to_string()),
            (
                "content-security-policy".to_string(),
                CONTENT_SECURITY_POLICY.to_string(),
            ),
        ],
        body,
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use flate2::{write::GzEncoder, Compression};
    use tar::{Builder, Header};
    use tempfile::{tempdir, TempDir};

    use super::*;
    use crate::ui_update::{
        sha256_hex, SignatureVerifier, SignedUiManifest, UiArchive, UiManifest, UiUpdateStore,
        UpdateLimits, VerifyError, SUPPORTED_UI_ABI,
    };

    const BUILD_ID: &str = "933a665e06f3b3dcb1d45f9cccbad0be83581637";

    struct AcceptVerifier;

    impl SignatureVerifier for AcceptVerifier {
        fn verify(&self, _message: &[u8], _signature: &str) -> Result<(), VerifyError> {
            Ok(())
        }
    }

    fn signed_archive() -> Vec<u8> {
        let encoder = GzEncoder::new(Vec::new(), Compression::default());
        let mut archive = Builder::new(encoder);
        for (path, body) in [
            (
                "index.html",
                b"<html><head><script type=\"module\" src=\"/assets/app.js\"></script></head><body>signed</body></html>".as_slice(),
            ),
            ("assets/app.js", b"console.log('signed')".as_slice()),
        ] {
            let mut header = Header::new_gnu();
            header.set_size(body.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            archive.append_data(&mut header, path, body).unwrap();
        }
        archive.into_inner().unwrap().finish().unwrap()
    }

    fn verified_store() -> (TempDir, UiUpdateStore) {
        let bytes = signed_archive();
        let manifest = UiManifest {
            schema: 1,
            version: "1.4.0".to_string(),
            ui_abi: SUPPORTED_UI_ABI,
            min_shell_version: "0.2.94".to_string(),
            build_id: BUILD_ID.to_string(),
            published_at: "2026-07-11T07:30:00Z".to_string(),
            archive: UiArchive {
                name: "agentparty-desktop-ui-v1.4.0.tar.gz".to_string(),
                url: "https://github.com/leeguooooo/AgentParty/releases/download/desktop-ui/agentparty-desktop-ui-v1.4.0.tar.gz".to_string(),
                size_bytes: bytes.len() as u64,
                file_count: 2,
                sha256: sha256_hex(&bytes),
                signature: "archive-signature".to_string(),
            },
            entrypoint: "index.html".to_string(),
        };
        let update = SignedUiManifest::new(manifest, "manifest-signature")
            .unwrap()
            .verify_for_core("0.2.94", SUPPORTED_UI_ABI, &AcceptVerifier)
            .unwrap()
            .verify_archive(&bytes, &AcceptVerifier)
            .unwrap();
        let app_data = tempdir().unwrap();
        let store = UiUpdateStore::new(app_data.path());
        let staged = store
            .stage(&update, &bytes, &UpdateLimits::default())
            .unwrap();
        store.activate(&staged).unwrap();
        store.mark_ready(BUILD_ID, SUPPORTED_UI_ABI).unwrap();
        (app_data, store)
    }

    fn store_with(files: &[(&str, &[u8])]) -> (TempDir, UiUpdateStore) {
        let app_data = tempdir().unwrap();
        let store = UiUpdateStore::new(app_data.path());
        let root = store.release_path(BUILD_ID);
        fs::create_dir_all(&root).unwrap();
        for (path, body) in files {
            let destination = root.join(path);
            if let Some(parent) = destination.parent() {
                fs::create_dir_all(parent).unwrap();
            }
            fs::write(destination, body).unwrap();
        }
        fs::create_dir_all(store.metadata_path().parent().unwrap()).unwrap();
        fs::write(
            store.metadata_path(),
            serde_json::to_vec(&serde_json::json!({
                "current": BUILD_ID,
                "currentUiAbi": SUPPORTED_UI_ABI,
                "status": "ready"
            }))
            .unwrap(),
        )
        .unwrap();
        (app_data, store)
    }

    fn body_text(response: &UiProtocolResponse) -> &str {
        std::str::from_utf8(response.body()).unwrap()
    }

    #[test]
    fn serves_root_with_external_metadata_script_and_security_headers() {
        let (_app_data, store) = store_with(&[(
            "index.html",
            b"<!doctype html><html><head><title>AgentParty</title><script type=\"module\" src=\"/assets/app.js\"></script></head><body></body></html>",
        )]);

        let response = serve(&store, "/");

        assert_eq!(response.status(), 200);
        assert_eq!(
            response.header("content-type"),
            Some("text/html; charset=utf-8")
        );
        assert_eq!(response.header("x-content-type-options"), Some("nosniff"));
        assert_eq!(response.header("cache-control"), Some("no-store"));
        assert_eq!(
            response.header("content-security-policy"),
            Some("default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: blob: https: http://127.0.0.1:* http://localhost:* http://[::1]:*; connect-src 'self' ipc: http://ipc.localhost https: wss: http://127.0.0.1:* http://localhost:* http://[::1]:* ws://127.0.0.1:* ws://localhost:* ws://[::1]:*")
        );
        assert_eq!(response.headers().len(), 5);
        let html = body_text(&response);
        let metadata_script = html
            .find("<script src=\"/__agentparty_ui_meta.js\"></script>")
            .unwrap();
        let vite_module = html.find("<script type=\"module\"").unwrap();
        assert!(metadata_script < vite_module);
        assert!(!html.contains("window.__AGENTPARTY_DESKTOP_UI__"));

        let (status, headers, body) = response.clone().into_parts();
        assert_eq!(status, 200);
        assert_eq!(headers.len(), 5);
        assert_eq!(body, response.body());
    }

    #[test]
    fn generates_metadata_javascript_for_the_current_build() {
        let (_app_data, store) = store_with(&[("index.html", b"<html></html>")]);

        let response = serve(&store, "/__agentparty_ui_meta.js");

        assert_eq!(response.status(), 200);
        assert_eq!(
            response.header("content-type"),
            Some("application/javascript; charset=utf-8")
        );
        assert_eq!(
            body_text(&response),
            format!(
                "window.__AGENTPARTY_DESKTOP_UI__={{\"buildId\":\"{BUILD_ID}\",\"uiAbi\":{SUPPORTED_UI_ABI}}};"
            )
        );
    }

    #[test]
    fn serves_static_assets_and_falls_back_only_for_extensionless_spa_paths() {
        let (_app_data, store) = store_with(&[
            ("index.html", b"<html><head></head><body>app</body></html>"),
            ("assets/app.js", b"console.log('ok')"),
            ("assets/app.css", b"body{}"),
            ("assets/logo.svg", b"<svg></svg>"),
        ]);

        let javascript = serve(&store, "/assets/app.js");
        assert_eq!(javascript.status(), 200);
        assert_eq!(javascript.body(), b"console.log('ok')");
        assert_eq!(
            javascript.header("content-type"),
            Some("application/javascript; charset=utf-8")
        );
        assert_eq!(
            serve(&store, "/assets/app.css").header("content-type"),
            Some("text/css; charset=utf-8")
        );
        assert_eq!(
            serve(&store, "/assets/logo.svg").header("content-type"),
            Some("image/svg+xml")
        );

        let spa = serve(&store, "/channels/general");
        assert_eq!(spa.status(), 200);
        assert!(body_text(&spa).contains("<body>app</body>"));
        assert_eq!(serve(&store, "/assets/missing.js").status(), 404);
        assert_eq!(serve(&store, "/profile/jane.doe").status(), 404);
    }

    #[test]
    fn rejects_noncanonical_or_encoded_path_bypasses() {
        let (_app_data, store) = store_with(&[("index.html", b"<html></html>")]);

        for path in [
            "relative",
            "//etc/passwd",
            "/../secret",
            "/./secret",
            "/assets//app.js",
            "/assets\\app.js",
            "/%2e%2e/secret",
            "/%2E%2E/secret",
            "/%252e%252e/secret",
            "/%2fetc/passwd",
            "/assets%2fapp.js",
            "/assets%5capp.js",
            "/assets/%",
            "/assets/app.js?x=1",
        ] {
            assert_eq!(serve(&store, path).status(), 400, "accepted {path}");
        }
    }

    #[test]
    fn reads_only_the_current_build() {
        let (_app_data, store) = store_with(&[("index.html", b"<html></html>")]);
        let previous = store.release_path("a33a665e06f3b3dcb1d45f9cccbad0be83581637");
        fs::create_dir_all(&previous).unwrap();
        fs::write(previous.join("previous.js"), b"secret").unwrap();

        assert_eq!(serve(&store, "/previous.js").status(), 404);
    }

    #[test]
    fn rejects_assets_larger_than_sixteen_mibibytes() {
        let oversized = vec![b'x'; MAX_ASSET_BYTES + 1];
        let (_app_data, store) = store_with(&[
            ("index.html", b"<html></html>"),
            ("assets/oversized.wasm", oversized.as_slice()),
        ]);

        assert_eq!(serve(&store, "/assets/oversized.wasm").status(), 413);
    }

    #[test]
    fn verified_protocol_ignores_tampered_extracted_files() {
        let (_app_data, store) = verified_store();
        fs::write(
            store.release_path(BUILD_ID).join("index.html"),
            b"<html><body>tampered</body></html>",
        )
        .unwrap();
        let cache = Mutex::new(UiProtocolCache::default());

        let response = serve_verified(
            &cache,
            &store,
            "0.2.94",
            SUPPORTED_UI_ABI,
            &AcceptVerifier,
            "/",
        );

        assert_eq!(response.status(), 200);
        assert!(body_text(&response).contains("<body>signed</body>"));
        assert!(!body_text(&response).contains("tampered"));
    }
}
