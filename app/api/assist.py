"""ИИ в чатах: варианты ответа, краткий пересказ пропущенного и «улучшить текст» перед отправкой.

Всё запускается только по нажатию человека — переписку ИИ сам не читает. Используем общую цепочку бесплатных
моделей (world.llm) с дневным бюджетом токенов; без ключей кнопки честно говорят, что ИИ недоступен."""
import json

from starlette.concurrency import run_in_threadpool
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from .. import db
from ..security import clean_text
from ..web import ApiError, auth, body, limit, path_int
from ..world import llm
from .messages import _member, _preview_text

MODES = {
    "fix": "Исправь орфографию, пунктуацию и опечатки. Ничего не добавляй и не меняй смысл и стиль.",
    "short": "Сделай короче и яснее, сохранив смысл и тон.",
    "polite": "Перепиши вежливее и теплее, но естественно, без канцелярита.",
    "fun": "Перепиши веселее и живее, можно добавить 1–2 уместных эмодзи.",
    "formal": "Перепиши в деловом стиле, кратко и уважительно.",
    "en": "Переведи на английский язык естественно, как написал бы носитель.",
    "ru": "Переведи на русский язык естественно.",
}


def _need_ai(uid: int | None = None) -> None:
    if uid is not None:
        from .. import consents
        consents.require_ai(uid)
    if not llm.enabled():
        raise ApiError(503, "ИИ пока не подключён", "ai_off")


def _ask(system: str, user: str, max_tokens: int, want_json: bool = False) -> str:
    out = llm.complete(system, user, max_tokens=max_tokens, want_json=want_json)
    if not out:
        raise ApiError(503, "ИИ сейчас недоступен — попробуйте позже", "ai_busy")
    return out.strip()


def _line(m: dict, names: dict, v: int) -> str:
    text = _preview_text(m)
    if m.get("kind") == "voice" and m.get("media"):
        try:
            tr = (json.loads(m["media"]) or {}).get("transcript")
            if tr:
                text = f"🎤 {tr}"
        except (ValueError, TypeError):
            pass
    who = "Я" if m["sender_id"] == v else names.get(m["sender_id"], "Собеседник")
    return f"{who}: {text[:400]}"


def _history(conv_id: int, v: int, limit_n: int, after_id: int = 0) -> list[str]:
    rows = db.all("""SELECT * FROM messages WHERE conversation_id=? AND id>? AND kind!='deleted'
                     ORDER BY id DESC LIMIT ?""", (conv_id, after_id, limit_n))[::-1]
    ids = {r["sender_id"] for r in rows}
    names = {}
    if ids:
        for p in db.all(f"SELECT user_id, name FROM profiles WHERE user_id IN ({db.placeholders(list(ids))})", tuple(ids)):
            names[p["user_id"]] = (p["name"] or "").split(" ")[0] or "Собеседник"
    return [_line(r, names, v) for r in rows]


@auth()
async def replies(request: Request):
    """Три коротких варианта ответа на последнее сообщение собеседника."""
    limit(request, "ai_assist")
    v = request.state.user["id"]
    conv_id = path_int(request)
    _member(conv_id, v)
    _need_ai(v)
    lines = await run_in_threadpool(_history, conv_id, v, 12)
    if not lines or lines[-1].startswith("Я:"):
        raise ApiError(400, "Варианты ответа появляются, когда вам написали", "ai_nothing")
    system = ("Ты помогаешь человеку ответить в мессенджере. По переписке предложи РОВНО 3 коротких варианта ответа "
              "от лица «Я» на последнее сообщение собеседника: разные по смыслу (например: согласиться, уточнить, пошутить/отказаться), "
              "живые, на языке переписки, до 12 слов каждый, без кавычек. Ответь JSON: {\"replies\": [\"…\", \"…\", \"…\"]}")
    out = await run_in_threadpool(_ask, system, "\n".join(lines), 600, True)
    data = llm.parse_json(out) or {}
    items = [clean_text(str(x), 160).strip().strip('"«»') for x in (data.get("replies") or []) if str(x).strip()][:3]
    if not items:
        raise ApiError(503, "ИИ не придумал ответ — попробуйте ещё раз", "ai_busy")
    return JSONResponse({"replies": items})


@auth()
async def summary(request: Request):
    """Кратко о пропущенном: с первого непрочитанного (from_id) или последние 80 сообщений."""
    limit(request, "ai_assist")
    v = request.state.user["id"]
    conv_id = path_int(request)
    _member(conv_id, v)
    _need_ai(v)
    data = await body(request)
    try:
        after = max(0, int(data.get("from_id") or 0) - 1)
    except (TypeError, ValueError):
        after = 0
    lines = await run_in_threadpool(_history, conv_id, v, 150 if after else 80, after)
    if len(lines) < 4:
        raise ApiError(400, "Тут пока нечего пересказывать", "ai_nothing")
    text = "\n".join(lines)[-12000:]
    system = ("Ты кратко пересказываешь переписку для человека («Я»), который её пропустил. Напиши 3–6 пунктов, "
              "каждый начинается с «• », по-русски, по делу: о чём договорились, вопросы к «Я», важные даты, ссылки, решения. "
              "Называй людей по именам. Без вступлений и выводов.")
    out = await run_in_threadpool(_ask, system, text, 700)
    return JSONResponse({"summary": clean_text(out, 2000), "count": len(lines)})


@auth()
async def rewrite(request: Request):
    limit(request, "ai_assist")
    _need_ai(request.state.user["id"])
    data = await body(request)
    mode = str(data.get("mode") or "")
    text = clean_text(str(data.get("text") or ""), 2000).strip()
    if mode not in MODES:
        raise ApiError(400, "Неизвестный режим")
    if len(text) < 2:
        raise ApiError(400, "Напишите текст, который нужно улучшить")
    system = ("Ты редактор сообщений в мессенджере. " + MODES[mode] +
              " Верни ТОЛЬКО готовый текст сообщения, без пояснений, кавычек и вариантов.")
    out = await run_in_threadpool(_ask, system, text, 900)
    out = out.strip().strip('"«»').strip()
    return JSONResponse({"text": clean_text(out, 4000)})


@auth()
async def status(request: Request):
    return JSONResponse({"enabled": llm.enabled()})


routes = [
    Route("/api/ai/status", status, methods=["GET"]),
    Route("/api/ai/rewrite", rewrite, methods=["POST"]),
    Route("/api/conversations/{id:int}/ai/replies", replies, methods=["POST"]),
    Route("/api/conversations/{id:int}/ai/summary", summary, methods=["POST"]),
]
