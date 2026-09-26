"""Наполнение базы тестовыми данными.

    python -m scripts.seed           # добавить данные (если база пустая)
    python -m scripts.seed --reset   # удалить базу и загрузки и заполнить заново

Все тестовые пользователи имеют пароль  demo12345
"""
import io
import math
import random
import shutil
import sys
from datetime import datetime, timedelta, timezone

from PIL import Image, ImageDraw, ImageFilter

from app import config, db
from app.media import _process
from app.security import extract_hashtags, extract_mentions, hash_password

random.seed(7)
PASSWORD = "demo12345"
NOW = datetime.now(timezone.utc)


def ts(hours_ago: float) -> str:
    return (NOW - timedelta(hours=hours_ago)).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


# ---------------------------------------------------------------- Картинки
def _grad(size, top, bottom):
    w, h = size
    img = Image.new("RGB", size, top)
    d = ImageDraw.Draw(img)
    for y in range(h):
        t = y / max(1, h - 1)
        d.line([(0, y), (w, y)], fill=tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3)))
    return img


def landscape(seed: int, size=(1400, 1000)) -> bytes:
    rnd = random.Random(seed)
    skies = [((255, 176, 120), (255, 226, 190)), ((116, 170, 238), (208, 230, 250)), ((58, 64, 140), (240, 140, 110)),
             ((250, 205, 150), (170, 200, 230)), ((30, 40, 90), (110, 90, 160))]
    top, bottom = skies[seed % len(skies)]
    img = _grad(size, top, bottom)
    d = ImageDraw.Draw(img, "RGBA")
    w, h = size
    sun_y = rnd.randint(int(h * .18), int(h * .45))
    sun_x = rnd.randint(int(w * .2), int(w * .8))
    d.ellipse([sun_x - 90, sun_y - 90, sun_x + 90, sun_y + 90], fill=(255, 245, 220, 230))
    layers = [((70, 90, 140), .55), ((50, 70, 110), .65), ((30, 48, 80), .78)]
    if seed % 3 == 1:
        layers = [((60, 120, 90), .6), ((40, 95, 70), .7), ((25, 70, 50), .82)]
    for color, base in layers:
        pts = [(0, h)]
        x = 0
        phase = rnd.random() * 6
        amp = rnd.randint(40, 120)
        while x <= w:
            y = h * base + math.sin(x / rnd.randint(120, 260) + phase) * amp * .5 + rnd.randint(-15, 15)
            pts.append((x, y))
            x += 40
        pts.append((w, h))
        d.polygon(pts, fill=color + (255,))
    if seed % 2 == 0:  # вода с отражением
        d.rectangle([0, int(h * .86), w, h], fill=(40, 70, 120, 170))
        for i in range(12):
            y = int(h * .88) + i * 9
            d.line([(sun_x - 120 + rnd.randint(-30, 30), y), (sun_x + 120 + rnd.randint(-30, 30), y)], fill=(255, 235, 200, 90), width=3)
    img = img.filter(ImageFilter.GaussianBlur(0.6))
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=90)
    return buf.getvalue()


def food(seed: int, size=(1100, 1100)) -> bytes:
    rnd = random.Random(seed)
    img = _grad(size, (236, 226, 210), (214, 198, 176))
    d = ImageDraw.Draw(img, "RGBA")
    w, h = size
    d.ellipse([140, 140, w - 140, h - 140], fill=(250, 250, 248, 255), outline=(220, 215, 205, 255), width=12)
    colors = [(214, 80, 60), (240, 170, 60), (90, 160, 80), (200, 60, 90), (250, 210, 100)]
    for _ in range(40):
        r = rnd.randint(25, 70)
        a = rnd.random() * math.tau
        dist = rnd.random() * 260
        x, y = w / 2 + math.cos(a) * dist, h / 2 + math.sin(a) * dist
        d.ellipse([x - r, y - r, x + r, y + r], fill=rnd.choice(colors) + (235,))
    img = img.filter(ImageFilter.GaussianBlur(1.2))
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=90)
    return buf.getvalue()


