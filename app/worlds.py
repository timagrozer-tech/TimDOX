"""Живые миры Созвездия: мини-профили GitHub и Telegram (Steam — в steam.py).

Как и со Steam: сервер ходит только за ником, который владелец сам вписал в Созвездие, только на
фиксированные адреса сервиса, ответ кешируется (час при успехе, 3 минуты при сбое). Ссылки и картинки
пропускаются только с доменов самого сервиса. Ключей API не нужно."""
import json
import logging
import re
import threading
import time
import urllib.request
from html import unescape

log = logging.getLogger("krug.worlds")

GH_LOGIN = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$")
TG_NAME = re.compile(r"^[A-Za-z][A-Za-z0-9_]{3,31}$")
TTL_OK, TTL_FAIL = 3600, 180
MAX_BYTES = 768 * 1024

_cache: dict[str, tuple[float, dict]] = {}
_lock = threading.Lock()


def _safe(url, hosts):
    m = re.match(r"^https://([a-z0-9.\-]+)(/[^\s\"'<>]*)?$", (url or "").strip(), re.I)
    if not m:
        return None
    host = m.group(1).lower()
    return url.strip() if any(host == d or host.endswith("." + d) for d in hosts) else None


def _get(url: str, accept: str = "*/*") -> bytes:
    req = urllib.request.Request(url, headers={"user-agent": "KrugConstellation/1.0 (+https://krug-social.onrender.com)",
                                               "accept": accept, "accept-language": "ru,en;q=0.8"})
    with urllib.request.urlopen(req, timeout=6) as resp:
        return resp.read(MAX_BYTES)


def _cached(key: str, fn):
    now = time.time()
    with _lock:
        hit = _cache.get(key)
    if hit and now - hit[0] < (TTL_OK if hit[1].get("ok") else TTL_FAIL):
        return hit[1]
    try:
        data = fn()
    except Exception as e:  # сеть, лимиты, разметка поменялась — показываем обычную карточку
        log.info("world %s: %s", key, e)
        data = {"ok": False, "reason": "unavailable"}
    with _lock:
        if len(_cache) > 4000:
            _cache.clear()
        _cache[key] = (now, data)
    return data


# ---------------------------------------------------------------- GitHub
GH_HOSTS = ("github.com",)
GH_IMG = ("githubusercontent.com",)


def parse_github(user: dict, repos: list) -> dict:
    if not isinstance(user, dict) or not user.get("login"):
        return {"ok": False, "reason": "not_found"}
    top = sorted([r for r in repos if isinstance(r, dict) and not r.get("fork")],
                 key=lambda r: (r.get("stargazers_count") or 0, r.get("pushed_at") or ""), reverse=True)[:3]
    return {
        "ok": True,
        "login": str(user["login"])[:40],
        "name": str(user.get("name") or user["login"])[:80],
        "avatar": _safe(user.get("avatar_url"), GH_IMG),
        "bio": str(user.get("bio") or "")[:200],
        "location": str(user.get("location") or "")[:60],
        "repos": int(user.get("public_repos") or 0),
        "followers": int(user.get("followers") or 0),
        "following": int(user.get("following") or 0),
        "since": str(user.get("created_at") or "")[:4],
        "url": _safe(user.get("html_url"), GH_HOSTS) or f"https://github.com/{user['login']}",
        "top": [{"name": str(r.get("name"))[:60], "desc": str(r.get("description") or "")[:120],
                 "stars": int(r.get("stargazers_count") or 0), "lang": str(r.get("language") or "")[:20],
                 "url": _safe(r.get("html_url"), GH_HOSTS)} for r in top],
    }


def github(handle: str) -> dict:
    h = (handle or "").strip().lstrip("@")
    if not GH_LOGIN.match(h):
        return {"ok": False, "reason": "bad_handle"}

    def run():
        user = json.loads(_get(f"https://api.github.com/users/{h}", "application/vnd.github+json"))
        repos = json.loads(_get(f"https://api.github.com/users/{h}/repos?sort=pushed&per_page=30", "application/vnd.github+json"))
        return parse_github(user, repos if isinstance(repos, list) else [])
    return _cached("gh:" + h.lower(), run)


# ---------------------------------------------------------------- Telegram
TG_IMG = ("telesco.pe", "cdn-telegram.org", "telegram.org")


def _meta(html: str, prop: str) -> str:
    m = re.search(r'<meta\s+(?:property|name)="' + re.escape(prop) + r'"\s+content="([^"]*)"', html)
    return unescape(m.group(1)).strip() if m else ""


def parse_telegram(html: str, handle: str) -> dict:
    title = _meta(html, "og:title")
    if not title or "tgme_page_title" not in html:
        return {"ok": False, "reason": "not_found"}
    extra = ""
    m = re.search(r'<div class="tgme_page_extra">\s*([^<]+?)\s*</div>', html)
    if m:
        extra = unescape(m.group(1)).strip()
    kind = "user"
    if re.search(r"(subscribers?|подписчик)", extra, re.I):
        kind = "channel"
    elif re.search(r"(members?|участник)", extra, re.I):
        kind = "group"
    count = None
    n = re.search(r"([\d\s,. ]+)\s*(subscribers?|members?|подписчик|участник)", extra, re.I)
    if n:
        digits = re.sub(r"\D", "", n.group(1))
        count = int(digits) if digits else None
    desc = _meta(html, "og:description")
    if desc.startswith("You can contact @") or desc.startswith("Вы можете связаться"):
        desc = ""
    return {
        "ok": True,
        "handle": handle,
        "title": title[:80],
        "desc": desc[:220],
        "photo": _safe(_meta(html, "og:image"), TG_IMG),
        "type": kind,
        "count": count,
        "url": f"https://t.me/{handle}",
    }


def telegram(handle: str) -> dict:
    h = (handle or "").strip().lstrip("@")
    if not TG_NAME.match(h):
        return {"ok": False, "reason": "bad_handle"}

    def run():
        return parse_telegram(_get(f"https://t.me/{h}", "text/html").decode("utf-8", "replace"), h)
    return _cached("tg:" + h.lower(), run)


def fetch(kind: str, handle: str) -> dict:
    if kind == "steam":
        from . import steam
        return steam.fetch(handle)
    if kind == "github":
        return github(handle)
    if kind == "telegram":
        return telegram(handle)
    return {"ok": False, "reason": "unsupported"}


LIVE_KINDS = ("steam", "github", "telegram")
