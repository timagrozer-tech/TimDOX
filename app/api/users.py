"""Профили, друзья, подписки, блокировки, настройки, экспорт и удаление аккаунта."""
import json
import re

from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.routing import Route

from .. import collection, config, constellation, db, email_codes, mailer, media, social
from ..realtime import hub
from ..security import censor, clean_text, verify_password
from ..social import FRIEND_IDS_SQL
from ..web import ApiError, auth, body, limit, ok, path_int
from .posts import delete_post_files


def _profile(username: str) -> dict:
    row = db.one("SELECT p.*, u.created_at AS joined_at FROM profiles p JOIN users u ON u.id=p.user_id WHERE p.username=?",
                 (username,))
    if not row:
        raise ApiError(404, "Пользователь не найден")
    return row


def _target(request: Request) -> int:
    uid = path_int(request)
    if not db.value("SELECT 1 FROM users WHERE id=?", (uid,)):
        raise ApiError(404, "Пользователь не найден")
    if uid == request.state.user["id"]:
        raise ApiError(400, "Нельзя выполнить действие с самим собой")
    return uid


def _can_see_friends(v: int, prof: dict) -> bool:
    uid = prof["user_id"]
    if uid == v:
        return True
    if social.blocked_between(v, uid):
        return False
    vis = prof["friends_visibility"]
    return vis == "public" or (vis == "friends" and social.are_friends(v, uid))


@auth()
async def profile(request: Request):
    v = request.state.user["id"]
    p = _profile(request.path_params["username"])
    uid = p["user_id"]
    rel = social.relation(v, uid)
    card = social.user_card(p)
    if rel["blocked_me"]:
        return JSONResponse({"user": card, "relation": rel, "hidden": True, "blocked": True})
    full = uid == v or rel["status"] == "friends" or p["profile_visibility"] == "public"
    my_friends = set(social.friend_ids(v))
    their_friends = set(social.friend_ids(uid))
    data = {
        "user": card,
        "cover": p["cover"],
        "relation": rel,
        "hidden": not full,
        "joined_at": p["joined_at"],
        "counts": {
            "friends": len(their_friends),
            "followers": db.value("SELECT count(*) FROM follows WHERE followee_id=?", (uid,)),
            "following": db.value("SELECT count(*) FROM follows WHERE follower_id=?", (uid,)),
            "posts": db.value("SELECT count(*) FROM posts WHERE author_id=?", (uid,)) if full else None,
            "invited": p.get("invites_qualified") or 0,
        },
        "mutual_friends": len(my_friends & their_friends) if uid != v else 0,
        "can_message": uid != v and not rel["blocked_by_me"] and (
            p["message_privacy"] == "all" or rel["status"] == "friends"),
        "friends_visible": _can_see_friends(v, p),
        "equipped": collection.parse_equipped(p.get("equipped")),
        "can_verify": bool(request.state.user["is_admin"]),
    }
    data["space"] = constellation.load_space(p.get("space"))
    from .. import shop
    data["title"] = shop.title_of(p.get("shop_title"))
    data["title_style"] = shop.title_style(p.get("shop_title"))
    data["gifts"] = shop.gifts_of(uid, 12)
    if full:
        from .collection_routes import showcase
        data["showcase"] = showcase(uid)
        data["constellation"] = constellation.public(uid, p.get("constellation"))
    if uid != v and not rel["blocked_by_me"]:
        from .people_extra import record_visit
        record_visit(uid, v)
    if full:
        data.update({
            "bio": p["bio"], "city": p["city"], "education": p["education"], "work": p["work"],
            "relationship": p["relationship"],
            "school": p["school"], "school_year": p["school_year"],
            "university": p["university"], "university_year": p["university_year"],
            "birth_date": p["birth_date"] if (p["show_birth_date"] or uid == v) else None,
        })
    return JSONResponse(data)


def _people(rows: list[dict], v: int) -> list[dict]:
    my_friends = set(social.friend_ids(v))
    ids = [r["id"] for r in rows]
    closed = {x["user_id"] for x in db.all(
        f"SELECT user_id FROM profiles WHERE profile_visibility <> 'public' AND user_id IN ({db.placeholders(ids)})", tuple(ids))} if ids else set()
    out = []
    for r in rows:
        c = social.user_card(r)
        hide = r["id"] in closed and r["id"] not in my_friends and r["id"] != v
        c["city"] = "" if hide else r.get("city", "")
        c["is_friend"] = r["id"] in my_friends
        c["is_me"] = r["id"] == v
        out.append(c)
    return out


