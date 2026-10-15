"""«Транслировать аудио в статус»: по желанию человека на его странице видно, что он слушает."""
import unittest

from starlette.testclient import TestClient

from test_api import Client  # noqa: F401 — настраивает окружение и тестовую базу
from test_stage4 import FAKE_MP3
from app import db
from app.main import app
from app.security import rate_limiter


class NowPlayingTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.ctx = TestClient(app).__enter__()
        cls.dj = Client().register("dj_status", "Диджей Статус")
        cls.fan = Client().register("fan_status", "Фан Статус")

    def setUp(self):
        rate_limiter.reset()

    def test_broadcast(self):
        s = self.dj.post("/api/music/songs", data={"title": "Моя песня", "duration": "120"},
                         files=[("audio", ("s.mp3", FAKE_MP3, "audio/mpeg"))]).json()
        # пока трансляция выключена — ничего не сохраняется
        self.assertFalse(self.dj.post("/api/me/now-playing", {"key": s["key"]}).json()["broadcast"])
        self.assertNotIn("now_playing", self.fan.get("/api/users/dj_status").json())
        self.dj.patch("/api/me/settings", {"music_status": True})
        self.assertTrue(self.dj.get("/api/auth/me").json()["user"]["music_status"])
        self.assertTrue(self.dj.post("/api/me/now-playing", {"key": s["key"]}).json()["broadcast"])
        np = self.fan.get("/api/users/dj_status").json()["now_playing"]
        self.assertEqual((np["title"], np["key"]), ("Моя песня", s["key"]))
        # клиенту на слово не верим: несуществующий трек не попадает в статус
        self.assertFalse(self.dj.post("/api/me/now-playing", {"key": "yk:99999999"}).json()["broadcast"])
        # устаревшая запись не показывается
        db.run("UPDATE profiles SET now_playing_at=? WHERE username='dj_status'", (db.future(minutes=-30),))
        self.assertNotIn("now_playing", self.fan.get("/api/users/dj_status").json())
        # выключили — строка пропала
        self.dj.post("/api/me/now-playing", {"key": s["key"]})
        self.dj.patch("/api/me/settings", {"music_status": False})
        self.assertNotIn("now_playing", self.fan.get("/api/users/dj_status").json())


if __name__ == "__main__":
    unittest.main()
