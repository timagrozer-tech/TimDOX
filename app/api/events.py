"""Мероприятия: дата, место, «Пойду / Возможно / Не пойду», приглашения друзей."""
from datetime import datetime, timezone

from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from .. import db, media, social
from ..security import censor, clean_text
from ..social import community_visible_sql, is_friend_sql, not_blocked_sql
from ..web import ApiError, auth, body, limit, ok, path_int

STATUSES = ("going", "maybe", "declined")


def _visible_sql() -> str:
    """Зритель :v видит мероприятие e."""
    invited = "EXISTS (SELECT 1 FROM event_members emx WHERE emx.event_id = e.id AND emx.user_id = :v)"
    return f"""(e.creator_id = :v OR {invited} OR ({not_blocked_sql("e.creator_id")} AND (
        (e.community_id IS NOT NULL AND {community_visible_sql("e.community_id")})
        OR (e.community_id IS NULL AND (e.visibility = 'public' OR (e.visibility = 'friends' AND {is_friend_sql("e.creator_id")}))))))"""


def _parse_dt(value, field: str) -> str | None:
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        raise ApiError(422, f"Некорректная дата: {field}")
    # клиент присылает время в UTC (toISOString); время без часового пояса считаем UTC
    dt = dt.astimezone(timezone.utc) if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.000Z")


def _view(rows: list[dict], v: int) -> list[dict]:
    if not rows:
        return []
    ids = [r["id"] for r in rows]
    ph = db.placeholders(ids)
    counts = {}
    for r in db.all(f"SELECT event_id, status, count(*) AS n FROM event_members WHERE event_id IN ({ph}) GROUP BY event_id, status", tuple(ids)):
        counts.setdefault(r["event_id"], {})[r["status"]] = r["n"]
    mine = {r["event_id"]: r["status"] for r in db.all(
        f"SELECT event_id, status FROM event_members WHERE user_id=? AND event_id IN ({ph})", (v, *ids))}
    creators = social.cards_by_ids(r["creator_id"] for r in rows)
    comm_ids = {r["community_id"] for r in rows if r["community_id"]}
    comms = {c["id"]: c for c in db.all(
        f"SELECT id, slug, name, avatar FROM communities WHERE id IN ({db.placeholders(comm_ids)})", tuple(comm_ids))} if comm_ids else {}
    out = []
    for r in rows:
        c = counts.get(r["id"], {})
        out.append({
            "id": r["id"], "title": r["title"], "description": r["description"], "place": r["place"],
            "starts_at": r["starts_at"], "ends_at": r["ends_at"], "cover": r["cover"], "visibility": r["visibility"],
            "creator": creators.get(r["creator_id"]), "community": comms.get(r["community_id"]),
            "going": c.get("going", 0), "maybe": c.get("maybe", 0), "invited": c.get("invited", 0),
            "my_status": mine.get(r["id"]), "can_edit": r["creator_id"] == v,
        })
    return out


def _get(eid: int, v: int) -> dict:
    row = db.one(f"SELECT e.* FROM events e WHERE e.id = :id AND {_visible_sql()}", {"id": eid, "v": v})
    if not row:
        raise ApiError(404, "Мероприятие не найдено")
    return row


@auth()
async def list_events(request: Request):
    v = request.state.user["id"]
    tab = request.query_params.get("tab", "upcoming")
    now = db.now()
    params = {"v": v, "now": now}
    if tab == "mine":
        where = "e.id IN (SELECT event_id FROM event_members WHERE user_id = :v AND status IN ('going','maybe')) OR e.creator_id = :v"
        order = "e.starts_at"
        extra = "AND coalesce(e.ends_at, e.starts_at) >= :now"
    elif tab == "invites":
        where = "e.id IN (SELECT event_id FROM event_members WHERE user_id = :v AND status = 'invited')"
        order, extra = "e.starts_at", "AND e.starts_at >= :now"
    elif tab == "past":
        where = "e.id IN (SELECT event_id FROM event_members WHERE user_id = :v) OR e.creator_id = :v"
        order, extra = "e.starts_at DESC", "AND coalesce(e.ends_at, e.starts_at) < :now"
    else:
        where = "TRUE"
        order, extra = "e.starts_at", "AND coalesce(e.ends_at, e.starts_at) >= :now"
    rows = db.all(f"SELECT e.* FROM events e WHERE ({where}) {extra} AND {_visible_sql()} ORDER BY {order} LIMIT 50", params)
    return JSONResponse({"items": _view(rows, v)})


