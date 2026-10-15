"""Свои плейлисты в «Музыке»: человек собирает песни Yarko, треки каталога и радио в подборки.

Трек при добавлении проверяется по источнику (music.resolve) и хранится копией — плейлист открывается без
обращений к внешним сервисам. Смотреть плейлист может любой вошедший (ссылкой можно поделиться), менять — только автор.
"""
import json

from starlette.concurrency import run_in_threadpool
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from .. import db, music, social
from ..security import censor, clean_text
from ..web import ApiError, auth, body, limit, ok, path_int

MAX_PLAYLISTS = 50
MAX_TRACKS = 500


def _view(row: dict, v: int, with_tracks: bool = False) -> dict:
    tracks = [json.loads(r["data"]) for r in db.all("SELECT data FROM playlist_tracks WHERE playlist_id=? ORDER BY pos", (row["id"],))]
    out = {"id": row["id"], "title": row["title"], "count": len(tracks), "mine": row["owner_id"] == v,
           "covers": [t.get("artwork") for t in tracks if t.get("artwork")][:4], "updated_at": row["updated_at"],
           "owner": social.cards_by_ids([row["owner_id"]]).get(row["owner_id"])}
    if with_tracks:
        out["tracks"] = tracks
    return out


def _own(request: Request) -> dict:
    v = request.state.user["id"]
    row = db.one("SELECT * FROM playlists WHERE id=?", (path_int(request),))
    if not row or row["owner_id"] != v:
        raise ApiError(404, "Плейлист не найден")
    return row


def _title(raw) -> str:
    t = censor(clean_text(str(raw or ""), 80)).replace("\n", " ").strip()
    if not t:
        raise ApiError(400, "Назовите плейлист")
    return t


@auth()
async def list_mine(request: Request):
    v = request.state.user["id"]
    username = request.query_params.get("user")
    uid = v
    if username:
        uid = db.value("SELECT user_id FROM profiles WHERE username=?", (username,))
        if not uid or social.blocked_between(v, uid):
            raise ApiError(404, "Пользователь не найден")
    rows = db.all("SELECT * FROM playlists WHERE owner_id=? ORDER BY updated_at DESC LIMIT ?", (uid, MAX_PLAYLISTS))
    return JSONResponse({"items": [_view(r, v) for r in rows]})


@auth()
async def create(request: Request):
    limit(request, "write")
    v = request.state.user["id"]
    d = await body(request)
    if db.value("SELECT count(*) FROM playlists WHERE owner_id=?", (v,)) >= MAX_PLAYLISTS:
        raise ApiError(400, f"Плейлистов может быть не больше {MAX_PLAYLISTS}")
    now = db.now()
    pid = db.run("INSERT INTO playlists (owner_id, title, created_at, updated_at) VALUES (?,?,?,?)", (v, _title(d.get("title")), now, now)).lastrowid
    if d.get("key"):
        await _add(pid, str(d["key"]))
    return JSONResponse(_view(db.one("SELECT * FROM playlists WHERE id=?", (pid,)), v), status_code=201)


@auth()
async def get_one(request: Request):
    v = request.state.user["id"]
    row = db.one("SELECT * FROM playlists WHERE id=?", (path_int(request),))
    if not row or social.blocked_between(v, row["owner_id"]):
        raise ApiError(404, "Плейлист не найден")
    return JSONResponse(_view(row, v, with_tracks=True))


@auth()
async def update(request: Request):
    limit(request, "write")
    row = _own(request)
    d = await body(request)
    if "title" in d:
        db.run("UPDATE playlists SET title=?, updated_at=? WHERE id=?", (_title(d["title"]), db.now(), row["id"]))
    if isinstance(d.get("order"), list):  # новый порядок — список ключей
        keys = [str(k) for k in d["order"]][:MAX_TRACKS]
        for i, k in enumerate(keys):
            db.run("UPDATE playlist_tracks SET pos=? WHERE playlist_id=? AND track_key=?", (i, row["id"], k))
    return JSONResponse(_view(db.one("SELECT * FROM playlists WHERE id=?", (row["id"],)), request.state.user["id"], with_tracks=True))


@auth()
async def remove(request: Request):
    row = _own(request)
    db.run("DELETE FROM playlist_tracks WHERE playlist_id=?", (row["id"],))
    db.run("DELETE FROM playlists WHERE id=?", (row["id"],))
    return ok()


async def _add(pid: int, key: str) -> dict:
    if db.value("SELECT count(*) FROM playlist_tracks WHERE playlist_id=?", (pid,)) >= MAX_TRACKS:
        raise ApiError(400, f"В плейлисте может быть не больше {MAX_TRACKS} треков")
    track = music.public(await run_in_threadpool(music.resolve, key[:100]))
    if not track:
        raise ApiError(404, "Трек недоступен")
    if not db.value("SELECT 1 FROM playlist_tracks WHERE playlist_id=? AND track_key=?", (pid, track["key"])):
        pos = (db.value("SELECT max(pos) FROM playlist_tracks WHERE playlist_id=?", (pid,)) or 0) + 1
        db.run("INSERT INTO playlist_tracks (playlist_id, track_key, pos, data) VALUES (?,?,?,?)",
               (pid, track["key"], pos, json.dumps(track, ensure_ascii=False)))
    db.run("UPDATE playlists SET updated_at=? WHERE id=?", (db.now(), pid))
    return track


@auth()
async def tracks(request: Request):
    limit(request, "write")
    row = _own(request)
    d = await body(request)
    key = str(d.get("key") or "")
    if request.method == "DELETE":
        db.run("DELETE FROM playlist_tracks WHERE playlist_id=? AND track_key=?", (row["id"], key))
        db.run("UPDATE playlists SET updated_at=? WHERE id=?", (db.now(), row["id"]))
        return ok()
    await _add(row["id"], key)
    return JSONResponse(_view(db.one("SELECT * FROM playlists WHERE id=?", (row["id"],)), request.state.user["id"]))


routes = [
    Route("/api/music/my-playlists", list_mine, methods=["GET"]),
    Route("/api/music/my-playlists", create, methods=["POST"]),
    Route("/api/music/my-playlists/{id:int}", get_one, methods=["GET"]),
    Route("/api/music/my-playlists/{id:int}", update, methods=["PATCH"]),
    Route("/api/music/my-playlists/{id:int}", remove, methods=["DELETE"]),
    Route("/api/music/my-playlists/{id:int}/tracks", tracks, methods=["POST", "DELETE"]),
]
