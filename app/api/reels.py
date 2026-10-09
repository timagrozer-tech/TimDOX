"""Клипы — короткие вертикальные видео (как Reels): лента, лайки, комментарии, просмотры."""
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from .. import collection, config, db, media, social
from ..security import censor, clean_text
from ..web import ApiError, auth, body, int_param, limit, ok, path_int

PAGE = 8


def _num(value, lo, hi):
    try:
        x = float(value)
    except (TypeError, ValueError):
        return None
    return max(lo, min(hi, x)) if x == x else None


def reel_views(rows: list[dict], v: int) -> list[dict]:
    if not rows:
        return []
    ids = [r["id"] for r in rows]
    ph = db.placeholders(ids)
    likes = {r["reel_id"]: r["n"] for r in db.all(f"SELECT reel_id, count(*) AS n FROM reel_likes WHERE reel_id IN ({ph}) GROUP BY reel_id", tuple(ids))}
    mine = {r["reel_id"] for r in db.all(f"SELECT reel_id FROM reel_likes WHERE user_id=? AND reel_id IN ({ph})", (v, *ids))}
    comments = {r["reel_id"]: r["n"] for r in db.all(f"SELECT reel_id, count(*) AS n FROM reel_comments WHERE reel_id IN ({ph}) GROUP BY reel_id", tuple(ids))}
    authors = social.cards_by_ids([r["author_id"] for r in rows])
    following = {r["followee_id"] for r in db.all(
        f"SELECT followee_id FROM follows WHERE follower_id=? AND followee_id IN ({db.placeholders(list(authors))})", (v, *authors))}
    friends = set(social.friend_ids(v))
    return [{
        "id": r["id"], "video": r["video"], "poster": r["poster"], "caption": r["caption"], "duration": r["duration"],
        "width": r["width"], "height": r["height"], "views": r["views"], "created_at": r["created_at"],
        "author": authors.get(r["author_id"]), "likes": likes.get(r["id"], 0), "liked": r["id"] in mine,
        "comments": comments.get(r["id"], 0), "mine": r["author_id"] == v,
        "visibility": r.get("visibility") or "public", "comments_off": bool(r.get("comments_off")),
        "following": r["author_id"] in following or r["author_id"] in friends,
    } for r in rows]


def _reel(reel_id: int, v: int) -> dict:
    r = db.one("SELECT * FROM reels WHERE id=?", (reel_id,))
    if not r or social.blocked_between(v, r["author_id"]):
        raise ApiError(404, "Клип не найден")
    if r["author_id"] != v and not social.are_friends(v, r["author_id"]) and (
            (r.get("visibility") or "public") == "friends"
            or db.value("SELECT profile_visibility FROM profiles WHERE user_id=?", (r["author_id"],)) != "public"):
        raise ApiError(404, "Клип доступен только друзьям автора")
    return r


@auth()
async def list_reels(request: Request):
    v = request.state.user["id"]
    cursor = int_param(request, "cursor")
    username = request.query_params.get("user")
    where, params = ["NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id=? AND b.blocked_id=r.author_id) OR (b.blocker_id=r.author_id AND b.blocked_id=?))",
                     """(r.author_id=? OR EXISTS (SELECT 1 FROM profiles pr WHERE pr.user_id=r.author_id AND pr.profile_visibility='public'
                                                   AND coalesce(r.visibility, 'public')='public')
                        OR EXISTS (SELECT 1 FROM friendships f WHERE f.status='accepted' AND f.user_low=least(?, r.author_id) AND f.user_high=greatest(?, r.author_id)))"""], [v, v, v, v, v]
    if username:
        uid = db.value("SELECT user_id FROM profiles WHERE username=?", (username,))
        if not uid:
            raise ApiError(404, "Пользователь не найден")
        where.append("r.author_id=?"); params.append(uid)
    elif request.query_params.get("feed") == "following":
        # подписки: авторы, на которых человек подписан, и друзья
        where.append("""(EXISTS (SELECT 1 FROM follows fo WHERE fo.follower_id=? AND fo.followee_id=r.author_id)
                        OR EXISTS (SELECT 1 FROM friendships f2 WHERE f2.status='accepted'
                                   AND f2.user_low=least(?, r.author_id) AND f2.user_high=greatest(?, r.author_id)))""")
        params += [v, v, v]
    if cursor:
        where.append("r.id<?"); params.append(cursor)
    rows = db.all(f"SELECT r.* FROM reels r WHERE {' AND '.join(where)} ORDER BY r.id DESC LIMIT {PAGE + 1}", tuple(params))
    more = len(rows) > PAGE
    rows = rows[:PAGE]
    return JSONResponse({"items": reel_views(rows, v), "next_cursor": rows[-1]["id"] if more and rows else None})


