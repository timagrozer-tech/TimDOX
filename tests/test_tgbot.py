"""Бот KRUG Stickers: вебхук с секретом, ответы на /start, стикер и ссылку."""
import unittest

from starlette.testclient import TestClient

from test_api import Client  # noqa: F401 — настраивает окружение и тестовую базу
from app import stickers2, tgbot
from app.main import app


class TgBotTest(unittest.TestCase):
    def setUp(self):
        self.sent = []
        self.orig = (stickers2.tg_token, tgbot._call, stickers2.tg_set)
        stickers2.tg_token = lambda: "123:abc"
        tgbot._call = lambda method, payload: self.sent.append((method, payload)) or {"ok": True}
        stickers2.tg_set = lambda name: {"name": name, "title": "Смешные коты"}
        self.c = TestClient(app)

    def tearDown(self):
        stickers2.tg_token, tgbot._call, stickers2.tg_set = self.orig

    def hook(self, msg, secret=None):
        return self.c.post("/api/telegram/webhook", json={"message": msg},
                           headers={"x-telegram-bot-api-secret-token": tgbot._secret() if secret is None else secret})

    def test_secret_required(self):
        self.assertEqual(self.hook({"chat": {"id": 1, "type": "private"}, "text": "/start"}, secret="wrong").status_code, 404)
        self.assertFalse(self.sent)

    def test_start_sticker_and_link(self):
        self.assertEqual(self.hook({"chat": {"id": 7, "type": "private"}, "text": "/start"}).status_code, 200)
        self.assertIn("Привет", self.sent[-1][1]["text"])
        self.hook({"chat": {"id": 7, "type": "private"}, "sticker": {"set_name": "FunnyCats", "file_id": "x"}})
        btn = self.sent[-1][1]["reply_markup"]["inline_keyboard"][0][0]
        self.assertTrue(btn["url"].endswith("/stickers?tab=import&ref=FunnyCats"))
        self.assertIn("Смешные коты", self.sent[-1][1]["text"])
        self.hook({"chat": {"id": 7, "type": "private"}, "text": "смотри https://t.me/addstickers/Hot_Cherry"})
        self.assertTrue(self.sent[-1][1]["reply_markup"]["inline_keyboard"][0][0]["url"].endswith("ref=Hot_Cherry"))
        n = len(self.sent)
        self.hook({"chat": {"id": 9, "type": "group"}, "text": "/start"})          # в группах молчим
        self.assertEqual(len(self.sent), n)


if __name__ == "__main__":
    unittest.main()
