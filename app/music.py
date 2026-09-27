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


# ---------------------------------------------------------------- Российская музыка: чарт Apple Music (Россия)
# Полные версии популярных российских песен легально доступны только в платных сервисах, поэтому здесь —
# официальные 30-секундные фрагменты Apple Music и ссылки «Слушать полностью» на Яндекс Музыку, VK и Apple Music.
ITUNES = "https://itunes.apple.com"
APPLE_RSS = "https://rss.applemarketingtools.com/api/v2/ru/music/most-played"
LEGENDS = ["Кино", "Руки Вверх!", "Сплин", "Звери", "Мумий Тролль", "Любэ", "Ленинград", "Григорий Лепс",
           "Дима Билан", "Полина Гагарина", "Сергей Лазарев", "Ани Лорак", "Баста", "Макс Корж", "Zivert", "Мот",
           "Каста", "Jah Khalib", "Егор Крид", "Клава Кока", "Три дня дождя", "Artik & Asti", "HammAli & Navai", "Jony"]


def _itunes(path: str, **params):
    params.setdefault("country", "ru")
    data = _http_json(f"{ITUNES}{path}?{urllib.parse.urlencode(params)}", timeout=10)
    return data.get("results") if isinstance(data, dict) else None


def _big_art(url, size: int = 600) -> str | None:
    url = _https(url)
    return re.sub(r"/\d+x\d+bb\.(jpg|png|webp)$", f"/{size}x{size}bb.jpg", url) if url else None


def track_from_itunes(r: dict) -> dict | None:
    if not isinstance(r, dict) or r.get("wrapperType") != "track" or r.get("kind") != "song":
        return None
    tid, stream = str(r.get("trackId") or ""), _https(r.get("previewUrl"))
    if not tid.isdigit() or not stream:
        return None
    return {
        "key": f"itunes:{tid}", "source": "itunes", "id": tid,
        "title": str(r.get("trackName") or "Без названия")[:200], "artist": str(r.get("artistName") or "")[:120],
        "artwork": _big_art(r.get("artworkUrl100")), "duration": 30,
        "full_duration": int((r.get("trackTimeMillis") or 0) / 1000), "genre": str(r.get("primaryGenreName") or "")[:40],
        "permalink": _https(r.get("trackViewUrl")), "stream": stream, "preview": True,
        "album": str(r.get("collectionName") or "")[:160], "artist_id": str(r.get("artistId") or ""),
    }


def _lookup(ids: list[str]) -> list[dict]:
    found: dict[str, dict] = {}
    for i in range(0, len(ids), 150):
        for r in _itunes("/lookup", id=",".join(ids[i:i + 150])) or []:
            t = track_from_itunes(r)
            if t:
                found[t["id"]] = t
    return [found[i] for i in ids if i in found]


def _feed(kind: str, n: int) -> list[dict]:
    data = _http_json(f"{APPLE_RSS}/{n}/{kind}.json", timeout=12)
    return ((data or {}).get("feed") or {}).get("results") or []


def ru_chart(limit: int = 100) -> list[dict]:
    """Топ-100 самых популярных песен в России (Apple Music), по местам."""
    def load():
        ids = [str(x.get("id")) for x in _feed("songs", 100) if str(x.get("id") or "").isdigit()]
        tracks = _lookup(ids)
        if not tracks:
            raise Unavailable("пустой чарт")
        return tracks
    return cached("ru:chart", 6 * 3600, load)[:limit]


def ru_albums(limit: int = 20) -> list[dict]:
    def load():
        out = []
        for x in _feed("albums", 50):
            aid = str(x.get("id") or "")
            if aid.isdigit():
                out.append({"id": aid, "title": str(x.get("name") or "")[:200], "artist": str(x.get("artistName") or "")[:120],
                            "artwork": _big_art(x.get("artworkUrl100"), 400), "source": "itunes"})
        return out
    return cached("ru:albums", 6 * 3600, load)[:limit]


def ru_album(aid: str) -> dict:
    if not aid.isdigit():
        raise Unavailable("bad id")

    def load():
        rows = _itunes("/lookup", id=aid, entity="song") or []
        info = next((r for r in rows if r.get("wrapperType") == "collection"), None) or {}
        tracks = [t for t in (track_from_itunes(r) for r in rows) if t]
        return {"album": {"id": aid, "title": str(info.get("collectionName") or "Альбом")[:200],
                          "artist": str(info.get("artistName") or "")[:120], "artwork": _big_art(info.get("artworkUrl100")),
                          "year": str(info.get("releaseDate") or "")[:4], "permalink": _https(info.get("collectionViewUrl"))},
                "tracks": tracks}
    return cached(f"ru:album:{aid}", 24 * 3600, load)


def ru_artists(limit: int = 16) -> list[dict]:
    """Артисты из чарта — с обложкой их самого популярного трека."""
    seen, out = set(), []
    for t in ru_chart():
        name = t["artist"]
        if name.lower() in seen:
            continue
        seen.add(name.lower())
        out.append({"id": t["artist_id"], "name": name, "artwork": t["artwork"], "top": t["title"]})
        if len(out) >= limit:
            break
    return out


def ru_artist(artist_id: str = "", name: str = "") -> dict:
    """Песни артиста: по номеру в Apple Music или по имени."""
    name = name.strip()[:80]

    def load():
        if artist_id.isdigit():
            rows = _itunes("/lookup", id=artist_id, entity="song", limit=60) or []
            info = next((r for r in rows if r.get("wrapperType") == "artist"), {}) or {}
            title = info.get("artistName") or name
        else:
            rows = _itunes("/search", term=name, entity="song", attribute="artistTerm", limit=60) or []
            title = name
        tracks = [t for t in (track_from_itunes(r) for r in rows) if t]
        if not artist_id.isdigit() and name:  # поиск по имени находит и однофамильцев — оставим точные совпадения
            exact = [t for t in tracks if name.lower() in t["artist"].lower()]
            tracks = exact or tracks
        seen, uniq = set(), []
        for t in tracks:
            k = t["title"].lower()
            if k not in seen:
                seen.add(k)
                uniq.append(t)
        return {"artist": {"id": artist_id, "name": str(title)[:120], "artwork": uniq[0]["artwork"] if uniq else None}, "tracks": uniq}
    return cached(f"ru:artist:{artist_id}:{name.lower()}", 24 * 3600, load)


def ru_search(q: str, limit: int = 25) -> list[dict]:
    q = q.strip()[:80]
    if not q:
        return []
    return cached(f"ru:search:{q.lower()}", 900,
                  lambda: [t for t in (track_from_itunes(r) for r in _itunes("/search", term=q, entity="song", limit=40) or []) if t])[:limit]


def itunes_track(tid: str) -> dict | None:
    if not tid.isdigit():
        return None
    return cached(f"ru:track:{tid}", 24 * 3600, lambda: (_lookup([tid]) or [None])[0])


# ---------------------------------------------------------------- Общее
def resolve(key: str) -> dict | None:
    """Проверенные данные трека по ключу вида source:id — клиенту на слово не верим."""
    source, _, tid = str(key or "").partition(":")
    try:
        if source == "audius":
            return audius_track(tid)
        if source == "radio":
            return radio_station(tid)
        if source == "itunes":
            return itunes_track(tid)
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
    keep = ("key", "source", "id", "title", "artist", "artwork", "duration", "genre", "permalink", "stream", "live",
            "preview", "full_duration", "album", "artist_id")
    return {k: track.get(k) for k in keep if track.get(k) is not None}
