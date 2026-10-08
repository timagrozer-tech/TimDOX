"""Стикеры Yarko 2.0: наборы как в Telegram и больше.

Свои наборы, импорт (Telegram, ZIP, файлы), коллекция (избранное, недавние, реакции, папки), умный поиск,
редактор наборов (обложка, объединить, разделить, копия), Yarko Remix и AI Sticker Lab, каталог с бесплатными
и платными (за KC) наборами, витрина в профиле. Форматы: WebP (в т. ч. анимированный), TGS (Lottie), WEBM."""
import hashlib
import json
import secrets

from starlette.concurrency import run_in_threadpool
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.routing import Route

from .. import db, economy, media, social, stickerart, stickers2
from ..security import censor, clean_text
from ..web import ApiError, auth, body, limit, ok, path_int

MAX_STICKERS = 200
MAX_OWN_PACKS = 30
MAX_FOLDERS = 30
MAX_PRICE = 5000
SALE_FEE = 0.07
KINDS = ("stickers", "emoji", "reactions")
SELLABLE_SOURCES = ("own", "copy", "remix", "lab", "avatar3d")   # импортированное из Telegram продавать нельзя


# ---------------------------------------------------------------- представления
def sticker_view(s: dict) -> dict:
    return {"id": s["id"], "url": s["file"], "emoji": s["emoji"], "animated": bool(s["animated"]), "pack_id": s["pack_id"],
            "format": s.get("format") or "webp", "thumb": s.get("thumb"), "tags": s.get("tags") or ""}


def _count(pid: int) -> int:
    return db.value("SELECT count(*) FROM stickers WHERE pack_id=?", (pid,))


def _purchased(v: int | None, pid: int) -> bool:
    return bool(v and db.value("SELECT 1 FROM sticker_purchases WHERE user_id=? AND pack_id=?", (v, pid)))


def pack_view(p: dict, v: int | None = None, with_stickers: bool = True, preview: int = 0) -> dict:
    data = {"id": p["id"], "slug": p["slug"], "title": p["title"], "builtin": p["owner_id"] is None,
            "mine": v is not None and p["owner_id"] == v, "count": _count(p["id"]),
            "kind": p.get("kind") or "stickers", "source": p.get("source") or "own", "description": p.get("description") or "",
            "published": bool(p.get("published")), "price": p.get("price") or 0, "installs": p.get("installs") or 0,
            "shared": bool(p.get("shared")), "cover_id": p.get("cover_id")}
    if p["owner_id"]:
        data["owner"] = social.cards_by_ids([p["owner_id"]]).get(p["owner_id"])
    rows = None
    if with_stickers or preview:
        rows = db.all("SELECT * FROM stickers WHERE pack_id=? ORDER BY position, id" + (f" LIMIT {int(preview)}" if preview and not with_stickers else ""), (p["id"],))
        data["stickers"] = [sticker_view(s) for s in rows]
    cover = None
    if p.get("cover_id"):
        cover = db.one("SELECT * FROM stickers WHERE id=? AND pack_id=?", (p["cover_id"], p["id"]))
    if not cover:
        cover = rows[0] if rows else db.one("SELECT * FROM stickers WHERE pack_id=? ORDER BY position, id LIMIT 1", (p["id"],))
    data["cover"] = sticker_view(cover) if cover else None
    if with_stickers:
        from .. import tgexport
        data["tg_url"] = tgexport.tg_url(p)
    if v is not None:
        link = db.one("SELECT favorite FROM user_sticker_packs WHERE user_id=? AND pack_id=?", (v, p["id"]))
        data["installed"] = p["owner_id"] is None or bool(link)
        data["favorite"] = bool(link and link["favorite"])
        data["purchased"] = _purchased(v, p["id"])
        data["locked"] = bool(data["price"]) and not data["mine"] and not data["purchased"]
    return data


def _pack(pack_id: int) -> dict:
    p = db.one("SELECT * FROM sticker_packs WHERE id=?", (pack_id,))
    if not p:
        raise ApiError(404, "Набор не найден")
    return p


def _own_pack(pack_id: int, v: int, edit: bool = True) -> dict:
    p = _pack(pack_id)
    if p["owner_id"] != v:
        raise ApiError(403, "Это не ваш набор")
    if edit and p.get("shared"):
        raise ApiError(403, "Это общий импортированный набор — создайте свою копию, чтобы менять его")
    return p


def can_use(v: int, p: dict) -> bool:
    """Пользоваться стикером можно, если набор встроенный, свой, добавленный или опубликованный бесплатный; платный — после покупки."""
    if p["owner_id"] is None or p["owner_id"] == v:
        return True
    if (p.get("price") or 0) > 0:
        return _purchased(v, p["id"])
    if p.get("published"):
        return True
    return bool(db.value("SELECT 1 FROM user_sticker_packs WHERE user_id=? AND pack_id=?", (v, p["id"])))


def usable_sticker(v: int, sticker_id) -> dict:
    try:
        sid = int(sticker_id)
    except (TypeError, ValueError):
        raise ApiError(400, "Неизвестный стикер")
    s = db.one("SELECT s.*, p.slug, p.title, p.owner_id, p.price, p.published, p.id AS pid FROM stickers s JOIN sticker_packs p ON p.id=s.pack_id WHERE s.id=?", (sid,))
    if not s:
        raise ApiError(404, "Стикер не найден")
    if not can_use(v, {"id": s["pid"], "owner_id": s["owner_id"], "price": s["price"], "published": s["published"]}):
        raise ApiError(403, "Этот стикер из платного набора — сначала купите набор")
    return s


def sticker_for_message(sticker_id, v: int | None = None) -> dict:
    s = usable_sticker(v, sticker_id) if v is not None else db.one(
        "SELECT s.*, p.slug, p.title FROM stickers s JOIN sticker_packs p ON p.id=s.pack_id WHERE s.id=?", (int(sticker_id),))
    if not s:
        raise ApiError(404, "Стикер не найден")
    if v is not None:
        _touch_recent(v, s["id"])
    return {"type": "sticker", "sticker_id": s["id"], "url": s["file"], "emoji": s["emoji"], "animated": bool(s["animated"]),
            "format": s.get("format") or "webp", "thumb": s.get("thumb"),
            "pack": {"id": s["pack_id"], "slug": s["slug"], "title": s["title"]}}


def _touch_recent(v: int, sid: int) -> None:
    db.run("DELETE FROM sticker_recent WHERE user_id=? AND sticker_id=?", (v, sid))
    db.run("INSERT INTO sticker_recent (user_id, sticker_id) VALUES (?,?)", (v, sid))
    old = db.all("SELECT sticker_id FROM sticker_recent WHERE user_id=? ORDER BY used_at DESC LIMIT 200 OFFSET 40", (v,))
    for r in old:
        db.run("DELETE FROM sticker_recent WHERE user_id=? AND sticker_id=?", (v, r["sticker_id"]))


def _stickers_by_ids(ids: list[int]) -> list[dict]:
    if not ids:
        return []
    rows = {r["id"]: r for r in db.all(f"SELECT * FROM stickers WHERE id IN ({db.placeholders(ids)})", tuple(ids))}
    return [sticker_view(rows[i]) for i in ids if i in rows]


def _title(raw, n: int = 64) -> str:
    t = censor(clean_text(str(raw or ""), n)).strip()
    if len(t) < 2:
        raise ApiError(422, f"Название — от 2 до {n} символов")
    return t


