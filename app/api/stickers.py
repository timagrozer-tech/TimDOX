"""Наборы стикеров как в Telegram: создать свой, добавить стикеры, поделиться ссылкой, добавить чужой набор."""
import secrets

from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from .. import db, media, social
from ..security import censor, clean_text
from ..web import ApiError, auth, body, limit, ok, path_int

MAX_STICKERS = 120
MAX_OWN_PACKS = 20


def sticker_view(s: dict) -> dict:
    return {"id": s["id"], "url": s["file"], "emoji": s["emoji"], "animated": bool(s["animated"]), "pack_id": s["pack_id"]}


def pack_view(p: dict, v: int | None = None, with_stickers: bool = True) -> dict:
    data = {"id": p["id"], "slug": p["slug"], "title": p["title"], "builtin": p["owner_id"] is None,
            "mine": v is not None and p["owner_id"] == v,
            "count": db.value("SELECT count(*) FROM stickers WHERE pack_id=?", (p["id"],))}
    if p["owner_id"]:
        data["owner"] = social.cards_by_ids([p["owner_id"]]).get(p["owner_id"])
    if with_stickers:
        data["stickers"] = [sticker_view(s) for s in db.all("SELECT * FROM stickers WHERE pack_id=? ORDER BY position, id", (p["id"],))]
    if v is not None:
        data["installed"] = p["owner_id"] is None or bool(
            db.value("SELECT 1 FROM user_sticker_packs WHERE user_id=? AND pack_id=?", (v, p["id"])))
    return data


def _pack(pack_id: int) -> dict:
    p = db.one("SELECT * FROM sticker_packs WHERE id=?", (pack_id,))
    if not p:
        raise ApiError(404, "Набор не найден")
    return p


def _own_pack(pack_id: int, v: int) -> dict:
    p = _pack(pack_id)
    if p["owner_id"] != v:
        raise ApiError(403, "Это не ваш набор")
    return p


@auth()
async def my_stickers(request: Request):
    """Все доступные стикеры: встроенные наборы, свои и добавленные."""
    v = request.state.user["id"]
    rows = db.all("""SELECT p.* FROM sticker_packs p
        LEFT JOIN user_sticker_packs u ON u.pack_id = p.id AND u.user_id = ?
        WHERE p.owner_id IS NULL OR u.user_id IS NOT NULL
        ORDER BY (p.owner_id IS NULL) DESC, u.added_at""", (v,))
    return JSONResponse({"packs": [pack_view(p, v) for p in rows]})


@auth()
async def create_pack(request: Request):
    limit(request, "write")
    v = request.state.user["id"]
    data = await body(request)
    title = censor(clean_text(str(data.get("title", "")), 64)).strip()
    if len(title) < 2:
        raise ApiError(422, "Название — от 2 до 64 символов")
    if db.value("SELECT count(*) FROM sticker_packs WHERE owner_id=?", (v,)) >= MAX_OWN_PACKS:
        raise ApiError(400, f"Можно создать не больше {MAX_OWN_PACKS} наборов")
    slug = secrets.token_hex(5)
    cur = db.run("INSERT INTO sticker_packs (owner_id, slug, title) VALUES (?,?,?)", (v, slug, title))
    pid = cur.lastrowid
    db.run("INSERT OR IGNORE INTO user_sticker_packs (user_id, pack_id) VALUES (?,?)", (v, pid))
    return JSONResponse(pack_view(_pack(pid), v), status_code=201)


@auth()
async def get_pack(request: Request):
    v = request.state.user["id"]
    p = db.one("SELECT * FROM sticker_packs WHERE slug=?", (request.path_params["slug"],))
    if not p:
        raise ApiError(404, "Набор не найден")
    return JSONResponse(pack_view(p, v))


@auth()
async def update_pack(request: Request):
    v = request.state.user["id"]
    p = _own_pack(path_int(request), v)
    data = await body(request)
    if "title" in data:
        title = censor(clean_text(str(data["title"]), 64)).strip()
        if len(title) < 2:
            raise ApiError(422, "Название — от 2 до 64 символов")
        db.run("UPDATE sticker_packs SET title=? WHERE id=?", (title, p["id"]))
    if isinstance(data.get("order"), list):  # новый порядок стикеров
        for i, sid in enumerate(data["order"][:MAX_STICKERS]):
            db.run("UPDATE stickers SET position=? WHERE id=? AND pack_id=?", (i, int(sid), p["id"]))
    return JSONResponse(pack_view(_pack(p["id"]), v))


