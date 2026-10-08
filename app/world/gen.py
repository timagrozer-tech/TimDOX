"""Пакетная генерация контента: один запрос к нейросети = посты всех персонажей организации на 2 дня.
Без нейросети — шаблоны. Всё складывается в ai_queue и публикуется тиком в своё время."""
import json
import logging
import random
from datetime import timedelta

from .. import config, db
from ..security import censor, clean_text
from . import core, llm, news, texts

log = logging.getLogger("krug.world.gen")

DAYS_AHEAD = 2


def theme() -> tuple:
    y, w, _ = core.now_msk().isocalendar()
    return texts.WEEK_THEMES[w % len(texts.WEEK_THEMES)]


def season() -> tuple | None:
    d = core.now_msk()
    return next((s for s in texts.SEASONS if s[0] == d.month and s[1] <= d.day <= s[2]), None)


def _slots(p: dict) -> list[str]:
    """Время публикаций персонажа на ближайшие дни: 1–2 из его часов в сутки."""
    out = []
    start = core.now_msk()
    for d in range(DAYS_AHEAD):
        day = start + timedelta(days=d)
        for h in sorted(random.sample(p["hours"], k=random.choice([1, 2, 2]))):
            at = core.at_hour(day, h)
            if at > db.now():
                out.append(at)
    return out


def _used(slug: str) -> list[str]:
    return core.get(f"used:{slug}", []) or []


def _mark_used(slug: str, text: str) -> None:
    used = (_used(slug) + [text[:60]])[-40:]
    core.put(f"used:{slug}", used)


def _template_post(p: dict) -> dict:
    """Пост из шаблонов: иногда опрос организации, иногда тема недели, иначе — из собственного запаса персонажа."""
    th = theme()
    r = random.random()
    channel = (p.get("channels") or [None])[0]
    community = channel if random.random() < .6 else None
    if r < .18 and texts.POLLS.get(p["org"]):
        q, opts = random.choice(texts.POLLS[p["org"]])
        return {"text": f"{q} Голосуйте! 🗳", "poll": {"question": q, "options": opts, "days": 2}, "community": channel}
    if r < .28 and th[3] == p["org"]:
        return {"text": f"{th[4]} Идёт {th[1].lower()}! Делитесь мыслями с тегом #{th[2]} — лучшие записи попадут в итоги Совета.",
                "community": community}
    used = set(_used(p["slug"]))
    pool = texts.POSTS.get(p["slug"]) or ["Привет, Yarko!"]
    text = next((t for t in random.sample(pool, len(pool)) if t[:60] not in used), random.choice(pool))
    return {"text": text, "community": community}


def _llm_posts(org: str, people: list[dict], counts: dict[str, int]) -> dict[str, list[dict]] | None:
    """Один запрос — посты всех персонажей организации. Возвращает slug → [{text, poll?}]."""
    o = core.orgs().get(org) or {}
    th, se = theme(), season()
    heads = []
    for p in people:
        for ch in p.get("channels") or []:
            heads += [h["title"] for h in news.headlines(ch, 3)]
    cast = "\n".join(f'- "{p["slug"]}": {p["name"]}, {p["role"]}; тема: {p["specialty"]}; стиль: {p["style"]}; нужно постов: {counts[p["slug"]]}'
                     for p in people)
    system = ("Ты — сценарист живой соцсети Yarko. Пишешь посты от лица её ИИ-персонажей по-русски: живо, коротко (1–4 предложения), "
              "дружелюбно, с 1–2 эмодзи, без политики, рекламы и мата. СТРОГО: не придумывай цифры, проценты, даты, имена, цитаты и события. "
              "Если опираешься на заголовок новости — перескажи только то, что в нём сказано, и добавь мнение персонажа или вопрос подписчикам. "
              "Лучше всего работают: общеизвестные достоверные факты, советы, вопросы к аудитории, мнения, шутки. "
              "Отвечай строго JSON.")
    user = (f"Организация: {o.get('name')} — «{o.get('motto')}».\nТема недели: {th[1]} (тег #{th[2]}). "
            + (f"Сезонное событие: {se[3]} (#{se[4]}).\n" if se else "\n")
            + ("Свежие заголовки для вдохновения (не выдумывай подробностей): " + "; ".join(heads[:8]) + "\n" if heads else "")
            + f"Персонажи:\n{cast}\n\nСделай для каждого указанное число постов. Примерно каждый пятый пост — опрос. "
            'Формат: {"posts": [{"persona": "slug", "text": "...", "poll": null | {"question": "...", "options": ["...", "..."]}}]}')
    data = llm.parse_json(llm.complete(system, user, max_tokens=2500, want_json=True))
    if not data or not isinstance(data.get("posts"), list):
        return None
    out: dict[str, list[dict]] = {}
    for item in data["posts"]:
        if not isinstance(item, dict) or item.get("persona") not in counts:
            continue
        text = censor(clean_text(str(item.get("text") or ""), 900))
        if len(text) < 15:
            continue
        poll = item.get("poll")
        if isinstance(poll, dict) and isinstance(poll.get("options"), list) and len(poll["options"]) >= 2:
            poll = {"question": clean_text(str(poll.get("question") or text[:200]), 200),
                    "options": [clean_text(str(x), 80) for x in poll["options"][:5]], "days": 2}
        else:
            poll = None
        out.setdefault(item["persona"], []).append({"text": text, "poll": poll})
    return out


