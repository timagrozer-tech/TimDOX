"""Web Push: уведомления на телефон и компьютер, даже когда сайт закрыт.

Своя реализация стандартов RFC 8291 (шифрование aes128gcm) и RFC 8292 (VAPID) на библиотеке cryptography —
без внешних сервисов. Ключи VAPID создаются один раз и хранятся в базе (ai_state), настраивать ничего не нужно."""
import base64
import hashlib
import hmac
import json
import logging
import os
import queue
import struct
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from . import config, db

log = logging.getLogger("krug.webpush")
_key_lock = threading.Lock()
_vapid: dict = {}


def b64u(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def unb64u(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def _raw_public(key) -> bytes:
    return key.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)


def vapid_key():
    """Закрытый ключ VAPID (P-256) — создаётся при первом обращении и хранится в базе."""
    with _key_lock:
        if "key" in _vapid:
            return _vapid["key"]
        pem = db.value("SELECT value FROM ai_state WHERE key='webpush:vapid'")
        if not pem:
            k = ec.generate_private_key(ec.SECP256R1())
            pem = k.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()).decode()
            db.run("INSERT INTO ai_state (key, value) VALUES ('webpush:vapid', ?)", (pem,))
            pem = db.value("SELECT value FROM ai_state WHERE key='webpush:vapid'") or pem  # если параллельно создали — берём из базы
        _vapid["key"] = serialization.load_pem_private_key(pem.encode(), password=None)
        return _vapid["key"]


def public_key() -> str:
    return b64u(_raw_public(vapid_key()))


def _jwt(aud: str) -> str:
    header = b64u(json.dumps({"typ": "JWT", "alg": "ES256"}, separators=(",", ":")).encode())
    sub = config.APP_URL if config.APP_URL.startswith("https://") else "mailto:admin@krug.local"
    claims = b64u(json.dumps({"aud": aud, "exp": int(time.time()) + 12 * 3600, "sub": sub}, separators=(",", ":")).encode())
    der = vapid_key().sign(f"{header}.{claims}".encode(), ec.ECDSA(hashes.SHA256()))
    r, s = decode_dss_signature(der)
    return f"{header}.{claims}.{b64u(r.to_bytes(32, 'big') + s.to_bytes(32, 'big'))}"


def _hkdf(salt: bytes, ikm: bytes, info: bytes, n: int) -> bytes:
    prk = hmac.new(salt, ikm, hashlib.sha256).digest()
    return hmac.new(prk, info + b"\x01", hashlib.sha256).digest()[:n]


def encrypt(payload: bytes, p256dh: str, auth: str) -> bytes:
    """RFC 8291: одна запись aes128gcm, ключ получателя — из подписки браузера."""
    ua_public = unb64u(p256dh)
    auth_secret = unb64u(auth)
    eph = ec.generate_private_key(ec.SECP256R1())
    as_public = _raw_public(eph)
    shared = eph.exchange(ec.ECDH(), ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), ua_public))
    ikm = _hkdf(auth_secret, shared, b"WebPush: info\x00" + ua_public + as_public, 32)
    salt = os.urandom(16)
    cek = _hkdf(salt, ikm, b"Content-Encoding: aes128gcm\x00", 16)
    nonce = _hkdf(salt, ikm, b"Content-Encoding: nonce\x00", 12)
    body = AESGCM(cek).encrypt(nonce, payload + b"\x02", None)
    return salt + struct.pack(">I", 4096) + bytes([len(as_public)]) + as_public + body


def send_one(sub: dict, data: dict, urgency: str = "normal", ttl: int = 86400) -> int:
    """Отправка в службу push браузера. Возвращает HTTP-код (0 — сеть недоступна)."""
    endpoint = sub["endpoint"]
    u = urllib.parse.urlsplit(endpoint)
    if u.scheme != "https":
        return 400
    body = encrypt(json.dumps(data, ensure_ascii=False).encode()[:3000], sub["p256dh"], sub["auth"])
    req = urllib.request.Request(endpoint, data=body, method="POST", headers={
        "content-encoding": "aes128gcm", "content-type": "application/octet-stream", "ttl": str(ttl), "urgency": urgency,
        "authorization": f"vapid t={_jwt(f'{u.scheme}://{u.netloc}')}, k={public_key()}"})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code
    except (urllib.error.URLError, OSError, TimeoutError) as e:
        log.info("push недоступен: %s", e)
        return 0


