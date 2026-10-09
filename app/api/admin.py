"""Модерация для создателя сети: жалобы, блокировка людей, удаление нарушений, статистика."""
import json

from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from .. import db, media, social
from ..realtime import hub
from ..web import ApiError, auth, body, int_param, ok, path_int

TARGETS = ("post", "comment", "user", "reel", "reel_comment", "message", "story", "community")


def _admin(request: Request) -> dict:
    u = request.state.user
    if not u["is_admin"]:
        raise ApiError(403, "Раздел доступен только администрации")
    return u


def _target(ttype: str, tid: int) -> dict | None:
    """Что именно пожаловались: текст, автор, ссылка — чтобы решить, не открывая страницу."""
    if ttype == "post":
        r = db.one("SELECT id, author_id, text FROM posts WHERE id=?", (tid,))
        return r and {"author_id": r["author_id"], "text": r["text"], "link": f"/post/{tid}",
                      "photos": [m["thumb"] or m["path"] for m in db.all("SELECT path, thumb FROM post_media WHERE post_id=? ORDER BY position LIMIT 4", (tid,))]}
    if ttype == "comment":
        r = db.one("SELECT id, author_id, text, post_id FROM comments WHERE id=?", (tid,))
        return r and {"author_id": r["author_id"], "text": r["text"], "link": f"/post/{r['post_id']}?comments=1"}
    if ttype == "user":
        r = db.one("SELECT user_id, username, bio FROM profiles WHERE user_id=?", (tid,))
        return r and {"author_id": r["user_id"], "text": r["bio"] or "", "link": f"/u/{r['username']}"}
    if ttype == "reel":
        r = db.one("SELECT id, author_id, caption, poster FROM reels WHERE id=?", (tid,))
        return r and {"author_id": r["author_id"], "text": r["caption"], "link": f"/reels/{tid}", "photos": [r["poster"]] if r["poster"] else []}
    if ttype == "reel_comment":
        r = db.one("SELECT id, author_id, text, reel_id FROM reel_comments WHERE id=?", (tid,))
        return r and {"author_id": r["author_id"], "text": r["text"], "link": f"/reels/{r['reel_id']}"}
    if ttype == "message":
        r = db.one("SELECT id, sender_id, text, kind FROM messages WHERE id=?", (tid,))
        return r and {"author_id": r["sender_id"], "text": r["text"] if r["kind"] != "deleted" else "(удалено)", "link": None}
    if ttype == "story":
        r = db.one("SELECT id, author_id, text, media FROM stories WHERE id=?", (tid,))
        return r and {"author_id": r["author_id"], "text": r["text"], "link": None, "photos": [r["media"]] if r["media"] else []}
    if ttype == "community":
        r = db.one("SELECT id, created_by, name, description, slug FROM communities WHERE id=?", (tid,))
        return r and {"author_id": r["created_by"], "text": f"{r['name']}. {r['description'] or ''}", "link": f"/c/{r['slug']}"}
    return None


def _delete_target(ttype: str, tid: int) -> None:
    if ttype == "post":
        from .posts import delete_post_files
        delete_post_files([tid])
        db.run("DELETE FROM posts WHERE id=?", (tid,))
    elif ttype == "comment":
        db.run("DELETE FROM comments WHERE id=?", (tid,))
    elif ttype == "reel":
        r = db.one("SELECT video, poster FROM reels WHERE id=?", (tid,))
        if r:
            media.delete_files(r["video"], r["poster"])
        db.run("DELETE FROM reels WHERE id=?", (tid,))
    elif ttype == "reel_comment":
        db.run("DELETE FROM reel_comments WHERE id=?", (tid,))
    elif ttype == "message":
        m = db.one("SELECT * FROM messages WHERE id=?", (tid,))
        if m:
            db.run("UPDATE messages SET text='', media=NULL, kind='deleted', edited_at=? WHERE id=?", (db.now(), tid))
            from .messages import member_ids
            view = {"id": tid, "conversation_id": m["conversation_id"], "sender_id": m["sender_id"], "text": "", "kind": "deleted",
                    "created_at": m["created_at"], "edited_at": db.now(), "reply_to": m.get("reply_to")}
            for uid in member_ids(m["conversation_id"]):
                hub.publish(uid, "message_update", view)
    elif ttype == "story":
        r = db.one("SELECT media FROM stories WHERE id=?", (tid,))
        if r:
            media.delete_files(r["media"])
        db.run("DELETE FROM stories WHERE id=?", (tid,))
    elif ttype == "community":
        r = db.one("SELECT avatar, cover FROM communities WHERE id=?", (tid,))
        if r:
            media.delete_files(r["avatar"], r["cover"])
        db.run("DELETE FROM communities WHERE id=?", (tid,))


