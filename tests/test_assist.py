"""ИИ в чатах: варианты ответа, пересказ, «улучшить текст» — с подменённой нейросетью."""
import json
import unittest

from test_api import Client
from app.security import rate_limiter
from app.world import llm


class AssistTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.a = Client().register("ai_a", "Аня Тестова")
        cls.b = Client().register("ai_b", "Боря Тестов")
        cls.c = Client().register("ai_c", "Чужой Человек")
        cls.b_id = cls.b.refresh()["user"]["id"]

    def setUp(self):
        rate_limiter.reset()
        self.calls = []
        self.orig = (llm.enabled, llm.complete)
        llm.enabled = lambda: True

        def fake(system, user, max_tokens=1500, want_json=False):
            self.calls.append((system, user))
            if "варианта ответа" in system:
                return json.dumps({"replies": ["Да, давай!", "А во сколько?", "Сегодня не смогу 😔"]}, ensure_ascii=False)
            if "пересказываешь" in system:
                return "• Боря зовёт в кино в субботу\n• Нужно купить билеты"
            return "Привет! Как дела?"
        llm.complete = fake

    def tearDown(self):
        llm.enabled, llm.complete = self.orig

    def test_flow(self):
        conv = self.a.post("/api/conversations", {"user_id": self.b_id}).json()
        cid = conv.get("id") or conv["conversation"]["id"]
        self.a.post(f"/api/conversations/{cid}/messages", {"text": "Привет"})
        # последнее сообщение моё — предлагать нечего
        self.assertEqual(self.a.post(f"/api/conversations/{cid}/ai/replies", {}).json()["code"], "ai_nothing")
        for t in ("Пойдём в кино в субботу?", "Там новый фильм", "Билеты надо купить заранее"):
            self.b.post(f"/api/conversations/{cid}/messages", {"text": t})
        r = self.a.post(f"/api/conversations/{cid}/ai/replies", {})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(len(r.json()["replies"]), 3)
        sent = self.calls[-1][1]
        self.assertIn("Я: Привет", sent)
        self.assertIn("Боря: Билеты надо купить заранее", sent)
        # пересказ
        s = self.a.post(f"/api/conversations/{cid}/ai/summary", {}).json()
        self.assertTrue(s["summary"].startswith("•"))
        self.assertEqual(s["count"], 4)
        # чужая переписка недоступна
        self.assertEqual(self.c.post(f"/api/conversations/{cid}/ai/summary", {}).status_code, 404)
        # улучшить текст
        r = self.a.post("/api/ai/rewrite", {"text": "привет как дила", "mode": "fix"})
        self.assertEqual(r.json()["text"], "Привет! Как дела?")
        self.assertIn("орфографию", self.calls[-1][0])
        self.assertEqual(self.a.post("/api/ai/rewrite", {"text": "x y", "mode": "evil"}).status_code, 400)
        # нейросеть занята / не подключена
        llm.complete = lambda *a, **k: None
        self.assertEqual(self.a.post("/api/ai/rewrite", {"text": "привет", "mode": "fix"}).json()["code"], "ai_busy")
        llm.enabled = lambda: False
        self.assertEqual(self.a.post("/api/ai/rewrite", {"text": "привет", "mode": "fix"}).json()["code"], "ai_off")
        self.assertFalse(self.a.get("/api/ai/status").json()["enabled"])


if __name__ == "__main__":
    unittest.main()
