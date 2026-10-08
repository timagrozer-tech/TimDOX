"""Бот Yarko Stickers: вебхук с секретом, привязка аккаунта, перенос набора с прогрессом, ZIP, уведомления, вход из мини-приложения."""
import hashlib
import hmac
import io
import json
import time
import unittest
import urllib.parse
import zipfile

from starlette.testclient import TestClient

from test_api import Client
from app import db, stickers2, tgbot
from app.main import app
from app.realtime import hub
from app.security import rate_limiter
from test_stickers2 import sticker_png, tgs

TOKEN = "123:abc"
TSET = {"name": "FunnyCats", "title": "Смешные коты", "sticker_type": "regular", "stickers": [
    {"file_id": "f1", "emoji": "😹", "is_animated": False, "is_video": False, "file_size": 1000},
    {"file_id": "f2", "emoji": "🙀", "is_animated": True, "is_video": False, "file_size": 2000}]}
FILES = {"f1": sticker_png(), "f2": tgs()}


def init_data(user: dict, age: int = 0, token: str = TOKEN) -> str:
    fields = {"auth_date": str(int(time.time()) - age), "query_id": "AAE", "user": json.dumps(user, separators=(",", ":"))}
    check = "\n".join(f"{k}={v}" for k, v in sorted(fields.items()))
    key = hmac.new(b"WebAppData", token.encode(), hashlib.sha256).digest()
    fields["hash"] = hmac.new(key, check.encode(), hashlib.sha256).hexdigest()
    return urllib.parse.urlencode(fields)


class TgBotTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.user = Client().register("tgbot_user", "Бот Тестер")
        cls.uid = cls.user.refresh()["user"]["id"]

    def setUp(self):
        rate_limiter.reset()
        self.sent, self.docs, self.uploads = [], [], []
        self.orig = (stickers2.tg_token, tgbot._call, tgbot._upload, stickers2.tg_set, stickers2._tg_download,
                     tgbot._send_document, tgbot._enqueue, hub.is_online)
        stickers2.tg_token = lambda: TOKEN
        tgbot.BOT["username"] = "krug_test_bot"
        tgbot._call = lambda method, payload: self.sent.append((method, payload)) or {"ok": True, "result": {"message_id": len(self.sent)}}
        tgbot._upload = lambda method, fields, ff, fn, data, mime: self.uploads.append((method, fn)) or {"ok": True}
        stickers2.tg_set = lambda name: TSET if name == "FunnyCats" else {**TSET, "name": name, "title": "Набор " + name}
        stickers2._tg_download = lambda fid, limit=0: FILES[fid]
        tgbot._send_document = lambda chat, fn, data, cap: self.docs.append((fn, data))
        tgbot._enqueue = lambda fn, *a: fn(*a)
        hub.is_online = lambda uid: False
        tgbot._zip_busy.clear()
        tgbot._last.clear()
        stickers2._preview_cache.clear()
        self.c = TestClient(app)

    def tearDown(self):
        (stickers2.tg_token, tgbot._call, tgbot._upload, stickers2.tg_set, stickers2._tg_download,
         tgbot._send_document, tgbot._enqueue, hub.is_online) = self.orig

    def msg(self, text=None, sticker=None, uid=555):
        m = {"chat": {"id": uid, "type": "private"}, "from": {"id": uid, "username": "tester", "first_name": "Тест"}}
        if text:
            m["text"] = text
        if sticker:
            m["sticker"] = sticker
        tgbot.handle({"message": m})

    def cb(self, data, uid=555):
        tgbot.handle({"callback_query": {"id": "q", "data": data, "from": {"id": uid}, "message": {"chat": {"id": uid}, "message_id": 1}}})

    def texts(self):
        return [p.get("text", "") for m, p in self.sent if m in ("sendMessage", "editMessageText")]

    def last_kb(self):
        return [b for m, p in reversed(self.sent) if p.get("reply_markup") for row in p["reply_markup"]["inline_keyboard"] for b in row][:6]

    def wait(self, cond, sec=10):
        end = time.time() + sec
        while time.time() < end:
            if cond():
                return True
            time.sleep(.05)
        return False

    def link(self, tg=555):
        url = self.user.post("/api/telegram/link", {}).json()["url"]
        self.assertTrue(url.startswith("https://t.me/krug_test_bot?start=link_"))
        self.msg("/start " + url.split("start=")[1], uid=tg)

    def test_secret_and_groups(self):
        r = self.c.post("/api/telegram/webhook", json={"message": {}}, headers={"x-telegram-bot-api-secret-token": "wrong"})
        self.assertEqual(r.status_code, 404)
        r = self.c.post("/api/telegram/webhook", json={"message": {}}, headers={"x-telegram-bot-api-secret-token": tgbot._secret()})
        self.assertEqual(r.status_code, 200)
        tgbot.handle({"message": {"chat": {"id": 9, "type": "group"}, "from": {"id": 9}, "text": "/start"}})
        self.assertFalse(self.sent)

    def test_link_import_zip_notify(self):
        self.msg("/start", uid=556)
        self.assertIn("Привет", self.texts()[-1])
        # без привязки: кнопка-мини-приложение импорта и ZIP
        self.msg(sticker={"set_name": "FunnyCats", "file_id": "x"}, uid=556)
        self.assertIn("Смешные коты", self.texts()[-1])
        kb = self.last_kb()
        self.assertTrue(kb[0]["web_app"]["url"].endswith("ref=FunnyCats"))
        self.assertIn("zip:FunnyCats", [b.get("callback_data") for b in kb])
        # ZIP в исходных форматах, не чаще раза в минуту
        self.cb("zip:FunnyCats", uid=556)
        names = zipfile.ZipFile(io.BytesIO(self.docs[0][1])).namelist()
        self.assertEqual(sorted(n.rsplit(".", 1)[1] for n in names), ["tgs", "webp"])
        self.cb("zip:FunnyCats", uid=556)
        self.assertIn("Один архив в минуту", self.texts()[-1])
        # привязка
        self.link()
        self.assertIn("@tgbot_user", self.texts()[-1])
        st = self.user.get("/api/telegram").json()
        self.assertEqual(st["bot"], "krug_test_bot")
        self.assertEqual(st["linked"]["tg_username"], "tester")
        self.msg("/start link_wrongcode", uid=777)
        self.assertIn("устарела", self.texts()[-1])
        # теперь набор переносится прямо из чата, с прогрессом
        self.msg("https://t.me/addstickers/FunnyCats")
        self.assertTrue(self.wait(lambda: any("в вашем Yarko" in t for t in self.texts()), 15), self.texts()[-3:])
        self.assertTrue(db.value("SELECT 1 FROM user_sticker_packs u JOIN sticker_packs p ON p.id=u.pack_id "
                                 "WHERE u.user_id=? AND p.source_ref='FunnyCats'", (self.uid,)))
        self.msg("/packs")
        self.assertIn("Ваша коллекция", self.texts()[-1])
        # уведомления: офлайн → приходит, повтор в тот же чат — нет; выключили — тишина
        n = len(self.texts())
        tgbot.notify_message(self.uid, "Аня", 42, "привет!")
        tgbot.notify_message(self.uid, "Аня", 42, "ещё раз")
        self.assertEqual(len(self.texts()), n + 1)
        self.assertIn("Аня", self.texts()[-1])
        tgbot.notify_social(self.uid, "Боря", "friend_request")
        self.assertIn("в друзья", self.texts()[-1])
        self.user.patch("/api/telegram", {"notify_messages": False})
        n = len(self.texts())
        tgbot.notify_message(self.uid, "Аня", 43, "тишина")
        self.assertEqual(len(self.texts()), n)
        self.msg("/notify")
        self.cb("n:m")
        self.assertEqual(tgbot.link_of_user(self.uid)["notify_messages"], 1)
        # отвязка из бота
        self.msg("/unlink")
        self.cb("u:yes")
        self.assertIsNone(self.user.get("/api/telegram").json()["linked"])

    def test_webapp_login(self):
        tg_user = {"id": 888, "first_name": "Мини"}
        self.assertIsNone(tgbot.check_init_data(init_data(tg_user, token="999:zzz")))
        self.assertIsNone(tgbot.check_init_data(init_data(tg_user, age=3 * 3600)))
        self.assertEqual(tgbot.check_init_data(init_data(tg_user))["id"], 888)
        r = self.c.post("/api/auth/telegram", json={"init_data": init_data(tg_user)})
        self.assertEqual(r.status_code, 404)
        self.link(tg=888)
        r = self.c.post("/api/auth/telegram", json={"init_data": init_data(tg_user)})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self.c.get("/api/auth/me").json()["user"]["id"], self.uid)
        self.user.patch("/api/telegram", {"webapp_login": False})
        r = TestClient(app).post("/api/auth/telegram", json={"init_data": init_data(tg_user)})
        self.assertEqual(r.status_code, 403)
        self.user.delete("/api/telegram")

    def test_many_sets_bot_and_site(self):
        shared = "Мои наборы:\nhttps://t.me/addstickers/PackOne\nhttps://t.me/addstickers/PackTwo\nt.me/addemoji/PackThree"
        self.assertEqual(stickers2.parse_tg_refs(shared), ["PackOne", "PackTwo", "PackThree"])
        # без привязки — предложение привязать и перенести всё на сайте
        self.msg(shared, uid=4242)
        self.assertIn("Нашёл <b>3</b>", self.texts()[-1])
        self.assertIn("PackOne%2CPackTwo", self.last_kb()[0]["web_app"]["url"])
        # с привязкой — переносит все по одному и пишет итог
        self.link(tg=4243)
        self.msg(shared, uid=4243)
        self.assertIn("3</b> из 3", self.texts()[-1])
        items = self.user.get("/api/sticker-import/tg-sets").json()["items"]
        self.assertLessEqual({"PackOne", "PackTwo", "PackThree"}, {x["name"] for x in items if x["status"] == "done"})
        # сайт: вставка ссылок и «скрыть»
        r = self.user.post("/api/sticker-import/tg-sets", {"text": "https://t.me/addstickers/PackFour https://t.me/addstickers/PackOne"})
        self.assertEqual(r.status_code, 201, r.text)
        self.assertTrue(self.wait(lambda: any(x["name"] == "PackFour" and x["status"] == "done"
                                              for x in self.user.get("/api/sticker-import/tg-sets").json()["items"])))
        self.user.delete("/api/sticker-import/tg-sets/PackFour")
        self.assertNotIn("PackFour", [x["name"] for x in self.user.get("/api/sticker-import/tg-sets").json()["items"]])
        self.assertEqual(self.user.post("/api/sticker-import/tg-sets", {"text": "привет"}).status_code, 400)
        self.user.delete("/api/telegram")

    def test_export_pack_to_telegram(self):
        from app import media, tgexport
        pid = stickers2._new_pack(self.uid, "Мой 3D", "avatar3d")
        for i in range(3):
            stickers2._add(pid, media.store_any_sticker(sticker_png()), "😎", i)
        tg_export_id = "krug_export"
        # без привязки — понятная ошибка
        r = self.user.post(f"/api/sticker-packs/{pid}/telegram", {})
        self.assertEqual(r.json().get("code"), "tg_not_linked")
        self.link(tg=5151)
        tgbot._upload = lambda method, fields, ff, fn, data, mime: self.uploads.append((method, len(data))) or {"ok": True, "result": {"file_id": tg_export_id}}
        r = self.user.post(f"/api/sticker-packs/{pid}/telegram", {})
        self.assertEqual(r.status_code, 202, r.text)
        self.assertTrue(self.wait(lambda: self.user.get(f"/api/sticker-packs/{pid}/telegram").json().get("status") == "done"))
        st = self.user.get(f"/api/sticker-packs/{pid}/telegram").json()
        self.assertTrue(st["url"].startswith("https://t.me/addstickers/krug") and st["url"].endswith("v1_by_krug_test_bot"))
        self.assertFalse(st["stale"])
        create = [p for m, p in self.sent if m == "createNewStickerSet"][-1]
        self.assertEqual(len(create["stickers"]), 3)
        self.assertEqual(create["stickers"][0]["emoji_list"], ["😎"])
        self.assertTrue(all(n <= 500 * 1024 for m, n in self.uploads if m == "uploadStickerFile"))
        self.assertIn("теперь в Telegram", self.texts()[-1])
        slug = db.value("SELECT slug FROM sticker_packs WHERE id=?", (pid,))
        self.assertEqual(self.user.get(f"/api/sticker-packs/by-slug/{slug}").json()["tg_url"], st["url"])
        # повторный экспорт — старая версия удаляется, новая с v2
        tgexport._state.clear()
        self.user.post(f"/api/sticker-packs/{pid}/telegram", {})
        self.assertTrue(self.wait(lambda: "v2_by" in (self.user.get(f"/api/sticker-packs/{pid}/telegram").json().get("url") or "")))
        self.assertIn("deleteStickerSet", [m for m, p in self.sent])
        self.assertEqual(tgexport._emoji("abc"), "🙂")
        self.user.delete("/api/telegram")

    def test_link_inside_mini_app(self):
        tg_user = {"id": 999, "first_name": "Внутри", "username": "inside"}
        r = self.user.post("/api/telegram/link", {"init_data": init_data(tg_user, token="9:x")})
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.json()["code"], "tg_init_bad")
        r = self.user.post("/api/telegram/link", {"init_data": init_data(tg_user)})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["linked"]["tg_username"], "inside")
        self.assertIn("привязан", self.texts()[-1])
        self.user.delete("/api/telegram")


if __name__ == "__main__":
    unittest.main()
