"""页面整理（P04，06 改版 137–168）：计划校验、插入/复制/移动/旋转/删除、导入源权限与失效、预览与执行同源。"""

import io
import json
import os
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest.mock import patch

import _zlenv  # noqa: F401 — 固定测试数据目录（须先于 zhanlu 导入）

TMP = _zlenv.__dict__.get("_TMP") or Path(os.environ["ZHANLU_HOME"]).parent

from pypdf import PdfReader, PdfWriter  # noqa: E402
from pypdf.constants import UserAccessPermissions  # noqa: E402

from zhanlu.core import pdfops  # noqa: E402
from zhanlu.tasks import Cancelled, TaskContext  # noqa: E402


def make_pdf(path: Path, pages: int = 4, size=(595, 842)) -> Path:
    """每页带「Page N sample text」文字层的 PDF（pypdf 可抽取出，用于核对页序）。"""
    from reportlab.pdfgen import canvas

    writer = PdfWriter()
    for i in range(pages):
        page = writer.add_blank_page(width=size[0], height=size[1])
        buffer = io.BytesIO()
        drawing = canvas.Canvas(buffer, pagesize=size)
        drawing.drawString(36, size[1] - 60, f"Page {i + 1} sample text")
        drawing.save()
        buffer.seek(0)
        page.merge_page(PdfReader(buffer).pages[0])
    with open(path, "wb") as f:
        writer.write(f)
    return path


def make_restricted(path: Path, permissions) -> Path:
    """仅所有者密码、按 permissions 限制的 PDF（空用户密码可打开）。"""
    writer = PdfWriter()
    writer.add_blank_page(width=300, height=400)
    writer.add_blank_page(width=300, height=400)
    writer.encrypt("", owner_password="owner", permissions_flag=permissions)
    with open(path, "wb") as stream:
        writer.write(stream)
    return path


def texts(path: Path) -> list[str]:
    return [(page.extract_text() or "").strip() for page in PdfReader(str(path)).pages]


def ctx() -> TaskContext:
    return TaskContext({"id": "organize-test", "outputs": [], "pending_outputs": [], "cancel": threading.Event()})


