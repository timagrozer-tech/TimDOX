"""Экономика Э0: журнал сходится, лимиты держат, награды отменяются, задания выдаются один раз."""
import unittest

from test_api import Client
from app import db, economy
from app.security import rate_limiter

LONG = "Сегодня гуляли по набережной и смотрели закат над рекой — очень красиво было."


class EconomyTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        rate_limiter.reset()
        cls.a = Client().register("eco_anna", "Анна Монетка")
        cls.b = Client().register("eco_boris", "Борис Монетка")
        cls.aid = cls.a.refresh()["user"]["id"]
        cls.bid = cls.b.refresh()["user"]["id"]

    def setUp(self):
        rate_limiter.reset()

    def kc(self, c):
        return c.get("/api/wallet").json()["kc"]

    def test_checkin_once(self):
        r1 = self.a.post("/api/wallet/checkin").json()
        r2 = self.a.post("/api/wallet/checkin").json()
        self.assertEqual(r1["granted"], 10)
        self.assertEqual(r2["granted"], 0)
        self.assertTrue(r2["checked_in"])

    def test_post_reward_cap_and_clawback(self):
        before = self.kc(self.b)
        ids = []
        for i in range(4):
            r = self.b.post("/api/posts", data={"text": f"{LONG} №{i}"})
            self.assertEqual(r.status_code, 201, r.text)
            ids.append(r.json()["id"])
        self.assertEqual(self.kc(self.b) - before, 45)  # 3 × 15, четвёртая без награды
        self.b.post("/api/posts", data={"text": "коротко"})
        self.assertEqual(self.kc(self.b) - before, 45)
        self.assertEqual(self.b.delete(f"/api/posts/{ids[0]}").status_code, 200)
        self.assertEqual(self.kc(self.b) - before, 30)  # удалена в течение суток — награда отменена
        self.assertTrue(economy.audit()["ok"])

    def test_comment_reward_and_quests(self):
        pid = self.a.post("/api/posts", data={"text": LONG + " Комментарии приветствуются!"}).json()["id"]
        before = self.kc(self.b)
        self.b.post(f"/api/posts/{pid}/comments", {"text": "Очень красиво, а где это было?"})
        self.b.post(f"/api/posts/{pid}/comments", {"text": "ок"})
        self.assertEqual(self.kc(self.b) - before, 3)
        w = self.b.get("/api/wallet").json()
        self.assertEqual(len(w["quests"]), 3)
        # доводим задания до выполнения прямыми событиями
        for q in w["quests"]:
            economy.track(self.bid, q["event"], q["target"])
        got = 0
        for slot in (1, 2, 3):
            r = self.b.post(f"/api/quests/{slot}/claim")
            self.assertEqual(r.status_code, 200, r.text)
            got += r.json()["got"]["kc"] + r.json()["got"]["bonus"]
        self.assertEqual(got, 20 + 25 + 35 + 20)
        self.assertEqual(self.b.post("/api/quests/1/claim").status_code, 400)
        self.assertEqual(self.b.get("/api/wallet").json()["weekly"]["days"], 1)
        hist = self.b.get("/api/wallet/history").json()["items"]
        self.assertTrue(any(h["kind"] == "quest_all" for h in hist))
        self.assertTrue(economy.audit()["ok"])

    def test_incoming_reactions_settle(self):
        pid = self.a.post("/api/posts", data={"text": LONG + " Ставьте реакции."}).json()["id"]
        # реакции молодых аккаунтов не считаются
        self.b.post(f"/api/posts/{pid}/react", {"type": "like"})
        economy.settle_incoming()
        self.assertEqual(economy._count(self.aid, economy.today(), "reactions_in")["n"], 0)
        db.run("UPDATE users SET created_at='2020-01-01T00:00:00.000Z' WHERE id=?", (self.bid,))
        economy.settle_incoming()
        after = self.kc(self.a)
        economy.settle_incoming()  # повтор ничего не добавляет
        self.assertEqual(self.kc(self.a), after)
        self.assertEqual(economy._count(self.aid, economy.today(), "reactions_in")["n"], 1)

    def test_swap_once(self):
        q = self.a.get("/api/wallet").json()["quests"]
        slot = next(x["slot"] for x in q if not x["done"])
        self.assertEqual(self.a.post(f"/api/quests/{slot}/swap").status_code, 200)
        other = next((x["slot"] for x in q if not x["done"] and x["slot"] != slot), None)
        if other:
            self.assertEqual(self.a.post(f"/api/quests/{other}/swap").status_code, 400)

    def test_levels(self):
        self.assertEqual(economy.level_for(0)["level"], 1)
        self.assertEqual(economy.level_for(4000)["level"], 10)
        self.assertEqual(economy.level_for(10 ** 9)["level"], 50)


if __name__ == "__main__":
    unittest.main()
