"""Свои плейлисты и песня в личных сообщениях."""
import unittest

from starlette.testclient import TestClient

from test_api import Client  # noqa: F401 — настраивает окружение и тестовую базу
from test_stage4 import FAKE_MP3
from app.main import app
from app.security import rate_limiter


def song(who, title):
    r = who.post("/api/music/songs", data={"title": title, "duration": "100"}, files=[("audio", ("s.mp3", FAKE_MP3, "audio/mpeg"))])
    assert r.status_code == 201, r.text
    return r.json()


class PlaylistsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.ctx = TestClient(app).__enter__()
        cls.me = Client().register("pl_owner", "Плейлист Владелец")
        cls.other = Client().register("pl_other", "Плейлист Гость")
        cls.other_id = cls.other.refresh()["user"]["id"]

    def setUp(self):
        rate_limiter.reset()

    def test_playlist_crud(self):
        a, b = song(self.me, "Первая"), song(self.me, "Вторая")
        p = self.me.post("/api/music/my-playlists", {"title": "Дорога", "key": a["key"]}).json()
        self.assertEqual((p["title"], p["count"], p["mine"]), ("Дорога", 1, True))
        self.assertEqual(self.me.post(f"/api/music/my-playlists/{p['id']}/tracks", {"key": b["key"]}).status_code, 200)
        self.me.post(f"/api/music/my-playlists/{p['id']}/tracks", {"key": b["key"]})  # повтор не дублирует
        full = self.other.get(f"/api/music/my-playlists/{p['id']}").json()
        self.assertEqual([t["key"] for t in full["tracks"]], [a["key"], b["key"]])
        self.assertFalse(full["mine"])
        # чужой не может менять
        self.assertEqual(self.other.post(f"/api/music/my-playlists/{p['id']}/tracks", {"key": a["key"]}).status_code, 404)
        self.assertEqual(self.other.delete(f"/api/music/my-playlists/{p['id']}").status_code, 404)
        # несуществующий трек не добавить
        self.assertEqual(self.me.post(f"/api/music/my-playlists/{p['id']}/tracks", {"key": "yk:9999999"}).status_code, 404)
        # порядок, переименование, удаление трека
        r = self.me.patch(f"/api/music/my-playlists/{p['id']}", {"title": "Дорога домой", "order": [b["key"], a["key"]]}).json()
        self.assertEqual((r["title"], [t["key"] for t in r["tracks"]]), ("Дорога домой", [b["key"], a["key"]]))
        self.me.delete(f"/api/music/my-playlists/{p['id']}/tracks", {"key": b["key"]})
        self.assertEqual(self.me.get("/api/music/my-playlists").json()["items"][0]["count"], 1)
        self.assertEqual(self.me.delete(f"/api/music/my-playlists/{p['id']}").status_code, 200)
        self.assertEqual(self.me.get("/api/music/my-playlists").json()["items"], [])
        self.assertEqual(self.me.post("/api/music/my-playlists", {"title": "  "}).status_code, 400)

    def test_send_song_in_chat(self):
        s = song(self.me, "Песня другу")
        c = self.me.post("/api/conversations", {"user_id": self.other_id}).json()
        r = self.me.post(f"/api/conversations/{c['id']}/share", {"type": "track", "key": s["key"]})
        self.assertEqual(r.status_code, 201, r.text)
        msgs = self.other.get(f"/api/conversations/{c['id']}/messages").json()["items"]
        m = msgs[-1]
        self.assertEqual((m["kind"], m["media"]["key"], m["media"]["title"]), ("track", s["key"], "Песня другу"))
        self.assertEqual(self.me.post(f"/api/conversations/{c['id']}/share", {"type": "track", "key": "yk:999999"}).status_code, 400)
        convs = self.other.get("/api/conversations").json()["items"]
        self.assertIn("Песня другу", str(convs))


if __name__ == "__main__":
    unittest.main()