class TestOrganizePlan(unittest.TestCase):
    """pdfops.organize_plan_check / organize_resolve / organize：预览与执行共用的校验与生成。"""

    def setUp(self):
        self.dir = TMP / "page-organize"
        self.dir.mkdir(parents=True, exist_ok=True)
        self.src = make_pdf(self.dir / "四页样本.pdf", 4)
        self.supplement = make_pdf(self.dir / "补充材料.pdf", 6)

    def test_legacy_plan_still_reorders_rotates_and_drops(self):
        summary = pdfops.organize_plan_check(4, [{"page": 4}, {"page": 1, "rotate": 90}, {"page": 2}])
        self.assertEqual(summary["count"], 3)
        self.assertEqual(summary["rotations"], [(2, 90)])
        self.assertEqual(summary["dropped"], [3])
        self.assertEqual((summary["imported"], summary["blanks"], summary["copies"]), (0, 0, 0))
        out = self.dir / "legacy.pdf"
        pdfops.organize(self.src, [{"page": 4}, {"page": 1, "rotate": 90}, {"page": 2}], out)
        reader = PdfReader(str(out))
        self.assertEqual(texts(out)[:1], ["Page 4 sample text"])
        self.assertEqual(reader.pages[1].rotation, 90)

    def test_page_range_accepts_common_dashes(self):
        """区间连字符容错：应用展示用的「–」与输入法常见的横线都按区间解析；倒序、越界仍报错。"""
        for dash in "-‐–—−－":
            with self.subTest(dash=hex(ord(dash))):
                self.assertEqual(pdfops.parse_pages(f"2{dash}4,1", 6), [1, 2, 3, 0])
        self.assertEqual(pdfops.parse_pages("2–6", 6), [1, 2, 3, 4, 5])
        with self.assertRaisesRegex(pdfops.OpError, "页码范围无效"):
            pdfops.parse_pages("5–3", 6)
        with self.assertRaisesRegex(pdfops.OpError, "无法识别"):
            pdfops.parse_pages("2~4", 6)

    def test_p04_scenario_seven_pages(self):
        """交接词样本：原第 2 页后插空白页 → 空白页后插补充 PDF 第 2、4 页 → 复制原第 3 页并独立右转、
        移到原第 2 页前 → 删除原第 4 页。另存 7 页：原 1、旋转副本、原 2、空白、导入 2、导入 4、原 3。"""
        plan = [
            {"page": 1, "rotate": 0},
            {"page": 3, "rotate": 90},                       # 副本：与原第 3 页同源，旋转独立
            {"page": 2, "rotate": 0},
            {"blank": True, "width": 595, "height": 842, "rotate": 0},
            {"file": "supplement", "page": 2, "rotate": 0},
            {"file": "supplement", "page": 4, "rotate": 0},
            {"page": 3, "rotate": 0},
        ]
        before = (self.src.read_bytes(), self.supplement.read_bytes())
        summary = pdfops.organize_plan_check(4, plan)
        self.assertEqual(summary["count"], 7)
        self.assertEqual(summary["rotations"], [(2, 90)])
        self.assertEqual(summary["dropped"], [4])
        self.assertEqual((summary["imported"], summary["blanks"], summary["copies"]), (2, 1, 1))
        out = self.dir / "整理结果.pdf"
        pdfops.organize(self.src, plan, out, imports={"supplement": self.supplement})
        reader = PdfReader(str(out))
        self.assertEqual(len(reader.pages), 7)
        self.assertEqual(texts(out), [
            "Page 1 sample text", "Page 3 sample text", "Page 2 sample text", "",
            "Page 2 sample text", "Page 4 sample text", "Page 3 sample text",
        ])
        self.assertEqual([page.rotation for page in reader.pages], [0, 90, 0, 0, 0, 0, 0])
        blank = reader.pages[3]
        self.assertEqual((round(float(blank.mediabox.width)), round(float(blank.mediabox.height))), (595, 842))
        # 所有输入原样保留
        self.assertEqual((self.src.read_bytes(), self.supplement.read_bytes()), before)

    def test_blank_page_keeps_given_size_and_each_instance_rotates_alone(self):
        plan = [{"blank": True, "width": 841.89, "height": 595.28},
                {"page": 2, "rotate": 180}, {"page": 2, "rotate": 270}, {"page": 2}]
        out = self.dir / "blank-rot.pdf"
        pdfops.organize(self.src, plan, out)
        reader = PdfReader(str(out))
        self.assertEqual([page.rotation for page in reader.pages], [0, 180, 270, 0])
        self.assertEqual(texts(out)[1:], ["Page 2 sample text"] * 3)
        self.assertEqual(round(float(reader.pages[0].mediabox.width)), 842)

    def test_plan_validation_errors(self):
        check = pdfops.organize_plan_check
        with self.assertRaisesRegex(pdfops.OpError, "至少保留一页"):
            check(4, [])
        with self.assertRaisesRegex(pdfops.OpError, "超出范围"):
            check(4, [{"page": 5}])
        with self.assertRaisesRegex(pdfops.OpError, "正整数"):
            check(4, [{"page": True}])
        with self.assertRaisesRegex(pdfops.OpError, "90 的倍数"):
            check(4, [{"page": 1, "rotate": 45}])
        with self.assertRaisesRegex(pdfops.OpError, "尺寸"):
            check(4, [{"blank": True, "width": 0, "height": 100}])
        with self.assertRaisesRegex(pdfops.OpError, "尺寸"):
            check(4, [{"blank": True, "width": "a", "height": 100}])
        with self.assertRaisesRegex(pdfops.OpError, "尺寸"):
            check(4, [{"blank": True, "width": 20000, "height": 100}])

    def test_import_source_range_and_missing_file(self):
        plan = [{"file": "supp", "page": 7}]
        with self.assertRaisesRegex(pdfops.OpError, "导入页码超出范围"):
            pdfops.organize(self.src, plan, self.dir / "x.pdf", imports={"supp": self.supplement})
        plan = [{"file": "supp", "page": 2}]
        with self.assertRaisesRegex(pdfops.OpError, "导入源文件已不存在"):
            pdfops.organize(self.src, plan, self.dir / "x.pdf", imports={"supp": self.dir / "不存在.pdf"})
        self.assertFalse((self.dir / "x.pdf").exists())

    def test_restricted_import_source_is_blocked(self):
        """导入源禁止提取时：探测给出原因，生成被阻止，目标目录不产生文件。"""
        no_extract = make_restricted(self.dir / "禁止提取.pdf",
                                     UserAccessPermissions.PRINT | UserAccessPermissions.MODIFY)
        probe = pdfops.import_probe(no_extract)
        self.assertEqual((probe["ok"], probe["pages"]), (False, 2))
        self.assertIn("禁止提取", probe["error"])
        plan = [{"page": 1}, {"file": "locked", "page": 2}]
        out = self.dir / "blocked.pdf"
        with self.assertRaisesRegex(pdfops.OpError, "禁止提取"):
            pdfops.organize(self.src, plan, out, imports={"locked": no_extract})
        self.assertFalse(out.exists())

    def test_import_probe_reports_unreadable_files(self):
        self.assertEqual(pdfops.import_probe(self.supplement), {"ok": True, "pages": 6, "error": None})
        broken = self.dir / "损坏.pdf"
        broken.write_bytes(b"%PDF-1.4\nnot really a pdf")
        probe = pdfops.import_probe(broken)
        self.assertFalse(probe["ok"])
        self.assertTrue(probe["error"])

    def test_cancel_before_write_leaves_no_output(self):
        plan = [{"page": 1}, {"file": "supp", "page": 3}, {"blank": True, "width": 100, "height": 100}]
        context = ctx()
        context._task["cancel"].set()
        out = self.dir / "cancelled.pdf"
        with self.assertRaises(Cancelled):
            pdfops.organize(self.src, plan, out, imports={"supp": self.supplement}, check=context.check)
        self.assertFalse(out.exists())

    def test_progress_reports_assembly(self):
        seen: list[tuple[float, str]] = []
        pdfops.organize(self.src, [{"page": 2}, {"page": 1}], self.dir / "progress.pdf",
                        progress=lambda value, detail="": seen.append((value, detail)))
        self.assertTrue(seen and seen[-1][0] <= 1.0)


