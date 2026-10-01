"""Constellation: белый список адресов, миры Круга с живыми числами, пространство профиля."""
import unittest

from test_api import Client
from app.security import rate_limiter
from app import constellation


class ConstellationTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        rate_limiter.reset()
        cls.a = Client().register("cst_anna", "Анна Созвездие")
        cls.b = Client().register("cst_boris", "Борис Гость")

    def test_normalize(self):
        self.assertEqual(constellation.normalize("github", "@octo")["url"], "https://github.com/octo")
        self.assertEqual(constellation.normalize("telegram", "https://t.me/krug")["handle"], "krug")
        with self.assertRaises(constellation.Invalid):
            constellation.normalize("github", "https://evil.example/x")
        with self.assertRaises(constellation.Invalid):
            constellation.normalize("website", "javascript:alert(1)")
        with self.assertRaises(constellation.Invalid):
            constellation.normalize("steam", "bad handle!")
        self.assertIsNone(constellation.normalize("riot", "Tima#EUW")["url"])

    def test_save_and_view(self):
        r = self.a.put("/api/me/constellation", {"style": "neural", "items": [
            {"kind": "github", "value": "octo"}, {"kind": "website", "value": "https://example.com"},
            {"kind": "network"}, {"kind": "github", "value": "octo"}, {"kind": "nope", "value": "x"}]})
        self.assertEqual(r.status_code, 400, r.text)  # неизвестный вид
        r = self.a.put("/api/me/constellation", {"style": "neural", "items": [
            {"kind": "github", "value": "octo"}, {"kind": "website", "value": "https://example.com"},
            {"kind": "network"}, {"kind": "github", "value": "octo"}]})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(len(r.json()["items"]), 3)  # дубль убран
        prof = self.b.get("/api/users/cst_anna").json()
        c = prof["constellation"]
        self.assertEqual(c["style"], "neural")
        self.assertEqual(c["items"][0]["url"], "https://github.com/octo")
        self.assertIn("friends", c["items"][2]["stats"])

    def test_space(self):
        r = self.a.put("/api/me/space", {"mode": "gamer", "order": ["constellation", "about", "evil"], "hidden": ["showcase", "posts"]})
        self.assertEqual(r.status_code, 200, r.text)
        d = r.json()
        self.assertEqual(d["mode"], "gamer")
        self.assertEqual(d["order"], ["constellation", "about", "showcase"])
        self.assertEqual(d["hidden"], ["showcase"])
        self.assertEqual(self.b.get("/api/users/cst_anna").json()["space"]["mode"], "gamer")


if __name__ == "__main__":
    unittest.main()
