"""Задания организаций, репутация, звания и память персонажей о пользователе. Проверка — обычными SQL-счётчиками."""
import json
import random
import time

from .. import db
from . import core, texts

_last_check: dict[int, float] = {}

STARTER = [
    # code, org, persona, title, description, rule, reward, secret
    ("start-council", "council", "mira_sovet", "Знакомство с Yarko", "Подпишитесь на председателя Совета Миру Светлову.",
     {"type": "follow_persona", "persona": "mira_sovet"}, 10, 0),
    ("start-academy", "academy", "vera_uchit", "Первый урок", "Вступите в сообщество «Академия знаний».",
     {"type": "join_community", "community": "akademiya"}, 10, 0),
    ("start-archivists", "archivists", "orest_arhiv", "Летописец", "Опубликуйте запись с тегом #летописькруга — она попадёт в летопись.",
     {"type": "post_tag", "tag": "летописькруга"}, 15, 0),
    ("start-explorers", "explorers", "kapitan_vega", "В экипаже", "Добавьте Капитана Вегу в друзья.",
     {"type": "friend_persona", "persona": "kapitan_vega"}, 15, 0),
    ("start-techunion", "techunion", "neira", "Разговор с ИИ", "Напишите личное сообщение Нейре.",
     {"type": "chat_persona", "persona": "neira"}, 10, 0),
    ("start-gameleague", "gameleague", "kira_gg", "Голос игрока", "Проголосуйте в любом опросе Игровой лиги.",
     {"type": "poll_vote", "org": "gameleague"}, 10, 0),
    ("start-media", "media", "timur_efir", "Зритель эфира", "Поставьте реакцию на 3 записи Медиацентра.",
     {"type": "react_org", "org": "media", "count": 3}, 10, 0),
    ("secret-archive", "archivists", "orest_arhiv", "Три тайные строки",
     "Архивариусы доверяют вам тайну: опубликуйте запись с тегом #тайныйархив и расскажите, что бы вы спрятали в архиве Yarko.",
     {"type": "post_tag", "tag": "тайныйархив", "unlock_rep": 30}, 40, 1),
    ("secret-explorers", "explorers", "kapitan_vega", "Сигнал из глубины",
     "Только для экипажа: напишите Капитану Веге слово «горизонт».",
     {"type": "chat_word", "persona": "kapitan_vega", "word": "горизонт", "unlock_rep": 30}, 40, 1),
]


def ensure_starter() -> None:
    for code, org, persona, title, desc, rule, reward, secret in STARTER:
        if db.value("SELECT 1 FROM ai_quests WHERE code=?", (code,)):
            continue
        o = core.orgs().get(org)
        p = core.personas().get(persona)
        db.run("""INSERT INTO ai_quests (code, org_id, persona_id, title, description, rule, reward, secret, starts_at)
                  VALUES (?,?,?,?,?,?,?,?,?)""", (code, o and o["id"], p and p["user_id"], title, desc,
                                                  json.dumps(rule, ensure_ascii=False), reward, secret, "2020-01-01T00:00:00.000Z"))


def add_quest(code: str, org: str, persona: str, title: str, desc: str, rule: dict, reward: int, ends_at: str | None) -> None:
    if db.value("SELECT 1 FROM ai_quests WHERE code=?", (code,)):
        return
    o = core.orgs().get(org)
    p = core.personas().get(persona)
    db.run("""INSERT INTO ai_quests (code, org_id, persona_id, title, description, rule, reward, starts_at, ends_at)
              VALUES (?,?,?,?,?,?,?,?,?)""", (code, o and o["id"], p and p["user_id"], title, desc,
                                              json.dumps(rule, ensure_ascii=False), reward, db.now(), ends_at))


# ---------------------------------------------------------------- проверка правил
def _org_author_ids(org: str) -> list[int]:
    return [p["user_id"] for p in core.org_personas(org)] or [0]


def progress(uid: int, q: dict) -> tuple[int, int]:
    """(сделано, нужно)"""
    r = json.loads(q["rule"] or "{}")
    t, need, since = r.get("type"), int(r.get("count", 1)), q["starts_at"]
    pers = core.personas().get(r.get("persona", ""), {})
    pid = pers.get("user_id", 0)
    if t == "post_tag":
        n = db.value("SELECT count(*) FROM posts WHERE author_id=? AND created_at>=? AND lower(text) LIKE ?",
                     (uid, since, f"%#{r['tag'].lower()}%"))
    elif t == "join_community":
        n = db.value("""SELECT count(*) FROM community_members m JOIN communities c ON c.id=m.community_id
                        WHERE m.user_id=? AND c.slug=? AND m.status='member'""", (uid, r["community"]))
    elif t == "follow_persona":
        n = db.value("SELECT count(*) FROM follows WHERE follower_id=? AND followee_id=?", (uid, pid))
    elif t == "friend_persona":
        n = db.value("""SELECT count(*) FROM friendships WHERE status='accepted' AND
                        ((requester_id=? AND addressee_id=?) OR (requester_id=? AND addressee_id=?))""", (uid, pid, pid, uid))
    elif t == "chat_persona":
        n = db.value(f"""SELECT count(*) FROM messages m WHERE m.sender_id=? AND m.created_at>=? AND m.conversation_id IN
                         (SELECT conversation_id FROM conversation_members WHERE user_id=?)""", (uid, since, pid))
    elif t == "chat_word":
        n = db.value(f"""SELECT count(*) FROM messages m WHERE m.sender_id=? AND lower(m.text) LIKE ? AND m.conversation_id IN
                         (SELECT conversation_id FROM conversation_members WHERE user_id=?)""", (uid, f"%{r['word']}%", pid))
    elif t == "poll_vote":
        ids = _org_author_ids(r["org"])
        n = db.value(f"""SELECT count(DISTINCT v.poll_id) FROM poll_votes v JOIN polls pl ON pl.id=v.poll_id JOIN posts p ON p.id=pl.post_id
                         WHERE v.user_id=? AND v.created_at>=? AND p.author_id IN ({db.placeholders(ids)})""", (uid, since, *ids))
    elif t == "react_org":
        ids = _org_author_ids(r["org"])
        n = db.value(f"""SELECT count(*) FROM reactions x JOIN posts p ON p.id=x.post_id
                         WHERE x.user_id=? AND x.created_at>=? AND p.author_id IN ({db.placeholders(ids)})""", (uid, since, *ids))
    elif t == "event_going":
        n = db.value("SELECT count(*) FROM event_members WHERE event_id=? AND user_id=? AND status='going'", (r["event_id"], uid))
    elif t == "comment_org":
        ids = _org_author_ids(r["org"])
        n = db.value(f"""SELECT count(*) FROM comments c JOIN posts p ON p.id=c.post_id
                         WHERE c.author_id=? AND c.created_at>=? AND p.author_id IN ({db.placeholders(ids)})""", (uid, since, *ids))
    else:
        n = 0
    return min(int(n or 0), need), need


