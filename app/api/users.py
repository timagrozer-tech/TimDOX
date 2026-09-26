"""Профили, друзья, подписки, блокировки, настройки, экспорт и удаление аккаунта."""
import json
import re

from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.routing import Route

from .. import config, db, media, social
from ..realtime import hub
from ..security import censor, clean_text, verify_password
from ..social import FRIEND_IDS_SQL
from ..web import ApiError, auth, body, limit, ok, path_int
from .posts import delete_post_files


def _profile(username: str) -> dict:
    row = db.one("SELECT p.*, u.created_at AS joined_at FROM profiles p JOIN users u ON u.id=p.user_id WHERE p.username=?",
                 (username,))
    if not row:
        raise ApiError(404, "Пользователь не найден")
    return row


def _target(request: Request) -> int:
    uid = path_int(request)
    if not db.value("SELECT 1 FROM users WHERE id=?", (uid,)):
        raise ApiError(404, "Пользователь не найден")
    if uid == request.state.user["id"]:
        raise ApiError(400, "Нельзя выполнить действие с самим собой")
    return uid


def _can_see_friends(v: int, prof: dict) -> bool:
    uid = prof["user_id"]
    if uid == v:
        return True
    if social.blocked_between(v, uid):
        return False
    vis = prof["friends_visibility"]
    return vis == "public" or (vis == "friends" and social.are_friends(v, uid))


@auth()
async def profile(request: Request):
    v = request.state.user["id"]
    p = _profile(request.path_params["username"])
    uid = p["user_id"]
    rel = social.relation(v, uid)
    card = social.user_card(p)
    if rel["blocked_me"]:
        return JSONResponse({"user": card, "relation": rel, "hidden": True, "blocked": True})
    full = uid == v or rel["status"] == "friends" or p["profile_visibility"] == "public"
    my_friends = set(social.friend_ids(v))
    their_friends = set(social.friend_ids(uid))
    data = {
        "user": card,
        "cover": p["cover"],
        "relation": rel,
        "hidden": not full,
        "joined_at": p["joined_at"],
        "counts": {
            "friends": len(their_friends),
            "followers": db.value("SELECT count(*) FROM follows WHERE followee_id=?", (uid,)),
            "following": db.value("SELECT count(*) FROM follows WHERE follower_id=?", (uid,)),
            "posts": db.value("SELECT count(*) FROM posts WHERE author_id=?", (uid,)) if full else None,
        },
        "mutual_friends": len(my_friends & their_friends) if uid != v else 0,
        "can_message": uid != v and not rel["blocked_by_me"] and (
            p["message_privacy"] == "all" or rel["status"] == "friends"),
        "friends_visible": _can_see_friends(v, p),
    }
    if full:
        data.update({
            "bio": p["bio"], "city": p["city"], "education": p["education"], "work": p["work"],
            "relationship": p["relationship"],
            "birth_date": p["birth_date"] if (p["show_birth_date"] or uid == v) else None,
        })
    return JSONResponse(data)


def _people(rows: list[dict], v: int) -> list[dict]:
    my_friends = set(social.friend_ids(v))
    out = []
    for r in rows:
        c = social.user_card(r)
        c["city"] = r.get("city", "")
        c["is_friend"] = r["id"] in my_friends
        c["is_me"] = r["id"] == v
        out.append(c)
    return out


@auth()
async def user_friends(request: Request):
    v = request.state.user["id"]
    p = _profile(request.path_params["username"])
    if not _can_see_friends(v, p):
        return JSONResponse({"items": [], "hidden": True})
    rows = db.all(f"""SELECT p.user_id AS id, p.username, p.name, p.avatar, p.city FROM profiles p
                      WHERE p.user_id IN ({FRIEND_IDS_SQL}) ORDER BY p.name COLLATE NOCASE""", {"v": p["user_id"]})
    items = _people(rows, v)
    items.sort(key=lambda x: not x["online"])
    return JSONResponse({"items": items})