def fill_org(org: str) -> int:
    """Дополняет очередь постов организации на DAYS_AHEAD дней. Возвращает число запланированных постов."""
    people = core.org_personas(org)
    need = {}
    slots = {}
    for p in people:
        pending = db.value("SELECT count(*) FROM ai_queue WHERE persona_id=? AND kind='post' AND status='pending'", (p["user_id"],))
        if pending >= 2:
            continue
        slots[p["slug"]] = _slots(p)
        need[p["slug"]] = len(slots[p["slug"]])
    need = {k: v for k, v in need.items() if v}
    if not need:
        return 0
    generated = _llm_posts(org, [p for p in people if p["slug"] in need], need) if llm.enabled() else None
    n = 0
    for p in people:
        for i, at in enumerate(slots.get(p["slug"], [])):
            item = None
            if generated and i < len(generated.get(p["slug"], [])):
                g = generated[p["slug"]][i]
                channel = (p.get("channels") or [None])[0]
                item = {"text": g["text"], "poll": g["poll"], "community": channel if (g["poll"] or random.random() < .6) else None}
                source = "llm"
            else:
                item = _template_post(p)
                source = "template"
            _mark_used(p["slug"], item["text"])
            core.schedule(p["user_id"], "post", item, at, source)
            n += 1
    return n


# ---------------------------------------------------------------- ежедневные новости
def daily_news() -> None:
    """Дайджест заголовков для новостных каналов. С нейросетью — короткие подводки в стиле ведущих одним запросом."""
    blocks = {}
    for ch in news.FEEDS:
        items = news.headlines(ch, 4)
        owner = core.channel_owner(ch)
        if items and owner:
            blocks[ch] = (owner, items)
    if not blocks:
        return
    intros = {}
    if llm.enabled():
        req = "\n".join(f'"{ch}" (ведущий {o["name"]}, стиль: {o["style"]}): ' + " | ".join(i["title"] for i in items)
                        for ch, (o, items) in blocks.items())
        data = llm.parse_json(llm.complete(
            "Ты редактор новостных каналов соцсети Yarko. По каждому каналу напиши одно короткое вступление (до 200 символов) "
            "от лица ведущего к подборке заголовков. Не добавляй фактов, которых нет в заголовках. Ответ — JSON {\"канал\": \"вступление\"}.",
            req, max_tokens=900, want_json=True))
        if isinstance(data, dict):
            intros = {k: censor(clean_text(str(v), 300)) for k, v in data.items()}
    default = {"tech": "💻 Технологии за день — коротко:", "ii": "🤖 Что нового в мире ИИ:", "igry": "🎮 Игровые новости дня:",
               "nauka": "🔬 Наука сегодня:", "kosmos": "🚀 Новости космоса:", "kinozal": "🎬 Новости кино и сериалов:"}
    for ch, (owner, items) in blocks.items():
        body = "\n".join(f"• {i['title']}\n{i['link']}" for i in items)
        text = f"{intros.get(ch) or default.get(ch, '📰 Главное за день:')}\n\n{body}\n\n#новостидня"
        core.schedule(owner["user_id"], "post", {"text": text, "community": ch}, core.soon(1, 40), "llm" if ch in intros else "template")


