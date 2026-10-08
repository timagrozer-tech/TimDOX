"""Нейросети для Мира QEVI: цепочка бесплатных OpenAI-совместимых провайдеров с дневным бюджетом токенов.

Порядок: Ollama (если задан OLLAMA_URL) → Groq → OpenRouter (:free) → любой AI_BASE_URL. Нет ключей — мир живёт на шаблонах.
"""
import json
import logging
import os
import re
import urllib.error
import urllib.request

from .. import db

log = logging.getLogger("krug.world.llm")

DAILY_TOKENS = int(os.environ.get("AI_DAILY_TOKENS", "120000"))


def providers() -> list[dict]:
    out = []
    if os.environ.get("OLLAMA_URL"):
        out.append({"name": "ollama", "url": os.environ["OLLAMA_URL"].rstrip("/") + "/v1/chat/completions", "key": "",
                    "model": os.environ.get("OLLAMA_MODEL", "qwen2.5:7b"), "json": True})
    if os.environ.get("GROQ_API_KEY"):
        out.append({"name": "groq", "url": "https://api.groq.com/openai/v1/chat/completions", "key": os.environ["GROQ_API_KEY"],
                    "model": os.environ.get("GROQ_MODEL", "openai/gpt-oss-120b"), "json": True})
    if os.environ.get("OPENROUTER_API_KEY"):
        out.append({"name": "openrouter", "url": "https://openrouter.ai/api/v1/chat/completions", "key": os.environ["OPENROUTER_API_KEY"],
                    "model": os.environ.get("OPENROUTER_MODEL", "openrouter/free"), "json": False})
    if os.environ.get("AI_BASE_URL"):
        out.append({"name": "custom", "url": os.environ["AI_BASE_URL"].rstrip("/") + "/chat/completions", "key": os.environ.get("AI_API_KEY", ""),
                    "model": os.environ.get("AI_MODEL", "gpt-4o-mini"), "json": False})
    return out


def enabled() -> bool:
    return bool(providers())


def _state(key: str, default: str = "") -> str:
    return db.value("SELECT value FROM ai_state WHERE key=?", (key,)) or default


def _set_state(key: str, value: str) -> None:
    db.run("DELETE FROM ai_state WHERE key=?", (key,))
    db.run("INSERT INTO ai_state (key, value) VALUES (?,?)", (key, value))


def used_today() -> int:
    return int(_state(f"tokens:{db.now()[:10]}", "0") or 0)


def budget_left() -> int:
    return DAILY_TOKENS - used_today()


def _post(p: dict, messages: list, max_tokens: int, want_json: bool) -> tuple[str, int]:
    payload = {"model": p["model"], "messages": messages, "max_tokens": max_tokens, "temperature": 0.9}
    if p["name"] == "groq" and "gpt-oss" in p["model"]:
        payload["reasoning_effort"] = "low"  # меньше скрытых «размышлений» — меньше токенов
    if want_json and p["json"]:
        payload["response_format"] = {"type": "json_object"}
    # без своего User-Agent Cloudflare перед API отвечает 403 на запросы Python
    headers = {"content-type": "application/json", "user-agent": "KrugWorld/1.0 (+https://krug-social.onrender.com)", "accept": "application/json"}
    if p["key"]:
        headers["authorization"] = f"Bearer {p['key']}"
    if p["name"] == "openrouter":
        headers["http-referer"] = "https://krug-social.onrender.com"
        headers["x-title"] = "Krug"
    req = urllib.request.Request(p["url"], data=json.dumps(payload).encode(), headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=90) as resp:
        data = json.loads(resp.read())
    text = data["choices"][0]["message"].get("content") or ""
    used = (data.get("usage") or {}).get("total_tokens") or (len(text) // 3 + sum(len(m["content"]) for m in messages) // 3)
    return text, int(used)


def complete(system: str, user: str, max_tokens: int = 1500, want_json: bool = False) -> str | None:
    """Синхронный вызов (запускать в отдельном потоке). None — нет провайдеров, бюджет исчерпан или все упали."""
    if budget_left() < max_tokens:
        return None
    messages = [{"role": "system", "content": system}, {"role": "user", "content": user}]
    for p in providers():
        try:
            text, used = _post(p, messages, max_tokens, want_json)
        except urllib.error.HTTPError as e:
            log.warning("LLM %s недоступен: %s %s", p["name"], e.code, e.read()[:200])
            continue
        except (urllib.error.URLError, TimeoutError, KeyError, ValueError, OSError) as e:
            log.warning("LLM %s недоступен: %s", p["name"], e)
            continue
        _set_state(f"tokens:{db.now()[:10]}", str(used_today() + used))
        _set_state("llm:last", f"{p['name']} {db.now()}")
        if text.strip():
            return text
    return None


def parse_json(text: str | None):
    """Достаёт JSON из ответа модели (даже если он обёрнут в ```json …```)."""
    if not text:
        return None
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        return None
    try:
        return json.loads(m.group(0))
    except ValueError:
        return None
