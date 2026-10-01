"""Рынок: удержание 7 дней, коридор цен, депозит предмета, комиссии сгорают, двойной покупки нет."""
import unittest

from test_api import Client
from app import db, economy, market
from app.security import rate_limiter


class MarketTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        rate_limiter.reset()
        cls.s = Client().register("mkt_seller", "Сева Продавец")
        cls.b = Client().register("mkt_buyer", "Варя Покупатель")
        cls.sid = cls.s.refresh()["user"]["id"]
        cls.bid = cls.b.refresh()["user"]["id"]
        db.run("UPDATE sessions SET user_agent='dev-s' WHERE user_id=?", (cls.sid,))
        db.run("UPDATE sessions SET user_agent='dev-b' WHERE user_id=?", (cls.bid,))
        economy.mint(cls.sid, 2000, kind="test")
        economy.mint(cls.bid, 5000, kind="test")
        cls.s.post("/api/shop/buy", {"item_id": "shop_frame_ice"})

    def setUp(self):
        rate_limiter.reset()

    def test_flow(self):
        # молодой аккаунт и свежая покупка — продавать нельзя
        db.run("UPDATE users SET created_at=? WHERE id=?", (db.now(), self.sid))
        self.assertEqual(self.s.post("/api/market", {"item_id": "shop_frame_ice", "price": 900}).status_code, 400)
        db.run("UPDATE users SET created_at='2020-01-01T00:00:00.000Z' WHERE id=?", (self.sid,))
        db.run("UPDATE shop_items SET acquired_at=? WHERE user_id=? AND item_id='shop_frame_ice'", (db.now(), self.sid))
        self.assertEqual(self.s.post("/api/market", {"item_id": "shop_frame_ice", "price": 900}).status_code, 400)
        db.run("UPDATE shop_items SET acquired_at='2020-01-01T00:00:00.000Z' WHERE user_id=?", (self.sid,))
        self.assertEqual(self.s.post("/api/market", {"item_id": "shop_frame_ice", "price": 100}).status_code, 400)  # ниже коридора
        before = economy.balances(self.sid)["KC"]
        r = self.s.post("/api/market", {"item_id": "shop_frame_ice", "price": 1000})
        self.assertEqual(r.status_code, 201, r.text)
        lid = r.json()["id"]
        self.assertEqual(before - economy.balances(self.sid)["KC"], 10)  # 1% сбор
        self.assertFalse(db.value("SELECT 1 FROM shop_items WHERE user_id=? AND item_id='shop_frame_ice'", (self.sid,)))
        items = self.b.get("/api/market").json()["items"]
        self.assertTrue(any(x["id"] == lid for x in items))
        self.assertEqual(self.s.post(f"/api/market/{lid}/buy").status_code, 400)  # свой лот
        before_s = economy.balances(self.sid)["KC"]
        r = self.b.post(f"/api/market/{lid}/buy")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(economy.balances(self.sid)["KC"] - before_s, 930)  # 7% сгорело
        self.assertTrue(db.value("SELECT 1 FROM shop_items WHERE user_id=? AND item_id='shop_frame_ice'", (self.bid,)))
        self.assertEqual(self.b.post(f"/api/market/{lid}/buy").status_code, 400)  # уже продан
        self.assertEqual(market.reference_price("shop_frame_ice"), 1000)
        self.assertTrue(economy.audit()["ok"])

    def test_cancel_returns_item(self):
        self.s.post("/api/shop/buy", {"item_id": "shop_frame_mint"})
        db.run("UPDATE users SET created_at='2020-01-01T00:00:00.000Z' WHERE id=?", (self.sid,))
        db.run("UPDATE shop_items SET acquired_at='2020-01-01T00:00:00.000Z' WHERE user_id=?", (self.sid,))
        lid = self.s.post("/api/market", {"item_id": "shop_frame_mint", "price": 300}).json()["id"]
        self.assertEqual(self.s.delete(f"/api/market/{lid}").status_code, 200)
        self.assertTrue(db.value("SELECT 1 FROM shop_items WHERE user_id=? AND item_id='shop_frame_mint'", (self.sid,)))
        self.assertEqual(self.b.post(f"/api/market/{lid}/buy").status_code, 400)


if __name__ == "__main__":
    unittest.main()
