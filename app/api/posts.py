"""Посты, лента, реакции, комментарии, репосты, закладки, хэштеги, жалобы."""
import json
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from .. import collection, config, db, media, music, polls, social
from ..security import censor, clean_text, extract_hashtags, extract_mentions
from ..social import is_friend_sql, not_blocked_sql, visible_post_sql
from ..web import ApiError, auth, body, int_param, limit, ok, path_int

REACTIONS = ("like", "love", "haha", "wow", "sad", "angry")
VISIBILITIES = ("public", "friends", "only_me")
PAGE = 15
PUBLIC_COMMUNITY = "(p.community_id IS NULL OR p.community_id IN (SELECT id FROM communities WHERE is_private = 0))"


# ----------------------------------------------------------------------------
# Сборка постов для ответа API
# ----------------------------------------------------------------------------
def _fetch_visible(ids: list[int], v: int) -> dict[int, dict]:
    if not ids:
        return {}
    params = {"v": v, **{f"i{n}": i for n, i in enumerate(ids)}}
    in_ = ",".join(f":i{n}" for n in range(len(ids)))
    rows = db.all(f"""SELECT p.* FROM posts p JOIN profiles pr ON pr.user_id = p.author_id
                      WHERE p.id IN ({in_}) AND {visible_post_sql()}""", params)
    return {r["id"]: r for r in rows}


def hydrate(rows: list[dict], v: int, depth: int = 0) -> list[dict]:
    if not rows:
        return []
    ids = [r["id"] for r in rows]
    ph = db.placeholders(ids)
    t = tuple(ids)

    authors = social.cards_by_ids(r["author_id"] for r in rows)
    media_rows = db.all(f"SELECT * FROM post_media WHERE post_id IN ({ph}) ORDER BY position", t)
    media_by = {}
    for m in media_rows:
        media_by.setdefault(m["post_id"], []).append(
            {"id": m["id"], "url": m["path"], "thumb": m["thumb"], "width": m["width"], "height": m["height"], "alt": m["alt"]})

    counts = {}
    for r in db.all(f"SELECT post_id, type, count(*) AS n FROM reactions WHERE post_id IN ({ph}) GROUP BY post_id, type", t):
        counts.setdefault(r["post_id"], {})[r["type"]] = r["n"]
    mine = {r["post_id"]: r["type"] for r in
            db.all(f"SELECT post_id, type FROM reactions WHERE user_id=? AND post_id IN ({ph})", (v, *t))}
    comments = {r["post_id"]: r["n"] for r in
                db.all(f"SELECT post_id, count(*) AS n FROM comments WHERE post_id IN ({ph}) GROUP BY post_id", t)}
    reposts = {r["quote_of"]: r["n"] for r in
               db.all(f"SELECT quote_of, count(*) AS n FROM posts WHERE quote_of IN ({ph}) GROUP BY quote_of", t)}
    reposted = {r["quote_of"] for r in
                db.all(f"SELECT quote_of FROM posts WHERE author_id=? AND is_repost=1 AND quote_of IN ({ph})", (v, *t))}
    bookmarked = {r["post_id"] for r in
                  db.all(f"SELECT post_id FROM bookmarks WHERE user_id=? AND post_id IN ({ph})", (v, *t))}

    comm_ids = {r["community_id"] for r in rows if r.get("community_id")}
    comms = {c["id"]: c for c in db.all(
        f"SELECT id, slug, name, avatar, is_private FROM communities WHERE id IN ({db.placeholders(comm_ids)})",
        tuple(comm_ids))} if comm_ids else {}
    circ_ids = {r["circle_id"] for r in rows if r.get("circle_id") and r["author_id"] == v}
    circles = {c["id"]: c["name"] for c in db.all(
        f"SELECT id, name FROM circles WHERE id IN ({db.placeholders(circ_ids)})", tuple(circ_ids))} if circ_ids else {}
    can_mod = set()
    if comm_ids:
        can_mod = {r["community_id"] for r in db.all(
            f"""SELECT community_id FROM community_members WHERE user_id=? AND role IN ('admin','moderator')
                AND status='member' AND community_id IN ({db.placeholders(comm_ids)})""", (v, *comm_ids))}

    poll_by = polls.views(ids, v)

    quotes = {}
    if depth == 0:
        q_ids = [r["quote_of"] for r in rows if r["quote_of"]]
        visible = _fetch_visible(q_ids, v)
        for q in hydrate(list(visible.values()), v, depth=1):
            quotes[q["id"]] = q

    out = []
    for r in rows:
        c = counts.get(r["id"], {})
        item = {
            "id": r["id"],
            "author": authors.get(r["author_id"]),
            "text": r["text"],
            "visibility": r["visibility"],
            "created_at": r["created_at"],
            "edited_at": r["edited_at"],
            "is_repost": bool(r["is_repost"]),
            "media": media_by.get(r["id"], []),
            "reactions": {"counts": c, "total": sum(c.values()), "mine": mine.get(r["id"])},
            "comments_count": comments.get(r["id"], 0),
            "reposts_count": reposts.get(r["id"], 0),
            "reposted": r["id"] in reposted,
            "bookmarked": r["id"] in bookmarked,
            "is_mine": r["author_id"] == v,
            "community": comms.get(r.get("community_id")),
            "as_community": bool(r.get("as_community")),
            "circle": circles.get(r.get("circle_id")) if r.get("circle_id") else None,
            "can_moderate": r.get("community_id") in can_mod,
            "poll": poll_by.get(r["id"]),
            "music": _music(r.get("music")),
        }
        if r["quote_of"] and depth == 0:
            item["quote"] = quotes.get(r["quote_of"]) or {"unavailable": True}
        elif r["quote_of"]:
            item["quote"] = {"id": r["quote_of"], "nested": True}
        out.append(item)
    return out