def city(seed: int, size=(1400, 950)) -> bytes:
    rnd = random.Random(seed)
    img = _grad(size, (24, 34, 72), (236, 128, 86))
    d = ImageDraw.Draw(img, "RGBA")
    w, h = size
    x = 0
    while x < w:
        bw = rnd.randint(60, 140)
        bh = rnd.randint(int(h * .25), int(h * .7))
        d.rectangle([x, h - bh, x + bw, h], fill=(20, 24, 44, 255))
        for wy in range(h - bh + 20, h - 20, 34):
            for wx in range(x + 12, x + bw - 16, 26):
                if rnd.random() < .45:
                    d.rectangle([wx, wy, wx + 12, wy + 16], fill=(255, 214, 140, 220))
        x += bw + rnd.randint(4, 16)
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=90)
    return buf.getvalue()


def avatar_img(seed: int) -> bytes:
    rnd = random.Random(seed * 13)
    palettes = [((31, 63, 174), (245, 118, 26)), ((26, 138, 74), (240, 200, 80)), ((124, 58, 237), (236, 72, 153)),
                ((14, 116, 144), (125, 211, 252)), ((190, 24, 93), (251, 146, 60))]
    a, b = palettes[seed % len(palettes)]
    img = _grad((512, 512), a, b)
    d = ImageDraw.Draw(img, "RGBA")
    for _ in range(6):
        r = rnd.randint(60, 180)
        x, y = rnd.randint(0, 512), rnd.randint(0, 512)
        d.ellipse([x - r, y - r, x + r, y + r], fill=(255, 255, 255, rnd.randint(25, 70)))
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


def cover_img(seed: int) -> bytes:
    return landscape(seed + 40, size=(1600, 600))


# ---------------------------------------------------------------- Данные
USERS = [
    # username, имя, город, о себе, работа, учёба, дата рождения, аватар?
    ("anna", "Анна Смирнова", "Казань", "Фотографирую закаты и котов. Люблю горы, кофе и долгие прогулки 🏔", "Дизайнер интерфейсов", "КФУ, 2016", "1994-05-14", True),
    ("boris", "Борис Иванов", "Казань", "Инженер, велосипедист, иногда пеку хлеб.", "Инженер-конструктор", "КНИТУ-КАИ", "1991-11-02", True),
    ("maria", "Мария Кузнецова", "Москва", "Учитель литературы. Книги, театр, путешествия.", "Школа № 57", "МПГУ", "1989-03-08", True),
    ("dmitry", "Дмитрий Орлов", "Санкт-Петербург", "Бегаю марафоны и пишу код.", "Backend-разработчик", "ИТМО", "1992-07-21", False),
    ("elena", "Елена Волкова", "Новосибирск", "Мама двоих детей и кондитер по вечерам 🍰", "Кондитерская «Ваниль»", "", "1987-12-30", True),
    ("igor", "Игорь Соколов", "Екатеринбург", "Походы, рыбалка, баня.", "Уралмаш", "УрФУ", "1985-09-10", False),
    ("olga", "Ольга Морозова", "Москва", "Врач-педиатр. Пишу о здоровье детей простым языком.", "Детская поликлиника", "РНИМУ им. Пирогова", "1990-01-19", True),
    ("sergey", "Сергей Павлов", "Казань", "Фотограф. Снимаю свадьбы и город.", "Свободный фотограф", "", "1993-06-05", False),
    ("natasha", "Наталья Лебедева", "Самара", "Сад, огород и рассада на подоконнике 🌱", "На пенсии, но очень занята", "", "1958-04-22", False),
    ("alexey", "Алексей Новиков", "Нижний Новгород", "История, архитектура, краеведение.", "Экскурсовод", "ННГУ", "1996-10-11", True),
    ("tatiana", "Татьяна Фёдорова", "Сочи", "Море каждый день 🌊", "Отель «Лазурь»", "", "1995-08-17", True),
    ("pavel", "Павел Егоров", "Краснодар", "Фермер. Выращиваю черешню и мечты.", "КФХ Егорова", "КубГАУ", "1983-02-27", False),
]

