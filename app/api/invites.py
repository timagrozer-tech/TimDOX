"""Приглашения: ссылка и коды, статистика переходов и конверсии, история, рейтинг, социальное дерево."""
from starlette.requests import Request
from starlette.responses import JSONResponse, RedirectResponse, Response
from starlette.routing import Route

from .. import db, qr, referrals, social
from ..security import clean_text
from ..web import ApiError, auth, body, client_ip, limit, ok

REF_COOKIE = "krug_ref"
STATUS_TEXT = {"pending": "ждём активности", "qualified": "засчитано", "rejected": "не засчитано"}
REJECT_TEXT = {"inactive": "не стал активным за 30 дней", "banned": "аккаунт заблокирован",
               "same_network": "слишком много приглашений из одной сети"}


async def follow_link(request: Request):
    """Переход по ссылке-приглашению: учитываем визит и запоминаем код на 30 дней."""
    code = request.path_params["code"].lower()[:16]
    if not referrals.record_click(code, client_ip(request), request.headers.get("user-agent", ""),
                                  request.query_params.get("utm_source") or request.query_params.get("s")):
        return RedirectResponse("/register", status_code=302)
    resp = RedirectResponse(f"/register?ref={code}", status_code=302)
    resp.set_cookie(REF_COOKIE, code, max_age=30 * 86400, httponly=True, samesite="lax", path="/")
    return resp


async def code_info(request: Request):
    """Карточка пригласившего — для страницы регистрации (публично)."""
    o = referrals.code_owner(request.path_params["code"])
    if not o:
        raise ApiError(404, "Приглашение не найдено")
    card = social.cards_by_ids([o["user_id"]]).get(o["user_id"])
    friends = db.value("SELECT count(*) FROM referrals WHERE inviter_id=? AND status='qualified'", (o["user_id"],)) or 0
    return JSONResponse({"code": o["code"], "inviter": card, "invited": friends})


def _code_stats(codes: list[str]) -> dict[str, dict]:
    if not codes:
        return {}
    ph = db.placeholders(codes)
    clicks = {r["code"]: r["n"] for r in db.all(f"SELECT code, count(*) AS n FROM invite_clicks WHERE code IN ({ph}) GROUP BY code", tuple(codes))}
    regs = {(r["code"], r["status"]): r["n"] for r in db.all(
        f"SELECT code, status, count(*) AS n FROM referrals WHERE code IN ({ph}) GROUP BY code, status", tuple(codes))}
    out = {}
    for c in codes:
        signups = sum(n for (cc, _), n in regs.items() if cc == c)
        out[c] = {"clicks": clicks.get(c, 0), "signups": signups, "qualified": regs.get((c, "qualified"), 0)}
    return out


@auth()
async def me(request: Request):
    v = request.state.user["id"]
    main = referrals.main_code(v)
    rows = db.all("SELECT code, label, created_at FROM invite_codes WHERE user_id=? AND disabled_at IS NULL ORDER BY created_at", (v,))
    stats = _code_stats([r["code"] for r in rows])
    codes = [{"code": r["code"], "label": r["label"], "link": referrals.link(r["code"]), "main": r["code"] == main,
              **stats.get(r["code"], {})} for r in rows]
    by = {r["status"]: r["n"] for r in db.all("SELECT status, count(*) AS n FROM referrals WHERE inviter_id=? GROUP BY status", (v,))}
    clicks = db.value("""SELECT count(*) FROM invite_clicks k JOIN invite_codes c ON c.code = k.code WHERE c.user_id=?""", (v,)) or 0
    signups = sum(by.values())
    prog = referrals.progress(v)
    rank = None
    if prog["qualified"]:
        rank = 1 + (db.value("""SELECT count(*) FROM (SELECT inviter_id FROM referrals WHERE status='qualified'
                                GROUP BY inviter_id HAVING count(*) > ?) t""", (prog["qualified"],)) or 0)
    week = db.all("""SELECT substr(created_at, 1, 10) AS day, count(*) AS n FROM referrals
                     WHERE inviter_id=? AND created_at >= ? GROUP BY substr(created_at, 1, 10)""", (v, db.future(days=-30)))
    return JSONResponse({
        "link": referrals.link(main), "code": main, "codes": codes,
        "totals": {"clicks": clicks, "signups": signups, "qualified": by.get("qualified", 0), "pending": by.get("pending", 0),
                   "rejected": by.get("rejected", 0), "conversion": round(100 * signups / clicks, 1) if clicks else None},
        "progress": prog, "rank": rank, "daily": {r["day"]: r["n"] for r in week},
        "tiers": [{"tier": t, "need": n, "name": referrals.TIER_NAMES[t]} for n, t in reversed(referrals.TIERS)],
        "rules": {"active_days": referrals.ACTIVE_DAYS_NEEDED, "pending_days": referrals.PENDING_DAYS},
    })


