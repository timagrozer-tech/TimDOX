"""Превью ссылок (Open Graph / Twitter Card). Сайт — SPA, поэтому мета-теги подставляет сервер:
ссылка на профиль, запись или сообщество в Telegram/VK/WhatsApp показывается карточкой с именем, текстом и фото.

Только открытое: публичный профиль, запись «для всех» от автора с открытым профилем, открытое сообщество.
Закрытое получает общую карточку Yarko — по ссылке нельзя узнать, что внутри."""
import re
from html import escape
from pathlib import Path

from . import config, db, social

DEFAULT_TITLE = "Yarko — социальная сеть нового поколения"
DEFAULT_DESC = "Цифровая экосистема нового поколения: друзья и сообщества, переписка, ИИ-помощники, цифровой город и созвездие ваших связей."
_tpl = {"mtime": 0.0, "html": ""}


def _index() -> str:
    p = Path(config.STATIC_DIR) / "index.html"
    m = p.stat().st_mtime
    if m != _tpl["mtime"]:
        _tpl.update(mtime=m, html=p.read_text("utf-8"))
    return _tpl["html"]


def _abs(url: str | None) -> str | None:
    if not url:
        return None
    return url if url.startswith("https://") else f"{config.APP_URL}{url if url.startswith('/') else '/' + url}"


def _clip(text: str, n: int = 200) -> str:
    t = re.sub(r"\s+", " ", text or "").strip()
    return t if len(t) <= n else t[: n - 1].rsplit(" ", 1)[0] + "…"


def _plural(n, forms):
    a, b = abs(n) % 100, abs(n) % 10
    return forms[2] if 10 < a < 20 else forms[1] if 1 < b < 5 else forms[0] if b == 1 else forms[2]


def meta_for(path: str) -> dict:
    """Путь страницы → {title, desc, image, large, type}. Ничего закрытого не раскрывает."""
    out = {"title": DEFAULT_TITLE, "desc": DEFAULT_DESC, "image": _abs("/static/img/og.png"), "large": True, "type": "website"}
    try:
        m = re.match(r"^/u/([A-Za-z0-9_.]{1,40})/?$", path)
        if m:
            p = db.one("""SELECT p.user_id, p.username, p.name, p.bio, p.avatar, p.profile_visibility, u.is_banned
                          FROM profiles p JOIN users u ON u.id = p.user_id WHERE p.username=?""", (social.resolve_username(m.group(1)),))
            if p and not p["is_banned"]:
                out["title"] = f"{p['name']} (@{p['username']}) — Yarko"
                out.update(name=p["name"], username=p["username"])
                if p["profile_visibility"] == "public":
                    out["public"] = True
                    friends = db.value("SELECT count(*) FROM follows WHERE followee_id=?", (p["user_id"],)) or 0
                    stats = f"{friends} {_plural(friends, ('подписчик', 'подписчика', 'подписчиков'))} в Yarko"
                    out["desc"] = _clip(f"{p['bio']} · {stats}" if p["bio"] else stats)
                    if p["avatar"]:
                        out.update(image=_abs(p["avatar"]), large=False)
                else:
                    out["desc"] = "Закрытый профиль в Yarko. Войдите, чтобы попросить доступ."
                    out["closed"] = True
                out["type"] = "profile"
            return out
        m = re.match(r"^/post/(\d{1,12})/?$", path)
        if m:
            r = db.one("""SELECT po.id, po.text, po.visibility, po.circle_id, pr.name, pr.username, pr.profile_visibility, u.is_banned
                          FROM posts po JOIN profiles pr ON pr.user_id = po.author_id JOIN users u ON u.id = po.author_id
                          WHERE po.id=?""", (int(m.group(1)),))
            if r and not r["is_banned"] and r["visibility"] == "public" and not r["circle_id"] and r["profile_visibility"] == "public":
                out["title"] = f"{r['name']} в Yarko"
                out.update(name=r["name"], username=r["username"])
                out["desc"] = _clip(r["text"]) or f"Запись @{r['username']}"
                img = db.value("SELECT path FROM post_media WHERE post_id=? ORDER BY position LIMIT 1", (r["id"],))
                if img:
                    out["image"] = _abs(img)
                out["type"] = "article"
            return out
        m = re.match(r"^/c/([A-Za-z0-9_\-]{1,60})/?$", path)
        if m:
            c = db.one("SELECT id, name, description, avatar, cover, is_private FROM communities WHERE slug=?", (m.group(1),))
            if c:
                out["title"] = f"{c['name']} — сообщество в Yarko"
                if not c["is_private"]:
                    n = db.value("SELECT count(*) FROM community_members WHERE community_id=? AND status='member'", (c["id"],)) or 0
                    out["desc"] = _clip(f"{c['description'] or ''} · {n} {_plural(n, ('участник', 'участника', 'участников'))}".strip(" ·"))
                    if c["cover"] or c["avatar"]:
                        out["image"] = _abs(c["cover"] or c["avatar"])
                        out["large"] = bool(c["cover"])
                else:
                    out["desc"] = "Закрытое сообщество в Yarko."
                    out["closed"] = True
            return out
    except Exception:  # превью никогда не должно ронять страницу
        return {"title": DEFAULT_TITLE, "desc": DEFAULT_DESC, "image": _abs("/static/img/og.png"), "large": True, "type": "website"}
    return out


