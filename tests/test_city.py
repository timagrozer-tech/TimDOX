"""Город: стартовые постройки, стройка за монеты, районы по уровню и населению, казна, визиты друзей."""
import unittest

from test_api import Client
from app import city, db, economy
from app.security import rate_limiter


class CityTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        rate_limiter.reset()
        cls.a = Client().register("city_anna", "Анна Город")
        cls.b = Client().register("city_boris", "Борис Город")
        cls.x = Client().register("city_xeno", "Чужой Город")
        cls.aid = cls.a.refresh()["user"]["id"]
        cls.bid = cls.b.refresh()["user"]["id"]

    def setUp(self):
        rate_limiter.reset()

    def test_start_and_build(self):
        v = self.a.get("/api/city/city_anna").json()
        kinds = sorted(b["kind"] for b in v["buildings"])
        self.assertEqual(kinds, ["hall", "nexus"])
        self.assertTrue(v["districts"][0]["open"])
        self.assertFalse(v["districts"][1]["open"])
        r = self.a.post("/api/city/build", {"kind": "house", "x": 4, "y": 4})
        self.assertEqual(r.status_code, 400)  # нет монет
        economy.mint(self.aid, 2000, kind="test")
        r = self.a.post("/api/city/build", {"kind": "house", "x": 4, "y": 4})
        self.assertEqual(r.status_code, 201, r.text)
        self.assertEqual(r.json()["kc"], 1900)
        self.assertEqual(self.a.post("/api/city/build", {"kind": "house", "x": 4, "y": 4}).status_code, 400)  # занято
        self.assertEqual(self.a.post("/api/city/build", {"kind": "house", "x": 2, "y": 2}).status_code, 400)  # район закрыт
        self.assertEqual(self.a.post("/api/city/build", {"kind": "apartment", "x": 4, "y": 5}).status_code, 400)  # не тот район
        self.assertEqual(self.a.post("/api/city/build", {"kind": "hall", "x": 4, "y": 6}).status_code, 400)
        house = next(b for b in r.json()["buildings"] if b["kind"] == "house")
        u = self.a.post(f"/api/city/buildings/{house['id']}/upgrade")
        self.assertEqual(u.status_code, 200, u.text)
        self.assertEqual(u.json()["kc"], 1900 - 160)
        self.assertEqual(u.json()["population"]["capacity"], 40)
        self.assertTrue(economy.audit()["ok"])
        hall = next(b for b in r.json()["buildings"] if b["kind"] == "hall")
        self.assertEqual(self.a.delete(f"/api/city/buildings/{hall['id']}").status_code, 400)

    def test_treasury_and_visits(self):
        r = self.b.post("/api/city/collect")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertGreater(r.json()["got"], 0)
        self.assertEqual(self.b.post("/api/city/collect").status_code, 400)
        # чужой не может зайти в гости
        self.assertEqual(self.x.post("/api/city/city_boris/visit", {"action": "postcard"}).status_code, 400)
        # дружба
        self.a.post(f"/api/people/{self.bid}/friend")
        self.b.post(f"/api/people/{self.aid}/friend")
        r = self.a.post("/api/city/city_boris/visit", {"action": "water"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["got"], 5)
        self.assertEqual(self.a.post("/api/city/city_boris/visit", {"action": "water"}).status_code, 400)
        v = self.b.get("/api/city/city_boris").json()
        self.assertEqual(v["guests"][0]["username"], "city_anna")
        self.assertGreaterEqual(v["population"]["want"], 10)

    def test_districts_rule(self):
        self.assertEqual(city.district_of(5, 5), "center")
        self.assertEqual(city.district_of(2, 9), "living")
        self.assertEqual(city.district_of(0, 0), "park")
        self.assertIsNone(city.district_of(12, 0))


if __name__ == "__main__":
    unittest.main()
