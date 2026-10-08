"""Режим REALTIME=db: события через базу и короткий опрос (обычный хостинг с несколькими процессами)."""
import unittest
from unittest import mock

from test_api import Client  # noqa: F401 — настраивает окружение и тестовую базу
from app import db, realtime
from app.api import messages
from app.security import rate_limiter


class PollTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.a = Client().register("pollanna", "Анна Опрос")
        cls.b = Client().register("pollboris", "Борис Опрос")
        cls.aid = cls.a.refresh()["user"]["id"]
        cls.bid = cls.b.refresh()["user"]["id"]

    def setUp(self):
        rate_limiter.reset()
        db.run("DELETE FROM rt_events")
        db.run("DELETE FROM rt_online")
        self.hub = realtime.DbHub()
        self.p = [mock.patch.object(realtime, "POLLING", True), mock.patch.object(messages, "hub", self.hub)]
        for p in self.p:
            p.start()

    def tearDown(self):
        for p in self.p:
            p.stop()

    def test_events_and_cursor(self):
        first = self.a.get("/api/poll").json()
        self.assertEqual(first["events"], [])
        self.assertTrue(self.hub.is_online(self.aid))
        self.hub.publish(self.aid, "notification", {"x": 1})
        self.hub.publish_many([self.aid, self.bid], "counters", {"messages": 2})
        d = self.a.get("/api/poll", params={"after": first["cursor"]}).json()
        self.assertEqual([e["event"] for e in d["events"]], ["notification", "counters"])
        self.assertEqual(d["events"][0]["data"], {"x": 1})
        again = self.a.get("/api/poll", params={"after": d["cursor"]}).json()
        self.assertEqual(again["events"], [], "события не повторяются")
        self.assertEqual(again["cursor"], d["cursor"])
        self.assertEqual(Client().get("/api/poll").status_code, 401)

    def test_typing_only_for_online(self):
        self.hub.publish(self.bid, "typing", {"conversation_id": 1})
        self.assertEqual(db.value("SELECT count(*) FROM rt_events WHERE user_id=?", (self.bid,)), 0)
        self.b.get("/api/poll")
        self.hub._online_cache = (0.0, set())
        self.hub.publish(self.bid, "typing", {"conversation_id": 1})
        self.assertEqual(db.value("SELECT count(*) FROM rt_events WHERE user_id=?", (self.bid,)), 1)

    def test_offline_sweep(self):
        self.a.get("/api/poll")
        db.run("UPDATE rt_online SET seen_at='2000-01-01T00:00:00.000Z'")
        self.hub._online_cache = (0.0, set())
        self.assertFalse(self.hub.is_online(self.aid))
        self.hub.sweep(force=True)
        self.assertIsNone(db.value("SELECT 1 FROM rt_online WHERE user_id=?", (self.aid,)))

    def test_me_reports_mode(self):
        with mock.patch("app.api.auth_routes.POLLING", True):
            self.assertEqual(self.a.get("/api/auth/me").json()["realtime"], "poll")
        self.assertEqual(self.a.get("/api/auth/me").json()["realtime"], "sse")

    def test_poll_disabled_in_memory_mode(self):
        with mock.patch.object(realtime, "POLLING", False):
            self.assertEqual(self.a.get("/api/poll").status_code, 404)
