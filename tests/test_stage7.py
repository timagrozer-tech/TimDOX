"""Большое обновление: защита входа, приватность, мероприятия, удаление аккаунта, список диалогов."""
import unittest

from starlette.testclient import TestClient

from test_api import Client  # noqa: F401 — настраивает окружение и тестовую базу
from test_stage2 import make_friends
from app import db
from app.main import app
from app.security import rate_limiter


class Stage7Test(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.ctx = TestClient(app).__enter__()
        cls.a = Client().register("vera7", "Вера Семь", city="Тверь")
        cls.b = Client().register("gleb7", "Глеб Семь")
        cls.c = Client().register("nina7", "Нина Семь")
        make_friends(cls.a, cls.b)

    def setUp(self):
        rate_limiter.reset()

    def test_login_lockout_per_account_ignores_forwarded_ip(self):
        anon = Client()
        codes = []
        for i in range(12):
            r = anon.c.post("/api/auth/login", json={"email": "vera7", "password": "wrong-pass1"},
                            headers={"X-Forwarded-For": f"10.0.0.{i}"})
            codes.append(r.status_code)
        self.assertIn(429, codes, "подмена IP не должна обходить лимит неудачных входов в аккаунт")

    def test_private_profile_city_hidden_from_strangers(self):
        self.a.patch("/api/me/settings", {"profile_visibility": "friends"})
        try:
            people = self.c.get("/api/search", params={"q": "Тверь", "type": "people"}).json()["people"]
            self.assertFalse(any(p["username"] == "vera7" for p in people), "закрытый профиль нашёлся по городу")
            people = self.c.get("/api/search", params={"q": "Вера", "type": "people"}).json()["people"]
            me = next(p for p in people if p["username"] == "vera7")
            self.assertEqual(me["city"], "")
            friend_view = self.b.get("/api/search", params={"q": "Тверь", "type": "people"}).json()["people"]
            self.assertTrue(any(p["username"] == "vera7" and p["city"] == "Тверь" for p in friend_view))
        finally:
            self.a.patch("/api/me/settings", {"profile_visibility": "public"})

    def test_event_invite_cannot_expose_friends_only_event(self):
        # Вера создаёт мероприятие «для друзей»; Глеб (друг) не может пригласить Нину, которая с Верой не дружит
        make_friends(self.b, self.c)
        ev = self.a.post("/api/events", data={"title": "Только свои", "starts_at": "2030-01-01T10:00:00Z", "visibility": "friends"})
        self.assertEqual(ev.status_code, 201, ev.text)
        eid = ev.json()["id"]
        r = self.b.post(f"/api/events/{eid}/invite", {"user_ids": [self.c.refresh()["user"]["id"], "x"]})
        self.assertEqual(r.json()["invited"], 0)
        self.assertEqual(self.c.get(f"/api/events/{eid}").status_code, 404)
        # правка: окончание раньше начала — ошибка
        bad = self.a.patch(f"/api/events/{eid}", {"ends_at": "2029-01-01T10:00:00Z"})
        self.assertEqual(bad.status_code, 422)

    def test_conversation_list_and_account_deletion_keeps_partner_history(self):
        x = Client().register("temp7", "Временный Семь")
        make_friends(x, self.b)
        bid = self.b.refresh()["user"]["id"]
        conv = x.post("/api/conversations", {"user_id": bid}).json()
        x.post(f"/api/conversations/{conv['id']}/messages", {"text": "Привет перед уходом"})
        items = self.b.get("/api/conversations").json()["items"]
        mine = next(i for i in items if i["id"] == conv["id"])
        self.assertEqual(mine["unread"], 1)
        self.assertEqual(mine["user"]["username"], "temp7")
        self.assertEqual(x.delete("/api/me", {"password": "secret123"}).status_code, 200)
        items = self.b.get("/api/conversations").json()["items"]
        self.assertTrue(any(i["id"] == conv["id"] for i in items), "переписка собеседника пропала после удаления аккаунта")

    def test_bad_numbers_give_400_not_500(self):
        r = self.a.get("/api/feed", params={"cursor": "abc"})
        self.assertLess(r.status_code, 500)


if __name__ == "__main__":
    unittest.main()
