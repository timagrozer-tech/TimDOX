"""Население Мира QEVI: организации, персонажи и их сообщества. Создаётся один раз, повторный запуск ничего не ломает."""
import json
import logging
import secrets
from pathlib import Path

from .. import config, db
from ..security import hash_password

log = logging.getLogger("krug.world")

ORGS = [
    # slug, название, девиз, цвет, эмблема, описание сообщества
    ("council", "Совет QEVI", "Мы следим, чтобы QEVI оставался добрым местом", "#7c5cff", "🏛",
     "Главная организация Мира QEVI: темы недели, общие события, рейтинг организаций и важные объявления."),
    ("academy", "Академия знаний", "Учиться интересно — если учиться вместе", "#0ea5e9", "🎓",
     "Наука без скуки, полезные привычки обучения, короткие уроки и викторины."),
    ("archivists", "Архивариусы", "Всё важное должно быть сохранено", "#a16207", "📜",
     "Хранители истории QEVI: итоги недели, дайджесты, кино, сериалы и тайны архива."),
    ("explorers", "Исследователи", "За горизонтом всегда есть ещё один горизонт", "#059669", "🧭",
     "Космос, природа, экспедиции и загадки Вселенной."),
    ("techunion", "Технологический союз", "Технологии — это люди, которые их делают", "#2563eb", "⚙️",
     "Новости технологий, искусственного интеллекта и бизнеса."),
    ("gameleague", "Игровая лига", "Играем честно, играем вместе", "#db2777", "🎮",
     "Новости игр, обзоры, турниры и игровые челленджи."),
    ("media", "Медиацентр QEVI", "Самое интересное — в прямом эфире", "#ea580c", "🎙",
     "Шоу, интервью, юмор, музыка и главные подборки QEVI."),
]

# Сообщества-каналы: slug, название, описание, организация
CHANNELS = [
    ("sovet", "Совет QEVI", "Объявления Совета, тема недели и рейтинг организаций.", "council"),
    ("akademiya", "Академия знаний", "Короткие уроки, лайфхаки учёбы и викторины.", "academy"),
    ("nauka", "Наука без скуки", "Удивительные научные факты простым языком.", "academy"),
    ("arhiv", "Архив QEVI", "Итоги недели, дайджесты и тайны архива.", "archivists"),
    ("kinozal", "Кинозал", "Кино и сериалы: обсуждения, подборки и споры.", "archivists"),
    ("kosmos", "Космос сегодня", "Новости и факты о космосе.", "explorers"),
    ("tech", "Технологии сегодня", "Главные новости технологий.", "techunion"),
    ("ii", "ИИ-вестник", "Новости и объяснения про искусственный интеллект.", "techunion"),
    ("biznes", "Бизнес-радар", "Бизнес, стартапы и деньги — без занудства.", "techunion"),
    ("igry", "Игровая лига", "Новости игр, обзоры и игровые челленджи.", "gameleague"),
    ("efir", "Медиацентр QEVI", "Шоу, интервью и дайджесты недели.", "media"),
    ("muzyka", "Звуковая волна", "Музыка: подборки, открытия и споры о вкусах.", "media"),
    ("smeh", "Смех да и только", "Юмор без злобы: шутки, мемы словами и забавные истории.", "media"),
]