# ---------------------------------------------------------------- коллекция целиком (для панели)
@auth()
async def my_stickers(request: Request):
    """Всё для панели за один запрос: наборы, избранное, реакции, недавние, папки и оформление панели. С ETag — повторно не качаем."""
    v = request.state.user["id"]
    rows = db.all("""SELECT p.* FROM sticker_packs p
        LEFT JOIN user_sticker_packs u ON u.pack_id = p.id AND u.user_id = ?
        WHERE p.owner_id IS NULL OR u.user_id IS NOT NULL
        ORDER BY (p.owner_id IS NULL) DESC, COALESCE(u.favorite, 0) DESC, u.added_at""", (v,))
    saved = db.all("SELECT sticker_id, kind FROM sticker_saved WHERE user_id=? ORDER BY created_at DESC", (v,))
    recent = [r["sticker_id"] for r in db.all("SELECT sticker_id FROM sticker_recent WHERE user_id=? ORDER BY used_at DESC LIMIT 32", (v,))]
    folders = []
    for f in db.all("SELECT * FROM sticker_folders WHERE user_id=? ORDER BY position, id", (v,)):
        ids = [r["sticker_id"] for r in db.all("SELECT sticker_id FROM sticker_folder_items WHERE folder_id=? ORDER BY added_at", (f["id"],))]
        folders.append({"id": f["id"], "title": f["title"], "emoji": f["emoji"], "stickers": _stickers_by_ids(ids)})
    from ..collection import parse_equipped
    eq = parse_equipped(db.value("SELECT equipped FROM profiles WHERE user_id=?", (v,)))
    payload = {"packs": [pack_view(p, v) for p in rows],
               "favorites": _stickers_by_ids([r["sticker_id"] for r in saved if r["kind"] == "fav"]),
               "reactions": _stickers_by_ids([r["sticker_id"] for r in saved if r["kind"] == "reaction"]),
               "recent": _stickers_by_ids(recent), "folders": folders,
               "theme": eq.get("sp_theme"), "open_anim": eq.get("sp_open")}
    raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    etag = '"' + hashlib.sha1(raw.encode()).hexdigest()[:20] + '"'
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers={"ETag": etag})
    return Response(raw, media_type="application/json", headers={"ETag": etag, "Cache-Control": "private, no-cache"})


@auth()
async def search(request: Request):
    v = request.state.user["id"]
    q = request.query_params.get("q", "")
    scope = "all" if request.query_params.get("scope") == "all" else "mine"
    rows = await run_in_threadpool(stickers2.search, v, q, scope)
    return JSONResponse({"items": [{**sticker_view(r), "pack": {"slug": r["slug"], "title": r["pack_title"]},
                                    "locked": bool(r["price"]) and r["pack_owner"] != v and not _purchased(v, r["pack_id"])} for r in rows]})


# ---------------------------------------------------------------- наборы
@auth()
async def create_pack(request: Request):
    limit(request, "write")
    v = request.state.user["id"]
    data = await body(request)
    title = _title(data.get("title"))
    kind = data.get("kind") if data.get("kind") in KINDS else "stickers"
    if db.value("SELECT count(*) FROM sticker_packs WHERE owner_id=? AND slug<>? AND shared=0", (v, avatar_pack_slug(v))) >= MAX_OWN_PACKS:
        raise ApiError(400, f"Можно создать не больше {MAX_OWN_PACKS} наборов")
    slug = secrets.token_hex(5)
    pid = db.run("INSERT INTO sticker_packs (owner_id, slug, title, kind) VALUES (?,?,?,?)", (v, slug, title, kind)).lastrowid
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
        db.run("UPDATE sticker_packs SET title=? WHERE id=?", (_title(data["title"]), p["id"]))
    if "description" in data:
        db.run("UPDATE sticker_packs SET description=? WHERE id=?", (censor(clean_text(str(data["description"] or ""), 300)), p["id"]))
    if "kind" in data and data["kind"] in KINDS:
        db.run("UPDATE sticker_packs SET kind=? WHERE id=?", (data["kind"], p["id"]))
    if "cover_id" in data:
        cid = data["cover_id"]
        if cid is not None and not db.value("SELECT 1 FROM stickers WHERE id=? AND pack_id=?", (int(cid), p["id"])):
            raise ApiError(400, "Обложкой может быть только стикер из этого набора")
        db.run("UPDATE sticker_packs SET cover_id=? WHERE id=?", (int(cid) if cid is not None else None, p["id"]))
    if isinstance(data.get("order"), list):  # новый порядок стикеров
        for i, sid in enumerate(data["order"][:MAX_STICKERS]):
            db.run("UPDATE stickers SET position=? WHERE id=? AND pack_id=?", (i, int(sid), p["id"]))
    return JSONResponse(pack_view(_pack(p["id"]), v))


def _drop_files(files: list[str]) -> None:
    """Файл удаляем, только если на него больше не ссылается ни один стикер (копии наборов используют те же файлы)."""
    lonely = [f for f in files if f and not db.value("SELECT 1 FROM stickers WHERE file=? OR thumb=?", (f, f))]
    if lonely:
        media.delete_files(*lonely)


@auth()
async def delete_pack(request: Request):
    v = request.state.user["id"]
    p = _own_pack(path_int(request), v, edit=False)
    if p.get("shared"):  # общий импортированный набор: просто убираем у себя
        db.run("DELETE FROM user_sticker_packs WHERE user_id=? AND pack_id=?", (v, p["id"]))
        return ok()
    if db.value("SELECT count(*) FROM sticker_purchases WHERE pack_id=?", (p["id"],)):
        raise ApiError(400, "Этот набор уже купили — его можно снять с продажи, но не удалить")
    rows = db.all("SELECT file, thumb FROM stickers WHERE pack_id=?", (p["id"],))
    db.run("DELETE FROM sticker_packs WHERE id=?", (p["id"],))
    _drop_files([r["file"] for r in rows] + [r["thumb"] for r in rows if r["thumb"]])
    return ok()


@auth()
async def add_sticker(request: Request):
    limit(request, "upload")
    v = request.state.user["id"]
    p = _own_pack(path_int(request), v)
    if _count(p["id"]) >= MAX_STICKERS:
        raise ApiError(400, f"В наборе не больше {MAX_STICKERS} стикеров")
    form = await request.form(max_files=1, max_fields=6)
    try:
        f = form.get("file")
        if not getattr(f, "filename", None):
            raise ApiError(400, "Выберите картинку")
        emoji = clean_text(str(form.get("emoji") or "🙂"), 8).strip() or "🙂"
        tags = censor(clean_text(str(form.get("tags") or ""), 200)).lower()
        data = await f.read(5 * 1024 * 1024 + 1)
        if len(data) > 5 * 1024 * 1024:
            raise ApiError(413, "Стикер больше 5 МБ")
        saved = await media.save_any_sticker(data)
    finally:
        await form.close()
    pos = (db.value("SELECT max(position) FROM stickers WHERE pack_id=?", (p["id"],)) or 0) + 1
    cur = db.run("INSERT INTO stickers (pack_id, file, emoji, animated, position, format, tags) VALUES (?,?,?,?,?,?,?)",
                 (p["id"], saved["path"], emoji, 1 if saved["animated"] else 0, pos, saved.get("format", "webp"), tags))
    return JSONResponse(sticker_view(db.one("SELECT * FROM stickers WHERE id=?", (cur.lastrowid,))), status_code=201)


def _own_sticker(v: int, sid: int) -> dict:
    s = db.one("SELECT s.*, p.owner_id, p.shared FROM stickers s JOIN sticker_packs p ON p.id=s.pack_id WHERE s.id=?", (sid,))
    if not s:
        raise ApiError(404, "Стикер не найден")
    if s["owner_id"] != v or s["shared"]:
        raise ApiError(403, "Это не ваш набор")
    return s


@auth()
async def edit_sticker(request: Request):
    v = request.state.user["id"]
    s = _own_sticker(v, path_int(request))
    data = await body(request)
    if "emoji" in data:
        db.run("UPDATE stickers SET emoji=? WHERE id=?", (clean_text(str(data["emoji"] or "🙂"), 8).strip() or "🙂", s["id"]))
    if "tags" in data:
        db.run("UPDATE stickers SET tags=? WHERE id=?", (censor(clean_text(str(data["tags"] or ""), 200)).lower(), s["id"]))
    return JSONResponse(sticker_view(db.one("SELECT * FROM stickers WHERE id=?", (s["id"],))))


