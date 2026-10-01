"""Мультиаккаунт и онбординг 2.0."""
import unittest

from test_api import Client
from app.security import rate_limiter


class AccountsTest(unittest.TestCase):
    def setUp(self):
        rate_limiter.reset()

    def test_add_switch_logout(self):
        Client().register("acc_one", "Аккаунт Один")
        Client().register("acc_two", "Аккаунт Два")
        Client().register("acc_three", "Аккаунт Три")
        c = Client()
        self.assertEqual(c.post("/api/auth/login", {"email": "acc_one", "password": "secret123"}).status_code, 200)
        c.refresh()
        r = c.post("/api/auth/login", {"email": "acc_two", "password": "secret123", "add": True})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(c.refresh()["user"]["username"], "acc_two")
        c.post("/api/auth/login", {"email": "acc_three", "password": "secret123", "add": True})
        me = c.refresh()
        self.assertEqual(me["user"]["username"], "acc_three")
        items = c.get("/api/accounts").json()["items"]
        self.assertEqual([i["user"]["username"] for i in items], ["acc_three", "acc_two", "acc_one"])
        self.assertTrue(items[0]["active"])
        # переключение без пароля
        slot = next(i["slot"] for i in items if i["user"]["username"] == "acc_one")
        self.assertEqual(c.post("/api/accounts/switch", {"slot": slot}).status_code, 200)
        self.assertEqual(c.refresh()["user"]["username"], "acc_one")
        self.assertEqual(len(c.get("/api/accounts").json()["items"]), 3)
        # повторный вход в уже добавленный аккаунт не дублирует его
        c.post("/api/auth/login", {"email": "acc_two", "password": "secret123", "add": True})
        c.refresh()
        self.assertEqual(sorted(i["user"]["username"] for i in c.get("/api/accounts").json()["items"]), ["acc_one", "acc_three", "acc_two"])
        # выход из активного переключает на следующий аккаунт
        r = c.post("/api/auth/logout")
        self.assertTrue(r.json().get("switched"))
        self.assertIsNotNone(c.refresh()["user"])
        # выход из неактивного аккаунта
        items = c.get("/api/accounts").json()["items"]
        self.assertEqual(c.delete(f"/api/accounts/{items[1]['slot']}").status_code, 200)
        self.assertEqual(len(c.get("/api/accounts").json()["items"]), 1)
        c.post("/api/auth/logout")
        self.assertIsNone(c.refresh()["user"])

    def test_onboarding(self):
        c = Client().register("onb_user", "Онбординг Тест")
        self.assertFalse(c.get("/api/onboarding").json()["done"])
        d = c.post("/api/onboarding", {"style": "future", "tour": "feed"}).json()
        self.assertEqual(d["style"], "future")
        self.assertEqual(d["tours"], ["feed"])
        d = c.post("/api/onboarding", {"style": "nope", "tour": "hack", "done": True}).json()
        self.assertEqual(d["style"], "future")
        self.assertEqual(d["tours"], ["feed"])
        self.assertTrue(d["done"])
        self.assertEqual(c.post("/api/onboarding", {"reset_tours": True}).json()["tours"], [])


if __name__ == "__main__":
    unittest.main()
