"""Артисты Yarko: карточка артиста, альбомы, чарт, слушатели и музыкальные награды.

Всё считается простыми выборками по индексам; награды проверяются только в моменты, когда что-то меняется
(новая песня, альбом, сердечко, круглое число прослушиваний), а не при каждом показе страницы.
"""
import json

from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from .. import db, media, social
from ..realtime import hub
from ..security import censor, clean_text
from ..web import ApiError, auth, body, limit, ok, path_int
from . import songs as songs_mod

KINDS = {"album": "Альбом", "ep": "EP", "single": "Сингл"}

# код: (эмодзи, название, за что, редкость)
AWARDS = {
    "debut": ("🎤", "Дебют", "Опубликовать первую песню", "common"),
    "pioneer": ("🚀", "Первопроходец", "Стать одним из первых 100 артистов Yarko", "epic"),
    "album": ("💿", "Первый релиз", "Выпустить альбом или EP", "rare"),
    "discography": ("📀", "Дискография", "Выпустить три альбома", "epic"),
    "prolific": ("✍️", "Плодовитый автор", "Опубликовать 10 песен", "rare"),
    "poet": ("📝", "Поэт", "Добавить тексты к 5 песням", "rare"),
    "genres": ("🎨", "Без рамок", "Песни в трёх разных жанрах", "rare"),
    "plays100": ("🎧", "Первая сотня", "100 прослушиваний", "common"),
    "plays1k": ("🔥", "Тысяча", "1 000 прослушиваний", "rare"),
    "gold": ("🥇", "Золотая пластинка", "10 000 прослушиваний", "epic"),
    "platinum": ("💎", "Платиновая пластинка", "50 000 прослушиваний", "legendary"),
    "listeners50": ("👥", "Своя публика", "50 разных слушателей", "rare"),
    "loved": ("💜", "Любимец публики", "50 сердечек песням", "rare"),
    "hit": ("🏆", "Хит Yarko", "Песня на первом месте чарта Yarko", "legendary"),
}
PLAY_STEPS = {100: "plays100", 1000: "plays1k", 10000: "gold", 50000: "platinum"}


# ---------------------------------------------------------------- награды
def _grant(uid: int, code: str, song_id: int | None = None) -> bool:
    if db.value("SELECT 1 FROM music_awards WHERE user_id=? AND code=?", (uid, code)):
        return False
    db.run("INSERT OR IGNORE INTO music_awards (user_id, code, song_id) VALUES (?,?,?)", (uid, code, song_id))
    emoji, name, why, rarity = AWARDS[code]
    # уведомление себе: награду «вручает» сам Yarko, поэтому без проверки «сам себе»
    cur = db.run("INSERT INTO notifications (user_id, actor_id, type, extra) VALUES (?,?,?,?)",
                 (uid, uid, "music_award", json.dumps({"code": code, "name": name, "emoji": emoji, "rarity": rarity}, ensure_ascii=False)))
    row = db.one("SELECT * FROM notifications WHERE id=?", (cur.lastrowid,))
    hub.publish(uid, "notification", social.notification_view(row))
    social.push_counters(uid)
    return True


def check_awards(uid: int) -> list[str]:
    """Пересчёт наград артиста (несколько коротких выборок); возвращает коды новых наград"""
    got = {r["code"] for r in db.all("SELECT code FROM music_awards WHERE user_id=?", (uid,))}
    s = db.one("""SELECT count(*) AS n, coalesce(sum(plays), 0) AS plays, coalesce(sum(likes), 0) AS likes,
                         count(DISTINCT CASE WHEN genre NOT IN ('', 'other') THEN genre END) AS genres,
                         sum(CASE WHEN lyrics <> '' THEN 1 ELSE 0 END) AS lyrics
                  FROM songs WHERE author_id=?""", (uid,)) or {}
    if not s.get("n"):
        return []
    want = ["debut"]
    if (s["n"] or 0) >= 10:
        want.append("prolific")
    if (s["lyrics"] or 0) >= 5:
        want.append("poet")
    if (s["genres"] or 0) >= 3:
        want.append("genres")
    for step, code in PLAY_STEPS.items():
        if (s["plays"] or 0) >= step:
            want.append(code)
    if (s["likes"] or 0) >= 50:
        want.append("loved")
    albums = db.value("SELECT count(*) FROM albums a WHERE a.artist_id=? AND EXISTS (SELECT 1 FROM songs x WHERE x.album_id=a.id)", (uid,)) or 0
    if albums >= 1:
        want.append("album")
    if albums >= 3:
        want.append("discography")
    if "pioneer" not in got and (db.value("SELECT count(DISTINCT author_id) FROM songs") or 0) <= 100:
        want.append("pioneer")
    if "listeners50" not in got and (db.value(
            "SELECT count(DISTINCT l.user_id) FROM song_listens l JOIN songs s ON s.id=l.song_id WHERE s.author_id=?", (uid,)) or 0) >= 50:
        want.append("listeners50")
    new = [c for c in want if c not in got and _grant(uid, c)]
    return new