@auth()
async def delete_sticker(request: Request):
    v = request.state.user["id"]
    s = _own_sticker(v, path_int(request))
    db.run("DELETE FROM stickers WHERE id=?", (s["id"],))
    _drop_files([s["file"], s["thumb"]])
    return ok()


@auth()
async def install(request: Request):
    v = request.state.user["id"]
    p = _pack(path_int(request))
    if request.method == "DELETE":
        db.run("DELETE FROM user_sticker_packs WHERE user_id=? AND pack_id=?", (v, p["id"]))
    else:
        # добавить чужой набор можно, зная ссылку на него (slug), или из каталога, если он опубликован
        if p["owner_id"] != v and not p.get("published") and str((await body(request)).get("slug") or "") != p["slug"]:
            raise ApiError(404, "Набор не найден")
        if (p.get("price") or 0) > 0 and p["owner_id"] != v and not _purchased(v, p["id"]):
            raise ApiError(402, f"Набор платный — {p['price']} KC")
        if db.value("SELECT count(*) FROM user_sticker_packs WHERE user_id=?", (v,)) >= 300:
            raise ApiError(400, "Слишком много наборов — удалите ненужные")
        if not db.value("SELECT 1 FROM user_sticker_packs WHERE user_id=? AND pack_id=?", (v, p["id"])):
            db.run("INSERT OR IGNORE INTO user_sticker_packs (user_id, pack_id) VALUES (?,?)", (v, p["id"]))
            if p["owner_id"] != v:
                db.run("UPDATE sticker_packs SET installs=installs+1 WHERE id=?", (p["id"],))
    return JSONResponse(pack_view(_pack(p["id"]), v, with_stickers=False))


@auth()
async def favorite_pack(request: Request):
    v = request.state.user["id"]
    p = _pack(path_int(request))
    if p["owner_id"] is not None and not db.value("SELECT 1 FROM user_sticker_packs WHERE user_id=? AND pack_id=?", (v, p["id"])):
        raise ApiError(400, "Сначала добавьте набор")
    if p["owner_id"] is None:
        db.run("INSERT OR IGNORE INTO user_sticker_packs (user_id, pack_id) VALUES (?,?)", (v, p["id"]))
    cur = db.value("SELECT favorite FROM user_sticker_packs WHERE user_id=? AND pack_id=?", (v, p["id"]))
    db.run("UPDATE user_sticker_packs SET favorite=? WHERE user_id=? AND pack_id=?", (0 if cur else 1, v, p["id"]))
    return JSONResponse({"favorite": not cur})


# ---------------------------------------------------------------- редактор: копия, объединение, разделение
def _clone_rows(src_pid: int, dst_pid: int, ids: list[int] | None = None) -> int:
    rows = db.all("SELECT * FROM stickers WHERE pack_id=? ORDER BY position, id", (src_pid,))
    if ids is not None:
        rows = [r for r in rows if r["id"] in set(ids)]
    pos = (db.value("SELECT max(position) FROM stickers WHERE pack_id=?", (dst_pid,)) or 0) + 1
    room = MAX_STICKERS - _count(dst_pid)
    n = 0
    for r in rows[:max(0, room)]:
        db.run("INSERT INTO stickers (pack_id, file, emoji, animated, position, format, tags, thumb, ai_tagged, remix_of) VALUES (?,?,?,?,?,?,?,?,?,?)",
               (dst_pid, r["file"], r["emoji"], r["animated"], pos + n, r["format"], r["tags"], r["thumb"], r["ai_tagged"], r["id"]))
        n += 1
    return n


@auth()
async def copy_pack(request: Request):
    """«Создать свою версию»: копия набора, которую можно менять как угодно. Оригинал не меняется."""
    limit(request, "write")
    v = request.state.user["id"]
    p = _pack(path_int(request))
    if not can_use(v, p) and not db.value("SELECT 1 FROM user_sticker_packs WHERE user_id=? AND pack_id=?", (v, p["id"])):
        raise ApiError(403, "Сначала добавьте или купите набор")
    data = await body(request)
    title = _title(data.get("title") or f"{p['title']} (моя версия)")
    if db.value("SELECT count(*) FROM sticker_packs WHERE owner_id=? AND shared=0", (v,)) >= MAX_OWN_PACKS:
        raise ApiError(400, f"Можно создать не больше {MAX_OWN_PACKS} наборов")
    # своё остаётся своим (можно продавать), копия чужого — только для себя
    source = ("copy" if p.get("source") in SELLABLE_SOURCES else p.get("source") or "import") if p["owner_id"] == v else "import"
    pid = db.run("INSERT INTO sticker_packs (owner_id, slug, title, kind, source, source_ref, remix_of, description) VALUES (?,?,?,?,?,?,?,?)",
                 (v, secrets.token_hex(5), title, p.get("kind") or "stickers", source, p.get("source_ref"), p["id"],
                  p.get("description") or "")).lastrowid
    db.run("INSERT OR IGNORE INTO user_sticker_packs (user_id, pack_id) VALUES (?,?)", (v, pid))
    _clone_rows(p["id"], pid)
    return JSONResponse(pack_view(_pack(pid), v), status_code=201)


@auth()
async def merge_pack(request: Request):
    """Добавить в свой набор стикеры другого набора (копией). Если второй набор тоже ваш и move=true — он переносится и удаляется."""
    v = request.state.user["id"]
    dst = _own_pack(path_int(request), v)
    data = await body(request)
    src = _pack(int(data.get("from_id") or 0))
    if src["id"] == dst["id"]:
        raise ApiError(400, "Выберите другой набор")
    if not can_use(v, src):
        raise ApiError(403, "Сначала добавьте или купите набор")
    n = _clone_rows(src["id"], dst["id"])
    moved = False
    if data.get("move") and src["owner_id"] == v and not src.get("shared") and not db.value("SELECT 1 FROM sticker_purchases WHERE pack_id=?", (src["id"],)):
        if dst.get("source") in SELLABLE_SOURCES and src.get("source") not in SELLABLE_SOURCES:
            db.run("UPDATE sticker_packs SET source='import', published=0, price=0 WHERE id=?", (dst["id"],))
        db.run("DELETE FROM sticker_packs WHERE id=?", (src["id"],))
        moved = True
    elif dst.get("source") in SELLABLE_SOURCES and (src["owner_id"] != v or src.get("source") not in SELLABLE_SOURCES):
        db.run("UPDATE sticker_packs SET source='import', published=0, price=0 WHERE id=?", (dst["id"],))  # чужое — не продаём
    return JSONResponse({"added": n, "moved": moved, "pack": pack_view(_pack(dst["id"]), v)})


@auth()
async def split_pack(request: Request):
    """Выбранные стикеры уходят в новый набор."""
    v = request.state.user["id"]
    p = _own_pack(path_int(request), v)
    data = await body(request)
    ids = [int(x) for x in (data.get("sticker_ids") or [])[:MAX_STICKERS]]
    own = {r["id"] for r in db.all("SELECT id FROM stickers WHERE pack_id=?", (p["id"],))}
    ids = [i for i in ids if i in own]
    if not ids:
        raise ApiError(400, "Выберите стикеры")
    if len(ids) == len(own):
        raise ApiError(400, "В старом наборе должен остаться хотя бы один стикер")
    title = _title(data.get("title") or f"{p['title']} · часть 2")
    pid = db.run("INSERT INTO sticker_packs (owner_id, slug, title, kind, source, source_ref) VALUES (?,?,?,?,?,?)",
                 (v, secrets.token_hex(5), title, p.get("kind") or "stickers", p.get("source") or "own", p.get("source_ref"))).lastrowid
    db.run("INSERT OR IGNORE INTO user_sticker_packs (user_id, pack_id) VALUES (?,?)", (v, pid))
    for i, sid in enumerate(ids):
        db.run("UPDATE stickers SET pack_id=?, position=? WHERE id=?", (pid, i, sid))
    if p.get("cover_id") in ids:
        db.run("UPDATE sticker_packs SET cover_id=NULL WHERE id=?", (p["id"],))
    return JSONResponse(pack_view(_pack(pid), v), status_code=201)


