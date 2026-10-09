"""Мессенджер (фото, видео, музыка, стикеры), наборы стикеров и клипы."""
import io
import unittest

from PIL import Image
from starlette.testclient import TestClient

from test_api import Client, png_bytes  # noqa: F401 — настраивает окружение и тестовую базу
from test_stage2 import make_friends
from app import db
from app.main import app
from app.security import rate_limiter

FAKE_MP4 = b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom" + b"\x00" * 4000
FAKE_MP3 = b"ID3\x03\x00\x00\x00\x00\x00\x00" + b"\xff\xfb\x90\x00" * 1000


def gif_bytes(frames=3):
    imgs = [Image.new("RGBA", (64, 64), (i * 80, 100, 200, 255)) for i in range(frames)]
    buf = io.BytesIO()
    imgs[0].save(buf, "GIF", save_all=True, append_images=imgs[1:], duration=80, loop=0)
    return buf.getvalue()


class Stage4Test(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.ctx = TestClient(app).__enter__()
        cls.ivan = Client().register("ivan4", "Иван Медиа")
        cls.zoya = Client().register("zoya4", "Зоя Клип")
        make_friends(cls.ivan, cls.zoya)
        conv = cls.ivan.post("/api/conversations", {"user_id": cls.zoya.refresh()["user"]["id"]}).json()
        cls.conv = conv["id"]

    def setUp(self):
        rate_limiter.reset()

    def test_starter_pack_and_custom_pack(self):
        packs = self.ivan.get("/api/stickers").json()["packs"]
        krug = next(p for p in packs if p["slug"] == "krug")
        self.assertTrue(krug["builtin"])
        self.assertEqual(len(krug["stickers"]), 10)
        # свой набор
        r = self.ivan.post("/api/sticker-packs", {"title": "Мои котики"})
        self.assertEqual(r.status_code, 201, r.text)
        pack = r.json()
        st = self.ivan.post(f"/api/sticker-packs/{pack['id']}/stickers", data={"emoji": "😺"},
                            files=[("file", ("cat.png", png_bytes(), "image/png"))])
        self.assertEqual(st.status_code, 201, st.text)
        anim = self.ivan.post(f"/api/sticker-packs/{pack['id']}/stickers", data={"emoji": "🙀"},
                              files=[("file", ("cat.gif", gif_bytes(), "image/gif"))])
        self.assertTrue(anim.json()["animated"])
        # чужой не может добавлять стикеры в мой набор
        self.assertEqual(self.zoya.post(f"/api/sticker-packs/{pack['id']}/stickers",
                                        files=[("file", ("x.png", png_bytes(), "image/png"))]).status_code, 403)
        # по ссылке набор можно посмотреть и добавить к себе
        view = self.zoya.get(f"/api/sticker-packs/by-slug/{pack['slug']}").json()
        self.assertFalse(view["installed"])
        self.assertEqual(view["count"], 2)
        # без ссылки (slug) чужой набор по номеру не добавить
        self.assertEqual(self.zoya.post(f"/api/sticker-packs/{pack['id']}/install", json={}).status_code, 404)
        self.zoya.post(f"/api/sticker-packs/{pack['id']}/install", json={"slug": pack["slug"]})
        self.assertTrue(any(p["id"] == pack["id"] for p in self.zoya.get("/api/stickers").json()["packs"]))
        # стикер в переписке
        msg = self.zoya.post(f"/api/conversations/{self.conv}/messages", {"sticker_id": st.json()["id"]})
        self.assertEqual(msg.status_code, 201, msg.text)
        self.assertEqual(msg.json()["kind"], "sticker")
        self.assertEqual(msg.json()["media"]["pack"]["slug"], pack["slug"])
        self.zoya.delete(f"/api/sticker-packs/{pack['id']}/install")
        self.assertEqual(self.ivan.delete(f"/api/sticker-packs/{pack['id']}").status_code, 200)

    def test_media_messages(self):
        photo = self.ivan.post(f"/api/conversations/{self.conv}/media", data={"type": "photo", "caption": "Закат"},
                               files=[("file", ("a.png", png_bytes(), "image/png"))])
        self.assertEqual(photo.status_code, 201, photo.text)
        self.assertEqual(photo.json()["media"]["type"], "photo")
        self.assertEqual(photo.json()["text"], "Закат")
        audio = self.ivan.post(f"/api/conversations/{self.conv}/media", data={"type": "audio", "duration": "184.5", "title": "Песня.mp3"},
                               files=[("file", ("song.mp3", FAKE_MP3, "audio/mpeg"))])
        self.assertEqual(audio.status_code, 201, audio.text)
        a = audio.json()["media"]
        self.assertEqual((a["title"], a["duration"], a["mime"]), ("Песня", 184.5, "audio/mpeg"))
        video = self.ivan.post(f"/api/conversations/{self.conv}/media", data={"type": "video", "width": "720", "height": "1280"},
                               files=[("file", ("v.mp4", FAKE_MP4, "video/mp4")), ("poster", ("p.png", png_bytes(), "image/png"))])
        self.assertEqual(video.status_code, 201, video.text)
        v = video.json()["media"]
        self.assertTrue(v["poster"].endswith("_t.webp"))
        # перемотка: сервер отдаёт куски файла
        r = self.zoya.get(v["url"], headers={"Range": "bytes=0-99"})
        self.assertEqual(r.status_code, 206)
        self.assertEqual(len(r.content), 100)
        self.assertEqual(r.headers["content-type"], "video/mp4")
        # подмена расширения не пройдёт: картинка вместо видео
        bad = self.ivan.post(f"/api/conversations/{self.conv}/media", data={"type": "video"},
                             files=[("file", ("v.mp4", png_bytes(), "video/mp4"))])
        self.assertEqual(bad.status_code, 400)
        msgs = self.zoya.get(f"/api/conversations/{self.conv}/messages").json()["items"]
        self.assertEqual([m["kind"] for m in msgs if m["kind"] in ("photo", "audio", "video")], ["photo", "audio", "video"])

    def test_reels(self):
        r = self.zoya.post("/api/reels", data={"caption": "Мой первый клип #лето", "duration": "12.4", "width": "1080", "height": "1920"},
                           files=[("video", ("r.mp4", FAKE_MP4, "video/mp4")), ("poster", ("p.png", png_bytes(), "image/png"))])
        self.assertEqual(r.status_code, 201, r.text)
        reel = r.json()
        self.assertTrue(reel["mine"])
        too_long = self.zoya.post("/api/reels", data={"duration": "600"}, files=[("video", ("r.mp4", FAKE_MP4, "video/mp4"))])
        self.assertEqual(too_long.status_code, 400)
        feed = self.ivan.get("/api/reels").json()["items"]
        self.assertEqual(feed[0]["id"], reel["id"])
        self.assertTrue(feed[0]["following"])  # друзья
        self.assertEqual(self.ivan.post(f"/api/reels/{reel['id']}/like").json(), {"likes": 1, "liked": True})
        self.ivan.post(f"/api/reels/{reel['id']}/view")
        c = self.ivan.post(f"/api/reels/{reel['id']}/comments", {"text": "Круто!"})
        self.assertEqual(c.status_code, 201)
        one = self.ivan.get(f"/api/reels/{reel['id']}").json()
        self.assertEqual((one["likes"], one["comments"], one["views"], one["liked"]), (1, 1, 1, True))
        types = [n["type"] for n in self.zoya.get("/api/notifications").json()["items"]]
        self.assertIn("reel_like", types)
        self.assertIn("reel_comment", types)
        self.assertEqual(len(self.ivan.get("/api/reels", params={"user": "zoya4"}).json()["items"]), 1)
        # «Подписки»: клипы друзей и тех, на кого подписан; незнакомцу — пусто
        self.assertIn(reel["id"], [x["id"] for x in self.ivan.get("/api/reels", params={"feed": "following"}).json()["items"]])
        stranger = Client().register("reel_stranger4", "Незнакомец Клипов")
        self.assertNotIn(reel["id"], [x["id"] for x in stranger.get("/api/reels", params={"feed": "following"}).json()["items"]])
        self.assertEqual(self.ivan.delete(f"/api/reels/{reel['id']}").status_code, 403)
        self.assertEqual(self.zoya.delete(f"/api/reels/{reel['id']}").status_code, 200)
        self.assertIsNone(db.value("SELECT 1 FROM reels WHERE id=?", (reel["id"],)))

    def test_reel_options_and_story_video(self):
        rate_limiter.reset()
        r = self.zoya.post("/api/reels", data={"caption": "Для своих", "duration": "8", "visibility": "friends", "comments_off": "1"},
                           files=[("video", ("r.mp4", FAKE_MP4, "video/mp4"))])
        self.assertEqual(r.status_code, 201, r.text)
        reel = r.json()
        self.assertEqual((reel["visibility"], reel["comments_off"]), ("friends", True))
        stranger = Client().register("reel_stranger5", "Чужой Клипов")
        self.assertNotIn(reel["id"], [x["id"] for x in stranger.get("/api/reels").json()["items"]], "клип «для друзей» не виден чужим")
        self.assertEqual(stranger.get(f"/api/reels/{reel['id']}").status_code, 404)
        self.assertIn(reel["id"], [x["id"] for x in self.ivan.get("/api/reels").json()["items"]])
        self.assertEqual(self.ivan.post(f"/api/reels/{reel['id']}/comments", {"text": "Можно?"}).status_code, 403)
        self.assertEqual(self.zoya.post(f"/api/reels/{reel['id']}/comments", {"text": "Себе можно"}).status_code, 201)
        self.assertEqual(self.zoya.delete(f"/api/reels/{reel['id']}").status_code, 200)
        bad = self.zoya.post("/api/reels", data={"duration": "5", "visibility": "secret"}, files=[("video", ("r.mp4", FAKE_MP4, "video/mp4"))])
        self.assertEqual(bad.status_code, 400)
        # истории: короткое видео до 10 секунд
        s = self.zoya.post("/api/stories", data={"duration": "9.5", "visibility": "friends"},
                           files=[("video", ("s.mp4", FAKE_MP4, "video/mp4")), ("poster", ("p.png", png_bytes(), "image/png"))])
        self.assertEqual(s.status_code, 201, s.text)
        self.assertEqual(s.json()["kind"], "video")
        long = self.zoya.post("/api/stories", data={"duration": "25"}, files=[("video", ("s.mp4", FAKE_MP4, "video/mp4"))])
        self.assertEqual(long.status_code, 400)


if __name__ == "__main__":
    unittest.main()