def _music(raw) -> dict | None:
    if not raw:
        return None
    try:
        t = json.loads(raw)
    except (TypeError, ValueError):
        return None
    return t if isinstance(t, dict) and t.get("key") and not t.get("preview") else None


def _page(rows: list[dict], v: int) -> dict:
    items = hydrate(rows[:PAGE], v)
    return {"items": items, "next_cursor": rows[PAGE - 1]["id"] if len(rows) > PAGE else None}


def get_visible_post(post_id: int, v: int) -> dict:
    row = _fetch_visible([post_id], v).get(post_id)
    if not row:
        raise ApiError(404, "Запись не найдена или скрыта настройками приватности")
    return row


def is_shareable(post: dict) -> bool:
    """Можно ли репостить/цитировать: публичная запись не из закрытого сообщества и не для круга."""
    if post["community_id"]:
        return not db.value("SELECT is_private FROM communities WHERE id=?", (post["community_id"],))
    return post["visibility"] == "public"


def community_role(community_id: int, v: int) -> str | None:
    return db.value("SELECT role FROM community_members WHERE community_id=? AND user_id=? AND status='member'",
                    (community_id, v))


def _profile_by_username(username: str) -> dict:
    row = db.one("SELECT * FROM profiles WHERE username=?", (username,))
    if not row:
        raise ApiError(404, "Пользователь не найден")
    return row


# ----------------------------------------------------------------------------
# Ленты
# ----------------------------------------------------------------------------
@auth()
async def feed(request: Request):
    v = request.state.user["id"]
    cursor = int_param(request, "cursor", 2**62)
    rows = db.all(f"""
        SELECT p.* FROM posts p JOIN profiles pr ON pr.user_id = p.author_id
        WHERE p.id < :cursor
          AND ((p.community_id IS NULL AND (p.author_id = :v
                    OR p.author_id IN ({social.FRIEND_IDS_SQL})
                    OR p.author_id IN (SELECT followee_id FROM follows WHERE follower_id = :v)))
               OR p.community_id IN ({social.MY_COMMUNITIES_SQL}))
          AND {visible_post_sql()}
        ORDER BY p.id DESC LIMIT :lim""", {"v": v, "cursor": cursor, "lim": PAGE + 1})
    return JSONResponse(_page(rows, v))


@auth()
async def explore(request: Request):
    """Все публичные записи — для новичков, у которых пока нет друзей."""
    v = request.state.user["id"]
    cursor = int_param(request, "cursor", 2**62)
    rows = db.all(f"""
        SELECT p.* FROM posts p JOIN profiles pr ON pr.user_id = p.author_id
        WHERE p.id < :cursor AND p.is_repost = 0 AND {visible_post_sql()}
        ORDER BY p.id DESC LIMIT :lim""", {"v": v, "cursor": cursor, "lim": PAGE + 1})
    return JSONResponse(_page(rows, v))


def _can_view_profile_content(v: int, prof: dict) -> bool:
    uid = prof["user_id"]
    if uid == v:
        return True
    if social.blocked_between(v, uid):
        return False
    return prof["profile_visibility"] == "public" or social.are_friends(v, uid)


