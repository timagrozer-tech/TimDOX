"""Артисты Yarko: карточка, альбомы, чарт, слушатели и музыкальные награды."""
import unittest

from starlette.testclient import TestClient

from test_api import Client, png_bytes  # noqa: F401 — настраивает окружение и тестовую базу
from test_stage4 import FAKE_MP3
from app import db
from app.main import app
from app.security import rate_limiter


def publish(who, title, **extra):
    r = who.post("/api/music/songs", data={"title": title, "duration": "120", **extra},
                 files=[("audio", ("s.mp3", FAKE_MP3, "audio/mpeg"))])
    assert r.status_code == 201, r.text
    return r.json()


class ArtistsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.ctx = TestClient(app).__enter__()
        cls.art = Client().register("artist_one", "Арт Певец")
        cls.fan = Client().register("fan_one", "Фан Слушатель")
        cls.fan_id = cls.fan.refresh()["user"]["id"]
        cls.art_id = cls.art.refresh()["user"]["id"]

    def setUp(self):
        rate_limiter.reset()

    def test_artist_album_awards_chart(self):
        # подписчик узнает о новой песне
        self.fan.post(f"/api/people/{self.art_id}/follow")
        s1 = publish(self.art, "Первая", genre="pop", lyrics="Текст")
        self.assertIn("debut", s1["new_awards"])
        notes = self.fan.get("/api/notifications").json()["items"]
        self.assertTrue(any(n["type"] == "new_song" for n in notes))
        mine = self.art.get("/api/notifications").json()["items"]
        self.assertTrue(any(n["type"] == "music_award" and n["extra"]["code"] == "debut" for n in mine))
        s2 = publish(self.art, "Вторая", genre="rock")
        s3 = publish(self.art, "Третья", genre="house")
        # карточка артиста
        self.assertEqual(self.art.put("/api/music/artist", {"name": "АРТ", "bio": "Пою о городе", "genre": "pop"}).status_code, 200)
        self.assertEqual(self.art.post("/api/music/artist", files=[("banner", ("b.png", png_bytes(), "image/png"))]).status_code, 200)
        card = self.fan.get("/api/music/artists/artist_one").json()
        self.assertEqual((card["name"], card["bio"], card["stats"]["songs"]), ("АРТ", "Пою о городе", 3))
        self.assertTrue(card["banner"].startswith("/uploads/"))
        self.assertTrue(card["following"])
        earned = {a["code"] for a in card["awards"] if a["earned"]}
        self.assertTrue({"debut", "genres", "pioneer"} <= earned, earned)
        # альбом из своих песен; чужие песни в него не попадают
        other = publish(self.fan, "Чужая")
        r = self.art.post("/api/music/albums", data={"title": "Город", "kind": "ep", "songs": f"{s3['id']},{s1['id']},{other['id']}"},
                          files=[("cover", ("c.png", png_bytes(), "image/png"))])
        self.assertEqual(r.status_code, 201, r.text)
        alb = r.json()
        self.assertIn("album", alb["new_awards"])
        full = self.fan.get(f"/api/music/albums/{alb['id']}").json()
        self.assertEqual([t["id"] for t in full["tracks"]], [s3["id"], s1["id"]])
        self.assertEqual(full["kind_name"], "EP")
        self.assertTrue(any(n["type"] == "new_album" for n in self.fan.get("/api/notifications").json()["items"]))
        # порядок и состав меняются
        self.art.patch(f"/api/music/albums/{alb['id']}", {"songs": [s1["id"], s2["id"]], "title": "Город-2"})
        full = self.fan.get(f"/api/music/albums/{alb['id']}").json()
        self.assertEqual(([t["id"] for t in full["tracks"]], full["title"]), ([s1["id"], s2["id"]], "Город-2"))
        self.assertEqual(self.fan.patch(f"/api/music/albums/{alb['id']}", {"title": "x"}).status_code, 404)
        # слушатели, прослушивания и чарт
        for _ in range(3):
            self.fan.post(f"/api/music/songs/{s2['id']}/play")
        db.run("UPDATE songs SET plays=129 WHERE id=?", (s2["id"],))
        self.fan.post(f"/api/music/songs/{s2['id']}/play")
        card = self.fan.get("/api/music/artists/artist_one").json()
        self.assertEqual(card["stats"]["listeners"], 1)
        self.assertIn("plays100", {a["code"] for a in card["awards"] if a["earned"]})
        top = self.fan.get("/api/music/chart").json()["items"]
        self.assertEqual(top[0]["id"], s2["id"])
        self.assertIn("hit", {a["code"] for a in self.art.get("/api/music/artists/artist_one").json()["awards"] if a["earned"]})
        artists = self.fan.get("/api/music/artists").json()["items"]
        self.assertEqual(artists[0]["user"]["username"], "artist_one")
        # удаление альбома не удаляет песни
        self.assertEqual(self.art.delete(f"/api/music/albums/{alb['id']}").status_code, 200)
        self.assertEqual(self.fan.get(f"/api/music/songs/{s1['id']}").json()["album_id"], None)

    def test_no_card_without_songs(self):
        Client().register("quiet_one", "Тихий")
        self.assertEqual(self.fan.get("/api/music/artists/quiet_one").status_code, 404)
        self.assertEqual(self.fan.post("/api/music/albums", data={"title": "Пусто", "songs": "999999"}).status_code, 400)


if __name__ == "__main__":
    unittest.main()