def awards_view(uid: int) -> list[dict]:
    have = {r["code"]: r for r in db.all("SELECT code, song_id, created_at FROM music_awards WHERE user_id=?", (uid,))}
    out = []
    for code, (emoji, name, why, rarity) in AWARDS.items():
        r = have.get(code)
        out.append({"code": code, "emoji": emoji, "name": name, "why": why, "rarity": rarity,
                    "earned": bool(r), "at": r["created_at"] if r else None})
    return out


# ---------------------------------------------------------------- карточка артиста
def _stats(uid: int) -> dict:
    s = db.one("SELECT count(*) AS songs, coalesce(sum(plays), 0) AS plays, coalesce(sum(likes), 0) AS likes FROM songs WHERE author_id=?", (uid,))
    s["listeners"] = db.value("SELECT count(DISTINCT l.user_id) FROM song_listens l JOIN songs x ON x.id=l.song_id WHERE x.author_id=?", (uid,)) or 0
    s["followers"] = db.value("SELECT count(*) FROM follows WHERE followee_id=?", (uid,)) or 0
    s["albums"] = db.value("SELECT count(*) FROM albums WHERE artist_id=?", (uid,)) or 0
    return s


def _artist_row(uid: int, card: dict) -> dict:
    a = db.one("SELECT * FROM artists WHERE user_id=?", (uid,)) or {}
    return {"id": uid, "username": card["username"], "user": card, "name": a.get("name") or card["name"],
            "bio": a.get("bio") or "", "genre": a.get("genre") or "", "banner": a.get("banner"),
            "genre_name": songs_mod.GENRES.get(a.get("genre") or "", "")}


def album_views(rows: list[dict]) -> list[dict]:
    if not rows:
        return []
    ids = [r["id"] for r in rows]
    stats = {r["album_id"]: r for r in db.all(
        f"""SELECT album_id, count(*) AS n, coalesce(sum(duration), 0) AS dur, coalesce(sum(plays), 0) AS plays
            FROM songs WHERE album_id IN ({db.placeholders(ids)}) GROUP BY album_id""", tuple(ids))}
    cards = social.cards_by_ids({r["artist_id"] for r in rows})
    return [{"id": r["id"], "title": r["title"], "kind": r["kind"], "kind_name": KINDS.get(r["kind"], "Альбом"),
             "about": r["about"], "cover": r["cover"], "created_at": r["created_at"],
             "artist": cards.get(r["artist_id"]), "count": (stats.get(r["id"]) or {}).get("n", 0),
             "duration": (stats.get(r["id"]) or {}).get("dur", 0), "plays": (stats.get(r["id"]) or {}).get("plays", 0)}
            for r in rows]


@auth()
async def get_artist(request: Request):
    v = request.state.user["id"]
    uid = db.value("SELECT user_id FROM profiles WHERE username=?", (request.path_params["username"],))
    if not uid or social.blocked_between(v, uid):
        raise ApiError(404, "Артист не найден")
    card = social.cards_by_ids([uid]).get(uid)
    if not card:
        raise ApiError(404, "Артист не найден")
    if uid != v and not db.value("SELECT 1 FROM songs WHERE author_id=?", (uid,)) and not db.value("SELECT 1 FROM artists WHERE user_id=?", (uid,)):
        raise ApiError(404, "Этот человек пока не публиковал песен")
    top = db.all("SELECT * FROM songs WHERE author_id=? ORDER BY plays + likes * 5 DESC, id DESC LIMIT 10", (uid,))
    latest = db.all("SELECT * FROM songs WHERE author_id=? ORDER BY id DESC LIMIT 50", (uid,))
    albums = db.all("SELECT * FROM albums WHERE artist_id=? ORDER BY id DESC", (uid,))
    return JSONResponse({
        **_artist_row(uid, card), "stats": _stats(uid), "awards": awards_view(uid),
        "top": songs_mod.views(top, v), "songs": songs_mod.views(latest, v), "albums": album_views(albums),
        "mine": uid == v, "following": bool(db.value("SELECT 1 FROM follows WHERE follower_id=? AND followee_id=?", (v, uid))),
    })


