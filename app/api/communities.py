"""Сообщества и паблики: создание, вступление, заявки, роли, стена, закреплённая запись."""
import re

from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from .. import db, media, social
from ..security import censor, clean_text
from ..web import ApiError, auth, body, int_param, limit, ok
from .posts import PAGE, _page, delete_post_files, hydrate, visible_post_sql

SLUG_RE = re.compile(r"^[a-z0-9_]{3,40}$")
RESERVED = {"new", "create", "admin", "api", "my", "popular", "search"}


def _get(slug: str) -> dict:
    row = db.one("SELECT * FROM communities WHERE slug=?", (slug,))
    if not row:
        raise ApiError(404, "Сообщество не найдено")
    return row


def _membership(cid: int, v: int) -> dict | None:
    return db.one("SELECT role, status FROM community_members WHERE community_id=? AND user_id=?", (cid, v))


def _require_role(cid: int, v: int, roles=("admin",)) -> str:
    m = _membership(cid, v)
    if not m or m["status"] != "member" or m["role"] not in roles:
        raise ApiError(403, "Недостаточно прав")
    return m["role"]


def _card(c: dict, v: int | None = None) -> dict:
    members = db.value("SELECT count(*) FROM community_members WHERE community_id=? AND status='member'", (c["id"],))
    out = {"id": c["id"], "slug": c["slug"], "name": c["name"], "description": c["description"],
           "avatar": c["avatar"], "cover": c["cover"], "is_private": bool(c["is_private"]),
           "members_count": members}
    if v is not None:
        m = _membership(c["id"], v)
        out["membership"] = m["status"] if m else None
        out["role"] = m["role"] if m and m["status"] == "member" else None
    return out


def _admin_ids(cid: int) -> list[int]:
    return [r["user_id"] for r in db.all(
        "SELECT user_id FROM community_members WHERE community_id=? AND role='admin' AND status='member'", (cid,))]


def ensure_admin(community_id: int) -> None:
    """Если у сообщества не осталось администратора — назначаем самого давнего модератора, иначе самого давнего участника."""
    if db.value("SELECT 1 FROM community_members WHERE community_id=? AND role='admin' AND status='member'", (community_id,)):
        return
    heir = db.value("""SELECT user_id FROM community_members WHERE community_id=? AND status='member'
                       ORDER BY (role='moderator') DESC, joined_at LIMIT 1""", (community_id,))
    if heir:
        db.run("UPDATE community_members SET role='admin' WHERE community_id=? AND user_id=?", (community_id, heir))


@auth()
async def list_communities(request: Request):
    v = request.state.user["id"]
    tab = request.query_params.get("tab", "my")
    q = (request.query_params.get("q") or "").strip().lower()[:80]
    if q:
        from .misc import _like
        like = _like(q.lower())
        rows = db.all("""SELECT c.* FROM communities c WHERE ulower(c.name) LIKE ? ESCAPE '\\'
                         OR ulower(c.description) LIKE ? ESCAPE '\\' OR c.slug LIKE ? ESCAPE '\\' LIMIT 30""", (like, like, like))
    elif tab == "my":
        rows = db.all("""SELECT c.* FROM communities c JOIN community_members m ON m.community_id = c.id
                         WHERE m.user_id=? ORDER BY m.status = 'member' DESC, c.name""", (v,))
    elif tab == "manage":
        rows = db.all("""SELECT c.* FROM communities c JOIN community_members m ON m.community_id = c.id
                         WHERE m.user_id=? AND m.role IN ('admin','moderator') AND m.status='member' ORDER BY c.name""", (v,))
    else:
        rows = db.all("""SELECT c.*, (SELECT count(*) FROM community_members m WHERE m.community_id=c.id AND m.status='member') AS n
                         FROM communities c ORDER BY n DESC, c.id DESC LIMIT 30""")
    return JSONResponse({"items": [_card(r, v) for r in rows]})


@auth(require_verified=True)
async def create_community(request: Request):
    limit(request, "write")
    v = request.state.user["id"]
    data = await body(request)
    name = censor(clean_text(data.get("name"), 80))
    slug = str(data.get("slug") or "").strip().lower()
    errors = {}
    if len(name) < 3:
        errors["name"] = "Название — от 3 до 80 символов"
    if not SLUG_RE.match(slug):
        errors["slug"] = "Адрес: 3–40 символов, латиница, цифры и _"
    elif slug in RESERVED or db.value("SELECT 1 FROM communities WHERE slug=?", (slug,)):
        errors["slug"] = "Этот адрес уже занят"
    if errors:
        return JSONResponse({"error": "Проверьте поля формы", "fields": errors}, status_code=422)
    with db.tx() as c:
        cid = c.execute("""INSERT INTO communities (slug, name, description, is_private, wall_open, created_by)
                           VALUES (?,?,?,?,?,?)""",
                        (slug, name, censor(clean_text(data.get("description"), 2000)),
                         1 if data.get("is_private") else 0, 1 if data.get("wall_open") else 0, v)).lastrowid
        c.execute("INSERT INTO community_members (community_id, user_id, role, status) VALUES (?,?, 'admin', 'member')", (cid, v))
    return JSONResponse(_card(db.one("SELECT * FROM communities WHERE id=?", (cid,)), v), status_code=201)