def rep(uid: int, org_id: int) -> int:
    return db.value("SELECT points FROM ai_rep WHERE user_id=? AND org_id=?", (uid, org_id)) or 0


def unlocked(uid: int, q: dict) -> bool:
    need = json.loads(q["rule"] or "{}").get("unlock_rep")
    return not need or rep(uid, q["org_id"]) >= need


def active_quests() -> list[dict]:
    now = db.now()
    return db.all("SELECT * FROM ai_quests WHERE starts_at<=? AND (ends_at IS NULL OR ends_at>?) ORDER BY secret, id DESC", (now, now))


def remember(uid: int, persona_id: int, fact: str | None = None, closeness: int = 1) -> None:
    row = db.one("SELECT facts, closeness FROM ai_memory WHERE user_id=? AND persona_id=?", (uid, persona_id))
    facts = json.loads(row["facts"]) if row else []
    if fact and fact not in facts:
        facts = (facts + [fact])[-10:]
    if row:
        db.run("UPDATE ai_memory SET facts=?, closeness=?, last_at=? WHERE user_id=? AND persona_id=?",
               (json.dumps(facts, ensure_ascii=False), row["closeness"] + closeness, db.now(), uid, persona_id))
    else:
        db.run("INSERT OR IGNORE INTO ai_memory (user_id, persona_id, closeness, facts, last_at) VALUES (?,?,?,?,?)",
               (uid, persona_id, closeness, json.dumps(facts, ensure_ascii=False), db.now()))


def give_rep(uid: int, org_id: int, points: int) -> tuple[int, int]:
    before = rep(uid, org_id)
    if db.value("SELECT 1 FROM ai_rep WHERE user_id=? AND org_id=?", (uid, org_id)):
        db.run("UPDATE ai_rep SET points=points+?, week_points=week_points+? WHERE user_id=? AND org_id=?", (points, points, uid, org_id))
    else:
        db.run("INSERT INTO ai_rep (user_id, org_id, points, week_points) VALUES (?,?,?,?)", (uid, org_id, points, points))
    db.run("UPDATE ai_orgs SET influence=influence+? WHERE id=?", (points, org_id))
    return before, before + points


def _complete(uid: int, q: dict) -> None:
    if db.value("SELECT 1 FROM ai_quest_progress WHERE user_id=? AND quest_id=? AND status='done'", (uid, q["id"])):
        return
    if db.value("SELECT 1 FROM ai_quest_progress WHERE user_id=? AND quest_id=?", (uid, q["id"])):
        db.run("UPDATE ai_quest_progress SET status='done', completed_at=? WHERE user_id=? AND quest_id=?", (db.now(), uid, q["id"]))
    else:
        db.run("INSERT INTO ai_quest_progress (user_id, quest_id, status, progress, completed_at) VALUES (?,?, 'done', 1, ?)",
               (uid, q["id"], db.now()))
    org = core.org_by_id(q["org_id"]) or {}
    before, after = give_rep(uid, q["org_id"], q["reward"])
    giver = q["persona_id"] or (core.org_personas(org.get("slug", ""))[0]["user_id"] if org else None)
    if not giver:
        return
    name = (db.value("SELECT name FROM profiles WHERE user_id=?", (uid,)) or "").split(" ")[0]
    msg = random.choice(texts.QUEST_DONE).format(name=name, quest=q["title"], reward=q["reward"], org=org.get("name", ""))
    if texts.title_for(after) != texts.title_for(before):
        msg += "\n\n" + texts.TITLE_UP.format(name=name, title=texts.title_for(after), org=org.get("name", ""))
    core.schedule(giver, "dm", {"user_id": uid, "text": msg}, core.soon(0.1, 0.5))
    remember(uid, giver, f"выполнил(а) «{q['title']}»", closeness=3)


def check(uid: int, force: bool = False) -> list[int]:
    """Проверяет задания пользователя после его действия. Не чаще раза в 15 секунд."""
    if core.is_persona(uid):
        return []
    t = time.monotonic()
    if not force and t - _last_check.get(uid, float("-inf")) < 15:
        return []
    _last_check[uid] = t
    done = {r["quest_id"] for r in db.all("SELECT quest_id FROM ai_quest_progress WHERE user_id=? AND status='done'", (uid,))}
    finished = []
    for q in active_quests():
        if q["id"] in done or not unlocked(uid, q):
            continue
        have, need = progress(uid, q)
        if have >= need:
            _complete(uid, q)
            finished.append(q["id"])
    return finished
