"""Социальный граф и общие выборки: дружба, блокировки, видимость постов, уведомления."""
import json

from . import db
from .realtime import hub

FRIEND_IDS_SQL = """SELECT CASE WHEN requester_id = :v THEN addressee_id ELSE requester_id END
                    FROM friendships WHERE status = 'accepted' AND (requester_id = :v OR addressee_id = :v)"""


def is_friend_sql(other: str) -> str:
    return (f"EXISTS (SELECT 1 FROM friendships f WHERE f.status = 'accepted' "
            f"AND f.user_low = least(:v, {other}) AND f.user_high = greatest(:v, {other}))")


def not_blocked_sql(other: str) -> str:
    return (f"NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = :v AND b.blocked_id = {other}) "
            f"OR (b.blocker_id = {other} AND b.blocked_id = :v))")


def community_visible_sql(cid: str) -> str:
    """Сообщество открытое или зритель :v — его участник."""
    return (f"EXISTS (SELECT 1 FROM communities cx WHERE cx.id = {cid} AND (cx.is_private = 0 OR EXISTS ("
            f"SELECT 1 FROM community_members mx WHERE mx.community_id = cx.id AND mx.user_id = :v AND mx.status = 'member')))")


MY_COMMUNITIES_SQL = "SELECT community_id FROM community_members WHERE user_id = :v AND status = 'member'"


def visible_post_sql(p: str = "p", pr: str = "pr") -> str:
    """Условие «зритель :v может видеть пост p» (pr — профиль автора)."""
    friend = is_friend_sql(f"{p}.author_id")
    in_circle = (f"({p}.circle_id IS NULL OR EXISTS (SELECT 1 FROM circle_members ccm "
                 f"WHERE ccm.circle_id = {p}.circle_id AND ccm.user_id = :v))")
    return f"""({p}.author_id = :v OR ({not_blocked_sql(f"{p}.author_id")} AND (
        ({p}.community_id IS NOT NULL AND {community_visible_sql(f"{p}.community_id")})
        OR ({p}.community_id IS NULL AND (
            ({p}.visibility = 'public' AND ({pr}.profile_visibility = 'public' OR {friend}))
            OR ({p}.visibility = 'friends' AND {friend} AND {in_circle}))))))"""


def friend_ids(uid: int) -> list[int]:
    return [next(iter(r.values())) for r in db.all(FRIEND_IDS_SQL, {"v": uid})]


def are_friends(a: int, b: int) -> bool:
    return bool(db.value(
        "SELECT 1 FROM friendships WHERE status='accepted' AND user_low=least(?,?) AND user_high=greatest(?,?)",
        (a, b, a, b)))


def blocked_between(a: int, b: int) -> bool:
    return bool(db.value(
        "SELECT 1 FROM blocks WHERE (blocker_id=? AND blocked_id=?) OR (blocker_id=? AND blocked_id=?)",
        (a, b, b, a)))


# Официальные (подтверждённые) аккаунты: их немного, держим в памяти, обновляем раз в минуту и при изменении.
_verified: dict[int, str] = {}
_verified_at = 0.0


def verified_map() -> dict[int, str]:
    """{user_id: подпись} — подпись может быть пустой (просто «официальный аккаунт»)."""
    global _verified, _verified_at
    import time
    if time.monotonic() - _verified_at > 60:
        try:
            _verified = {r["user_id"]: r["badge"] or "" for r in db.all("SELECT user_id, badge FROM profiles WHERE verified=1")}
        except Exception:  # колонок ещё нет (миграция не применена) — просто без галочек
            _verified = {}
        _verified_at = time.monotonic()
    return _verified


def reset_verified_cache() -> None:
    global _verified_at, _invisible_at
    _verified_at = 0.0
    _invisible_at = 0.0


# «Режим невидимки»: такие люди не показываются «в сети» и без времени последнего визита
_invisible: set[int] = set()
_invisible_at = 0.0


def invisible_ids() -> set[int]:
    global _invisible, _invisible_at
    import time
    if time.monotonic() - _invisible_at > 60:
        try:
            _invisible = {r["user_id"] for r in db.all("SELECT user_id FROM profiles WHERE invisible=1")}
        except Exception:
            _invisible = set()
        _invisible_at = time.monotonic()
    return _invisible