@auth()
async def get_community(request: Request):
    v = request.state.user["id"]
    c = _get(request.path_params["slug"])
    data = _card(c, v)
    is_member = data["membership"] == "member"
    data.update({
        "wall_open": bool(c["wall_open"]),
        "created_at": c["created_at"],
        "can_view": not c["is_private"] or is_member,
        "can_post": is_member and (data["role"] in ("admin", "moderator") or bool(c["wall_open"])),
        "pending_count": db.value("SELECT count(*) FROM community_members WHERE community_id=? AND status='pending'", (c["id"],))
        if data["role"] in ("admin", "moderator") else 0,
        "friends_inside": [social.user_card(r) for r in db.all(f"""
            SELECT p.user_id AS id, p.username, p.name, p.avatar FROM community_members m JOIN profiles p ON p.user_id = m.user_id
            WHERE m.community_id = :c AND m.status = 'member' AND m.user_id IN ({social.FRIEND_IDS_SQL}) LIMIT 6""",
            {"c": c["id"], "v": v})],
        "pinned": None,
    })
    if c["pinned_post_id"] and data["can_view"]:
        row = db.one(f"""SELECT p.* FROM posts p JOIN profiles pr ON pr.user_id = p.author_id
                         WHERE p.id = :id AND {visible_post_sql()}""", {"id": c["pinned_post_id"], "v": v})
        data["pinned"] = hydrate([row], v)[0] if row else None
    return JSONResponse(data)


@auth()
async def update_community(request: Request):
    v = request.state.user["id"]
    c = _get(request.path_params["slug"])
    _require_role(c["id"], v)
    data = await body(request)
    sets, params = [], []
    if "name" in data:
        name = censor(clean_text(data["name"], 80))
        if len(name) < 3:
            raise ApiError(422, "Название — от 3 до 80 символов")
        sets.append("name=?"); params.append(name)
    if "description" in data:
        sets.append("description=?"); params.append(censor(clean_text(data["description"], 2000)))
    for flag in ("is_private", "wall_open"):
        if flag in data:
            sets.append(f"{flag}=?"); params.append(1 if data[flag] else 0)
    if "pinned_post_id" in data:
        pid = data["pinned_post_id"]
        if pid and not db.value("SELECT 1 FROM posts WHERE id=? AND community_id=?", (int(pid), c["id"])):
            raise ApiError(404, "Запись не найдена в этом сообществе")
        sets.append("pinned_post_id=?"); params.append(int(pid) if pid else None)
    if sets:
        db.run(f"UPDATE communities SET {', '.join(sets)} WHERE id=?", (*params, c["id"]))
    if data.get("is_private") is False:
        # открыли сообщество — одобряем все заявки
        db.run("UPDATE community_members SET status='member' WHERE community_id=? AND status='pending'", (c["id"],))
    return JSONResponse(_card(db.one("SELECT * FROM communities WHERE id=?", (c["id"],)), v))


@auth()
async def community_image(request: Request):
    limit(request, "upload")
    v = request.state.user["id"]
    c = _get(request.path_params["slug"])
    _require_role(c["id"], v)
    kind = request.path_params["kind"]
    if kind not in ("avatar", "cover"):
        raise ApiError(404, "Не найдено")
    form = await request.form(max_files=1, max_fields=5)
    try:
        f = form.get("file")
        if not getattr(f, "filename", None):
            raise ApiError(400, "Выберите изображение")
        saved = await media.save_upload(f, kind)
    finally:
        await form.close()
    media.delete_files(c[kind])
    db.run(f"UPDATE communities SET {kind}=? WHERE id=?", (saved["path"], c["id"]))
    return JSONResponse({kind: saved["path"]})


@auth()
async def delete_community(request: Request):
    v = request.state.user["id"]
    c = _get(request.path_params["slug"])
    _require_role(c["id"], v)
    ids = [r["id"] for r in db.all("SELECT id FROM posts WHERE community_id=?", (c["id"],))]
    if ids:
        delete_post_files(ids)
    media.delete_files(c["avatar"], c["cover"])
    db.run("DELETE FROM communities WHERE id=?", (c["id"],))
    return ok()


