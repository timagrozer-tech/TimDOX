"""Музыка Круга: каталог Audius (полные треки независимых музыкантов, открытый API без ключа)
и интернет-радио (каталог Radio Browser). Запросы к источникам кэшируются в памяти.
Трек везде описывается одинаково: {key, source, id, title, artist, artwork, duration, genre, permalink, stream?, live?}."""
import json
import logging
import random
import re
import time
import urllib.parse
import urllib.request

log = logging.getLogger("krug.music")

APP = "KRUG"
AUDIUS = "https://api.audius.co/v1"
RADIO = ["https://de1.api.radio-browser.info", "https://de2.api.radio-browser.info", "https://fi1.api.radio-browser.info"]
UA = "KrugSocial/1.0 (+https://krug-social.onrender.com)"

GENRES = [  # (как в Audius, адрес в Круге, по-русски, эмодзи)
    ("Electronic", "electronic", "Электроника", "🎛️"), ("Hip-Hop/Rap", "hiphop", "Хип-хоп", "🎤"), ("Pop", "pop", "Поп", "🎧"),
    ("Rock", "rock", "Рок", "🎸"), ("Lo-Fi", "lofi", "Лоу-фай", "☕"), ("House", "house", "Хаус", "🏠"),
    ("Techno", "techno", "Техно", "⚡"), ("Ambient", "ambient", "Эмбиент", "🌌"), ("R&B/Soul", "rnb", "R&B и соул", "💜"),
    ("Jazz", "jazz", "Джаз", "🎷"), ("Alternative", "alternative", "Альтернатива", "🌀"), ("Drum & Bass", "dnb", "Драм-н-бейс", "🥁"),
    ("Soundtrack", "soundtrack", "Саундтреки", "🎬"), ("Classical", "classical", "Классика", "🎻"), ("Metal", "metal", "Метал", "🤘"),
    ("Acoustic", "acoustic", "Акустика", "🪕"),
]
GENRE_NAMES = {g for g, _, _, _ in GENRES}
GENRE_BY_SLUG = {s: (g, n, e) for g, s, n, e in GENRES}
RADIO_TAGS = [("", "Популярное"), ("pop", "Поп"), ("rock", "Рок"), ("dance", "Танцевальное"), ("electronic", "Электроника"),
              ("hip-hop", "Хип-хоп"), ("jazz", "Джаз"), ("classical", "Классика"), ("chillout", "Чилаут"), ("news", "Новости")]

_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_cache: dict[str, tuple[float, object]] = {}


class Unavailable(Exception):
    """Источник музыки не ответил."""


def _http_json(url: str, timeout: float = 8.0):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def cached(key: str, ttl: float, fn):
    hit = _cache.get(key)
    if hit and hit[0] > time.monotonic():
        return hit[1]
    try:
        val = fn()
    except Exception as e:  # сеть, формат ответа — отдаём прошлое значение, если оно было
        log.warning("Музыка: %s — %s", key, e)
        if hit:
            return hit[1]
        raise Unavailable(str(e)) from e
    _cache[key] = (time.monotonic() + ttl, val)
    if len(_cache) > 500:
        for k in sorted(_cache, key=lambda k: _cache[k][0])[:100]:
            _cache.pop(k, None)
    return val


def _https(url) -> str | None:
    return url if isinstance(url, str) and url.startswith("https://") and len(url) < 600 else None


# ---------------------------------------------------------------- Audius
def _audius(path: str, **params):
    params["app_name"] = APP
    data = _http_json(f"{AUDIUS}{path}?{urllib.parse.urlencode(params)}")
    return data.get("data") if isinstance(data, dict) else None


def _art(obj: dict, size: str = "480x480") -> str | None:
    art = obj.get("artwork") or {}
    return _https(art.get(size) or art.get("480x480") or art.get("150x150")) if isinstance(art, dict) else None


def track_from_audius(t: dict) -> dict | None:
    if not isinstance(t, dict) or not t.get("id") or t.get("is_streamable") is False or t.get("is_delete"):
        return None
    tid = str(t["id"])
    if not _ID.match(tid):
        return None
    user = t.get("user") or {}
    return {
        "key": f"audius:{tid}", "source": "audius", "id": tid,
        "title": str(t.get("title") or "Без названия")[:200],
        "artist": str(user.get("name") or user.get("handle") or "")[:120],
        "artwork": _art(t),
        "duration": int(t.get("duration") or 0),
        "genre": str(t.get("genre") or "")[:40],
        "permalink": f"https://audius.co{t['permalink']}" if str(t.get("permalink") or "").startswith("/") else None,
        "plays": int(t.get("play_count") or 0),
    }


def _tracks(items) -> list[dict]:
    out, seen = [], set()
    for t in items or []:
        tr = track_from_audius(t)
        if tr and tr["id"] not in seen:
            seen.add(tr["id"])
            out.append(tr)
    return out


def trending(genre: str = "", time_range: str = "week", limit: int = 30) -> list[dict]:
    params = {"time": time_range, "limit": 60}
    if genre:
        params["genre"] = genre
    return cached(f"trend:{genre}:{time_range}", 900, lambda: _tracks(_audius("/tracks/trending", **params)))[:limit]