@auth()
async def user_friends(request: Request):
    v = request.state.user["id"]
    p = _profile(request.path_params["username"])
    if not _can_see_friends(v, p):
        return JSONResponse({"items": [], "hidden": True})
    rows = db.all(f"""SELECT p.user_id AS id, p.username, p.name, p.avatar, p.city FROM profiles p
                      WHERE p.user_id IN ({FRIEND_IDS_SQL}) ORDER BY p.name COLLATE NOCASE""", {"v": p["user_id"]})
    items = _people(rows, v)
    items.sort(key=lambda x: not x["online"])
    return JSONResponse({"items": items})


@auth()
async def user_follows(request: Request):
    v = request.state.user["id"]
    p = _profile(request.path_params["username"])
    kind = request.query_params.get("type", "followers")
    if not _can_see_friends(v, p):
        return JSONResponse({"items": [], "hidden": True})
    if kind == "following":
        sql = "SELECT pr.user_id AS id, pr.username, pr.name, pr.avatar, pr.city FROM follows f JOIN profiles pr ON pr.user_id=f.followee_id WHERE f.follower_id=? ORDER BY f.created_at DESC LIMIT 500"
    else:
        sql = "SELECT pr.user_id AS id, pr.username, pr.name, pr.avatar, pr.city FROM follows f JOIN profiles pr ON pr.user_id=f.follower_id WHERE f.followee_id=? ORDER BY f.created_at DESC LIMIT 500"
    return JSONResponse({"items": _people(db.all(sql, (p["user_id"],)), v)})


# ----------------------------------------------------------------------------
# Дружба и подписки
# ----------------------------------------------------------------------------
def _relation_response(v: int, uid: int):
    return JSONResponse({"relation": social.relation(v, uid)})


@auth()
async def friend_request(request: Request):
    limit(request, "write")
    v = request.state.user["id"]
    uid = _target(request)
    if social.blocked_between(v, uid):
        raise ApiError(403, "Действие недоступно")
    if db.value("SELECT badge FROM profiles WHERE user_id=?", (uid,)) == "Официальный":
        raise ApiError(400, "Это официальный профиль — на него можно подписаться")
    fr = db.one("SELECT * FROM friendships WHERE user_low=least(?,?) AND user_high=greatest(?,?)", (v, uid, v, uid))
    if fr and fr["status"] == "pending" and fr["addressee_id"] == v:
        return await _accept(v, uid)
    if not fr:
        db.run("INSERT INTO friendships (requester_id, addressee_id, status) VALUES (?,?, 'pending')", (v, uid))
        db.run("INSERT OR IGNORE INTO follows (follower_id, followee_id) VALUES (?,?)", (v, uid))
        social.notify(uid, v, "friend_request")
        social.push_counters(uid)
    return _relation_response(v, uid)


async def _accept(v: int, uid: int):
    cur = db.run("""UPDATE friendships SET status='accepted', accepted_at=? WHERE requester_id=? AND addressee_id=?
                    AND status='pending'""", (db.now(), uid, v))
    if cur.rowcount:
        db.run("INSERT OR IGNORE INTO follows (follower_id, followee_id) VALUES (?,?)", (v, uid))
        db.run("INSERT OR IGNORE INTO follows (follower_id, followee_id) VALUES (?,?)", (uid, v))
        db.run("DELETE FROM notifications WHERE user_id=? AND actor_id=? AND type='friend_request'", (v, uid))
        social.notify(uid, v, "friend_accept")
        social.push_counters(v)
    return _relation_response(v, uid)


@auth()
async def friend_accept(request: Request):
    v = request.state.user["id"]
    return await _accept(v, _target(request))


@auth()
async def friend_remove(request: Request):
    """Отменить заявку, отклонить входящую или удалить из друзей."""
    v = request.state.user["id"]
    uid = _target(request)
    fr = db.one("SELECT * FROM friendships WHERE user_low=least(?,?) AND user_high=greatest(?,?)", (v, uid, v, uid))
    if fr:
        db.run("DELETE FROM friendships WHERE id=?", (fr["id"],))
        if fr["status"] == "accepted" or fr["requester_id"] == v:
            db.run("DELETE FROM follows WHERE follower_id=? AND followee_id=?", (v, uid))
        if fr["requester_id"] == v and fr["status"] == "pending":
            db.run("DELETE FROM notifications WHERE user_id=? AND actor_id=? AND type='friend_request'", (uid, v))
            social.push_counters(uid)
        social.push_counters(v)
    return _relation_response(v, uid)


@auth()
async def follow(request: Request):
    limit(request, "write")
    v = request.state.user["id"]
    uid = _target(request)
    if request.method == "POST":
        if social.blocked_between(v, uid):
            raise ApiError(403, "Действие недоступно")
        cur = db.run("INSERT OR IGNORE INTO follows (follower_id, followee_id) VALUES (?,?)", (v, uid))
        if cur.rowcount:
            social.notify(uid, v, "follow")
    else:
        db.run("DELETE FROM follows WHERE follower_id=? AND followee_id=?", (v, uid))
        social.unnotify(uid, v, "follow")
    return _relation_response(v, uid)


