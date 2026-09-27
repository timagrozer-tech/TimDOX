"""Раздел «Музыка»: каталог, поиск, радио, «Волна Круга», любимые треки, что слушают друзья."""
import asyncio
import json
from collections import Counter

from starlette.concurrency import run_in_threadpool
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from .. import db, music, social
from ..web import ApiError, auth, body, limit, ok

MAX_LIKES = 2000


async def _call(fn, *args, default=None):
    """Запрос к внешнему источнику в отдельном потоке; при недоступности — default или 503."""
    try:
        return await run_in_threadpool(fn, *args)
    except music.Unavailable:
        if default is not None:
            return default
        raise ApiError(503, "Музыкальный сервис сейчас не отвечает. Попробуйте чуть позже.")


def _liked_keys(v: int) -> list[str]:
    return [r["track_key"] for r in db.all("SELECT track_key FROM music_likes WHERE user_id=? ORDER BY created_at DESC LIMIT 2000", (v,))]


def _load(rows) -> list[dict]:
    out = []
    for r in rows:
        try:
            t = json.loads(r["data"])
        except (TypeError, ValueError):
            continue
        if isinstance(t, dict) and t.get("key"):
            out.append(t)
    return out


def _krug_top(limit_n: int = 12) -> list[dict]:
    rows = db.all("""SELECT track_key, count(*) AS n, max(data) AS data FROM music_likes WHERE created_at >= ?
                     GROUP BY track_key ORDER BY count(*) DESC, max(created_at) DESC LIMIT ?""", (db.future(days=-30), limit_n))
    tracks = _load(rows)
    for t, r in zip(tracks, rows):
        t["likes"] = r["n"]
    return tracks


def _friends_listen(v: int, limit_n: int = 12) -> list[dict]:
    people = set(social.friend_ids(v)) | {r["followee_id"] for r in db.all("SELECT followee_id FROM follows WHERE follower_id=?", (v,))}
    people.discard(v)
    if not people:
        return []
    ids = list(people)[:500]
    rows = db.all(f"""SELECT user_id, data FROM music_likes WHERE user_id IN ({db.placeholders(ids)})
                      ORDER BY created_at DESC LIMIT 80""", tuple(ids))
    cards = social.cards_by_ids({r["user_id"] for r in rows})
    out, seen = [], set()
    for r in rows:
        t = (_load([r]) or [None])[0]
        if not t or t["key"] in seen or r["user_id"] not in cards:
            continue
        seen.add(t["key"])
        t["by"] = cards[r["user_id"]]
        out.append(t)
        if len(out) >= limit_n:
            break
    return out


@auth()
async def home(request: Request):
    v = request.state.user["id"]
    trending, fresh, lists = await asyncio.gather(
        _call(music.trending, "", "week", 12, default=[]),
        _call(music.underground, 14, default=[]),
        _call(music.playlists, 10, default=[]))
    return JSONResponse({
        "trending": trending, "underground": fresh, "playlists": lists,
        "genres": [{"id": g, "slug": s, "name": n, "emoji": e} for g, s, n, e in music.GENRES],
        "krug_top": _krug_top(), "friends": _friends_listen(v),
        "liked": _liked_keys(v),
        "online": bool(trending or fresh or lists),
    })


@auth()
async def genre(request: Request):
    g = request.query_params.get("g", "")
    if g in music.GENRE_BY_SLUG:
        g, name, emoji = music.GENRE_BY_SLUG[g]
    elif g in music.GENRE_NAMES:
        name, emoji = next((n, e) for gg, _, n, e in music.GENRES if gg == g)
    else:
        raise ApiError(400, "Неизвестный жанр")
    period = request.query_params.get("time", "week")
    if period not in ("week", "month", "year", "allTime"):
        period = "week"
    return JSONResponse({"genre": {"id": g, "name": name, "emoji": emoji}, "items": await _call(music.trending, g, period, 40)})


@auth()
async def search(request: Request):
    limit(request, "search_music")
    q = (request.query_params.get("q") or "").strip()[:80]
    if len(q) < 2:
        return JSONResponse({"tracks": [], "stations": []})
    tracks, stations = await asyncio.gather(_call(music.search, q, 30, default=[]),
                                            _call(music.radio, "", 6, q, default=[]))
    return JSONResponse({"tracks": tracks, "stations": stations})


@auth()
async def playlist(request: Request):
    return JSONResponse(await _call(music.playlist, request.path_params["id"]))


@auth()
async def radio(request: Request):
    tag = request.query_params.get("tag", "")
    if tag not in {t for t, _ in music.RADIO_TAGS}:
        tag = ""
    return JSONResponse({"items": await _call(music.radio, tag, 48),
                         "tags": [{"id": t, "name": n} for t, n in music.RADIO_TAGS]})


@auth()
async def wave(request: Request):
    v = request.state.user["id"]
    rows = db.all("SELECT data FROM music_likes WHERE user_id=? ORDER BY created_at DESC LIMIT 200", (v,))
    liked = _load(rows)
    genres = [g for g, _ in Counter(t.get("genre") for t in liked if t.get("genre") in music.GENRE_NAMES).most_common(3)]
    recent = {t["key"] for t in liked[:30]}
    items = await _call(music.wave, genres, recent, 40)
    if not items:
        raise ApiError(503, "Музыкальный сервис сейчас не отвечает. Попробуйте чуть позже.")
    return JSONResponse({"items": items, "genres": genres})


@auth()
async def likes(request: Request):
    v = request.state.user["id"]
    rows = db.all("SELECT data FROM music_likes WHERE user_id=? ORDER BY created_at DESC LIMIT 2000", (v,))
    return JSONResponse({"items": _load(rows)})


@auth()
async def like(request: Request):
    limit(request, "write")
    v = request.state.user["id"]
    key = str((await body(request)).get("key") or request.query_params.get("key") or "")[:100]
    if request.method == "DELETE":
        db.run("DELETE FROM music_likes WHERE user_id=? AND track_key=?", (v, key))
        return ok()
    if db.value("SELECT 1 FROM music_likes WHERE user_id=? AND track_key=?", (v, key)):
        return ok()
    if db.value("SELECT count(*) FROM music_likes WHERE user_id=?", (v,)) >= MAX_LIKES:
        raise ApiError(400, "В «Моей музыке» уже 2000 треков — уберите лишние")
    track = music.public(await run_in_threadpool(music.resolve, key))
    if not track:
        raise ApiError(404, "Трек недоступен")
    db.run("INSERT OR IGNORE INTO music_likes (user_id, track_key, data) VALUES (?,?,?)",
           (v, track["key"], json.dumps(track, ensure_ascii=False)))
    return ok({"ok": True, "track": track})


async def status(request: Request):
    """Проверка источников музыки (для мониторинга): сколько треков и станций сейчас доступно."""
    tracks, stations = await asyncio.gather(_call(music.trending, "", "week", 60, default=[]), _call(music.radio, "", 60, default=[]))
    return JSONResponse({"catalog": len(tracks), "radio": len(stations), "ok": bool(tracks) and bool(stations)})


routes = [
    Route("/api/music/status", status, methods=["GET"]),
    Route("/api/music/home", home, methods=["GET"]),
    Route("/api/music/genre", genre, methods=["GET"]),
    Route("/api/music/search", search, methods=["GET"]),
    Route("/api/music/playlist/{id}", playlist, methods=["GET"]),
    Route("/api/music/radio", radio, methods=["GET"]),
    Route("/api/music/wave", wave, methods=["GET"]),
    Route("/api/music/likes", likes, methods=["GET"]),
    Route("/api/music/likes", like, methods=["POST", "DELETE"]),
]