@auth()
async def update_artist(request: Request):
    """Своя карточка: сценическое имя, о себе, жанр; обложка (баннер) — отдельной загрузкой"""
    limit(request, "write")
    v = request.state.user["id"]
    if (request.headers.get("content-type") or "").startswith("multipart/"):
        form = await request.form(max_files=1, max_fields=2, max_part_size=16 * 1024)
        try:
            f = form.get("banner")
            if not getattr(f, "filename", None):
                raise ApiError(400, "Выберите картинку")
            saved = await media.save_upload(f, "cover")
        finally:
            await form.close()
        old = db.value("SELECT banner FROM artists WHERE user_id=?", (v,))
        db.run("INSERT OR IGNORE INTO artists (user_id) VALUES (?)", (v,))
        db.run("UPDATE artists SET banner=? WHERE user_id=?", (saved["path"], v))
        if old:
            media.delete_files(old)
    else:
        d = await body(request)
        name = censor(clean_text(str(d.get("name") or ""), 60)).replace("\n", " ")
        bio = censor(clean_text(str(d.get("bio") or ""), 1000))
        genre = d.get("genre") if d.get("genre") in songs_mod.GENRES else ""
        db.run("INSERT OR IGNORE INTO artists (user_id) VALUES (?)", (v,))
        db.run("UPDATE artists SET name=?, bio=?, genre=? WHERE user_id=?", (name, bio, genre, v))
    card = social.cards_by_ids([v]).get(v)
    return JSONResponse(_artist_row(v, card))


@auth()
async def list_artists(request: Request):
    """Артисты Yarko: по прослушиваниям или новые"""
    v = request.state.user["id"]
    sort = request.query_params.get("sort", "top")
    order = "max(s.id) DESC" if sort == "new" else "sum(s.plays) + sum(s.likes) * 5 DESC"
    w, params = songs_mod._not_blocked(v)
    rows = db.all(f"""SELECT s.author_id, count(*) AS songs, sum(s.plays) AS plays, sum(s.likes) AS likes
                      FROM songs s WHERE {w} GROUP BY s.author_id ORDER BY {order} LIMIT 30""", tuple(params))
    cards = social.cards_by_ids({r["author_id"] for r in rows})
    names = {r["user_id"]: r["name"] for r in db.all(
        f"SELECT user_id, name FROM artists WHERE user_id IN ({db.placeholders([r['author_id'] for r in rows])})",
        tuple(r["author_id"] for r in rows))} if rows else {}
    return JSONResponse({"items": [{"user": cards[r["author_id"]], "name": names.get(r["author_id"]) or cards[r["author_id"]]["name"],
                                    "songs": r["songs"], "plays": r["plays"] or 0, "likes": r["likes"] or 0}
                                   for r in rows if r["author_id"] in cards]})


@auth()
async def chart(request: Request):
    """Чарт Yarko: 20 песен по прослушиваниям и сердечкам. Лидер (от 20 прослушиваний) получает награду «Хит Yarko»"""
    v = request.state.user["id"]
    w, params = songs_mod._not_blocked(v)
    rows = db.all(f"SELECT s.* FROM songs s WHERE {w} ORDER BY s.plays + s.likes * 5 DESC, s.id DESC LIMIT 20", tuple(params))
    if rows and rows[0]["plays"] >= 20:
        _grant(rows[0]["author_id"], "hit", rows[0]["id"]) if not db.value(
            "SELECT 1 FROM music_awards WHERE user_id=? AND code='hit'", (rows[0]["author_id"],)) else None
    return JSONResponse({"items": songs_mod.views(rows, v)})


# ---------------------------------------------------------------- альбомы
def _album(aid: int) -> dict:
    a = db.one("SELECT * FROM albums WHERE id=?", (aid,))
    if not a:
        raise ApiError(404, "Альбом не найден")
    return a


def _set_tracks(aid: int, uid: int, ids) -> None:
    try:
        ids = [int(x) for x in ids][:50]
    except (TypeError, ValueError):
        raise ApiError(400, "Неверный список песен")
    own = {r["id"] for r in db.all(f"SELECT id FROM songs WHERE author_id=? AND id IN ({db.placeholders(ids)})", (uid, *ids))} if ids else set()
    db.run("UPDATE songs SET album_id=NULL, track_no=0 WHERE album_id=?", (aid,))
    for i, sid in enumerate([x for x in dict.fromkeys(ids) if x in own], 1):
        db.run("UPDATE songs SET album_id=?, track_no=? WHERE id=?", (aid, i, sid))