def user_card(row: dict) -> dict:
    uid = row["id"] if "id" in row else row["user_id"]
    vmap = verified_map()
    return {
        "id": uid,
        "username": row["username"],
        "name": row["name"],
        "avatar": row.get("avatar"),
        "online": hub.is_online(uid) and uid not in invisible_ids(),
        "frame": _frame_of(row.get("equipped")),
        "status": status_of(row),
        "verified": uid in vmap,
        "badge": vmap.get(uid) or None,
    }


def status_of(row: dict) -> dict | None:
    """Статус-настроение пользователя, если он задан и не истёк."""
    if not row.get("status_emoji") and not row.get("status_text"):
        return None
    until = row.get("status_until")
    if until and until < db.now():
        return None
    return {"emoji": row.get("status_emoji") or "", "text": row.get("status_text") or "", "until": until}


def _frame_of(equipped) -> str | None:
    if not equipped:
        return None
    from .collection import parse_equipped
    return parse_equipped(equipped).get("frame")


def cards_by_ids(ids) -> dict[int, dict]:
    ids = list(set(ids))
    if not ids:
        return {}
    rows = db.all(f"SELECT user_id AS id, username, name, avatar, equipped, status_emoji, status_text, status_until FROM profiles WHERE user_id IN ({db.placeholders(ids)})", tuple(ids))
    return {r["id"]: user_card(r) for r in rows}


def relation(viewer: int, target: int) -> dict:
    if viewer == target:
        return {"status": "self", "following": False, "follows_you": False, "blocked_by_me": False, "blocked_me": False}
    fr = db.one("SELECT requester_id, status FROM friendships WHERE user_low=least(?,?) AND user_high=greatest(?,?)",
                (viewer, target, viewer, target))
    if not fr:
        status = "none"
    elif fr["status"] == "accepted":
        status = "friends"
    else:
        status = "request_sent" if fr["requester_id"] == viewer else "request_received"
    return {
        "status": status,
        "following": bool(db.value("SELECT 1 FROM follows WHERE follower_id=? AND followee_id=?", (viewer, target))),
        "follows_you": bool(db.value("SELECT 1 FROM follows WHERE follower_id=? AND followee_id=?", (target, viewer))),
        "blocked_by_me": bool(db.value("SELECT 1 FROM blocks WHERE blocker_id=? AND blocked_id=?", (viewer, target))),
        "blocked_me": bool(db.value("SELECT 1 FROM blocks WHERE blocker_id=? AND blocked_id=?", (target, viewer))),
    }


# ---------------------------- Уведомления ----------------------------
def notification_view(row: dict, actors: dict[int, dict] | None = None) -> dict:
    actor = (actors or {}).get(row["actor_id"]) or cards_by_ids([row["actor_id"]]).get(row["actor_id"])
    snippet = None
    if row.get("post_id"):
        p = db.one("SELECT text, is_repost, quote_of FROM posts WHERE id=?", (row["post_id"],))
        if p:
            snippet = (p["text"] or "")[:80]
    if row.get("comment_id"):
        c = db.one("SELECT text FROM comments WHERE id=?", (row["comment_id"],))
        if c:
            snippet = c["text"][:80]
    return {
        "id": row["id"],
        "type": row["type"],
        "actor": actor,
        "post_id": row.get("post_id"),
        "comment_id": row.get("comment_id"),
        "extra": json.loads(row["extra"]) if row.get("extra") else None,
        "snippet": snippet,
        "created_at": row["created_at"],
        "read": bool(row["read_at"]),
    }


def notification_views(rows: list[dict], v: int) -> list[dict]:
    """Уведомления страницей: цитаты записей, комментарии и авторы — несколькими запросами на всех."""
    if not rows:
        return []
    actors = cards_by_ids(r["actor_id"] for r in rows)
    pids = list({r["post_id"] for r in rows if r.get("post_id")})
    cids = list({r["comment_id"] for r in rows if r.get("comment_id")})
    posts = {p["id"]: (p["text"] or "")[:80] for p in db.all(
        f"SELECT id, text FROM posts WHERE id IN ({db.placeholders(pids)})", tuple(pids))} if pids else {}
    comments = {c["id"]: c["text"][:80] for c in db.all(
        f"SELECT id, text FROM comments WHERE id IN ({db.placeholders(cids)})", tuple(cids))} if cids else {}
    req_actors = [r["actor_id"] for r in rows if r["type"] == "friend_request"]
    pending = {r["requester_id"] for r in db.all(
        f"""SELECT requester_id FROM friendships WHERE status='pending' AND addressee_id=?
            AND requester_id IN ({db.placeholders(req_actors)})""", (v, *req_actors))} if req_actors else set()
    out = []
    for r in rows:
        snippet = comments.get(r.get("comment_id")) or posts.get(r.get("post_id"))
        view = {
            "id": r["id"], "type": r["type"],
            "actor": actors.get(r["actor_id"]) or {"id": r["actor_id"], "name": "Удалённый пользователь", "username": "", "avatar": None},
            "post_id": r.get("post_id"), "comment_id": r.get("comment_id"),
            "extra": json.loads(r["extra"]) if r.get("extra") else None,
            "snippet": snippet, "created_at": r["created_at"], "read": bool(r["read_at"]),
        }
        if r["type"] == "friend_request":
            view["pending"] = r["actor_id"] in pending
        out.append(view)
    return out


