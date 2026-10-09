"""Свои песни в «Музыке»: публикация, общая лента, поиск, прослушивания, удаление.

Нагрузка минимальная: аудио хранится готовым файлом и после первого прослушивания отдаётся веб-сервером хостинга
напрямую (папка uploads), а списки — простые выборки по индексам с ограничением в 30 строк.
"""
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from .. import config, db, media, music, social
from ..security import censor, clean_text
from ..web import ApiError, auth, body, int_param, limit, ok, path_int

PAGE = 30
GENRES = {s: n for _, s, n, _ in music.GENRES}
GENRES["other"] = "Другое"


def _num(value, lo, hi):
    try:
        x = float(value)
    except (TypeError, ValueError):
        return None
    return max(lo, min(hi, x)) if x == x else None


def track_of(r: dict, card: dict | None = None) -> dict:
    """Песня в формате трека плеера (key «yk:<id>», поток — сам файл)"""
    t = {"key": f"yk:{r['id']}", "source": "yarko", "id": str(r["id"]), "title": r["title"],
         "artist": r["artist"] or (card or {}).get("name") or "", "artwork": r.get("cover") or None,
         "duration": r["duration"] or 0, "genre": r.get("genre") or "", "stream": r["audio"]}
    return t


def views(rows: list[dict], v: int) -> list[dict]:
    cards = social.cards_by_ids({r["author_id"] for r in rows})
    out = []
    for r in rows:
        card = cards.get(r["author_id"])
        if not card:
            continue
        t = track_of(r, card)
        t.update({"author": card, "plays": r["plays"], "likes": r["likes"], "created_at": r["created_at"],
                  "mine": r["author_id"] == v, "lyrics": r.get("lyrics") or "",
                  "genre_name": GENRES.get(r.get("genre") or "", "")})
        out.append(t)
    return out


def resolve(key: str) -> dict | None:
    """Проверенные данные песни для «Моей музыки» и записей в ленте"""
    try:
        sid = int(str(key).split(":", 1)[1])
    except (IndexError, ValueError):
        return None
    r = db.one("SELECT * FROM songs WHERE id=?", (sid,))
    if not r:
        return None
    card = social.cards_by_ids([r["author_id"]]).get(r["author_id"])
    return track_of(r, card)


def _not_blocked(v: int) -> tuple[str, list]:
    return ("NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id=? AND b.blocked_id=s.author_id) OR (b.blocker_id=s.author_id AND b.blocked_id=?))",
            [v, v])


@auth()
async def list_songs(request: Request):
    v = request.state.user["id"]
    if request.query_params.get("meta"):
        return JSONResponse({"genres": [{"slug": s, "name": n} for s, n in GENRES.items()]})
    sort = request.query_params.get("sort", "new")
    q = (request.query_params.get("q") or "").strip().lower()[:60]
    genre = request.query_params.get("genre") or ""
    username = request.query_params.get("user") or ""
    cursor = int_param(request, "cursor")
    w, params = _not_blocked(v)
    where = [w]
    if q:
        where.append("s.search LIKE ?"); params.append(f"%{q}%")
    if genre in GENRES:
        where.append("s.genre=?"); params.append(genre)
    if username == "me":
        where.append("s.author_id=?"); params.append(v)
    elif username:
        uid = db.value("SELECT user_id FROM profiles WHERE username=?", (username,))
        if not uid:
            raise ApiError(404, "Пользователь не найден")
        where.append("s.author_id=?"); params.append(uid)
    if sort == "popular":
        offset = max(0, min(int(cursor or 0), 300))
        rows = db.all(f"SELECT s.* FROM songs s WHERE {' AND '.join(where)} ORDER BY s.plays + s.likes * 5 DESC, s.id DESC LIMIT ? OFFSET ?",
                      (*params, PAGE + 1, offset))
        nxt = offset + PAGE if len(rows) > PAGE else None
    else:
        if cursor:
            where.append("s.id<?"); params.append(cursor)
        rows = db.all(f"SELECT s.* FROM songs s WHERE {' AND '.join(where)} ORDER BY s.id DESC LIMIT ?", (*params, PAGE + 1))
        nxt = rows[PAGE - 1]["id"] if len(rows) > PAGE else None
    return JSONResponse({"items": views(rows[:PAGE], v), "next": nxt,
                         "genres": [{"slug": s, "name": n} for s, n in GENRES.items()]})


@auth()
async def get_song(request: Request):
    v = request.state.user["id"]
    r = db.one("SELECT * FROM songs WHERE id=?", (path_int(request),))
    if not r or social.blocked_between(v, r["author_id"]):
        raise ApiError(404, "Песня не найдена")
    return JSONResponse(views([r], v)[0])


