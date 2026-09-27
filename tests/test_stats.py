"""Личная статистика аккаунта: считает отклик других людей, не считает свои действия, видна только владельцу."""
import unittest

from test_api import Client  # noqa: F401 — настраивает окружение и тестовую базу
from app.security import rate_limiter


class StatsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.a = Client().register("statsanna", "Анна Стат")
        cls.b = Client().register("statsboris", "Борис Стат")
        cls.aid = cls.a.refresh()["user"]["id"]

    def setUp(self):
        rate_limiter.reset()

    def test_counts_only_other_people(self):
        r = self.a.c.post("/api/posts", data={"text": "Запись для статистики"}, headers=self.a._h())
        self.assertEqual(r.status_code, 201, r.text)
        pid = r.json()["id"]
        self.a.post(f"/api/posts/{pid}/react", {"type": "like"})          # своя реакция — не считается
        self.b.post(f"/api/posts/{pid}/react", {"type": "love"})
        self.b.post(f"/api/posts/{pid}/comments", {"text": "Здорово!"})
        self.a.post(f"/api/posts/{pid}/comments", {"text": "Спасибо"})    # свой комментарий — не считается
        self.b.post(f"/api/people/{self.aid}/follow")

        s = self.a.get("/api/me/stats?days=7")
        self.assertEqual(s.status_code, 200, s.text)
        d = s.json()
        self.assertEqual(d["totals"]["reactions"], 1)
        self.assertEqual(d["totals"]["comments"], 1)
        self.assertEqual(d["totals"]["posts"], 1)
        self.assertEqual(d["totals"]["followers"], 1)
        self.assertEqual(d["reactions_by_type"]["love"], 1)
        self.assertEqual(d["reactions_by_type"]["like"], 0)
        self.assertEqual(sum(x["reactions"] for x in d["timeline"]), 1)
        self.assertEqual(sum(d["hours"]), 2)
        self.assertEqual(d["top_posts"][0]["id"], pid)
        self.assertEqual(d["fans"][0]["username"], "statsboris")
        self.assertEqual(d["step"], "day")
        self.assertEqual(len(d["timeline"]), 8)

    def test_periods(self):
        for days, step in ((30, "day"), (90, "day"), (365, "week"), (0, "day")):
            d = self.a.get(f"/api/me/stats?days={days}").json()
            self.assertIn(d["step"], ("day", "week", "month"))
            if days:
                self.assertEqual(d["step"], step)
        self.assertEqual(self.a.get("/api/me/stats?days=5").status_code, 400)

    def test_requires_login(self):
        self.assertEqual(Client().get("/api/me/stats").status_code, 401)


if __name__ == "__main__":
    unittest.main()