# Страницы, которые имеет смысл показывать в поиске; остальное (лента, чаты, настройки) — личное, его не индексируем
INDEXABLE = re.compile(r"^/($|u/|post/|c/|privacy/?$|terms/?$|login/?$|register/?$)")
SITE_DESC_LONG = ("Yarko (Ярко) — российская социальная сеть: лента друзей и сообществ, клипы — короткие вертикальные видео, "
                  "переписка и видеозвонки, музыка, истории, стикеры, ИИ-помощники, цифровой город и «созвездие» связей. "
                  "Работает в браузере на телефоне и компьютере, без VPN.")


def _jsonld(path: str, m: dict, url: str) -> list[dict]:
    """Структурированные данные schema.org: поисковики и ИИ-поиск понимают, что это за страница"""
    site = config.APP_URL
    if path in ("", "/"):
        return [{"@context": "https://schema.org", "@type": "WebSite", "name": "Yarko", "alternateName": "Ярко", "url": site + "/",
                 "inLanguage": "ru", "description": DEFAULT_DESC,
                 "potentialAction": {"@type": "SearchAction", "target": site + "/search?q={search_term_string}",
                                     "query-input": "required name=search_term_string"}},
                {"@context": "https://schema.org", "@type": "Organization", "name": "Yarko", "url": site + "/",
                 "logo": site + "/static/img/icon-512.png"}]
    if m["type"] == "profile" and m.get("public"):
        return [{"@context": "https://schema.org", "@type": "ProfilePage", "url": url, "inLanguage": "ru",
                 "mainEntity": {"@type": "Person", "name": m.get("name"), "alternateName": "@" + (m.get("username") or ""),
                                "description": m["desc"], "image": m["image"], "url": url}}]
    if m["type"] == "article":
        return [{"@context": "https://schema.org", "@type": "SocialMediaPosting", "url": url, "inLanguage": "ru",
                 "headline": _clip(m["desc"], 110), "articleBody": m["desc"], "image": m["image"],
                 "author": {"@type": "Person", "name": m.get("name"), "url": f"{site}/u/{m.get('username')}"}}]
    return []


# Версия сборки: скрипты и стили отдаются по адресу /static/v/<версия>/… и кэшируются браузером навсегда —
# повторные визиты не делают ни одного запроса за ~150 модулями, а после выкладки адрес меняется сам
import os as _os
import time as _time
BUILD = (_os.environ.get("RENDER_GIT_COMMIT") or _os.environ.get("YARKO_COMMIT") or str(int(_time.time())))[:12]


