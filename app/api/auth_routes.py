"""Регистрация, вход, выход, подтверждение почты, восстановление и смена пароля."""
import asyncio
import base64
import json
import re
import secrets

from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from .. import config, db, email_codes, mailer, qr, referrals, social, twofa
from ..security import (DISPOSABLE_DOMAINS, LIMITS, USERNAME_RE, hash_password, new_token, rate_limiter, token_hash,
                        validate_password, verify_password)
from ..web import ApiError, auth, body, client_ip, ip_prefix, limit, ok
from . import accounts


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
        "mail_enabled": mailer.configured(),
    }


def _start_session(request: Request, response: JSONResponse, user_id: int) -> None:
    token = new_token()
    db.run("""INSERT INTO sessions (id, user_id, csrf_token, user_agent, expires_at, ip_prefix, last_seen_at)
              VALUES (?,?,?,?,?,?,?)""",
           (token_hash(token), user_id, secrets.token_urlsafe(24),
            request.headers.get("user-agent", "")[:200], db.future(days=config.SESSION_DAYS),
            ip_prefix(client_ip(request)), db.now()))
    response.set_cookie(config.SESSION_COOKIE, token, max_age=config.SESSION_DAYS * 86400,
                        httponly=True, samesite="lax", secure=config.COOKIE_SECURE, path="/")


def log_login(request: Request, user_id: int | None, ok_: bool, method: str, reason: str | None = None) -> None:
    """Запись в журнал входов: успешные и неудачные попытки, устройство и сеть (без точного IP)."""
    db.run("INSERT INTO login_events (user_id, ok, method, reason, device, ip_prefix) VALUES (?,?,?,?,?,?)",
           (user_id, 1 if ok_ else 0, method, reason, _device(request.headers.get("user-agent", "")),
            ip_prefix(client_ip(request))))


def _is_new_place(request: Request, user_id: int) -> bool:
    """Первый вход с этого устройства из этой сети (а сами входы были и раньше)."""
    device, net = _device(request.headers.get("user-agent", "")), ip_prefix(client_ip(request))
    seen = db.value("SELECT count(*) FROM login_events WHERE user_id=? AND ok=1", (user_id,)) or 0
    same = db.value("SELECT 1 FROM login_events WHERE user_id=? AND ok=1 AND device=? AND ip_prefix=?", (user_id, device, net))
    return seen > 0 and not same


async def _finish_login(request: Request, user_id: int, method: str, add: bool = False) -> JSONResponse:
    new_place = _is_new_place(request, user_id)
    resp = JSONResponse({"ok": True})
    if add:  # «Добавить аккаунт»: текущий сеанс не закрываем, а откладываем в список аккаунтов устройства
        accounts.stash_current(request, resp, user_id)
    log_login(request, user_id, True, method)
    _start_session(request, resp, user_id)
    if new_place and mailer.configured():
        email = db.value("SELECT email FROM users WHERE id=?", (user_id,))
        device = _device(request.headers.get("user-agent", ""))
        text = (f"В ваш аккаунт выполнен вход: {device}, сеть {ip_prefix(client_ip(request))}. "
                "Если это были вы — ничего делать не нужно. Если нет — откройте «Настройки → Защита», "
                "завершите незнакомый сеанс и смените пароль.")
        asyncio.create_task(mailer.send(email, f"Новый вход в аккаунт — {config.APP_NAME}", text, f"{config.APP_URL}/settings?tab=security"))
    return resp