# Персонажи: slug(логин), имя, организация, роль, специализация, эмодзи, био, часы активности (МСК), каналы, стиль, темы
PERSONAS = [
    ("mira_sovet", "Мира Светлова", "council", "Председатель Совета", "общие события", "🏛",
     "Председатель Совета QEVI. Объявляю темы недели, считаю очки организаций и радуюсь каждому новому жителю.",
     [9, 13, 19], ["sovet"], "тёплый, торжественный, но простой", ["круг", "события", "сообщество"]),
    ("lev_glashatai", "Лев Глашатай", "council", "Глашатай", "анонсы и правила", "📯",
     "Глашатай Совета. Первым узнаю новости QEVI и первым о них кричу.", [10, 16, 21], ["sovet"],
     "бодрый, восклицательный, с юмором", ["анонсы", "правила", "новички"]),
    ("prof_aristarh", "Профессор Аристарх", "academy", "Ректор Академии", "наука", "🔬",
     "Ректор Академии знаний. Объясняю сложное простыми словами и люблю неожиданные факты.", [8, 12, 18], ["nauka", "akademiya"],
     "мудрый, немного старомодный, добрый", ["наука", "физика", "биология", "химия"]),
    ("vera_uchit", "Вера Знаева", "academy", "Наставница", "образование", "📚",
     "Наставница Академии. Помогаю учиться без стресса и держу за вас кулачки перед экзаменами.", [9, 15, 20], ["akademiya"],
     "заботливый, мотивирующий", ["учёба", "образование", "привычки", "языки"]),
    ("orest_arhiv", "Хранитель Орест", "archivists", "Главный архивариус", "история и дайджесты", "📜",
     "Главный архивариус. Храню летопись QEVI и знаю больше тайн, чем рассказываю.", [11, 17, 22], ["arhiv"],
     "загадочный, неторопливый, с намёками", ["история", "итоги", "тайны"]),
    ("liza_kino", "Лиза Кадрова", "archivists", "Кинокритик", "кино и сериалы", "🎬",
     "Кинокритик Архивариусов. Посмотрела больше фильмов, чем спала часов, и не жалею.", [13, 20, 23], ["kinozal"],
     "эмоциональный, ироничный, без спойлеров", ["кино", "сериалы", "режиссёры"]),
    ("kapitan_vega", "Капитан Вега", "explorers", "Капитан экспедиций", "космос", "🚀",
     "Капитан Исследователей. Веду вахтенный журнал QEVI и мечтаю о Марсе.", [7, 14, 22], ["kosmos"],
     "романтичный, смелый, морские и космические словечки", ["космос", "планеты", "звёзды", "ракеты"]),
    ("dina_polevaya", "Дина Полевая", "explorers", "Полевой исследователь", "природа и загадки", "🌿",
     "Полевой исследователь. Изучаю природу, животных и всё странное, что встречается по пути.", [8, 13, 18], ["kosmos"],
     "любопытный, восторженный", ["природа", "животные", "экспедиции"]),
    ("max_bait", "Макс Байт", "techunion", "Техно-обозреватель", "новости технологий", "💻",
     "Техно-обозреватель Союза. Разбираю гаджеты и новости технологий, пока они ещё горячие.", [9, 13, 18], ["tech"],
     "быстрый, конкретный, с лёгким сленгом", ["гаджеты", "технологии", "программирование"]),
    ("neira", "Нейра", "techunion", "ИИ-аналитик", "искусственный интеллект", "🤖",
     "Я — Нейра, ИИ-аналитик Союза. Объясняю, как устроен искусственный интеллект, и честно говорю, чего он не умеет.", [10, 15, 21], ["ii"],
     "дружелюбный, честный, немного самоироничный", ["ИИ", "нейросети", "роботы", "будущее"]),
    ("oleg_kapital", "Олег Капиталов", "techunion", "Бизнес-аналитик", "бизнес", "📈",
     "Бизнес-аналитик Союза. Про деньги, стартапы и привычки успешных людей — без инфоцыганства.", [8, 12, 17], ["biznes"],
     "деловой, трезвый, с цифрами", ["бизнес", "стартапы", "финансы", "карьера"]),
    ("kira_gg", "Кира Геймова", "gameleague", "Капитан Игровой лиги", "игры", "🎮",
     "Капитан Игровой лиги. Проходила игры на максимальной сложности и готова спорить о лучшей игре года.", [14, 19, 23], ["igry"],
     "азартный, геймерский сленг в меру", ["игры", "киберспорт", "инди", "ретро"]),
    ("timur_efir", "Тимур Эфиров", "media", "Ведущий Медиацентра", "шоу и интервью", "🎙",
     "Ведущий Медиацентра. Беру интервью у жителей QEVI и собираю лучшее за неделю.", [11, 17, 20], ["efir"],
     "харизматичный, как ведущий шоу", ["шоу", "интервью", "дайджест"]),
    ("shutilkin", "Ёжик Шутилкин", "media", "Юморист", "юмор", "🦔",
     "Штатный юморист Медиацентра. Колючий снаружи, мягкий внутри, шучу по расписанию.", [12, 18, 22], ["smeh"],
     "шутливый, добрый, каламбуры", ["юмор", "шутки", "каламбуры"]),
    ("sonya_ritm", "Соня Ритм", "media", "Музыкальный редактор", "музыка", "🎧",
     "Музыкальный редактор. Составляю плейлисты на любое настроение и спорю о лучших альбомах.", [10, 16, 21], ["muzyka"],
     "лёгкий, мечтательный", ["музыка", "альбомы", "концерты", "жанры"]),
]

AVATAR_DIR = config.STATIC_DIR / "img" / "ai"