class TestOrganizeJobs(unittest.TestCase):
    """jobs.preview_organize / run_organize：预览与执行共用一套来源核验。"""

    @classmethod
    def setUpClass(cls):
        from zhanlu import jobs

        cls.jobs = jobs
        cls.dir = TMP / "page-organize-jobs"
        cls.dir.mkdir(parents=True, exist_ok=True)
        cls.src = make_pdf(cls.dir / "合同.pdf", 4)
        cls.supplement = make_pdf(cls.dir / "附件.pdf", 6)
        cls.src_id = jobs.store.add_path(cls.src)["id"]
        cls.supp_id = jobs.store.add_path(cls.supplement)["id"]

    def _params(self, plan, **extra):
        return {"id": self.src_id, "plan": plan, "name": "合同-整理.pdf", "dir": str(self.dir / "out"), **extra}

    def test_preview_and_run_share_the_plan_and_keep_inputs(self):
        plan = [{"page": 1}, {"blank": True, "width": 595, "height": 842},
                {"file": self.supp_id, "page": 4}, {"file": self.supp_id, "page": 2}, {"page": 4}]
        before = (self.src.read_bytes(), self.supplement.read_bytes())
        preview = self.jobs.preview_organize(self._params(plan))
        self.assertTrue(preview["ok"], str(preview))
        self.assertEqual(preview["outputs"][0]["pages"], 5)
        self.assertEqual(preview["outputs"][0]["name"], "合同-整理.pdf")
        result = self.jobs.run_organize(self._params(plan), ctx())
        self.assertEqual(result["file"]["pages"], 5)
        out = Path(result["file"]["path"])
        self.assertEqual(out.name, "合同-整理.pdf")
        self.assertEqual(texts(out), ["Page 1 sample text", "", "Page 4 sample text", "Page 2 sample text", "Page 4 sample text"])
        self.assertEqual((self.src.read_bytes(), self.supplement.read_bytes()), before)
        # 同名再生成：自动编号，不覆盖
        second = self.jobs.run_organize(self._params(plan), ctx())
        self.assertEqual(Path(second["file"]["path"]).name, "合同-整理（1）.pdf")
        self.assertEqual(texts(out)[:1], ["Page 1 sample text"])

    def test_import_source_removed_after_preview_fails_run(self):
        temp = make_pdf(TMP / "page-organize-jobs" / "临时附件.pdf", 3)
        entry = self.jobs.store.add_path(temp)
        plan = [{"page": 1}, {"file": entry["id"], "page": 3}]
        preview = self.jobs.preview_organize(self._params(plan))
        self.assertTrue(preview["ok"], str(preview))
        temp.unlink()
        with self.assertRaisesRegex(pdfops.OpError, "已不存在"):
            self.jobs.preview_organize(self._params(plan))
        with self.assertRaisesRegex(pdfops.OpError, "已不存在"):
            self.jobs.run_organize(self._params(plan), ctx())

    def test_restricted_import_is_blocked_in_preview_and_run(self):
        locked = make_restricted(self.dir / "保密附件.pdf", UserAccessPermissions.PRINT)
        locked_id = self.jobs.store.add_path(locked)["id"]
        plan = [{"page": 1}, {"file": locked_id, "page": 1}]
        with self.assertRaisesRegex(pdfops.OpError, "禁止提取"):
            self.jobs.preview_organize(self._params(plan))
        with self.assertRaisesRegex(pdfops.OpError, "禁止提取"):
            self.jobs.run_organize(self._params(plan), ctx())
        self.assertFalse((self.dir / "out").exists() and list((self.dir / "out").glob("保密*")))

    def test_import_page_out_of_range_is_reported_with_source_total(self):
        plan = [{"file": self.supp_id, "page": 9}]
        with self.assertRaisesRegex(pdfops.OpError, "共 6 页"):
            self.jobs.preview_organize(self._params(plan))
        with self.assertRaisesRegex(pdfops.OpError, "共 6 页"):
            self.jobs.run_organize(self._params(plan), ctx())

    def test_non_pdf_cannot_be_an_import_source(self):
        note = self.dir / "说明.txt"
        note.write_text("x", encoding="utf-8")
        note_id = self.jobs.store.add_path(note)["id"]
        with self.assertRaisesRegex(pdfops.OpError, "仅支持插入 PDF"):
            self.jobs.preview_organize(self._params([{"page": 1}, {"file": note_id, "page": 1}]))


