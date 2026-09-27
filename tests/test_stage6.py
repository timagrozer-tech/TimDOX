"""Опросы и статус-настроение."""
import json
import unittest

from starlette.testclient import TestClient

from test_api import Client  # noqa: F401 — настраивает окружение и тестовую базу
from test_stage2 import make_friends
from app import db
from app.main import app
from app.security import rate_limiter


class Stage6Test(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.ctx = TestClient(app).__enter__()
        cls.a = Client().register("polina6", "Полина Опрос")
        cls.b = Client().register("stas6", "Стас Голос")
        make_friends(cls.a, cls.b)

    def setUp(self):
        rate_limiter.reset()

    def test_poll(self):
        bad = self.a.post("/api/posts", data={"text": "?", "poll": json.dumps({"options": ["Один"]})})
        self.assertEqual(bad.status_code, 400)
        r = self.a.post("/api/posts", data={"text": "Куда идём в субботу?", "visibility": "public",
                                            "poll": json.dumps({"options": ["Кино", "Боулинг", "Кино", " "], "days": 3})})
        self.assertEqual(r.status_code, 201, r.text)
        poll = r.json()["poll"]
        self.assertEqual(poll["question"], "Куда идём в субботу?")
        self.assertEqual([o["text"] for o in poll["options"]], ["Кино", "Боулинг"])
        self.assertFalse(poll["closed"])
        o1, o2 = poll["options"][0]["id"], poll["options"][1]["id"]
        self.assertEqual(self.b.post(f"/api/polls/{poll['id']}/vote", {"option_ids": [o1, o2]}).status_code, 400)
        v = self.b.post(f"/api/polls/{poll['id']}/vote", {"option_ids": [o2]}).json()
        self.assertEqual((v["voted"], v["voters"], v["options"][1]["votes"]), ([o2], 1, 1))
        v = self.b.post(f"/api/polls/{poll['id']}/vote", {"option_ids": []}).json()  # отзыв голоса
        self.assertEqual(v["voters"], 0)
        feed_poll = self.b.get("/api/feed").json()["items"][0]["poll"]
        self.assertEqual(feed_poll["id"], poll["id"])
        db.run("UPDATE polls SET closes_at=? WHERE id=?", (db.future(hours=-1), poll["id"]))
        self.assertEqual(self.b.post(f"/api/polls/{poll['id']}/vote", {"option_ids": [o1]}).status_code, 400)

    def test_status(self):
        self.assertEqual(self.a.patch("/api/me/status", {}).status_code, 400)
        r = self.a.patch("/api/me/status", {"emoji": "🏖", "text": "В отпуске до понедельника", "hours": 24}).json()
        self.assertEqual(r["status"]["emoji"], "🏖")
        prof = self.b.get("/api/users/polina6").json()
        self.assertEqual(prof["user"]["status"]["text"], "В отпуске до понедельника")
        db.run("UPDATE profiles SET status_until=? WHERE username='polina6'", (db.future(hours=-1),))
        self.assertIsNone(self.b.get("/api/users/polina6").json()["user"]["status"])  # истёк
        self.a.patch("/api/me/status", {"emoji": "💼"})
        self.assertEqual(self.b.get("/api/users/polina6").json()["user"]["status"]["emoji"], "💼")
        self.a.delete("/api/me/status")
        self.assertIsNone(self.b.get("/api/users/polina6").json()["user"]["status"])


if __name__ == "__main__":
    unittest.main()
