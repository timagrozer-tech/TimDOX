"""Constellation — цифровая вселенная профиля: внешние миры (соцсети, игры, код, медиа)
и миры Yarko. Хранится в profiles.constellation как JSON {style, items:[{kind, value}]}.

Сервер — единственный источник правды о ссылках: клиент присылает «вид + ник или адрес»,
сервер сам строит адрес по белому списку доменов. Произвольных ссылок, кроме «Сайта», нет."""
import json
import re

from . import db

STYLES = ("cosmos", "neural", "crystal")
MAX_ITEMS = 12

HANDLE = re.compile(r"^[A-Za-z0-9_.\-]{1,64}$")
TAG = re.compile(r"^[\w .#\-]{2,40}$", re.UNICODE)

# вид: (название, группа, шаблон адреса или None — только ник, допустимые домены для готовой ссылки)
KINDS = {
    "telegram": ("Telegram", "social", "https://t.me/{h}", ("t.me", "telegram.me")),
    "discord": ("Discord", "social", None, ("discord.gg", "discord.com")),
    "instagram": ("Instagram", "social", "https://instagram.com/{h}", ("instagram.com",)),
    "tiktok": ("TikTok", "social", "https://www.tiktok.com/@{h}", ("tiktok.com",)),
    "x": ("X", "social", "https://x.com/{h}", ("x.com", "twitter.com")),
    "threads": ("Threads", "social", "https://www.threads.net/@{h}", ("threads.net",)),
    "vk": ("VK", "social", "https://vk.com/{h}", ("vk.com", "vk.ru")),
    "steam": ("Steam", "games", "https://steamcommunity.com/id/{h}", ("steamcommunity.com",)),
    "xbox": ("Xbox", "games", None, ()),
    "playstation": ("PlayStation", "games", None, ()),
    "epic": ("Epic Games", "games", None, ()),
    "riot": ("Riot Games", "games", None, ()),
    "github": ("GitHub", "dev", "https://github.com/{h}", ("github.com",)),
    "gitlab": ("GitLab", "dev", "https://gitlab.com/{h}", ("gitlab.com",)),
    "portfolio": ("Портфолио", "dev", None, ("*",)),
    "website": ("Сайт", "dev", None, ("*",)),
    "youtube": ("YouTube", "media", "https://www.youtube.com/@{h}", ("youtube.com", "youtu.be")),
    "twitch": ("Twitch", "media", "https://www.twitch.tv/{h}", ("twitch.tv",)),
    "spotify": ("Spotify", "media", None, ("open.spotify.com",)),
    "soundcloud": ("SoundCloud", "media", "https://soundcloud.com/{h}", ("soundcloud.com",)),
}
# миры Yarko считаются автоматически
KRUG_KINDS = ("network", "communities", "gallery", "collection", "stickers")

URL = re.compile(r"^https://([a-z0-9.\-]+\.[a-z]{2,})(/[^\s<>\"']*)?$", re.I)


class Invalid(ValueError):
    pass


def _host_ok(host: str, allowed: tuple) -> bool:
    host = host.lower()
    if "*" in allowed:
        return True
    return any(host == d or host.endswith("." + d) for d in allowed)


def normalize(kind: str, value: str) -> dict:
    """Вид + ник/адрес → {kind, handle, url}. Бросает Invalid с понятным текстом."""
    if kind in KRUG_KINDS:
        return {"kind": kind}
    if kind not in KINDS:
        raise Invalid("Неизвестный вид")
    label, _group, tpl, domains = KINDS[kind]
    v = (value or "").strip()
    if not v:
        raise Invalid(f"{label}: укажите ник или ссылку")
    if v.lower().startswith("http://"):
        v = "https://" + v[7:]
    if v.lower().startswith("https://"):
        m = URL.match(v)
        if not m or not domains or not _host_ok(m.group(1), domains):
            raise Invalid(f"{label}: ссылка должна вести на {', '.join(d for d in domains if d != '*') or 'этот сервис'}")
        path = (m.group(2) or "").strip("/")
        handle = path.split("/")[-1].lstrip("@")[:64] if path else m.group(1)
        return {"kind": kind, "handle": handle or m.group(1), "url": v[:300]}
    if "*" in domains or kind == "spotify":
        raise Invalid(f"{label}: нужна полная ссылка, начинающаяся с https://")
    h = v.lstrip("@")
    if tpl:
        if not HANDLE.match(h):
            raise Invalid(f"{label}: ник из латинских букв, цифр, точки, дефиса или подчёркивания")
        if kind == "steam":
            from .steam import profile_url
            return {"kind": kind, "handle": h, "url": profile_url(h)}
        return {"kind": kind, "handle": h, "url": tpl.format(h=h)}
    if not TAG.match(h):
        raise Invalid(f"{label}: от 2 до 40 символов")
    return {"kind": kind, "handle": h, "url": None}