@auth()
async def block(request: Request):
    v = request.state.user["id"]
    uid = _target(request)
    if request.method == "POST":
        with db.tx() as c:
            c.execute("INSERT OR IGNORE INTO blocks (blocker_id, blocked_id) VALUES (?,?)", (v, uid))
            c.execute("DELETE FROM friendships WHERE user_low=least(?,?) AND user_high=greatest(?,?)", (v, uid, v, uid))
            c.execute("DELETE FROM follows WHERE (follower_id=? AND followee_id=?) OR (follower_id=? AND followee_id=?)",
                      (v, uid, uid, v))
    else:
        db.run("DELETE FROM blocks WHERE blocker_id=? AND blocked_id=?", (v, uid))
    return _relation_response(v, uid)


@auth()
async def requests_list(request: Request):
    v = request.state.user["id"]
    incoming = db.all("""SELECT p.user_id AS id, p.username, p.name, p.avatar, p.city FROM friendships f
                         JOIN profiles p ON p.user_id=f.requester_id WHERE f.addressee_id=? AND f.status='pending'
                         ORDER BY f.id DESC""", (v,))
    outgoing = db.all("""SELECT p.user_id AS id, p.username, p.name, p.avatar, p.city FROM friendships f
                         JOIN profiles p ON p.user_id=f.addressee_id WHERE f.requester_id=? AND f.status='pending'
                         ORDER BY f.id DESC""", (v,))
    blocked = db.all("""SELECT p.user_id AS id, p.username, p.name, p.avatar, p.city FROM blocks b
                        JOIN profiles p ON p.user_id=b.blocked_id WHERE b.blocker_id=?""", (v,))
    return JSONResponse({"incoming": _people(incoming, v), "outgoing": _people(outgoing, v), "blocked": _people(blocked, v)})


@auth()
async def suggestions(request: Request):
    """«Возможно, вы знакомы»: друзья друзей, затем люди из того же города, затем новички."""
    v = request.state.user["id"]
    me = db.one("SELECT city, school, school_year, university FROM profiles WHERE user_id=?", (v,))
    my_city = me["city"] or ""
    rows = db.all(f"""
        WITH mine AS ({FRIEND_IDS_SQL}),
        fof AS (
            SELECT CASE WHEN f.requester_id IN (SELECT * FROM mine) THEN f.addressee_id ELSE f.requester_id END AS uid,
                   count(*) AS mutual
            FROM friendships f
            WHERE f.status='accepted' AND (f.requester_id IN (SELECT * FROM mine) OR f.addressee_id IN (SELECT * FROM mine))
            GROUP BY uid)
        SELECT p.user_id AS id, p.username, p.name, p.avatar, p.city, coalesce(fof.mutual, 0) AS mutual
        FROM profiles p LEFT JOIN fof ON fof.uid = p.user_id
        WHERE p.user_id != :v
          AND p.user_id NOT IN (SELECT * FROM mine)
          AND NOT EXISTS (SELECT 1 FROM friendships f2 WHERE f2.user_low=least(:v,p.user_id) AND f2.user_high=greatest(:v,p.user_id))
          AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id=:v AND b.blocked_id=p.user_id) OR (b.blocker_id=p.user_id AND b.blocked_id=:v))
          AND coalesce(p.badge, '') <> 'Официальный'
        ORDER BY mutual DESC,
                 (p.school != '' AND p.school = :school AND p.school_year IS :syear) DESC,
                 (p.university != '' AND p.university = :uni) DESC,
                 (p.city != '' AND p.city = :city) DESC, p.user_id DESC
        LIMIT 12""", {"v": v, "city": my_city, "school": me["school"], "syear": me["school_year"], "uni": me["university"]})
    items = _people(rows, v)
    for item, r in zip(items, rows):
        item["mutual"] = r["mutual"]
    return JSONResponse({"items": items, "featured": featured_accounts(v)})


def featured_accounts(v: int, limit_n: int = 6) -> list[dict]:
    """«Рекомендуем»: официальные аккаунты, на которые человек ещё не подписан. Создатель — первым."""
    vmap = social.verified_map()
    ids = [i for i in vmap if i != v]
    if not ids:
        return []
    marks = ",".join("?" * len(ids))
    followed = {r["followee_id"] for r in db.all(
        f"SELECT followee_id FROM follows WHERE follower_id=? AND followee_id IN ({marks})", (v, *ids))}
    friends = set(social.friend_ids(v))
    ids = [i for i in ids if i not in followed and i not in friends and not social.blocked_between(v, i)]
    if not ids:
        return []
    marks = ",".join("?" * len(ids))
    rows = db.all(f"""SELECT p.user_id AS id, p.username, p.name, p.avatar, p.city, p.equipped,
                             (SELECT count(*) FROM follows f WHERE f.followee_id=p.user_id) AS followers
                      FROM profiles p WHERE p.user_id IN ({marks})""", tuple(ids))
    rows.sort(key=lambda r: (not (vmap.get(r["id"]) or "").lower().startswith("создатель"), -r["followers"]))
    out = _people(rows[:limit_n], v)
    for item, r in zip(out, rows):
        item["followers"] = r["followers"]
    return out