@auth(require_verified=True)
async def create_event(request: Request):
    limit(request, "write")
    v = request.state.user["id"]
    form = await request.form(max_files=1, max_fields=20, max_part_size=16 * 1024)
    try:
        title = censor(clean_text(form.get("title"), 120))
        errors = {}
        if len(title) < 3:
            errors["title"] = "Название — от 3 символов"
        starts = _parse_dt(form.get("starts_at"), "начало")
        ends = _parse_dt(form.get("ends_at"), "окончание")
        if not starts:
            errors["starts_at"] = "Укажите дату и время начала"
        elif ends and ends < starts:
            errors["ends_at"] = "Окончание раньше начала"
        visibility = form.get("visibility") or "public"
        if visibility not in ("public", "friends", "invited"):
            errors["visibility"] = "Недопустимое значение"
        community_id = form.get("community_id") or None
        if community_id:
            community_id = int(community_id)
            role = db.value("SELECT role FROM community_members WHERE community_id=? AND user_id=? AND status='member'", (community_id, v))
            if role not in ("admin", "moderator"):
                raise ApiError(403, "Создавать мероприятия сообщества могут администраторы")
        if errors:
            return JSONResponse({"error": "Проверьте поля формы", "fields": errors}, status_code=422)
        cover = form.get("cover")
        saved = await media.save_upload(cover, "event") if getattr(cover, "filename", None) else None
    finally:
        await form.close()
    eid = db.run("""INSERT INTO events (creator_id, community_id, title, description, place, starts_at, ends_at, cover, visibility)
                    VALUES (?,?,?,?,?,?,?,?,?)""",
                 (v, community_id, title, censor(clean_text(form.get("description"), 3000)),
                  clean_text(form.get("place"), 200), starts, ends, saved["path"] if saved else None, visibility)).lastrowid
    db.run("INSERT INTO event_members (event_id, user_id, status) VALUES (?,?, 'going')", (eid, v))
    return JSONResponse(_view([db.one("SELECT * FROM events WHERE id=?", (eid,))], v)[0], status_code=201)


@auth()
async def get_event(request: Request):
    v = request.state.user["id"]
    e = _get(path_int(request), v)
    data = _view([e], v)[0]
    rows = db.all("""SELECT p.user_id AS id, p.username, p.name, p.avatar, em.status FROM event_members em
                     JOIN profiles p ON p.user_id = em.user_id WHERE em.event_id=? AND em.status IN ('going','maybe')
                     ORDER BY em.status, em.updated_at LIMIT 200""", (e["id"],))
    data["attendees"] = [{**social.user_card(r), "status": r["status"]} for r in rows]
    return JSONResponse(data)


@auth()
async def update_event(request: Request):
    v = request.state.user["id"]
    e = _get(path_int(request), v)
    if e["creator_id"] != v:
        raise ApiError(403, "Изменять мероприятие может только организатор")
    data = await body(request)
    sets, params = [], []
    for field, n in (("title", 120), ("description", 3000), ("place", 200)):
        if field in data:
            sets.append(f"{field}=?"); params.append(censor(clean_text(data[field], n)))
    for field in ("starts_at", "ends_at"):
        if field in data:
            sets.append(f"{field}=?"); params.append(_parse_dt(data[field], field))
    if "visibility" in data and data["visibility"] in ("public", "friends", "invited"):
        sets.append("visibility=?"); params.append(data["visibility"])
    if sets:
        db.run(f"UPDATE events SET {', '.join(sets)} WHERE id=?", (*params, e["id"]))
    return JSONResponse(_view([db.one("SELECT * FROM events WHERE id=?", (e["id"],))], v)[0])


@auth()
async def delete_event(request: Request):
    v = request.state.user["id"]
    e = _get(path_int(request), v)
    if e["creator_id"] != v:
        raise ApiError(403, "Удалить мероприятие может только организатор")
    media.delete_files(e["cover"])
    db.run("DELETE FROM events WHERE id=?", (e["id"],))
    return ok()


@auth()
async def rsvp(request: Request):
    v = request.state.user["id"]
    e = _get(path_int(request), v)
    status = (await body(request)).get("status")
    if status not in STATUSES:
        raise ApiError(400, "Неизвестный ответ")
    db.run("""INSERT INTO event_members (event_id, user_id, status) VALUES (?,?,?)
              ON CONFLICT(event_id, user_id) DO UPDATE SET status=excluded.status, updated_at=excluded.updated_at""",
           (e["id"], v, status))
    if status == "going" and e["creator_id"] != v:
        social.notify(e["creator_id"], v, "event_going", extra={"event_id": e["id"], "title": e["title"]})
    social.push_counters(v)
    return JSONResponse(_view([e], v)[0])


@auth()
async def invite(request: Request):
    limit(request, "write")
    v = request.state.user["id"]
    e = _get(path_int(request), v)
    if e["visibility"] == "invited" and e["creator_id"] != v:
        raise ApiError(403, "Приглашать на закрытое мероприятие может только организатор")
    data = await body(request)
    friends = set(social.friend_ids(v))
    added = 0
    for uid in data.get("user_ids") or []:
        uid = int(uid)
        if uid not in friends:
            continue
        cur = db.run("INSERT OR IGNORE INTO event_members (event_id, user_id, status, invited_by) VALUES (?,?, 'invited', ?)",
                     (e["id"], uid, v))
        if cur.rowcount:
            added += 1
            social.notify(uid, v, "event_invite", extra={"event_id": e["id"], "title": e["title"]})
    return JSONResponse({"invited": added})


routes = [
    Route("/api/events", list_events, methods=["GET"]),
    Route("/api/events", create_event, methods=["POST"]),
    Route("/api/events/{id:int}", get_event, methods=["GET"]),
    Route("/api/events/{id:int}", update_event, methods=["PATCH"]),
    Route("/api/events/{id:int}", delete_event, methods=["DELETE"]),
    Route("/api/events/{id:int}/rsvp", rsvp, methods=["POST"]),
    Route("/api/events/{id:int}/invite", invite, methods=["POST"]),
]