@auth()
async def user_posts(request: Request):
    v = request.state.user["id"]
    prof = _profile_by_username(request.path_params["username"])
    if not _can_view_profile_content(v, prof):
        return JSONResponse({"items": [], "next_cursor": None, "hidden": True})
    cursor = int_param(request, "cursor", 2**62)
    rows = db.all(f"""
        SELECT p.* FROM posts p JOIN profiles pr ON pr.user_id = p.author_id
        WHERE p.author_id = :uid AND p.community_id IS NULL AND p.id < :cursor AND {visible_post_sql()}
        ORDER BY p.id DESC LIMIT :lim""", {"v": v, "uid": prof["user_id"], "cursor": cursor, "lim": PAGE + 1})
    return JSONResponse(_page(rows, v))


@auth()
async def user_photos(request: Request):
    v = request.state.user["id"]
    prof = _profile_by_username(request.path_params["username"])
    if not _can_view_profile_content(v, prof):
        return JSONResponse({"items": [], "next_cursor": None, "hidden": True})
    cursor = int_param(request, "cursor", 2**62)
    rows = db.all(f"""
        SELECT m.id, m.post_id, m.path AS url, m.thumb, m.width, m.height, m.alt
        FROM post_media m JOIN posts p ON p.id = m.post_id JOIN profiles pr ON pr.user_id = p.author_id
        WHERE p.author_id = :uid AND p.community_id IS NULL AND m.id < :cursor AND {visible_post_sql()}
        ORDER BY m.id DESC LIMIT 31""", {"v": v, "uid": prof["user_id"], "cursor": cursor})
    return JSONResponse({"items": rows[:30], "next_cursor": rows[29]["id"] if len(rows) > 30 else None})


@auth()
async def tag_posts(request: Request):
    v = request.state.user["id"]
    tag = request.path_params["tag"].lower().lstrip("#")
    cursor = int_param(request, "cursor", 2**62)
    rows = db.all(f"""
        SELECT p.* FROM posts p JOIN profiles pr ON pr.user_id = p.author_id
        JOIN post_hashtags ph ON ph.post_id = p.id JOIN hashtags h ON h.id = ph.hashtag_id
        WHERE h.tag = :tag AND p.id < :cursor AND {visible_post_sql()}
        ORDER BY p.id DESC LIMIT :lim""", {"v": v, "tag": tag, "cursor": cursor, "lim": PAGE + 1})
    data = _page(rows, v)
    data["tag"] = tag
    data["total"] = db.value("""SELECT count(*) FROM post_hashtags ph JOIN hashtags h ON h.id=ph.hashtag_id
                                WHERE h.tag=?""", (tag,))
    return JSONResponse(data)


@auth()
async def bookmarks(request: Request):
    v = request.state.user["id"]
    cursor = int_param(request, "cursor", 2**62)
    rows = db.all(f"""
        SELECT p.*, b.rowid AS bid FROM bookmarks b JOIN posts p ON p.id = b.post_id
        JOIN profiles pr ON pr.user_id = p.author_id
        WHERE b.user_id = :v AND b.rowid < :cursor AND {visible_post_sql()}
        ORDER BY b.rowid DESC LIMIT :lim""", {"v": v, "cursor": cursor, "lim": PAGE + 1})
    items = hydrate(rows[:PAGE], v)
    return JSONResponse({"items": items, "next_cursor": rows[PAGE - 1]["bid"] if len(rows) > PAGE else None})


_trends_cache: tuple[float, list] = (float("-inf"), [])


@auth()
async def trends(request: Request):
    """Популярные теги одинаковы для всех — считаем раз в минуту, а не на каждый запрос."""
    global _trends_cache
    import time
    if time.monotonic() - _trends_cache[0] < 60:
        return JSONResponse({"items": _trends_cache[1]})
    rows = db.all(f"""
        SELECT h.tag, count(*) AS n FROM post_hashtags ph
        JOIN hashtags h ON h.id = ph.hashtag_id JOIN posts p ON p.id = ph.post_id
        WHERE p.visibility = 'public' AND p.created_at >= ? AND {PUBLIC_COMMUNITY}
        GROUP BY h.id ORDER BY n DESC, max(p.id) DESC LIMIT 8""", (db.future(hours=-24),))
    if len(rows) < 3:  # если за сутки мало — берём неделю
        rows = db.all(f"""
            SELECT h.tag, count(*) AS n FROM post_hashtags ph
            JOIN hashtags h ON h.id = ph.hashtag_id JOIN posts p ON p.id = ph.post_id
            WHERE p.visibility = 'public' AND p.created_at >= ? AND {PUBLIC_COMMUNITY}
            GROUP BY h.id ORDER BY n DESC LIMIT 8""", (db.future(days=-7),))
    _trends_cache = (time.monotonic(), rows)
    return JSONResponse({"items": rows})


