"""Поддержка авторов и переводы: комиссия сгорает, лимиты, связанные аккаунты, ИИ-персонажи."""
import unittest

from test_api import Client
from app import db, economy
from app.security import rate_limiter

TEXT = "Сделал сегодня большую подборку полезных ссылок про фотографию для новичков."


class SupportTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        rate_limiter.reset()
        cls.a = Client().register("sup_anna", "Анна Автор")
        cls.b = Client().register("sup_boris", "Борис Меценат")
        cls.aid = cls.a.refresh()["user"]["id"]
        cls.bid = cls.b.refresh()["user"]["id"]
        # разные устройства: иначе тестовые клиенты выглядят как один браузер
        db.run("UPDATE sessions SET user_agent='phone-a' WHERE user_id=?", (cls.aid,))
        db.run("UPDATE sessions SET user_agent='phone-b' WHERE user_id=?", (cls.bid,))
        economy.mint(cls.bid, 3000, kind="test")
        cls.pid = cls.a.post("/api/posts", data={"text": TEXT}).json()["id"]

    def setUp(self):
        rate_limiter.reset()

    def test_support_flow(self):
        before_a = economy.balances(self.aid)["KC"]
        before_total = (economy.supports_for([self.pid], self.bid).get(self.pid) or {"total": 0})["total"]
        r = self.b.post(f"/api/posts/{self.pid}/support", {"amount": 50})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["net"], 45)
        self.assertEqual(economy.balances(self.aid)["KC"] - before_a, 45)
        self.assertEqual(r.json()["support"]["total"] - before_total, 50)
        self.assertEqual(self.b.post(f"/api/posts/{self.pid}/support", {"amount": 7}).status_code, 400)
        self.assertEqual(self.a.post(f"/api/posts/{self.pid}/support", {"amount": 10}).status_code, 400)  # свою — нельзя
        post = self.a.get(f"/api/posts/{self.pid}").json()
        self.assertGreaterEqual(post["support"]["people"], 1)
        n = db.value("SELECT count(*) FROM notifications WHERE user_id=? AND type='support'", (self.aid,))
        self.assertGreaterEqual(n, 1)
        self.assertTrue(economy.audit()["ok"])

    def test_daily_cap(self):
        # аккаунт моложе 14 дней — до 200 KC поддержки в сутки
        self.b.post(f"/api/posts/{self.pid}/support", {"amount": 100})
        r = self.b.post(f"/api/posts/{self.pid}/support", {"amount": 500})
        self.assertEqual(r.status_code, 400)

    def test_linked_accounts(self):
        c = Client().register("sup_twin", "Двойник Бориса")
        tid = c.refresh()["user"]["id"]
        db.run("UPDATE sessions SET user_agent='phone-b' WHERE user_id=?", (tid,))
        economy.mint(tid, 500, kind="test")
        self.assertEqual(c.post(f"/api/posts/{self.pid}/support", {"amount": 10}).status_code, 200)  # с Анной не связан
        bpid = self.b.post("/api/posts", data={"text": TEXT + " Вторая часть."}).json()["id"]
        self.assertEqual(c.post(f"/api/posts/{bpid}/support", {"amount": 10}).status_code, 400)  # тот же браузер, что у Бориса

    def test_transfer_rules(self):
        self.assertEqual(self.b.post("/api/wallet/transfer", {"to": "sup_anna", "amount": 100}).status_code, 403)  # молодой аккаунт
        db.run("UPDATE users SET created_at='2020-01-01T00:00:00.000Z' WHERE id IN (?,?)", (self.aid, self.bid))
        self.assertEqual(self.b.post("/api/wallet/transfer", {"to": "sup_anna", "amount": 100}).status_code, 403)  # не друзья
        self.a.post(f"/api/people/{self.bid}/friend")
        self.b.post(f"/api/people/{self.aid}/friend")
        before = economy.balances(self.aid)["KC"]
        r = self.b.post("/api/wallet/transfer", {"to": "sup_anna", "amount": 200, "note": "на кофе"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(economy.balances(self.aid)["KC"] - before, 190)
        self.assertEqual(self.b.post("/api/wallet/transfer", {"to": "sup_anna", "amount": 1500}).status_code, 400)
        self.assertTrue(economy.audit()["ok"])

    def test_ai_support(self):
        from app.world import actions
        economy.ai_stipend(self.bid)  # стипендия идемпотентна в пределах недели
        economy.ai_stipend(self.bid)
        hist = [h for h in economy.history(self.bid) if h["kind"] == "ai_stipend"]
        self.assertEqual(len(hist), 1)
        self.assertTrue(actions.support(self.bid, self.pid, 10))


if __name__ == "__main__":
    unittest.main()
