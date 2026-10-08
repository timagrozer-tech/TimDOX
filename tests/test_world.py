"""Мир QEVI: заселение, тик, задания и репутация, дружба с персонажем — без нейросети."""
import unittest

from starlette.testclient import TestClient

from test_api import Client  # noqa: F401 — настраивает окружение и тестовую базу
from app import db
from app.main import app
from app.security import rate_limiter
from app.world import core, engine, quests


class WorldTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.ctx = TestClient(app).__enter__()
        engine.setup()
        engine.ENABLED = True
        cls.u = Client().register("mirtest", "Мир Тест")
        cls.uid = db.value("SELECT user_id FROM profiles WHERE username='mirtest'")

    def setUp(self):
        rate_limiter.reset()

    def test_seed_and_tick_publish(self):
        self.assertGreaterEqual(db.value("SELECT count(*) FROM ai_personas"), 15)
        engine.tick()
        db.run("UPDATE ai_queue SET run_at=? WHERE status='pending'", (db.future(minutes=-1),))
        engine.publish_due(500)
        n = db.value("SELECT count(*) FROM posts WHERE author_id IN (SELECT user_id FROM ai_personas)")
        self.assertGreater(n, 0, "персонажи должны публиковать записи")
        data = self.u.get("/api/world").json()
        self.assertTrue(data["ready"])
        self.assertEqual(len(data["orgs"]), 7)
        self.assertTrue(any(q["title"] == "Летописец" for q in data["quests"]))

    def test_quest_gives_reputation(self):
        r = self.u.c.post("/api/posts", data={"text": "Моя первая запись #летописькруга"}, headers=self.u._h())
        self.assertEqual(r.status_code, 201, r.text)
        quests.check(self.uid, force=True)
        org = core.orgs()["archivists"]
        self.assertGreaterEqual(quests.rep(self.uid, org["id"]), 15)
        done = self.u.get("/api/world").json()["quests"]
        self.assertTrue(any(q["done"] and q["title"] == "Летописец" for q in done))

    def test_persona_accepts_friendship(self):
        vega = core.personas()["kapitan_vega"]["user_id"]
        self.u.post(f"/api/people/{vega}/friend")
        db.run("UPDATE ai_queue SET run_at=? WHERE kind='accept_friend'", (db.future(minutes=-1),))
        engine.publish_due(50)
        st = db.value("SELECT status FROM friendships WHERE requester_id=? AND addressee_id=?", (self.uid, vega))
        self.assertEqual(st, "accepted")
        card = self.u.get("/api/users/kapitan_vega").json()["user"]
        self.assertTrue(card["ai"])


if __name__ == "__main__":
    unittest.main()