# ----------------------------------------------------------------------------
# Создание, просмотр, изменение, удаление
# ----------------------------------------------------------------------------
def _index_text(post_id: int, author_id: int, text: str, visibility: str, notify_mentions: bool) -> None:
    db.run("DELETE FROM post_hashtags WHERE post_id=?", (post_id,))
    for tag in extract_hashtags(text):
        db.run("INSERT OR IGNORE INTO hashtags (tag) VALUES (?)", (tag,))
        hid = db.value("SELECT id FROM hashtags WHERE tag=?", (tag,))
        db.run("INSERT OR IGNORE INTO post_hashtags (post_id, hashtag_id) VALUES (?,?)", (post_id, hid))
    old = {r["user_id"] for r in db.all("SELECT user_id FROM mentions WHERE post_id=?", (post_id,))}
    db.run("DELETE FROM mentions WHERE post_id=?", (post_id,))
    for uname in extract_mentions(text):
        row = db.one("SELECT user_id FROM profiles WHERE username=?", (uname,))
        if not row or row["user_id"] == author_id:
            continue
        uid = row["user_id"]
        db.run("INSERT OR IGNORE INTO mentions (post_id, user_id) VALUES (?,?)", (post_id, uid))
        can_see = bool(_fetch_visible([post_id], uid))
        if notify_mentions and can_see and uid not in old:
            social.notify(uid, author_id, "mention", post_id=post_id)


@auth(require_verified=True)
async def create_post(request: Request):
    limit(request, "write")
    v = request.state.user["id"]
    form = await request.form(max_files=config.MAX_PHOTOS_PER_POST + 1, max_fields=40, max_part_size=64 * 1024)
    try:
        return await _create_post(request, v, form)
    finally:
        await form.close()


async def _create_post(request: Request, v: int, form):
    text = censor(clean_text(form.get("text"), config.POST_MAX_LEN))
    visibility = form.get("visibility") or db.value("SELECT default_visibility FROM profiles WHERE user_id=?", (v,))
    if visibility not in VISIBILITIES:
        raise ApiError(400, "Неизвестная настройка видимости")
    files = [f for f in form.getlist("photos") if getattr(f, "filename", None)]
    alts = form.getlist("alts")
    if len(files) > config.MAX_PHOTOS_PER_POST:
        raise ApiError(400, f"Не больше {config.MAX_PHOTOS_PER_POST} фото в одной записи")

    quote_of = form.get("quote_of")
    if quote_of:
        try:
            quote_of = int(quote_of)
        except ValueError:
            raise ApiError(400, "Некорректная запись для цитирования")
        target = get_visible_post(quote_of, v)
        if target["is_repost"] and target["quote_of"]:
            target = get_visible_post(target["quote_of"], v)
        if not is_shareable(target):
            raise ApiError(403, "Цитировать можно только публичные записи")
        quote_of = target["id"]
    else:
        quote_of = None

    poll = polls.parse(form.get("poll"))
    if poll and not poll["question"]:
        poll["question"] = text[:200]
    music_json = None
    if form.get("music"):  # трек из раздела «Музыка»: данные берём из источника, а не от клиента
        from starlette.concurrency import run_in_threadpool
        track = music.public(await run_in_threadpool(music.resolve, str(form.get("music"))[:100]))
        if not track:
            raise ApiError(400, "Трек недоступен — попробуйте другой")
        music_json = json.dumps(track, ensure_ascii=False)
    if not text and not files and not quote_of and not poll and not music_json:
        raise ApiError(400, "Напишите текст или добавьте фото")

    community_id = form.get("community_id")
    as_community = 0
    circle_id = None
    if community_id:
        try:
            community_id = int(community_id)
        except ValueError:
            raise ApiError(400, "Некорректное сообщество")
        comm = db.one("SELECT * FROM communities WHERE id=?", (community_id,))
        if not comm:
            raise ApiError(404, "Сообщество не найдено")
        role = community_role(community_id, v)
        if role in ("admin", "moderator"):
            as_community = 1 if form.get("as_community", "1") == "1" else 0
        elif not (role == "member" and comm["wall_open"]):
            raise ApiError(403, "Публиковать в этом сообществе могут только администраторы")
        visibility = "public"
    else:
        community_id = None
        if form.get("circle_id"):
            try:
                circle_id = int(form.get("circle_id"))
            except ValueError:
                raise ApiError(400, "Некорректный круг")
            if not db.value("SELECT 1 FROM circles WHERE id=? AND owner_id=?", (circle_id, v)):
                raise ApiError(404, "Круг не найден")
            visibility = "friends"

    if files:
        limit(request, "upload")
    saved = []
    try:
        for f in files:
            saved.append(await media.save_upload(f, "post"))
    except Exception:
        for s in saved:
            media.delete_files(s["path"])
        raise

    with db.tx() as c:
        cur = c.execute("""INSERT INTO posts (author_id, text, visibility, quote_of, community_id, as_community, circle_id, music)
                           VALUES (?,?,?,?,?,?,?,?)""", (v, text, visibility, quote_of, community_id, as_community, circle_id, music_json))
        pid = cur.lastrowid
        for i, s in enumerate(saved):
            alt = clean_text(alts[i] if i < len(alts) and isinstance(alts[i], str) else "", 300)
            c.execute("INSERT INTO post_media (post_id, path, thumb, width, height, alt, position) VALUES (?,?,?,?,?,?,?)",
                      (pid, s["path"], s["thumb"], s["width"], s["height"], alt, i))
        if poll:
            polls.create(c, pid, poll)
    _index_text(pid, v, text, visibility, notify_mentions=True)
    if quote_of:
        author = db.value("SELECT author_id FROM posts WHERE id=?", (quote_of,))
        social.notify(author, v, "quote", post_id=pid)
    row = db.one("SELECT * FROM posts WHERE id=?", (pid,))
    return JSONResponse(hydrate([row], v)[0], status_code=201)