@auth()
async def add_code(request: Request):
    limit(request, "write")
    v = request.state.user["id"]
    data = await body(request)
    label = clean_text(data.get("label"), 40)
    if not label:
        raise ApiError(400, "Назовите ссылку — например, «для Telegram»")
    if (db.value("SELECT count(*) FROM invite_codes WHERE user_id=? AND disabled_at IS NULL", (v,)) or 0) >= referrals.MAX_CODES:
        raise ApiError(400, f"Не больше {referrals.MAX_CODES} ссылок — отключите ненужную")
    referrals.main_code(v)
    code = referrals.new_code()
    db.run("INSERT INTO invite_codes (code, user_id, label) VALUES (?,?,?)", (code, v, label))
    return JSONResponse({"code": code, "label": label, "link": referrals.link(code), "clicks": 0, "signups": 0, "qualified": 0}, status_code=201)


@auth()
async def remove_code(request: Request):
    v = request.state.user["id"]
    code = request.path_params["code"]
    row = db.one("SELECT label FROM invite_codes WHERE code=? AND user_id=? AND disabled_at IS NULL", (code, v))
    if not row:
        raise ApiError(404, "Ссылка не найдена")
    if row["label"] is None:
        raise ApiError(400, "Основную ссылку отключить нельзя")
    db.run("UPDATE invite_codes SET disabled_at=? WHERE code=?", (db.now(), code))
    return ok()


@auth()
async def code_qr(request: Request):
    v = request.state.user["id"]
    code = request.query_params.get("code") or referrals.main_code(v)
    if not db.value("SELECT 1 FROM invite_codes WHERE code=? AND user_id=?", (code, v)):
        raise ApiError(404, "Ссылка не найдена")
    return Response(qr.svg(referrals.link(code), scale=8), media_type="image/svg+xml",
                    headers={"Cache-Control": "private, max-age=86400"})


@auth()
async def history(request: Request):
    v = request.state.user["id"]
    before = request.query_params.get("before") or "9999"
    rows = db.all("""SELECT r.invitee_id, r.status, r.reject_reason, r.created_at, r.qualified_at, r.code, p.avatar,
                            (SELECT count(*) FROM user_active_days d WHERE d.user_id = r.invitee_id) AS days
                     FROM referrals r JOIN profiles p ON p.user_id = r.invitee_id
                     WHERE r.inviter_id=? AND r.created_at < ? ORDER BY r.created_at DESC LIMIT 30""", (v, before))
    cards = social.cards_by_ids([r["invitee_id"] for r in rows])
    items = []
    for r in rows:
        if r["invitee_id"] not in cards:
            continue
        steps = None
        if r["status"] == "pending":
            steps = {"avatar": bool(r["avatar"]), "days": min(r["days"], referrals.ACTIVE_DAYS_NEEDED), "days_need": referrals.ACTIVE_DAYS_NEEDED}
        items.append({"user": cards[r["invitee_id"]], "status": r["status"], "status_text": STATUS_TEXT[r["status"]],
                      "reason": REJECT_TEXT.get(r["reject_reason"] or ""), "created_at": r["created_at"],
                      "qualified_at": r["qualified_at"], "steps": steps})
    return JSONResponse({"items": items, "more": len(rows) == 30, "before": rows[-1]["created_at"] if rows else None})


