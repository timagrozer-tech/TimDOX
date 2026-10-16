"""«Фильм о вас»: данные для ролика — цифры, друзья, лучший пост, слово года."""
import unittest

from starlette.testclient import TestClient

from test_api import Client  # noqa: F401 — настраивает окружение и тестовую базу
from app.main import app
from app.security import rate_limiter


class FilmTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.ctx = TestClient(app).__enter__()
        cls.me = Client().register("film_star", "Фильм Звезда")
        cls.fr = Client().register("film_friend", "Фильм Друг")
        cls.me_id = cls.me.refresh()["user"]["id"]
        cls.fr_id = cls.fr.refresh()["user"]["id"]

    def setUp(self):
        rate_limiter.reset()

    def test_film_data(self):
        self.assertEqual(self.me.get("/api/film").json()["counts"]["posts"], 0)  # пустой профиль тоже работает
        self.me.post(f"/api/people/{self.fr_id}/friend")
        self.fr.post(f"/api/people/{self.me_id}/friend/accept")
        a = self.me.post("/api/posts", data={"text": "Летний закат над Волгой, лето лучше всего"}).json()
        self.me.post("/api/posts", data={"text": "Снова лето и снова закат"})
        self.fr.post(f"/api/posts/{a['id']}/react", {"type": "love"})
        d = self.me.get("/api/film").json()
        self.assertEqual(d["counts"]["posts"], 2)
        self.assertEqual(d["counts"]["friends"], 1)
        self.assertEqual(d["counts"]["reactions"], 1)
        self.assertEqual(d["top_post"]["id"], a["id"])
        self.assertEqual(d["top_friend"]["username"], "film_friend")
        self.assertIn(d["word"]["word"], ("лето", "закат"))
        self.assertEqual(len(d["times"]), 2)
        self.assertEqual(d["me"]["username"], "film_star")
        self.assertEqual(Client().get("/api/film").status_code, 401)


if __name__ == "__main__":
    unittest.main()
