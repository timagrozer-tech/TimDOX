"""Этап 2: двухфакторная защита, журнал входов, сеансы, антибот при регистрации, антиспам в переписке."""
import time
import unittest

from test_api import Client
from app import db, qr, twofa
from app.security import LIMITS, rate_limiter


def _code_now(secret: str) -> str:
    return twofa.code_at(secret.replace(" ", ""), int(time.time() // 30))


class TotpUnitTest(unittest.TestCase):
    def test_rfc6238_vector(self):
        secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"  # «12345678901234567890»
        self.assertEqual(twofa.code_at(secret, 59 // 30), "287082")
        self.assertEqual(twofa.code_at(secret, 1111111109 // 30), "081804")
        self.assertEqual(twofa.verify(secret, "287082", None, now=59), 1)
        self.assertIsNone(twofa.verify(secret, "287082", 1, now=59), "тот же код дважды не принимается")

    def test_encryption_roundtrip(self):
        enc = twofa.encrypt("JBSWY3DPEHPK3PXP")
        self.assertNotIn("JBSWY3DP", enc)
        self.assertEqual(twofa.decrypt(enc), "JBSWY3DPEHPK3PXP")
        with self.assertRaises(ValueError):
            twofa.decrypt(enc[:-4] + "AAAA")

    def test_qr_svg(self):
        self.assertTrue(qr.svg("otpauth://totp/x?secret=ABC").startswith("<svg"))


class TwoFactorFlowTest(unittest.TestCase):
    def setUp(self):
        rate_limiter.reset()

    def test_enable_login_disable(self):
        c = Client().register("tfa_user", "Двух Факторов")
        self.assertFalse(c.get("/api/security/2fa").json()["enabled"])
        self.assertEqual(c.post("/api/security/2fa/setup", {"password": "wrong123"}).status_code, 400)
        s = c.post("/api/security/2fa/setup", {"password": "secret123"}).json()
        self.assertTrue(s["qr"].startswith("data:image/svg+xml;base64,"))
        self.assertEqual(c.post("/api/security/2fa/enable", {"code": "000000"}).status_code, 400)
        r = c.post("/api/security/2fa/enable", {"code": _code_now(s["secret"])})
        self.assertEqual(r.status_code, 200, r.text)
        backup = r.json()["backup_codes"]
        self.assertEqual(len(backup), 10)
        self.assertEqual(c.get("/api/security/2fa").json(), {"enabled": True, "backup_left": 10})

        # вход: пароль даёт только билет, сеанса ещё нет
        x = Client()
        r = x.post("/api/auth/login", {"email": "tfa_user", "password": "secret123"})
        self.assertTrue(r.json()["mfa_required"])
        ticket = r.json()["ticket"]
        self.assertIsNone(x.refresh()["user"])
        self.assertEqual(x.post("/api/auth/2fa", {"ticket": ticket, "code": "123456"}).status_code, 400)
        # резервный код работает один раз
        self.assertEqual(x.post("/api/auth/2fa", {"ticket": ticket, "code": backup[0].lower()}).status_code, 200)
        self.assertEqual(x.refresh()["user"]["username"], "tfa_user")
        y = Client()
        t2 = y.post("/api/auth/login", {"email": "tfa_user", "password": "secret123"}).json()["ticket"]
        self.assertEqual(y.post("/api/auth/2fa", {"ticket": t2, "code": backup[0]}).status_code, 400)
        self.assertEqual(c.get("/api/security/2fa").json()["backup_left"], 9)

        # журнал входов видит неудачи и успехи
        items = c.get("/api/security/logins").json()["items"]
        self.assertTrue(any(not i["ok"] and i["reason"] == "неверный код 2FA" for i in items))
        self.assertTrue(any(i["ok"] and "резервный" in i["method"] for i in items))

        # восстановление пароля по письму не обходит 2FA
        from app.api.auth_routes import new_token
        from app.security import token_hash
        uid = c.refresh()["user"]["id"]
        tok = new_token()
        db.run("INSERT INTO email_tokens (id, user_id, kind, expires_at) VALUES (?,?,?,?)", (token_hash(tok), uid, "reset", db.future(hours=1)))
        z = Client()
        r = z.post("/api/auth/reset", {"token": tok, "password": "newpass123"})
        self.assertTrue(r.json().get("need_login"))
        self.assertIsNone(z.refresh()["user"])

        # отключение требует пароль и код
        c = Client()
        t3 = c.post("/api/auth/login", {"email": "tfa_user", "password": "newpass123"}).json()["ticket"]
        self.assertEqual(c.post("/api/auth/2fa", {"ticket": t3, "code": backup[1]}).status_code, 200)
        c.refresh()
        self.assertEqual(c.post("/api/security/2fa/disable", {"password": "newpass123", "code": "000000"}).status_code, 400)
        self.assertEqual(c.post("/api/security/2fa/disable", {"password": "newpass123", "code": backup[2]}).status_code, 200)
        self.assertEqual(Client().post("/api/auth/login", {"email": "tfa_user", "password": "newpass123"}).json(), {"ok": True})

    def test_ticket_attempts_limited(self):
        c = Client().register("tfa_brute", "Брут Форс")
        s = c.post("/api/security/2fa/setup", {"password": "secret123"}).json()
        c.post("/api/security/2fa/enable", {"code": _code_now(s["secret"])})
        x = Client()
        ticket = x.post("/api/auth/login", {"email": "tfa_brute", "password": "secret123"}).json()["ticket"]
        for _ in range(5):
            rate_limiter.reset()
            x.post("/api/auth/2fa", {"ticket": ticket, "code": "111111"})
        rate_limiter.reset()
        r = x.post("/api/auth/2fa", {"ticket": ticket, "code": _code_now(s["secret"])})
        self.assertEqual(r.json().get("code"), "mfa_expired", "после 5 ошибок билет сгорает")

    def test_sessions_show_activity(self):
        c = Client().register("tfa_sess", "Сеансы Тест")
        items = c.get("/api/me/sessions").json()["items"]
        self.assertTrue(items[0]["current"])
        self.assertIn("last_seen_at", items[0])


class AntibotTest(unittest.TestCase):
    def setUp(self):
        rate_limiter.reset()

    def _reg(self, **extra):
        data = {"email": f"bot{time.time_ns()}@example.com", "password": "secret123", "name": "Бот Ботов",
                "username": f"b{time.time_ns() % 10**12}", "consent": True, **extra}
        return Client().post("/api/auth/register", data)

    def test_honeypot_and_speed(self):
        self.assertEqual(self._reg(website="http://spam").status_code, 400)
        self.assertEqual(self._reg(t=300).status_code, 429)
        self.assertEqual(self._reg(t=4000).status_code, 201)

    def test_disposable_email(self):
        r = self._reg(email="x1@mailinator.com")
        self.assertEqual(r.status_code, 422)
        self.assertIn("email", r.json()["fields"])

    def test_mass_registration(self):
        saved = LIMITS["register"]
        LIMITS["register"] = (2, 3600)
        try:
            codes = [self._reg().status_code for _ in range(3)]
            self.assertEqual(codes, [201, 201, 429])
        finally:
            LIMITS["register"] = saved

    def test_new_account_dialog_limit(self):
        saved = LIMITS["new_dialogs"]
        LIMITS["new_dialogs"] = (1, 86400)
        try:
            spam = Client().register("spam_dm", "Спам Личка")
            ids = [Client().register(f"dm_target{i}", f"Цель {i}").refresh()["user"]["id"] for i in range(2)]
            self.assertEqual(spam.post("/api/conversations", {"user_id": ids[0]}).status_code, 200)
            self.assertEqual(spam.post("/api/conversations", {"user_id": ids[1]}).status_code, 429)
        finally:
            LIMITS["new_dialogs"] = saved


if __name__ == "__main__":
    unittest.main()
