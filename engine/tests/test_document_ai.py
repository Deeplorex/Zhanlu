import _zlenv  # noqa: F401 — 固定测试数据目录（须先于 zhanlu 导入）

import unittest
from pathlib import Path
from unittest.mock import patch

from zhanlu.core import ai, document_ai
from zhanlu import jobs


class TestDocumentAi(unittest.TestCase):
    def test_sending_scope_matches_each_operation(self):
        pages = ["采购合同金额为三万元", "", "项目总结与待办事项"]
        with patch.object(document_ai.pdfops, "extract_text", return_value=pages):
            summary = document_ai.sending_scope(Path("example.pdf"), "summary")
            question = document_ai.sending_scope(Path("example.pdf"), "ask", question="待办事项")
            selection = document_ai.sending_scope(Path("example.pdf"), "explain", selection="合同金额", selection_page=1)
        self.assertEqual(summary["pages"], [1, 3])
        self.assertEqual(question["pages"], [1, 3])
        self.assertEqual(selection["pages"], [1])
        self.assertEqual(selection["characters"], len("合同金额"))

    def test_uncited_or_unavailable_pages_are_not_presented_as_sources(self):
        pages = ["第一段", "第二段"]
        self.assertEqual(document_ai._cited_sources("无法从材料确定。", pages, [0, 1]), [])
        self.assertEqual(document_ai._cited_sources("见第 2 页。", pages, [0]), [])

    def test_remote_classification_uses_host_not_protocol_label(self):
        self.assertTrue(document_ai.is_local_model({"protocol": "ollama", "baseurl": "http://127.0.0.1:11434/v1"}))
        self.assertFalse(document_ai.is_local_model({"protocol": "ollama", "baseurl": "https://example.com/v1"}))

    def test_question_retrieves_matching_page_and_returns_source(self):
        pages = ["设计目标与阅读体验", "采购合同金额为三万元，履行期限一年", "项目总结与待办"]
        with patch.object(document_ai.pdfops, "extract_text", return_value=pages), \
             patch.object(document_ai.ai, "chat", return_value="合同金额为三万元。第 2 页") as model:
            result = document_ai.analyze(Path("example.pdf"), {"baseurl": "http://localhost:11434/v1"},
                                         "ask", question="采购合同金额是多少？")
        self.assertEqual(result["sources"][0]["page"], 2)
        self.assertIn("[第 2 页]", model.call_args.args[1][1]["content"])
        self.assertTrue(result["local"])

    def test_scanned_document_requires_ocr(self):
        with patch.object(document_ai.pdfops, "extract_text", return_value=["", ""]):
            with self.assertRaisesRegex(ValueError, "OCR"):
                document_ai.analyze(Path("scan.pdf"), {"baseurl": "http://localhost:11434/v1"}, "summary")

    def test_deep_answer_changes_instruction_and_budget(self):
        with patch.object(document_ai.pdfops, "extract_text", return_value=["第 1 页记录了风险事项。"]), \
             patch.object(document_ai.ai, "chat", return_value="风险事项见第 1 页。") as model:
            document_ai.analyze(Path("example.pdf"), {"baseurl": "http://localhost:11434/v1"},
                                "ask", question="有哪些风险？", depth="deep")
        self.assertIn("整理相关证据", model.call_args.args[1][0]["content"])
        # 思考型模型需要正文预算余量：max 档（原 deep）4500
        self.assertEqual(model.call_args.kwargs["max_tokens"], 4500)

    def test_task_uses_selected_saved_model(self):
        saved = {"ai": {"configs": [
            {"id": "model-a", "name": "模型 A", "baseurl": "https://example.com/v1"},
            {"id": "model-b", "name": "模型 B", "baseurl": "http://localhost:11434/v1"},
        ]}}
        with patch.object(ai, "_settings", return_value=saved), \
             patch.object(ai, "deobfuscate", return_value=""), \
             patch.object(ai, "active_config_full") as global_default:
            cfg, local = jobs._ai_ready({"config_id": "model-b"})
        global_default.assert_not_called()
        self.assertEqual(cfg["id"], "model-b")
        self.assertTrue(local)

    def test_selected_remote_model_still_requires_document_consent(self):
        remote = {"id": "remote-b", "baseurl": "https://example.com/v1", "key_plain": "test-key"}
        with patch.object(ai, "config_by_id_full", return_value=remote):
            with self.assertRaisesRegex(document_ai.pdfops.OpError, "确认发送范围"):
                jobs._ai_ready({"config_id": "remote-b"})

    def test_local_model_override_must_be_installed(self):
        local = {"id": "local-a", "baseurl": "http://localhost:11434/v1", "model": "default"}
        with patch.object(ai, "config_by_id_full", return_value=local), \
             patch.object(jobs.localai, "list_models", return_value=[{"name": "installed"}]):
            chosen, _ = jobs._ai_ready({"config_id": "local-a", "model_override": "installed"})
            self.assertEqual(chosen["model"], "installed")
            with self.assertRaisesRegex(document_ai.pdfops.OpError, "未安装"):
                jobs._ai_ready({"config_id": "local-a", "model_override": "unknown"})

    def test_parse_responses_output_array_and_output_text(self):
        resp = {"output": [
            {"type": "reasoning", "content": [{"type": "reasoning_text", "text": "思考"}]},
            {"type": "message", "content": [{"type": "output_text", "text": "湛卢"},
                                             {"type": "output_text", "text": "可用"}]},
        ]}
        self.assertEqual(ai._parse_responses(resp), "湛卢可用")
        self.assertEqual(ai._parse_responses({"output_text": "直接文本"}), "直接文本")
        with self.assertRaisesRegex(RuntimeError, "响应格式异常"):
            ai._parse_responses({"output": []})

    def test_protocols_list_two_openai_forms(self):
        ids = [p["id"] for p in ai.PROTOCOLS]
        self.assertIn("openai", ids)
        self.assertIn("openai-responses", ids)
        self.assertIn("anthropic", ids)


