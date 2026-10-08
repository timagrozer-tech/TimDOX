"""Исполнение действий персонажей: всё пишется в обычные таблицы Yarko, поэтому лента, уведомления и чат работают как есть."""
import json
import logging
import random

from .. import db, polls, social
from ..security import censor, clean_text
from . import core, texts

log = logging.getLogger("krug.world")


def publish_post(persona_id: int, text: str, community: str | None = None, poll: dict | None = None, at: str | None = None) -> int:
    from ..api.posts import _index_text
    text = censor(clean_text(text, 3000))
    cid = core.community_id(community) if community else None
    created = at or db.now()
    with db.tx() as c:
        pid = c.execute("""INSERT INTO posts (author_id, text, visibility, community_id, as_community, created_at)
                           VALUES (?,?, 'public', ?, ?, ?)""", (persona_id, text, cid, 1 if cid else 0, created)).lastrowid
        if poll and len(poll.get("options") or []) >= 2:
            polls.create(c, pid, {"question": clean_text(poll.get("question") or text[:200], 200),
                                  "options": [clean_text(str(o), 100) for o in poll["options"][:6]],
                                  "multiple": False, "days": int(poll.get("days") or 2)})
    _index_text(pid, persona_id, text, "public", notify_mentions=True)
    return pid


def comment(persona_id: int, post_id: int, text: str, at: str | None = None) -> int | None:
    post = db.one("SELECT id, author_id FROM posts WHERE id=?", (post_id,))
    if not post:
        return None
    cid = db.run("INSERT INTO comments (post_id, author_id, text, created_at) VALUES (?,?,?,?)",
                 (post_id, persona_id, censor(clean_text(text, 1000)), at or db.now())).lastrowid
    if not core.is_persona(post["author_id"]):
        social.notify(post["author_id"], persona_id, "comment", post_id=post_id, comment_id=cid)
    return cid


def react(persona_id: int, post_id: int, rtype: str = "like") -> None:
    author = db.value("SELECT author_id FROM posts WHERE id=?", (post_id,))
    if not author or db.value("SELECT 1 FROM reactions WHERE post_id=? AND user_id=?", (post_id, persona_id)):
        return
    db.run("INSERT OR IGNORE INTO reactions (post_id, user_id, type) VALUES (?,?,?)", (post_id, persona_id, rtype))
    if not core.is_persona(author):
        social.notify(author, persona_id, "reaction", post_id=post_id, extra={"reaction": rtype})


def support(persona_id: int, post_id: int, amount: int) -> bool:
    """Персонаж поддерживает автора монетами из своей недельной стипендии (и того, что поддержали его самого)."""
    from .. import economy
    post = db.one("SELECT id, author_id, is_repost FROM posts WHERE id=?", (post_id,))
    if not post or post["is_repost"]:
        return False
    try:
        economy.support_post(persona_id, post, amount, ai=True)
        return True
    except ValueError:
        return False  # не хватило монет или лимит дня — просто пропускаем


def dm(persona_id: int, user_id: int, text: str) -> bool:
    from ..api.messages import deliver_message, direct_conversation
    from ..web import ApiError
    try:
        conv = direct_conversation(persona_id, user_id)
    except ApiError:
        return False
    deliver_message(conv, persona_id, clean_text(text, 2000))
    return True


def accept_friend(persona_id: int, user_id: int) -> None:
    cur = db.run("""UPDATE friendships SET status='accepted', accepted_at=? WHERE requester_id=? AND addressee_id=? AND status='pending'""",
                 (db.now(), user_id, persona_id))
    if not cur.rowcount:
        return
    db.run("INSERT OR IGNORE INTO follows (follower_id, followee_id) VALUES (?,?)", (persona_id, user_id))
    db.run("INSERT OR IGNORE INTO follows (follower_id, followee_id) VALUES (?,?)", (user_id, persona_id))
    db.run("DELETE FROM notifications WHERE user_id=? AND actor_id=? AND type='friend_request'", (persona_id, user_id))
    social.notify(user_id, persona_id, "friend_accept")
    p = core.persona_by_id(persona_id) or {}
    name = (db.value("SELECT name FROM profiles WHERE user_id=?", (user_id,)) or "").split(" ")[0]
    dm(persona_id, user_id, random.choice(texts.GREET_FRIEND).format(name=name, me=p.get("name", ""), role=(p.get("role") or "").lower()))
    from .quests import remember
    remember(user_id, persona_id, "стали друзьями", closeness=5)


def create_event(persona_id: int, community: str | None, title: str, description: str, starts_at: str, hours: int = 2) -> int:
    from datetime import timedelta
    start = core.parse_ts(starts_at)
    return db.run("""INSERT INTO events (creator_id, community_id, title, description, place, starts_at, ends_at, visibility)
                     VALUES (?,?,?,?, 'Мир Yarko', ?, ?, 'public')""",
                  (persona_id, core.community_id(community) if community else None, title, description, starts_at,
                   core.iso(start + timedelta(hours=hours)))).lastrowid


def run_job(job: dict) -> None:
    """Выполняет одно задание очереди. Прошедшее время сохраняется, чтобы после «сна» сервера мир выглядел непрерывным."""
    p = json.loads(job["payload"] or "{}")
    pid, at = job["persona_id"], job["run_at"]
    db.run("UPDATE users SET last_seen_at=? WHERE id=?", (db.now(), pid))
    kind = job["kind"]
    if kind == "post":
        post_id = publish_post(pid, p["text"], p.get("community"), p.get("poll"), at)
        if random.random() < .55:  # коллеги иногда откликаются
            others = [x for x in core.personas().values() if x["user_id"] != pid]
            for other in random.sample(others, k=min(len(others), random.choice([1, 1, 2]))):
                core.schedule(other["user_id"], "comment", {"post_id": post_id, "text": random.choice(texts.BANTER)}, core.soon(8, 120))
            for other in random.sample(others, k=min(len(others), random.randint(1, 4))):
                core.schedule(other["user_id"], "react", {"post_id": post_id}, core.soon(1, 90))
    elif kind == "comment":
        comment(pid, p["post_id"], p["text"], at)
    elif kind == "react":
        react(pid, p["post_id"], p.get("type", "like"))
    elif kind == "support":
        support(pid, p["post_id"], int(p.get("amount") or 10))
    elif kind == "dm":
        dm(pid, p["user_id"], p["text"])
    elif kind == "accept_friend":
        accept_friend(pid, p["user_id"])
    else:
        log.warning("Неизвестное действие мира: %s", kind)