FRIENDS = [("anna", "boris"), ("anna", "maria"), ("anna", "sergey"), ("anna", "dmitry"), ("anna", "tatiana"), ("anna", "alexey"),
           ("boris", "sergey"), ("boris", "dmitry"), ("boris", "igor"), ("maria", "olga"), ("maria", "alexey"), ("maria", "elena"),
           ("dmitry", "alexey"), ("elena", "natasha"), ("elena", "olga"), ("igor", "pavel"), ("natasha", "pavel"), ("tatiana", "olga"),
           ("sergey", "tatiana"), ("olga", "natasha")]
PENDING = [("elena", "anna"), ("pavel", "anna"), ("anna", "olga")]
FOLLOWS = [("natasha", "anna"), ("igor", "anna"), ("anna", "elena"), ("pavel", "tatiana"), ("dmitry", "olga")]

POSTS = [
    # автор, часов назад, текст, картинки [(тип, seed)], видимость
    ("sergey", 1.5, "Вечерний Кремль после дождя. Казань, ты прекрасна! #Казань #фото", [("city", 1), ("landscape", 2)], "public"),
    ("anna", 3, "Наконец-то добрались до Алтая! Три дня без связи, только горы, звёзды и тишина. Фото — рассвет у Телецкого озера 🏔\n\n@boris спасибо, что уговорил поехать! #путешествия #Алтай", [("landscape", 10), ("landscape", 11), ("landscape", 12), ("landscape", 14)], "public"),
    ("maria", 5, "Дочитала «Лето Господне» Шмелёва. Какой язык, какие запахи и звуки старой Москвы! Кто ещё любит эту книгу? #книги", [], "public"),
    ("elena", 7, "Сегодня пекла медовик на юбилей бабушке. Восемь коржей, два часа терпения — и вот он 🍰 #выпечка #рецепты", [("food", 3)], "public"),
    ("dmitry", 9, "Пробежал полумарафон за 1:38 — личный рекорд! Следующая цель — Белые ночи в июне. #бег #спорт", [], "public"),
    ("boris", 12, "Испёк первый в жизни хлеб на закваске. Корочка хрустит, мякиш пористый. Жена сказала — лучше магазинного 😄 #выпечка", [("food", 8)], "friends"),
    ("tatiana", 16, "Утро в Сочи. Вода +24, людей почти нет. Кто в отпуске — приезжайте! #море #Сочи", [("landscape", 20)], "public"),
    ("olga", 20, "Коротко о прививках для малышей: календарь, противопоказания и почему не стоит откладывать. Сохраните себе, чтобы не потерять 👇\n\n1. Первая неделя — гепатит B и БЦЖ.\n2. 3 месяца — АКДС и полиомиелит.\n3. 12 месяцев — корь, краснуха, паротит.\n\nВопросы — в комментарии, отвечу всем. #здоровье", [], "public"),
    ("alexey", 26, "Нижегородский кремль — один из немногих, что ни разу не был взят штурмом. На фото — Дмитриевская башня на закате. #история #НижнийНовгород", [("city", 5)], "public"),
    ("natasha", 30, "Рассада томатов на подоконнике уже по колено! Сорт «Бычье сердце». Соседки, делимся секретами? 🌱 #дача", [("landscape", 31)], "public"),
    ("igor", 40, "Выходные на Чусовой. Сплав, уха, костёр. Вот это и есть отдых. #путешествия", [("landscape", 41), ("landscape", 43)], "public"),
    ("anna", 50, "Новый проект — редизайн приложения для библиотеки. Пожелайте удачи 🙌 #работа", [], "friends"),
    ("pavel", 60, "Черешня зацвела! Если погода не подведёт, в июне будет урожай. #дача #Краснодар", [("landscape", 61)], "public"),
    ("maria", 72, "Сходили с классом в Третьяковку. Дети стояли у «Утра в сосновом лесу» дольше, чем я ожидала. #книги #искусство", [], "public"),
    ("sergey", 90, "Серия «Казань в тумане» — 5 кадров с утренней прогулки по набережной. #Казань #фото", [("city", 91), ("landscape", 92), ("city", 93), ("landscape", 94), ("landscape", 95)], "public"),
]