def load(raw) -> dict:
    try:
        d = json.loads(raw or "{}")
    except (TypeError, ValueError):
        d = {}
    style = d.get("style") if d.get("style") in STYLES else "cosmos"
    items = [i for i in d.get("items") or [] if isinstance(i, dict) and (i.get("kind") in KINDS or i.get("kind") in KRUG_KINDS)]
    return {"style": style, "items": items[:MAX_ITEMS]}


def validate(payload: dict) -> dict:
    style = payload.get("style") if payload.get("style") in STYLES else "cosmos"
    items, seen = [], set()
    for it in (payload.get("items") or [])[:MAX_ITEMS]:
        if not isinstance(it, dict):
            continue
        n = normalize(str(it.get("kind") or ""), str(it.get("value") or it.get("handle") or it.get("url") or ""))
        key = (n["kind"], (n.get("handle") or "").lower())
        if key in seen:
            continue
        seen.add(key)
        items.append(n)
    return {"style": style, "items": items}


def public(uid: int, raw) -> dict:
    """То, что видит гость профиля: внешние миры + живые числа миров Yarko."""
    d = load(raw)
    stats = {}
    kinds = {i["kind"] for i in d["items"]}
    if "network" in kinds:
        from .social import friend_ids
        stats["network"] = {"friends": len(friend_ids(uid)),
                            "followers": db.value("SELECT count(*) FROM follows WHERE followee_id=?", (uid,))}
    if "communities" in kinds:
        stats["communities"] = {"count": db.value("SELECT count(*) FROM community_members WHERE user_id=? AND status='member'", (uid,))}
    if "gallery" in kinds:
        stats["gallery"] = {"count": db.value(
            "SELECT count(*) FROM post_media m JOIN posts p ON p.id=m.post_id WHERE p.author_id=?", (uid,))}
    if "collection" in kinds:
        stats["collection"] = {"count": db.value("SELECT count(*) FROM user_items WHERE user_id=?", (uid,))}
    # Sticker Planet: появляется сама, как только у человека есть своя коллекция стикеров
    st = {"packs": db.value("SELECT count(*) FROM user_sticker_packs u JOIN sticker_packs p ON p.id=u.pack_id WHERE u.user_id=? AND p.owner_id IS NOT NULL", (uid,)),
          "created": db.value("SELECT count(*) FROM sticker_packs WHERE owner_id=? AND shared=0 AND source IN ('own','lab','remix','copy','avatar3d')", (uid,))}
    st["stickers"] = db.value("SELECT count(*) FROM stickers s JOIN user_sticker_packs u ON u.pack_id=s.pack_id WHERE u.user_id=?", (uid,))
    stats["stickers"] = st
    items = list(d["items"])
    if "stickers" not in kinds and (st["packs"] or st["created"]):
        items.append({"kind": "stickers"})
    out = []
    for i in items:
        if i["kind"] in KRUG_KINDS:
            out.append({"kind": i["kind"], "stats": stats.get(i["kind"], {})})
        else:
            url = i.get("url")
            if i["kind"] == "steam" and i.get("handle"):
                from .steam import STEAMID, profile_url
                if STEAMID.match(i["handle"]):  # старые записи вели на /id/<число> — это битая ссылка
                    url = profile_url(i["handle"])
            out.append({"kind": i["kind"], "label": KINDS[i["kind"]][0], "group": KINDS[i["kind"]][1],
                        "handle": i.get("handle"), "url": url})
    return {"style": d["style"], "items": out}


# ---------------------------------------------------------------- пространство профиля (конструктор)
SPACE_MODES = ("classic", "creator", "project", "city", "professional", "gamer", "minimal")
SPACE_BLOCKS = ("about", "showcase", "constellation")


def load_space(raw) -> dict:
    try:
        d = json.loads(raw or "{}")
    except (TypeError, ValueError):
        d = {}
    mode = d.get("mode") if d.get("mode") in SPACE_MODES else "classic"
    order = [b for b in d.get("order") or [] if b in SPACE_BLOCKS]
    order += [b for b in SPACE_BLOCKS if b not in order]
    hidden = [b for b in d.get("hidden") or [] if b in SPACE_BLOCKS]
    return {"mode": mode, "order": order, "hidden": hidden}