@auth()
async def vote(request: Request):
    """Голос в опросе. option_ids: [] — отозвать голос."""
    limit(request, "write")
    v = request.state.user["id"]
    poll = db.one("SELECT * FROM polls WHERE id=?", (path_int(request),))
    if not poll:
        raise ApiError(404, "Опрос не найден")
    get_visible_post(poll["post_id"], v)  # проверка доступа к записи
    if poll["closes_at"] and poll["closes_at"] < db.now():
        raise ApiError(400, "Голосование закончилось")
    data = await body(request)
    try:
        chosen = [int(x) for x in (data.get("option_ids") or [])]
    except (TypeError, ValueError):
        raise ApiError(400, "Некорректный выбор")
    valid = {r["id"] for r in db.all("SELECT id FROM poll_options WHERE poll_id=?", (poll["id"],))}
    chosen = list(dict.fromkeys(x for x in chosen if x in valid))
    if len(chosen) > 1 and not poll["multiple"]:
        raise ApiError(400, "В этом опросе можно выбрать только один вариант")
    with db.tx() as c:
        c.execute("DELETE FROM poll_votes WHERE poll_id=? AND user_id=?", (poll["id"], v))
        for oid in chosen:
            c.execute("INSERT INTO poll_votes (poll_id, option_id, user_id) VALUES (?,?,?)", (poll["id"], oid, v))
    return JSONResponse(polls.views([poll["post_id"]], v)[poll["post_id"]])


@auth()
async def get_post(request: Request):
    v = request.state.user["id"]
    row = get_visible_post(path_int(request), v)
    return JSONResponse(hydrate([row], v)[0])


@auth(require_verified=True)
async def update_post(request: Request):
    limit(request, "write")
    v = request.state.user["id"]
    pid = path_int(request)
    row = db.one("SELECT * FROM posts WHERE id=? AND author_id=?", (pid, v))
    if not row:
        raise ApiError(404, "Запись не найдена")
    if row["is_repost"]:
        raise ApiError(400, "Репост нельзя редактировать")
    data = await body(request)
    text = censor(clean_text(data.get("text", row["text"]), config.POST_MAX_LEN))
    visibility = data.get("visibility", row["visibility"])
    if visibility not in VISIBILITIES:
        raise ApiError(400, "Неизвестная настройка видимости")
    if row["community_id"]:
        visibility = "public"
    circle_id = row["circle_id"] if visibility == "friends" else None
    has_media = db.value("SELECT 1 FROM post_media WHERE post_id=?", (pid,))
    if not text and not has_media and not row["quote_of"]:
        raise ApiError(400, "Запись не может быть пустой")
    db.run("UPDATE posts SET text=?, visibility=?, circle_id=?, edited_at=? WHERE id=?",
           (text, visibility, circle_id, db.now() if text != row["text"] else row["edited_at"], pid))
    _index_text(pid, v, text, visibility, notify_mentions=True)
    return JSONResponse(hydrate([db.one("SELECT * FROM posts WHERE id=?", (pid,))], v)[0])