COMMENTS = [
    (1, "boris", "Потрясающие кадры! Надо было ехать с вами 😭"),
    (1, "maria", "Анна, это невероятно красиво. Сохранила себе на заставку!"),
    (1, "tatiana", "Хочу туда! Сколько стоила поездка?"),
    (1, "anna", "@tatiana примерно 45 тысяч на двоих за неделю, напишу подробнее в личку 🙂"),
    (0, "anna", "Сергей, какой свет! Это на Кремлёвской набережной?"),
    (0, "sergey", "@anna да, возле Благовещенского собора 👍"),
    (2, "alexey", "Одна из моих любимых! Ещё советую «Богомолье»."),
    (3, "natasha", "Леночка, поделитесь рецептом крема?"),
    (3, "elena", "Конечно! Сметана 20%, сгущёнка и немного лимонной цедры. Главное — дать постоять ночь."),
    (4, "anna", "Дима, поздравляю! 🔥"),
    (4, "boris", "Машина! Готовимся к Белым ночам вместе?"),
    (7, "maria", "Спасибо, очень полезно! Можно вопрос про БЦЖ?"),
    (9, "pavel", "Наталья Петровна, подкармливайте золой — у меня помогает."),
]

REACTIONS = {1: ["boris", "maria", "sergey", "tatiana", "dmitry", "alexey", "olga"], 0: ["anna", "boris", "tatiana", "alexey"],
             3: ["maria", "olga", "natasha", "anna"], 4: ["anna", "boris", "alexey"], 6: ["anna", "olga", "sergey"],
             7: ["maria", "elena", "natasha", "tatiana"], 2: ["alexey", "olga"], 8: ["maria", "dmitry"], 14: ["anna", "boris", "tatiana"]}
REACTION_TYPES = ["like", "love", "like", "wow", "like", "haha", "love"]

MESSAGES = [
    ("boris", "anna", [
        ("boris", "Привет! Как съездили на Алтай?"),
        ("anna", "Привет! Это было лучшее путешествие за последние годы 😍"),
        ("anna", "Выложила фото, посмотри"),
        ("boris", "Уже увидел, огонь! В следующий раз едем все вместе"),
        ("anna", "Договорились! Кстати, как твой хлеб на закваске?"),
    ]),
    ("maria", "anna", [
        ("maria", "Анечка, привет! Ты в субботу свободна? Идём в театр?"),
        ("anna", "Привет! Да, с удовольствием. Что смотрим?"),
        ("maria", "«Вишнёвый сад» в Художественном. Взяла два билета 🎭"),
    ]),
    ("tatiana", "anna", [
        ("tatiana", "Аня, привет! Расскажи подробнее про маршрут по Алтаю?"),
    ]),
]


def reset():
    if config.DB_PATH.exists():
        for suffix in ("", "-wal", "-shm"):
            p = config.DB_PATH.with_name(config.DB_PATH.name + suffix)
            p.unlink(missing_ok=True)
    if config.UPLOAD_DIR.exists():
        shutil.rmtree(config.UPLOAD_DIR)
    config.UPLOAD_DIR.mkdir(parents=True, exist_ok=True)


def image(kind: str, seed: int, preset: str = "post") -> dict:
    data = {"landscape": landscape, "food": food, "city": city}[kind](seed)
    return _process(data, preset)


