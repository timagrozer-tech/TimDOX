"""Звонки: начало, приглашение, сигналинг между участниками, отказ, завершение."""
import json
import unittest

from test_api import Client
from app.realtime import hub
from app.security import rate_limiter


def drain(q):
    out = []
    while not q.empty():
        ev, payload = q.get_nowait()
        out.append((ev, json.loads(payload)))
    return out


class CallsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        rate_limiter.reset()
        cls.a = Client().register("call_anna", "Анна Звонок")
        cls.b = Client().register("call_boris", "Борис Звонок")
        cls.x = Client().register("call_stranger", "Чужой Звонок")
        cls.aid = cls.a.refresh()["user"]["id"]
        cls.bid = cls.b.refresh()["user"]["id"]
        cls.conv = cls.a.post("/api/conversations", {"user_id": cls.bid}).json()["id"]

    def setUp(self):
        rate_limiter.reset()

    def test_call_flow(self):
        qb, _ = hub.subscribe(self.bid)
        qa, _ = hub.subscribe(self.aid)
        try:
            r = self.a.post("/api/calls", {"conversation_id": self.conv, "video": True})
            self.assertEqual(r.status_code, 201, r.text)
            call = r.json()["call"]
            self.assertTrue(r.json()["ice_servers"])
            ev = drain(qb)
            self.assertEqual(ev[-1][0], "call_invite")
            self.assertTrue(ev[-1][1]["video"])
            # посторонний не видит звонок и не может подключиться
            self.assertEqual(self.x.post(f"/api/calls/{call['id']}/join").status_code, 404)
            j = self.b.post(f"/api/calls/{call['id']}/join").json()
            self.assertEqual(j["peers"], [self.aid])
            self.assertEqual(drain(qa)[-1][0], "call_join")
            # сигнал адресно
            self.assertEqual(self.b.post(f"/api/calls/{call['id']}/signal", {"to": self.aid, "type": "offer", "data": {"sdp": "v=0"}}).status_code, 200)
            ev = drain(qa)[-1]
            self.assertEqual(ev[0], "call_signal")
            self.assertEqual((ev[1]["from"], ev[1]["type"]), (self.bid, "offer"))
            self.assertEqual(self.b.post(f"/api/calls/{call['id']}/signal", {"type": "evil"}).status_code, 400)
            # повторный старт в том же диалоге возвращает тот же звонок
            self.assertEqual(self.b.post("/api/calls", {"conversation_id": self.conv}).json()["call"]["id"], call["id"])
            # выход одного из двоих завершает звонок
            self.assertEqual(self.a.post(f"/api/calls/{call['id']}/leave").status_code, 200)
            self.assertIn("call_end", [e for e, _ in drain(qb)])
            self.assertEqual(self.b.post(f"/api/calls/{call['id']}/join").status_code, 410)
            hist = self.a.get("/api/calls/history").json()["items"]
            self.assertEqual(hist[0]["id"], call["id"])
        finally:
            hub.unsubscribe(self.bid, qb)
            hub.unsubscribe(self.aid, qa)

    def test_decline(self):
        call = self.a.post("/api/calls", {"conversation_id": self.conv}).json()["call"]
        self.assertEqual(self.b.post(f"/api/calls/{call['id']}/decline").status_code, 200)
        self.assertIsNotNone(self.a.get("/api/calls/history").json()["items"][0]["ended_at"])
        self.assertEqual(self.x.post("/api/calls", {"conversation_id": self.conv}).status_code, 404)


if __name__ == "__main__":
    unittest.main()
