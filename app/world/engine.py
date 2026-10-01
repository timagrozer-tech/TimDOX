"""Сердце Мира Круга: тик раз в 2 минуты и реакции на действия людей.

Тик: публикует созревшие задания очереди → дополняет очередь → реагирует на свежие записи людей →
ежедневные и еженедельные работы по календарю → двигает сюжеты. Всё идемпотентно и дёшево.
"""
import asyncio
import json
import logging
import os
import random
import re

from .. import db
from . import actions, core, gen, llm, quests, seed, texts

log = logging.getLogger("krug.world")

ENABLED = os.environ.get("AI_WORLD", "0") == "1"
TICK_SECONDS = int(os.environ.get("AI_TICK_SECONDS", "120"))
CHAT_PER_DAY = int(os.environ.get("AI_CHAT_PER_DAY", "25"))


def setup() -> None:
    seed.ensure()
    core.reset_cache()
    from .. import social
    social._ai_at = float("-inf")  # отметка «ИИ» появится сразу, без ожидания кэша
    quests.ensure_starter()


# ---------------------------------------------------------------- тик
def publish_due(limit: int = 40) -> int:
    jobs = db.all("SELECT * FROM ai_queue WHERE status='pending' AND run_at<=? ORDER BY run_at LIMIT ?", (db.now(), limit))
    for j in jobs:
        try:
            actions.run_job(j)
            db.run("UPDATE ai_queue SET status='done' WHERE id=?", (j["id"],))
        except Exception:
            log.exception("Действие мира не выполнено: %s", j["kind"])
            db.run("UPDATE ai_queue SET status='failed' WHERE id=?", (j["id"],))
    return len(jobs)


def plan() -> None:
    """За один тик дополняется очередь одной организации (по кругу) — нагрузка размазывается."""
    order = [o[0] for o in seed.ORGS]
    i = int(core.get("plan:cursor", 0) or 0) % len(order)
    core.put("plan:cursor", i + 1)
    n = gen.fill_org(order[i])
    if n:
        log.info("Мир: запланировано постов для «%s»: %s", order[i], n)


def social_tick() -> None:
    """Персонажи замечают свежие записи людей: реакция и иногда комментарий по теме записи."""
    engaged = set(core.get("engaged", []) or [])
    rows = db.all(f"""SELECT id, author_id, text FROM posts WHERE visibility='public' AND is_repost=0 AND created_at>?
                      AND author_id NOT IN (SELECT user_id FROM ai_personas) ORDER BY id DESC LIMIT 20""", (db.future(hours=-6),))
    rows = [r for r in rows if r["id"] not in engaged][:3]
    people = core.personas()
    for r in rows:
        engaged.add(r["id"])
        text = (r["text"] or "").lower()
        fans = [slug for slug, keys in texts.TOPIC_KEYS.items() if any(k in text for k in keys)]
        if not fans and random.random() > .35:
            continue
        slug = random.choice(fans) if fans else random.choice(list(people))
        p = people.get(slug)
        if not p:
            continue
        core.schedule(p["user_id"], "react", {"post_id": r["id"], "type": random.choice(["like", "like", "love", "wow"])}, core.soon(1, 8))
        if fans or random.random() < .4:
            core.schedule(p["user_id"], "comment", {"post_id": r["id"], "text": random.choice(texts.REPLIES.get(slug, texts.BANTER))},
                          core.soon(3, 25))
            quests.remember(r["author_id"], p["user_id"], None, closeness=1)
    core.put("engaged", list(engaged)[-400:])


