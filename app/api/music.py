"""Раздел «Музыка»: каталог, поиск, радио, «Волна Yarko», любимые треки, что слушают друзья."""
import asyncio
import json
from collections import Counter

from starlette.concurrency import run_in_threadpool
from starlette.requests import Request
from starlette.responses import JSONResponse, RedirectResponse, Response, StreamingResponse
from starlette.routing import Route

from .. import config, db, music, social
from ..web import ApiError, auth, body, limit, ok

MAX_LIKES = 2000


async def _call(fn, *args, default=None, wait: float | None = None):
    """Запрос к внешнему источнику в отдельном потоке; при недоступности — default или 503.
    wait — сколько ждать ответа: если источник медлит, отдаём default, а данные досчитаются в фоне и попадут в кэш."""
    try:
        job = run_in_threadpool(fn, *args)
        return await (asyncio.wait_for(asyncio.shield(asyncio.ensure_future(job)), wait) if wait else job)
    except asyncio.TimeoutError:
        return default if default is not None else []
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
        if isinstance(t, dict) and t.get("key") and not t.get("preview"):
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


def _new_songs(v: int, n: int = 12) -> list[dict]:
    from . import songs
    w, params = songs._not_blocked(v)
    return songs.views(db.all(f"SELECT s.* FROM songs s WHERE {w} ORDER BY s.id DESC LIMIT ?", (*params, n)), v)