# ---------------------------------------------------------------- коллекция: избранное, реакции, недавние, папки
@auth()
async def save_sticker(request: Request):
    v = request.state.user["id"]
    s = usable_sticker(v, path_int(request))
    kind = "reaction" if (await body(request)).get("kind") == "reaction" else "fav"
    if db.value("SELECT 1 FROM sticker_saved WHERE user_id=? AND sticker_id=? AND kind=?", (v, s["id"], kind)):
        db.run("DELETE FROM sticker_saved WHERE user_id=? AND sticker_id=? AND kind=?", (v, s["id"], kind))
        return JSONResponse({"saved": False, "kind": kind})
    if db.value("SELECT count(*) FROM sticker_saved WHERE user_id=? AND kind=?", (v, kind)) >= (200 if kind == "fav" else 40):
        raise ApiError(400, "Слишком много — уберите что-нибудь")
    db.run("INSERT INTO sticker_saved (user_id, sticker_id, kind) VALUES (?,?,?)", (v, s["id"], kind))
    return JSONResponse({"saved": True, "kind": kind})


@auth()
async def used_sticker(request: Request):
    v = request.state.user["id"]
    s = usable_sticker(v, path_int(request))
    _touch_recent(v, s["id"])
    return ok()


@auth()
async def folders(request: Request):
    v = request.state.user["id"]
    data = await body(request)
    if request.method == "POST":
        if db.value("SELECT count(*) FROM sticker_folders WHERE user_id=?", (v,)) >= MAX_FOLDERS:
            raise ApiError(400, f"Не больше {MAX_FOLDERS} папок")
        fid = db.run("INSERT INTO sticker_folders (user_id, title, emoji, position) VALUES (?,?,?,?)",
                     (v, _title(data.get("title"), 32), clean_text(str(data.get("emoji") or "📁"), 8) or "📁",
                      db.value("SELECT count(*) FROM sticker_folders WHERE user_id=?", (v,)))).lastrowid
        return JSONResponse({"id": fid}, status_code=201)
    fid = path_int(request)
    f = db.one("SELECT * FROM sticker_folders WHERE id=? AND user_id=?", (fid, v))
    if not f:
        raise ApiError(404, "Папка не найдена")
    if request.method == "DELETE":
        db.run("DELETE FROM sticker_folders WHERE id=?", (fid,))
    else:
        if "title" in data:
            db.run("UPDATE sticker_folders SET title=? WHERE id=?", (_title(data["title"], 32), fid))
        if "emoji" in data:
            db.run("UPDATE sticker_folders SET emoji=? WHERE id=?", (clean_text(str(data["emoji"] or "📁"), 8) or "📁", fid))
    return ok()


@auth()
async def folder_items(request: Request):
    v = request.state.user["id"]
    fid = path_int(request)
    if not db.value("SELECT 1 FROM sticker_folders WHERE id=? AND user_id=?", (fid, v)):
        raise ApiError(404, "Папка не найдена")
    data = await body(request)
    s = usable_sticker(v, data.get("sticker_id"))
    if data.get("remove"):
        db.run("DELETE FROM sticker_folder_items WHERE folder_id=? AND sticker_id=?", (fid, s["id"]))
    else:
        if db.value("SELECT count(*) FROM sticker_folder_items WHERE folder_id=?", (fid,)) >= 300:
            raise ApiError(400, "В папке не больше 300 стикеров")
        db.run("INSERT OR IGNORE INTO sticker_folder_items (folder_id, sticker_id) VALUES (?,?)", (fid, s["id"]))
    return ok()


# ---------------------------------------------------------------- 3D-стикеры
AVATAR_EMOJI = {"neutral": "🙂", "happy": "😄", "smirk": "😏", "cool": "😎", "surprised": "😮", "love": "😍",
                "laugh": "😂", "wink": "😉", "angry": "😠", "sad": "😢", "sleepy": "😴"}


def avatar_pack_slug(user_id: int) -> str:
    return f"a3d{user_id}"


@auth()
async def avatar_stickers(request: Request):
    """Набор «<имя> · 3D»: при каждом сохранении 3D-аватара браузер присылает снимки эмоций — набор пересобирается.
    Старые файлы не удаляются: на них ссылаются уже отправленные сообщения."""
    limit(request, "upload")
    u = request.state.user
    v = u["id"]
    if not db.value("SELECT avatar3d FROM profiles WHERE user_id=?", (v,)):
        raise ApiError(400, "Сначала создайте 3D-аватар")
    form = await request.form(max_files=len(AVATAR_EMOJI), max_fields=len(AVATAR_EMOJI) * 2 + 4, max_part_size=6 * 1024 * 1024)
    try:
        files, emotions = form.getlist("file"), [str(x) for x in form.getlist("emotion")]
        if not files or len(files) != len(emotions):
            raise ApiError(400, "Нет стикеров")
        if len(set(emotions)) != len(emotions) or any(e not in AVATAR_EMOJI for e in emotions):
            raise ApiError(400, "Неизвестная эмоция")
        try:
            frames = int(form.get("frames") or 1)
        except ValueError:
            frames = 1
        # живые стикеры: каждая эмоция — лента кадров; статичные (старые версии сайта) — как раньше
        saved = [await (media.save_sprite_sticker(f, frames) if frames > 1 else media.save_sticker(f)) for f in files]
    finally:
        await form.close()
    slug = avatar_pack_slug(v)
    first = ((u["name"] or u["username"] or "").split() or ["Мой"])[0]
    title = censor(clean_text(f"{first} · 3D", 64)).strip() or "Мой 3D"
    p = db.one("SELECT * FROM sticker_packs WHERE slug=?", (slug,))
    if p:
        db.run("UPDATE sticker_packs SET title=? WHERE id=?", (title, p["id"]))
        db.run("DELETE FROM stickers WHERE pack_id=?", (p["id"],))
        pid = p["id"]
    else:
        pid = db.run("INSERT INTO sticker_packs (owner_id, slug, title, source) VALUES (?,?,?, 'avatar3d')", (v, slug, title)).lastrowid
    for i, (em, st) in enumerate(zip(emotions, saved)):
        db.run("INSERT INTO stickers (pack_id, file, emoji, animated, position, tags) VALUES (?,?,?,?,?,?)",
               (pid, st["path"], AVATAR_EMOJI[em], 1 if st["animated"] else 0, i, "3d аватар я"))
    db.run("INSERT OR IGNORE INTO user_sticker_packs (user_id, pack_id) VALUES (?,?)", (v, pid))
    return JSONResponse(pack_view(_pack(pid), v), status_code=201)


# ---------------------------------------------------------------- импорт
@auth()
async def tg_preview(request: Request):
    limit(request, "sticker_preview")
    ref = stickers2.parse_tg_ref(request.query_params.get("ref", ""))
    if not ref:
        raise ApiError(400, "Вставьте ссылку вида t.me/addstickers/Название или @Название")
    return JSONResponse(await run_in_threadpool(stickers2.tg_preview, ref[0]))


@auth()
async def tg_thumb(request: Request):
    data = await run_in_threadpool(stickers2.tg_thumb, request.query_params.get("set", ""), request.query_params.get("f", ""))
    ctype = "image/webp" if data[:4] == b"RIFF" else "image/jpeg" if data[:2] == b"\xff\xd8" else "image/png"
    return Response(data, media_type=ctype, headers={"Cache-Control": "private, max-age=3600"})


@auth()
async def tg_import(request: Request):
    limit(request, "upload")
    v = request.state.user["id"]
    ref = stickers2.parse_tg_ref(str((await body(request)).get("ref") or ""))
    if not ref:
        raise ApiError(400, "Вставьте ссылку вида t.me/addstickers/Название или @Название")
    return JSONResponse(await run_in_threadpool(stickers2.start_tg_import, v, ref[0]), status_code=201)