def delete_post_files(post_ids: list[int]) -> None:
    for m in db.all(f"SELECT path FROM post_media WHERE post_id IN ({db.placeholders(post_ids)})", tuple(post_ids)):
        media.delete_files(m["path"])


@auth()
async def delete_post(request: Request):
    v = request.state.user
    pid = path_int(request)
    row = db.one("SELECT * FROM posts WHERE id=?", (pid,))
    is_mod = bool(row and row["community_id"] and community_role(row["community_id"], v["id"]) in ("admin", "moderator"))
    if not row or (row["author_id"] != v["id"] and not v["is_admin"] and not is_mod):
        raise ApiError(404, "Запись не найдена")
    delete_post_files([pid])
    # простые репосты удалённой записи теряют смысл — удаляем их тоже
    db.run("DELETE FROM posts WHERE quote_of=? AND is_repost=1", (pid,))
    db.run("DELETE FROM posts WHERE id=?", (pid,))
    return ok()


# ----------------------------------------------------------------------------
# Реакции, репосты, закладки
# ----------------------------------------------------------------------------
@auth()
async def react(request: Request):
    limit(request, "write")
    v = request.state.user["id"]
    post = get_visible_post(path_int(request), v)
    data = await body(request)
    rtype = data.get("type", "like")
    if rtype not in REACTIONS:
        raise ApiError(400, "Неизвестная реакция")
    prev = db.value("SELECT type FROM reactions WHERE post_id=? AND user_id=?", (post["id"], v))
    db.run("""INSERT INTO reactions (post_id, user_id, type) VALUES (?,?,?)
              ON CONFLICT(post_id, user_id) DO UPDATE SET type=excluded.type, created_at=excluded.created_at""",
           (post["id"], v, rtype))
    if prev:
        social.unnotify(post["author_id"], v, "reaction", post["id"])
    social.notify(post["author_id"], v, "reaction", post_id=post["id"], extra={"reaction": rtype})
    collection.check(post["author_id"])
    return JSONResponse(hydrate([post], v)[0]["reactions"])


@auth()
async def unreact(request: Request):
    v = request.state.user["id"]
    post = get_visible_post(path_int(request), v)
    db.run("DELETE FROM reactions WHERE post_id=? AND user_id=?", (post["id"], v))
    social.unnotify(post["author_id"], v, "reaction", post["id"])
    return JSONResponse(hydrate([post], v)[0]["reactions"])


@auth()
async def reactions_list(request: Request):
    v = request.state.user["id"]
    post = get_visible_post(path_int(request), v)
    rows = db.all("""SELECT r.type, p.user_id AS id, p.username, p.name, p.avatar FROM reactions r
                     JOIN profiles p ON p.user_id = r.user_id WHERE r.post_id=? ORDER BY r.created_at DESC LIMIT 200""",
                  (post["id"],))
    return JSONResponse({"items": [{"type": r["type"], "user": social.user_card(r)} for r in rows]})


@auth(require_verified=True)
async def repost(request: Request):
    limit(request, "write")
    v = request.state.user["id"]
    post = get_visible_post(path_int(request), v)
    if post["is_repost"] and post["quote_of"]:
        post = get_visible_post(post["quote_of"], v)
    if not is_shareable(post):
        raise ApiError(403, "Делиться можно только публичными записями")
    if post["author_id"] == v:
        raise ApiError(400, "Нельзя сделать репост своей записи — используйте цитату")
    exists = db.value("SELECT id FROM posts WHERE author_id=? AND is_repost=1 AND quote_of=?", (v, post["id"]))
    if not exists:
        db.run("INSERT INTO posts (author_id, text, visibility, quote_of, is_repost) VALUES (?, '', 'public', ?, 1)",
               (v, post["id"]))
        social.notify(post["author_id"], v, "repost", post_id=post["id"])
    return JSONResponse(hydrate([post], v)[0])


@auth()
async def unrepost(request: Request):
    v = request.state.user["id"]
    pid = path_int(request)
    db.run("DELETE FROM posts WHERE author_id=? AND is_repost=1 AND quote_of=?", (v, pid))
    author = db.value("SELECT author_id FROM posts WHERE id=?", (pid,))
    if author:
        social.unnotify(author, v, "repost", pid)
    post = get_visible_post(pid, v)
    return JSONResponse(hydrate([post], v)[0])