def set_ban(uid: int, banned: bool) -> None:
    db.run("UPDATE users SET is_banned=? WHERE id=?", (1 if banned else 0, uid))
    if banned:
        db.run("DELETE FROM sessions WHERE user_id=?", (uid,))  # выходит со всех устройств


@auth()
async def reports_list(request: Request):
    _admin(request)
    status = request.query_params.get("status", "open")
    if status not in ("open", "resolved", "dismissed"):
        raise ApiError(400, "Неизвестный статус")
    rows = db.all("""SELECT target_type, target_id, count(*) AS n, max(created_at) AS last_at, max(id) AS last_id
                     FROM reports WHERE status=? GROUP BY target_type, target_id ORDER BY count(*) DESC, max(id) DESC LIMIT 100""", (status,))
    items = []
    authors = set()
    for r in rows:
        t = _target(r["target_type"], r["target_id"])
        reasons = [x["reason"] for x in db.all(
            "SELECT reason FROM reports WHERE target_type=? AND target_id=? AND status=? ORDER BY id DESC LIMIT 10",
            (r["target_type"], r["target_id"], status))]
        items.append({"target_type": r["target_type"], "target_id": r["target_id"], "count": r["n"], "last_at": r["last_at"],
                      "reasons": reasons, "target": t, "exists": t is not None})
        if t and t.get("author_id"):
            authors.add(t["author_id"])
    cards = social.cards_by_ids(list(authors))
    banned = {r["id"] for r in db.all(f"SELECT id FROM users WHERE is_banned=1 AND id IN ({db.placeholders(list(authors))})", tuple(authors))} if authors else set()
    for it in items:
        aid = (it["target"] or {}).get("author_id")
        it["author"] = cards.get(aid)
        it["author_banned"] = aid in banned
    return JSONResponse({"items": items})


@auth()
async def resolve(request: Request):
    admin = _admin(request)
    data = await body(request)
    ttype, action = data.get("target_type"), data.get("action")
    if ttype not in TARGETS or action not in ("dismiss", "delete", "ban", "delete_ban"):
        raise ApiError(400, "Некорректное действие")
    tid = int(data.get("target_id"))
    t = _target(ttype, tid)
    from .. import modlog
    reasons = [r["reason"] for r in db.all("SELECT DISTINCT reason FROM reports WHERE target_type=? AND target_id=? AND status='open'", (ttype, tid))]
    modlog.log(admin["id"], f"report_{action}", ttype, tid, (t or {}).get("author_id") if ttype != "user" else tid,
               details={"reasons": reasons[:5], "text": modlog.snippet((t or {}).get("text"))})
    if action in ("ban", "delete_ban"):
        aid = (t or {}).get("author_id")
        if not aid:
            raise ApiError(404, "Автор не найден")
        if aid == admin["id"]:
            raise ApiError(400, "Себя заблокировать нельзя")
        set_ban(aid, True)
    if action in ("delete", "delete_ban") and t and ttype != "user":
        _delete_target(ttype, tid)
    db.run("UPDATE reports SET status=? WHERE target_type=? AND target_id=? AND status='open'",
           ("dismissed" if action == "dismiss" else "resolved", ttype, tid))
    social.push_counters(admin["id"])
    return ok()


@auth()
async def ban_user(request: Request):
    admin = _admin(request)
    uid = path_int(request)
    if uid == admin["id"]:
        raise ApiError(400, "Себя заблокировать нельзя")
    if not db.value("SELECT 1 FROM users WHERE id=?", (uid,)):
        raise ApiError(404, "Пользователь не найден")
    set_ban(uid, request.method == "POST")
    from .. import modlog
    modlog.log(admin["id"], "ban" if request.method == "POST" else "unban", "user", uid, uid)
    return ok()


@auth()
async def users_list(request: Request):
    """Поиск людей для администрации (включая заблокированных)."""
    _admin(request)
    q = (request.query_params.get("q") or "").strip().lower()[:60]
    only_banned = request.query_params.get("banned") == "1"
    from .misc import _like
    where, params = ["1=1"], []
    if q:
        where.append("(ulower(p.name) LIKE ? ESCAPE '\\' OR ulower(p.username) LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\')")
        params += [_like(q)] * 3
    if only_banned:
        where.append("u.is_banned=1")
    rows = db.all(f"""SELECT u.id, u.email, u.is_banned, u.is_admin, u.created_at, u.email_verified_at, p.username, p.name, p.avatar, p.equipped,
                             p.status_emoji, p.status_text, p.status_until,
                             (SELECT count(*) FROM posts x WHERE x.author_id=u.id) AS posts,
                             (SELECT count(*) FROM reports r WHERE r.target_type='user' AND r.target_id=u.id AND r.status='open') AS reports
                      FROM users u JOIN profiles p ON p.user_id=u.id WHERE {' AND '.join(where)}
                      ORDER BY u.id DESC LIMIT 60""", tuple(params))
    return JSONResponse({"items": [{**social.user_card(r), "email": r["email"], "banned": bool(r["is_banned"]), "admin": bool(r["is_admin"]),
                                    "joined_at": r["created_at"], "email_verified": bool(r["email_verified_at"]),
                                    "posts": r["posts"], "reports": r["reports"]} for r in rows]})