@auth()
async def home(request: Request):
    v = request.state.user["id"]
    trending, fresh, lists, ru, stations = await asyncio.gather(
        _call(music.trending, "", "week", 12, default=[], wait=7),
        _call(music.underground, 14, default=[], wait=7),
        _call(music.playlists, 10, default=[], wait=7),
        _call(music.ru_indie, 40, default=[], wait=9),
        _call(music.radio, "", 12, default=[], wait=6))
    return JSONResponse({
        "ru": {"tracks": ru, "radio": stations},
        "trending": trending, "underground": fresh, "playlists": lists,
        "genres": [{"id": g, "slug": s, "name": n, "emoji": e} for g, s, n, e in music.GENRES],
        "krug_top": _krug_top(), "friends": _friends_listen(v), "songs": _new_songs(v),
        "liked": _liked_keys(v),
        "online": bool(trending or fresh or lists or ru),
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
    tracks, stations = await asyncio.gather(_call(music.search, q, 40, default=[]),
                                            _call(music.radio, "", 6, q, default=[]))
    from . import songs
    v = request.state.user["id"]
    w, params = songs._not_blocked(v)
    own = songs.views(db.all(f"SELECT s.* FROM songs s WHERE {w} AND s.search LIKE ? ORDER BY s.plays + s.likes * 5 DESC LIMIT 20",
                             (*params, f"%{q.lower()}%")), v)
    return JSONResponse({"tracks": tracks, "stations": stations, "songs": own})


@auth()
async def russian(request: Request):
    return JSONResponse({"items": await _call(music.ru_indie, 60)})


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
        gone = db.value("SELECT 1 FROM music_likes WHERE user_id=? AND track_key=?", (v, key))
        db.run("DELETE FROM music_likes WHERE user_id=? AND track_key=?", (v, key))
        if gone and key.startswith("yk:"):
            db.run("UPDATE songs SET likes=CASE WHEN likes>0 THEN likes-1 ELSE 0 END WHERE id=?", (int(key[3:]) if key[3:].isdigit() else 0,))
        return ok()
    if db.value("SELECT 1 FROM music_likes WHERE user_id=? AND track_key=?", (v, key)):
        return ok()
    if db.value("SELECT count(*) FROM music_likes WHERE user_id=?", (v,)) >= MAX_LIKES:
        raise ApiError(400, "В «Моей музыке» уже 2000 треков — уберите лишние")
    if key.startswith("yk:"):
        from . import songs
        track = music.public(songs.resolve(key))
    else:
        track = music.public(await run_in_threadpool(music.resolve, key))
    if not track:
        raise ApiError(404, "Трек недоступен")
    db.run("INSERT OR IGNORE INTO music_likes (user_id, track_key, data) VALUES (?,?,?)",
           (v, track["key"], json.dumps(track, ensure_ascii=False)))
    if key.startswith("yk:"):
        db.run("UPDATE songs SET likes=likes+1 WHERE id=?", (int(track["id"]),))
        author = db.value("SELECT author_id FROM songs WHERE id=?", (int(track["id"]),))
        if author and author != v:
            from . import artists
            artists.check_awards(author)
    return ok({"ok": True, "track": track})


# ---------------------------------------------------------------- копии на своём диске (хостинг)
# Аудио и обложки из-за рубежа один раз скачиваются на диск хостинга (папка uploads), дальше их отдаёт
# веб-сервер напрямую: перемотка мгновенная, а процессы Python не заняты минутами, пока играет песня.
CACHE_CAP = 1536 * 1048576


def _cache_path(*parts: str):
    from pathlib import Path
    return Path(config.MEDIA_CACHE_DIR).joinpath("mcache", *parts)


def _trim_cache() -> None:
    import os
    import random
    if random.random() > .05:
        return
    try:
        files = [p for p in _cache_path().rglob("*") if p.is_file()]
        total = sum(p.stat().st_size for p in files)
        for p in sorted(files, key=lambda p: p.stat().st_mtime):
            if total <= CACHE_CAP:
                break
            total -= p.stat().st_size
            os.remove(p)
    except OSError:
        pass


@auth()
async def play(request: Request):
    """Аудио трека через наш сервер: из России Audius напрямую не открывается"""
    import os
    limit(request, "music_play")
    tid = request.path_params["id"]
    cached = _cache_path("a", f"{tid}.mp3") if config.MEDIA_PROXY and music._ID.match(tid) else None
    if cached is not None and cached.is_file():
        return RedirectResponse(f"/uploads/mcache/a/{tid}.mp3", status_code=302, headers={"Cache-Control": "private, max-age=86400"})
    rng = request.headers.get("range")
    try:
        r = await run_in_threadpool(music.open_audius_stream, tid, rng)
    except music.Unavailable:
        raise ApiError(502, "Трек сейчас недоступен")
    headers = {"Accept-Ranges": "bytes", "Cache-Control": "private, max-age=3600"}
    for h in ("Content-Length", "Content-Range"):
        if r.headers.get(h):
            headers[h] = r.headers[h]
    ctype = r.headers.get("Content-Type") or "audio/mpeg"
    status = getattr(r, "status", None) or r.getcode()
    # первое прослушивание целиком (без перемотки): параллельно пишем файл на диск — следующее уже с диска
    full = cached is not None and status == 200 and (not rng or rng.strip() in ("bytes=0-", "")) and \
        str(r.headers.get("Content-Length") or "").isdigit() and int(r.headers["Content-Length"]) <= 60 * 1048576

    def chunks():
        tmp = out = None
        got = 0
        if full:
            try:
                cached.parent.mkdir(parents=True, exist_ok=True)
                tmp = cached.with_name(f"{cached.name}.{os.getpid()}.{id(r)}.tmp")
                out = open(tmp, "wb")
            except OSError:
                out = None
        try:
            while True:
                b = r.read(65536)
                if not b:
                    break
                if out:
                    out.write(b); got += len(b)
                yield b
        finally:
            r.close()
            if out:
                out.close()
                try:
                    if got == int(r.headers["Content-Length"]):
                        os.replace(tmp, cached)
                        _trim_cache()
                    else:
                        os.remove(tmp)
                except OSError:
                    pass
    return StreamingResponse(chunks(), status_code=status, media_type=ctype, headers=headers)


@auth()
async def art(request: Request):
    """Обложки и значки станций через наш сервер — тоже ради работы без VPN"""
    import hashlib
    import os
    limit(request, "music_play")
    u = request.query_params.get("u", "")
    ext_of = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif"}
    name = hashlib.sha1(u.encode()).hexdigest()[:24]
    if config.MEDIA_PROXY:
        for ext in ext_of.values():
            if _cache_path("art", f"{name}.{ext}").is_file():
                return RedirectResponse(f"/uploads/mcache/art/{name}.{ext}", status_code=302,
                                        headers={"Cache-Control": "public, max-age=604800"})
    try:
        data, ctype = await _call(music.fetch_art, u)
    except ApiError:
        return Response(status_code=404)
    if config.MEDIA_PROXY and ctype in ext_of:
        try:
            p = _cache_path("art", f"{name}.{ext_of[ctype]}")
            p.parent.mkdir(parents=True, exist_ok=True)
            tmp = p.with_name(p.name + f".{os.getpid()}.tmp")
            tmp.write_bytes(data)
            os.replace(tmp, p)
        except OSError:
            pass
    return Response(data, media_type=ctype, headers={"Cache-Control": "private, max-age=604800",
                                                     "X-Content-Type-Options": "nosniff"})


async def status(request: Request):
    """Проверка источников музыки (для мониторинга): сколько треков и станций сейчас доступно."""
    tracks, stations, ru = await asyncio.gather(_call(music.trending, "", "week", 60, default=[]),
                                                _call(music.radio, "", 60, default=[]), _call(music.ru_indie, 60, default=[]))
    out = {"catalog": len(tracks), "radio": len(stations), "ru_tracks": len(ru), "ok": bool(tracks and stations)}
    return JSONResponse(out)


routes = [
    Route("/api/music/status", status, methods=["GET"]),
    Route("/api/music/home", home, methods=["GET"]),
    Route("/api/music/genre", genre, methods=["GET"]),
    Route("/api/music/russian", russian, methods=["GET"]),
    Route("/api/music/search", search, methods=["GET"]),
    Route("/api/music/playlist/{id}", playlist, methods=["GET"]),
    Route("/api/music/radio", radio, methods=["GET"]),
    Route("/api/music/wave", wave, methods=["GET"]),
    Route("/api/music/likes", likes, methods=["GET"]),
    Route("/api/music/play/{id}", play, methods=["GET"]),
    Route("/api/music/art", art, methods=["GET"]),
    Route("/api/music/likes", like, methods=["POST", "DELETE"]),
]