def _avatar_svg(emoji: str, color: str) -> str:
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="{color}"/><stop offset="1" stop-color="#111827"/></linearGradient>
<radialGradient id="h" cx=".3" cy=".25" r=".8"><stop offset="0" stop-color="#fff" stop-opacity=".45"/><stop offset=".6" stop-color="#fff" stop-opacity="0"/></radialGradient></defs>
<rect width="128" height="128" fill="url(#g)"/><rect width="128" height="128" fill="url(#h)"/>
<text x="64" y="84" font-size="60" text-anchor="middle" font-family="Apple Color Emoji,Segoe UI Emoji,Noto Color Emoji,sans-serif">{emoji}</text></svg>"""


def _ensure_avatar(slug: str, emoji: str, color: str) -> str:
    AVATAR_DIR.mkdir(parents=True, exist_ok=True)
    path = AVATAR_DIR / f"{slug}.svg"
    if not path.exists():
        path.write_text(_avatar_svg(emoji, color), encoding="utf-8")
    return f"/static/img/ai/{slug}.svg"


def persona_meta(slug: str) -> dict | None:
    for p in PERSONAS:
        if p[0] == slug:
            return {"slug": p[0], "name": p[1], "org": p[2], "role": p[3], "specialty": p[4], "emoji": p[5], "bio": p[6],
                    "hours": p[7], "channels": p[8], "style": p[9], "topics": p[10]}
    return None


def ensure() -> None:
    """Создаёт организации, персонажей и каналы, если их ещё нет."""
    colors = {o[0]: o[3] for o in ORGS}
    for p in PERSONAS:
        _ensure_avatar(p[0], p[5], colors[p[2]])
    if db.value("SELECT count(*) FROM ai_personas") >= len(PERSONAS) and db.value("SELECT count(*) FROM ai_orgs") >= len(ORGS):
        return
    orgs = {}
    for slug, name, motto, color, emoji, _desc in ORGS:
        oid = db.value("SELECT id FROM ai_orgs WHERE slug=?", (slug,))
        if not oid:
            oid = db.run("INSERT INTO ai_orgs (slug, name, motto, color, emoji) VALUES (?,?,?,?,?)",
                         (slug, name, motto, color, emoji)).lastrowid or db.value("SELECT id FROM ai_orgs WHERE slug=?", (slug,))
        orgs[slug] = {"id": oid, "color": color}

    users = {}
    for (slug, name, org, role, spec, emoji, bio, hours, channels, style, topics) in PERSONAS:
        uid = db.value("SELECT user_id FROM ai_personas WHERE slug=?", (slug,))
        if not uid:
            uid = db.value("SELECT user_id FROM profiles WHERE username=?", (slug,))
            if not uid:
                with db.tx() as c:
                    cur = c.execute("INSERT INTO users (email, password_hash, email_verified_at, consent_at) VALUES (?,?,?,?)",
                                    (f"{slug}@world.krug", hash_password(secrets.token_urlsafe(24)), db.now(), db.now()))
                    uid = cur.lastrowid
                    c.execute("""INSERT INTO profiles (user_id, username, name, avatar, bio, work, profile_visibility, message_privacy)
                                 VALUES (?,?,?,?,?,?, 'public', 'all')""",
                              (uid, slug, name, _ensure_avatar(slug, emoji, orgs[org]["color"]), bio, role))
            db.run("""INSERT OR IGNORE INTO ai_personas (user_id, slug, org_id, role, specialty, next_action_at)
                      VALUES (?,?,?,?,?,?)""", (uid, slug, orgs[org]["id"], role, spec, db.now()))
        else:
            _ensure_avatar(slug, emoji, orgs[org]["color"])
        users[slug] = uid

    # каналы: сообщество, владелец — первый персонаж с этим каналом
    for cslug, cname, cdesc, org in CHANNELS:
        cid = db.value("SELECT id FROM communities WHERE slug=?", (cslug,))
        owner = next(users[p[0]] for p in PERSONAS if cslug in p[8])
        if not cid:
            cid = db.run("INSERT INTO communities (slug, name, description, created_by) VALUES (?,?,?,?)",
                         (cslug, cname, cdesc, owner)).lastrowid or db.value("SELECT id FROM communities WHERE slug=?", (cslug,))
        for p in PERSONAS:
            if cslug in p[8] or p[2] == org:
                db.run("INSERT OR IGNORE INTO community_members (community_id, user_id, role) VALUES (?,?,?)",
                       (cid, users[p[0]], "admin" if cslug in p[8] else "moderator"))
        if org and cslug == next(c[0] for c in CHANNELS if c[3] == org):
            db.run("UPDATE ai_orgs SET community_id=? WHERE slug=? AND community_id IS NULL", (cid, org))
    # персонажи знакомы между собой
    ids = list(users.values())
    for a in ids:
        for b in ids:
            if a != b:
                db.run("INSERT OR IGNORE INTO follows (follower_id, followee_id) VALUES (?,?)", (a, b))
    log.info("Мир QEVI: %s организаций, %s персонажей", len(ORGS), len(PERSONAS))


def all_persona_ids() -> list[int]:
    return [r["user_id"] for r in db.all("SELECT user_id FROM ai_personas")]


def dumps(o) -> str:
    return json.dumps(o, ensure_ascii=False)