@auth()
async def featured(request: Request):
    return JSONResponse({"items": featured_accounts(request.state.user["id"], 12)})


@auth()
async def admin_verify(request: Request):
    """Выдать или снять галочку «Официальный аккаунт». Только для администратора (создателя сети)."""
    if not request.state.user["is_admin"]:
        raise ApiError(403, "Выдавать галочки может только создатель сети")
    uid = path_int(request)
    if not db.value("SELECT 1 FROM users WHERE id=?", (uid,)):
        raise ApiError(404, "Пользователь не найден")
    if request.method == "DELETE":
        db.run("UPDATE profiles SET verified=0, badge=NULL WHERE user_id=?", (uid,))
    else:
        data = await body(request)
        badge = clean_text(str(data.get("badge") or ""), 40).strip() or None
        db.run("UPDATE profiles SET verified=1, badge=? WHERE user_id=?", (badge, uid))
    social.reset_verified_cache()
    card = social.user_card(db.one("SELECT user_id, username, name, avatar, equipped, status_emoji, status_text, status_until FROM profiles WHERE user_id=?", (uid,)))
    return JSONResponse({"user": card})


@auth()
async def online_friends(request: Request):
    v = request.state.user["id"]
    ids = [i for i in social.friend_ids(v) if hub.is_online(i)]
    return JSONResponse({"items": list(social.cards_by_ids(ids).values())[:20], "total": len(ids)})


# ----------------------------------------------------------------------------
# Настройки
# ----------------------------------------------------------------------------
PROFILE_FIELDS = {"name": 60, "bio": 500, "city": 80, "education": 200, "work": 200, "relationship": 40,
                  "school": 120, "university": 120}
YEAR_FIELDS = ("school_year", "university_year")
PRIVACY_FIELDS = {
    "profile_visibility": ("public", "friends"),
    "message_privacy": ("all", "friends"),
    "friends_visibility": ("public", "friends", "only_me"),
    "default_visibility": ("public", "friends", "only_me"),
    "theme": ("system", "light", "dark"),
}


APPEARANCE_ENUMS = {
    "preset": ("orbit", "dawn", "ocean", "forest", "sakura", "midnight", "neon", "graphite", "classic",
               "sky", "sunset", "cyber", "coffee", "royal", "notebook", "sport", "amber", "minimal", "custom"),
    "palette": ("violet", "ocean", "mint", "forest", "sakura", "ruby", "lavender", "midnight", "graphite",
                "sky", "sunset", "amber", "coffee", "cyber", "royal", "custom"),
    "bg": ("orbit", "aurora", "stars", "gradient", "pattern", "plain", "image"),
    "font": ("manrope", "inter", "nunito", "rubik", "montserrat", "comfortaa", "serif", "mono", "roboto", "opensans",
             "ubuntu", "exo", "oswald", "lora", "philosopher", "caveat", "pacifico", "russo", "system"),
    "shape": ("soft", "medium", "sharp"),
}
APPEARANCE_RANGES = {"dim": (0, 85), "blur": (0, 24)}
HEX_COLOR = re.compile(r"^#[0-9a-fA-F]{6}$")


def clean_appearance(raw) -> dict | None:
    """Проверяет настройки оформления: только известные ключи и значения."""
    if not isinstance(raw, dict):
        return None
    out = {}
    for key, allowed in APPEARANCE_ENUMS.items():
        if key in raw:
            if raw[key] not in allowed:
                return None
            out[key] = raw[key]
    for key, (lo, hi) in APPEARANCE_RANGES.items():
        if key in raw:
            try:
                out[key] = max(lo, min(hi, int(raw[key])))
            except (TypeError, ValueError):
                return None
    custom = raw.get("custom")
    if custom not in (None, ""):
        if not isinstance(custom, str) or not HEX_COLOR.match(custom):
            return None
        out["custom"] = custom.lower()
    if out.get("palette") == "custom" and not out.get("custom"):
        return None
    return out


def parse_appearance(value):
    if not value:
        return None
    try:
        return json.loads(value)
    except ValueError:
        return None


