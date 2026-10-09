"""Ретрансляторы звонков: настройки создателя (секреты не уходят в браузер) и выдача в iceServers."""
import json
import unittest
from unittest import mock

from test_api import Client  # noqa: F401
from app import db, turn
from app.security import rate_limiter


class TurnTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.admin = Client().register("turnadmin", "Админ Звонков")
        db.run("UPDATE users SET is_admin=1 WHERE id=(SELECT user_id FROM profiles WHERE username='turnadmin')")
        cls.user = Client().register("turnuser", "Обычный")

    def setUp(self):
        rate_limiter.reset()
        db.run("DELETE FROM app_secrets WHERE name='turn_config'")

    def test_admin_only_and_no_secret_leak(self):
        self.assertEqual(self.user.get("/api/admin/calls").status_code, 403)
        with mock.patch("app.turncheck.check_all", lambda s: [("turn:x:3478?transport=tcp", "ok")]), \
                mock.patch.object(turn, "_cloudflare", lambda cf: [{"urls": ["turn:turn.cloudflare.com:3478"], "username": "u", "credential": "c"}] if cf else []):
            r = self.admin.put("/api/admin/calls", {"cloudflare": {"key_id": "abcdef1234567890abcdef", "token": "SECRET-TOKEN-123"},
                                                   "custom": {"urls": ["turn:relay.example:3478"], "username": "me", "credential": "pw"}})
            self.assertEqual(r.status_code, 200, r.text)
            d = r.json()
            self.assertTrue(d["cloudflare"]["configured"])
            self.assertNotIn("SECRET-TOKEN-123", r.text)
            self.assertNotIn('"pw"', r.text)
            self.assertEqual(d["checks"][0]["result"], "ok")
            ice = self.user.get("/api/calls/ice").json()
            urls = json.dumps(ice)
            self.assertIn("turn.cloudflare.com", urls)
            self.assertIn("relay.example", urls)
        self.assertNotIn("SECRET-TOKEN-123", db.value("SELECT value FROM app_secrets WHERE name='turn_config'"), "хранится зашифрованным")
        bad = self.admin.put("/api/admin/calls", {"custom": {"urls": ["http://evil"]}})
        self.assertEqual(bad.status_code, 400)