@auth(require_verified=True)
async def create_song(request: Request):
    limit(request, "upload")
    v = request.state.user["id"]
    if db.value("SELECT count(*) FROM songs WHERE author_id=? AND created_at >= ?", (v, db.future(days=-1))) >= config.SONGS_PER_DAY:
        raise ApiError(429, f"За сутки можно опубликовать не больше {config.SONGS_PER_DAY} песен")
    form = await request.form(max_files=2, max_fields=10, max_part_size=64 * 1024)
    saved = []
    try:
        f = form.get("audio")
        if not getattr(f, "filename", None):
            raise ApiError(400, "Выберите файл песни")
        title = censor(clean_text(str(form.get("title") or ""), 120)).replace("\n", " ")
        if not title:
            raise ApiError(400, "Укажите название песни")
        artist = censor(clean_text(str(form.get("artist") or ""), 80)).replace("\n", " ")
        lyrics = censor(clean_text(str(form.get("lyrics") or ""), 6000))
        genre = str(form.get("genre") or "")
        if genre not in GENRES:
            genre = "other"
        duration = _num(form.get("duration"), 0, 3600) or 0
        if duration and duration < 5:
            raise ApiError(400, "Песня слишком короткая")
        if duration > 20 * 60:
            raise ApiError(400, "Песня должна быть не длиннее 20 минут")
        a = await media.save_media(f, "audio", limit_mb=config.MAX_SONG_MB)
        saved.append(a["path"])
        cover = None
        cf = form.get("cover")
        if getattr(cf, "filename", None):
            c = await media.save_upload(cf, "avatar")  # квадрат 512 px + превью
            saved.append(c["path"])
            cover = c["path"]
    except Exception:
        media.delete_files(*saved)
        raise
    finally:
        await form.close()
    name = (social.cards_by_ids([v]).get(v) or {}).get("name", "")
    search = f"{title} {artist or name}".lower()
    cur = db.run("""INSERT INTO songs (author_id, title, artist, genre, lyrics, audio, cover, duration, size, search)
                    VALUES (?,?,?,?,?,?,?,?,?,?)""", (v, title, artist, genre, lyrics, a["path"], cover, duration, a["size"], search))
    return JSONResponse(views([db.one("SELECT * FROM songs WHERE id=?", (cur.lastrowid,))], v)[0], status_code=201)


@auth()
async def update_song(request: Request):
    limit(request, "write")
    v = request.state.user["id"]
    r = db.one("SELECT * FROM songs WHERE id=?", (path_int(request),))
    if not r or r["author_id"] != v:
        raise ApiError(404, "Песня не найдена")
    d = await body(request)
    title = censor(clean_text(str(d.get("title", r["title"])), 120)).replace("\n", " ") or r["title"]
    artist = censor(clean_text(str(d.get("artist", r["artist"])), 80)).replace("\n", " ")
    lyrics = censor(clean_text(str(d.get("lyrics", r["lyrics"])), 6000))
    genre = d.get("genre", r["genre"]) if d.get("genre", r["genre"]) in GENRES else r["genre"]
    name = (social.cards_by_ids([v]).get(v) or {}).get("name", "")
    db.run("UPDATE songs SET title=?, artist=?, lyrics=?, genre=?, search=? WHERE id=?",
           (title, artist, lyrics, genre, f"{title} {artist or name}".lower(), r["id"]))
    return JSONResponse(views([db.one("SELECT * FROM songs WHERE id=?", (r["id"],))], v)[0])


@auth()
async def delete_song(request: Request):
    u = request.state.user
    r = db.one("SELECT * FROM songs WHERE id=?", (path_int(request),))
    if not r:
        raise ApiError(404, "Песня не найдена")
    if r["author_id"] != u["id"] and not u["is_admin"]:
        raise ApiError(403, "Удалить можно только свою песню")
    if r["author_id"] != u["id"]:
        from .. import modlog
        modlog.log(u["id"], "delete_song", "song", r["id"], r["author_id"], details={"text": r["title"][:80]})
    db.run("DELETE FROM songs WHERE id=?", (r["id"],))
    db.run("DELETE FROM music_likes WHERE track_key=?", (f"yk:{r['id']}",))
    media.delete_files(r["audio"], r["cover"])
    return ok()


@auth()
async def played(request: Request):
    """Прослушивание: не чаще раза в 30 секунд с одного аккаунта (ограничитель запросов), просто счётчик"""
    limit(request, "song_play")
    db.run("UPDATE songs SET plays=plays+1 WHERE id=?", (path_int(request),))
    return ok()


routes = [
    Route("/api/music/songs", list_songs, methods=["GET"]),
    Route("/api/music/songs", create_song, methods=["POST"]),
    Route("/api/music/songs/{id:int}", get_song, methods=["GET"]),
    Route("/api/music/songs/{id:int}", update_song, methods=["PATCH"]),
    Route("/api/music/songs/{id:int}", delete_song, methods=["DELETE"]),
    Route("/api/music/songs/{id:int}/play", played, methods=["POST"]),
]
