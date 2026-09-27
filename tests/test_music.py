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
    if "rss.applemarketingtools.com" in url:
        if "albums" in url:
            return {"feed": {"results": [{"id": "900", "name": "Альбом", "artistName": "Zivert", "artworkUrl100": "https://is1.mzstatic.com/a/100x100bb.jpg"}]}}
        return {"feed": {"results": [{"id": str(700 + i)} for i in range(5)]}}
    if "itunes.apple.com" in url:
        def song(i, artist="Zivert"):
            return {"wrapperType": "track", "kind": "song", "trackId": 700 + i, "trackName": f"Песня {i}", "artistName": artist,
                    "artistId": 55, "artworkUrl100": "https://is1.mzstatic.com/x/100x100bb.jpg", "previewUrl": f"https://audio.example/{i}.m4a",
                    "trackTimeMillis": 200000, "primaryGenreName": "Поп", "trackViewUrl": f"https://music.apple.com/ru/{i}", "collectionName": "Альбом"}
        if "/lookup" in url and "id=900" in url:
            return {"results": [{"wrapperType": "collection", "collectionName": "Альбом", "artistName": "Zivert", "releaseDate": "2025-01-01"}, song(1), song(2)]}
        if "/lookup" in url and "id=55" in url:
            return {"results": [{"wrapperType": "artist", "artistName": "Zivert"}, song(1), song(2), song(3)]}
        if "/lookup" in url:
            return {"results": [song(i, "Баста" if i == 2 else "Zivert") for i in range(5)]}
        if "/search" in url:
            return {"results": [song(9), song(8, "Другой"), {"wrapperType": "track", "kind": "song", "trackId": 1, "previewUrl": "http://insecure"}]}
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

    def test_russian_chart(self):
        d = self.a.get("/api/music/home").json()
        chart = d["ru"]["chart"]
        self.assertEqual([t["key"] for t in chart], [f"itunes:{700 + i}" for i in range(5)], "порядок мест чарта сохраняется")
        t = chart[0]
        self.assertTrue(t["preview"])
        self.assertEqual(t["duration"], 30)
        self.assertEqual(t["full_duration"], 200)
        self.assertEqual(t["artwork"], "https://is1.mzstatic.com/x/600x600bb.jpg")
        self.assertEqual([a["name"] for a in d["ru"]["artists"]], ["Zivert", "Баста"])
        self.assertEqual(d["ru"]["albums"][0]["id"], "900")
        self.assertIn("Кино", d["ru"]["legends"])
        self.assertEqual(len(self.a.get("/api/music/chart").json()["items"]), 5)
        al = self.a.get("/api/music/album/900").json()
        self.assertEqual((al["album"]["title"], len(al["tracks"])), ("Альбом", 2))
        ar = self.a.get("/api/music/artist", params={"id": "55"}).json()
        self.assertEqual((ar["artist"]["name"], len(ar["tracks"])), ("Zivert", 3))
        byname = self.a.get("/api/music/artist", params={"name": "Zivert"}).json()
        self.assertEqual([t["artist"] for t in byname["tracks"]], ["Zivert"], "однофамильцы отброшены")
        s = self.a.get("/api/music/search", params={"q": "зиверт"}).json()
        self.assertEqual(len(s["ru"]), 2, "треки без https-фрагмента отброшены")
        self.assertEqual(self.a.post("/api/music/likes", {"key": "itunes:701"}).status_code, 200)
        liked = self.a.get("/api/music/likes").json()["items"]
        self.assertTrue(any(x["key"] == "itunes:701" and x["preview"] for x in liked))
        r = self.a.c.post("/api/posts", data={"music": "itunes:702"}, headers=self.a._h())
        self.assertEqual(r.json()["music"]["stream"], "https://audio.example/2.m4a")

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