@auth()
async def user_follows(request: Request):
    v = request.state.user["id"]
    p = _profile(request.path_params["username"])
    kind = request.query_params.get("type", "followers")
    if not _can_see_friends(v, p):
        return JSONResponse({"items": [], "hidden": True})
    if kind == "following":
        sql = "SELECT pr.user_id AS id, pr.username, pr.name, pr.avatar, pr.city FROM follows f JOIN profiles pr ON pr.user_id=f.followee_id WHERE f.follower_id=? ORDER BY f.created_at DESC LIMIT 500"
    else:
        sql = "SELECT pr.user_id AS id, pr.username, pr.name, pr.avatar, pr.city FROM follows f JOIN profiles pr ON pr.user_id=f.follower_id WHERE f.followee_id=? ORDER BY f.created_at DESC LIMIT 500"
    return JSONResponse({"items": _people(db.all(sql, (p["user_id"],)), v)})


# ----------------------------------------------------------------------------
# Дружба и подписки
# ----------------------------------------------------------------------------
def _relation_response(v: int, uid: int):
    return JSONResponse({"relation": social.relation(v, uid)})


@auth()
async def friend_request(request: Request):
    limit(request, "write")
    v = request.state.user["id"]
    uid = _target(request)
    if social.blocked_between(v, uid):
        raise ApiError(403, "Действие недоступно")
    fr = db.one("SELECT * FROM friendships WHERE user_low=min(?,?) AND user_high=max(?,?)", (v, uid, v, uid))
    if fr and fr["status"] == "pending" and fr["addressee_id"] == v:
        return await _accept(v, uid)
    if not fr:
        db.run("INSERT INTO friendships (requester_id, addressee_id, status) VALUES (?,?, 'pending')", (v, uid))
        db.run("INSERT OR IGNORE INTO follows (follower_id, followee_id) VALUES (?,?)", (v, uid))
        social.notify(uid, v, "friend_request")
        social.push_counters(uid)
    return _relation_response(v, uid)


async def _accept(v: int, uid: int):
    cur = db.run("""UPDATE friendships SET status='accepted', accepted_at=? WHERE requester_id=? AND addressee_id=?
                    AND status='pending'""", (db.now(), uid, v))
    if cur.rowcount:
        db.run("INSERT OR IGNORE INTO follows (follower_id, followee_id) VALUES (?,?)", (v, uid))
        db.run("INSERT OR IGNORE INTO follows (follower_id, followee_id) VALUES (?,?)", (uid, v))
        db.run("DELETE FROM notifications WHERE user_id=? AND actor_id=? AND type='friend_request'", (v, uid))
        social.notify(uid, v, "friend_accept")
        social.push_counters(v)
    return _relation_response(v, uid)


@auth()
async def friend_accept(request: Request):
    v = request.state.user["id"]
    return await _accept(v, _target(request))


@auth()
async def friend_remove(request: Request):
    """Отменить заявку, отклонить входящую или удалить из друзей."""
    v = request.state.user["id"]
    uid = _target(request)
    fr = db.one("SELECT * FROM friendships WHERE user_low=min(?,?) AND user_high=max(?,?)", (v, uid, v, uid))
    if fr:
        db.run("DELETE FROM friendships WHERE id=?", (fr["id"],))
        if fr["status"] == "accepted" or fr["requester_id"] == v:
            db.run("DELETE FROM follows WHERE follower_id=? AND followee_id=?", (v, uid))
        if fr["requester_id"] == v and fr["status"] == "pending":
            db.run("DELETE FROM notifications WHERE user_id=? AND actor_id=? AND type='friend_request'", (uid, v))
            social.push_counters(uid)
        social.push_counters(v)
    return _relation_response(v, uid)