@auth()
async def get_reel(request: Request):
    v = request.state.user["id"]
    return JSONResponse(reel_views([_reel(path_int(request), v)], v)[0])


@auth(require_verified=True)
async def create_reel(request: Request):
    limit(request, "upload")
    v = request.state.user["id"]
    form = await request.form(max_files=2, max_fields=10, max_part_size=1024 * 1024)
    saved_files = []
    try:
        f = form.get("video")
        if not getattr(f, "filename", None):
            raise ApiError(400, "Выберите видео")
        duration = _num(form.get("duration"), 0, 36000) or 0
        if duration > config.REEL_MAX_SECONDS + 1:
            raise ApiError(400, f"Клип должен быть не длиннее {config.REEL_MAX_SECONDS} секунд")
        caption = censor(clean_text(str(form.get("caption") or ""), 2200))
        visibility = str(form.get("visibility") or "public")
        if visibility not in ("public", "friends"):
            raise ApiError(400, "Неизвестная настройка видимости")
        comments_off = 1 if str(form.get("comments_off") or "") in ("1", "true", "on") else 0
        saved = await media.save_media(f, "video")
        saved_files.append(saved["path"])
        poster = None
        pf = form.get("poster")
        if getattr(pf, "filename", None):
            ps = await media.save_upload(pf, "post")
            saved_files.append(ps["path"])
            poster = ps["path"]
        w = int(_num(form.get("width"), 1, 10000) or 0) or None
        hgt = int(_num(form.get("height"), 1, 10000) or 0) or None
    except Exception:
        media.delete_files(*saved_files)
        raise
    finally:
        await form.close()
    cur = db.run("""INSERT INTO reels (author_id, video, poster, caption, duration, width, height, visibility, comments_off)
                    VALUES (?,?,?,?,?,?,?,?,?)""", (v, saved["path"], poster, caption, duration, w, hgt, visibility, comments_off))
    return JSONResponse(reel_views([db.one("SELECT * FROM reels WHERE id=?", (cur.lastrowid,))], v)[0], status_code=201)


@auth()
async def delete_reel(request: Request):
    u = request.state.user
    r = _reel(path_int(request), u["id"])
    if r["author_id"] != u["id"] and not u["is_admin"]:
        raise ApiError(403, "Удалить можно только свой клип")
    if r["author_id"] != u["id"]:
        from .. import modlog
        modlog.log(u["id"], "delete_reel", "reel", r["id"], r["author_id"], details={"text": modlog.snippet(r.get("caption"))})
    db.run("DELETE FROM reels WHERE id=?", (r["id"],))
    media.delete_files(r["video"], r["poster"])
    return ok()


