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
        return [{"stationuuid": "aaaa-1111", "name": "Радио Yarko", "url_resolved": "https://stream.example/live",
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


class _FakeStream:
    def __init__(self, data, status=200, headers=None):
        self._data, self.status, self.headers = data, status, headers or {}

    def read(self, n=-1):
        out, self._data = (self._data, b"") if n < 0 else (self._data[:n], self._data[n:])
        return out

    def getcode(self):
        return self.status

    def close(self):
        pass


class MusicProxyTest(unittest.TestCase):
    """Аудио и обложки через наш сервер — в России Audius напрямую не открывается"""

    @classmethod
    def setUpClass(cls):
        cls.a = Client().register("musproxy", "Прокси Музыка")

    def setUp(self):
        rate_limiter.reset()
        self._open, self._art = music.open_audius_stream, music.fetch_art

    def tearDown(self):
        music.open_audius_stream, music.fetch_art = self._open, self._art

    def test_play_streams_with_range(self):
        seen = {}

        def fake(tid, rng):
            seen["tid"], seen["rng"] = tid, rng
            return _FakeStream(b"ID3" + b"x" * 97, 206, {"Content-Type": "audio/mpeg", "Content-Length": "100",
                                                        "Content-Range": "bytes 0-99/5000"})
        music.open_audius_stream = fake
        r = self.a.get("/api/music/play/T1", headers={"Range": "bytes=0-99"})
        self.assertEqual(r.status_code, 206)
        self.assertEqual(r.content[:3], b"ID3")
        self.assertEqual(r.headers["content-range"], "bytes 0-99/5000")
        self.assertNotIn("content-encoding", r.headers, "аудио не сжимается — иначе ломается перемотка")
        self.assertEqual(seen, {"tid": "T1", "rng": "bytes=0-99"})
        self.assertEqual(Client().get("/api/music/play/T1").status_code, 401)

    def test_play_unavailable(self):
        def fake(tid, rng):
            raise music.Unavailable("x")
        music.open_audius_stream = fake
        self.assertEqual(self.a.get("/api/music/play/T1").status_code, 502)

    def test_bad_track_id(self):
        with self.assertRaises(music.Unavailable):
            self._open("../../etc", None)

    def test_art_proxy(self):
        music.fetch_art = lambda u: (b"\x89PNG", "image/png")
        r = self.a.get("/api/music/art", params={"u": "https://img.example/1.png"})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.headers["content-type"], "image/png")
        self.assertEqual(Client().get("/api/music/art", params={"u": "https://img.example/1.png"}).status_code, 401)

    def test_disk_copies_on_hosting(self):
        """Хостинг: первое прослушивание пишет файл на диск, дальше — переадресация на готовый файл (его отдаёт веб-сервер)"""
        import tempfile
        from app import config
        old = (config.MEDIA_PROXY, config.MEDIA_CACHE_DIR)
        config.MEDIA_PROXY, config.MEDIA_CACHE_DIR = True, tempfile.mkdtemp()
        try:
            calls = []

            def fake(tid, rng):
                calls.append(rng)
                return _FakeStream(b"ID3" + b"y" * 997, 200, {"Content-Type": "audio/mpeg", "Content-Length": "1000"})
            music.open_audius_stream = fake
            r = self.a.get("/api/music/play/T9")
            self.assertEqual((r.status_code, len(r.content)), (200, 1000))
            r2 = self.a.get("/api/music/play/T9", follow_redirects=False)
            self.assertEqual(r2.status_code, 302)
            self.assertEqual(r2.headers["location"], "/uploads/mcache/a/T9.mp3")
            self.assertEqual(len(calls), 1)
            # перемотка до сохранения не пишет обрывки
            music.open_audius_stream = lambda tid, rng: _FakeStream(b"z" * 10, 206, {"Content-Length": "10", "Content-Range": "bytes 5-14/99"})
            self.assertEqual(self.a.get("/api/music/play/T8", headers={"Range": "bytes=5-14"}).status_code, 206)
            self.assertEqual(self.a.get("/api/music/play/T8", follow_redirects=False).status_code, 206)
            music.fetch_art = lambda u: (b"\x89PNG", "image/png")
            self.assertEqual(self.a.get("/api/music/art", params={"u": "https://img.example/2.png"}).status_code, 200)
            r3 = self.a.get("/api/music/art", params={"u": "https://img.example/2.png"}, follow_redirects=False)
            self.assertEqual(r3.status_code, 302)
            self.assertTrue(r3.headers["location"].startswith("/uploads/mcache/art/"))
        finally:
            config.MEDIA_PROXY, config.MEDIA_CACHE_DIR = old

    def test_art_blocks_internal_addresses(self):
        for u in ("http://img.example/1.png", "https://127.0.0.1/x.png", "https://localhost/x.png",
                  "https://169.254.169.254/latest", "file:///etc/passwd", ""):
            with self.assertRaises(music.Unavailable, msg=u):
                self._art(u)
        self.assertEqual(self.a.get("/api/music/art", params={"u": "https://127.0.0.1/x.png"}).status_code, 404)


class MediaCacheTest(unittest.TestCase):
    """Хостинг: файлы из базы кладутся на диск (их отдаёт веб-сервер) и удаляются вместе с оригиналом"""

    def test_db_media_cached_and_deleted(self):
        import tempfile
        from pathlib import Path
        from unittest import mock
        from app import config, db, media
        with tempfile.TemporaryDirectory() as d, mock.patch.object(config, "MEDIA_STORAGE", "db"), \
                mock.patch.object(config, "MEDIA_PROXY", True), mock.patch.object(config, "MEDIA_CACHE_DIR", Path(d)):
            db.run("INSERT INTO media_files (path, content_type, data) VALUES (?,?,?)", ("2026/10/cachetest.webp", "image/webp", b"RIFFxx"))
            p = media.cached_copy("2026/10/cachetest.webp")
            self.assertTrue(p and p.read_bytes() == b"RIFFxx")
            media.delete_files("/uploads/2026/10/cachetest.webp")
            self.assertFalse(p.exists())
            self.assertIsNone(media.cached_copy("../etc/passwd"))