@auth()
async def follow(request: Request):
    limit(request, "write")
    v = request.state.user["id"]
    uid = _target(request)
    if request.method == "POST":
        if social.blocked_between(v, uid):
            raise ApiError(403, "Действие недоступно")
        cur = db.run("INSERT OR IGNORE INTO follows (follower_id, followee_id) VALUES (?,?)", (v, uid))
        if cur.rowcount:
            social.notify(uid, v, "follow")
    else:
        db.run("DELETE FROM follows WHERE follower_id=? AND followee_id=?", (v, uid))
        social.unnotify(uid, v, "follow")
    return _relation_response(v, uid)


@auth()
async def block(request: Request):
    v = request.state.user["id"]
    uid = _target(request)
    if request.method == "POST":
        with db.tx() as c:
            c.execute("INSERT OR IGNORE INTO blocks (blocker_id, blocked_id) VALUES (?,?)", (v, uid))
            c.execute("DELETE FROM friendships WHERE user_low=min(?,?) AND user_high=max(?,?)", (v, uid, v, uid))
            c.execute("DELETE FROM follows WHERE (follower_id=? AND followee_id=?) OR (follower_id=? AND followee_id=?)",
                      (v, uid, uid, v))
    else:
        db.run("DELETE FROM blocks WHERE blocker_id=? AND blocked_id=?", (v, uid))
    return _relation_response(v, uid)


@auth()
async def requests_list(request: Request):
    v = request.state.user["id"]
    incoming = db.all("""SELECT p.user_id AS id, p.username, p.name, p.avatar, p.city FROM friendships f
                         JOIN profiles p ON p.user_id=f.requester_id WHERE f.addressee_id=? AND f.status='pending'
                         ORDER BY f.id DESC""", (v,))
    outgoing = db.all("""SELECT p.user_id AS id, p.username, p.name, p.avatar, p.city FROM friendships f
                         JOIN profiles p ON p.user_id=f.addressee_id WHERE f.requester_id=? AND f.status='pending'
                         ORDER BY f.id DESC""", (v,))
    blocked = db.all("""SELECT p.user_id AS id, p.username, p.name, p.avatar, p.city FROM blocks b
                        JOIN profiles p ON p.user_id=b.blocked_id WHERE b.blocker_id=?""", (v,))
    return JSONResponse({"incoming": _people(incoming, v), "outgoing": _people(outgoing, v), "blocked": _people(blocked, v)})


@auth()
async def suggestions(request: Request):
    """«Возможно, вы знакомы»: друзья друзей, затем люди из того же города, затем новички."""
    v = request.state.user["id"]
    my_city = db.value("SELECT city FROM profiles WHERE user_id=?", (v,)) or ""
    rows = db.all(f"""
        WITH mine AS ({FRIEND_IDS_SQL}),
        fof AS (
            SELECT CASE WHEN f.requester_id IN (SELECT * FROM mine) THEN f.addressee_id ELSE f.requester_id END AS uid,
                   count(*) AS mutual
            FROM friendships f
            WHERE f.status='accepted' AND (f.requester_id IN (SELECT * FROM mine) OR f.addressee_id IN (SELECT * FROM mine))
            GROUP BY uid)
        SELECT p.user_id AS id, p.username, p.name, p.avatar, p.city, coalesce(fof.mutual, 0) AS mutual
        FROM profiles p LEFT JOIN fof ON fof.uid = p.user_id
        WHERE p.user_id != :v
          AND p.user_id NOT IN (SELECT * FROM mine)
          AND NOT EXISTS (SELECT 1 FROM friendships f2 WHERE f2.user_low=min(:v,p.user_id) AND f2.user_high=max(:v,p.user_id))
          AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id=:v AND b.blocked_id=p.user_id) OR (b.blocker_id=p.user_id AND b.blocked_id=:v))
        ORDER BY mutual DESC, (p.city != '' AND p.city = :city) DESC, p.user_id DESC
        LIMIT 12""", {"v": v, "city": my_city})
    items = _people(rows, v)
    for item, r in zip(items, rows):
        item["mutual"] = r["mutual"]
    return JSONResponse({"items": items})