@auth()
async def tg_sets(request: Request):
    """«Ваши наборы из Telegram»: GET — список, POST {text|names, all} — запомнить и перенести (по одному, в фоне)."""
    v = request.state.user["id"]
    if request.method == "GET":
        return JSONResponse({"items": await run_in_threadpool(stickers2.seen_sets, v)})
    limit(request, "upload")
    data = await body(request)
    names = stickers2.parse_tg_refs(str(data.get("text") or ""))
    names += [n for n in (data.get("names") or []) if isinstance(n, str) and stickers2.TG_NAME.match(n)][:100]
    if data.get("all"):
        names += [r["name"] for r in db.all("SELECT name FROM tg_seen_sets WHERE user_id=? AND hidden=0", (v,))]
    names = list(dict.fromkeys(names))[:100]
    if not names:
        raise ApiError(400, "Не нашли ссылок на наборы — вставьте ссылки вида t.me/addstickers/Название")
    remembered = await run_in_threadpool(stickers2.remember_sets, v, names)
    if not remembered:
        raise ApiError(404, "Эти наборы не нашлись в Telegram")
    import threading
    todo = [s["name"] for s in remembered]
    stickers2._queued[v] = list(dict.fromkeys(stickers2._queued.get(v, []) + todo))
    threading.Thread(target=stickers2.import_many, args=(v, todo), daemon=True).start()
    return JSONResponse({"items": await run_in_threadpool(stickers2.seen_sets, v), "started": len(remembered)}, status_code=201)


@auth()
async def tg_set_hide(request: Request):
    db.run("UPDATE tg_seen_sets SET hidden=1 WHERE user_id=? AND name=?", (request.state.user["id"], request.path_params["name"]))
    return ok()


@auth()
async def pack_to_telegram(request: Request):
    """Свой набор → настоящий стикерпак Telegram (POST — запустить, GET — ход и ссылка)."""
    from .. import tgexport
    v = request.state.user["id"]
    p = _own_pack(path_int(request, "id"), v, edit=False)
    if request.method == "GET":
        return JSONResponse(tgexport.status(p["id"]))
    limit(request, "sticker_lab")
    return JSONResponse(await run_in_threadpool(tgexport.start, v, p), status_code=202)


@auth()
async def file_import(request: Request):
    """ZIP-архив или пачка файлов (PNG, WEBP, GIF, JPEG, TGS, WEBM) → новый набор или дополнение своего."""
    limit(request, "upload")
    v = request.state.user["id"]
    form = await request.form(max_files=200, max_fields=8, max_part_size=90 * 1024 * 1024)
    try:
        title = censor(clean_text(str(form.get("title") or "Импортированный набор"), 64)).strip() or "Импортированный набор"
        pack_id = form.get("pack_id")
        pid = _own_pack(int(pack_id), v)["id"] if pack_id else None
        files, total = [], 0
        for f in form.getlist("files"):
            if not getattr(f, "filename", None):
                continue
            data = await f.read(stickers2.ZIP_MAX_TOTAL + 1)
            total += len(data)
            if total > stickers2.ZIP_MAX_TOTAL:
                raise ApiError(413, "Слишком много данных за раз — до 80 МБ")
            files += stickers2.unpack(f.filename, data)
    finally:
        await form.close()
    if not files:
        raise ApiError(400, "Выберите файлы или ZIP-архив")
    media.charge_upload(total)
    if not pid and db.value("SELECT count(*) FROM sticker_packs WHERE owner_id=? AND shared=0", (v,)) >= MAX_OWN_PACKS:
        raise ApiError(400, f"Можно создать не больше {MAX_OWN_PACKS} наборов")
    return JSONResponse(stickers2.start_file_import(v, title, files, pid), status_code=201)


@auth()
async def import_status(request: Request):
    v = request.state.user["id"]
    r = db.one("SELECT * FROM sticker_imports WHERE id=? AND user_id=?", (path_int(request), v))
    if not r:
        raise ApiError(404, "Не найдено")
    return JSONResponse(stickers2.job_view(r))


@auth()
async def imports(request: Request):
    v = request.state.user["id"]
    rows = db.all("SELECT * FROM sticker_imports WHERE user_id=? ORDER BY id DESC LIMIT 20", (v,))
    return JSONResponse({"items": [stickers2.job_view(r) for r in rows], "telegram": bool(stickers2.tg_token())})


# ---------------------------------------------------------------- Yarko Remix и AI Sticker Lab
def _lab_target(v: int, pack_id, default_title: str) -> int:
    if pack_id:
        p = _own_pack(int(pack_id), v)
        if _count(p["id"]) >= MAX_STICKERS:
            raise ApiError(400, f"В наборе не больше {MAX_STICKERS} стикеров")
        return p["id"]
    p = db.one("SELECT * FROM sticker_packs WHERE owner_id=? AND source='lab' AND title=? AND shared=0", (v, default_title))
    if p and _count(p["id"]) < MAX_STICKERS:
        return p["id"]
    pid = db.run("INSERT INTO sticker_packs (owner_id, slug, title, source) VALUES (?,?,?, 'lab')", (v, secrets.token_hex(5), default_title)).lastrowid
    db.run("INSERT OR IGNORE INTO user_sticker_packs (user_id, pack_id) VALUES (?,?)", (v, pid))
    return pid


def _store_result(v: int, pid: int, img: bytes, animated: bool, emoji: str, tags: str = "", remix_of: int | None = None) -> dict:
    saved = media._store(_webp_result(img))
    pos = (db.value("SELECT max(position) FROM stickers WHERE pack_id=?", (pid,)) or 0) + 1
    sid = db.run("INSERT INTO stickers (pack_id, file, emoji, animated, position, format, tags, remix_of) VALUES (?,?,?,?,?,?,?,?)",
                 (pid, saved["path"], emoji or "🙂", 1 if animated else 0, pos, "webp", tags, remix_of)).lastrowid
    return sticker_view(db.one("SELECT * FROM stickers WHERE id=?", (sid,)))


def _webp_result(img: bytes) -> dict:
    from datetime import datetime
    rel = f"{datetime.now().strftime('%Y/%m')}/st_{secrets.token_hex(10)}.webp"
    return {"path": f"/uploads/{rel}", "_files": {rel: img}}


def _params(raw) -> dict:
    if isinstance(raw, str):
        try:
            raw = json.loads(raw or "{}")
        except ValueError:
            raw = {}
    p = raw if isinstance(raw, dict) else {}
    for k in ("text", "meme_top", "meme_bottom"):
        if p.get(k):
            p[k] = censor(clean_text(str(p[k]), 48))
    return p


@auth()
async def lab_remix(request: Request):
    """Ремикс стикера: превью (сразу картинка) или сохранение в свой набор. Оригинал не меняется."""
    v = request.state.user["id"]
    data = await body(request)
    limit(request, "sticker_preview" if data.get("preview") else "sticker_lab")
    s = usable_sticker(v, data.get("sticker_id"))
    if (s.get("format") or "webp") != "webp":
        raise ApiError(400, "Ремикс пока работает с картинками и GIF-стикерами — анимации TGS и видео можно только копировать")
    raw = await run_in_threadpool(media.read_upload, s["file"])
    p = _params(data.get("params"))
    size = 256 if data.get("preview") else 512
    img, animated = await run_in_threadpool(stickerart.remix, raw, p, size)
    if data.get("preview"):
        return Response(img, media_type="image/webp", headers={"Cache-Control": "no-store"})
    pid = _lab_target(v, data.get("pack_id"), "Мои ремиксы")
    out = await run_in_threadpool(_store_result, v, pid, img, animated, s["emoji"], (s.get("tags") or "") + " ремикс", s["id"])
    if s["owner_id"] != v:  # ремикс чужого — в набор, который нельзя продавать
        db.run("UPDATE sticker_packs SET source='import', published=0, price=0 WHERE id=? AND source IN ('lab','own','copy','remix')", (pid,))
    return JSONResponse({"sticker": out, "pack": pack_view(_pack(pid), v, with_stickers=False)}, status_code=201)


