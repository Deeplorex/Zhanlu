"""AI 通道：本地 Ollama / 用户自配远程模型（OpenAI 兼容 / Anthropic），仅保存在本机。

密钥经 Windows DPAPI 加密存储（secure.py）；无 DPAPI 环境退化为旧混淆。
所有请求走 urllib，明确超时；不做任何遥测。
"""

from __future__ import annotations

import base64
import json
import time
import urllib.error
import urllib.request
import uuid as uuidlib

from .. import config, secure

PROTOCOLS = [
    {"id": "ollama", "name": "Ollama 本地（默认）", "hint": "本机 http://127.0.0.1:11434/v1，文字不出本机"},
    {"id": "openai", "name": "OpenAI · Chat Completions", "hint": "兼容 DeepSeek 等 ChatGPT 接口；baseurl 形如 https://api.deepseek.com/v1"},
    {"id": "openai-responses", "name": "OpenAI · Responses", "hint": "OpenAI 官方新接口；baseurl 形如 https://api.openai.com/v1"},
    {"id": "anthropic", "name": "Anthropic", "hint": "baseurl 形如 https://api.anthropic.com"},
]


# ---------- 密钥加密存储（DPAPI，兼容历史混淆值） ----------

def obfuscate(secret: str) -> str:
    return secure.protect_secret(secret)


def deobfuscate(token: str) -> str:
    return secure.unprotect_secret(token)


# ---------- 配置管理 ----------

def _settings() -> dict:
    return config.load_settings()


def list_configs() -> list[dict]:
    cfgs = _settings()["ai"]["configs"]
    out = []
    for c in cfgs:
        c2 = {k: v for k, v in c.items() if k != "key"}
        c2["has_key"] = bool(deobfuscate(c.get("key", "")).strip())
        if c.get("key"):
            c2["key_masked"] = c["key"][:4] + "••••" + c["key"][-4:] if len(c["key"]) > 8 else "••••"
        out.append(c2)
    return out


def _is_local_cfg(c: dict) -> bool:
    from urllib.parse import urlparse
    host = (urlparse(str(c.get("baseurl", ""))).hostname or "").lower()
    return host in {"127.0.0.1", "localhost", "::1"}


def active_config() -> dict | None:
    """按用户设定的通道优先级选择当前配置。

    - 用户显式启用的配置（active id）永远最优先；
    - 未显式启用时，按 prefer（"cloud" | "local"）选对应通道的第一个配置，
      该通道没有可用配置时自动落到另一通道（备选语义）。
    """
    s = _settings()["ai"]
    prefer = s.get("prefer") or "cloud"
    if prefer not in ("cloud", "local"):
        prefer = "cloud"
    active = s.get("active")
    for c in s["configs"]:
        if c["id"] == active:
            return c
    preferred = [c for c in s["configs"] if _is_local_cfg(c) == (prefer == "local")]
    fallback = [c for c in s["configs"] if _is_local_cfg(c) != (prefer == "local")]
    for pool in (preferred, fallback):
        if pool:
            return pool[0]
    return None


def active_config_full() -> dict | None:
    """带解密 key 的配置，仅引擎内部使用。"""
    cfg = active_config()
    if not cfg:
        return None
    full = dict(cfg)
    full["key_plain"] = deobfuscate(cfg.get("key", ""))
    return full


def config_by_id_full(config_id: str) -> dict | None:
    """Resolve a saved model for one task without changing the global default."""
    for cfg in _settings()["ai"]["configs"]:
        if cfg.get("id") == config_id:
            full = dict(cfg)
            full["key_plain"] = deobfuscate(cfg.get("key", ""))
            return full
    return None


def save_configs(payload: dict) -> dict:
    """payload: {configs: [...], active: id, prefer: "cloud"|"local"}。key 若为掩码占位则保留原值。"""
    s = config.load_settings()
    old_by_id = {c["id"]: c for c in s["ai"]["configs"]}
    cleaned = []
    for c in payload.get("configs", []):
        c = dict(c)
        cid = c.get("id") or uuidlib.uuid4().hex[:8]
        c["id"] = cid
        if c.get("key") and "••" in c["key"]:
            old = old_by_id.get(cid, {})
            c["key"] = old.get("key", "")
        elif c.get("key") is not None and c.get("key") != "":
            c["key"] = obfuscate(str(c["key"]))
        elif cid in old_by_id and not c.get("key"):
            c["key"] = old_by_id[cid].get("key", "")
        else:
            c.pop("key", None)
        cleaned.append(c)
    prefer = payload.get("prefer")
    prefer = prefer if prefer in ("cloud", "local") else s["ai"].get("prefer") or "cloud"
    if "active" in payload:
        # 前端总是显式传 active（可为 null）——null 表示未显式启用，按通道优先级自动选择
        active_id = payload.get("active") or None
    else:
        active_id = payload.get("active") or (cleaned[0]["id"] if cleaned else None)
    s["ai"] = {"configs": cleaned, "active": active_id, "prefer": prefer}
    config.save_settings(s)
    return {"ok": True, "count": len(cleaned), "prefer": prefer}


# ---------- HTTP 客户端 ----------

