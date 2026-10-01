"""Магазин: покупка сжигает монеты, рамку можно надеть только купленную, титул в профиле, подарки."""
import unittest

from test_api import Client
from app import db, economy
from app.security import rate_limiter


class ShopTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        rate_limiter.reset()
        cls.a = Client().register("shop_anna", "Анна Покупатель")
        cls.b = Client().register("shop_boris", "Борис Получатель")
        cls.aid = cls.a.refresh()["user"]["id"]
        economy.mint(cls.aid, 5000, kind="test")

    def setUp(self):
        rate_limiter.reset()

    def test_frame(self):
        self.assertEqual(self.a.patch("/api/collection/equip", {"slot": "frame", "item_id": "shop_frame_mint"}).status_code, 403)
        r = self.a.post("/api/shop/buy", {"item_id": "shop_frame_mint"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self.a.post("/api/shop/buy", {"item_id": "shop_frame_mint"}).status_code, 400)
        self.assertEqual(self.a.patch("/api/collection/equip", {"slot": "frame", "item_id": "shop_frame_mint"}).status_code, 200)
        prof = self.b.get("/api/users/shop_anna").json()
        self.assertEqual(prof["user"]["frame"], "shop_frame_mint")
        self.assertTrue(economy.audit()["ok"])

    def test_title_and_gift(self):
        self.assertEqual(self.a.post("/api/shop/title", {"item_id": "title_owl"}).status_code, 400)
        self.a.post("/api/shop/buy", {"item_id": "title_owl"})
        self.assertEqual(self.a.post("/api/shop/title", {"item_id": "title_owl"}).status_code, 200)
        self.assertEqual(self.b.get("/api/users/shop_anna").json()["title"], "Ночная сова")
        before = economy.balances(self.aid)["KC"]
        r = self.a.post("/api/shop/gift", {"to": "shop_boris", "item_id": "gift_cake", "note": "С днём рождения!"})
        self.assertEqual(r.status_code, 201, r.text)
        self.assertEqual(before - economy.balances(self.aid)["KC"], 150)
        gifts = self.a.get("/api/users/shop_boris").json()["gifts"]
        self.assertEqual(gifts[0]["emoji"], "🎂")
        self.assertEqual(self.a.post("/api/shop/gift", {"to": "shop_anna", "item_id": "gift_rose"}).status_code, 400)
        self.assertTrue(economy.audit()["ok"])


if __name__ == "__main__":
    unittest.main()