# ---------------------------------------------------------------- неделя: тема, задания, событие, итоги
def weekly_start() -> None:
    th = theme()
    key, title, tag, org, emoji = th
    wk = core.week_key()
    mira, lev = core.personas()["mira_sovet"], core.personas()["lev_glashatai"]
    host = core.org_personas(org)[0]
    ends = core.iso(core.now_msk() + timedelta(days=7))
    # событие недели
    start = core.at_hour(core.now_msk() + timedelta(days=3), 19)
    from .actions import create_event
    ev_title = f"{emoji} {title}: вечер организации «{core.orgs()[org]['name']}»"
    event_id = create_event(host["user_id"], host["channels"][0], ev_title,
                            f"{host['name']} приглашает всех на главный вечер недели. Обсуждения, викторина и сюрпризы. Отметьтесь «Пойду» — это тоже задание!",
                            start)
    from .quests import add_quest
    add_quest(f"w{wk}-post", org, host["slug"], f"{title}: ваш голос", f"Опубликуйте запись с тегом #{tag}.",
              {"type": "post_tag", "tag": tag}, 20, ends)
    add_quest(f"w{wk}-event", org, host["slug"], "Приходите на вечер недели", f"Отметьтесь «Пойду» на мероприятии «{ev_title}».",
              {"type": "event_going", "event_id": event_id}, 15, ends)
    add_quest(f"w{wk}-comment", org, host["slug"], "Слово в обсуждении", f"Оставьте 2 комментария под записями организации «{core.orgs()[org]['name']}».",
              {"type": "comment_org", "org": org, "count": 2}, 15, ends)
    core.schedule(mira["user_id"], "post", {"text": f"{emoji} Совет Yarko объявляет: началась {title.lower()}! Пишите с тегом #{tag}, "
                                                    f"выполняйте задания в «Мире Yarko» и приходите на вечер организации «{core.orgs()[org]['name']}». "
                                                    "Очки влияния получит организация, чьи задания вы выполните 🏛", "community": "sovet"}, core.soon(0, 5))
    core.schedule(lev["user_id"], "post", {"text": f"📯 Новые задания недели уже в «Мире Yarko»! Первые три выполнивших — герои вечернего выпуска!"},
                  core.soon(30, 90))


def weekly_results() -> None:
    """Итоги недели: рейтинг организаций от Совета, летопись от Архивариусов, обнуление недельных очков."""
    rows = db.all("""SELECT o.name, o.emoji, COALESCE(SUM(r.week_points), 0) AS pts FROM ai_orgs o
                     LEFT JOIN ai_rep r ON r.org_id=o.id GROUP BY o.id, o.name, o.emoji ORDER BY pts DESC""")
    medals = ["🥇", "🥈", "🥉"]
    lines = "\n".join(f"{medals[i] if i < 3 else '•'} {r['emoji']} {r['name']} — {r['pts']}" for i, r in enumerate(rows))
    core.schedule(core.personas()["mira_sovet"]["user_id"], "post",
                  {"text": f"🏛 Итоги недели: рейтинг организаций по очкам, которые принесли жители Yarko:\n\n{lines}\n\n"
                           "Спасибо каждому! Новая неделя — новые задания.", "community": "sovet"}, core.soon(0, 10))
    top = db.all("""SELECT p.id, pr.name, count(x.user_id) AS n FROM posts p JOIN profiles pr ON pr.user_id=p.author_id
                    LEFT JOIN reactions x ON x.post_id=p.id WHERE p.created_at > ? AND p.visibility='public'
                    AND p.author_id NOT IN (SELECT user_id FROM ai_personas)
                    GROUP BY p.id, pr.name ORDER BY n DESC LIMIT 3""", (db.future(days=-7),))
    if top:
        body = "\n".join(f"• {t['name']} — {config.APP_URL}/post/{t['id']}" for t in top)
        core.schedule(core.personas()["orest_arhiv"]["user_id"], "post",
                      {"text": f"📜 Летопись недели. Архив запомнит самые обсуждаемые записи жителей:\n\n{body}\n\n#летописькруга", "community": "arhiv"},
                      core.soon(20, 60))
    db.run("UPDATE ai_rep SET week_points=0")


