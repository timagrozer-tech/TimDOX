"""Чат 2.0: темы, капсула времени, колесо решений, тук-тук."""
import json
import unittest
from datetime import datetime, timedelta, timezone

from test_api import Client
from app import db
from app.security import rate_limiter


class ChatPlusTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.a = Client().register("cp_a", "Аня Чат")
        cls.b = Client().register("cp_b", "Боря Чат")
        cls.x = Client().register("cp_x", "Посторонний")
        b_id = cls.b.refresh()["user"]["id"]
        conv = cls.a.post("/api/conversations", {"user_id": b_id}).json()
        cls.cid = conv.get("id") or conv["conversation"]["id"]

    def setUp(self):
        rate_limiter.reset()

    def test_capsule(self):
        soon = (datetime.now(timezone.utc) + timedelta(hours=2)).isoformat()
        self.assertEqual(self.a.post(f"/api/conversations/{self.cid}/capsule", {"text": "x", "unlock_at": datetime.now(timezone.utc).isoformat()}).status_code, 400)
        r = self.a.post(f"/api/conversations/{self.cid}/capsule", {"text": "Секрет: я купил билеты!", "unlock_at": soon, "hint": "на твой ДР"})
        self.assertEqual(r.status_code, 201, r.text)
        m = r.json()
        self.assertEqual((m["kind"], m["text"], m["media"]["opened"], m["media"]["hint"]), ("capsule", "⏳ Капсула времени", False, "на твой ДР"))
        self.assertNotIn("sealed_text", json.dumps(m))
        # ни в списке сообщений, ни по одному — секрета не видно
        items = self.b.get(f"/api/conversations/{self.cid}/messages").json()["items"]
        self.assertNotIn("билеты", json.dumps(items, ensure_ascii=False))
        self.assertNotIn("билеты", json.dumps(self.b.get(f"/api/messages/{m['id']}").json(), ensure_ascii=False))
        self.assertEqual(self.x.get(f"/api/messages/{m['id']}").status_code, 404)
        # время пришло
        raw = json.loads(db.value("SELECT media FROM messages WHERE id=?", (m["id"],)))
        raw["unlock_at"] = "2000-01-01T00:00:00.000Z"
        db.run("UPDATE messages SET media=? WHERE id=?", (json.dumps(raw, ensure_ascii=False), m["id"]))
        opened = self.b.get(f"/api/messages/{m['id']}").json()
        self.assertEqual((opened["text"], opened["media"]["opened"]), ("Секрет: я купил билеты!", True))
        # капсулу нельзя «подправить» после отправки
        self.assertEqual(self.a.patch(f"/api/messages/{m['id']}", {"text": "другое"}).status_code, 400)

    def test_wheel_nudge_theme(self):
        self.assertEqual(self.a.post(f"/api/conversations/{self.cid}/wheel", {"options": ["Пицца"]}).status_code, 400)
        w = self.a.post(f"/api/conversations/{self.cid}/wheel", {"question": "Что едим?", "options": ["Пицца", "Суши", "Суши", "Бургер", ""]}).json()
        self.assertEqual(w["media"]["options"], ["Пицца", "Суши", "Бургер"])
        self.assertIn(w["media"]["winner"], range(3))
        self.assertTrue(w["text"].endswith(w["media"]["options"][w["media"]["winner"]]))
        n = self.b.post(f"/api/conversations/{self.cid}/nudge", {"type": "heart"}).json()
        self.assertEqual((n["kind"], n["media"]["type"]), ("nudge", "heart"))
        self.assertEqual(self.b.post(f"/api/conversations/{self.cid}/nudge", {"type": "slap"}).status_code, 400)
        # тема: своя — только у меня; общая — у обоих
        t = self.a.patch(f"/api/conversations/{self.cid}/theme", {"theme": {"wall": "aurora", "accent": "pink", "bubble": "glass", "size": 17}}).json()
        self.assertEqual(t["theme"]["wall"], "aurora")
        self.assertIsNone(self.b.get(f"/api/conversations/{self.cid}").json()["theme"])
        self.a.patch(f"/api/conversations/{self.cid}/theme", {"theme": {"wall": "ocean", "accent": "hack"}, "shared": True})
        bt = self.b.get(f"/api/conversations/{self.cid}").json()
        self.assertEqual((bt["theme"]["wall"], bt["theme"]["accent"]), ("ocean", "default"))
        self.assertEqual(self.a.get(f"/api/conversations/{self.cid}").json()["theme"]["wall"], "ocean")  # общая заменила личную
        self.assertEqual(self.x.patch(f"/api/conversations/{self.cid}/theme", {"theme": {"wall": "neon"}}).status_code, 404)


if __name__ == "__main__":
    unittest.main()
