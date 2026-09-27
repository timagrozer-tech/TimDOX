"""Личная статистика аккаунта: отклик на записи, рост аудитории, лучшее время для публикаций.
Видна только владельцу страницы."""
from collections import Counter
from datetime import datetime, timedelta, timezone

from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from .. import db, social
from ..web import ApiError, auth, limit

MSK = timezone(timedelta(hours=3))
PERIODS = {7, 30, 90, 365, 0}  # 0 — за всё время
REACTIONS = ["like", "love", "haha", "wow", "sad", "angry"]
CAP = 50000  # защита от слишком тяжёлых выборок


def _ts(s: str) -> datetime | None:
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(MSK)
    except (AttributeError, ValueError):
        return None


def _received(v: int, since: str) -> dict[str, list[dict]]:
    """Всё, что другие люди сделали с моими записями, профилем и клипами с даты since."""
    p = {"v": v, "since": since}
    return {
        "reactions": db.all(f"""SELECT r.type, r.user_id AS uid, r.created_at AS at FROM reactions r
                               JOIN posts p ON p.id = r.post_id
                               WHERE p.author_id = :v AND r.user_id != :v AND r.created_at >= :since LIMIT {CAP}""", p),
        "comments": db.all(f"""SELECT c.author_id AS uid, c.created_at AS at FROM comments c
                              JOIN posts p ON p.id = c.post_id
                              WHERE p.author_id = :v AND c.author_id != :v AND c.created_at >= :since LIMIT {CAP}""", p),
        "reposts": db.all(f"""SELECT q.author_id AS uid, q.created_at AS at FROM posts q
                             JOIN posts p ON p.id = q.quote_of
                             WHERE p.author_id = :v AND q.author_id != :v AND q.created_at >= :since LIMIT {CAP}""", p),
        "followers": db.all(f"""SELECT follower_id AS uid, created_at AS at FROM follows
                               WHERE followee_id = :v AND created_at >= :since LIMIT {CAP}""", p),
        "posts": db.all(f"""SELECT id, created_at AS at FROM posts
                           WHERE author_id = :v AND is_repost = 0 AND created_at >= :since LIMIT {CAP}""", p),
    }


def _count(sql: str, p: dict) -> int:
    return int(db.value(sql, p) or 0)


def _totals(v: int, since: str, until: str | None = None) -> dict[str, int]:
    """Сводные числа за период [since, until)."""
    p = {"v": v, "since": since, "until": until or "9999"}
    def rng(a: str = "") -> str:
        return f"{a}created_at >= :since AND {a}created_at < :until"
    return {
        "posts": _count(f"SELECT count(*) FROM posts WHERE author_id = :v AND is_repost = 0 AND {rng()}", p),
        "reactions": _count(f"""SELECT count(*) FROM reactions r JOIN posts p ON p.id = r.post_id
                               WHERE p.author_id = :v AND r.user_id != :v AND {rng('r.')}""", p),
        "comments": _count(f"""SELECT count(*) FROM comments c JOIN posts p ON p.id = c.post_id
                              WHERE p.author_id = :v AND c.author_id != :v AND {rng('c.')}""", p),
        "reposts": _count(f"""SELECT count(*) FROM posts q JOIN posts p ON p.id = q.quote_of
                             WHERE p.author_id = :v AND q.author_id != :v AND {rng('q.')}""", p),
        "saves": _count(f"""SELECT count(*) FROM bookmarks b JOIN posts p ON p.id = b.post_id
                           WHERE p.author_id = :v AND b.user_id != :v AND {rng('b.')}""", p),
        "followers": _count(f"SELECT count(*) FROM follows WHERE followee_id = :v AND {rng()}", p),
        "friends": _count("""SELECT count(*) FROM friendships WHERE (requester_id = :v OR addressee_id = :v)
                             AND status = 'accepted' AND accepted_at >= :since AND accepted_at < :until""", p),
        "story_views": _count("""SELECT count(*) FROM story_views sv JOIN stories s ON s.id = sv.story_id
                                 WHERE s.author_id = :v AND sv.viewer_id != :v
                                   AND sv.viewed_at >= :since AND sv.viewed_at < :until""", p),
        "reel_likes": _count(f"""SELECT count(*) FROM reel_likes l JOIN reels r ON r.id = l.reel_id
                                WHERE r.author_id = :v AND l.user_id != :v AND {rng('l.')}""", p),
    }


def _buckets(days: int, start: datetime, end: datetime) -> tuple[str, list[datetime]]:
    """Шаг графика: дни для коротких периодов, недели для года, месяцы для «всего времени»."""
    if days and days <= 90:
        first = start.replace(hour=0, minute=0, second=0, microsecond=0)
        return "day", [first + timedelta(days=i) for i in range((end.date() - first.date()).days + 1)]
    if days == 365 or (end - start).days <= 400:
        first = (start - timedelta(days=start.weekday())).replace(hour=0, minute=0, second=0, microsecond=0)
        out, d = [], first
        while d <= end:
            out.append(d)
            d += timedelta(days=7)
        return "week", out
    out, d = [], start.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    while d <= end:
        out.append(d)
        d = (d.replace(day=28) + timedelta(days=4)).replace(day=1)
    return "month", out


def _key(step: str, t: datetime) -> str:
    if step == "day":
        return t.strftime("%Y-%m-%d")
    if step == "week":
        return (t - timedelta(days=t.weekday())).strftime("%Y-%m-%d")
    return t.strftime("%Y-%m")