class TestOrganizeServerApi(unittest.TestCase):
    """HTTP：导入源探测接口、单选 PDF 选择器、整理任务的预览与执行。"""

    @classmethod
    def setUpClass(cls):
        from http.server import ThreadingHTTPServer

        from zhanlu import config, server as srv

        config.save_settings(config.DEFAULT_SETTINGS)
        srv.auth.dev_mode = True
        cls.srv = srv
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), srv.Handler)
        cls.base = f"http://127.0.0.1:{cls.httpd.server_address[1]}"
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()
        cls.dir = TMP / "page-organize-api"
        cls.dir.mkdir(parents=True, exist_ok=True)

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()

    def _get(self, path: str):
        with urllib.request.urlopen(self.base + path, timeout=10) as r:
            return json.loads(r.read().decode("utf-8"))

    def _post(self, path: str, body: dict):
        req = urllib.request.Request(self.base + path, data=json.dumps(body).encode("utf-8"),
                                     headers={"Content-Type": "application/json"}, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.status, json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            return exc.code, json.loads(exc.read().decode("utf-8"))

    def test_import_probe_endpoint(self):
        target = self.srv.store.add_path(make_pdf(self.dir / "接口目标.pdf", 6))
        for text, expected in (("2–4", {"ok": True, "pages": [2, 3, 4], "total": 6}),
                               ("9", {"ok": False, "pages": None, "error": "页码超出范围: 9（文档共 6 页）", "total": 6}),
                               ("", {"ok": True, "pages": None, "total": 6})):
            with self.subTest(text=text):
                self.assertEqual(self._post("/api/pages/parse", {"id": target["id"], "pages": text})[1], expected)
        normal = self.srv.store.add_path(make_pdf(self.dir / "可插入.pdf", 5))
        locked = self.srv.store.add_path(make_restricted(self.dir / "受限.pdf", UserAccessPermissions.PRINT))
        ok = self._get(f"/api/files/{normal['id']}/import-probe")
        self.assertEqual((ok["ok"], ok["pages"], ok["error"]), (True, 5, None))
        self.assertEqual(ok["name"], "可插入.pdf")
        bad = self._get(f"/api/files/{locked['id']}/import-probe")
        self.assertEqual((bad["ok"], bad["pages"]), (False, 2))
        self.assertIn("禁止提取", bad["error"])

    def test_source_picker_is_single_pdf_only(self):
        from types import SimpleNamespace

        pdf_path = make_pdf(self.dir / "选择.pdf", 2)
        picked = SimpleNamespace(returncode=0, stdout=str(pdf_path) + "\n" + str(pdf_path) + "\n")
        with patch.object(self.srv.subprocess, "run", return_value=picked) as run:
            result = self.srv.api_pick_pdfs({}, {"kind": "source"})
        self.assertFalse(result["cancelled"])
        self.assertEqual(len(result["files"]), 1)
        script = run.call_args.args[0][-1]
        self.assertIn("$d.Filter = 'PDF 文档|*.pdf';", script)
        self.assertIn("$d.Multiselect = $false;", script)

        image = self.dir / "图片.png"
        image.write_bytes(b"image")
        with patch.object(self.srv.subprocess, "run",
                          return_value=SimpleNamespace(returncode=0, stdout=str(image) + "\n")):
            result = self.srv.api_pick_pdfs({}, {"kind": "source"})
        self.assertEqual(result["files"], [])
        self.assertTrue(result["errors"] and "PDF" in result["errors"][0])

    def test_organize_task_with_import_over_http(self):
        target = self.srv.store.add_path(make_pdf(self.dir / "接口样本.pdf", 3))
        source = self.srv.store.add_path(make_pdf(self.dir / "接口附件.pdf", 4))
        plan = [{"page": 2}, {"file": source["id"], "page": 3}, {"blank": True, "width": 300, "height": 400}, {"page": 1}]
        params = {"id": target["id"], "plan": plan, "name": "接口-整理.pdf", "dir": str(self.dir / "out")}
        status, preview = self._post("/api/jobs/preview", {"kind": "organize", "params": params})
        self.assertEqual(status, 200)
        self.assertTrue(preview["ok"], str(preview))
        self.assertEqual(preview["outputs"][0]["pages"], 4)
        status, started = self._post("/api/jobs/run", {"kind": "organize", "params": params})
        self.assertEqual(status, 200)
        for _ in range(100):
            task = self._get(f"/api/tasks/{started['id']}")
            if task["status"] in ("done", "error", "cancelled"):
                break
        self.assertEqual(task["status"], "done", str(task.get("error")))
        out = task["outputs"][0]
        self.assertEqual((out["pages"], out["name"]), (4, "接口-整理.pdf"))
        self.assertEqual(texts(Path(out["path"])), ["Page 2 sample text", "Page 3 sample text", "", "Page 1 sample text"])

        # 非法页号：预览返回 ok=false 与原因，不建任务
        bad = dict(params, plan=[{"file": source["id"], "page": 99}])
        _status, rejected = self._post("/api/jobs/preview", {"kind": "organize", "params": bad})
        self.assertFalse(rejected["ok"])
        self.assertIn("导入页码超出范围", rejected["error"])


if __name__ == "__main__":
    unittest.main()