LAB_TOOLS = ("removebg", "enhance", "meme", "remix")


@auth()
async def lab_upload(request: Request):
    """Инструменты AI Lab для своей картинки: убрать фон, улучшить, мем, ремикс. preview=1 — вернуть картинку; иначе сохранить."""
    v = request.state.user["id"]
    form = await request.form(max_files=1, max_fields=8)
    try:
        f = form.get("file")
        if not getattr(f, "filename", None):
            raise ApiError(400, "Выберите картинку")
        raw = await f.read(8 * 1024 * 1024 + 1)
        tool = str(form.get("tool") or "")
        preview = form.get("preview") in ("1", "true")
        params = _params(form.get("params"))
        pack_id = form.get("pack_id")
        emoji = clean_text(str(form.get("emoji") or "🙂"), 8) or "🙂"
    finally:
        await form.close()
    limit(request, "sticker_preview" if preview else "sticker_lab")
    if len(raw) > 8 * 1024 * 1024:
        raise ApiError(413, "Картинка больше 8 МБ")
    if tool not in LAB_TOOLS:
        raise ApiError(400, "Неизвестный инструмент")

    def work() -> tuple[bytes, bool]:
        src = raw
        if params.get("cut") or tool == "removebg":
            src = stickerart.remove_background(src)
        if tool == "enhance" or params.get("enhance"):
            src = stickerart.enhance(src)
        if tool in ("meme", "remix") or any(params.get(k) for k in ("outline", "text", "anim", "elements", "bg")):
            return stickerart.remix(src, params, 256 if preview else 512)
        frames, _ = stickerart.load_frames(src)
        return src, len(frames) > 1
    img, animated = await run_in_threadpool(work)
    if preview:
        return Response(img, media_type="image/webp", headers={"Cache-Control": "no-store"})
    media.charge_upload(len(raw))
    pid = _lab_target(v, pack_id, "AI Lab")
    out = await run_in_threadpool(_store_result, v, pid, img, animated, emoji, "lab")
    return JSONResponse({"sticker": out, "pack": pack_view(_pack(pid), v, with_stickers=False)}, status_code=201)


CAPTION_PROMPT = ("Это фото, из которого делают набор стикеров для мессенджера. Придумай 8 коротких (1–3 слова) живых подписей "
                  "по-русски, по одной на настроение, строго в этом порядке: приветствие, смех, согласие, любовь, удивление, "
                  "восторг, благодарность, грусть. Учитывай, что на фото. Только JSON: {\"captions\": [...]}")


def _ai_captions(raw: bytes) -> list[str]:
    import io
    import re
    from PIL import Image
    try:
        im = Image.open(io.BytesIO(raw)).convert("RGB")
        im.thumbnail((384, 384))
        buf = io.BytesIO(); im.save(buf, "JPEG", quality=80)
        text = stickers2.vision_chat(CAPTION_PROMPT, buf.getvalue(), "image/jpeg", 220, .8)
        if not text:
            return []
        caps = json.loads(re.search(r"\{.*\}", text, re.S).group(0)).get("captions") or []
        return [censor(clean_text(str(c), 24)) for c in caps if str(c).strip()][:8]
    except Exception:  # noqa: BLE001 — без подписей ИИ используем стандартные
        return []


@auth()
async def lab_photo_pack(request: Request):
    """Набор из одного фото: фон убирается, 10 стикеров с подписями (их придумывает ИИ по фото), элементами и анимациями."""
    limit(request, "sticker_lab")
    v = request.state.user["id"]
    form = await request.form(max_files=1, max_fields=6)
    try:
        f = form.get("file")
        if not getattr(f, "filename", None):
            raise ApiError(400, "Выберите фото")
        raw = await f.read(8 * 1024 * 1024 + 1)
        title = censor(clean_text(str(form.get("title") or "Мои стикеры"), 64)).strip() or "Мои стикеры"
        cut = form.get("cut") not in ("0", "false")
    finally:
        await form.close()
    if len(raw) > 8 * 1024 * 1024:
        raise ApiError(413, "Фото больше 8 МБ")
    media.charge_upload(len(raw))
    if db.value("SELECT count(*) FROM sticker_packs WHERE owner_id=? AND shared=0", (v,)) >= MAX_OWN_PACKS:
        raise ApiError(400, f"Можно создать не больше {MAX_OWN_PACKS} наборов")
    from .. import consents
    # подписи придумывает ИИ только с согласия; без него — готовые подписи
    caps = await run_in_threadpool(_ai_captions, raw) if consents.has(v, "ai") else []
    items = await run_in_threadpool(stickerart.photo_pack, raw, caps, cut)
    pid = db.run("INSERT INTO sticker_packs (owner_id, slug, title, source) VALUES (?,?,?, 'lab')", (v, secrets.token_hex(5), title)).lastrowid
    db.run("INSERT OR IGNORE INTO user_sticker_packs (user_id, pack_id) VALUES (?,?)", (v, pid))
    for img, animated, emoji in items:
        await run_in_threadpool(_store_result, v, pid, img, animated, emoji, "фото я")
    return JSONResponse(pack_view(_pack(pid), v), status_code=201)


TEXT_PROMPT = """Ты дизайнер стикеров. По описанию придумай 6 стикеров, которые рисуются из эмодзи и короткой надписи.
Для каждого: "emoji" — главный эмодзи (один символ), "accent" — до 3 маленьких эмодзи-украшений, "caption" — надпись по-русски
(1–3 слова, можно пусто), "bg" — цвет подложки в формате #rrggbb или "none", "anim" — одно из none/bounce/shake/pulse/wobble/float.
Только JSON: {"stickers":[{"emoji":"🐱","accent":["🌧"],"caption":"Грущу","bg":"#7c5cff","anim":"none"}, ...]}"""


@auth()
async def lab_text(request: Request):
    """Стикеры по описанию: ИИ придумывает композиции из эмодзи и надписей, браузер их рисует (эмодзи — системным шрифтом)."""
    limit(request, "sticker_preview")
    from .. import consents
    consents.require_ai(request.state.user["id"])
    data = await body(request)
    prompt = censor(clean_text(str(data.get("prompt") or ""), 200)).strip()
    if len(prompt) < 2:
        raise ApiError(400, "Опишите, какие стикеры нужны")
    from ..world import llm
    designs = []
    raw = await run_in_threadpool(llm.complete, TEXT_PROMPT, prompt, 700, True)
    parsed = llm.parse_json(raw) or {}
    for d in (parsed.get("stickers") or [])[:8]:
        if not isinstance(d, dict):
            continue
        em = str(d.get("emoji") or "")[:4]
        if not em:
            continue
        anim = d.get("anim") if d.get("anim") in stickerart.ANIMATIONS else "none"
        bg = str(d.get("bg") or "none")
        designs.append({"emoji": em, "accent": [str(a)[:4] for a in (d.get("accent") or [])[:3]],
                        "caption": censor(clean_text(str(d.get("caption") or ""), 24)),
                        "bg": bg if bg == "none" or (len(bg) == 7 and bg.startswith("#")) else "none", "anim": anim})
    if not designs:  # без ИИ — по словам из описания
        ems = list(stickers2.words_to_emoji(prompt))[:6] or ["🙂", "😄", "😎", "🥰", "😮", "👍"]
        caps = [w for w in prompt.split() if len(w) > 2][:6]
        designs = [{"emoji": e, "accent": ["✨"] if i % 2 else [], "caption": (caps[i] if i < len(caps) else "").capitalize(),
                    "bg": ["#7c5cff", "none", "#ff6b9a", "none", "#22c55e", "none"][i % 6], "anim": "none"} for i, e in enumerate(ems)]
    return JSONResponse({"designs": designs, "ai": bool(parsed.get("stickers"))})