@auth()
async def leaderboard(request: Request):
    v = request.state.user["id"]
    period = request.query_params.get("period", "month")
    since = {"week": db.future(days=-7), "month": db.future(days=-30)}.get(period, "")
    rows = db.all("""SELECT r.inviter_id AS uid, count(*) AS n, max(r.qualified_at) AS last FROM referrals r
                     JOIN users u ON u.id = r.inviter_id
                     WHERE r.status='qualified' AND r.qualified_at >= ? AND u.is_banned = 0
                     GROUP BY r.inviter_id ORDER BY count(*) DESC, max(r.qualified_at) ASC LIMIT 50""", (since,))
    cards = social.cards_by_ids([r["uid"] for r in rows])
    items = [{"rank": i + 1, "user": cards[r["uid"]], "count": r["n"], "me": r["uid"] == v} for i, r in enumerate(rows) if r["uid"] in cards]
    mine = next((it for it in items if it["me"]), None)
    if not mine:
        n = db.value("SELECT count(*) FROM referrals WHERE inviter_id=? AND status='qualified' AND qualified_at >= ?", (v, since)) or 0
        mine = {"rank": None, "count": n}
    return JSONResponse({"period": period, "items": items, "me": mine})


@auth()
async def tree(request: Request):
    """Граф приглашений. scope=me — моё дерево (предки и потомки до 3 уровней), scope=all — всё сообщество."""
    v = request.state.user["id"]
    scope = request.query_params.get("scope", "me")
    LIMIT = 800
    nodes: dict[int, dict] = {}
    edges: list[tuple[int, int]] = []
    if scope == "all":
        rows = db.all("SELECT inviter_id, invitee_id FROM referrals WHERE status != 'rejected' ORDER BY created_at LIMIT ?", (LIMIT * 2,))
        for r in rows:
            if len(nodes) >= LIMIT:
                break
            nodes.setdefault(r["inviter_id"], {})
            nodes.setdefault(r["invitee_id"], {})
            edges.append((r["inviter_id"], r["invitee_id"]))
        nodes.setdefault(v, {})
    else:
        root = v
        username = request.query_params.get("user")
        if username:
            root = db.value("SELECT user_id FROM profiles WHERE username=?", (username,)) or v
        nodes[root] = {"depth": 0}
        cur, depth = root, 0  # кто пригласил — цепочка вверх
        while depth > -3:
            up = db.value("SELECT inviter_id FROM referrals WHERE invitee_id=? AND status != 'rejected'", (cur,))
            if not up or up in nodes:
                break
            depth -= 1
            nodes[up] = {"depth": depth}
            edges.append((up, cur))
            cur = up
        frontier = [root]
        for level in range(1, 4):
            if not frontier or len(nodes) >= LIMIT:
                break
            rows = db.all(f"""SELECT inviter_id, invitee_id FROM referrals WHERE status != 'rejected'
                              AND inviter_id IN ({db.placeholders(frontier)}) LIMIT ?""", (*frontier, LIMIT))
            frontier = []
            for r in rows:
                if r["invitee_id"] in nodes or len(nodes) >= LIMIT:
                    continue
                nodes[r["invitee_id"]] = {"depth": level}
                edges.append((r["inviter_id"], r["invitee_id"]))
                frontier.append(r["invitee_id"])
    ids = list(nodes)
    cards = social.cards_by_ids(ids)
    counts = {r["inviter_id"]: r["n"] for r in db.all(
        f"SELECT inviter_id, count(*) AS n FROM referrals WHERE status='qualified' AND inviter_id IN ({db.placeholders(ids)}) GROUP BY inviter_id",
        tuple(ids))} if ids else {}
    joined = {r["user_id"]: r["created_at"] for r in db.all(
        f"SELECT u.id AS user_id, u.created_at FROM users u WHERE u.id IN ({db.placeholders(ids)})", tuple(ids))} if ids else {}
    out_nodes = [{**cards[i], "invited": counts.get(i, 0), "depth": nodes[i].get("depth"), "joined": joined.get(i), "me": i == v}
                 for i in ids if i in cards]
    alive = {n["id"] for n in out_nodes}
    return JSONResponse({"scope": scope, "nodes": out_nodes,
                         "edges": [{"from": a, "to": b} for a, b in edges if a in alive and b in alive],
                         "truncated": len(nodes) >= LIMIT})


routes = [
    Route("/i/{code}", follow_link, methods=["GET"]),
    Route("/api/invites/code/{code}", code_info, methods=["GET"]),
    Route("/api/invites/me", me, methods=["GET"]),
    Route("/api/invites/codes", add_code, methods=["POST"]),
    Route("/api/invites/codes/{code}", remove_code, methods=["DELETE"]),
    Route("/api/invites/qr", code_qr, methods=["GET"]),
    Route("/api/invites/history", history, methods=["GET"]),
    Route("/api/invites/leaderboard", leaderboard, methods=["GET"]),
    Route("/api/invites/tree", tree, methods=["GET"]),
]