async def _send_token_email(user_id: int, email: str, kind: str) -> bool:
    token = new_token()
    hours = 48 if kind == "verify" else 2
    db.run("INSERT INTO email_tokens (id, user_id, kind, expires_at) VALUES (?,?,?,?)",
           (token_hash(token), user_id, kind, db.future(hours=hours)))
    if kind == "verify":
        code = email_codes.issue(user_id, "verify")
        return await mailer.send(email, f"Код подтверждения: {code} — {config.APP_NAME}",
                                 "Здравствуйте! Введите этот код на сайте, чтобы подтвердить адрес электронной почты. "
                                 "Или просто нажмите кнопку ниже.",
                                 f"{config.APP_URL}/verify?token={token}", code=code)
    else:
        return await mailer.send(email, f"Восстановление пароля — {config.APP_NAME}",
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
    # антибот: невидимое поле-ловушка заполняют только скрипты; живой человек не заполняет форму быстрее 1.5 с
    if str(data.get("website") or "").strip():
        raise ApiError(400, "Не удалось зарегистрироваться. Обновите страницу и попробуйте ещё раз.")
    try:
        fill_ms = int(data.get("t")) if data.get("t") is not None else None
    except (TypeError, ValueError):
        fill_ms = None
    if fill_ms is not None and fill_ms < 1500:
        raise ApiError(429, "Слишком быстро. Подождите пару секунд и отправьте форму ещё раз.")
    # массовые регистрации: считаем только успешные, но проверяем заранее
    ip = client_ip(request)
    for bucket in ("register", "register_day"):
        n_, w_ = LIMITS[bucket]
        if not rate_limiter.check(f"{bucket}:{ip}", n_, w_):
            raise ApiError(429, "С этой сети недавно создали слишком много аккаунтов. Попробуйте позже.")
    email = str(data.get("email", "")).strip().lower()
    if email.rsplit("@", 1)[-1] in DISPOSABLE_DOMAINS:
        return JSONResponse({"error": "Проверьте поля формы",
                             "fields": {"email": "Одноразовые почтовые ящики не подходят — укажите свою почту"}}, status_code=422)
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
    if data.get("terms") is False:
        errors["terms"] = "Нужно принять Пользовательское соглашение"
    if errors:
        return JSONResponse({"error": "Проверьте поля формы", "fields": errors}, status_code=422)

    with db.tx() as c:
        cur = c.execute("INSERT INTO users (email, password_hash, consent_at) VALUES (?,?,?)",
                        (email, hash_password(password), db.now()))
        uid = cur.lastrowid
        c.execute("INSERT INTO profiles (user_id, username, name) VALUES (?,?,?)", (uid, username, name))
    from .. import consents
    for k in ("pd", "terms", "content"):
        consents.record(uid, k, True, request)
    for bucket in ("register", "register_day"):
        rate_limiter.hit(f"{bucket}:{ip}", *LIMITS[bucket])
    log_login(request, uid, True, "register")
    # пришёл по приглашению: запоминаем пригласившего и сразу подписываем на него
    ref = str(data.get("ref") or request.cookies.get("krug_ref") or "")
    inviter = referrals.attach(uid, ref, ip_prefix(ip)) if ref else None
    if inviter:
        db.run("INSERT OR IGNORE INTO follows (follower_id, followee_id) VALUES (?,?)", (uid, inviter))
    from .. import updates
    updates.follow_new_user(uid)  # официальный канал обновлений
    await _send_token_email(uid, email, "verify")
    resp = JSONResponse({"ok": True, "invited_by": inviter}, status_code=201)
    _start_session(request, resp, uid)
    if ref:
        resp.delete_cookie("krug_ref", path="/")
    return resp


async def login(request: Request):
    limit(request, "auth")
    data = await body(request)
    login_ = str(data.get("email", "")).strip().lstrip("@")
    password = str(data.get("password", ""))
    acct_key = f"login_account:{login_.lower()}"
    n, window = LIMITS["login_account"]
    if not rate_limiter.check(acct_key, n, window):
        raise ApiError(429, "Слишком много неудачных попыток входа. Попробуйте через 15 минут или восстановите пароль.")
    row = db.one("""SELECT u.id, u.password_hash, u.is_banned FROM users u JOIN profiles p ON p.user_id=u.id
                    WHERE u.email=? OR p.username=?""", (login_.lower(), login_))
    if not row or not verify_password(password, row["password_hash"]):
        rate_limiter.hit(acct_key, n, window)
        if row:
            log_login(request, row["id"], False, "password", "bad_password")
        raise ApiError(400, "Неверный e-mail или пароль")
    if row["is_banned"]:
        log_login(request, row["id"], False, "password", "banned")
        raise ApiError(403, "Аккаунт заблокирован администрацией")
    if twofa.enabled(row["id"]):
        # пароль верный, но сеанс выдаётся только после кода из приложения: даём билет на 5 минут
        ticket = new_token()
        db.run("INSERT INTO mfa_tickets (id, user_id, expires_at) VALUES (?,?,?)",
               (token_hash(ticket), row["id"], db.future(minutes=5)))
        return JSONResponse({"mfa_required": True, "ticket": ticket})
    return await _finish_login(request, row["id"], "password", add=bool(data.get("add")))


async def login_2fa(request: Request):
    """Второй шаг входа: билет из первого шага + код из приложения или резервный код."""
    limit(request, "auth", "2fa")
    data = await body(request)
    tid = token_hash(str(data.get("ticket", "")))
    t = db.one("SELECT * FROM mfa_tickets WHERE id=?", (tid,))
    if not t or t["expires_at"] < db.now() or t["attempts"] >= 5:
        if t:
            db.run("DELETE FROM mfa_tickets WHERE id=?", (tid,))
        raise ApiError(400, "Время на ввод кода истекло — войдите ещё раз", "mfa_expired")
    method = twofa.check(t["user_id"], str(data.get("code", "")))
    if not method:
        db.run("UPDATE mfa_tickets SET attempts=attempts+1 WHERE id=?", (tid,))
        log_login(request, t["user_id"], False, "totp", "bad_code")
        raise ApiError(400, "Неверный код. Проверьте время на телефоне или введите резервный код.")
    db.run("DELETE FROM mfa_tickets WHERE id=?", (tid,))
    if db.value("SELECT is_banned FROM users WHERE id=?", (t["user_id"],)):
        raise ApiError(403, "Аккаунт заблокирован администрацией")
    return await _finish_login(request, t["user_id"], method, add=bool(data.get("add")))


async def logout(request: Request):
    if request.state.session:
        db.run("DELETE FROM sessions WHERE id=?", (request.state.session["id"],))
    # на устройстве есть другие аккаунты — переключаемся на следующий, а не выходим совсем
    others = accounts.alive_tokens(request)
    if others:
        token = others[0][0]
        resp = JSONResponse({"ok": True, "switched": True})
        resp.set_cookie(config.SESSION_COOKIE, token, max_age=config.SESSION_DAYS * 86400,
                        httponly=True, samesite="lax", secure=config.COOKIE_SECURE, path="/")
        accounts.write_tokens(resp, [t for t, _ in others[1:]])
        return resp
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(config.SESSION_COOKIE, path="/")
    resp.delete_cookie(accounts.ACCOUNTS_COOKIE, path="/")
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
    sent = await _send_token_email(u["id"], u["email"], "verify")
    if not sent:
        raise ApiError(503, "Отправка писем пока не настроена на сервере. Попробуйте позже.")
    return ok()


@auth()
async def verify_code(request: Request):
    limit(request, "auth", "code")
    u = request.state.user
    if u["email_verified_at"]:
        return ok()
    data = await body(request)
    email_codes.consume(u["id"], "verify", str(data.get("code", "")))
    db.run("UPDATE users SET email_verified_at=coalesce(email_verified_at, ?) WHERE id=?", (db.now(), u["id"]))
    return ok()


async def forgot(request: Request):
    limit(request, "auth")
    data = await body(request)
    email = str(data.get("email", "")).strip().lower()
    row = db.one("SELECT id FROM users WHERE email=?", (email,))
    n, window = LIMITS["mail_address"]
    if row and rate_limiter.hit(f"mail_address:{email}", n, window):
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
    log_login(request, uid, True, "reset")
    if twofa.enabled(uid):
        # письмо со ссылкой не должно обходить вторую ступень защиты: дальше обычный вход с кодом
        return JSONResponse({"ok": True, "need_login": True})
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



def _device(ua: str) -> str:
    """Понятное название устройства по строке браузера."""
    ua = ua or ""
    os_ = next((n for k, n in (("iPhone", "iPhone"), ("iPad", "iPad"), ("Android", "Android"), ("Windows", "Windows"),
                                 ("Mac OS", "Mac"), ("Linux", "Linux")) if k in ua), "Устройство")
    br = next((n for k, n in (("YaBrowser", "Яндекс Браузер"), ("Edg/", "Edge"), ("OPR/", "Opera"), ("Firefox", "Firefox"),
                                ("Chrome", "Chrome"), ("Safari", "Safari")) if k in ua), "браузер")
    return f"{br}, {os_}"


@auth()
async def sessions_list(request: Request):
    u = request.state.user
    current = request.state.session["id"]
    rows = db.all("""SELECT id, user_agent, created_at, last_seen_at, ip_prefix FROM sessions WHERE user_id=? AND expires_at>?
                     ORDER BY coalesce(last_seen_at, created_at) DESC""", (u["id"], db.now()))
    return JSONResponse({"items": [{"id": r["id"][:16], "device": _device(r["user_agent"]), "created_at": r["created_at"],
                                    "last_seen_at": r["last_seen_at"] or r["created_at"], "network": r["ip_prefix"],
                                    "current": r["id"] == current} for r in rows]})


# ---------------------------------------------------------------- журнал входов и 2FA
REASONS = {"bad_password": "неверный пароль", "bad_code": "неверный код 2FA", "banned": "аккаунт заблокирован"}
METHODS = {"password": "пароль", "totp": "пароль + код из приложения", "backup": "пароль + резервный код",
           "reset": "восстановление пароля", "register": "регистрация"}


@auth()
async def logins(request: Request):
    v = request.state.user["id"]
    before = request.query_params.get("before")
    params = [v] + ([int(before)] if before and before.isdigit() else [])
    rows = db.all(f"""SELECT id, ok, method, reason, device, ip_prefix, created_at FROM login_events
                      WHERE user_id=? {'AND id < ?' if len(params) > 1 else ''} ORDER BY id DESC LIMIT 30""", tuple(params))
    return JSONResponse({"items": [{"id": r["id"], "ok": bool(r["ok"]), "method": METHODS.get(r["method"], r["method"]),
                                    "reason": REASONS.get(r["reason"] or "", r["reason"]), "device": r["device"],
                                    "network": r["ip_prefix"], "created_at": r["created_at"]} for r in rows],
                         "more": len(rows) == 30})


def _require_password(u, data) -> None:
    stored = db.value("SELECT password_hash FROM users WHERE id=?", (u["id"],))
    if not verify_password(str(data.get("password", "")), stored):
        raise ApiError(400, "Пароль указан неверно", "bad_password")


@auth()
async def twofa_status(request: Request):
    v = request.state.user["id"]
    on = twofa.enabled(v)
    return JSONResponse({"enabled": on, "backup_left": twofa.backup_left(v) if on else 0})


@auth()
async def twofa_setup(request: Request):
    """Новый секрет (пока не включён): QR-код для приложения и тот же ключ текстом для ручного ввода."""
    limit(request, "auth", "2fa-setup")
    u = request.state.user
    data = await body(request)
    _require_password(u, data)
    if twofa.enabled(u["id"]):
        raise ApiError(400, "Двухфакторная защита уже включена")
    secret = twofa.new_secret()
    enc = twofa.encrypt(secret)
    if db.value("SELECT 1 FROM user_totp WHERE user_id=?", (u["id"],)):
        db.run("UPDATE user_totp SET secret_enc=?, enabled_at=NULL, last_step=NULL WHERE user_id=?", (enc, u["id"]))
    else:
        db.run("INSERT INTO user_totp (user_id, secret_enc) VALUES (?,?)", (u["id"], enc))
    url = twofa.otpauth_url(secret, u["username"])
    svg = qr.svg(url)
    return JSONResponse({"secret": " ".join(secret[i:i + 4] for i in range(0, len(secret), 4)), "url": url,
                         "qr": "data:image/svg+xml;base64," + base64.b64encode(svg.encode()).decode()})


@auth()
async def twofa_enable(request: Request):
    limit(request, "auth", "2fa-enable")
    u = request.state.user
    data = await body(request)
    row = db.one("SELECT secret_enc, enabled_at FROM user_totp WHERE user_id=?", (u["id"],))
    if not row or row["enabled_at"]:
        raise ApiError(400, "Сначала получите новый ключ")
    step = twofa.verify(twofa.decrypt(row["secret_enc"]), str(data.get("code", "")), None)
    if step is None:
        raise ApiError(400, "Код не подошёл. Проверьте, что время на телефоне установлено автоматически.")
    db.run("UPDATE user_totp SET enabled_at=?, last_step=? WHERE user_id=?", (db.now(), step, u["id"]))
    codes = twofa.new_backup_codes(u["id"])
    return JSONResponse({"enabled": True, "backup_codes": codes})


@auth()
async def twofa_disable(request: Request):
    limit(request, "auth", "2fa-disable")
    u = request.state.user
    data = await body(request)
    _require_password(u, data)
    if not twofa.check(u["id"], str(data.get("code", ""))):
        raise ApiError(400, "Неверный код из приложения или резервный код")
    db.run("DELETE FROM user_totp WHERE user_id=?", (u["id"],))
    db.run("DELETE FROM backup_codes WHERE user_id=?", (u["id"],))
    return JSONResponse({"enabled": False})


@auth()
async def twofa_backup(request: Request):
    limit(request, "auth", "2fa-backup")
    u = request.state.user
    data = await body(request)
    if not twofa.check(u["id"], str(data.get("code", ""))):
        raise ApiError(400, "Неверный код из приложения")
    return JSONResponse({"backup_codes": twofa.new_backup_codes(u["id"])})


@auth()
async def sessions_end(request: Request):
    """Завершить один сеанс (id) или все, кроме текущего."""
    u = request.state.user
    current = request.state.session["id"]
    sid = request.path_params.get("sid")
    if sid:
        rows = [r["id"] for r in db.all("SELECT id FROM sessions WHERE user_id=?", (u["id"],)) if r["id"].startswith(sid) and r["id"] != current]
        for full in rows:
            db.run("DELETE FROM sessions WHERE id=?", (full,))
        if not rows:
            raise ApiError(404, "Сеанс не найден")
    else:
        db.run("DELETE FROM sessions WHERE user_id=? AND id<>?", (u["id"], current))
    return ok()

routes = [
    Route("/api/auth/2fa", login_2fa, methods=["POST"]),
    Route("/api/security/logins", logins, methods=["GET"]),
    Route("/api/security/2fa", twofa_status, methods=["GET"]),
    Route("/api/security/2fa/setup", twofa_setup, methods=["POST"]),
    Route("/api/security/2fa/enable", twofa_enable, methods=["POST"]),
    Route("/api/security/2fa/disable", twofa_disable, methods=["POST"]),
    Route("/api/security/2fa/backup", twofa_backup, methods=["POST"]),
    Route("/api/me/sessions", sessions_list, methods=["GET"]),
    Route("/api/me/sessions", sessions_end, methods=["DELETE"]),
    Route("/api/me/sessions/{sid}", sessions_end, methods=["DELETE"]),
    Route("/api/auth/register", register, methods=["POST"]),
    Route("/api/auth/login", login, methods=["POST"]),
    Route("/api/auth/logout", logout, methods=["POST"]),
    Route("/api/auth/logout-all", logout_all, methods=["POST"]),
    Route("/api/auth/me", me, methods=["GET"]),
    Route("/api/auth/verify", verify, methods=["POST"]),
    Route("/api/auth/resend", resend, methods=["POST"]),
    Route("/api/auth/verify-code", verify_code, methods=["POST"]),
    Route("/api/auth/forgot", forgot, methods=["POST"]),
    Route("/api/auth/reset", reset, methods=["POST"]),
    Route("/api/auth/change-password", change_password, methods=["POST"]),
]