@auth()
async def bookmark(request: Request):
    v = request.state.user["id"]
    post = get_visible_post(path_int(request), v)
    if request.method == "POST":
        db.run("INSERT OR IGNORE INTO bookmarks (user_id, post_id) VALUES (?,?)", (v, post["id"]))
    else:
        db.run("DELETE FROM bookmarks WHERE user_id=? AND post_id=?", (v, post["id"]))
    return JSONResponse({"bookmarked": request.method == "POST"})


# ----------------------------------------------------------------------------
# Комментарии
# ----------------------------------------------------------------------------
def _comment_view(r: dict, authors: dict, v: int, post_author: int) -> dict:
    return {"id": r["id"], "post_id": r["post_id"], "parent_id": r["parent_id"], "text": r["text"],
            "created_at": r["created_at"], "author": authors.get(r["author_id"]),
            "can_delete": r["author_id"] == v or post_author == v}


@auth()
async def comments(request: Request):
    v = request.state.user["id"]
    post = get_visible_post(path_int(request), v)
    rows = db.all(f"""SELECT c.* FROM comments c WHERE c.post_id = :pid AND {not_blocked_sql('c.author_id')}
                      ORDER BY c.id LIMIT 500""", {"pid": post["id"], "v": v})
    authors = social.cards_by_ids(r["author_id"] for r in rows)
    roots, by_id = [], {}
    for r in rows:
        view = _comment_view(r, authors, v, post["author_id"])
        if r["parent_id"] is None:
            view["replies"] = []
            roots.append(view)
            by_id[r["id"]] = view
        elif r["parent_id"] in by_id:
            by_id[r["parent_id"]]["replies"].append(view)
    return JSONResponse({"items": roots, "total": len(rows)})


@auth(require_verified=True)
async def add_comment(request: Request):
    limit(request, "write")
    v = request.state.user["id"]
    post = get_visible_post(path_int(request), v)
    data = await body(request)
    text = censor(clean_text(data.get("text"), config.COMMENT_MAX_LEN))
    if not text:
        raise ApiError(400, "Комментарий не может быть пустым")
    parent_id = data.get("parent_id")
    parent = None
    if parent_id:
        parent = db.one("SELECT * FROM comments WHERE id=? AND post_id=?", (int(parent_id), post["id"]))
        if not parent:
            raise ApiError(404, "Комментарий не найден")
        if parent["parent_id"]:  # только один уровень вложенности
            parent = db.one("SELECT * FROM comments WHERE id=?", (parent["parent_id"],))
    cur = db.run("INSERT INTO comments (post_id, author_id, parent_id, text) VALUES (?,?,?,?)",
                 (post["id"], v, parent["id"] if parent else None, text))
    cid = cur.lastrowid
    notified = {v}
    reply_to = None
    if parent_id:
        reply_to = db.value("SELECT author_id FROM comments WHERE id=?", (int(parent_id),))
    if reply_to and reply_to not in notified:
        social.notify(reply_to, v, "reply", post_id=post["id"], comment_id=cid)
        notified.add(reply_to)
    if post["author_id"] not in notified:
        social.notify(post["author_id"], v, "comment", post_id=post["id"], comment_id=cid)
        notified.add(post["author_id"])
    for uname in extract_mentions(text):
        uid = db.value("SELECT user_id FROM profiles WHERE username=?", (uname,))
        if uid and uid not in notified and _fetch_visible([post["id"]], uid):
            social.notify(uid, v, "mention", post_id=post["id"], comment_id=cid)
            notified.add(uid)
    row = db.one("SELECT * FROM comments WHERE id=?", (cid,))
    view = _comment_view(row, social.cards_by_ids([v]), v, post["author_id"])
    view["replies"] = []
    return JSONResponse(view, status_code=201)


@auth()
async def delete_comment(request: Request):
    u = request.state.user
    cid = path_int(request)
    row = db.one("""SELECT c.*, p.author_id AS post_author FROM comments c JOIN posts p ON p.id = c.post_id
                    WHERE c.id=?""", (cid,))
    if not row or u["id"] not in (row["author_id"], row["post_author"]) and not u["is_admin"]:
        raise ApiError(404, "Комментарий не найден")
    db.run("DELETE FROM comments WHERE id=?", (cid,))
    return ok()