@auth()
async def online_friends(request: Request):
    v = request.state.user["id"]
    ids = [i for i in social.friend_ids(v) if hub.is_online(i)]
    return JSONResponse({"items": list(social.cards_by_ids(ids).values())[:20], "total": len(ids)})


# ----------------------------------------------------------------------------
# Настройки
# ----------------------------------------------------------------------------
PROFILE_FIELDS = {"name": 60, "bio": 500, "city": 80, "education": 200, "work": 200, "relationship": 40}
PRIVACY_FIELDS = {
    "profile_visibility": ("public", "friends"),
    "message_privacy": ("all", "friends"),
    "friends_visibility": ("public", "friends", "only_me"),
    "default_visibility": ("public", "friends", "only_me"),
    "theme": ("system", "light", "dark"),
}


@auth()
async def settings_get(request: Request):
    u = request.state.user
    p = db.one("SELECT * FROM profiles WHERE user_id=?", (u["id"],))
    p["email"] = u["email"]
    p["email_verified"] = bool(u["email_verified_at"])
    p["show_birth_date"] = bool(p["show_birth_date"])
    return JSONResponse(p)


@auth()
async def settings_update(request: Request):
    limit(request, "write")
    v = request.state.user["id"]
    data = await body(request)
    sets, params, errors = [], [], {}
    for field, max_len in PROFILE_FIELDS.items():
        if field in data:
            val = censor(clean_text(str(data[field] or ""), max_len))
            if field == "name":
                val = re.sub(r"\s+", " ", val)
                if len(val) < 2:
                    errors["name"] = "Имя — от 2 до 60 символов"
                    continue
            sets.append(f"{field}=?")
            params.append(val)
    if "birth_date" in data:
        bd = data["birth_date"] or None
        if bd and not re.match(r"^\d{4}-\d{2}-\d{2}$", str(bd)):
            errors["birth_date"] = "Некорректная дата"
        else:
            sets.append("birth_date=?")
            params.append(bd)
    if "show_birth_date" in data:
        sets.append("show_birth_date=?")
        params.append(1 if data["show_birth_date"] else 0)
    if "username" in data:
        from .auth_routes import RESERVED
        from ..security import USERNAME_RE
        un = str(data["username"]).strip().lstrip("@")
        if not USERNAME_RE.match(un):
            errors["username"] = "Логин: 3–30 символов, латиница, цифры и _"
        elif un.lower() in RESERVED or db.value("SELECT 1 FROM profiles WHERE username=? AND user_id!=?", (un, v)):
            errors["username"] = "Этот логин уже занят"
        else:
            sets.append("username=?")
            params.append(un)
    for field, allowed in PRIVACY_FIELDS.items():
        if field in data:
            if data[field] not in allowed:
                errors[field] = "Недопустимое значение"
                continue
            sets.append(f"{field}=?")
            params.append(data[field])
    if errors:
        return JSONResponse({"error": "Проверьте поля формы", "fields": errors}, status_code=422)
    if sets:
        db.run(f"UPDATE profiles SET {', '.join(sets)} WHERE user_id=?", (*params, v))
    return await settings_get(request)


@auth()
async def upload_image(request: Request):
    limit(request, "upload")
    v = request.state.user["id"]
    kind = request.path_params["kind"]
    if kind not in ("avatar", "cover"):
        raise ApiError(404, "Не найдено")
    old = db.value(f"SELECT {kind} FROM profiles WHERE user_id=?", (v,))
    if request.method == "DELETE":
        db.run(f"UPDATE profiles SET {kind}=NULL WHERE user_id=?", (v,))
        media.delete_files(old)
        return JSONResponse({kind: None})
    form = await request.form(max_files=1, max_fields=5)
    try:
        f = form.get("file")
        if not getattr(f, "filename", None):
            raise ApiError(400, "Выберите изображение")
        saved = await media.save_upload(f, kind)
    finally:
        await form.close()
    url = saved["path"]  # превью доступно по тому же адресу с суффиксом _t
    db.run(f"UPDATE profiles SET {kind}=? WHERE user_id=?", (url, v))
    media.delete_files(old)
    return JSONResponse({kind: url})