def _request(url: str, headers: dict, body: dict | None, timeout: int) -> dict:
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method="POST" if data else "GET")
    req.add_header("Content-Type", "application/json")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=max(5, timeout)) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            detail = exc.read().decode("utf-8", "ignore")[:300]
        except Exception:  # noqa: BLE001
            pass
        raise RuntimeError(f"模型服务返回 {exc.code}: {detail or exc.reason}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"无法连接模型服务: {exc.reason}") from exc


def _headers(cfg: dict) -> dict:
    h = {}
    if cfg.get("protocol") == "anthropic":
        h["x-api-key"] = cfg.get("key_plain", "")
        h["anthropic-version"] = "2023-06-01"
    else:
        h["Authorization"] = f"Bearer {cfg.get('key_plain', '')}"
    for k, v in (cfg.get("headers") or {}).items():
        h[k] = v
    return h


def _parse_responses(resp: dict) -> str:
    """OpenAI Responses 接口的返回：优先 output_text，其次遍历 output[].content[].output_text。"""
    if isinstance(resp.get("output_text"), str) and resp["output_text"]:
        return resp["output_text"]
    parts: list[str] = []
    for item in resp.get("output") or []:
        if not isinstance(item, dict):
            continue
        for piece in item.get("content") or []:
            if isinstance(piece, dict) and piece.get("type") == "output_text":
                parts.append(str(piece.get("text", "")))
    text = "".join(parts)
    if not text:
        raise RuntimeError(f"模型响应格式异常: {json.dumps(resp, ensure_ascii=False)[:300]}")
    return text


def chat(cfg: dict, messages: list, max_tokens: int = 2048, temperature: float | None = None) -> str:
    base = str(cfg.get("baseurl", "")).rstrip("/")
    if not base:
        raise RuntimeError("未配置 BaseURL")
    timeout = int(cfg.get("timeout", 60))
    temp = cfg.get("temperature") if temperature is None else temperature
    if cfg.get("protocol") == "anthropic":
        url = base + "/v1/messages"
        body = {
            "model": cfg.get("model", ""),
            "max_tokens": max_tokens,
            "messages": messages,
        }
        if temp is not None:
            body["temperature"] = float(temp)
        return _chat_with_budget_guard(url, _headers(cfg), body, timeout,
                                       lambda r: ("".join(p.get("text", "") for p in (r.get("content") or []) if isinstance(p, dict)),
                                                  r.get("stop_reason") == "max_tokens"),
                                       "max_tokens")
    if cfg.get("protocol") == "openai-responses":
        url = base + "/responses"
        body: dict = {"model": cfg.get("model", ""), "input": messages, "max_output_tokens": max_tokens}
        if temp is not None:
            body["temperature"] = float(temp)
        return _chat_with_budget_guard(url, _headers(cfg), body, timeout,
                                       lambda r: (_parse_responses(r), r.get("status") == "incomplete"),
                                       "max_output_tokens")
    url = base + "/chat/completions"
    body = {"model": cfg.get("model", ""), "messages": messages, "max_tokens": max_tokens}
    if temp is not None:
        body["temperature"] = float(temp)
    def _openai_text(r: dict) -> tuple[str, bool]:
        try:
            choice = r["choices"][0]
            return choice["message"]["content"] or "", choice.get("finish_reason") == "length"
        except (KeyError, IndexError, TypeError) as exc:
            raise RuntimeError(f"模型响应格式异常: {json.dumps(r, ensure_ascii=False)[:300]}") from exc
    return _chat_with_budget_guard(url, _headers(cfg), body, timeout, _openai_text, "max_tokens")


def _chat_with_budget_guard(url: str, headers: dict, body: dict, timeout: int,
                            extract, token_field: str) -> str:
    """带思考模型（如 GLM）会先消耗 reasoning token：正文可能为空（stop 或 length 截断），
    也可能只剩被 length 截断的残片——残片非空不等于内容完整，静默放行会让分段笔记
    只剩标题一类碎片进入最终拼接。出现任一不完整信号（空正文或 length 截断）即加倍
    预算重试一次；重试后仍不完整时返回内容最长的一次（尽力而为），两次都没有正文
    才明确报错。绝不让空回答或静默截断的残片冒充有效内容。"""
    best = ""
    for attempt in range(2):
        resp = _request(url, headers, body, timeout)
        try:
            text, truncated = extract(resp)
        except RuntimeError:
            raise
        if text and not truncated:
            return text
        if len(text) > len(best):
            best = text
        if attempt == 0:
            body[token_field] = min(int(body.get(token_field, 0) or 0) * 2 or 2048, 16384)
    if best.strip():
        return best
    raise RuntimeError("模型回复为空：思考消耗超出 token 预算，请降低思考强度后重试。")


def test_config(cfg_full: dict) -> dict:
    t0 = time.time()
    try:
        reply = chat(cfg_full, [{"role": "user", "content": "回复两个字：湛卢"}], max_tokens=1024, temperature=0)
        return {"ok": True, "ms": int((time.time() - t0) * 1000), "message": (reply or "").strip()[:60]}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "ms": int((time.time() - t0) * 1000), "message": str(exc)[:300]}