if __name__ == "__main__":
    unittest.main()


class ChatBudgetGuardTest(unittest.TestCase):
    """思考型模型把 token 预算耗在 reasoning 上的守卫：空正文或 length 截断残片都不得静默放行。"""

    CFG = {"protocol": "openai", "baseurl": "https://example.com/v1", "model": "m", "key_plain": "k"}

    def test_empty_content_with_length_truncation_retries_with_doubled_budget(self):
        from unittest.mock import patch
        from zhanlu.core import ai
        calls = []

        def fake_request(url, headers, body, timeout):
            calls.append(body["max_tokens"])
            if len(calls) == 1:
                return {"choices": [{"finish_reason": "length", "message": {"content": "", "role": "assistant"}}]}
            return {"choices": [{"finish_reason": "stop", "message": {"content": "有效回答", "role": "assistant"}}]}

        with patch.object(ai, "_request", side_effect=fake_request):
            self.assertEqual(ai.chat(self.CFG, [{"role": "user", "content": "hi"}], max_tokens=200), "有效回答")
        self.assertEqual(calls, [200, 400])

    def test_partial_fragment_with_length_truncation_retries_for_complete_answer(self):
        from unittest.mock import patch
        from zhanlu.core import ai
        calls = []

        def fake_request(url, headers, body, timeout):
            calls.append(body["max_tokens"])
            if len(calls) == 1:
                # 残片非空但被截断：旧实现会静默返回它，笔记只剩标题碎片
                return {"choices": [{"finish_reason": "length", "message": {"content": "标题行", "role": "assistant"}}]}
            return {"choices": [{"finish_reason": "stop", "message": {"content": "完整的多点笔记", "role": "assistant"}}]}

        with patch.object(ai, "_request", side_effect=fake_request):
            self.assertEqual(ai.chat(self.CFG, [{"role": "user", "content": "hi"}], max_tokens=200), "完整的多点笔记")
        self.assertEqual(calls, [200, 400])

    def test_still_truncated_after_retry_returns_longest_best_effort(self):
        from unittest.mock import patch
        from zhanlu.core import ai

        def fake_request(url, headers, body, timeout):
            if body["max_tokens"] == 200:
                return {"choices": [{"finish_reason": "length", "message": {"content": "短", "role": "assistant"}}]}
            return {"choices": [{"finish_reason": "length", "message": {"content": "较长但仍被截断的残片", "role": "assistant"}}]}

        with patch.object(ai, "_request", side_effect=fake_request):
            self.assertEqual(ai.chat(self.CFG, [{"role": "user", "content": "hi"}], max_tokens=200), "较长但仍被截断的残片")

    def test_still_empty_after_retry_raises_clear_error(self):
        from unittest.mock import patch
        from zhanlu.core import ai
        attempts = []

        def fake_request(url, headers, body, timeout):
            attempts.append(1)
            return {"choices": [{"finish_reason": "length", "message": {"content": "", "role": "assistant"}}]}

        with patch.object(ai, "_request", side_effect=fake_request):
            with self.assertRaisesRegex(RuntimeError, "思考消耗超出"):
                ai.chat(self.CFG, [{"role": "user", "content": "hi"}], max_tokens=200)
        self.assertEqual(len(attempts), 2)

    def test_empty_content_with_stop_finish_also_retries_then_raises(self):
        from unittest.mock import patch
        from zhanlu.core import ai
        calls = []

        def fake_request(url, headers, body, timeout):
            calls.append(body["max_tokens"])
            return {"choices": [{"finish_reason": "stop", "message": {"content": "", "role": "assistant"}}]}

        # stop+空不再静默返回空串：重试一次，仍为空则明确报错
        with patch.object(ai, "_request", side_effect=fake_request):
            with self.assertRaisesRegex(RuntimeError, "模型回复为空"):
                ai.chat(self.CFG, [{"role": "user", "content": "hi"}], max_tokens=200)
        self.assertEqual(calls, [200, 400])

    def test_complete_answer_on_first_attempt_makes_single_call(self):
        from unittest.mock import patch
        from zhanlu.core import ai
        calls = []

        def fake_request(url, headers, body, timeout):
            calls.append(body["max_tokens"])
            return {"choices": [{"finish_reason": "stop", "message": {"content": "正常回答", "role": "assistant"}}]}

        with patch.object(ai, "_request", side_effect=fake_request):
            self.assertEqual(ai.chat(self.CFG, [{"role": "user", "content": "hi"}], max_tokens=200), "正常回答")
        self.assertEqual(calls, [200])