def main():
    if "--reset" in sys.argv:
        reset()
    db.connect()
    if db.value("SELECT count(*) FROM users"):
        print("База уже заполнена. Для пересоздания: python -m scripts.seed --reset")
        return

    pw = hash_password(PASSWORD)
    ids = {}
    for i, (un, name, city_, bio, work, edu, bd, has_avatar) in enumerate(USERS):
        uid = db.run("INSERT INTO users (email, password_hash, email_verified_at, consent_at, created_at) VALUES (?,?,?,?,?)",
                     (f"{un}@example.com", pw, ts(24 * 60), ts(24 * 60), ts(24 * (90 - i * 5)))).lastrowid
        ava = _process(avatar_img(i), "avatar")["path"] if has_avatar else None
        cov = _process(cover_img(i), "cover")["path"] if i in (0, 1, 2, 7) else None
        db.run("""INSERT INTO profiles (user_id, username, name, avatar, cover, bio, city, birth_date, education, work)
                  VALUES (?,?,?,?,?,?,?,?,?,?)""", (uid, un, name, ava, cov, bio, city_, bd, edu, work))
        ids[un] = uid
    db.run("UPDATE users SET is_admin=1 WHERE id=?", (ids["anna"],))

    for a, b in FRIENDS:
        db.run("INSERT INTO friendships (requester_id, addressee_id, status, accepted_at) VALUES (?,?, 'accepted', ?)", (ids[a], ids[b], ts(500)))
        db.run("INSERT OR IGNORE INTO follows (follower_id, followee_id) VALUES (?,?),(?,?)", (ids[a], ids[b], ids[b], ids[a]))
    for a, b in PENDING:
        db.run("INSERT INTO friendships (requester_id, addressee_id, status) VALUES (?,?, 'pending')", (ids[a], ids[b]))
        db.run("INSERT OR IGNORE INTO follows (follower_id, followee_id) VALUES (?,?)", (ids[a], ids[b]))
        db.run("INSERT INTO notifications (user_id, actor_id, type, created_at) VALUES (?,?, 'friend_request', ?)", (ids[b], ids[a], ts(2)))
    for a, b in FOLLOWS:
        db.run("INSERT OR IGNORE INTO follows (follower_id, followee_id) VALUES (?,?)", (ids[a], ids[b]))

    # записи вставляем от старых к новым, чтобы id росли вместе со временем
    order = sorted(range(len(POSTS)), key=lambda i: -POSTS[i][1])
    post_ids = {}
    for i in order:
        author, hours, text, images, vis = POSTS[i]
        pid = db.run("INSERT INTO posts (author_id, text, visibility, created_at) VALUES (?,?,?,?)",
                     (ids[author], text, vis, ts(hours))).lastrowid
        post_ids[i] = pid
        for pos, (kind, seed) in enumerate(images):
            m = image(kind, seed)
            db.run("INSERT INTO post_media (post_id, path, thumb, width, height, alt, position) VALUES (?,?,?,?,?,?,?)",
                   (pid, m["path"], m["thumb"], m["width"], m["height"], "", pos))
        for tag in extract_hashtags(text):
            db.run("INSERT OR IGNORE INTO hashtags (tag) VALUES (?)", (tag,))
            hid = db.value("SELECT id FROM hashtags WHERE tag=?", (tag,))
            db.run("INSERT OR IGNORE INTO post_hashtags VALUES (?,?)", (pid, hid))
        for un in extract_mentions(text):
            if un in ids:
                db.run("INSERT OR IGNORE INTO mentions VALUES (?,?)", (pid, ids[un]))
                db.run("INSERT INTO notifications (user_id, actor_id, type, post_id, created_at) VALUES (?,?, 'mention', ?, ?)",
                       (ids[un], ids[author], pid, ts(hours)))

    # репосты и цитата
    db.run("INSERT INTO posts (author_id, text, visibility, quote_of, is_repost, created_at) VALUES (?, '', 'public', ?, 1, ?)",
           (ids["boris"], post_ids[1], ts(2.5)))
    db.run("INSERT INTO posts (author_id, text, visibility, quote_of, created_at) VALUES (?,?, 'public', ?, ?)",
           (ids["alexey"], "Вот это я понимаю — отпуск! Анна, какие объективы брала? #фото", post_ids[1], ts(2.2)))
    db.run("INSERT INTO posts (author_id, text, visibility, quote_of, is_repost, created_at) VALUES (?, '', 'public', ?, 1, ?)",
           (ids["anna"], post_ids[7], ts(18)))

    for pi, un, text in COMMENTS:
        pid = post_ids[pi]
        author = db.value("SELECT author_id FROM posts WHERE id=?", (pid,))
        hours = POSTS[pi][1] - 0.3 - random.random() * 0.5
        cid = db.run("INSERT INTO comments (post_id, author_id, text, created_at) VALUES (?,?,?,?)", (pid, ids[un], text, ts(max(hours, 0.05)))).lastrowid
        if author != ids[un]:
            db.run("INSERT INTO notifications (user_id, actor_id, type, post_id, comment_id, created_at, read_at) VALUES (?,?, 'comment', ?, ?, ?, ?)",
                   (author, ids[un], pid, cid, ts(max(hours, 0.05)), None if pi == 1 else ts(0)))
    # ответ на комментарий (вложенность)
    first = db.value("SELECT id FROM comments WHERE post_id=? ORDER BY id LIMIT 1", (post_ids[1],))
    db.run("INSERT INTO comments (post_id, author_id, parent_id, text, created_at) VALUES (?,?,?,?,?)",
           (post_ids[1], ids["anna"], first, "@boris в следующий раз точно вместе!", ts(2.4)))

    for pi, users in REACTIONS.items():
        pid = post_ids[pi]
        author = db.value("SELECT author_id FROM posts WHERE id=?", (pid,))
        for j, un in enumerate(users):
            rtype = REACTION_TYPES[(j + pi) % len(REACTION_TYPES)]
            db.run("INSERT OR IGNORE INTO reactions (post_id, user_id, type, created_at) VALUES (?,?,?,?)", (pid, ids[un], rtype, ts(POSTS[pi][1] - .2)))
            if author != ids[un]:
                db.run("INSERT INTO notifications (user_id, actor_id, type, post_id, extra, created_at, read_at) VALUES (?,?, 'reaction', ?, ?, ?, ?)",
                       (author, ids[un], pid, f'{{"reaction": "{rtype}"}}', ts(POSTS[pi][1] - .2), None if pi == 1 and j < 3 else ts(0)))
    db.run("INSERT OR IGNORE INTO bookmarks (user_id, post_id) VALUES (?,?),(?,?)", (ids["anna"], post_ids[7], ids["anna"], post_ids[3]))

    for a, b, msgs in MESSAGES:
        key = f"{min(ids[a], ids[b])}:{max(ids[a], ids[b])}"
        conv = db.run("INSERT INTO conversations (direct_key) VALUES (?)", (key,)).lastrowid
        db.run("INSERT INTO conversation_members (conversation_id, user_id) VALUES (?,?),(?,?)", (conv, ids[a], conv, ids[b]))
        last = None
        for k, (sender, text) in enumerate(msgs):
            t = ts(len(msgs) - k + (0 if a == "boris" else 3 if a == "maria" else 0.5))
            last = db.run("INSERT INTO messages (conversation_id, sender_id, text, created_at) VALUES (?,?,?,?)", (conv, ids[sender], text, t)).lastrowid
            db.run("UPDATE conversations SET last_message_at=? WHERE id=?", (t, conv))
        # собеседник прочитал всё, Анна — всё кроме последнего сообщения от Татьяны
        db.run("UPDATE conversation_members SET last_read_id=? WHERE conversation_id=? AND user_id=?", (last, conv, ids[a]))
        if a != "tatiana":
            db.run("UPDATE conversation_members SET last_read_id=? WHERE conversation_id=? AND user_id=?", (last, conv, ids[b]))

    print(f"Готово: {len(USERS)} пользователей, {db.value('SELECT count(*) FROM posts')} записей.")
    print("Вход: anna@example.com / demo12345 (или любой другой логин из списка: boris, maria, dmitry …)")


if __name__ == "__main__":
    main()
