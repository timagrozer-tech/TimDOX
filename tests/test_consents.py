"""Согласия: регистрация с отдельными согласиями, ИИ-функции только с согласия, журнал версий, уведомления."""
import unittest

from test_api import Client
from app import consents, db
from app.security import rate_limiter


class ConsentsTest(unittest.TestCase):
    def setUp(self):
        rate_limiter.reset()

    def test_register_and_toggle(self):
        c = Client().register("cons_user", "Согласный Человек")
        uid = c.refresh()["user"]["id"]
        st = c.get("/api/consents").json()
        self.assertTrue(all(st["items"][k]["granted"] for k in ("pd", "terms", "content")))
        self.assertEqual(st["items"]["pd"]["version"], consents.LEGAL_VERSION)
        self.assertFalse(st["review"])
        self.assertFalse(consents.has(uid, "ai"))
        # ИИ: включить и отозвать; ПДн из настроек не отзывается (только удалением аккаунта)
        c.post("/api/consents", {"kind": "ai", "granted": True})
        self.assertTrue(consents.has(uid, "ai"))
        c.post("/api/consents", {"kind": "ai", "granted": False})
        self.assertFalse(consents.has(uid, "ai"))
        self.assertEqual(c.post("/api/consents", {"kind": "pd", "granted": False}).status_code, 400)
        hist = c.get("/api/consents/history").json()["items"]
        self.assertEqual([h["granted"] for h in hist if h["kind"] == "ai"], [False, True])

    def test_legacy_and_review(self):
        c = Client().register("cons_legacy", "Давний Пользователь")
        uid = c.refresh()["user"]["id"]
        db.run("DELETE FROM consents WHERE user_id=?", (uid,))  # как будто зарегистрировался до журнала согласий
        st = c.get("/api/consents").json()
        self.assertEqual((st["items"]["pd"]["granted"], st["items"]["pd"]["version"]), (True, "прежняя"))
        self.assertTrue(st["review"])
        st = c.post("/api/consents", {"accept_documents": True}).json()
        self.assertFalse(st["review"])

    def test_register_requires_terms(self):
        r = Client().c.post("/api/auth/register", json={"name": "Без Соглашения", "username": "cons_noterms", "email": "noterms@example.com",
                                                         "password": "Strong-pass-2026", "consent": True, "terms": False})
        self.assertEqual(r.status_code, 422)
        self.assertIn("terms", r.json()["fields"])


if __name__ == "__main__":
    unittest.main()