@auth()
async def get_album(request: Request):
    v = request.state.user["id"]
    a = _album(path_int(request))
    if social.blocked_between(v, a["artist_id"]):
        raise ApiError(404, "Альбом не найден")
    tracks = db.all("SELECT * FROM songs WHERE album_id=? ORDER BY track_no, id", (a["id"],))
    return JSONResponse({**album_views([a])[0], "tracks": songs_mod.views(tracks, v), "mine": a["artist_id"] == v})


@auth(require_verified=True)
async def create_album(request: Request):
    limit(request, "upload")
    v = request.state.user["id"]
    if (db.value("SELECT count(*) FROM albums WHERE artist_id=? AND created_at >= ?", (v, db.future(days=-1))) or 0) >= 5:
        raise ApiError(429, "За сутки можно создать не больше 5 альбомов")
    form = await request.form(max_files=1, max_fields=8, max_part_size=64 * 1024)
    cover = None
    try:
        title = censor(clean_text(str(form.get("title") or ""), 100)).replace("\n", " ")
        if not title:
            raise ApiError(400, "Укажите название альбома")
        kind = str(form.get("kind") or "album")
        kind = kind if kind in KINDS else "album"
        about = censor(clean_text(str(form.get("about") or ""), 1500))
        ids = [x for x in str(form.get("songs") or "").split(",") if x.strip()]
        if not ids:
            raise ApiError(400, "Добавьте в альбом хотя бы одну свою песню")
        f = form.get("cover")
        if getattr(f, "filename", None):
            cover = (await media.save_upload(f, "avatar"))["path"]
    finally:
        await form.close()
    cur = db.run("INSERT INTO albums (artist_id, title, kind, about, cover) VALUES (?,?,?,?,?)", (v, title, kind, about, cover))
    aid = cur.lastrowid
    _set_tracks(aid, v, ids)
    if not db.value("SELECT 1 FROM songs WHERE album_id=?", (aid,)):
        db.run("DELETE FROM albums WHERE id=?", (aid,))
        media.delete_files(cover)
        raise ApiError(400, "В альбом можно добавить только свои песни")
    db.run("INSERT OR IGNORE INTO artists (user_id) VALUES (?)", (v,))
    new = check_awards(v)
    # подписчикам — о новом релизе (не больше 500 человек, без лавины запросов)
    a = _album(aid)
    for r in db.all("SELECT follower_id FROM follows WHERE followee_id=? LIMIT 500", (v,)):
        social.notify(r["follower_id"], v, "new_album", extra={"album_id": aid, "title": title, "kind": KINDS[kind]})
    return JSONResponse({**album_views([a])[0], "new_awards": new}, status_code=201)


@auth()
async def update_album(request: Request):
    limit(request, "write")
    v = request.state.user["id"]
    a = _album(path_int(request))
    if a["artist_id"] != v:
        raise ApiError(404, "Альбом не найден")
    d = await body(request)
    title = censor(clean_text(str(d.get("title", a["title"])), 100)).replace("\n", " ") or a["title"]
    kind = d.get("kind") if d.get("kind") in KINDS else a["kind"]
    about = censor(clean_text(str(d.get("about", a["about"])), 1500))
    db.run("UPDATE albums SET title=?, kind=?, about=? WHERE id=?", (title, kind, about, a["id"]))
    if "songs" in d:
        _set_tracks(a["id"], v, d.get("songs") or [])
    check_awards(v)
    return JSONResponse(album_views([_album(a["id"])])[0])


@auth()
async def delete_album(request: Request):
    u = request.state.user
    a = _album(path_int(request))
    if a["artist_id"] != u["id"] and not u["is_admin"]:
        raise ApiError(403, "Удалить можно только свой альбом")
    db.run("UPDATE songs SET album_id=NULL, track_no=0 WHERE album_id=?", (a["id"],))
    db.run("DELETE FROM albums WHERE id=?", (a["id"],))
    media.delete_files(a["cover"])
    return ok()


routes = [
    Route("/api/music/artists", list_artists, methods=["GET"]),
    Route("/api/music/artists/{username}", get_artist, methods=["GET"]),
    Route("/api/music/artist", update_artist, methods=["PUT", "POST"]),
    Route("/api/music/chart", chart, methods=["GET"]),
    Route("/api/music/albums", create_album, methods=["POST"]),
    Route("/api/music/albums/{id:int}", get_album, methods=["GET"]),
    Route("/api/music/albums/{id:int}", update_album, methods=["PATCH"]),
    Route("/api/music/albums/{id:int}", delete_album, methods=["DELETE"]),
]