@auth()
async def lab_reactions(request: Request):
    """Из стикера — три анимированные реакции (пульс, прыжок, тряска), сразу в избранных реакциях."""
    limit(request, "sticker_lab")
    v = request.state.user["id"]
    data = await body(request)
    s = usable_sticker(v, data.get("sticker_id"))
    if (s.get("format") or "webp") != "webp":
        raise ApiError(400, "Реакции делаются из картинок и GIF-стикеров")
    raw = await run_in_threadpool(media.read_upload, s["file"])
    pid = _lab_target(v, None, "Мои реакции")
    db.run("UPDATE sticker_packs SET kind='reactions' WHERE id=?", (pid,))
    if s["owner_id"] != v:
        db.run("UPDATE sticker_packs SET source='import', published=0, price=0 WHERE id=?", (pid,))
    made = []
    for anim in ("pulse", "bounce", "shake"):
        img, animated = await run_in_threadpool(stickerart.remix, raw, {"anim": anim}, 256)
        st = await run_in_threadpool(_store_result, v, pid, img, animated, s["emoji"], "реакция", s["id"])
        db.run("INSERT OR IGNORE INTO sticker_saved (user_id, sticker_id, kind) VALUES (?,?, 'reaction')", (v, st["id"]))
        made.append(st)
    return JSONResponse({"stickers": made}, status_code=201)


# ---------------------------------------------------------------- каталог и продажа за KC
@auth()
async def catalog(request: Request):
    v = request.state.user["id"]
    q = (request.query_params.get("q") or "").strip().lower()[:60]
    sort = request.query_params.get("sort") or "popular"
    price = request.query_params.get("price") or "all"
    kind = request.query_params.get("kind") or ""
    where, args = ["p.published=1"], []
    if q:
        where.append("(lower(p.title) LIKE ? OR lower(p.description) LIKE ? OR EXISTS (SELECT 1 FROM stickers s WHERE s.pack_id=p.id AND lower(s.tags) LIKE ?))")
        args += [f"%{q}%"] * 3
    if price == "free":
        where.append("p.price=0")
    elif price == "paid":
        where.append("p.price>0")
    if kind in KINDS:
        where.append("p.kind=?")
        args.append(kind)
    order = {"new": "p.id DESC", "cheap": "p.price, p.installs DESC"}.get(sort, "p.installs DESC, p.id DESC")
    rows = db.all(f"SELECT p.* FROM sticker_packs p WHERE {' AND '.join(where)} ORDER BY {order} LIMIT 60", tuple(args))
    return JSONResponse({"items": [pack_view(p, v, with_stickers=False, preview=5) for p in rows]})


@auth()
async def publish(request: Request):
    v = request.state.user["id"]
    p = _own_pack(path_int(request), v)
    data = await body(request)
    on = bool(data.get("published"))
    price = int(data.get("price") or 0)
    if on:
        if (p.get("source") or "own") not in SELLABLE_SOURCES:
            raise ApiError(400, "Импортированные наборы публиковать нельзя — только свои рисунки, ремиксы своих и наборы из AI Lab")
        if _count(p["id"]) < 3:
            raise ApiError(400, "Для каталога нужно хотя бы 3 стикера")
        if not 0 <= price <= MAX_PRICE:
            raise ApiError(400, f"Цена — от 0 до {MAX_PRICE} KC")
        if price and economy._age_days(v) < 7:
            raise ApiError(400, "Продавать наборы можно с 7-го дня в Yarko")
    db.run("UPDATE sticker_packs SET published=?, price=? WHERE id=?", (1 if on else 0, price if on else p.get("price") or 0, p["id"]))
    return JSONResponse(pack_view(_pack(p["id"]), v, with_stickers=False))


@auth()
async def buy(request: Request):
    limit(request, "write")
    v = request.state.user["id"]
    p = _pack(path_int(request))
    if not p.get("published") or not p.get("price"):
        raise ApiError(400, "Этот набор не продаётся")
    if p["owner_id"] == v or _purchased(v, p["id"]):
        raise ApiError(400, "Набор уже ваш")
    if economy.linked(v, p["owner_id"]):
        raise ApiError(400, "Связанные аккаунты не могут покупать друг у друга")
    try:
        tx = economy.transfer(v, p["owner_id"], int(p["price"]), "sticker_sale", SALE_FEE, ref=f"pack:{p['id']}")
    except economy.EconError as e:
        raise ApiError(400, str(e))
    db.run("INSERT OR IGNORE INTO sticker_purchases (user_id, pack_id, price) VALUES (?,?,?)", (v, p["id"], p["price"]))
    db.run("INSERT OR IGNORE INTO user_sticker_packs (user_id, pack_id) VALUES (?,?)", (v, p["id"]))
    db.run("UPDATE sticker_packs SET installs=installs+1 WHERE id=?", (p["id"],))
    return JSONResponse({"paid": tx["amount"], "pack": pack_view(_pack(p["id"]), v)})


# ---------------------------------------------------------------- витрина в профиле и достижения коллекционера
ACHIEVEMENTS = [
    ("collector_10", "Коллекционер", "10 наборов в коллекции", "packs", 10, "📚"),
    ("collector_50", "Хранитель", "50 наборов в коллекции", "packs", 50, "🏛"),
    ("hoarder_500", "Сокровищница", "500 стикеров в коллекции", "stickers", 500, "💎"),
    ("creator_1", "Автор", "Свой набор стикеров", "created", 1, "🎨"),
    ("creator_5", "Студия", "5 своих наборов", "created", 5, "🖌"),
    ("importer_3", "Переезд", "3 импортированных набора", "imported", 3, "📦"),
    ("remixer_10", "Ремиксер", "10 ремиксов", "remixes", 10, "🌀"),
    ("popular_10", "Популярный автор", "Ваши наборы добавили 10 раз", "installs", 10, "⭐"),
    ("popular_100", "Звезда стикеров", "Ваши наборы добавили 100 раз", "installs", 100, "🌟"),
    ("seller_1", "Первая продажа", "Кто-то купил ваш набор", "sales", 1, "💰"),
]


def showcase(uid: int, viewer: int) -> dict:
    stats = {
        "packs": db.value("SELECT count(*) FROM user_sticker_packs WHERE user_id=?", (uid,)),
        "stickers": db.value("SELECT count(*) FROM stickers s JOIN user_sticker_packs u ON u.pack_id=s.pack_id WHERE u.user_id=?", (uid,)),
        "created": db.value("SELECT count(*) FROM sticker_packs WHERE owner_id=? AND source IN ('own','lab','remix','copy','avatar3d') AND shared=0", (uid,)),
        "imported": db.value("SELECT count(*) FROM sticker_imports WHERE user_id=? AND status='done'", (uid,)),
        "remixes": db.value("SELECT count(*) FROM stickers s JOIN sticker_packs p ON p.id=s.pack_id WHERE p.owner_id=? AND s.remix_of IS NOT NULL", (uid,)),
        "installs": db.value("SELECT COALESCE(sum(installs),0) FROM sticker_packs WHERE owner_id=?", (uid,)),
        "sales": db.value("SELECT count(*) FROM sticker_purchases sp JOIN sticker_packs p ON p.id=sp.pack_id WHERE p.owner_id=?", (uid,)),
    }
    achievements = [{"id": a[0], "title": a[1], "desc": a[2], "emoji": a[5], "done": stats[a[3]] >= a[4],
                     "progress": min(1, stats[a[3]] / a[4])} for a in ACHIEVEMENTS]
    created = db.all("""SELECT * FROM sticker_packs WHERE owner_id=? AND shared=0 AND source IN ('own','lab','remix','copy','avatar3d')
                        AND (published=1 OR ?=?) ORDER BY installs DESC, id DESC LIMIT 12""", (uid, uid, viewer))
    favorites = db.all("""SELECT p.* FROM sticker_packs p JOIN user_sticker_packs u ON u.pack_id=p.id
                          WHERE u.user_id=? AND u.favorite=1 ORDER BY u.added_at DESC LIMIT 12""", (uid,))
    rare = db.all("""SELECT p.* FROM sticker_packs p JOIN sticker_purchases sp ON sp.pack_id=p.id WHERE sp.user_id=?
                     ORDER BY p.price DESC LIMIT 8""", (uid,))
    popular = [p for p in created if p["installs"]][:6]
    from ..collection import parse_equipped
    eq = parse_equipped(db.value("SELECT equipped FROM profiles WHERE user_id=?", (uid,)))
    card = lambda p: pack_view(p, viewer, with_stickers=False, preview=4)  # noqa: E731
    return {"stats": stats, "achievements": achievements, "created": [card(p) for p in created], "favorites": [card(p) for p in favorites],
            "rare": [card(p) for p in rare], "popular": [card(p) for p in popular], "showcase": eq.get("showcase")}