# ----------------------------------------------------------------------------
# Жалобы
# ----------------------------------------------------------------------------
def _report_target_visible(ttype: str, tid: int, v: int) -> bool:
    """Пожаловаться можно только на то, что человек может видеть. Иначе по ответам на жалобы
    можно было бы перебирать номера и узнавать, существуют ли закрытые записи, истории и сообщения."""
    if ttype == "post":
        return bool(_fetch_visible([tid], v))
    if ttype == "comment":
        pid = db.value("SELECT post_id FROM comments WHERE id=?", (tid,))
        return bool(pid and _fetch_visible([pid], v))
    if ttype == "user":
        return tid != v and bool(db.value("SELECT 1 FROM users WHERE id=?", (tid,)))
    if ttype == "reel":
        return bool(db.value("SELECT 1 FROM reels WHERE id=?", (tid,)))
    if ttype == "reel_comment":
        return bool(db.value("SELECT 1 FROM reel_comments WHERE id=?", (tid,)))
    if ttype == "message":
        return bool(db.value("""SELECT 1 FROM messages m JOIN conversation_members cm
                                ON cm.conversation_id = m.conversation_id AND cm.user_id = ? WHERE m.id = ?""", (v, tid)))
    if ttype == "story":
        from .stories import _visible_sql
        return bool(db.value(f"""SELECT 1 FROM stories s JOIN profiles pr ON pr.user_id = s.author_id
                                 WHERE s.id = :id AND {_visible_sql()}""", {"id": tid, "v": v}))
    if ttype == "community":
        return bool(db.value("SELECT 1 FROM communities WHERE id=?", (tid,)))
    return False


@auth()
async def report(request: Request):
    limit(request, "write")
    limit(request, "report")
    data = await body(request)
    ttype = data.get("target_type")
    from .admin import TARGETS
    if ttype not in TARGETS:
        raise ApiError(400, "Неизвестный тип жалобы")
    try:
        tid = int(data.get("target_id"))
    except (TypeError, ValueError):
        raise ApiError(400, "Не указан объект жалобы")
    reason = clean_text(data.get("reason"), 500)
    if not reason:
        raise ApiError(400, "Выберите причину жалобы")
    v = request.state.user["id"]
    if not _report_target_visible(ttype, tid, v):
        raise ApiError(404, "Не найдено")
    # одна открытая жалоба от человека на одно и то же
    if not db.value("SELECT 1 FROM reports WHERE reporter_id=? AND target_type=? AND target_id=? AND status='open'", (v, ttype, tid)):
        db.run("INSERT INTO reports (reporter_id, target_type, target_id, reason) VALUES (?,?,?,?)", (v, ttype, tid, reason))
        for aid in [r["id"] for r in db.all("SELECT id FROM users WHERE is_admin=1")]:
            social.push_counters(aid)
    return ok()


routes = [
    Route("/api/feed", feed, methods=["GET"]),
    Route("/api/explore", explore, methods=["GET"]),
    Route("/api/trends", trends, methods=["GET"]),
    Route("/api/bookmarks", bookmarks, methods=["GET"]),
    Route("/api/tags/{tag}", tag_posts, methods=["GET"]),
    Route("/api/users/{username}/posts", user_posts, methods=["GET"]),
    Route("/api/users/{username}/photos", user_photos, methods=["GET"]),
    Route("/api/posts", create_post, methods=["POST"]),
    Route("/api/posts/{id:int}", get_post, methods=["GET"]),
    Route("/api/posts/{id:int}", update_post, methods=["PATCH"]),
    Route("/api/posts/{id:int}", delete_post, methods=["DELETE"]),
    Route("/api/posts/{id:int}/react", react, methods=["POST"]),
    Route("/api/posts/{id:int}/react", unreact, methods=["DELETE"]),
    Route("/api/posts/{id:int}/reactions", reactions_list, methods=["GET"]),
    Route("/api/posts/{id:int}/repost", repost, methods=["POST"]),
    Route("/api/posts/{id:int}/repost", unrepost, methods=["DELETE"]),
    Route("/api/posts/{id:int}/bookmark", bookmark, methods=["POST", "DELETE"]),
    Route("/api/polls/{id:int}/vote", vote, methods=["POST"]),
    Route("/api/posts/{id:int}/comments", comments, methods=["GET"]),
    Route("/api/posts/{id:int}/comments", add_comment, methods=["POST"]),
    Route("/api/comments/{id:int}", delete_comment, methods=["DELETE"]),
    Route("/api/reports", report, methods=["POST"]),
]
