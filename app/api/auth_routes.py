"""Регистрация, вход, выход, подтверждение почты, восстановление и смена пароля."""
import json
import re
import secrets

from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from .. import config, db, mailer, social
from ..security import (USERNAME_RE, hash_password, new_token, token_hash,
                        validate_password, verify_password)
from ..web import ApiError, auth, body, limit, ok


def parse_appearance(value):
    try:
        return json.loads(value) if value else None
    except ValueError:
        return None

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
RESERVED = {"admin", "api", "login", "register", "settings", "messages", "friends", "search",
            "notifications", "bookmarks", "support", "krug", "root", "system", "tag", "post", "u"}


def me_payload(request: Request) -> dict:
    u = request.state.user
    if not u:
        return {"user": None}
    return {
        "user": {
            "id": u["id"], "email": u["email"], "username": u["username"], "name": u["name"],
            "avatar": u["avatar"], "theme": u["theme"], "appearance": parse_appearance(u["appearance"]), "background": u["background"], "default_visibility": u["default_visibility"], "email_verified": bool(u["email_verified_at"]),
            "is_admin": bool(u["is_admin"]),
        },
        "csrf": request.state.session["csrf"],
        "counters": social.counters(u["id"]),
        "require_email_confirm": config.REQUIRE_EMAIL_CONFIRM,
    }


def _start_session(request: Request, response: JSONResponse, user_id: int) -> None:
    token = new_token()
    db.run("INSERT INTO sessions (id, user_id, csrf_token, user_agent, expires_at) VALUES (?,?,?,?,?)",
           (token_hash(token), user_id, secrets.token_urlsafe(24),
            request.headers.get("user-agent", "")[:200], db.future(days=config.SESSION_DAYS)))
    response.set_cookie(config.SESSION_COOKIE, token, max_age=config.SESSION_DAYS * 86400,
                        httponly=True, samesite="lax", secure=config.COOKIE_SECURE, path="/")


async def _send_token_email(user_id: int, email: str, kind: str) -> None:
    token = new_token()
    hours = 48 if kind == "verify" else 2
    db.run("INSERT INTO email_tokens (id, user_id, kind, expires_at) VALUES (?,?,?,?)",
           (token_hash(token), user_id, kind, db.future(hours=hours)))
    if kind == "verify":
        await mailer.send(email, f"Подтвердите e-mail — {config.APP_NAME}",
                          "Здравствуйте! Чтобы подтвердить адрес электронной почты, перейдите по ссылке.",
                          f"{config.APP_URL}/verify?token={token}")
    else:
        await mailer.send(email, f"Восстановление пароля — {config.APP_NAME}",
                          "Вы запросили сброс пароля. Ссылка действует 2 часа.",
                          f"{config.APP_URL}/reset?token={token}")


def _use_token(token: str, kind: str) -> int:
    row = db.one("SELECT * FROM email_tokens WHERE id=? AND kind=?", (token_hash(token or ""), kind))
    if not row or row["used_at"] or row["expires_at"] < db.now():
        raise ApiError(400, "Ссылка недействительна или устарела")
    db.run("UPDATE email_tokens SET used_at=? WHERE id=?", (db.now(), row["id"]))
    return row["user_id"]


async def register(request: Request):
    limit(request, "auth")
    data = await body(request)
    email = str(data.get("email", "")).strip().lower()
    password = str(data.get("password", ""))
    name = re.sub(r"\s+", " ", str(data.get("name", ""))).strip()
    username = str(data.get("username", "")).strip().lstrip("@")
    errors = {}
    if not EMAIL_RE.match(email) or len(email) > 254:
        errors["email"] = "Введите корректный e-mail"
    elif db.value("SELECT 1 FROM users WHERE email=?", (email,)):
        errors["email"] = "Этот e-mail уже зарегистрирован"
    if err := validate_password(password):
        errors["password"] = err
    if not 2 <= len(name) <= 60:
        errors["name"] = "Имя — от 2 до 60 символов"
    if not USERNAME_RE.match(username):
        errors["username"] = "Логин: 3–30 символов, латиница, цифры и _"
    elif username.lower() in RESERVED or db.value("SELECT 1 FROM profiles WHERE username=?", (username,)):
        errors["username"] = "Этот логин уже занят"
    if not data.get("consent"):
        errors["consent"] = "Нужно согласие на обработку персональных данных"
    if errors:
        return JSONResponse({"error": "Проверьте поля формы", "fields": errors}, status_code=422)

    with db.tx() as c:
        cur = c.execute("INSERT INTO users (email, password_hash, consent_at) VALUES (?,?,?)",
                        (email, hash_password(password), db.now()))
        uid = cur.lastrowid
        c.execute("INSERT INTO profiles (user_id, username, name) VALUES (?,?,?)", (uid, username, name))
    await _send_token_email(uid, email, "verify")
    resp = JSONResponse({"ok": True}, status_code=201)
    _start_session(request, resp, uid)
    return resp


