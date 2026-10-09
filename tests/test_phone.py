"""Регистрация по номеру телефона, почта — резервная; вход по номеру; восстановление через резервную почту."""
import unittest

from starlette.testclient import TestClient

from test_api import Client  # noqa: F401 — настраивает окружение и тестовую базу
from app import db, phones
from app.main import app
from app.security import rate_limiter


class PhoneTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.ctx = TestClient(app).__enter__()

    def setUp(self):
        rate_limiter.reset()

    def test_normalize(self):
        for raw in ("8 (912) 345-67-89", "+7 912 345 67 89", "9123456789", "7-912-345-67-89"):
            self.assertEqual(phones.normalize(raw), "+79123456789", raw)
        self.assertEqual(phones.normalize("+375 29 123-45-67"), "+375291234567")
        for bad in ("", "12345", "+7 912 345", "abc", "8 800"):
            self.assertIsNone(phones.normalize(bad), bad)

    def _reg(self, c, **kw):
        data = {"password": "secret123", "name": "Телефон Тест", "consent": True, **kw}
        return c.post("/api/auth/register", data)

    def test_phone_only_then_login_by_phone(self):
        c = Client()
        r = self._reg(c, username="phone_only", phone="8 (900) 111-22-33")
        self.assertEqual(r.status_code, 201, r.text)
        me = c.refresh()["user"]
        self.assertEqual((me["phone"], me["email"]), ("+79001112233", ""))  # технический адрес не показывается
        # тот же номер второй раз не зарегистрировать
        r2 = self._reg(Client(), username="phone_dup", phone="+7 900 111 22 33")
        self.assertEqual(r2.status_code, 422)
        self.assertIn("phone", r2.json()["fields"])
        # вход по номеру в любом написании
        for login in ("+79001112233", "89001112233", "9001112233"):
            l = Client()
            self.assertEqual(l.post("/api/auth/login", {"email": login, "password": "secret123"}).status_code, 200, login)
        self.assertEqual(Client().post("/api/auth/login", {"email": "9001112233", "password": "wrong-pass"}).status_code, 400)

    def test_phone_required_and_backup_email(self):
        no_phone = self._reg(Client(), username="no_phone", email="np@example.com")
        self.assertEqual(no_phone.status_code, 422)
        self.assertIn("phone", no_phone.json()["fields"])
        c = Client()
        self.assertEqual(self._reg(c, username="with_backup", phone="+79005556677", email="Backup@Example.com").status_code, 201)
        me = c.refresh()["user"]
        self.assertEqual((me["phone"], me["email"]), ("+79005556677", "backup@example.com"))
        # «Забыли пароль» по номеру — письмо уходит на резервную почту (ответ одинаковый в любом случае)
        self.assertEqual(Client().post("/api/auth/forgot", {"email": "+7 900 555 66 77"}).status_code, 200)
        uid = db.value("SELECT id FROM users WHERE phone='+79005556677'")
        self.assertTrue(db.value("SELECT 1 FROM email_tokens WHERE user_id=? AND kind='reset'", (uid,)))

    def test_change_phone_in_settings(self):
        c = Client().register("phone_change", "Смена Номера")
        bad = c.post("/api/me/phone", {"phone": "+79007778899", "password": "wrong"})
        self.assertEqual(bad.status_code, 422)
        r = c.post("/api/me/phone", {"phone": "8 900 777 88 99", "password": "secret123"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(c.refresh()["user"]["phone"], "+79007778899")
        self.assertEqual(c.get("/api/me/settings").json()["phone"], "+79007778899")


if __name__ == "__main__":
    unittest.main()
