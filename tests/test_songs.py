"""Свои песни в «Музыке»: публикация, общая лента, поиск, лайки, прослушивания, правка и удаление."""
import unittest

from starlette.testclient import TestClient

from test_api import Client, png_bytes  # noqa: F401 — настраивает окружение и тестовую базу
from test_stage4 import FAKE_MP3, FAKE_MP4
from app.main import app
from app.security import rate_limiter


class SongsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.ctx = TestClient(app).__enter__()
        cls.lena = Client().register("lena_song", "Лена Поёт")
        cls.petr = Client().register("petr_song", "Пётр Слушает")

    def setUp(self):
        rate_limiter.reset()

    def publish(self, who, title="Ночной город", **extra):
        return who.post("/api/music/songs", data={"title": title, "duration": "185", "genre": "pop", **extra},
                        files=[("audio", ("song.mp3", FAKE_MP3, "audio/mpeg")), ("cover", ("c.png", png_bytes(), "image/png"))])

    def test_publish_list_play_like_delete(self):
        r = self.publish(self.lena, artist="Лена", lyrics="Слова песни")
        self.assertEqual(r.status_code, 201, r.text)
        s = r.json()
        self.assertEqual(s["key"], f"yk:{s['id']}")
        self.assertTrue(s["stream"].startswith("/uploads/") and s["stream"].endswith(".mp3"))
        self.assertTrue(s["artwork"].startswith("/uploads/"))
        self.assertTrue(s["mine"])
        # общедоступна: другой человек видит в общей ленте и находит поиском (кириллица, любой регистр)
        items = self.petr.get("/api/music/songs").json()["items"]
        self.assertIn(s["id"], [x["id"] for x in items])
        self.assertFalse(next(x for x in items if x["id"] == s["id"])["mine"])
        found = self.petr.get("/api/music/songs", params={"q": "НОЧНОЙ"}).json()["items"]
        self.assertEqual([x["id"] for x in found][:1], [s["id"]])
        self.assertEqual(self.petr.get("/api/music/songs", params={"genre": "rock", "q": "ночной"}).json()["items"], [])
        self.assertTrue(any(x["id"] == s["id"] for x in self.petr.get("/api/music/songs", params={"user": "lena_song"}).json()["items"]))
        # прослушивание и «Моя музыка»
        self.assertEqual(self.petr.post(f"/api/music/songs/{s['id']}/play").status_code, 200)
        self.assertEqual(self.petr.post("/api/music/likes", {"key": s["key"]}).status_code, 200)
        mine = self.petr.get("/api/music/likes").json()["items"]
        self.assertEqual(mine[0]["key"], s["key"])
        self.assertEqual(mine[0]["stream"], s["stream"])
        got = self.petr.get(f"/api/music/songs/{s['id']}").json()
        self.assertEqual((got["plays"], got["likes"]), (1, 1))
        top = self.petr.get("/api/music/songs", params={"sort": "popular", "user": "lena_song"}).json()["items"]
        self.assertEqual(top[0]["id"], s["id"])
        self.petr.delete("/api/music/likes", {"key": s["key"]})
        self.assertEqual(self.petr.get(f"/api/music/songs/{s['id']}").json()["likes"], 0)
        # чужую песню нельзя ни править, ни удалить
        self.assertEqual(self.petr.patch(f"/api/music/songs/{s['id']}", {"title": "x"}).status_code, 404)
        self.assertEqual(self.petr.delete(f"/api/music/songs/{s['id']}").status_code, 403)
        ed = self.lena.patch(f"/api/music/songs/{s['id']}", {"title": "Утренний город", "genre": "rock"}).json()
        self.assertEqual((ed["title"], ed["genre"]), ("Утренний город", "rock"))
        self.assertEqual(self.lena.delete(f"/api/music/songs/{s['id']}").status_code, 200)
        self.assertEqual(self.petr.get(f"/api/music/songs/{s['id']}").status_code, 404)

    def test_validation(self):
        no_title = self.lena.post("/api/music/songs", data={"title": " "}, files=[("audio", ("a.mp3", FAKE_MP3, "audio/mpeg"))])
        self.assertEqual(no_title.status_code, 400)
        video = self.lena.post("/api/music/songs", data={"title": "Видео"}, files=[("audio", ("a.mp4", FAKE_MP4, "video/mp4"))])
        self.assertIn(video.status_code, (201, 400))  # mp4-контейнер со звуком допустим (как m4a)
        too_long = self.publish(self.lena, title="Длинная", duration="5000")
        self.assertEqual(too_long.status_code, 400)
        no_file = self.lena.post("/api/music/songs", data={"title": "Без файла"})
        self.assertEqual(no_file.status_code, 400)

    def test_home_and_search_include_songs(self):
        s = self.publish(self.lena, title="Песня для поиска").json()
        home = self.petr.get("/api/music/home").json()
        self.assertIn(s["id"], [x["id"] for x in home["songs"]])
        res = self.petr.get("/api/music/search", params={"q": "для поиска"}).json()
        self.assertIn(s["id"], [x["id"] for x in res["songs"]])


if __name__ == "__main__":
    unittest.main()


class BootMeTest(unittest.TestCase):
    """Страница сразу содержит данные вошедшего — приложение стартует без запроса /api/auth/me"""

    def test_boot_me(self):
        c = Client().register("boot_me", "Бут Ми")
        html = c.get("/").text
        self.assertIn('id="boot-me"', html)
        self.assertIn('"username": "boot_me"', html)
        self.assertNotIn("<script type=\"application/json\" id=\"boot-me\">{\"user\": null", html)
        anon = Client().get("/").text
        self.assertNotIn('id="boot-me"', anon)
        self.assertEqual(Client().get("/no-such-page").status_code, 200)