@auth()
async def export_data(request: Request):
    """Выгрузка всех своих данных в JSON (право субъекта персональных данных)."""
    v = request.state.user["id"]
    data = {
        "account": db.one("SELECT id, email, email_verified_at, created_at FROM users WHERE id=?", (v,)),
        "profile": db.one("SELECT * FROM profiles WHERE user_id=?", (v,)),
        "posts": db.all("SELECT * FROM posts WHERE author_id=? ORDER BY id", (v,)),
        "media": db.all("SELECT m.* FROM post_media m JOIN posts p ON p.id=m.post_id WHERE p.author_id=?", (v,)),
        "comments": db.all("SELECT * FROM comments WHERE author_id=? ORDER BY id", (v,)),
        "reactions": db.all("SELECT * FROM reactions WHERE user_id=?", (v,)),
        "bookmarks": db.all("SELECT * FROM bookmarks WHERE user_id=?", (v,)),
        "friends": db.all("SELECT * FROM friendships WHERE requester_id=? OR addressee_id=?", (v, v)),
        "follows": db.all("SELECT * FROM follows WHERE follower_id=? OR followee_id=?", (v, v)),
        "messages": db.all("SELECT * FROM messages WHERE sender_id=? ORDER BY id", (v,)),
        "exported_at": db.now(),
    }
    return Response(json.dumps(data, ensure_ascii=False, indent=2), media_type="application/json",
                    headers={"Content-Disposition": 'attachment; filename="krug-export.json"'})


@auth()
async def delete_account(request: Request):
    limit(request, "auth")
    v = request.state.user["id"]
    data = await body(request)
    stored = db.value("SELECT password_hash FROM users WHERE id=?", (v,))
    if not verify_password(str(data.get("password", "")), stored):
        raise ApiError(400, "Неверный пароль")
    post_ids = [r["id"] for r in db.all("SELECT id FROM posts WHERE author_id=?", (v,))]
    if post_ids:
        delete_post_files(post_ids)
    prof = db.one("SELECT avatar, cover FROM profiles WHERE user_id=?", (v,))
    media.delete_files(prof["avatar"], prof["cover"])
    db.run("DELETE FROM reports WHERE target_type='user' AND target_id=?", (v,))
    db.run("DELETE FROM users WHERE id=?", (v,))  # остальное удаляется каскадно
    # пустые личные диалоги
    db.run("""DELETE FROM conversations WHERE id NOT IN (SELECT conversation_id FROM conversation_members
              GROUP BY conversation_id HAVING count(*) >= 2)""")
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(config.SESSION_COOKIE, path="/")
    return resp


routes = [
    Route("/api/users/{username}", profile, methods=["GET"]),
    Route("/api/users/{username}/friends", user_friends, methods=["GET"]),
    Route("/api/users/{username}/follows", user_follows, methods=["GET"]),
    Route("/api/people/{id:int}/friend", friend_request, methods=["POST"]),
    Route("/api/people/{id:int}/friend", friend_remove, methods=["DELETE"]),
    Route("/api/people/{id:int}/friend/accept", friend_accept, methods=["POST"]),
    Route("/api/people/{id:int}/follow", follow, methods=["POST", "DELETE"]),
    Route("/api/people/{id:int}/block", block, methods=["POST", "DELETE"]),
    Route("/api/friends/requests", requests_list, methods=["GET"]),
    Route("/api/friends/suggestions", suggestions, methods=["GET"]),
    Route("/api/friends/online", online_friends, methods=["GET"]),
    Route("/api/me/settings", settings_get, methods=["GET"]),
    Route("/api/me/settings", settings_update, methods=["PATCH"]),
    Route("/api/me/{kind}", upload_image, methods=["POST", "DELETE"]),
    Route("/api/me/export", export_data, methods=["GET"]),
    Route("/api/me", delete_account, methods=["DELETE"]),
]
