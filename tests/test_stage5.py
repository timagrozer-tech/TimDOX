"""Мессенджер: ответы, реакции, правка и удаление, голосовые."""
import json
import unittest

from starlette.testclient import TestClient

from test_api import Client  # noqa: F401 — настраивает окружение и тестовую базу
from test_stage2 import make_friends
from app.main import app
from app.security import rate_limiter

FAKE_WEBM = b"\x1a\x45\xdf\xa3" + b"\x00" * 3000


class Stage5Test(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.ctx = TestClient(app).__enter__()
        cls.a = Client().register("anya5", "Аня Пятая")
        cls.b = Client().register("borya5", "Боря Пятый")
        make_friends(cls.a, cls.b)
        cls.conv = cls.a.post("/api/conversations", {"user_id": cls.b.refresh()["user"]["id"]}).json()["id"]

    def setUp(self):
        rate_limiter.reset()

    def send(self, who, text, **extra):
        r = who.post(f"/api/conversations/{self.conv}/messages", {"text": text, **extra})
        self.assertEqual(r.status_code, 201, r.text)
        return r.json()

    def test_reply_react_edit_delete(self):
        first = self.send(self.a, "Идём в кино?")
        reply = self.send(self.b, "Конечно!", reply_to=first["id"])
        self.assertEqual(reply["reply"]["text"], "Идём в кино?")
        # реакция: поставить, заменить, снять
        r = self.a.post(f"/api/messages/{reply['id']}/react", {"emoji": "❤️"}).json()
        self.assertEqual(r["reactions"][0]["emoji"], "❤️")
        r = self.a.post(f"/api/messages/{reply['id']}/react", {"emoji": "🔥"}).json()
        self.assertEqual([x["emoji"] for x in r["reactions"]], ["🔥"])
        r = self.a.post(f"/api/messages/{reply['id']}/react", {"emoji": "🔥"}).json()
        self.assertEqual(r["reactions"], [])
        self.assertEqual(self.a.post(f"/api/messages/{reply['id']}/react", {"emoji": "💩"}).status_code, 400)
        # править можно только своё
        self.assertEqual(self.a.patch(f"/api/messages/{reply['id']}", {"text": "взлом"}).status_code, 403)
        e = self.a.patch(f"/api/messages/{first['id']}", {"text": "Идём в кино в субботу?"}).json()
        self.assertEqual(e["text"], "Идём в кино в субботу?")
        self.assertTrue(e["edited_at"])
        # удаление: чужое нельзя, своё — становится «удалено», а цитата в ответе меняется
        self.assertEqual(self.b.delete(f"/api/messages/{first['id']}").status_code, 403)
        d = self.a.delete(f"/api/messages/{first['id']}").json()
        self.assertEqual((d["kind"], d["text"]), ("deleted", ""))
        items = self.b.get(f"/api/conversations/{self.conv}/messages").json()["items"]
        again = next(m for m in items if m["id"] == reply["id"])
        self.assertEqual(again["reply"]["text"], "Сообщение удалено")
        self.assertEqual(self.a.patch(f"/api/messages/{first['id']}", {"text": "x"}).status_code, 400)

    def test_voice(self):
        r = self.b.post(f"/api/conversations/{self.conv}/media",
                        data={"type": "voice", "duration": "3.2", "waveform": json.dumps([10, 50, 200, -5, "x"][:4])},
                        files=[("file", ("voice.webm", FAKE_WEBM, "audio/webm"))])
        self.assertEqual(r.status_code, 201, r.text)
        m = r.json()
        self.assertEqual(m["kind"], "voice")
        self.assertTrue(m["media"]["url"].endswith(".weba"))
        self.assertEqual(m["media"]["waveform"], [10, 50, 100, 0])
        self.assertEqual(self.a.get(m["media"]["url"]).headers["content-type"], "audio/webm")

    def test_last_seen_in_direct_chat(self):
        conv = self.a.get(f"/api/conversations/{self.conv}").json()
        self.assertIn("last_seen_at", conv["user"])


if __name__ == "__main__":
    unittest.main()