def _top_posts(v: int, since: str) -> list[dict]:
    rows = db.all("""SELECT p.id, p.text, p.created_at,
                            (SELECT count(*) FROM reactions r WHERE r.post_id = p.id AND r.user_id != :v) AS reactions,
                            (SELECT count(*) FROM comments c WHERE c.post_id = p.id AND c.author_id != :v) AS comments,
                            (SELECT count(*) FROM posts q WHERE q.quote_of = p.id AND q.author_id != :v) AS reposts,
                            (SELECT count(*) FROM bookmarks b WHERE b.post_id = p.id AND b.user_id != :v) AS saves
                     FROM posts p WHERE p.author_id = :v AND p.is_repost = 0 AND p.created_at >= :since
                     ORDER BY p.id DESC LIMIT 300""", {"v": v, "since": since})
    for r in rows:
        r["score"] = r["reactions"] + 2 * r["comments"] + 3 * r["reposts"] + 2 * r["saves"]
    rows = [r for r in sorted(rows, key=lambda r: (-r["score"], -r["id"])) if r["score"] > 0][:5]
    if rows:
        ids = [r["id"] for r in rows]
        media = {}
        for m in db.all(f"SELECT post_id, thumb FROM post_media WHERE post_id IN ({db.placeholders(ids)}) ORDER BY position", ids):
            media.setdefault(m["post_id"], m["thumb"])
        for r in rows:
            r["thumb"] = media.get(r["id"])
            r["text"] = (r["text"] or "").strip()[:140]
    return rows


@auth()
async def my_stats(request: Request):
    v = request.state.user["id"]
    limit(request, "stats")
    try:
        days = int(request.query_params.get("days", "30"))
    except ValueError:
        raise ApiError(400, "Некорректный период")
    if days not in PERIODS:
        raise ApiError(400, "Некорректный период")

    joined = db.value("SELECT created_at FROM users WHERE id = ?", (v,)) or db.now()
    since = db.future(days=-days) if days else joined
    now = datetime.now(MSK)
    start = _ts(since) or now

    rec = _received(v, since)
    totals = _totals(v, since)
    # сравнение с предыдущим таким же периодом — только если аккаунт тогда уже существовал
    prev = _totals(v, db.future(days=-2 * days), since) if days and joined < since else None

    # отклик по дням / неделям / месяцам
    step, grid = _buckets(days, start, now)
    series = {_key(step, d): {"reactions": 0, "comments": 0, "reposts": 0, "followers": 0, "posts": 0} for d in grid}
    hours, weekdays = [0] * 24, [0] * 7
    fans = Counter()
    for kind in ("reactions", "comments", "reposts", "followers", "posts"):
        for r in rec[kind]:
            t = _ts(r["at"])
            if not t:
                continue
            k = _key(step, t)
            if k in series:
                series[k][kind] += 1
            if kind in ("reactions", "comments", "reposts"):
                hours[t.hour] += 1
                weekdays[t.weekday()] += 1
                fans[r["uid"]] += 2 if kind == "comments" else (3 if kind == "reposts" else 1)
    timeline = [{"key": k, **val} for k, val in series.items()]

    by_type = Counter(r["type"] for r in rec["reactions"])
    cards = social.cards_by_ids([uid for uid, _ in fans.most_common(8)])
    fan_list = [{**cards[uid], "score": n} for uid, n in fans.most_common(8) if uid in cards][:6]

    reels = db.one("""SELECT count(*) AS n, coalesce(sum(views), 0) AS views,
                             coalesce(sum((SELECT count(*) FROM reel_likes l WHERE l.reel_id = r.id)), 0) AS likes,
                             coalesce(sum((SELECT count(*) FROM reel_comments c WHERE c.reel_id = r.id)), 0) AS comments
                      FROM reels r WHERE r.author_id = ?""", (v,)) or {}
    overall = {
        "posts": _count("SELECT count(*) FROM posts WHERE author_id = :v AND is_repost = 0", {"v": v}),
        "followers": _count("SELECT count(*) FROM follows WHERE followee_id = :v", {"v": v}),
        "following": _count("SELECT count(*) FROM follows WHERE follower_id = :v", {"v": v}),
        "friends": len(social.friend_ids(v)),
        "reactions": _count("""SELECT count(*) FROM reactions r JOIN posts p ON p.id = r.post_id
                               WHERE p.author_id = :v AND r.user_id != :v""", {"v": v}),
        "guests_30": _count("SELECT count(*) FROM profile_visits WHERE visited_id = :v AND visited_at >= :s",
                            {"v": v, "s": db.future(days=-30)}),
        "days_on_krug": max(1, (now - (_ts(joined) or now)).days + 1),
        "reels": {k: int(reels.get(k) or 0) for k in ("n", "views", "likes", "comments")},
    }
    engaged = totals["reactions"] + totals["comments"] + totals["reposts"]
    return JSONResponse({
        "days": days,
        "since": since,
        "step": step,
        "totals": totals,
        "prev": prev,
        "per_post": round(engaged / totals["posts"], 1) if totals["posts"] else None,
        "timeline": timeline,
        "reactions_by_type": {t: by_type.get(t, 0) for t in REACTIONS},
        "hours": hours,
        "weekdays": weekdays,
        "top_posts": _top_posts(v, since),
        "fans": fan_list,
        "overall": overall,
    })


routes = [Route("/api/me/stats", my_stats, methods=["GET"])]