@auth()
async def join(request: Request):
    v = request.state.user["id"]
    c = _get(request.path_params["slug"])
    m = _membership(c["id"], v)
    if request.method == "POST":
        if m:
            return JSONResponse(_card(c, v))
        status = "pending" if c["is_private"] else "member"
        db.run("INSERT OR IGNORE INTO community_members (community_id, user_id, status) VALUES (?,?,?)", (c["id"], v, status))
        if status == "pending":
            for admin in _admin_ids(c["id"]):
                social.notify(admin, v, "community_request", extra={"slug": c["slug"], "name": c["name"]})
        return JSONResponse(_card(c, v))
    # выход
    if m and m["role"] == "admin" and m["status"] == "member" and _admin_ids(c["id"]) == [v]:
        others = db.value("SELECT count(*) FROM community_members WHERE community_id=? AND status='member' AND user_id!=?", (c["id"], v))
        if others:
            raise ApiError(400, "Вы единственный администратор. Назначьте другого администратора или удалите сообщество.")
    db.run("DELETE FROM community_members WHERE community_id=? AND user_id=?", (c["id"], v))
    return JSONResponse(_card(c, v))


@auth()
async def community_posts(request: Request):
    v = request.state.user["id"]
    c = _get(request.path_params["slug"])
    cursor = int_param(request, "cursor", 2**62)
    rows = db.all(f"""
        SELECT p.* FROM posts p JOIN profiles pr ON pr.user_id = p.author_id
        WHERE p.community_id = :c AND p.id < :cursor AND {visible_post_sql()}
        ORDER BY p.id DESC LIMIT :lim""", {"v": v, "c": c["id"], "cursor": cursor, "lim": PAGE + 1})
    return JSONResponse(_page(rows, v))


@auth()
async def members(request: Request):
    v = request.state.user["id"]
    c = _get(request.path_params["slug"])
    status = request.query_params.get("status", "member")
    m = _membership(c["id"], v)
    if status == "pending":
        _require_role(c["id"], v, ("admin", "moderator"))
    elif c["is_private"] and not (m and m["status"] == "member"):
        return JSONResponse({"items": [], "hidden": True})
    rows = db.all("""SELECT p.user_id AS id, p.username, p.name, p.avatar, p.city, m.role FROM community_members m
                     JOIN profiles p ON p.user_id = m.user_id WHERE m.community_id=? AND m.status=?
                     ORDER BY CASE m.role WHEN 'admin' THEN 0 WHEN 'moderator' THEN 1 ELSE 2 END, p.name LIMIT 500""",
                  (c["id"], status))
    return JSONResponse({"items": [{**social.user_card(r), "city": r["city"], "role": r["role"]} for r in rows]})


@auth()
async def manage_member(request: Request):
    """action: approve | reject | remove | role (role: admin/moderator/member)"""
    v = request.state.user["id"]
    c = _get(request.path_params["slug"])
    uid = int(request.path_params["uid"])
    my_role = _require_role(c["id"], v, ("admin", "moderator"))
    data = await body(request)
    action = data.get("action")
    target = _membership(c["id"], uid)
    if not target:
        raise ApiError(404, "Участник не найден")
    if action == "approve" and target["status"] == "pending":
        db.run("UPDATE community_members SET status='member', joined_at=? WHERE community_id=? AND user_id=?", (db.now(), c["id"], uid))
        social.notify(uid, v, "community_approved", extra={"slug": c["slug"], "name": c["name"]})
    elif action in ("reject", "remove"):
        if target["role"] == "admin" and my_role != "admin":
            raise ApiError(403, "Недостаточно прав")
        if uid == v:
            raise ApiError(400, "Чтобы выйти, используйте кнопку «Выйти»")
        db.run("DELETE FROM community_members WHERE community_id=? AND user_id=?", (c["id"], uid))
    elif action == "role":
        if my_role != "admin":
            raise ApiError(403, "Назначать роли может только администратор")
        role = data.get("role")
        if role not in ("admin", "moderator", "member") or target["status"] != "member":
            raise ApiError(400, "Некорректная роль")
        if uid == v and role != "admin" and _admin_ids(c["id"]) == [v]:
            raise ApiError(400, "Нельзя снять с себя права единственного администратора")
        db.run("UPDATE community_members SET role=? WHERE community_id=? AND user_id=?", (role, c["id"], uid))
    else:
        raise ApiError(400, "Неизвестное действие")
    return ok()


routes = [
    Route("/api/communities", list_communities, methods=["GET"]),
    Route("/api/communities", create_community, methods=["POST"]),
    Route("/api/communities/{slug}", get_community, methods=["GET"]),
    Route("/api/communities/{slug}", update_community, methods=["PATCH"]),
    Route("/api/communities/{slug}", delete_community, methods=["DELETE"]),
    Route("/api/communities/{slug}/join", join, methods=["POST", "DELETE"]),
    Route("/api/communities/{slug}/posts", community_posts, methods=["GET"]),
    Route("/api/communities/{slug}/members", members, methods=["GET"]),
    Route("/api/communities/{slug}/members/{uid:int}", manage_member, methods=["POST"]),
    Route("/api/communities/{slug}/{kind}", community_image, methods=["POST"]),
]