# ---------------------------------------------------------------- подписки и рассылка
def subscribe(uid: int, sub: dict, ua: str = "") -> None:
    endpoint = str(sub.get("endpoint") or "")
    keys = sub.get("keys") or {}
    if not endpoint.startswith("https://") or len(endpoint) > 1000 or not keys.get("p256dh") or not keys.get("auth"):
        from .web import ApiError
        raise ApiError(400, "Неверная подписка на уведомления")
    try:
        unb64u(keys["p256dh"]); unb64u(keys["auth"])
    except ValueError:
        from .web import ApiError
        raise ApiError(400, "Неверная подписка на уведомления")
    db.run("DELETE FROM push_subs WHERE endpoint=?", (endpoint,))
    db.run("INSERT INTO push_subs (user_id, endpoint, p256dh, auth, ua) VALUES (?,?,?,?,?)",
           (uid, endpoint, keys["p256dh"][:200], keys["auth"][:100], ua[:200]))


_jobs: "queue.Queue" = queue.Queue(maxsize=5000)
_thread = None
_last: dict = {}


def _worker() -> None:
    while True:
        uid, data, kind, urgency = _jobs.get()
        try:
            col = "notify_messages" if kind == "message" else "notify_social"
            for s in db.all(f"SELECT * FROM push_subs WHERE user_id=? AND {col}=1", (uid,)):
                code = send_one(s, data, urgency)
                if code in (404, 410):  # подписка больше не действует (удалили приложение, сбросили разрешение)
                    db.run("DELETE FROM push_subs WHERE id=?", (s["id"],))
                elif code and code >= 400:
                    log.info("push %s: код %s", urllib.parse.urlsplit(s["endpoint"]).netloc, code)
        except Exception as e:  # noqa: BLE001
            log.warning("push не отправлен: %s", e)


def push(uid: int, data: dict, kind: str = "social", urgency: str = "normal") -> None:
    global _thread
    if _thread is None or not _thread.is_alive():
        _thread = threading.Thread(target=_worker, daemon=True)
        _thread.start()
    try:
        _jobs.put_nowait((uid, data, kind, urgency))
    except queue.Full:
        pass


def _throttled(key, seconds: int) -> bool:
    now = time.time()
    if now - _last.get(key, 0) < seconds:
        return True
    _last[key] = now
    if len(_last) > 5000:
        for k in list(_last)[:2500]:
            _last.pop(k, None)
    return False


def has_subs(uid: int) -> bool:
    return bool(db.value("SELECT 1 FROM push_subs WHERE user_id=? LIMIT 1", (uid,)))


def notify_message(uid: int, sender_name: str, conv_id: int, preview: str, avatar: str | None = None) -> None:
    from .realtime import hub
    if hub.is_online(uid) or not has_subs(uid) or _throttled(("m", uid, conv_id), 45):
        return
    push(uid, {"title": sender_name, "body": preview[:180], "url": f"/messages/{conv_id}", "tag": f"conv-{conv_id}",
               "icon": avatar}, "message", "high")


SOCIAL = {
    "friend_request": "хочет добавить вас в друзья", "friend_accept": "принял(а) вашу заявку в друзья",
    "mention": "упомянул(а) вас", "comment": "прокомментировал(а) вашу запись", "reply": "ответил(а) на ваш комментарий",
    "follow": "подписался(-ась) на вас", "gift": "отправил(а) вам подарок 🎁", "transfer": "перевёл(а) вам KC",
    "reaction": "оценил(а) вашу запись", "repost": "поделился(-ась) вашей записью", "quote": "процитировал(а) вашу запись",
    "event_invite": "приглашает вас на мероприятие", "community_approved": "одобрил(а) вашу заявку в сообщество",
}
PATHS = {"friend_request": "/friends?tab=requests", "friend_accept": "/friends", "follow": "/notifications",
         "gift": "/notifications", "transfer": "/wallet", "event_invite": "/events"}


