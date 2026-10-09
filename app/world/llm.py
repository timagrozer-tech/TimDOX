"""Нейросети для Мира Yarko: цепочка бесплатных OpenAI-совместимых провайдеров с дневным бюджетом токенов.

Порядок: Ollama (если задан OLLAMA_URL) → Groq → OpenRouter (:free) → любой AI_BASE_URL. Нет ключей — мир живёт на шаблонах.
"""
import json
import logging
import os
import re
import urllib.error
import sys
import time
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
        # запасная модель того же ключа: у каждой модели Groq свои лимиты — упёрлись в одну, отвечает другая
        fb = os.environ.get("GROQ_FALLBACK_MODEL", "llama-3.3-70b-versatile")
        if fb and fb != os.environ.get("GROQ_MODEL", "openai/gpt-oss-120b"):
            out.append({"name": "groq-fb", "url": "https://api.groq.com/openai/v1/chat/completions", "key": os.environ["GROQ_API_KEY"],
                        "model": fb, "json": True})
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


_pause: dict[str, float] = {}  # провайдер → до какого времени не беспокоить (после 429/5xx)


def _diag(name: str, msg: str) -> None:
    """Сбой нейросети — в журнал запросов (SYS /__llm), чтобы причину было видно без доступа к логам хостинга"""
    log.warning("LLM %s: %s", name, msg)
    w = sys.modules.get("app.wsgi")
    if w is not None:
        try:
            w._req_queue.append(("SYS", "/__llm", 500, 0, name[:40], msg[:200], os.getpid()))
        except Exception:  # noqa: BLE001
            pass


def _post(p: dict, messages: list, max_tokens: int, want_json: bool) -> tuple[str, int]:
    # у «думающих» моделей (gpt-oss) лимит включает скрытые рассуждения: без запаса ответ выходил пустым
    room = max_tokens + 700 if "gpt-oss" in p["model"] else max_tokens
    payload = {"model": p["model"], "messages": messages, "max_tokens": room, "temperature": 0.9}
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
    ch = data["choices"][0]
    text = ch["message"].get("content") or ""
    if not text.strip():
        _diag(p["name"], f"пустой ответ, finish={ch.get('finish_reason')}")
    used = (data.get("usage") or {}).get("total_tokens") or (len(text) // 3 + sum(len(m["content"]) for m in messages) // 3)
    return text, int(used)


def complete(system: str, user: str, max_tokens: int = 1500, want_json: bool = False) -> str | None:
    """Синхронный вызов (запускать в отдельном потоке). None — нет провайдеров, бюджет исчерпан или все упали."""
    if budget_left() < max_tokens:
        return None
    messages = [{"role": "system", "content": system}, {"role": "user", "content": user}]
    for p in providers():
        if _pause.get(p["name"], 0) > time.time():
            continue
        try:
            text, used = _post(p, messages, max_tokens, want_json)
        except urllib.error.HTTPError as e:
            body = e.read()[:200]
            if e.code == 429 or e.code >= 500:
                try:
                    wait = float(e.headers.get("retry-after") or 20)
                except ValueError:
                    wait = 20
                _pause[p["name"]] = time.time() + min(max(wait, 5), 300)
            _diag(p["name"], f"{e.code} {body!r}")
            continue
        except (urllib.error.URLError, TimeoutError, KeyError, ValueError, OSError) as e:
            _diag(p["name"], repr(e)[:160])
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
