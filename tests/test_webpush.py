"""Web Push: шифрование RFC 8291 (расшифровываем как браузер), подпись VAPID, подписки и рассылка."""
import json
import os
import struct
import time
import unittest

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from test_api import Client
from app import db, webpush
from app.realtime import hub
from app.security import rate_limiter


def browser_keys():
    k = ec.generate_private_key(ec.SECP256R1())
    pub = k.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    return k, webpush.b64u(pub), webpush.b64u(os.urandom(16))


def browser_decrypt(body: bytes, key, p256dh: str, auth: str) -> bytes:
    """Как это делает браузер: из заголовка — соль и ключ сервера, дальше ECDH + HKDF + AES-GCM."""
    salt, rs, idlen = body[:16], struct.unpack(">I", body[16:20])[0], body[20]
    as_public = body[21:21 + idlen]
    assert rs == 4096
    shared = key.exchange(ec.ECDH(), ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), as_public))
    ua_public = webpush.unb64u(p256dh)
    ikm = webpush._hkdf(webpush.unb64u(auth), shared, b"WebPush: info\x00" + ua_public + as_public, 32)
    cek = webpush._hkdf(salt, ikm, b"Content-Encoding: aes128gcm\x00", 16)
    nonce = webpush._hkdf(salt, ikm, b"Content-Encoding: nonce\x00", 12)
    plain = AESGCM(cek).decrypt(nonce, body[21 + idlen:], None)
    assert plain.endswith(b"\x02")
    return plain[:-1]


class WebPushTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.a = Client().register("push_a", "Пуш Аня")
        cls.b = Client().register("push_b", "Пуш Боря")
        cls.a_id = cls.a.refresh()["user"]["id"]

    def setUp(self):
        rate_limiter.reset()
        webpush._last.clear()
        self.sent = []
        self.orig = (webpush.send_one, webpush.push, hub.is_online)
        hub.is_online = lambda uid: False

    def tearDown(self):
        webpush.send_one, webpush.push, hub.is_online = self.orig

    def test_encrypt_roundtrip_and_vapid(self):
        key, p256dh, auth = browser_keys()
        msg = json.dumps({"title": "Привет", "body": "Проверка 🔔"}, ensure_ascii=False).encode()
        self.assertEqual(browser_decrypt(webpush.encrypt(msg, p256dh, auth), key, p256dh, auth), msg)
        # подпись VAPID проверяется открытым ключом, который отдаёт сервер
        token = webpush._jwt("https://fcm.googleapis.com")
        head, claims, sig = token.split(".")
        self.assertEqual(json.loads(webpush.unb64u(claims))["aud"], "https://fcm.googleapis.com")
        raw = webpush.unb64u(sig)
        pub = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), webpush.unb64u(webpush.public_key()))
        pub.verify(encode_dss_signature(int.from_bytes(raw[:32], "big"), int.from_bytes(raw[32:], "big")),
                   f"{head}.{claims}".encode(), ec.ECDSA(hashes.SHA256()))
        # ключ один и тот же между перезапусками (берётся из базы)
        webpush._vapid.clear()
        self.assertEqual(webpush.public_key(), webpush.b64u(pub.public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)))

    def test_subscribe_prefs_and_delivery(self):
        key, p256dh, auth = browser_keys()
        ep = "https://push.example.test/abc"
        self.assertEqual(self.a.post("/api/push/subscribe", {"subscription": {"endpoint": "http://bad", "keys": {}}}).status_code, 400)
        webpush.push = lambda uid, data, kind="social", urgency="normal": self.sent.append((uid, data, kind))
        r = self.a.post("/api/push/subscribe", {"subscription": {"endpoint": ep, "keys": {"p256dh": p256dh, "auth": auth}}, "hello": True})
        self.assertEqual(r.status_code, 201, r.text)
        self.assertEqual(self.sent[-1][1]["tag"], "hello")
        st = self.a.get("/api/push", params={"endpoint": ep}).json()
        self.assertEqual((st["devices"], st["this"]["notify_messages"]), (1, True))
        # сообщение от Бори → push Ане (её нет на сайте); повтор в тот же чат сразу — не дублируем
        conv = self.b.post("/api/conversations", {"user_id": self.a_id}).json()
        conv_id = conv.get("id") or conv.get("conversation", {}).get("id")
        self.b.post(f"/api/conversations/{conv_id}/messages", {"text": "Привет, Аня!"})
        self.b.post(f"/api/conversations/{conv_id}/messages", {"text": "Ты тут?"})
        msgs = [d for u, d, k in self.sent if k == "message"]
        self.assertEqual(len(msgs), 1)
        self.assertEqual((msgs[0]["title"], msgs[0]["body"], msgs[0]["url"]), ("Пуш Боря", "Привет, Аня!", f"/messages/{conv_id}"))
        # заявка в друзья
        self.b.post(f"/api/people/{self.a_id}/friend", {})
        self.assertIn("в друзья", self.sent[-1][1]["body"])
        # тест-уведомление уходит реальным send_one; «устаревшая» подписка удаляется
        webpush.send_one = lambda sub, data, urgency="normal", ttl=86400: 201
        self.assertEqual(self.a.post("/api/push/test", {"endpoint": ep}).status_code, 200)
        webpush.send_one = lambda sub, data, urgency="normal", ttl=86400: 410
        self.assertEqual(self.a.post("/api/push/test", {"endpoint": ep}).json()["code"], "push_gone")
        self.assertIsNone(self.a.get("/api/push", params={"endpoint": ep}).json()["this"])
        # переключатели
        self.a.post("/api/push/subscribe", {"subscription": {"endpoint": ep, "keys": {"p256dh": p256dh, "auth": auth}}})
        self.a.patch("/api/push", {"endpoint": ep, "notify_messages": False})
        self.assertFalse(self.a.get("/api/push", params={"endpoint": ep}).json()["this"]["notify_messages"])
        # рабочий поток: выключенные сообщения не уходят, социальные — уходят, зашифрованными
        webpush.push = self.orig[1]
        got = []
        webpush.send_one = lambda sub, data, urgency="normal", ttl=86400: got.append((sub["endpoint"], data)) or 201
        webpush.push(self.a_id, {"title": "x", "body": "сообщение"}, "message")
        webpush.push(self.a_id, {"title": "x", "body": "друг"}, "social")
        end = time.time() + 3
        while time.time() < end and not got:
            time.sleep(.05)
        time.sleep(.2)
        self.assertEqual([d["body"] for e, d in got], ["друг"])
        self.a.post("/api/push/unsubscribe", {"endpoint": ep})
        self.assertFalse(db.value("SELECT 1 FROM push_subs WHERE endpoint=?", (ep,)))


if __name__ == "__main__":
    unittest.main()