@auth()
async def user_showcase(request: Request):
    v = request.state.user["id"]
    prof = db.one("SELECT user_id, profile_visibility FROM profiles WHERE username=?", (request.path_params["username"],))
    if not prof:
        raise ApiError(404, "Пользователь не найден")
    uid = prof["user_id"]
    rel = social.relation(v, uid)
    if rel.get("blocked_me") or not (uid == v or rel["status"] == "friends" or prof["profile_visibility"] == "public"):
        raise ApiError(403, "Это закрытый профиль")
    return JSONResponse(await run_in_threadpool(showcase, uid, v))


# ---------------------------------------------------------------- GIF
@auth()
async def gifs(request: Request):
    v = request.state.user["id"]
    if request.method == "GET":
        rows = db.all("SELECT * FROM user_gifs WHERE user_id=? ORDER BY id DESC LIMIT 200", (v,))
        return JSONResponse({"items": [{"id": r["id"], "url": r["file"], "format": r["format"], "w": r["width"], "h": r["height"]} for r in rows]})
    limit(request, "upload")
    if db.value("SELECT count(*) FROM user_gifs WHERE user_id=?", (v,)) >= 300:
        raise ApiError(400, "Не больше 300 GIF — удалите старые")
    form = await request.form(max_files=1, max_fields=2)
    try:
        f = form.get("file")
        if not getattr(f, "filename", None):
            raise ApiError(400, "Выберите GIF")
        raw = await f.read(10 * 1024 * 1024 + 1)
    finally:
        await form.close()
    if len(raw) > 10 * 1024 * 1024:
        raise ApiError(413, "GIF больше 10 МБ")
    media.charge_upload(len(raw))

    def work():
        if raw[:4] == b"\x1a\x45\xdf\xa3":
            r = media._process_webm(raw) if len(raw) <= media.WEBM_MAX else None
            if not r:
                raise ApiError(400, "Видео-GIF до 2 МБ")
            return media._store(r) | {"w": 0, "h": 0}
        from PIL import Image
        import io
        im = Image.open(io.BytesIO(raw))
        if getattr(im, "n_frames", 1) < 2:
            raise ApiError(400, "Это не анимация — для картинок есть стикеры")
        frames, durs = stickerart.load_frames(raw, 90)
        out = []
        for fr in frames:
            fr.thumbnail((480, 480))
            out.append(fr)
        data, _ = stickerart.encode(out, durs)
        return media._store(_webp_result(data)) | {"format": "webp", "w": out[0].width, "h": out[0].height}
    saved = await run_in_threadpool(work)
    gid = db.run("INSERT INTO user_gifs (user_id, file, format, width, height) VALUES (?,?,?,?,?)",
                 (v, saved["path"], saved.get("format", "webp"), saved.get("w", 0), saved.get("h", 0))).lastrowid
    return JSONResponse({"id": gid, "url": saved["path"], "format": saved.get("format", "webp")}, status_code=201)


@auth()
async def delete_gif(request: Request):
    v = request.state.user["id"]
    r = db.one("SELECT * FROM user_gifs WHERE id=? AND user_id=?", (path_int(request), v))
    if not r:
        raise ApiError(404, "Не найдено")
    db.run("DELETE FROM user_gifs WHERE id=?", (r["id"],))
    if not db.value("SELECT 1 FROM user_gifs WHERE file=?", (r["file"],)):
        media.delete_files(r["file"])
    return ok()


def gif_for_message(v: int, gif_id) -> dict:
    try:
        r = db.one("SELECT * FROM user_gifs WHERE id=? AND user_id=?", (int(gif_id), v))
    except (TypeError, ValueError):
        r = None
    if not r:
        raise ApiError(404, "GIF не найден")
    return {"type": "gif", "url": r["file"], "format": r["format"], "w": r["width"], "h": r["height"]}


routes = [
    Route("/api/stickers", my_stickers, methods=["GET"]),
    Route("/api/stickers/search", search, methods=["GET"]),
    Route("/api/stickers/{id:int}", edit_sticker, methods=["PATCH"]),
    Route("/api/stickers/{id:int}", delete_sticker, methods=["DELETE"]),
    Route("/api/stickers/{id:int}/save", save_sticker, methods=["POST"]),
    Route("/api/stickers/{id:int}/used", used_sticker, methods=["POST"]),
    Route("/api/avatar3d-stickers", avatar_stickers, methods=["PUT"]),
    Route("/api/sticker-packs", create_pack, methods=["POST"]),
    Route("/api/sticker-packs/by-slug/{slug}", get_pack, methods=["GET"]),
    Route("/api/sticker-packs/{id:int}/telegram", pack_to_telegram, methods=["GET", "POST"]),
    Route("/api/sticker-packs/{id:int}", update_pack, methods=["PATCH"]),
    Route("/api/sticker-packs/{id:int}", delete_pack, methods=["DELETE"]),
    Route("/api/sticker-packs/{id:int}/stickers", add_sticker, methods=["POST"]),
    Route("/api/sticker-packs/{id:int}/install", install, methods=["POST", "DELETE"]),
    Route("/api/sticker-packs/{id:int}/favorite", favorite_pack, methods=["POST"]),
    Route("/api/sticker-packs/{id:int}/copy", copy_pack, methods=["POST"]),
    Route("/api/sticker-packs/{id:int}/merge", merge_pack, methods=["POST"]),
    Route("/api/sticker-packs/{id:int}/split", split_pack, methods=["POST"]),
    Route("/api/sticker-packs/{id:int}/publish", publish, methods=["POST"]),
    Route("/api/sticker-packs/{id:int}/buy", buy, methods=["POST"]),
    Route("/api/sticker-folders", folders, methods=["POST"]),
    Route("/api/sticker-folders/{id:int}", folders, methods=["PATCH", "DELETE"]),
    Route("/api/sticker-folders/{id:int}/items", folder_items, methods=["POST"]),
    Route("/api/sticker-import", imports, methods=["GET"]),
    Route("/api/sticker-import/telegram", tg_preview, methods=["GET"]),
    Route("/api/sticker-import/telegram", tg_import, methods=["POST"]),
    Route("/api/sticker-import/tg-thumb", tg_thumb, methods=["GET"]),
    Route("/api/sticker-import/files", file_import, methods=["POST"]),
    Route("/api/sticker-import/tg-sets", tg_sets, methods=["GET", "POST"]),
    Route("/api/sticker-import/tg-sets/{name}", tg_set_hide, methods=["DELETE"]),
    Route("/api/sticker-import/{id:int}", import_status, methods=["GET"]),
    Route("/api/sticker-lab/remix", lab_remix, methods=["POST"]),
    Route("/api/sticker-lab/upload", lab_upload, methods=["POST"]),
    Route("/api/sticker-lab/photo-pack", lab_photo_pack, methods=["POST"]),
    Route("/api/sticker-lab/text", lab_text, methods=["POST"]),
    Route("/api/sticker-lab/reactions", lab_reactions, methods=["POST"]),
    Route("/api/sticker-catalog", catalog, methods=["GET"]),
    Route("/api/users/{username}/stickers", user_showcase, methods=["GET"]),
    Route("/api/gifs", gifs, methods=["GET", "POST"]),
    Route("/api/gifs/{id:int}", delete_gif, methods=["DELETE"]),
]