@auth()
async def delete_pack(request: Request):
    v = request.state.user["id"]
    p = _own_pack(path_int(request), v)
    files = [r["file"] for r in db.all("SELECT file FROM stickers WHERE pack_id=?", (p["id"],))]
    db.run("DELETE FROM sticker_packs WHERE id=?", (p["id"],))
    media.delete_files(*files)
    return ok()


@auth()
async def add_sticker(request: Request):
    limit(request, "upload")
    v = request.state.user["id"]
    p = _own_pack(path_int(request), v)
    if db.value("SELECT count(*) FROM stickers WHERE pack_id=?", (p["id"],)) >= MAX_STICKERS:
        raise ApiError(400, f"В наборе не больше {MAX_STICKERS} стикеров")
    form = await request.form(max_files=1, max_fields=5)
    try:
        f = form.get("file")
        if not getattr(f, "filename", None):
            raise ApiError(400, "Выберите картинку")
        emoji = clean_text(str(form.get("emoji") or "🙂"), 8).strip() or "🙂"
        saved = await media.save_sticker(f)
    finally:
        await form.close()
    pos = (db.value("SELECT max(position) FROM stickers WHERE pack_id=?", (p["id"],)) or 0) + 1
    cur = db.run("INSERT INTO stickers (pack_id, file, emoji, animated, position) VALUES (?,?,?,?,?)",
                 (p["id"], saved["path"], emoji, 1 if saved["animated"] else 0, pos))
    return JSONResponse(sticker_view(db.one("SELECT * FROM stickers WHERE id=?", (cur.lastrowid,))), status_code=201)


@auth()
async def delete_sticker(request: Request):
    v = request.state.user["id"]
    s = db.one("SELECT s.*, p.owner_id FROM stickers s JOIN sticker_packs p ON p.id=s.pack_id WHERE s.id=?", (path_int(request),))
    if not s:
        raise ApiError(404, "Стикер не найден")
    if s["owner_id"] != v:
        raise ApiError(403, "Это не ваш набор")
    db.run("DELETE FROM stickers WHERE id=?", (s["id"],))
    media.delete_files(s["file"])
    return ok()


@auth()
async def install(request: Request):
    v = request.state.user["id"]
    p = _pack(path_int(request))
    if request.method == "DELETE":
        db.run("DELETE FROM user_sticker_packs WHERE user_id=? AND pack_id=?", (v, p["id"]))
    else:
        if db.value("SELECT count(*) FROM user_sticker_packs WHERE user_id=?", (v,)) >= 100:
            raise ApiError(400, "Слишком много наборов — удалите ненужные")
        db.run("INSERT OR IGNORE INTO user_sticker_packs (user_id, pack_id) VALUES (?,?)", (v, p["id"]))
    return JSONResponse(pack_view(p, v, with_stickers=False))


def sticker_for_message(sticker_id) -> dict:
    try:
        sid = int(sticker_id)
    except (TypeError, ValueError):
        raise ApiError(400, "Неизвестный стикер")
    s = db.one("SELECT s.*, p.slug, p.title FROM stickers s JOIN sticker_packs p ON p.id=s.pack_id WHERE s.id=?", (sid,))
    if not s:
        raise ApiError(404, "Стикер не найден")
    return {"type": "sticker", "sticker_id": s["id"], "url": s["file"], "emoji": s["emoji"], "animated": bool(s["animated"]),
            "pack": {"id": s["pack_id"], "slug": s["slug"], "title": s["title"]}}


routes = [
    Route("/api/stickers", my_stickers, methods=["GET"]),
    Route("/api/sticker-packs", create_pack, methods=["POST"]),
    Route("/api/sticker-packs/by-slug/{slug}", get_pack, methods=["GET"]),
    Route("/api/sticker-packs/{id:int}", update_pack, methods=["PATCH"]),
    Route("/api/sticker-packs/{id:int}", delete_pack, methods=["DELETE"]),
    Route("/api/sticker-packs/{id:int}/stickers", add_sticker, methods=["POST"]),
    Route("/api/sticker-packs/{id:int}/install", install, methods=["POST", "DELETE"]),
    Route("/api/stickers/{id:int}", delete_sticker, methods=["DELETE"]),
]