@auth()
async def modlog_list(request: Request):
    """Журнал действий администрации и модераторов — только для администраторов."""
    _admin(request)
    from .. import modlog
    q = request.query_params
    before = int(q["before"]) if q.get("before", "").isdigit() else None
    items, more = modlog.items(before)
    return JSONResponse({"items": items, "more": more})


@auth()
async def stats(request: Request):
    _admin(request)
    day, week = db.future(days=-1), db.future(days=-7)
    q = lambda sql, *p: db.value(sql, p) or 0  # noqa: E731
    return JSONResponse({
        "users": q("SELECT count(*) FROM users"),
        "users_day": q("SELECT count(*) FROM users WHERE created_at > ?", day),
        "users_week": q("SELECT count(*) FROM users WHERE created_at > ?", week),
        "active_day": q("SELECT count(*) FROM users WHERE last_seen_at > ?", day),
        "online": len(hub.online_ids()),
        "posts": q("SELECT count(*) FROM posts"),
        "posts_day": q("SELECT count(*) FROM posts WHERE created_at > ?", day),
        "messages_day": q("SELECT count(*) FROM messages WHERE created_at > ?", day),
        "reels": q("SELECT count(*) FROM reels"),
        "communities": q("SELECT count(*) FROM communities"),
        "reports_open": q("SELECT count(DISTINCT target_type || ':' || target_id) FROM reports WHERE status='open'"),
        "banned": q("SELECT count(*) FROM users WHERE is_banned=1"),
    })


@auth()
async def calls_settings(request: Request):
    """Ретрансляторы звонков: Cloudflare TURN (ключ и токен) и любой TURN с постоянным логином"""
    _admin(request)
    from starlette.concurrency import run_in_threadpool
    from .. import turn
    cfg = turn.load()
    if request.method == "PUT":
        data = await body(request)
        cf = data.get("cloudflare") or {}
        if cf.get("clear"):
            cfg.pop("cloudflare", None)
        elif cf.get("key_id") or cf.get("token"):
            old = cfg.get("cloudflare") or {}
            key = str(cf.get("key_id") or old.get("key_id") or "").strip()[:200]
            token = str(cf.get("token") or old.get("token") or "").strip()[:400]
            if not (key and token):
                raise ApiError(400, "Нужны и ID ключа TURN, и API-токен")
            cfg["cloudflare"] = {"key_id": key, "token": token}
        cu = data.get("custom")
        if isinstance(cu, dict):
            urls = [u.strip() for u in (cu.get("urls") or []) if isinstance(u, str) and u.strip()][:8]
            if any(not u.startswith(("turn:", "turns:", "stun:")) for u in urls):
                raise ApiError(400, "Адреса начинаются с turn:, turns: или stun:")
            old = cfg.get("custom") or {}
            cred = str(cu.get("credential") or "").strip() or old.get("credential", "")
            cfg["custom"] = {"urls": urls, "username": str(cu.get("username") or "").strip()[:200], "credential": cred[:400]} if urls else {}
        turn.save(cfg)
        from .. import modlog
        modlog.log(request.state.user["id"], "calls_settings", "settings")
    result = turn.public_view(cfg)
    if request.method == "PUT" or request.query_params.get("check"):
        from .. import turncheck
        servers = await run_in_threadpool(turn.servers, cfg)
        checks = await run_in_threadpool(turncheck.check_all, servers)
        result["checks"] = [{"url": u, "result": r} for u, r in checks]
        result["servers"] = len(servers)
        try:  # итог проверки — в журнал запросов (удалённая диагностика; адреса без логина и пароля)
            import os
            import sys
            wsgi = sys.modules.get("app.wsgi")  # есть только на хостинге; импортировать самим нельзя — там запуск
            for u, r in (checks if wsgi else []):
                wsgi._req_queue.append(("SYS", "/__turn-admin-check", 200 if r == "ok" else 500, 0, u[:120], r[:120], os.getpid()))
        except Exception:  # noqa: BLE001
            pass
    return JSONResponse(result)


routes = [
    Route("/api/admin/calls", calls_settings, methods=["GET", "PUT"]),
    Route("/api/admin/reports", reports_list, methods=["GET"]),
    Route("/api/admin/reports/resolve", resolve, methods=["POST"]),
    Route("/api/admin/users", users_list, methods=["GET"]),
    Route("/api/admin/users/{id:int}/ban", ban_user, methods=["POST", "DELETE"]),
    Route("/api/admin/stats", stats, methods=["GET"]),
    Route("/api/admin/modlog", modlog_list, methods=["GET"]),
]
