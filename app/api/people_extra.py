"""Круги друзей, «Гости» и поиск одноклассников и однокурсников."""
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from .. import db, social
from ..security import censor, clean_text
from ..social import is_friend_sql, not_blocked_sql
from .misc import _like
from ..web import ApiError, auth, body, limit, path_int

MAX_CIRCLES = 20


# ---------------------------------------------------------------- Круги
def _circle(cid: int, v: int) -> dict:
    row = db.one("SELECT * FROM circles WHERE id=? AND owner_id=?", (cid, v))
    if not row:
        raise ApiError(404, "Круг не найден")
    return row


def _circles_view(v: int) -> list[dict]:
    rows = db.all("SELECT * FROM circles WHERE owner_id=? ORDER BY id", (v,))
    out = []
    for r in rows:
        ids = [m["user_id"] for m in db.all("SELECT user_id FROM circle_members WHERE circle_id=?", (r["id"],))]
        members = sorted(social.cards_by_ids(ids).values(), key=lambda m: m["name"])
        out.append({"id": r["id"], "name": r["name"], "members": members})
    return out


def ensure_default_circle(v: int) -> None:
    db.run("INSERT OR IGNORE INTO circles (owner_id, name) VALUES (?, 'Близкие друзья')", (v,))


@auth()
async def list_circles(request: Request):
    v = request.state.user["id"]
    ensure_default_circle(v)
    return JSONResponse({"items": _circles_view(v)})


@auth()
async def create_circle(request: Request):
    limit(request, "write")
    v = request.state.user["id"]
    name = censor(clean_text((await body(request)).get("name"), 40))
    if not name:
        raise ApiError(422, "Введите название круга")
    if db.value("SELECT count(*) FROM circles WHERE owner_id=?", (v,)) >= MAX_CIRCLES:
        raise ApiError(400, f"Можно создать не больше {MAX_CIRCLES} кругов")
    if db.value("SELECT 1 FROM circles WHERE owner_id=? AND name=?", (v, name)):
        raise ApiError(422, "Круг с таким названием уже есть")
    db.run("INSERT INTO circles (owner_id, name) VALUES (?,?)", (v, name))
    return JSONResponse({"items": _circles_view(v)}, status_code=201)


@auth()
async def update_circle(request: Request):
    v = request.state.user["id"]
    c = _circle(path_int(request), v)
    data = await body(request)
    if "name" in data:
        name = censor(clean_text(data["name"], 40))
        if not name:
            raise ApiError(422, "Введите название круга")
        db.run("UPDATE circles SET name=? WHERE id=?", (name, c["id"]))
    if "user_ids" in data:
        friends = set(social.friend_ids(v))
        ids = [int(i) for i in data["user_ids"] if int(i) in friends]
        with db.tx() as tx:
            tx.execute("DELETE FROM circle_members WHERE circle_id=?", (c["id"],))
            for uid in dict.fromkeys(ids):
                tx.execute("INSERT INTO circle_members (circle_id, user_id) VALUES (?,?)", (c["id"], uid))
    return JSONResponse({"items": _circles_view(v)})


@auth()
async def delete_circle(request: Request):
    v = request.state.user["id"]
    c = _circle(path_int(request), v)
    # записи этого круга становятся видны только автору, чтобы не расширить аудиторию без спроса
    db.run("UPDATE posts SET visibility='only_me' WHERE circle_id=?", (c["id"],))
    db.run("DELETE FROM circles WHERE id=?", (c["id"],))
    return JSONResponse({"items": _circles_view(v)})


# ---------------------------------------------------------------- Гости
def record_visit(visited: int, visitor: int) -> None:
    if visited == visitor:
        return
    if db.value("SELECT invisible FROM profiles WHERE user_id=?", (visitor,)):
        return  # режим «невидимки»
    db.run("""INSERT INTO profile_visits (visited_id, visitor_id, visited_at) VALUES (?,?,?)
              ON CONFLICT(visited_id, visitor_id) DO UPDATE SET visited_at=excluded.visited_at""",
           (visited, visitor, db.now()))
    social.push_counters(visited)