def render(path: str) -> str:
    import json
    html = _index()
    html = re.sub(r'/static/(js/app\.js|css/app\.css|css/orbit\.css)\?v=[\w.]+', lambda m_: f"/static/v/{BUILD}/{m_.group(1)}", html)
    m = meta_for(path)
    url = f"{config.APP_URL}{path}"
    e = lambda s: escape(s or "", quote=True)  # noqa: E731
    ld = _jsonld(path, m, url)
    index = bool(INDEXABLE.match(path)) and not m.get("closed")
    tags = "\n  ".join([
        "" if index else '<meta name="robots" content="noindex">',
        *['<script type="application/ld+json">' + json.dumps(x, ensure_ascii=False).replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026") + "</script>" for x in ld],
        f'<meta property="og:site_name" content="Yarko">',
        f'<meta property="og:type" content="{e(m["type"])}">',
        f'<meta property="og:title" content="{e(m["title"])}">',
        f'<meta property="og:description" content="{e(m["desc"])}">',
        f'<meta property="og:url" content="{e(url)}">',
        f'<meta property="og:locale" content="ru_RU">',
        f'<meta property="og:image" content="{e(m["image"])}">' if m["image"] else "",
        f'<meta name="twitter:card" content="{"summary_large_image" if m["large"] else "summary"}">',
        f'<meta name="twitter:title" content="{e(m["title"])}">',
        f'<meta name="twitter:description" content="{e(m["desc"])}">',
        f'<link rel="canonical" href="{e(url)}">',
    ])
    html = re.sub(r"<title>[^<]*</title>", f"<title>{e(m['title'])}</title>", html, count=1)
    html = re.sub(r'<meta name="description" content="[^"]*">', f'<meta name="description" content="{e(m["desc"])}">', html, count=1)
    # текст страницы без JavaScript: его читают поисковики и ИИ-краулеры (приложение потом рисует страницу само)
    heading = m["title"].replace(" — Yarko", "") if m["title"] != DEFAULT_TITLE else "Yarko — социальная сеть нового поколения"
    body = SITE_DESC_LONG if path in ("", "/") else m["desc"]
    nos = (f'<noscript><main class="ssr"><h1>{e(heading)}</h1><p>{e(body)}</p>'
           f'<p><a href="/register">Зарегистрироваться в Yarko</a> · <a href="/login">Войти</a></p></main></noscript>')
    html = html.replace('<div id="app">', nos + '\n  <div id="app">', 1)
    return html.replace("</head>", f"  {tags}\n</head>", 1)


def sitemap() -> str:
    """Карта сайта: главная, открытые профили, открытые сообщества и свежие открытые записи"""
    site = config.APP_URL
    urls = [(site + "/", None), (site + "/privacy", None), (site + "/terms", None)]
    try:
        for r in db.all("""SELECT p.username FROM profiles p JOIN users u ON u.id = p.user_id
                           WHERE p.profile_visibility='public' AND u.is_banned=0 ORDER BY p.user_id LIMIT 5000"""):
            urls.append((f"{site}/u/{r['username']}", None))
        for r in db.all("SELECT slug FROM communities WHERE is_private=0 ORDER BY id LIMIT 2000"):
            urls.append((f"{site}/c/{r['slug']}", None))
        for r in db.all("""SELECT po.id, po.created_at FROM posts po JOIN profiles pr ON pr.user_id = po.author_id
                           JOIN users u ON u.id = po.author_id
                           WHERE po.visibility='public' AND po.circle_id IS NULL AND pr.profile_visibility='public' AND u.is_banned=0
                           ORDER BY po.id DESC LIMIT 1000"""):
            urls.append((f"{site}/post/{r['id']}", (r["created_at"] or "")[:10] or None))
    except Exception:  # noqa: BLE001
        pass
    items = "".join(f"<url><loc>{escape(u)}</loc>{f'<lastmod>{d}</lastmod>' if d else ''}</url>" for u, d in urls)
    return f'<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">{items}</urlset>'


def llms_txt() -> str:
    """Краткое описание для ИИ-ассистентов и ИИ-поиска (формат llms.txt)"""
    site = config.APP_URL
    return (f"# Yarko (Ярко)\n\n> {SITE_DESC_LONG}\n\n"
            "## Что есть в Yarko\n"
            "- Лента записей друзей и сообществ, реакции, комментарии, репосты\n"
            "- Клипы — короткие вертикальные видео до 90 секунд\n"
            "- Личные и групповые чаты, голосовые сообщения, аудио- и видеозвонки\n"
            "- Музыка: каталог независимых исполнителей и интернет-радио\n"
            "- Истории, стикеры, ИИ-помощники, цифровой город, коллекции\n\n"
            "## Ссылки\n"
            f"- [Главная]({site}/)\n- [Регистрация]({site}/register)\n- [Вход]({site}/login)\n"
            f"- [Политика конфиденциальности]({site}/privacy)\n- [Пользовательское соглашение]({site}/terms)\n"
            f"- [Карта сайта]({site}/sitemap.xml)\n")