def notify_social(uid: int, actor_name: str, type_: str, post_id: int | None = None, avatar: str | None = None) -> None:
    from .realtime import hub
    if type_ not in SOCIAL or hub.is_online(uid) or not has_subs(uid):
        return
    # реакции сыплются пачками — одно уведомление на запись в 10 минут
    if _throttled(("s", uid, type_, post_id), 600 if type_ == "reaction" else 30):
        return
    url = PATHS.get(type_) or (f"/post/{post_id}" if post_id else "/notifications")
    push(uid, {"title": config.APP_NAME, "body": f"{actor_name} {SOCIAL[type_]}", "url": url,
               "tag": f"{type_}-{post_id or uid}", "icon": avatar}, "social")


# ---------------------------------------------------------------- API
from starlette.requests import Request  # noqa: E402
from starlette.responses import JSONResponse  # noqa: E402
from starlette.routing import Route  # noqa: E402

from .web import ApiError, auth, body, limit  # noqa: E402


def _device(uid: int, endpoint: str) -> dict | None:
    return db.one("SELECT * FROM push_subs WHERE user_id=? AND endpoint=?", (uid, endpoint)) if endpoint else None


@auth()
async def api_state(request: Request):
    v = request.state.user["id"]
    d = _device(v, request.query_params.get("endpoint", ""))
    return JSONResponse({"key": public_key(), "devices": db.value("SELECT count(*) FROM push_subs WHERE user_id=?", (v,)),
                         "this": {"notify_messages": bool(d["notify_messages"]), "notify_social": bool(d["notify_social"])} if d else None})


@auth()
async def api_subscribe(request: Request):
    limit(request, "write")
    v = request.state.user["id"]
    data = await body(request)
    subscribe(v, data.get("subscription") or {}, request.headers.get("user-agent", ""))
    from . import consents
    if not consents.has(v, "notifications"):
        consents.record(v, "notifications", True, request)
    if data.get("hello"):
        push(v, {"title": "Уведомления включены ✨", "body": "Теперь вы не пропустите сообщения и заявки в друзья.",
                 "url": "/settings?tab=notify", "tag": "hello"}, "social")
    return JSONResponse({"ok": True}, status_code=201)


@auth()
async def api_unsubscribe(request: Request):
    v = request.state.user["id"]
    db.run("DELETE FROM push_subs WHERE user_id=? AND endpoint=?", (v, str((await body(request)).get("endpoint") or "")))
    if not has_subs(v):
        from . import consents
        consents.record(v, "notifications", False, request)
    return JSONResponse({"ok": True})


@auth()
async def api_prefs(request: Request):
    v = request.state.user["id"]
    data = await body(request)
    d = _device(v, str(data.get("endpoint") or ""))
    if not d:
        raise ApiError(404, "Это устройство не подписано на уведомления")
    for col in ("notify_messages", "notify_social"):
        if col in data:
            db.run(f"UPDATE push_subs SET {col}=? WHERE id=?", (1 if data[col] else 0, d["id"]))
    return JSONResponse({"ok": True})


@auth()
async def api_test(request: Request):
    limit(request, "write")
    v = request.state.user["id"]
    d = _device(v, str((await body(request)).get("endpoint") or ""))
    if not d:
        raise ApiError(404, "Это устройство не подписано на уведомления")
    import asyncio
    code = await asyncio.get_running_loop().run_in_executor(None, send_one, d, {
        "title": "Проверка уведомлений 🔔", "body": "Всё работает! Так будут выглядеть уведомления KRUG.", "url": "/settings?tab=notify", "tag": "test"})
    if code in (404, 410):
        db.run("DELETE FROM push_subs WHERE id=?", (d["id"],))
        raise ApiError(410, "Подписка устарела — включите уведомления заново", "push_gone")
    if not code or code >= 400:
        raise ApiError(502, "Служба уведомлений браузера не ответила — попробуйте ещё раз")
    return JSONResponse({"ok": True})


routes = [
    Route("/api/push", api_state, methods=["GET"]),
    Route("/api/push", api_prefs, methods=["PATCH"]),
    Route("/api/push/subscribe", api_subscribe, methods=["POST"]),
    Route("/api/push/unsubscribe", api_unsubscribe, methods=["POST"]),
    Route("/api/push/test", api_test, methods=["POST"]),
]
