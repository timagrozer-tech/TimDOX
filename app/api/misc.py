"""Уведомления, счётчики и поиск."""
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from .. import db, social
from ..social import is_friend_sql, not_blocked_sql, visible_post_sql
from ..web import ApiError, auth, int_param, ok
from .posts import hydrate


@auth()
async def notifications(request: Request):
    v = request.state.user["id"]
    cursor = int_param(request, "cursor", 2**62)
    rows = db.all("SELECT * FROM notifications WHERE user_id=? AND id<? ORDER BY id DESC LIMIT 31", (v, cursor))
    actors = social.cards_by_ids(r["actor_id"] for r in rows)
    items = [social.notification_view(r, actors) for r in rows[:30]]
    return JSONResponse({"items": items, "next_cursor": rows[29]["id"] if len(rows) > 30 else None})


@auth()
async def notifications_read(request: Request):
    v = request.state.user["id"]
    db.run("UPDATE notifications SET read_at=? WHERE user_id=? AND read_at IS NULL", (db.now(), v))
    social.push_counters(v)
    return ok()


@auth()
async def counters(request: Request):
    return JSONResponse(social.counters(request.state.user["id"]))


def _like(q: str) -> str:
    return "%" + q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"


@auth()
async def search(request: Request):
    v = request.state.user["id"]
    q = (request.query_params.get("q") or "").strip()[:100]
    kind = request.query_params.get("type", "all")
    if kind not in ("all", "people", "posts", "tags", "communities"):
        raise ApiError(400, "Неизвестный тип поиска")
    if not q:
        return JSONResponse({"people": [], "posts": [], "tags": [], "communities": []})
    result = {"people": [], "posts": [], "tags": [], "communities": []}
    term = q.lstrip("@#")
    like = _like(term.lower())
    params = {"v": v, "like": like, "exact": term.lower()}

    if kind in ("all", "people") and term:
        rows = db.all(f"""
            SELECT p.user_id AS id, p.username, p.name, p.avatar, p.city,
                   (p.user_id = :v OR p.profile_visibility = 'public' OR {is_friend_sql('p.user_id')}) AS open_profile
            FROM profiles p
            WHERE (ulower(p.name) LIKE :like ESCAPE '\\' OR ulower(p.username) LIKE :like ESCAPE '\\'
                   OR ((p.profile_visibility = 'public' OR {is_friend_sql('p.user_id')})
                       AND (ulower(p.city) LIKE :like ESCAPE '\\' OR ulower(p.work) LIKE :like ESCAPE '\\'
                            OR ulower(p.education) LIKE :like ESCAPE '\\')))
              AND {not_blocked_sql('p.user_id')}
            ORDER BY (ulower(p.username) = :exact) DESC, (ulower(p.name) LIKE :exact || '%') DESC, p.name
            LIMIT {20 if kind == 'people' else 6}""", params)
        friends = set(social.friend_ids(v))
        for r in rows:
            c = social.user_card(r)
            c["city"] = r["city"] if r["open_profile"] else ""  # город закрытого профиля видят только друзья
            c["is_friend"] = r["id"] in friends
            c["is_me"] = r["id"] == v
            result["people"].append(c)

    if kind in ("all", "tags") and term:
        result["tags"] = db.all("""
            SELECT h.tag, count(ph.post_id) AS n FROM hashtags h LEFT JOIN post_hashtags ph ON ph.hashtag_id = h.id
            WHERE h.tag LIKE :like ESCAPE '\\' GROUP BY h.id ORDER BY (h.tag = :exact) DESC, n DESC
            LIMIT 10""", params)

    if kind in ("all", "communities") and term:
        rows = db.all(f"""SELECT c.*, (SELECT count(*) FROM community_members m WHERE m.community_id = c.id AND m.status='member') AS n
                          FROM communities c WHERE ulower(c.name) LIKE :like ESCAPE '\\' OR ulower(c.description) LIKE :like ESCAPE '\\'
                          OR c.slug LIKE :like ESCAPE '\\' ORDER BY n DESC LIMIT {20 if kind == 'communities' else 5}""", params)
        result["communities"] = [{"id": r["id"], "slug": r["slug"], "name": r["name"], "avatar": r["avatar"],
                                  "is_private": bool(r["is_private"]), "members_count": r["n"]} for r in rows]

    if kind in ("all", "posts") and term:
        rows = db.all(f"""
            SELECT p.* FROM posts p JOIN profiles pr ON pr.user_id = p.author_id
            WHERE p.is_repost = 0 AND ulower(p.text) LIKE :like ESCAPE '\\' AND {visible_post_sql()}
            ORDER BY p.id DESC LIMIT {30 if kind == 'posts' else 10}""", params)
        result["posts"] = hydrate(rows, v)
    return JSONResponse(result)


routes = [
    Route("/api/notifications", notifications, methods=["GET"]),
    Route("/api/notifications/read", notifications_read, methods=["POST"]),
    Route("/api/counters", counters, methods=["GET"]),
    Route("/api/search", search, methods=["GET"]),
]
