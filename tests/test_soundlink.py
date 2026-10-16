"""«Звуковое рукопожатие»: код человека и его распознавание."""
import unittest

from starlette.testclient import TestClient

from test_api import Client  # noqa: F401 — настраивает окружение и тестовую базу
from app.main import app
from app.api import soundlink
from app.security import rate_limiter


class SoundlinkTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.ctx = TestClient(app).__enter__()
        cls.a = Client().register("snd_alice", "Звук Алиса")
        cls.b = Client().register("snd_bob", "Звук Боб")
        cls.a_id = cls.a.refresh()["user"]["id"]

    def setUp(self):
        rate_limiter.reset()

    def test_code_roundtrip(self):
        code = self.a.get("/api/soundlink/me").json()["code"]
        self.assertTrue(0 <= code < 2 ** 32)
        r = self.b.get(f"/api/soundlink/{code}").json()
        self.assertEqual(r["user"]["username"], "snd_alice")
        self.assertEqual(r["relation"]["status"], "none")
        self.assertFalse(r["self"])
        self.assertTrue(self.a.get(f"/api/soundlink/{code}").json()["self"])

    def test_wrong_or_old_code(self):
        code = soundlink.code_for(self.a_id)
        self.assertEqual(self.b.get(f"/api/soundlink/{code ^ 1}").status_code, 404)  # испорченная подпись
        old = soundlink.code_for(self.a_id, now=1_000_000)
        self.assertEqual(self.b.get(f"/api/soundlink/{old}").status_code, 404)  # давно устаревший
        self.assertIsNone(soundlink.uid_of(code, now=__import__("time").time() + 3 * soundlink.WINDOW))

    def test_blocked(self):
        code = soundlink.code_for(self.a_id)
        bid = self.b.refresh()["user"]["id"]
        self.a.post(f"/api/people/{bid}/block")
        self.assertEqual(self.b.get(f"/api/soundlink/{code}").status_code, 404)
        self.a.delete(f"/api/people/{bid}/block")


if __name__ == "__main__":
    unittest.main()
