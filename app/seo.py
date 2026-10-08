"""Превью ссылок (Open Graph / Twitter Card). Сайт — SPA, поэтому мета-теги подставляет сервер:
ссылка на профиль, запись или сообщество в Telegram/VK/WhatsApp показывается карточкой с именем, текстом и фото.

Только открытое: публичный профиль, запись «для всех» от автора с открытым профилем, открытое сообщество.
Закрытое получает общую карточку QEVI — по ссылке нельзя узнать, что внутри."""
import re
from html import escape
from pathlib import Path

from . import config, db, social

DEFAULT_TITLE = "QEVI — социальная сеть нового поколения"
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
                out["title"] = f"{p['name']} (@{p['username']}) — QEVI"
                if p["profile_visibility"] == "public":
                    friends = db.value("SELECT count(*) FROM follows WHERE followee_id=?", (p["user_id"],)) or 0
                    stats = f"{friends} {_plural(friends, ('подписчик', 'подписчика', 'подписчиков'))} в QEVI"
                    out["desc"] = _clip(f"{p['bio']} · {stats}" if p["bio"] else stats)
                    if p["avatar"]:
                        out.update(image=_abs(p["avatar"]), large=False)
                else:
                    out["desc"] = "Закрытый профиль в QEVI. Войдите, чтобы попросить доступ."
                out["type"] = "profile"
            return out
        m = re.match(r"^/post/(\d{1,12})/?$", path)
        if m:
            r = db.one("""SELECT po.id, po.text, po.visibility, po.circle_id, pr.name, pr.username, pr.profile_visibility, u.is_banned
                          FROM posts po JOIN profiles pr ON pr.user_id = po.author_id JOIN users u ON u.id = po.author_id
                          WHERE po.id=?""", (int(m.group(1)),))
            if r and not r["is_banned"] and r["visibility"] == "public" and not r["circle_id"] and r["profile_visibility"] == "public":
                out["title"] = f"{r['name']} в QEVI"
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
                out["title"] = f"{c['name']} — сообщество в QEVI"
                if not c["is_private"]:
                    n = db.value("SELECT count(*) FROM community_members WHERE community_id=? AND status='member'", (c["id"],)) or 0
                    out["desc"] = _clip(f"{c['description'] or ''} · {n} {_plural(n, ('участник', 'участника', 'участников'))}".strip(" ·"))
                    if c["cover"] or c["avatar"]:
                        out["image"] = _abs(c["cover"] or c["avatar"])
                        out["large"] = bool(c["cover"])
                else:
                    out["desc"] = "Закрытое сообщество в QEVI."
            return out
    except Exception:  # превью никогда не должно ронять страницу
        return {"title": DEFAULT_TITLE, "desc": DEFAULT_DESC, "image": _abs("/static/img/og.png"), "large": True, "type": "website"}
    return out


def render(path: str) -> str:
    html = _index()
    m = meta_for(path)
    url = f"{config.APP_URL}{path}"
    e = lambda s: escape(s or "", quote=True)  # noqa: E731
    tags = "\n  ".join([
        f'<meta property="og:site_name" content="QEVI">',
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
    return html.replace("</head>", f"  {tags}\n</head>", 1)