@auth()
async def settings_get(request: Request):
    u = request.state.user
    p = db.one("SELECT * FROM profiles WHERE user_id=?", (u["id"],))
    p["email"] = u["email"]
    p["email_verified"] = bool(u["email_verified_at"])
    p["show_birth_date"] = bool(p["show_birth_date"])
    p["invisible"] = bool(p["invisible"])
    p["appearance"] = parse_appearance(p["appearance"])
    pend = email_codes.pending(u["id"], "email_change")
    p["pending_email"] = pend["new_email"] if pend else None
    p["mail_enabled"] = mailer.configured()
    p["equipped"] = collection.parse_equipped(p.get("equipped"))
    return JSONResponse(p)


@auth()
async def set_status(request: Request):
    """Статус-настроение: эмодзи + короткий текст, по желанию — на время (1, 4, 24 часа, неделя)."""
    limit(request, "write")
    v = request.state.user["id"]
    if request.method == "DELETE":
        db.run("UPDATE profiles SET status_emoji=NULL, status_text=NULL, status_until=NULL WHERE user_id=?", (v,))
        return JSONResponse({"status": None})
    data = await body(request)
    emoji = clean_text(str(data.get("emoji") or ""), 8).strip()
    text = censor(clean_text(str(data.get("text") or ""), 60)).strip()
    if not emoji and not text:
        raise ApiError(400, "Выберите эмодзи или напишите статус")
    try:
        hours = int(data.get("hours") or 0)
    except (TypeError, ValueError):
        hours = 0
    until = db.future(hours=hours) if hours in (1, 4, 24, 168) else None
    db.run("UPDATE profiles SET status_emoji=?, status_text=?, status_until=? WHERE user_id=?", (emoji or None, text or None, until, v))
    return JSONResponse({"status": {"emoji": emoji, "text": text, "until": until}})


def _mask(email: str) -> str:
    name, _, domain = email.partition("@")
    return (name[:2] + "•" * max(1, len(name) - 2)) + "@" + domain


@auth()
async def email_change(request: Request):
    """Шаг 1: новый адрес + пароль → код на новый адрес (или сразу, если почта не настроена)."""
    from .auth_routes import EMAIL_RE
    limit(request, "auth", "email")
    u = request.state.user
    data = await body(request)
    new = str(data.get("email", "")).strip().lower()
    errors = {}
    if not EMAIL_RE.match(new) or len(new) > 254:
        errors["email"] = "Введите корректный адрес почты"
    elif new == str(u["email"]).lower():
        errors["email"] = "Это ваш текущий адрес"
    elif db.value("SELECT 1 FROM users WHERE email=? AND id!=?", (new, u["id"])):
        errors["email"] = "Этот адрес уже занят другим аккаунтом"
    stored = db.value("SELECT password_hash FROM users WHERE id=?", (u["id"],))
    if not verify_password(str(data.get("password", "")), stored):
        errors["password"] = "Неверный пароль"
    if errors:
        return JSONResponse({"error": "Проверьте поля формы", "fields": errors}, status_code=422)
    if not mailer.configured():
        db.run("UPDATE users SET email=?, email_verified_at=NULL WHERE id=?", (new, u["id"]))
        return JSONResponse({"changed": True, "email": new, "email_verified": False})
    code = email_codes.issue(u["id"], "email_change", new)
    sent = await mailer.send(new, f"Код для смены почты: {code} — {config.APP_NAME}",
                             "Вы меняете адрес почты своего аккаунта. Введите этот код на сайте, чтобы подтвердить новый адрес.",
                             code=code)
    if not sent:
        raise ApiError(503, "Не удалось отправить письмо. Попробуйте позже.")
    return JSONResponse({"pending": new})


@auth()
async def email_confirm(request: Request):
    """Шаг 2: код из письма → адрес меняется и сразу считается подтверждённым."""
    limit(request, "auth", "code")
    u = request.state.user
    data = await body(request)
    if data.get("cancel"):
        db.run("DELETE FROM email_codes WHERE user_id=? AND purpose='email_change'", (u["id"],))
        return ok()
    row = email_codes.consume(u["id"], "email_change", str(data.get("code", "")))
    new = row["new_email"]
    if db.value("SELECT 1 FROM users WHERE email=? AND id!=?", (new, u["id"])):
        raise ApiError(409, "Этот адрес уже занят другим аккаунтом")
    old = u["email"]
    db.run("UPDATE users SET email=?, email_verified_at=? WHERE id=?", (new, db.now(), u["id"]))
    await mailer.send(old, f"Адрес почты изменён — {config.APP_NAME}",
                      f"Адрес почты вашего аккаунта изменён на {_mask(new)}. Если это сделали не вы — срочно смените пароль "
                      "и напишите в поддержку.")
    return JSONResponse({"email": new, "email_verified": True})