async def login(request: Request):
    limit(request, "auth")
    data = await body(request)
    login_ = str(data.get("email", "")).strip().lstrip("@")
    password = str(data.get("password", ""))
    row = db.one("""SELECT u.id, u.password_hash, u.is_banned FROM users u JOIN profiles p ON p.user_id=u.id
                    WHERE u.email=? OR p.username=?""", (login_.lower(), login_))
    if not row or not verify_password(password, row["password_hash"]):
        raise ApiError(400, "Неверный e-mail или пароль")
    if row["is_banned"]:
        raise ApiError(403, "Аккаунт заблокирован администрацией")
    resp = JSONResponse({"ok": True})
    _start_session(request, resp, row["id"])
    return resp


async def logout(request: Request):
    if request.state.session:
        db.run("DELETE FROM sessions WHERE id=?", (request.state.session["id"],))
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(config.SESSION_COOKIE, path="/")
    return resp


@auth()
async def logout_all(request: Request):
    db.run("DELETE FROM sessions WHERE user_id=? AND id != ?", (request.state.user["id"], request.state.session["id"]))
    return ok()


async def me(request: Request):
    return JSONResponse(me_payload(request))


async def verify(request: Request):
    data = await body(request)
    uid = _use_token(str(data.get("token", "")), "verify")
    db.run("UPDATE users SET email_verified_at=coalesce(email_verified_at, ?) WHERE id=?", (db.now(), uid))
    return ok()


@auth()
async def resend(request: Request):
    limit(request, "auth", "resend")
    u = request.state.user
    if u["email_verified_at"]:
        return ok()
    await _send_token_email(u["id"], u["email"], "verify")
    return ok()


async def forgot(request: Request):
    limit(request, "auth")
    data = await body(request)
    email = str(data.get("email", "")).strip().lower()
    row = db.one("SELECT id FROM users WHERE email=?", (email,))
    if row:
        await _send_token_email(row["id"], email, "reset")
    # одинаковый ответ, чтобы нельзя было проверить, зарегистрирован ли адрес
    return ok()


async def reset(request: Request):
    limit(request, "auth")
    data = await body(request)
    password = str(data.get("password", ""))
    if err := validate_password(password):
        raise ApiError(422, err)
    uid = _use_token(str(data.get("token", "")), "reset")
    db.run("UPDATE users SET password_hash=?, email_verified_at=coalesce(email_verified_at, ?) WHERE id=?",
           (hash_password(password), db.now(), uid))
    db.run("DELETE FROM sessions WHERE user_id=?", (uid,))
    resp = JSONResponse({"ok": True})
    _start_session(request, resp, uid)
    return resp


@auth()
async def change_password(request: Request):
    limit(request, "auth")
    data = await body(request)
    uid = request.state.user["id"]
    stored = db.value("SELECT password_hash FROM users WHERE id=?", (uid,))
    if not verify_password(str(data.get("old_password", "")), stored):
        raise ApiError(400, "Текущий пароль указан неверно")
    new = str(data.get("new_password", ""))
    if err := validate_password(new):
        raise ApiError(422, err)
    db.run("UPDATE users SET password_hash=? WHERE id=?", (hash_password(new), uid))
    db.run("DELETE FROM sessions WHERE user_id=? AND id != ?", (uid, request.state.session["id"]))
    return ok()


routes = [
    Route("/api/auth/register", register, methods=["POST"]),
    Route("/api/auth/login", login, methods=["POST"]),
    Route("/api/auth/logout", logout, methods=["POST"]),
    Route("/api/auth/logout-all", logout_all, methods=["POST"]),
    Route("/api/auth/me", me, methods=["GET"]),
    Route("/api/auth/verify", verify, methods=["POST"]),
    Route("/api/auth/resend", resend, methods=["POST"]),
    Route("/api/auth/forgot", forgot, methods=["POST"]),
    Route("/api/auth/reset", reset, methods=["POST"]),
    Route("/api/auth/change-password", change_password, methods=["POST"]),
]