def calendar() -> None:
    d = core.now_msk()
    wk = core.week_key(d)
    if core.once(f"week-start:{wk}"):
        gen.weekly_start()
    if d.weekday() == 6 and d.hour >= 18 and core.once(f"week-results:{wk}"):
        gen.weekly_results()
    if d.weekday() == 4 and d.hour >= 17 and core.once(f"interview:{wk}"):
        gen.interview()
    if d.hour >= 9 and core.once(f"news:{d.date()}"):
        gen.daily_news()
    se = gen.season()
    if se and core.once(f"season:{d.year}:{se[4]}"):
        core.schedule(core.personas()["mira_sovet"]["user_id"], "post",
                      {"text": f"{se[5]} В Круге начинается «{se[3]}»! Делитесь настроением с тегом #{se[4]} — Совет отметит самые тёплые записи.",
                       "community": "sovet"}, core.soon(0, 10))
    if d.hour == 4 and core.once(f"cleanup:{d.date()}"):
        db.run("DELETE FROM ai_queue WHERE status<>'pending' AND run_at<?", (db.future(days=-7),))


def tick() -> None:
    try:
        from . import trailer, tts
        tts.process()
        trailer.process()
    except Exception:
        log.exception("Озвучка")
    publish_due()
    plan()
    social_tick()
    calendar()
    gen.arcs_tick()


async def loop() -> None:
    try:
        await asyncio.to_thread(setup)
    except Exception:
        log.exception("Мир Круга не запустился")
        return
    log.info("Мир Круга запущен (нейросеть: %s)", "да" if llm.enabled() else "нет, шаблоны")
    while True:
        try:
            await asyncio.to_thread(tick)
        except Exception:
            log.exception("Ошибка тика мира")
        await asyncio.sleep(TICK_SECONDS)


# ---------------------------------------------------------------- отклики на действия людей
_FRIEND = re.compile(r"^/api/people/(\d+)/friend$")
_MSG = re.compile(r"^/api/conversations/(\d+)/messages$")


def on_request(uid: int, method: str, path: str, new_items: list | None = None) -> None:
    """Вызывается после каждого изменяющего запроса пользователя (из общего middleware). Должен быть быстрым."""
    if not ENABLED or core.is_persona(uid):
        return
    m = _FRIEND.match(path)
    if m and method == "POST" and core.is_persona(int(m.group(1))):
        core.schedule(int(m.group(1)), "accept_friend", {"user_id": uid}, core.soon(0.1, 0.4))
        asyncio.get_event_loop().call_later(15, lambda: asyncio.ensure_future(asyncio.to_thread(publish_due, 10)))
    m = _MSG.match(path)
    if m and method == "POST":
        conv = int(m.group(1))
        other = db.value("SELECT user_id FROM conversation_members WHERE conversation_id=? AND user_id<>?", (conv, uid))
        members = db.value("SELECT count(*) FROM conversation_members WHERE conversation_id=?", (conv,))
        if other and members == 2 and core.is_persona(other):
            asyncio.ensure_future(_reply_later(conv, other, uid))
    for item in new_items or []:
        _congrats(uid, item)
    if path == "/api/auth/me" and method == "GET":
        _welcome(uid)
    try:
        quests.check(uid)
    except Exception:
        log.exception("Проверка заданий")
    if db.value("SELECT 1 FROM ai_queue WHERE status='pending' AND kind='dm' AND run_at<=? LIMIT 1", (db.now(),)):
        asyncio.ensure_future(asyncio.to_thread(publish_due, 10))


def _welcome(uid: int) -> None:
    mira = core.personas().get("mira_sovet")
    if not mira or db.value("SELECT 1 FROM ai_memory WHERE user_id=? AND persona_id=?", (uid, mira["user_id"])):
        return
    if (db.value("SELECT created_at FROM users WHERE id=?", (uid,)) or "") < db.future(days=-14):
        quests.remember(uid, mira["user_id"], "давний житель Круга", 0)
        return
    name = (db.value("SELECT name FROM profiles WHERE user_id=?", (uid,)) or "").split(" ")[0]
    quests.remember(uid, mira["user_id"], "новый житель", 1)
    core.schedule(mira["user_id"], "dm", {"user_id": uid, "text": texts.WELCOME.format(name=name)}, core.soon(0.2, 1))