@auth()
async def settings_update(request: Request):
    limit(request, "write")
    v = request.state.user["id"]
    data = await body(request)
    sets, params, errors = [], [], {}
    for field, max_len in PROFILE_FIELDS.items():
        if field in data:
            val = censor(clean_text(str(data[field] or ""), max_len))
            if field == "name":
                val = re.sub(r"\s+", " ", val)
                if len(val) < 2:
                    errors["name"] = "Имя — от 2 до 60 символов"
                    continue
            sets.append(f"{field}=?")
            params.append(val)
    if "birth_date" in data:
        bd = data["birth_date"] or None
        if bd and not re.match(r"^\d{4}-\d{2}-\d{2}$", str(bd)):
            errors["birth_date"] = "Некорректная дата"
        else:
            sets.append("birth_date=?")
            params.append(bd)
    for field in YEAR_FIELDS:
        if field in data:
            val = data[field]
            if val in (None, ""):
                sets.append(f"{field}=?"); params.append(None)
            else:
                try:
                    year = int(val)
                    if not 1940 <= year <= 2040:
                        raise ValueError
                except (TypeError, ValueError):
                    errors[field] = "Год от 1940 до 2040"
                    continue
                sets.append(f"{field}=?"); params.append(year)
    if "invisible" in data:
        sets.append("invisible=?"); params.append(1 if data["invisible"] else 0)
    if "show_birth_date" in data:
        sets.append("show_birth_date=?")
        params.append(1 if data["show_birth_date"] else 0)
    if "username" in data:
        from .auth_routes import RESERVED
        from ..security import USERNAME_RE
        un = str(data["username"]).strip().lstrip("@")
        if not USERNAME_RE.match(un):
            errors["username"] = "Логин: 3–30 символов, латиница, цифры и _"
        elif un.lower() in RESERVED or db.value("SELECT 1 FROM profiles WHERE username=? AND user_id!=?", (un, v)):
            errors["username"] = "Этот логин уже занят"
        else:
            sets.append("username=?")
            params.append(un)
    for field, allowed in PRIVACY_FIELDS.items():
        if field in data:
            if data[field] not in allowed:
                errors[field] = "Недопустимое значение"
                continue
            sets.append(f"{field}=?")
            params.append(data[field])
    if "appearance" in data:
        look = clean_appearance(data["appearance"])
        if look is None:
            errors["appearance"] = "Недопустимые настройки оформления"
        else:
            sets.append("appearance=?")
            params.append(json.dumps(look, separators=(",", ":")))
    if errors:
        return JSONResponse({"error": "Проверьте поля формы", "fields": errors}, status_code=422)
    if sets:
        db.run(f"UPDATE profiles SET {', '.join(sets)} WHERE user_id=?", (*params, v))
        if "invisible" in data:
            social.reset_verified_cache()
    return await settings_get(request)


@auth()
async def upload_image(request: Request):
    limit(request, "upload")
    v = request.state.user["id"]
    kind = request.path_params["kind"]
    if kind not in ("avatar", "cover", "background"):
        raise ApiError(404, "Не найдено")
    old = db.value(f"SELECT {kind} FROM profiles WHERE user_id=?", (v,))
    if request.method == "DELETE":
        db.run(f"UPDATE profiles SET {kind}=NULL WHERE user_id=?", (v,))
        media.delete_files(old)
        return JSONResponse({kind: None})
    form = await request.form(max_files=1, max_fields=5)
    try:
        f = form.get("file")
        if not getattr(f, "filename", None):
            raise ApiError(400, "Выберите изображение")
        saved = await media.save_upload(f, kind)
    finally:
        await form.close()
    url = saved["path"]  # превью доступно по тому же адресу с суффиксом _t
    db.run(f"UPDATE profiles SET {kind}=? WHERE user_id=?", (url, v))
    media.delete_files(old)
    return JSONResponse({kind: url})


@auth()
async def export_data(request: Request):
    """Выгрузка всех своих данных в JSON (право субъекта персональных данных)."""
    v = request.state.user["id"]
    data = {
        "account": db.one("SELECT id, email, email_verified_at, created_at FROM users WHERE id=?", (v,)),
        "profile": db.one("SELECT * FROM profiles WHERE user_id=?", (v,)),
        "posts": db.all("SELECT * FROM posts WHERE author_id=? ORDER BY id", (v,)),
        "media": db.all("SELECT m.* FROM post_media m JOIN posts p ON p.id=m.post_id WHERE p.author_id=?", (v,)),
        "comments": db.all("SELECT * FROM comments WHERE author_id=? ORDER BY id", (v,)),
        "reactions": db.all("SELECT * FROM reactions WHERE user_id=?", (v,)),
        "bookmarks": db.all("SELECT * FROM bookmarks WHERE user_id=?", (v,)),
        "friends": db.all("SELECT * FROM friendships WHERE requester_id=? OR addressee_id=?", (v, v)),
        "follows": db.all("SELECT * FROM follows WHERE follower_id=? OR followee_id=?", (v, v)),
        "messages": db.all("SELECT * FROM messages WHERE sender_id=? ORDER BY id", (v,)),
        "stories": db.all("SELECT * FROM stories WHERE author_id=?", (v,)),
        "circles": db.all("SELECT c.name, cm.user_id FROM circles c LEFT JOIN circle_members cm ON cm.circle_id=c.id WHERE c.owner_id=?", (v,)),
        "communities": db.all("SELECT c.slug, c.name, m.role, m.status FROM community_members m JOIN communities c ON c.id=m.community_id WHERE m.user_id=?", (v,)),
        "events": db.all("SELECT * FROM events WHERE creator_id=?", (v,)),
        "exported_at": db.now(),
    }
    return Response(json.dumps(data, ensure_ascii=False, indent=2), media_type="application/json",
                    headers={"Content-Disposition": 'attachment; filename="krug-export.json"'})


