import importlib.util
import json
import tempfile
import unittest
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread


SCRIPT = Path(__file__).with_name("linuxdo_grok_replenish.py")
SPEC = importlib.util.spec_from_file_location("linuxdo_grok_replenish", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


class LinuxDoGrokReplenishTest(unittest.TestCase):
    def test_discovers_grok_cpa_attachment_metadata_without_downloading(self):
        topic = {
            "topic": {"id": 2571014, "title": "新鲜 GROK CPA 直接导入"},
            "posts": [{
                "cooked": '<p>分享</p><a class="attachment" href="/uploads/short-url/example.7z">grok_cpa.7z</a>',
            }],
        }
        candidates = MODULE.discover_candidates(topic, "https://linux.do")
        self.assertEqual(candidates, [{
            "topic_id": 2571014,
            "topic_title": "新鲜 GROK CPA 直接导入",
            "filename": "grok_cpa.7z",
            "url": "https://linux.do/uploads/short-url/example.7z",
            "state": "awaiting_authorized_local_copy",
        }])

    def test_rejects_import_without_explicit_authorization(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source"
            target = Path(directory) / "target"
            source.mkdir()
            (source / "xai.json").write_text(json.dumps(valid_credential("a@example.com")))
            with self.assertRaisesRegex(PermissionError, "authorization"):
                MODULE.import_authorized_directory(source, target, authorized=False)

    def test_validates_deduplicates_and_atomically_imports_authorized_credentials(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source"
            target = Path(directory) / "target"
            source.mkdir()
            target.mkdir()
            credential = valid_credential("a@example.com")
            (source / "first.json").write_text(json.dumps(credential))
            (source / "duplicate.json").write_text(json.dumps(credential))
            (source / "invalid.json").write_text("{}")

            result = MODULE.import_authorized_directory(source, target, authorized=True)

            self.assertEqual(result, {"imported": 1, "duplicates": 1, "invalid": 1})
            imported = list(target.glob("*.json"))
            self.assertEqual(len(imported), 1)
            self.assertEqual(json.loads(imported[0].read_text())["email"], "a@example.com")

    def test_replenishes_an_exact_authorized_source_via_staging_idempotently(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = make_zip(root / "authorized.zip", {"credential.json": json.dumps(valid_credential("a@example.com"))})
            with serve_file(archive) as url:
                manifest = write_manifest(root, url)
                first = MODULE.replenish(manifest, "registered-source")
                second = MODULE.replenish(manifest, "registered-source")

            self.assertEqual(first, {"imported": 1, "duplicates": 0, "invalid": 0})
            self.assertEqual(second, {"imported": 0, "duplicates": 1, "invalid": 0})
            self.assertEqual(len(list((root / "target").glob("*.json"))), 1)
            self.assertEqual(list((root / "staging").iterdir()), [])

    def test_rejects_unregistered_or_non_exact_attachment_urls(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest = write_manifest(root, "http://127.0.0.1:9/exact.zip")
            with self.assertRaisesRegex(PermissionError, "not registered"):
                MODULE.replenish(manifest, "unknown")
            payload = json.loads(manifest.read_text())
            payload["sources"][0]["attachment_url"] = "http://127.0.0.1:9/changed.zip"
            manifest.write_text(json.dumps(payload))
            with self.assertRaisesRegex(PermissionError, "authorized attachment URL"):
                MODULE.replenish(manifest, "registered-source", attachment_url="http://127.0.0.1:9/exact.zip")

    def test_rejects_html_wrong_magic_invalid_json_and_oversized_archives_without_changing_target(self):
        fixtures = [
            (b"<html>challenge</html>", "archive magic"),
            (make_zip_bytes({"credential.json": "not-json"}), "credential JSON"),
            (make_zip_bytes({"credential.json": json.dumps(valid_credential("a@example.com"))}), "compressed archive exceeds"),
        ]
        for content, message in fixtures:
            with self.subTest(message=message), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                existing = root / "target" / "existing.json"
                existing.parent.mkdir()
                existing.write_text(json.dumps(valid_credential("existing@example.com")))
                fixture = root / "fixture.bin"
                fixture.write_bytes(content)
                with serve_file(fixture) as url:
                    manifest = write_manifest(root, url, max_archive_bytes=8 if message.startswith("compressed") else 1_000_000)
                    with self.assertRaisesRegex((ValueError, OSError), message):
                        MODULE.replenish(manifest, "registered-source")
                self.assertEqual(list((root / "target").glob("*.json")), [existing])

    def test_rejects_path_traversal_and_file_count_or_extracted_size_limits(self):
        cases = [
            ({"../escape.json": "{}"}, {}, "unsafe archive path"),
            ({"one.json": "{}", "two.json": "{}"}, {"max_files": 1}, "too many files"),
            ({"large.json": "x" * 100}, {"max_extracted_bytes": 10}, "extracted data exceeds"),
        ]
        for files, limits, message in cases:
            with self.subTest(message=message), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                archive = make_zip(root / "fixture.zip", files)
                with serve_file(archive) as url:
                    manifest = write_manifest(root, url, **limits)
                    with self.assertRaisesRegex(ValueError, message):
                        MODULE.replenish(manifest, "registered-source")
                self.assertFalse((root / "escape.json").exists())
                self.assertFalse((root / "target").exists())


def valid_credential(email: str):
    return {
        "type": "xai",
        "provider": "xai",
        "email": email,
        "access_token": "access-test-value",
        "refresh_token": "refresh-test-value",
        "expires_at": 2_000_000_000,
    }


def make_zip(path: Path, files: dict[str, str]) -> Path:
    with zipfile.ZipFile(path, "w") as archive:
        for name, content in files.items():
            archive.writestr(name, content)
    return path


def make_zip_bytes(files: dict[str, str]) -> bytes:
    with tempfile.NamedTemporaryFile(suffix=".zip") as handle:
        make_zip(Path(handle.name), files)
        return Path(handle.name).read_bytes()


def write_manifest(root: Path, attachment_url: str, **limits: int) -> Path:
    manifest = root / "authorized-sources.json"
    manifest.write_text(json.dumps({
        "staging_dir": str(root / "staging"),
        "target_dir": str(root / "target"),
        "limits": {
            "max_archive_bytes": limits.get("max_archive_bytes", 1_000_000),
            "max_extracted_bytes": limits.get("max_extracted_bytes", 1_000_000),
            "max_files": limits.get("max_files", 20),
        },
        "sources": [{
            "id": "registered-source",
            "topic_url": "https://linux.do/t/topic/authorized",
            "attachment_url": attachment_url,
        }],
    }))
    return manifest


class serve_file:
    def __init__(self, path: Path):
        self.path = path

    def __enter__(self):
        content = self.path.read_bytes()

        class Handler(BaseHTTPRequestHandler):
            def do_GET(inner_self):
                inner_self.send_response(200)
                inner_self.send_header("Content-Length", str(len(content)))
                inner_self.end_headers()
                inner_self.wfile.write(content)

            def log_message(self, *_args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        return f"http://127.0.0.1:{self.server.server_port}/{self.path.name}"

    def __exit__(self, *_args):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()


if __name__ == "__main__":
    unittest.main()
