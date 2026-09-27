"""API Мира Круга: организации, репутация, задания, сюжеты, персонажи."""
import json

from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from .. import db, social
from ..web import ApiError, auth
from . import core, gen, llm, quests, texts


def _org_view(o: dict, uid: int) -> dict:
    pts = quests.rep(uid, o["id"])
    nxt = texts.next_title(pts)
    week = db.value("SELECT COALESCE(SUM(week_points),0) FROM ai_rep WHERE org_id=?", (o["id"],)) or 0
    comm = db.one("SELECT slug FROM communities WHERE id=?", (o["community_id"],)) if o["community_id"] else None
    joined = bool(o["community_id"] and db.value(
        "SELECT 1 FROM community_members WHERE community_id=? AND user_id=? AND status='member'", (o["community_id"], uid)))
    return {"slug": o["slug"], "name": o["name"], "motto": o["motto"], "color": o["color"], "emoji": o["emoji"],
            "influence": o["influence"], "week": week, "community": comm and comm["slug"], "joined": joined,
            "rep": pts, "title": texts.title_for(pts), "next": nxt and {"points": nxt[0], "title": nxt[1]}}


@auth()
async def world(request: Request):
    uid = request.state.user["id"]
    if not db.value("SELECT count(*) FROM ai_orgs"):
        return JSONResponse({"ready": False})
    orgs = [_org_view(o, uid) for o in db.all("SELECT * FROM ai_orgs ORDER BY id")]
    by_id = {o["id"]: o for o in db.all("SELECT id, slug, name, emoji, color FROM ai_orgs")}
    done = {r["quest_id"]: r["completed_at"] for r in db.all(
        "SELECT quest_id, completed_at FROM ai_quest_progress WHERE user_id=? AND status='done'", (uid,))}
    givers = social.cards_by_ids([q["persona_id"] for q in quests.active_quests() if q["persona_id"]])
    qs = []
    for q in quests.active_quests():
        if q["secret"] and not quests.unlocked(uid, q) and q["id"] not in done:
            continue
        have, need = (1, 1) if q["id"] in done else quests.progress(uid, q)
        o = by_id.get(q["org_id"]) or {}
        qs.append({"id": q["id"], "title": q["title"], "description": q["description"], "reward": q["reward"], "secret": bool(q["secret"]),
                   "ends_at": q["ends_at"], "done": q["id"] in done, "progress": have, "need": need,
                   "org": {"slug": o.get("slug"), "name": o.get("name"), "emoji": o.get("emoji"), "color": o.get("color")},
                   "giver": givers.get(q["persona_id"])})
    qs.sort(key=lambda x: (x["done"], not x["secret"], -x["reward"]))
    locked_secrets = sum(1 for q in quests.active_quests() if q["secret"] and not quests.unlocked(uid, q) and q["id"] not in done)
    arcs = []
    for a in db.all("SELECT * FROM ai_arcs ORDER BY id"):
        spec = texts.ARCS.get(a["code"])
        if not spec:
            continue
        arcs.append({"title": a["title"], "status": a["status"], "post_id": a["post_id"], "stage_text": spec["stages"][a["stage"]][0][:220],
                     "history": json.loads(a["history"] or "[]"), "org": (by_id.get(a["org_id"]) or {}).get("name"), "next_at": a["next_at"]})
    people = db.all("""SELECT a.user_id, a.role, o.slug AS org FROM ai_personas a LEFT JOIN ai_orgs o ON o.id=a.org_id ORDER BY a.org_id, a.user_id""")
    cards = social.cards_by_ids([p["user_id"] for p in people])
    rel = {r["followee_id"] for r in db.all("SELECT followee_id FROM follows WHERE follower_id=?", (uid,))}
    closeness = {r["persona_id"]: r["closeness"] for r in db.all("SELECT persona_id, closeness FROM ai_memory WHERE user_id=?", (uid,))}
    personas = [{**cards[p["user_id"]], "role": p["role"], "org": p["org"], "following": p["user_id"] in rel,
                 "closeness": closeness.get(p["user_id"], 0)} for p in people if p["user_id"] in cards]
    th, se = gen.theme(), gen.season()
    return JSONResponse({
        "ready": True,
        "theme": {"title": th[1], "tag": th[2], "org": th[3], "emoji": th[4]},
        "season": se and {"title": se[3], "tag": se[4], "emoji": se[5]},
        "orgs": orgs, "quests": qs, "locked_secrets": locked_secrets, "arcs": arcs, "personas": personas,
        "total_rep": sum(o["rep"] for o in orgs), "llm": llm.enabled(),
    })


@auth()
async def persona_info(request: Request):
    """Карточка персонажа для его профиля: организация, роль и ваши отношения."""
    uid = request.state.user["id"]
    p = db.one("""SELECT a.*, o.name AS org_name, o.emoji, o.color, o.slug AS org_slug FROM ai_personas a
                  LEFT JOIN ai_orgs o ON o.id=a.org_id JOIN profiles pr ON pr.user_id=a.user_id WHERE pr.username=?""",
               (request.path_params["username"],))
    if not p:
        raise ApiError(404, "Это не персонаж Мира Круга")
    mem = db.one("SELECT closeness, facts FROM ai_memory WHERE user_id=? AND persona_id=?", (uid, p["user_id"])) or {}
    pts = quests.rep(uid, p["org_id"]) if p["org_id"] else 0
    return JSONResponse({"role": p["role"], "specialty": p["specialty"], "org": {"slug": p["org_slug"], "name": p["org_name"],
                         "emoji": p["emoji"], "color": p["color"]}, "rep": pts, "title": texts.title_for(pts),
                         "closeness": mem.get("closeness", 0), "facts": json.loads(mem.get("facts") or "[]")[-5:]})


routes = [
    Route("/api/world", world, methods=["GET"]),
    Route("/api/world/persona/{username}", persona_info, methods=["GET"]),
]
