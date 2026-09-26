"""Социальный граф и общие выборки: дружба, блокировки, видимость постов, уведомления."""
import json

from . import db
from .realtime import hub

FRIEND_IDS_SQL = """SELECT CASE WHEN requester_id = :v THEN addressee_id ELSE requester_id END
                    FROM friendships WHERE status = 'accepted' AND (requester_id = :v OR addressee_id = :v)"""


def is_friend_sql(other: str) -> str:
    return (f"EXISTS (SELECT 1 FROM friendships f WHERE f.status = 'accepted' "
            f"AND f.user_low = min(:v, {other}) AND f.user_high = max(:v, {other}))")


def not_blocked_sql(other: str) -> str:
    return (f"NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = :v AND b.blocked_id = {other}) "
            f"OR (b.blocker_id = {other} AND b.blocked_id = :v))")


def visible_post_sql(p: str = "p", pr: str = "pr") -> str:
    """Условие «зритель :v может видеть пост p» (pr — профиль автора)."""
    friend = is_friend_sql(f"{p}.author_id")
    return f"""({p}.author_id = :v OR ({not_blocked_sql(f"{p}.author_id")} AND (
        ({p}.visibility = 'public' AND ({pr}.profile_visibility = 'public' OR {friend}))
        OR ({p}.visibility = 'friends' AND {friend}))))"""


def friend_ids(uid: int) -> list[int]:
    return [next(iter(r.values())) for r in db.all(FRIEND_IDS_SQL, {"v": uid})]


def are_friends(a: int, b: int) -> bool:
    return bool(db.value(
        "SELECT 1 FROM friendships WHERE status='accepted' AND user_low=min(?,?) AND user_high=max(?,?)",
        (a, b, a, b)))


def blocked_between(a: int, b: int) -> bool:
    return bool(db.value(
        "SELECT 1 FROM blocks WHERE (blocker_id=? AND blocked_id=?) OR (blocker_id=? AND blocked_id=?)",
        (a, b, b, a)))


def user_card(row: dict) -> dict:
    return {
        "id": row["id"] if "id" in row else row["user_id"],
        "username": row["username"],
        "name": row["name"],
        "avatar": row.get("avatar"),
        "online": hub.is_online(row["id"] if "id" in row else row["user_id"]),
    }


def cards_by_ids(ids) -> dict[int, dict]:
    ids = list(set(ids))
    if not ids:
        return {}
    rows = db.all(f"SELECT user_id AS id, username, name, avatar FROM profiles WHERE user_id IN ({db.placeholders(ids)})", tuple(ids))
    return {r["id"]: user_card(r) for r in rows}


def relation(viewer: int, target: int) -> dict:
    if viewer == target:
        return {"status": "self", "following": False, "follows_you": False, "blocked_by_me": False, "blocked_me": False}
    fr = db.one("SELECT requester_id, status FROM friendships WHERE user_low=min(?,?) AND user_high=max(?,?)",
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
    return {
        "notifications": db.value("SELECT count(*) FROM notifications WHERE user_id=? AND read_at IS NULL", (uid,)),
        "messages": db.value(
            """SELECT count(DISTINCT m.conversation_id) FROM conversation_members cm
               JOIN messages m ON m.conversation_id = cm.conversation_id
               WHERE cm.user_id = ? AND m.id > cm.last_read_id AND m.sender_id != ?""", (uid, uid)),
        "friend_requests": db.value(
            "SELECT count(*) FROM friendships WHERE addressee_id=? AND status='pending'", (uid,)),
    }


def push_counters(uid: int) -> None:
    hub.publish(uid, "counters", counters(uid))