@auth()
async def like(request: Request):
    limit(request, "write")
    v = request.state.user["id"]
    r = _reel(path_int(request), v)
    if request.method == "DELETE":
        db.run("DELETE FROM reel_likes WHERE reel_id=? AND user_id=?", (r["id"], v))
        # убираем уведомление только об этом клипе, а не обо всех лайках человека
        cur = db.run("DELETE FROM notifications WHERE user_id=? AND actor_id=? AND type='reel_like' AND extra LIKE ?",
                     (r["author_id"], v, f'%"reel_id": {r["id"]}}}%'))
        if cur.rowcount:
            social.push_counters(r["author_id"])
    else:
        cur = db.run("INSERT OR IGNORE INTO reel_likes (reel_id, user_id) VALUES (?,?)", (r["id"], v))
        if cur.rowcount:
            social.notify(r["author_id"], v, "reel_like", extra={"reel_id": r["id"]})
            collection.check(r["author_id"])
    return JSONResponse({"likes": db.value("SELECT count(*) FROM reel_likes WHERE reel_id=?", (r["id"],)),
                         "liked": request.method != "DELETE"})


@auth()
async def view(request: Request):
    v = request.state.user["id"]
    r = _reel(path_int(request), v)
    from ..security import rate_limiter
    # один просмотр от человека раз в 6 часов — счётчик нельзя накрутить
    if r["author_id"] != v and rate_limiter.hit(f"reel_view:{v}:{r['id']}", 1, 6 * 3600):
        db.run("UPDATE reels SET views=views+1 WHERE id=?", (r["id"],))
    return ok()


@auth()
async def comments(request: Request):
    v = request.state.user["id"]
    r = _reel(path_int(request), v)
    if request.method == "POST":
        limit(request, "write")
        if r.get("comments_off") and r["author_id"] != v:
            raise ApiError(403, "Автор отключил комментарии к этому клипу")
        data = await body(request)
        text = censor(clean_text(data.get("text"), 1000))
        if not text:
            raise ApiError(400, "Пустой комментарий")
        cur = db.run("INSERT INTO reel_comments (reel_id, author_id, text) VALUES (?,?,?)", (r["id"], v, text))
        social.notify(r["author_id"], v, "reel_comment", extra={"reel_id": r["id"], "text": text[:80]})
        row = db.one("SELECT * FROM reel_comments WHERE id=?", (cur.lastrowid,))
        return JSONResponse({"id": row["id"], "text": row["text"], "created_at": row["created_at"],
                             "author": social.cards_by_ids([v])[v]}, status_code=201)
    rows = db.all("SELECT * FROM reel_comments WHERE reel_id=? ORDER BY id LIMIT 300", (r["id"],))
    authors = social.cards_by_ids([c["author_id"] for c in rows])
    return JSONResponse({"items": [{"id": c["id"], "text": c["text"], "created_at": c["created_at"],
                                    "author": authors.get(c["author_id"]), "mine": c["author_id"] == v} for c in rows]})


@auth()
async def delete_comment(request: Request):
    u = request.state.user
    c = db.one("SELECT c.*, r.author_id AS reel_author FROM reel_comments c JOIN reels r ON r.id=c.reel_id WHERE c.id=?",
               (path_int(request),))
    if not c:
        raise ApiError(404, "Комментарий не найден")
    if u["id"] not in (c["author_id"], c["reel_author"]) and not u["is_admin"]:
        raise ApiError(403, "Нельзя удалить чужой комментарий")
    if u["id"] not in (c["author_id"], c["reel_author"]):
        from .. import modlog
        modlog.log(u["id"], "delete_reel_comment", "reel_comment", c["id"], c["author_id"], details={"text": modlog.snippet(c["text"])})
    db.run("DELETE FROM reel_comments WHERE id=?", (c["id"],))
    return ok()


routes = [
    Route("/api/reels", list_reels, methods=["GET"]),
    Route("/api/reels", create_reel, methods=["POST"]),
    Route("/api/reels/{id:int}", get_reel, methods=["GET"]),
    Route("/api/reels/{id:int}", delete_reel, methods=["DELETE"]),
    Route("/api/reels/{id:int}/like", like, methods=["POST", "DELETE"]),
    Route("/api/reels/{id:int}/view", view, methods=["POST"]),
    Route("/api/reels/{id:int}/comments", comments, methods=["GET", "POST"]),
    Route("/api/reel-comments/{id:int}", delete_comment, methods=["DELETE"]),
]
