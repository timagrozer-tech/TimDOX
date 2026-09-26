"""Истории на 24 часа: фото или текст на цветном фоне, просмотры, ответы в личные сообщения."""
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from .. import config, db, media, social
from ..security import censor, clean_text
from ..social import is_friend_sql, not_blocked_sql
from ..web import ApiError, auth, body, limit, ok, path_int

BACKGROUNDS = ("blue", "orange", "green", "purple", "pink", "dark")
STORY_HOURS = 24


def _visible_sql() -> str:
    """Историю s автора с профилем pr видит зритель :v."""
    friend = is_friend_sql("s.author_id")
    return f"""(s.author_id = :v OR ({not_blocked_sql("s.author_id")} AND (
        (s.visibility = 'public' AND (pr.profile_visibility = 'public' OR {friend}))
        OR (s.visibility = 'friends' AND {friend}))))"""


def _story_view(s: dict, seen: set[int]) -> dict:
    return {"id": s["id"], "media": s["media"], "text": s["text"], "background": s["background"],
            "visibility": s["visibility"], "created_at": s["created_at"], "expires_at": s["expires_at"],
            "seen": s["id"] in seen}


def _get_visible(story_id: int, v: int) -> dict:
    row = db.one(f"""SELECT s.* FROM stories s JOIN profiles pr ON pr.user_id = s.author_id
                     WHERE s.id = :id AND s.expires_at > :now AND {_visible_sql()}""",
                 {"id": story_id, "v": v, "now": db.now()})
    if not row:
        raise ApiError(404, "История недоступна или истекла")
    return row


@auth()
async def stories_feed(request: Request):
    """Истории друзей и подписок, сгруппированные по авторам. Свои — первыми."""
    v = request.state.user["id"]
    rows = db.all(f"""
        SELECT s.* FROM stories s JOIN profiles pr ON pr.user_id = s.author_id
        WHERE s.expires_at > :now
          AND (s.author_id = :v OR s.author_id IN ({social.FRIEND_IDS_SQL})
               OR s.author_id IN (SELECT followee_id FROM follows WHERE follower_id = :v))
          AND {_visible_sql()}
        ORDER BY s.id""", {"v": v, "now": db.now()})
    seen = {r["story_id"] for r in db.all(
        f"SELECT story_id FROM story_views WHERE viewer_id=? AND story_id IN ({db.placeholders([r['id'] for r in rows])})",
        (v, *[r["id"] for r in rows]))} if rows else set()
    groups: dict[int, list] = {}
    for r in rows:
        groups.setdefault(r["author_id"], []).append(r)
    cards = social.cards_by_ids(groups.keys())
    out = []
    for uid, items in groups.items():
        stories = [_story_view(s, seen) for s in items]
        out.append({"user": cards[uid], "stories": stories, "is_me": uid == v,
                    "has_unseen": any(not s["seen"] for s in stories) and uid != v,
                    "latest": items[-1]["created_at"]})
    out.sort(key=lambda g: g["latest"], reverse=True)          # сначала свежие…
    out.sort(key=lambda g: (not g["is_me"], not g["has_unseen"]))  # …свои и непросмотренные — впереди
    return JSONResponse({"groups": out})


@auth(require_verified=True)
async def create_story(request: Request):
    limit(request, "write")
    v = request.state.user["id"]
    form = await request.form(max_files=1, max_fields=10, max_part_size=16 * 1024)
    try:
        text = censor(clean_text(form.get("text"), 300))
        background = form.get("background") or "blue"
        if background not in BACKGROUNDS:
            background = "blue"
        visibility = form.get("visibility") or "friends"
        if visibility not in ("public", "friends"):
            raise ApiError(400, "Неизвестная настройка видимости")
        photo = form.get("photo")
        saved = None
        if getattr(photo, "filename", None):
            limit(request, "upload")
            saved = await media.save_upload(photo, "story")
        if not saved and not text:
            raise ApiError(400, "Добавьте фото или текст")
    finally:
        await form.close()
    sid = db.run("""INSERT INTO stories (author_id, media, thumb, text, background, visibility, expires_at)
                    VALUES (?,?,?,?,?,?,?)""",
                 (v, saved["path"] if saved else None, saved["thumb"] if saved else None, text, background,
                  visibility, db.future(hours=STORY_HOURS))).lastrowid
    return JSONResponse(_story_view(db.one("SELECT * FROM stories WHERE id=?", (sid,)), set()), status_code=201)


@auth()
async def view_story(request: Request):
    v = request.state.user["id"]
    s = _get_visible(path_int(request), v)
    if s["author_id"] != v:
        db.run("INSERT OR IGNORE INTO story_views (story_id, viewer_id) VALUES (?,?)", (s["id"], v))
    return ok()


@auth()
async def viewers(request: Request):
    v = request.state.user["id"]
    s = db.one("SELECT * FROM stories WHERE id=? AND author_id=?", (path_int(request), v))
    if not s:
        raise ApiError(404, "История не найдена")
    rows = db.all("""SELECT p.user_id AS id, p.username, p.name, p.avatar, sv.viewed_at FROM story_views sv
                     JOIN profiles p ON p.user_id = sv.viewer_id WHERE sv.story_id=? ORDER BY sv.viewed_at DESC""", (s["id"],))
    return JSONResponse({"items": [{**social.user_card(r), "viewed_at": r["viewed_at"]} for r in rows], "total": len(rows)})


@auth()
async def delete_story(request: Request):
    v = request.state.user["id"]
    s = db.one("SELECT * FROM stories WHERE id=? AND author_id=?", (path_int(request), v))
    if not s:
        raise ApiError(404, "История не найдена")
    media.delete_files(s["media"])
    db.run("DELETE FROM stories WHERE id=?", (s["id"],))
    return ok()


@auth(require_verified=True)
async def reply_story(request: Request):
    """Ответ на историю уходит автору в личные сообщения."""
    limit(request, "message")
    v = request.state.user["id"]
    s = _get_visible(path_int(request), v)
    if s["author_id"] == v:
        raise ApiError(400, "Нельзя ответить на свою историю")
    data = await body(request)
    text = censor(clean_text(data.get("text"), config.MESSAGE_MAX_LEN))
    if not text:
        raise ApiError(400, "Пустое сообщение")
    from .messages import deliver_message, direct_conversation
    conv = direct_conversation(v, s["author_id"])
    preview = s["text"][:60] if s["text"] else "фото"
    msg = deliver_message(conv, v, f"Ответ на историю «{preview}»:\n{text}", kind="story_reply")
    return JSONResponse({"conversation_id": conv, "message": msg}, status_code=201)


def cleanup_expired() -> int:
    """Удаляет истёкшие истории вместе с файлами. Вызывается по расписанию."""
    rows = db.all("SELECT id, media FROM stories WHERE expires_at <= ?", (db.now(),))
    for r in rows:
        media.delete_files(r["media"])
    if rows:
        db.run(f"DELETE FROM stories WHERE id IN ({db.placeholders(rows)})", tuple(r["id"] for r in rows))
    return len(rows)


routes = [
    Route("/api/stories", stories_feed, methods=["GET"]),
    Route("/api/stories", create_story, methods=["POST"]),
    Route("/api/stories/{id:int}", delete_story, methods=["DELETE"]),
    Route("/api/stories/{id:int}/view", view_story, methods=["POST"]),
    Route("/api/stories/{id:int}/viewers", viewers, methods=["GET"]),
    Route("/api/stories/{id:int}/reply", reply_story, methods=["POST"]),
]