def _congrats(uid: int, item_id: str) -> None:
    from .. import collection
    item = collection.ITEM_BY_ID.get(item_id)
    host = core.personas().get("timur_efir")
    if not item or not host:
        return
    name = (db.value("SELECT name FROM profiles WHERE user_id=?", (uid,)) or "").split(" ")[0]
    core.schedule(host["user_id"], "dm", {"user_id": uid, "text": texts.ACHIEVE.format(name=name, item=item[2])}, core.soon(0.2, 2))
    quests.remember(uid, host["user_id"], f"получил(а) «{item[2]}»", 2)


# ---------------------------------------------------------------- чат с персонажем
async def _reply_later(conv: int, persona_id: int, uid: int) -> None:
    await asyncio.sleep(random.uniform(3, 9))
    try:
        text = await asyncio.to_thread(_compose_reply, conv, persona_id, uid)
        if text:
            await asyncio.to_thread(actions.dm, persona_id, uid, text)
    except Exception:
        log.exception("Ответ персонажа")


def _compose_reply(conv: int, persona_id: int, uid: int) -> str | None:
    p = core.persona_by_id(persona_id)
    last = db.all("SELECT sender_id, text FROM messages WHERE conversation_id=? AND kind='text' ORDER BY id DESC LIMIT 8", (conv,))
    if not p or not last or last[0]["sender_id"] != uid:
        return None
    msg = (last[0]["text"] or "").strip()
    name = (db.value("SELECT name FROM profiles WHERE user_id=?", (uid,)) or "").split(" ")[0]
    mem = db.one("SELECT facts, closeness, chats_day FROM ai_memory WHERE user_id=? AND persona_id=?", (uid, persona_id)) or {}
    facts = json.loads(mem.get("facts") or "[]")
    org = core.orgs().get(p["org"]) or {}
    points = quests.rep(uid, org.get("id", 0))
    # лимит ответов нейросети в день на человека
    day = db.now()[:10]
    used = mem.get("chats_day") or ""
    n_today = int(used.split(":")[1]) if used.startswith(day + ":") else 0
    quests.remember(uid, persona_id, None, closeness=1)
    db.run("UPDATE ai_memory SET chats_day=? WHERE user_id=? AND persona_id=?", (f"{day}:{n_today + 1}", uid, persona_id))
    if llm.enabled() and n_today < CHAT_PER_DAY:
        history = "\n".join(f"{'Ты' if r['sender_id'] == persona_id else name}: {r['text']}" for r in reversed(last) if r["text"])
        system = (f"Ты — {p['name']}, {p['role']} в организации «{org.get('name')}» соцсети «Круг». Ты ИИ-персонаж и не скрываешь этого. "
                  f"О себе: {p['bio']} Стиль: {p['style']}. Отвечай по-русски, коротко (1–3 предложения), тепло и по делу, без выдуманных фактов. "
                  f"Что ты помнишь о собеседнике ({name}): {', '.join(facts) or 'пока ничего'}. Его репутация у вашей организации: {points} "
                  f"(звание «{texts.title_for(points)}»). Можешь предлагать задания из раздела «Мир Круга».")
        answer = llm.complete(system, f"Переписка:\n{history}\n\nОтветь на последнее сообщение.", max_tokens=300)
        if answer:
            return answer.strip()[:800]
    low = msg.lower()
    done = {r["quest_id"] for r in db.all("SELECT quest_id FROM ai_quest_progress WHERE user_id=? AND status='done'", (uid,))}
    fmt = {"name": name, "org": org.get("name", ""), "rep": points, "title": texts.title_for(points), "bio": p.get("bio", ""),
           "quests": ", ".join(f"«{q['title']}»" for q in quests.active_quests() if q["org_id"] == org.get("id") and not q["secret"]
                             and q["id"] not in done)[:300] or "все уже выполнены — новые появятся в понедельник"}
    for keys, answers in texts.INTENTS:
        if any(k in low for k in keys):
            return random.choice(answers).format(**fmt)
    return random.choice(texts.FALLBACK).format(**fmt)