@auth()
async def guests(request: Request):
    v = request.state.user["id"]
    seen_before = db.value("SELECT guests_seen_at FROM profiles WHERE user_id=?", (v,)) or ""
    rows = db.all(f"""SELECT p.user_id AS id, p.username, p.name, p.avatar, p.city, pv.visited_at FROM profile_visits pv
                      JOIN profiles p ON p.user_id = pv.visitor_id
                      WHERE pv.visited_id = :v AND pv.visited_at >= :since AND {not_blocked_sql('pv.visitor_id')}
                      ORDER BY pv.visited_at DESC LIMIT 200""", {"v": v, "since": db.future(days=-30)})
    db.run("UPDATE profiles SET guests_seen_at=? WHERE user_id=?", (db.now(), v))
    social.push_counters(v)
    friends = set(social.friend_ids(v))
    items = [{**social.user_card(r), "city": r["city"], "visited_at": r["visited_at"],
              "is_new": r["visited_at"] > seen_before, "is_friend": r["id"] in friends} for r in rows]
    return JSONResponse({"items": items, "invisible": bool(db.value("SELECT invisible FROM profiles WHERE user_id=?", (v,)))})


# ---------------------------------------------------------------- Одноклассники
@auth()
async def classmates(request: Request):
    v = request.state.user["id"]
    qp = request.query_params
    school = (qp.get("school") or "").strip().lower()[:120]
    university = (qp.get("university") or "").strip().lower()[:120]
    city = (qp.get("city") or "").strip().lower()[:80]
    year = qp.get("year")
    if not (school or university):
        # подставляем данные из своего профиля
        me = db.one("SELECT school, school_year, university, university_year FROM profiles WHERE user_id=?", (v,))
        school, university = me["school"].lower(), me["university"].lower()
        year = year or me["school_year"] or me["university_year"]
        if not (school or university):
            return JSONResponse({"items": [], "need_profile": True})
    conds, params = [], {"v": v}
    if school:
        conds.append("ulower(p.school) LIKE :school ESCAPE '\\'")
        params["school"] = _like(school)
    if university:
        conds.append("ulower(p.university) LIKE :uni ESCAPE '\\'")
        params["uni"] = _like(university)
    where = "(" + " OR ".join(conds) + ")"
    if year:
        try:
            params["year"] = int(year)
        except ValueError:
            raise ApiError(400, "Некорректный год")
        where += " AND (p.school_year = :year OR p.university_year = :year)"
    if city:
        where += " AND ulower(p.city) LIKE :city ESCAPE '\\'"
        params["city"] = _like(city)
    rows = db.all(f"""SELECT p.user_id AS id, p.username, p.name, p.avatar, p.city, p.school, p.school_year,
                             p.university, p.university_year FROM profiles p
                      WHERE p.user_id != :v AND {where} AND {not_blocked_sql('p.user_id')}
                        AND (p.profile_visibility = 'public' OR {is_friend_sql('p.user_id')})
                      ORDER BY p.name LIMIT 100""", params)
    friends = set(social.friend_ids(v))
    items = []
    for r in rows:
        sub = []
        if r["school"]:
            sub.append(f"{r['school']}{', ' + str(r['school_year']) if r['school_year'] else ''}")
        if r["university"]:
            sub.append(f"{r['university']}{', ' + str(r['university_year']) if r['university_year'] else ''}")
        items.append({**social.user_card(r), "city": " · ".join(sub) or r["city"], "is_friend": r["id"] in friends,
                      "is_me": False})
    return JSONResponse({"items": items})


routes = [
    Route("/api/circles", list_circles, methods=["GET"]),
    Route("/api/circles", create_circle, methods=["POST"]),
    Route("/api/circles/{id:int}", update_circle, methods=["PATCH"]),
    Route("/api/circles/{id:int}", delete_circle, methods=["DELETE"]),
    Route("/api/guests", guests, methods=["GET"]),
    Route("/api/classmates", classmates, methods=["GET"]),
]
