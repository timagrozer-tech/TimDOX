"""Стикеры 2.0: форматы, импорт, коллекция, поиск, редактор, Remix и Lab, реакции, комментарии, каталог за KC, витрина, GIF."""
import gzip
import io
import json
import time
import unittest
import zipfile

from PIL import Image, ImageDraw
from starlette.testclient import TestClient

from test_api import Client  # noqa: F401 — настраивает окружение и тестовую базу
from test_stage2 import make_friends
from app import db, economy, stickers2
from app.main import app
from app.security import rate_limiter


def sticker_png(color=(255, 160, 40)) -> bytes:
    im = Image.new("RGBA", (300, 300), (0, 0, 0, 0))
    ImageDraw.Draw(im).ellipse([40, 40, 260, 260], fill=color + (255,))
    buf = io.BytesIO()
    im.save(buf, "PNG")
    return buf.getvalue()


def tgs() -> bytes:
    return gzip.compress(json.dumps({"v": "5.5", "fr": 60, "ip": 0, "op": 120, "w": 512, "h": 512, "layers": [{"ty": 4}]}).encode())


WEBM = b"\x1a\x45\xdf\xa3\x9f\x42\x86\x81\x01\x42\xf7\x81\x01\x42\xf2\x81\x04\x42\xf3\x81\x08\x42\x82\x84webm" + b"\x00" * 200


def photo_jpeg() -> bytes:
    im = Image.new("RGB", (500, 400), (120, 200, 240))
    ImageDraw.Draw(im).ellipse([140, 70, 360, 330], fill=(250, 120, 90))
    buf = io.BytesIO()
    im.save(buf, "JPEG")
    return buf.getvalue()


def wait_job(c, job):
    for _ in range(100):
        j = c.get(f"/api/sticker-import/{job['id']}").json()
        if j["status"] in ("done", "error"):
            return j
        time.sleep(.05)
    raise AssertionError("импорт завис")


