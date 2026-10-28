import io
import json
import tempfile
import time
import unittest
from pathlib import Path

import _zlenv  # noqa: F401
from zhanlu import desktop, server
from zhanlu.store import Store


class TestDesktopFiles(unittest.TestCase):
    def setUp(self):
        desktop.take()
        desktop.take_drops()
        with desktop._lock:
            desktop._drop_requests.clear()
            desktop._expired_drops.clear()
        _zlenv._TMP.mkdir(parents=True, exist_ok=True)
        self.directory = tempfile.TemporaryDirectory(dir=_zlenv._TMP)
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "合同 空格.PDF"
        self.path.write_bytes(b"%PDF-test")
        self.store = Store()

    def test_repeated_activation_reuses_id_without_changing_source(self):
        desktop.receive([str(self.path)], self.store)
        first = desktop.take()
        desktop.receive([str(self.path)], self.store)
        second = desktop.take()
        self.assertEqual(first["files"][0]["id"], second["files"][0]["id"])
        self.assertEqual(first["files"][0]["name"], "合同 空格.PDF")
        self.assertEqual(self.path.read_bytes(), b"%PDF-test")
        self.assertEqual(desktop.take(), {"files": [], "errors": []})

    def test_missing_or_non_pdf_does_not_hide_valid_file(self):
        desktop.receive([str(self.path.with_suffix(".txt")), str(self.path.parent), str(self.path)], self.store)
        result = desktop.take()
        self.assertEqual(len(result["errors"]), 2)
        self.assertEqual(len(result["files"]), 1)

    def test_stdin_accepts_unicode_json_and_ignores_invalid_messages(self):
        stream = io.StringIO('bad json\n{}\n' + json.dumps([str(self.path)], ensure_ascii=False) + '\n')
        desktop.start(stream, self.store)
        result = {"files": []}
        for _ in range(50):
            result = desktop.take()
            if result["files"]:
                break
            time.sleep(.01)
        self.assertEqual(result["files"][0]["name"], self.path.name)

    def test_drop_is_separate_from_activation_and_preserves_real_source(self):
        image = self.path.with_suffix(".png")
        image.write_bytes(b"image bytes")
        desktop.receive_drop("drop-1", [str(self.path), str(image), str(self.path.with_suffix(".txt"))], self.store)
        self.assertFalse(any(e["path"] == str(image) for e in self.store.list()))
        self.assertEqual(desktop.take_drops(), [])
        self.assertEqual(desktop.accept_drop("drop-1", self.store), {"accepted": True})
        self.assertEqual(desktop.take(), {"files": [], "errors": []})
        drops = self.wait_drops()
        self.assertEqual(len(drops), 1)
        self.assertEqual(drops[0]["id"], "drop-1")
        self.assertEqual([e["name"] for e in drops[0]["files"]], [self.path.name, image.name])
        self.assertEqual([Path(e["path"]).parent for e in drops[0]["files"]], [self.path.parent, self.path.parent])
        self.assertEqual(len(drops[0]["errors"]), 1)
        self.assertEqual(desktop.take_drops(), [])

    def test_stdin_routes_drop_by_id_and_ignores_malformed_requests(self):
        message = {"type": "drop", "id": "abc", "paths": [str(self.path)]}
        stream = io.StringIO(json.dumps({"type": "drop", "paths": [str(self.path)]}) + '\n' +
                             json.dumps(message, ensure_ascii=False) + '\n')
        desktop.start(stream, self.store)
        for _ in range(50):
            if desktop.accept_drop("abc", self.store)["accepted"]:
                break
            time.sleep(.01)
        drops = self.wait_drops()
        self.assertEqual([d["id"] for d in drops], ["abc"])
        self.assertEqual(drops[0]["files"][0]["name"], self.path.name)
        self.assertEqual(desktop.take(), {"files": [], "errors": []})

    def wait_drops(self):
        for _ in range(50):
            drops = desktop.take_drops()
            if drops:
                return drops
            time.sleep(.01)
        return []

    def test_drop_read_is_id_only_with_no_http_path_registration_route(self):
        desktop.receive_drop("read-id", [str(self.path)], self.store)
        self.assertTrue(desktop.accept_drop("read-id", self.store)["accepted"])
        drops = self.wait_drops()
        with desktop._lock:
            desktop._drops.extend(drops)
        response = server.api_desktop_drop_files({}, {})
        self.assertEqual(response["drops"][0]["id"], "read-id")
        self.assertEqual(response["drops"][0]["files"][0]["source_dir"], str(self.path.parent))
        self.assertNotIn(("POST", "/api/desktop/drop-files"), server.JSON_ROUTES)
        with self.assertRaises(server.ApiError):
            server.api_desktop_drop_accept({}, {"id": "read-id", "path": str(self.path)})
        self.assertEqual(server.api_desktop_drop_files({}, {}), {"drops": []})

    def test_accept_before_stdin_retries_and_unknown_id_does_not_register(self):
        self.assertEqual(desktop.accept_drop("late-id", self.store), {"accepted": False})
        desktop.receive_drop("late-id", [str(self.path)], self.store)
        self.assertEqual(desktop.accept_drop("late-id", self.store), {"accepted": True})
        self.assertEqual(desktop.accept_drop("late-id", self.store), {"accepted": True})
        self.assertEqual(len(self.wait_drops()[0]["files"]), 1)

    def test_expired_and_evicted_pending_drops_do_not_register(self):
        desktop.receive_drop("expired", [str(self.path)], self.store)
        with desktop._lock:
            desktop._drop_requests["expired"]["expires"] = 0
        self.assertEqual(desktop.accept_drop("expired", self.store), {"accepted": False, "expired": True})
        self.assertFalse(any(e["path"] == str(self.path) for e in self.store.list()))
        self.assertTrue(desktop.take_drops()[0]["errors"])
        for i in range(desktop._DROP_LIMIT + 1):
            desktop.receive_drop(f"queued-{i}", [str(self.path)], self.store)
        self.assertEqual(desktop.accept_drop("queued-0", self.store), {"accepted": False, "expired": True})
        self.assertTrue(desktop.take_drops()[0]["errors"])