@auth()
async def delete_account(request: Request):
    limit(request, "auth")
    v = request.state.user["id"]
    data = await body(request)
    stored = db.value("SELECT password_hash FROM users WHERE id=?", (v,))
    if not verify_password(str(data.get("password", "")), stored):
        raise ApiError(400, "Неверный пароль")
    post_ids = [r["id"] for r in db.all("SELECT id FROM posts WHERE author_id=?", (v,))]
    if post_ids:
        delete_post_files(post_ids)
    prof = db.one("SELECT avatar, cover, background FROM profiles WHERE user_id=?", (v,))
    media.delete_files(prof["avatar"], prof["cover"], prof["background"])
    # клипы, свои стикеры и вложения из сообщений
    for r in db.all("SELECT video, poster FROM reels WHERE author_id=?", (v,)):
        media.delete_files(r["video"], r["poster"])
    for r in db.all("SELECT s.file FROM stickers s JOIN sticker_packs p ON p.id=s.pack_id WHERE p.owner_id=?", (v,)):
        media.delete_files(r["file"])
    for r in db.all("SELECT media FROM messages WHERE sender_id=? AND media IS NOT NULL AND kind != 'sticker'", (v,)):
        try:
            m = json.loads(r["media"])
        except ValueError:
            continue
        media.delete_files(m.get("url"), m.get("poster_src"))
    for r in db.all("SELECT media FROM stories WHERE author_id=?", (v,)):
        media.delete_files(r["media"])
    for r in db.all("SELECT cover FROM events WHERE creator_id=?", (v,)):
        media.delete_files(r["cover"])
    db.run("DELETE FROM reports WHERE target_type='user' AND target_id=?", (v,))
    # сообщества не должны остаться без администратора: передаём права самому давнему модератору или участнику
    from .communities import ensure_admin
    my_admin_of = [r["community_id"] for r in db.all(
        "SELECT community_id FROM community_members WHERE user_id=? AND role='admin'", (v,))]
    my_convs = [r["conversation_id"] for r in db.all("SELECT conversation_id FROM conversation_members WHERE user_id=?", (v,))]
    db.run("DELETE FROM users WHERE id=?", (v,))  # остальное удаляется каскадно
    for cid in my_admin_of:
        ensure_admin(cid)
    # удаляем только диалоги, где никого не осталось; переписка собеседника сохраняется
    if my_convs:
        db.run(f"""DELETE FROM conversations WHERE id IN ({db.placeholders(my_convs)})
                   AND NOT EXISTS (SELECT 1 FROM conversation_members m WHERE m.conversation_id = conversations.id)""", tuple(my_convs))
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(config.SESSION_COOKIE, path="/")
    return resp


# ---------------------------------------------------------------- Онбординг 2.0 и обучение
ONBOARDING_STYLES = ("modern", "fun", "future")
TOUR_KEYS = ("feed", "profile", "friends", "messages", "settings", "security", "invite", "music")


def _onboarding(v: int) -> dict:
    try:
        d = json.loads(db.value("SELECT onboarding FROM profiles WHERE user_id=?", (v,)) or "{}")
    except ValueError:
        d = {}
    return d if isinstance(d, dict) else {}


@auth()
async def onboarding_get(request: Request):
    d = _onboarding(request.state.user["id"])
    return JSONResponse({"style": d.get("style"), "done": bool(d.get("done")), "tours": d.get("tours") or [],
                         "sound": d.get("sound", True)})


@auth()
async def onboarding_set(request: Request):
    v = request.state.user["id"]
    data = await body(request)
    d = _onboarding(v)
    if data.get("style") in ONBOARDING_STYLES:
        d["style"] = data["style"]
    if "done" in data:
        d["done"] = bool(data["done"])
    if "sound" in data:
        d["sound"] = bool(data["sound"])
    if data.get("tour") in TOUR_KEYS:
        d["tours"] = sorted(set(d.get("tours") or []) | {data["tour"]})
    if data.get("reset_tours"):
        d["tours"] = []
    db.run("UPDATE profiles SET onboarding=? WHERE user_id=?", (json.dumps(d), v))
    return JSONResponse({"style": d.get("style"), "done": bool(d.get("done")), "tours": d.get("tours") or [], "sound": d.get("sound", True)})