class ExtractMarkdownTest(unittest.TestCase):
    """PDF → Markdown：字号层级 → 标题，行首符号 → 列表；空文字层页返回空。"""

    TMP = _zlenv.__dict__.get("_TMP") or Path(__file__).parent

    @staticmethod
    def _make_pdf(tmp: Path, blank: bool = False) -> Path:
        from pypdf import PdfWriter
        from pypdf.generic import NameObject, DictionaryObject, DecodedStreamObject
        import io
        w = PdfWriter()
        w.add_blank_page(width=595, height=842)
        page = w.pages[0]
        if not blank:
            lines = [
                "BT /F1 24 Tf 60 760 Td (Contract Title) Tj ET",
                "BT /F1 18 Tf 60 700 Td (Section One) Tj ET",
                "BT /F1 12 Tf 60 650 Td (" + chr(0x95) + " first item) Tj ET",
                "BT /F1 12 Tf 60 620 Td (Body text line one.) Tj ET",
                "BT /F1 12 Tf 60 600 Td (Body text line two.) Tj ET",
            ]
            stream = chr(10).join(lines).encode("latin-1")
            font = w._add_object(DictionaryObject({
                NameObject("/Type"): NameObject("/Font"), NameObject("/Subtype"): NameObject("/Type1"),
                NameObject("/BaseFont"): NameObject("/Helvetica"), NameObject("/Encoding"): NameObject("/WinAnsiEncoding")}))
            page[NameObject("/Resources")] = DictionaryObject({
                NameObject("/Font"): DictionaryObject({NameObject("/F1"): font})})
            contents = DecodedStreamObject()
            contents.set_data(stream)
            page[NameObject("/Contents")] = w._add_object(contents)
        buf = io.BytesIO()
        w.write(buf)
        out = tmp / ("md-convert-blank.pdf" if blank else "md-convert.pdf")
        out.write_bytes(buf.getvalue())
        return out

    def test_markdown_has_headings_lists(self):
        from zhanlu.core import pdfops
        pdf = self._make_pdf(self.TMP)
        pages = pdfops.extract_markdown(pdf)
        self.assertEqual(len(pages), 1)
        md = pages[0]
        self.assertIn("# Contract Title", md)
        self.assertIn("## Section One", md)
        self.assertIn("- first item", md)
        self.assertIn("Body text line one.", md)

    def test_blank_page_returns_empty(self):
        from zhanlu.core import pdfops
        pdf = self._make_pdf(self.TMP, blank=True)
        self.assertEqual(pdfops.extract_markdown(pdf), [""])
