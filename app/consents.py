"""Согласия пользователей: что, когда, на какую версию документа дано или отозвано.

История только дополняется — каждое изменение новая запись (кто, что, версия, дата, сеть, устройство).
Действующее значение — последняя запись по виду согласия."""
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from . import db
from .web import ApiError, auth, body, client_ip, ip_prefix, limit

# Версия комплекта документов (Политика, Соглашение, согласия). Меняется — пользователей просим ознакомиться заново.
LEGAL_VERSION = "2026-10-08"

KINDS = {
    "pd": "Обработка персональных данных",
    "terms": "Пользовательское соглашение",
    "content": "Обработка пользовательского контента",
    "cookies": "Использование cookie",
    "notifications": "Push-уведомления",
    "ai": "ИИ-функции и передача данных ИИ-сервису",
}
# можно включать и отзывать из настроек; ПДн и соглашение отзываются удалением аккаунта
TOGGLEABLE = {"ai", "notifications", "cookies"}


def _ua(request: Request | None) -> str:
    return (request.headers.get("user-agent", "") if request else "")[:200]


def record(uid: int, kind: str, granted: bool, request: Request | None = None, version: str = LEGAL_VERSION) -> None:
    if kind not in KINDS:
        raise ValueError(kind)
    net = ip_prefix(client_ip(request)) if request else ""
    db.run("INSERT INTO consents (user_id, kind, version, granted, network, user_agent) VALUES (?,?,?,?,?,?)",
           (uid, kind, version, 1 if granted else 0, net, _ua(request)))


def current(uid: int) -> dict:
    rows = db.all("""SELECT c.* FROM consents c JOIN (SELECT kind, max(id) AS id FROM consents WHERE user_id=? GROUP BY kind) l
                     ON l.id = c.id""", (uid,))
    out = {r["kind"]: {"granted": bool(r["granted"]), "version": r["version"], "at": r["created_at"]} for r in rows}
    # зарегистрировались до появления журнала согласий: согласие дано при регистрации на прежнюю редакцию документов
    if "pd" not in out or "terms" not in out:
        at = db.value("SELECT consent_at FROM users WHERE id=?", (uid,))
        if at:
            for k in ("pd", "terms", "content"):
                out.setdefault(k, {"granted": True, "version": "прежняя", "at": at})
    return out


def has(uid: int | None, kind: str) -> bool:
    if not uid:
        return False
    v = db.value("SELECT granted FROM consents WHERE user_id=? AND kind=? ORDER BY id DESC LIMIT 1", (uid, kind))
    return bool(v)


def require_ai(uid: int) -> None:
    if not has(uid, "ai"):
        raise ApiError(403, "Чтобы пользоваться ИИ-функциями, включите их — это займёт секунду", "ai_consent")


def needs_review(uid: int) -> bool:
    """Документы обновились, а человек ещё не принял текущую версию."""
    cur = current(uid)
    return any((cur.get(k) or {}).get("version") != LEGAL_VERSION or not (cur.get(k) or {}).get("granted") for k in ("pd", "terms"))


@auth()
async def api_get(request: Request):
    uid = request.state.user["id"]
    return JSONResponse({"version": LEGAL_VERSION, "kinds": KINDS, "items": current(uid), "review": needs_review(uid)})


@auth()
async def api_set(request: Request):
    limit(request, "write")
    uid = request.state.user["id"]
    data = await body(request)
    if data.get("accept_documents"):
        # принять обновлённые документы: Соглашение, обработку ПДн и контента
        for k in ("terms", "pd", "content"):
            record(uid, k, True, request)
    kind = data.get("kind")
    if kind:
        if kind not in TOGGLEABLE:
            raise ApiError(400, "Это согласие отзывается удалением аккаунта — «Настройки» → «Ещё»")
        record(uid, kind, bool(data.get("granted")), request)
    return JSONResponse({"version": LEGAL_VERSION, "items": current(uid), "review": needs_review(uid)})


@auth()
async def api_history(request: Request):
    uid = request.state.user["id"]
    rows = db.all("SELECT kind, version, granted, created_at FROM consents WHERE user_id=? ORDER BY id DESC LIMIT 200", (uid,))
    return JSONResponse({"items": [{**r, "label": KINDS.get(r["kind"], r["kind"]), "granted": bool(r["granted"])} for r in rows]})


routes = [
    Route("/api/consents", api_get, methods=["GET"]),
    Route("/api/consents", api_set, methods=["POST"]),
    Route("/api/consents/history", api_history, methods=["GET"]),
]