# ---------------------------------------------------------------- Constellation и пространство профиля
@auth()
async def constellation_get(request: Request):
    v = request.state.user["id"]
    raw = db.value("SELECT constellation FROM profiles WHERE user_id=?", (v,))
    d = constellation.load(raw)
    kinds = [{"kind": k, "label": x[0], "group": x[1], "needs_url": "*" in x[3] or k == "spotify"} for k, x in constellation.KINDS.items()]
    return JSONResponse({"style": d["style"], "items": d["items"], "kinds": kinds, "styles": list(constellation.STYLES)})


@auth()
async def constellation_set(request: Request):
    v = request.state.user["id"]
    limit(request, "constellation")
    data = await body(request)
    try:
        d = constellation.validate(data)
    except constellation.Invalid as e:
        raise ApiError(400, str(e))
    db.run("UPDATE profiles SET constellation=? WHERE user_id=?", (json.dumps(d, ensure_ascii=False), v))
    return JSONResponse(constellation.public(v, json.dumps(d)))


@auth()
async def live_world(request: Request):
    """Живой мини-профиль мира из Созвездия (Steam, GitHub, Telegram). Только ник, вписанный владельцем, — не прокси."""
    from .. import worlds
    kind = request.path_params.get("kind", "steam")
    if kind not in worlds.LIVE_KINDS:
        raise ApiError(404, "Этот мир не умеет показывать живой профиль")
    v = request.state.user["id"]
    p = _profile(request.path_params["username"])
    uid = p["user_id"]
    rel = social.relation(v, uid)
    if rel["blocked_me"] or not (uid == v or rel["status"] == "friends" or p["profile_visibility"] == "public"):
        raise ApiError(404, "Профиль скрыт")
    item = next((i for i in constellation.load(p.get("constellation"))["items"] if i.get("kind") == kind), None)
    if not item or not item.get("handle"):
        raise ApiError(404, "Мир не привязан")
    limit(request, "steam_world")
    from starlette.concurrency import run_in_threadpool
    return JSONResponse(await run_in_threadpool(worlds.fetch, kind, item["handle"]))


@auth()
async def space_set(request: Request):
    v = request.state.user["id"]
    data = await body(request)
    d = constellation.load_space(json.dumps(data if isinstance(data, dict) else {}))
    db.run("UPDATE profiles SET space=? WHERE user_id=?", (json.dumps(d), v))
    return JSONResponse(d)


routes = [
    Route("/api/me/constellation", constellation_get, methods=["GET"]),
    Route("/api/me/constellation", constellation_set, methods=["PUT"]),
    Route("/api/me/space", space_set, methods=["PUT"]),
    Route("/api/users/{username}/steam", live_world, methods=["GET"]),
    Route("/api/users/{username}/world/{kind}", live_world, methods=["GET"]),
    Route("/api/onboarding", onboarding_get, methods=["GET"]),
    Route("/api/onboarding", onboarding_set, methods=["POST"]),
    Route("/api/users/{username}", profile, methods=["GET"]),
    Route("/api/users/{username}/friends", user_friends, methods=["GET"]),
    Route("/api/users/{username}/follows", user_follows, methods=["GET"]),
    Route("/api/people/{id:int}/friend", friend_request, methods=["POST"]),
    Route("/api/people/{id:int}/friend", friend_remove, methods=["DELETE"]),
    Route("/api/people/{id:int}/friend/accept", friend_accept, methods=["POST"]),
    Route("/api/people/{id:int}/follow", follow, methods=["POST", "DELETE"]),
    Route("/api/people/{id:int}/block", block, methods=["POST", "DELETE"]),
    Route("/api/friends/requests", requests_list, methods=["GET"]),
    Route("/api/friends/suggestions", suggestions, methods=["GET"]),
    Route("/api/friends/online", online_friends, methods=["GET"]),
    Route("/api/featured", featured, methods=["GET"]),
    Route("/api/admin/users/{id:int}/verify", admin_verify, methods=["POST", "DELETE"]),
    Route("/api/me/settings", settings_get, methods=["GET"]),
    Route("/api/me/settings", settings_update, methods=["PATCH"]),
    Route("/api/me/status", set_status, methods=["PATCH", "DELETE"]),
    Route("/api/me/email", email_change, methods=["POST"]),
    Route("/api/me/email/confirm", email_confirm, methods=["POST"]),
    Route("/api/me/{kind}", upload_image, methods=["POST", "DELETE"]),
    Route("/api/me/export", export_data, methods=["GET"]),
    Route("/api/me", delete_account, methods=["DELETE"]),
]