class Stickers2Test(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.ctx = TestClient(app).__enter__()
        cls.a = Client().register("st2_anna", "Анна Стикер")
        cls.b = Client().register("st2_boris", "Борис Коллекционер")
        make_friends(cls.a, cls.b)
        cls.aid = cls.a.refresh()["user"]["id"]
        cls.bid = cls.b.refresh()["user"]["id"]
        cls.conv = cls.a.post("/api/conversations", {"user_id": cls.bid}).json()["id"]

    def setUp(self):
        rate_limiter.reset()

    def _pack(self, c, title="Котики", n=3):
        p = c.post("/api/sticker-packs", {"title": title}).json()
        ids = []
        for i in range(n):
            r = c.post(f"/api/sticker-packs/{p['id']}/stickers", data={"emoji": "🐱", "tags": "кот рыжий"},
                       files={"file": (f"s{i}.png", io.BytesIO(sticker_png((200, 40 * i, 90))), "image/png")})
            self.assertEqual(r.status_code, 201, r.text)
            ids.append(r.json()["id"])
        return p, ids

    def test_formats_and_file_import(self):
        z = io.BytesIO()
        with zipfile.ZipFile(z, "w") as f:
            f.writestr("cats/happy_😺.png", sticker_png())
            f.writestr("cats/anim.tgs", tgs())
            f.writestr("cats/video.webm", WEBM)
            f.writestr("cats/readme.txt", "не стикер")
            f.writestr("__MACOSX/._x.png", b"junk")
        r = self.a.post("/api/sticker-import/files", data={"title": "Из архива"},
                        files=[("files", ("pack.zip", io.BytesIO(z.getvalue()), "application/zip")),
                               ("files", ("extra.gif", io.BytesIO(sticker_png()), "image/png"))])
        self.assertEqual(r.status_code, 201, r.text)
        j = wait_job(self.a, r.json())
        self.assertEqual((j["status"], j["total"]), ("done", 4), j)
        pack = self.a.get(f"/api/sticker-packs/by-slug/{j['slug']}").json()
        fmts = sorted(s["format"] for s in pack["stickers"])
        self.assertEqual(fmts, ["tgs", "webm", "webp", "webp"])
        self.assertIn("😺", [s["emoji"] for s in pack["stickers"]])            # эмодзи из имени файла
        self.assertEqual(pack["source"], "import")
        # плохие файлы
        bad = self.a.post("/api/sticker-import/files", files=[("files", ("x.zip", io.BytesIO(b"PK\x03\x04broken"), "application/zip"))])
        self.assertEqual(bad.status_code, 400)
        r = self.a.post(f"/api/sticker-packs/{pack['id']}/stickers", files={"file": ("t.tgs", io.BytesIO(gzip.compress(b"{}")), "application/gzip")})
        self.assertEqual(r.status_code, 400)

    def test_telegram_link_parsing_and_disabled_import(self):
        self.assertEqual(stickers2.parse_tg_ref("https://t.me/addstickers/AnimePack"), ("AnimePack", "stickers"))
        self.assertEqual(stickers2.parse_tg_ref("@FunnyCats"), ("FunnyCats", "stickers"))
        self.assertEqual(stickers2.parse_tg_ref("https://t.me/addemoji/Hearts"), ("Hearts", "emoji"))
        self.assertIsNone(stickers2.parse_tg_ref("http://evil.example/../x y"))
        stickers2._preview_cache.clear()
        r = self.a.get("/api/sticker-import/telegram", params={"ref": "@FunnyCats"})
        self.assertEqual(r.status_code, 503)                                   # без токена бота — честное сообщение
        self.assertIn("TELEGRAM_BOT_TOKEN", r.json()["error"])
        self.assertFalse(self.a.get("/api/sticker-import").json()["telegram"])

    def test_telegram_import_with_fake_api(self):
        """Импорт по ссылке с подменённым Telegram: скачивание, общий набор и мгновенный повторный импорт."""
        files = {"f1": sticker_png(), "f2": tgs(), "t2": sticker_png((10, 200, 10)), "f3": WEBM}
        tset = {"name": "FunnyCats", "title": "Смешные коты", "sticker_type": "regular", "stickers": [
            {"file_id": "f1", "emoji": "😹", "is_animated": False, "is_video": False, "file_size": 1000},
            {"file_id": "f2", "emoji": "🙀", "is_animated": True, "is_video": False, "thumbnail": {"file_id": "t2"}, "file_size": 2000},
            {"file_id": "f3", "emoji": "😼", "is_animated": False, "is_video": True, "file_size": 3000}]}
        orig = (stickers2.tg_token, stickers2._tg_api, stickers2._tg_download)
        stickers2.tg_token = lambda: "test"
        stickers2._tg_api = lambda method, **kw: tset
        stickers2._tg_download = lambda fid, limit=0: files[fid]
        stickers2._preview_cache.clear()
        try:
            pv = self.a.get("/api/sticker-import/telegram", params={"ref": "https://t.me/addstickers/FunnyCats"}).json()
            self.assertEqual((pv["count"], pv["animated"], pv["video"], pv["static"], pv["size"], pv["ready"]), (3, 1, 1, 1, 6000, False))
            self.assertTrue(pv["thumbs"][0].startswith("/api/sticker-import/tg-thumb"))
            self.assertEqual(self.a.get(pv["thumbs"][0]).status_code, 200)
            self.assertEqual(self.a.get("/api/sticker-import/tg-thumb", params={"set": "FunnyCats", "f": "secret"}).status_code, 404)
            j = wait_job(self.a, self.a.post("/api/sticker-import/telegram", {"ref": "@FunnyCats"}).json())
            self.assertEqual(j["status"], "done", j)
            p = self.a.get(f"/api/sticker-packs/by-slug/{j['slug']}").json()
            self.assertEqual((p["title"], p["count"], p["shared"]), ("Смешные коты", 3, True))
            anim = [s for s in p["stickers"] if s["format"] == "tgs"][0]
            self.assertTrue(anim["thumb"])                                     # у анимации есть миниатюра
            # Борис импортирует тот же набор — мгновенно, без скачивания
            stickers2._tg_download = lambda fid, limit=0: (_ for _ in ()).throw(AssertionError("не должно качать"))
            j2 = self.b.post("/api/sticker-import/telegram", {"ref": "FunnyCats"}).json()
            self.assertEqual((j2["status"], j2["pack_id"]), ("done", p["id"]))
            # общий набор нельзя менять напрямую и нельзя опубликовать — только своя копия
            self.assertEqual(self.a.patch(f"/api/sticker-packs/{p['id']}", {"title": "Мои"}).status_code, 403)
            mine = self.b.post(f"/api/sticker-packs/{p['id']}/copy", {}).json()
            self.assertEqual((mine["count"], mine["source"]), (3, "import"))
            self.assertEqual(self.b.post(f"/api/sticker-packs/{mine['id']}/publish", {"published": True}).status_code, 400)
            # «удалить» общий набор = убрать у себя; у Бориса он остаётся
            self.assertEqual(self.a.delete(f"/api/sticker-packs/{p['id']}").status_code, 200)
            self.assertTrue(any(x["id"] == p["id"] for x in self.b.get("/api/stickers").json()["packs"]))
        finally:
            stickers2.tg_token, stickers2._tg_api, stickers2._tg_download = orig

    def test_collection_search_and_editor(self):
        p, ids = self._pack(self.a, "Рыжие")
        # избранное, реакции, недавние, папки
        self.assertTrue(self.a.post(f"/api/stickers/{ids[0]}/save", {}).json()["saved"])
        self.assertTrue(self.a.post(f"/api/stickers/{ids[1]}/save", {"kind": "reaction"}).json()["saved"])
        self.a.post(f"/api/stickers/{ids[2]}/used", {})
        f = self.a.post("/api/sticker-folders", {"title": "Мемы", "emoji": "🤡"}).json()
        self.assertEqual(self.a.post(f"/api/sticker-folders/{f['id']}/items", {"sticker_id": ids[0]}).status_code, 200)
        col = self.a.get("/api/stickers")
        data = col.json()
        self.assertEqual([s["id"] for s in data["favorites"]], [ids[0]])
        self.assertEqual([s["id"] for s in data["reactions"]], [ids[1]])
        self.assertEqual(data["recent"][0]["id"], ids[2])
        self.assertEqual(data["folders"][0]["stickers"][0]["id"], ids[0])
        self.assertEqual(self.a.get("/api/stickers", headers={"if-none-match": col.headers["etag"]}).status_code, 304)
        # умный поиск: «котик» → 🐱, хотя слова нет; по тегам; чужие (не добавленные) не видны
        found = self.a.get("/api/stickers/search", params={"q": "котик"}).json()["items"]
        self.assertTrue({s["id"] for s in found} >= set(ids))
        self.assertTrue(self.a.get("/api/stickers/search", params={"q": "рыжий"}).json()["items"])
        self.assertFalse([s for s in self.b.get("/api/stickers/search", params={"q": "рыжий"}).json()["items"] if s["id"] in ids])
        # редактор: обложка, эмодзи и теги, разделить, объединить, копия
        self.assertEqual(self.a.patch(f"/api/sticker-packs/{p['id']}", {"cover_id": ids[2], "description": "Самые рыжие"}).json()["cover"]["id"], ids[2])
        self.assertEqual(self.a.patch(f"/api/stickers/{ids[0]}", {"emoji": "😻", "tags": "любовь"}).json()["emoji"], "😻")
        part = self.a.post(f"/api/sticker-packs/{p['id']}/split", {"sticker_ids": [ids[2]], "title": "Отдельно"}).json()
        self.assertEqual(part["count"], 1)
        self.assertEqual(self.a.get(f"/api/sticker-packs/by-slug/{p['slug']}").json()["count"], 2)
        m = self.a.post(f"/api/sticker-packs/{p['id']}/merge", {"from_id": part["id"], "move": True}).json()
        self.assertEqual((m["added"], m["moved"], m["pack"]["count"]), (1, True, 3))
        copy = self.a.post(f"/api/sticker-packs/{p['id']}/copy", {"title": "Версия 2"}).json()
        self.assertEqual((copy["count"], copy["source"]), (3, "copy"))
        # удаление копии не удаляет файлы оригинала
        self.assertEqual(self.a.delete(f"/api/sticker-packs/{copy['id']}").status_code, 200)
        self.assertEqual(self.a.get(f"/api/sticker-packs/by-slug/{p['slug']}").json()["count"], 3)

    def test_remix_lab_and_reactions(self):
        p, ids = self._pack(self.a, "Для ремикса", 1)
        pv = self.a.post("/api/sticker-lab/remix", {"sticker_id": ids[0], "preview": True,
                                                    "params": {"hue": 90, "outline": "white", "text": "Привет", "elements": ["hearts"]}})
        self.assertEqual((pv.status_code, pv.headers["content-type"]), (200, "image/webp"))
        saved = self.a.post("/api/sticker-lab/remix", {"sticker_id": ids[0], "params": {"anim": "bounce"}}).json()
        self.assertTrue(saved["sticker"]["animated"])
        self.assertEqual(saved["pack"]["title"], "Мои ремиксы")
        self.assertEqual(self.a.get(f"/api/sticker-packs/by-slug/{p['slug']}").json()["count"], 1)  # оригинал цел
        # инструменты для своей картинки
        img = io.BytesIO(photo_jpeg())
        r = self.a.post("/api/sticker-lab/upload", data={"tool": "removebg", "preview": "1"}, files={"file": ("p.jpg", img, "image/jpeg")})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(Image.open(io.BytesIO(r.content)).getpixel((0, 0))[3], 0)                 # угол стал прозрачным
        r = self.a.post("/api/sticker-lab/upload", data={"tool": "meme", "params": json.dumps({"meme_top": "когда", "meme_bottom": "пятница"})},
                        files={"file": ("p.jpg", io.BytesIO(photo_jpeg()), "image/jpeg")})
        self.assertEqual(r.status_code, 201, r.text)
        pack = self.a.post("/api/sticker-lab/photo-pack", data={"title": "Я"}, files={"file": ("p.jpg", io.BytesIO(photo_jpeg()), "image/jpeg")}).json()
        self.assertEqual(pack["count"], 10)
        self.assertTrue(any(s["animated"] for s in pack["stickers"]))
        designs = self.a.post("/api/sticker-lab/text", {"prompt": "грустный кот под дождём"}).json()["designs"]
        self.assertTrue(designs and all(d["emoji"] for d in designs))
        reac = self.a.post("/api/sticker-lab/reactions", {"sticker_id": ids[0]}).json()["stickers"]
        self.assertEqual(len(reac), 3)
        self.assertTrue({s["id"] for s in reac} <= {s["id"] for s in self.a.get("/api/stickers").json()["reactions"]})
        # стикер-реакция на сообщение
        msg = self.b.post(f"/api/conversations/{self.conv}/messages", {"text": "привет"}).json()
        r = self.a.post(f"/api/messages/{msg['id']}/react", {"emoji": f"st:{reac[0]['id']}"})
        self.assertEqual(r.status_code, 200, r.text)
        msgs = self.b.get(f"/api/conversations/{self.conv}/messages").json()
        items = msgs.get("items") or msgs.get("messages")
        got = [m for m in items if m["id"] == msg["id"]][0]["reactions"][0]
        self.assertEqual((got["emoji"], got["sticker"]["url"]), (f"st:{reac[0]['id']}", reac[0]["url"]))
        self.assertEqual(self.a.post(f"/api/messages/{msg['id']}/react", {"emoji": "st:999999"}).status_code, 404)

    def test_comments_gif_catalog_and_showcase(self):
        p, ids = self._pack(self.a, "На продажу", 3)
        # стикер в комментарии
        post = self.a.post("/api/posts", data={"text": "Новый пост"}).json()
        c = self.b.post(f"/api/posts/{post['id']}/comments", {"sticker_id": ids[0]})
        self.assertEqual(c.status_code, 403)                     # Борис набор не добавлял и он не опубликован
        self.b.post(f"/api/sticker-packs/{p['id']}/install", {"slug": p["slug"]})
        c = self.b.post(f"/api/posts/{post['id']}/comments", {"sticker_id": ids[0]})
        self.assertEqual(c.status_code, 201, c.text)
        listed = self.a.get(f"/api/posts/{post['id']}/comments").json()["items"]
        self.assertEqual(listed[0]["sticker"]["sticker_id"], ids[0])
        self.b.delete(f"/api/sticker-packs/{p['id']}/install")
        # каталог: платный набор, покупка за KC с комиссией, автору — оплата
        self.assertEqual(self.a.post(f"/api/sticker-packs/{p['id']}/publish", {"published": True, "price": 100}).status_code, 400)  # моложе 7 дней
        db.run("UPDATE users SET created_at=? WHERE id=?", (db.future(days=-30), self.aid))
        self.assertTrue(self.a.post(f"/api/sticker-packs/{p['id']}/publish", {"published": True, "price": 100}).json()["published"])
        cat = self.b.get("/api/sticker-catalog", params={"price": "paid"}).json()["items"]
        card = [x for x in cat if x["id"] == p["id"]][0]
        self.assertTrue(card["locked"])
        self.assertEqual(self.b.post(f"/api/sticker-packs/{p['id']}/install", {}).status_code, 402)
        self.assertEqual(self.b.post(f"/api/conversations/{self.conv}/messages", {"sticker_id": ids[1]}).status_code, 403)
        orig_linked = economy.linked
        economy.linked = lambda x, y: False   # в тестах все с одного адреса
        self.addCleanup(setattr, economy, "linked", orig_linked)
        self.assertEqual(self.b.post(f"/api/sticker-packs/{p['id']}/buy", {}).status_code, 400)        # нет монет
        economy.mint(self.bid, 500, kind="test")
        before = economy.balances(self.aid)["KC"]
        r = self.b.post(f"/api/sticker-packs/{p['id']}/buy", {})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(economy.balances(self.aid)["KC"] - before, 93)                                 # 100 − 7% комиссии
        self.assertEqual(self.b.post(f"/api/conversations/{self.conv}/messages", {"sticker_id": ids[1]}).status_code, 201)
        self.assertEqual(self.a.delete(f"/api/sticker-packs/{p['id']}").status_code, 400)               # купленное не удалить
        # витрина и планета в созвездии
        self.b.post(f"/api/sticker-packs/{p['id']}/favorite", {})
        sc = self.a.get("/api/users/st2_boris/stickers").json()
        self.assertEqual(sc["favorites"][0]["id"], p["id"])
        self.assertEqual(sc["rare"][0]["id"], p["id"])
        ach = {x["id"]: x["done"] for x in self.a.get("/api/users/st2_anna/stickers").json()["achievements"]}
        self.assertTrue(ach["creator_1"] and ach["seller_1"])
        prof = self.b.get("/api/users/st2_anna").json()
        kinds = [i["kind"] for i in (prof.get("constellation") or {}).get("items", [])]
        self.assertIn("stickers", kinds)
        # GIF
        frames = [Image.new("RGB", (80, 80), (i * 60, 0, 200)) for i in range(4)]
        buf = io.BytesIO(); frames[0].save(buf, "GIF", save_all=True, append_images=frames[1:], duration=80, loop=0)
        g = self.a.post("/api/gifs", files={"file": ("a.gif", io.BytesIO(buf.getvalue()), "image/gif")})
        self.assertEqual(g.status_code, 201, g.text)
        m = self.a.post(f"/api/conversations/{self.conv}/messages", {"gif_id": g.json()["id"]})
        self.assertEqual((m.status_code, m.json()["kind"]), (201, "gif"))
        self.assertEqual(self.b.post(f"/api/conversations/{self.conv}/messages", {"gif_id": g.json()["id"]}).status_code, 404)
        still = io.BytesIO(); Image.new("RGB", (40, 40)).save(still, "PNG")
        self.assertEqual(self.a.post("/api/gifs", files={"file": ("s.png", io.BytesIO(still.getvalue()), "image/png")}).status_code, 400)

    def test_shop_cosmetics(self):
        economy.mint(self.aid, 2000, kind="test")
        self.assertEqual(self.a.post("/api/shop/buy", {"item_id": "sp_theme_neon"}).status_code, 200)
        self.assertEqual(self.a.post("/api/shop/equip", {"slot": "sp_theme", "item_id": "sp_theme_neon"}).status_code, 200)
        self.assertEqual(self.a.get("/api/stickers").json()["theme"], "sp_theme_neon")
        self.assertEqual(self.a.post("/api/shop/equip", {"slot": "sp_open", "item_id": "sp_open_warp"}).status_code, 400)  # не куплено


if __name__ == "__main__":
    unittest.main()
