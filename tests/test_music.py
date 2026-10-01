"""Раздел «Музыка»: каталог через внешние источники (подменены), любимые треки, трек в записи."""
import unittest

from test_api import Client  # noqa: F401 — настраивает окружение и тестовую базу
from app import music
from app.security import rate_limiter


def _track(i, genre="Electronic", streamable=True):
    return {"id": f"T{i}", "title": f"Трек {i}", "user": {"name": f"Артист {i}"}, "duration": 180 + i, "genre": genre,
            "permalink": f"/artist/track-{i}", "play_count": 100 * i, "is_streamable": streamable,
            "artwork": {"480x480": f"https://img.example/{i}.jpg", "150x150": "http://insecure/x.jpg"}}


def fake_http(url, timeout=8.0):
    if "api.audius.co" in url:
        if "/tracks/trending/underground" in url:
            return {"data": [_track(i) for i in range(20, 26)]}
        if "/tracks/trending" in url:
            return {"data": [_track(i, "Hip-Hop/Rap" if "genre=Hip" in url else "Electronic") for i in range(1, 8)]
                    + [_track(99, streamable=False)]}
        if "/tracks/search" in url:
            return {"data": [_track(40), _track(41)]}
        if "/playlists/trending" in url:
            return {"data": [{"id": "P1", "playlist_name": "Вечер", "user": {"name": "Куратор"}, "track_count": 12,
                              "artwork": {"480x480": "https://img.example/p.jpg"}}]}
        if "/playlists/P1/tracks" in url:
            return {"data": [_track(50), _track(51)]}
        if "/playlists/P1" in url:
            return {"data": [{"id": "P1", "playlist_name": "Вечер", "user": {"name": "Куратор"}, "track_count": 2}]}
        if "/tracks/T" in url:
            tid = url.split("/tracks/T", 1)[1].split("?", 1)[0]
            return {"data": _track(int(tid))}
    if "radio-browser" in url:
        return [{"stationuuid": "aaaa-1111", "name": "Радио Круг", "url_resolved": "https://stream.example/live",
                 "favicon": "https://img.example/r.png", "tags": "pop,hits"},
                {"stationuuid": "bbbb-2222", "name": "Без шифрования", "url_resolved": "http://plain.example/live"}]
    raise OSError("нет сети")


class MusicTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._orig = music._http_json
        music._http_json = fake_http
        music._cache.clear()
        cls.a = Client().register("musanna", "Анна Музыка")
        cls.b = Client().register("musboris", "Борис Музыка")
        cls.bid = cls.b.refresh()["user"]["id"]

    @classmethod
    def tearDownClass(cls):
        music._http_json = cls._orig
        music._cache.clear()

    def setUp(self):
        rate_limiter.reset()

    def test_home_and_catalog(self):
        d = self.a.get("/api/music/home").json()
        self.assertTrue(d["online"])
        self.assertEqual(len(d["trending"]), 7, "нестримящиеся треки отфильтрованы")
        t = d["trending"][0]
        self.assertEqual(t["key"], "audius:T1")
        self.assertEqual(t["artwork"], "https://img.example/1.jpg")
        self.assertEqual(t["permalink"], "https://audius.co/artist/track-1")
        self.assertEqual(d["playlists"][0]["id"], "P1")
        self.assertTrue(any(g["id"] == "Hip-Hop/Rap" for g in d["genres"]))
        g = self.a.get("/api/music/genre", params={"g": "Hip-Hop/Rap"}).json()
        self.assertEqual(g["items"][0]["genre"], "Hip-Hop/Rap")
        self.assertEqual(self.a.get("/api/music/genre", params={"g": "Шансон"}).status_code, 400)
        s = self.a.get("/api/music/search", params={"q": "лоуфай"}).json()
        self.assertEqual([x["id"] for x in s["tracks"]], ["T40", "T41"])
        self.assertEqual(len(s["stations"]), 1, "станции без https отброшены")
        p = self.a.get("/api/music/playlist/P1").json()
        self.assertEqual(len(p["tracks"]), 2)
        r = self.a.get("/api/music/radio").json()
        self.assertEqual(r["items"][0]["stream"], "https://stream.example/live")
        self.assertTrue(r["items"][0]["live"])
        w = self.a.get("/api/music/wave").json()
        self.assertGreater(len(w["items"]), 5)

    def test_status_public(self):
        d = Client().get("/api/music/status").json()
        self.assertTrue(d["ok"])
        self.assertEqual(d["radio"], 1)

    def test_russian_full_tracks(self):
        d = self.a.get("/api/music/home").json()
        ru = d["ru"]["tracks"]
        self.assertTrue(ru, "русскоязычные треки собраны из поиска")
        self.assertTrue(all(not t.get("preview") and t["source"] == "audius" for t in ru), "только полные треки")
        self.assertTrue(d["ru"]["radio"])
        self.assertEqual(self.a.get("/api/music/russian").json()["items"][0]["key"], ru[0]["key"])
        self.assertEqual(self.a.post("/api/music/likes", {"key": "itunes:701"}).status_code, 404, "фрагменты больше не поддерживаются")
        r = self.a.c.post("/api/posts", data={"music": "itunes:702"}, headers=self.a._h())
        self.assertEqual(r.status_code, 400)
        self.assertEqual(self.a.get("/api/music/chart").status_code, 404)

    def test_likes_and_friends(self):
        self.assertEqual(self.b.post("/api/music/likes", {"key": "audius:T3"}).status_code, 200)
        self.assertEqual(self.b.post("/api/music/likes", {"key": "radio:aaaa-1111"}).status_code, 200)
        self.assertEqual(self.b.post("/api/music/likes", {"key": "audius:../../etc"}).status_code, 404)
        self.assertEqual(self.b.post("/api/music/likes", {"key": "evil:1"}).status_code, 404)
        items = self.b.get("/api/music/likes").json()["items"]
        self.assertEqual([t["key"] for t in items], ["radio:aaaa-1111", "audius:T3"])
        self.assertEqual(items[1]["title"], "Трек 3", "данные взяты из источника")
        self.a.post(f"/api/people/{self.bid}/follow")
        home = self.a.get("/api/music/home").json()
        self.assertEqual(home["friends"][0]["by"]["username"], "musboris")
        self.assertTrue(any(t["key"] == "audius:T3" for t in home["krug_top"]))
        self.assertEqual(self.b.delete("/api/music/likes", {"key": "audius:T3"}).status_code, 200)
        self.assertEqual(len(self.b.get("/api/music/likes").json()["items"]), 1)

    def test_post_with_track(self):
        r = self.a.c.post("/api/posts", data={"text": "Послушайте!", "music": "audius:T5"}, headers=self.a._h())
        self.assertEqual(r.status_code, 201, r.text)
        self.assertEqual(r.json()["music"]["title"], "Трек 5")
        r = self.a.c.post("/api/posts", data={"music": "audius:T6"}, headers=self.a._h())
        self.assertEqual(r.status_code, 201, "запись может состоять только из трека")
        r = self.a.c.post("/api/posts", data={"music": "audius:bad/../id"}, headers=self.a._h())
        self.assertEqual(r.status_code, 400)

    def test_source_down(self):
        music._http_json = lambda url, timeout=8.0: (_ for _ in ()).throw(OSError("нет сети"))
        music._cache.clear()
        try:
            d = self.a.get("/api/music/home").json()
            self.assertFalse(d["online"])
            self.assertEqual(self.a.get("/api/music/genre", params={"g": "Pop"}).status_code, 503)
        finally:
            music._http_json = fake_http
            music._cache.clear()


if __name__ == "__main__":
    unittest.main()
