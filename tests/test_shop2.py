"""Магазин 2.0: ауры, эффекты имени, анимированные титулы, редкости, продажа на рынке."""
import json
import unittest

from test_api import Client
from app import db, economy, shop
from app.collection import parse_equipped
from app.security import rate_limiter


class Shop2Test(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        rate_limiter.reset()
        cls.a = Client().register("shop2_a", "Модник Первый")
        cls.uid = cls.a.refresh()["user"]["id"]
        economy.mint(cls.uid, 60000, kind="test")

    def setUp(self):
        rate_limiter.reset()

    def test_catalog(self):
        d = self.a.get("/api/shop").json()
        self.assertGreaterEqual(len(d["frames"]), 18)
        self.assertEqual(len(d["auras"]), 10)
        self.assertEqual(len(d["names"]), 8)
        self.assertGreaterEqual(len(d["titles"]), 14)
        self.assertGreaterEqual(len(d["gifts"]), 15)
        prism = next(x for x in d["frames"] if x["id"] == "shop_frame_prism")
        self.assertEqual((prism["rarity"], prism["new"]), ("legendary", True))
        self.assertEqual(next(x for x in d["titles"] if x["id"] == "title_legend")["style"], "gold")

    def test_aura_and_name(self):
        self.assertEqual(self.a.post("/api/shop/equip", {"slot": "aura", "item_id": "aura_galaxy"}).status_code, 400)  # не куплено
        self.assertEqual(self.a.post("/api/shop/buy", {"item_id": "aura_galaxy"}).status_code, 200)
        self.assertEqual(self.a.post("/api/shop/buy", {"item_id": "name_gold"}).status_code, 200)
        d = self.a.post("/api/shop/equip", {"slot": "aura", "item_id": "aura_galaxy"}).json()
        self.assertTrue(next(x for x in d["auras"] if x["id"] == "aura_galaxy")["on"])
        self.a.post("/api/shop/equip", {"slot": "namefx", "item_id": "name_gold"})
        self.assertEqual(self.a.post("/api/shop/equip", {"slot": "namefx", "item_id": "aura_galaxy"}).status_code, 400)  # не тот слот
        prof = self.a.get("/api/users/shop2_a").json()
        self.assertEqual((prof["equipped"]["aura"], prof["equipped"]["namefx"]), ("aura_galaxy", "name_gold"))
        # рамка из коллекции не сбрасывает ауру, снятие работает
        self.a.post("/api/shop/equip", {"slot": "aura", "item_id": None})
        self.assertNotIn("aura", self.a.get("/api/users/shop2_a").json()["equipped"])
        self.assertEqual(parse_equipped(json.dumps({"aura": "evil", "namefx": "name_gold", "x": 1})), {"namefx": "name_gold"})

    def test_title_style_and_market(self):
        self.a.post("/api/shop/buy", {"item_id": "title_cyber"})
        self.a.post("/api/shop/title", {"item_id": "title_cyber"})
        p = self.a.get("/api/users/shop2_a").json()
        self.assertEqual((p["title"], p["title_style"]), ("Киберпанк", "cyber"))
        self.a.post("/api/shop/buy", {"item_id": "aura_snow"})
        db.run("UPDATE users SET created_at='2020-01-01T00:00:00.000Z' WHERE id=?", (self.uid,))
        db.run("UPDATE shop_items SET acquired_at='2020-01-01T00:00:00.000Z' WHERE user_id=?", (self.uid,))
        self.a.post("/api/shop/equip", {"slot": "aura", "item_id": "aura_snow"})
        r = self.a.post("/api/market", {"item_id": "aura_snow", "price": 1000})
        self.assertEqual(r.status_code, 201, r.text)
        self.assertNotIn("aura", self.a.get("/api/users/shop2_a").json()["equipped"])  # выставленное снимается
        self.assertTrue(any(l["item"]["kind"] == "aura" for l in self.a.get("/api/market?kind=aura").json()["items"]))


if __name__ == "__main__":
    unittest.main()
