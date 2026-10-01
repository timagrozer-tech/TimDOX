"""Мини-профиль Steam для мира «Steam» в Созвездии.

Берём открытую XML-страницу профиля steamcommunity.com (?xml=1) — без ключа API и без входа.
Сервер ходит туда сам и только за ником, который владелец вписал в своё Созвездие:
прокси на произвольные адреса нет. Ответ кешируется (15 минут, неудача — 2 минуты),
поэтому сотня гостей профиля — это один запрос к Steam."""
import logging
import re
import threading
import time
import urllib.request
import xml.etree.ElementTree as ET
from html import unescape

log = logging.getLogger("krug.steam")

STEAMID = re.compile(r"^7656119\d{10}$")
VANITY = re.compile(r"^[A-Za-z0-9_\-]{2,64}$")
IMG_HOSTS = ("steamstatic.com", "akamaihd.net", "steampowered.com")
LINK_HOSTS = ("steamcommunity.com", "steampowered.com")
TTL_OK, TTL_FAIL = 900, 120
MAX_BYTES = 512 * 1024

_cache: dict[str, tuple[float, dict]] = {}
_lock = threading.Lock()


def profile_path(handle: str) -> str:
    return f"profiles/{handle}" if STEAMID.match(handle) else f"id/{handle}"


def profile_url(handle: str) -> str:
    return f"https://steamcommunity.com/{profile_path(handle)}/"


def _safe(url: str | None, hosts: tuple) -> str | None:
    m = re.match(r"^https://([a-z0-9.\-]+)(/[^\s\"'<>]*)?$", (url or "").strip(), re.I)
    if not m:
        return None
    host = m.group(1).lower()
    return url.strip() if any(host == d or host.endswith("." + d) for d in hosts) else None


def _text(el, tag: str) -> str:
    x = el.find(tag)
    if x is None or x.text is None:
        return ""
    t = re.sub(r"<br\s*/?>", " · ", x.text)
    return unescape(re.sub(r"<[^>]+>", "", t)).strip()


def _num(s: str) -> float:
    try:
        return float((s or "0").replace(",", ""))
    except ValueError:
        return 0.0


def parse(xml: bytes | str, handle: str) -> dict:
    """XML профиля → то, что показываем гостю. Только безопасные поля и ссылки на домены Steam."""
    root = ET.fromstring(xml)
    if root.tag != "profile":
        return {"ok": False, "reason": "not_found"}
    privacy = _text(root, "privacyState") or "public"
    state = _text(root, "onlineState") or "offline"
    out = {
        "ok": True,
        "id": _text(root, "steamID64"),
        "name": _text(root, "steamID")[:64] or handle,
        "avatar": _safe(_text(root, "avatarFull") or _text(root, "avatarMedium"), IMG_HOSTS),
        "state": state if state in ("online", "offline", "in-game") else "offline",
        "status": _text(root, "stateMessage")[:80],
        "private": privacy != "public",
        "since": _text(root, "memberSince")[:40],
        "location": _text(root, "location")[:60],
        "url": profile_url(_text(root, "steamID64") or handle),
        "vac": _text(root, "vacBanned") == "1",
        "playing": None,
        "games": [],
    }
    ig = root.find("inGameInfo")
    if ig is not None and _text(ig, "gameName"):
        out["playing"] = {"name": _text(ig, "gameName")[:80], "logo": _safe(_text(ig, "gameLogo"), IMG_HOSTS),
                          "link": _safe(_text(ig, "gameLink"), LINK_HOSTS)}
    for g in root.findall("mostPlayedGames/mostPlayedGame")[:3]:
        name = _text(g, "gameName")
        if not name:
            continue
        out["games"].append({
            "name": name[:80],
            "logo": _safe(_text(g, "gameLogo") or _text(g, "gameIcon"), IMG_HOSTS),
            "link": _safe(_text(g, "gameLink"), LINK_HOSTS),
            "recent": round(_num(_text(g, "hoursPlayed")), 1),
            "total": round(_num(_text(g, "hoursOnRecord"))),
        })
    return out


def _download(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"user-agent": "Mozilla/5.0 (KrugConstellation)", "accept-language": "ru,en;q=0.8"})
    with urllib.request.urlopen(req, timeout=6) as resp:
        return resp.read(MAX_BYTES)


def fetch(handle: str) -> dict:
    """Синхронно (вызывать из пула потоков). Никогда не бросает: при сбое — {"ok": False}."""
    handle = (handle or "").strip()
    if not (STEAMID.match(handle) or VANITY.match(handle)):
        return {"ok": False, "reason": "bad_handle"}
    key = handle.lower()
    now = time.time()
    with _lock:
        hit = _cache.get(key)
    if hit and now - hit[0] < (TTL_OK if hit[1].get("ok") else TTL_FAIL):
        return hit[1]
    try:
        data = parse(_download(profile_url(handle) + "?xml=1"), handle)
    except Exception as e:  # сеть, таймаут, битый XML — показываем обычную карточку
        log.info("steam %s: %s", handle, e)
        data = {"ok": False, "reason": "unavailable"}
    with _lock:
        if len(_cache) > 2000:
            _cache.clear()
        _cache[key] = (now, data)
    return data