def interview() -> None:
    """«Интервью недели»: ведущий задаёт вопросы персонажу. С нейросетью — живой диалог одним запросом, без неё — шаблон."""
    host = core.personas()["timur_efir"]
    guest = random.choice([p for p in core.personas().values() if p["slug"] not in ("timur_efir",)])
    text = None
    if llm.enabled():
        data = llm.parse_json(llm.complete(
            "Ты сценарист шоу «Интервью недели» в соцсети Yarko. Короткое интервью (4 вопроса и ответа) по-русски, весело и тепло. JSON {\"text\": \"...\"}.",
            f"Ведущий: {host['name']} ({host['style']}). Гость: {guest['name']}, {guest['role']}, тема: {guest['specialty']}, стиль: {guest['style']}. "
            f"Биография гостя: {guest['bio']}", max_tokens=900, want_json=True))
        if isinstance(data, dict) and data.get("text"):
            text = censor(clean_text(str(data["text"]), 2500))
    if not text:
        text = (f"🎙 Интервью недели! Сегодня у нас в гостях {guest['name']} — {guest['role'].lower()}.\n\n"
                f"— Чем вы занимаетесь в Yarko?\n— {guest['bio']}\n\n"
                f"— Что вы посоветуете новым жителям?\n— Не бойтесь писать первыми. Здесь любят тех, кто делится.\n\n"
                f"— Ваше главное увлечение?\n— {guest['specialty'].capitalize()}, конечно! Заглядывайте ко мне в профиль @{guest['slug']}.\n\n"
                "Задавайте свои вопросы гостю в комментариях 👇")
    core.schedule(host["user_id"], "post", {"text": text, "community": "efir"}, core.soon(0, 20), "llm" if llm.enabled() else "template")


# ---------------------------------------------------------------- сюжеты
def _arc_post(arc: dict, stage: str) -> int:
    from .actions import publish_post
    spec = texts.ARCS[arc["code"]]
    author = core.personas()[spec["author"]]
    text, options = spec["stages"][stage]
    head = f"📖 «{spec['title']}»\n\n{text}"
    poll = {"question": "Что делаем дальше?", "options": [o[0] for o in options], "days": 2} if options else None
    return publish_post(author["user_id"], head + ("\n\nРешение за вами — голосуйте! #сюжеткруга" if poll else "\n\n#сюжеткруга"),
                        author["channels"][0], poll)


def arcs_tick() -> None:
    for code, spec in texts.ARCS.items():
        if not db.value("SELECT 1 FROM ai_arcs WHERE code=?", (code,)):
            org = core.orgs().get(spec["org"])
            status = "active" if not db.value("SELECT 1 FROM ai_arcs WHERE status='active'") else "pending"
            db.run("INSERT INTO ai_arcs (code, org_id, title, status, next_at) VALUES (?,?,?,?,?)",
                   (code, org and org["id"], spec["title"], status, db.now()))
    arc = db.one("SELECT * FROM ai_arcs WHERE status='active' ORDER BY id LIMIT 1")
    if not arc:
        nxt = db.one("SELECT * FROM ai_arcs WHERE status='pending' AND (next_at IS NULL OR next_at<=?) ORDER BY id LIMIT 1", (db.now(),))
        if nxt:
            db.run("UPDATE ai_arcs SET status='active' WHERE id=?", (nxt["id"],))
        return
    spec = texts.ARCS[arc["code"]]
    if not arc["post_id"]:
        pid = _arc_post(arc, arc["stage"])
        db.run("UPDATE ai_arcs SET post_id=?, next_at=? WHERE id=?", (pid, db.future(days=2), arc["id"]))
        return
    if arc["next_at"] and arc["next_at"] > db.now():
        return
    options = spec["stages"][arc["stage"]][1]
    history = json.loads(arc["history"] or "[]")
    if not options:  # финал
        db.run("UPDATE ai_arcs SET status='done' WHERE id=?", (arc["id"],))
        db.run("UPDATE ai_orgs SET influence=influence+50 WHERE id=?", (arc["org_id"],))
        db.run("UPDATE ai_arcs SET next_at=? WHERE status='pending'", (db.future(days=1),))
        return
    votes = db.all("""SELECT o.position, count(v.user_id) AS n FROM polls pl JOIN poll_options o ON o.poll_id=pl.id
                      LEFT JOIN poll_votes v ON v.option_id=o.id WHERE pl.post_id=? GROUP BY o.position ORDER BY n DESC, o.position""",
                   (arc["post_id"],))
    win = votes[0]["position"] if votes else 0
    nxt = options[min(win, len(options) - 1)][1]
    history.append({"stage": arc["stage"], "choice": options[min(win, len(options) - 1)][0]})
    pid = _arc_post(arc, nxt)
    final = not spec["stages"][nxt][1]
    db.run("UPDATE ai_arcs SET stage=?, post_id=?, history=?, next_at=? WHERE id=?",
           (nxt, pid, json.dumps(history, ensure_ascii=False), db.now() if final else db.future(days=2), arc["id"]))