GROUPABLE = {"reaction": "post_id", "reel_like": "reel_id", "follow": None, "event_going": "event_id", "item": None}


def group_notifications(items: list[dict]) -> list[dict]:
    """«Анна и ещё 4 оценили вашу запись»: однотипные уведомления об одном и том же собираются в одно."""
    out, index = [], {}
    for n in items:
        field = GROUPABLE.get(n["type"], "-")
        if field == "-":
            out.append(n)
            continue
        target = n.get(field) if field == "post_id" else (n.get("extra") or {}).get(field) if field else "all"
        key = (n["type"], target, n["created_at"][:10])
        if key in index:
            g = index[key]
            g["count"] = g.get("count", 1) + 1
            if n["actor"]["id"] not in {a["id"] for a in [g["actor"], *g.get("others", [])]}:
                g.setdefault("others", []).append(n["actor"])
            g["read"] = g["read"] and n["read"]
            continue
        index[key] = n
        out.append(n)
    return out


def notify(user_id: int, actor_id: int, type_: str, post_id: int | None = None,
           comment_id: int | None = None, extra: dict | None = None) -> None:
    if user_id == actor_id or blocked_between(user_id, actor_id):
        return
    cur = db.run(
        "INSERT INTO notifications (user_id, actor_id, type, post_id, comment_id, extra) VALUES (?,?,?,?,?,?)",
        (user_id, actor_id, type_, post_id, comment_id, json.dumps(extra, ensure_ascii=False) if extra else None),
    )
    row = db.one("SELECT * FROM notifications WHERE id=?", (cur.lastrowid,))
    hub.publish(user_id, "notification", notification_view(row))
    push_counters(user_id)


def unnotify(user_id: int, actor_id: int, type_: str, post_id: int | None = None) -> None:
    cur = db.run("DELETE FROM notifications WHERE user_id=? AND actor_id=? AND type=? AND post_id IS ?",
                 (user_id, actor_id, type_, post_id))
    if cur.rowcount:
        push_counters(user_id)


def counters(uid: int) -> dict:
    extra = {}
    if db.value("SELECT is_admin FROM users WHERE id=?", (uid,)):
        extra["reports"] = db.value("SELECT count(DISTINCT target_type || ':' || target_id) FROM reports WHERE status='open'")
    return extra | {
        "notifications": db.value("SELECT count(*) FROM notifications WHERE user_id=? AND read_at IS NULL", (uid,)),
        "messages": db.value(
            """SELECT count(DISTINCT m.conversation_id) FROM conversation_members cm
               JOIN messages m ON m.conversation_id = cm.conversation_id
               WHERE cm.user_id = ? AND m.id > cm.last_read_id AND m.sender_id != ?""", (uid, uid)),
        "friend_requests": db.value(
            "SELECT count(*) FROM friendships WHERE addressee_id=? AND status='pending'", (uid,)),
        "guests": db.value(
            """SELECT count(*) FROM profile_visits v JOIN profiles p ON p.user_id = v.visited_id
               WHERE v.visited_id = ? AND v.visited_at > coalesce(p.guests_seen_at, '')""", (uid,)),
        "events": db.value(
            """SELECT count(*) FROM event_members em JOIN events e ON e.id = em.event_id
               WHERE em.user_id = ? AND em.status = 'invited' AND e.starts_at >= ?""", (uid, db.now())),
    }


def push_counters(uid: int) -> None:
    hub.publish(uid, "counters", counters(uid))