def underground(limit: int = 20) -> list[dict]:
    return cached("underground", 900, lambda: _tracks(_audius("/tracks/trending/underground", limit=40)))[:limit]


def search(q: str, limit: int = 30) -> list[dict]:
    q = q.strip()[:80]
    if not q:
        return []
    return cached(f"search:{q.lower()}", 300, lambda: _tracks(_audius("/tracks/search", query=q, limit=50)))[:limit]


def playlist_from_audius(p: dict) -> dict | None:
    if not isinstance(p, dict) or not p.get("id") or not _ID.match(str(p["id"])):
        return None
    user = p.get("user") or {}
    return {"id": str(p["id"]), "title": str(p.get("playlist_name") or "Подборка")[:200],
            "artist": str(user.get("name") or "")[:120], "artwork": _art(p), "count": int(p.get("track_count") or 0)}


def playlists(limit: int = 12) -> list[dict]:
    def load():
        items = [playlist_from_audius(p) for p in (_audius("/playlists/trending", time="week", limit=30) or [])]
        return [p for p in items if p and p["count"] >= 3]
    return cached("playlists", 1800, load)[:limit]


def playlist(pid: str) -> dict:
    if not _ID.match(pid):
        raise Unavailable("bad id")

    def load():
        info = _audius(f"/playlists/{pid}")
        info = playlist_from_audius(info[0] if isinstance(info, list) and info else info or {})
        return {"playlist": info, "tracks": _tracks(_audius(f"/playlists/{pid}/tracks"))}
    return cached(f"playlist:{pid}", 1800, load)


def audius_track(tid: str) -> dict | None:
    if not _ID.match(tid):
        return None
    return cached(f"track:{tid}", 3600, lambda: track_from_audius(_audius(f"/tracks/{tid}") or {}))


# ---------------------------------------------------------------- Радио
def _radio(path: str, **params):
    last = None
    for host in RADIO:
        try:
            return _http_json(f"{host}/json{path}?{urllib.parse.urlencode(params)}", timeout=12)
        except Exception as e:  # зеркала равноправны — пробуем следующее
            log.info("Радио: %s не ответил — %s", host, e)
            last = e
    raise last or Unavailable("radio")


def station(s: dict) -> dict | None:
    stream = _https(s.get("url_resolved") or s.get("url"))
    uuid = str(s.get("stationuuid") or "")
    if not stream or not _ID.match(uuid):
        return None
    tags = [t.strip() for t in str(s.get("tags") or "").split(",") if t.strip()][:3]
    return {"key": f"radio:{uuid}", "source": "radio", "id": uuid, "title": str(s.get("name") or "Радио").strip()[:120],
            "artist": ", ".join(tags) or "Интернет-радио", "artwork": _https(s.get("favicon")), "duration": 0,
            "stream": stream, "live": True, "genre": tags[0] if tags else "", "permalink": _https(s.get("homepage"))}


def radio(tag: str = "", limit: int = 40, name: str = "") -> list[dict]:
    params = {"hidebroken": "true", "order": "clickcount", "reverse": "true", "limit": 100}
    if name:
        params["name"] = name[:60]
    else:
        params["countrycode"] = "RU"
    if tag:
        params["tag"] = tag[:30]

    def load():
        out, seen = [], set()
        for s in _radio("/stations/search", **params) or []:
            st = station(s)
            if st and st["title"].lower() not in seen:
                seen.add(st["title"].lower())
                out.append(st)
        return out
    return cached(f"radio:{tag}:{name.lower()}", 3600, load)[:limit]


def radio_station(uuid: str) -> dict | None:
    if not _ID.match(uuid):
        return None

    def load():
        items = _radio(f"/stations/byuuid/{uuid}")
        return station(items[0]) if items else None
    return cached(f"station:{uuid}", 3600, load)


# ---------------------------------------------------------------- Общее
def resolve(key: str) -> dict | None:
    """Проверенные данные трека по ключу вида source:id — клиенту на слово не верим."""
    source, _, tid = str(key or "").partition(":")
    try:
        if source == "audius":
            return audius_track(tid)
        if source == "radio":
            return radio_station(tid)
    except Unavailable:
        return None
    return None


def wave(genres: list[str], exclude: set[str], limit: int = 40) -> list[dict]:
    """«Волна Круга»: смесь трендов любимых жанров и новых открытий."""
    pool: list[dict] = []
    for g in (genres or [])[:3]:
        try:
            pool += trending(g, "month", 40)
        except Unavailable:
            pass
    for loader in (lambda: trending("", "week", 40), lambda: underground(30)):
        try:
            pool += loader()
        except Unavailable:
            pass
    seen, out = set(), []
    random.shuffle(pool)
    for t in pool:
        if t["key"] in seen or t["key"] in exclude:
            continue
        seen.add(t["key"])
        out.append(t)
    return out[:limit]


def public(track: dict | None) -> dict | None:
    """Сохранённая копия трека (в лайках и записях) — только разрешённые поля."""
    if not track:
        return None
    keep = ("key", "source", "id", "title", "artist", "artwork", "duration", "genre", "permalink", "stream", "live")
    return {k: track.get(k) for k in keep if track.get(k) is not None}
