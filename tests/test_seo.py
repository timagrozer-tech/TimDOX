"""Превью ссылок: открытое — карточкой, закрытое не раскрывается, всё экранировано."""
import io
import unittest

from test_api import Client
from app import db
from app.security import rate_limiter


class SeoTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        rate_limiter.reset()
        cls.a = Client().register("seo_open", "Открытый <Автор>")
        cls.b = Client().register("seo_closed", "Скрытый Автор")
        db.run("UPDATE profiles SET bio='Пишу про \"дизайн\" & код', profile_visibility='public' WHERE username='seo_open'")
        db.run("UPDATE profiles SET bio='секретная биография', profile_visibility='friends' WHERE username='seo_closed'")
        cls.pub = cls.a.post("/api/posts", data={"text": "Открытый пост про KRUG", "visibility": "public"}).json()["id"]
        cls.priv = cls.a.post("/api/posts", data={"text": "Тайный пост только друзьям", "visibility": "friends"}).json()["id"]
        cls.hidden = cls.b.post("/api/posts", data={"text": "Пост закрытого автора", "visibility": "public"}).json()["id"]

    def page(self, path):
        r = Client().get(path)
        self.assertEqual(r.status_code, 200)
        self.assertIn('<div id="app">', r.text)  # это всё ещё SPA
        return r.text

    def test_profile(self):
        h = self.page("/u/seo_open")
        self.assertIn('og:title" content="Открытый &lt;Автор&gt; (@seo_open) — Круг"', h)
        self.assertIn("Пишу про &quot;дизайн&quot; &amp; код", h)
        self.assertNotIn("<Автор>", h)
        h = self.page("/u/seo_closed")
        self.assertNotIn("секретная биография", h)
        self.assertIn("Закрытый профиль", h)

    def test_posts(self):
        self.assertIn("Открытый пост про KRUG", self.page(f"/post/{self.pub}"))
        self.assertNotIn("Тайный пост", self.page(f"/post/{self.priv}"))
        self.assertNotIn("Пост закрытого автора", self.page(f"/post/{self.hidden}"))

    def test_defaults(self):
        h = self.page("/")
        self.assertIn('og:image" content="', h)
        self.assertIn("/static/img/og.png", h)
        self.assertIn("summary_large_image", h)
        self.assertIn("Круг", self.page("/u/nobody_here_404"))
        self.assertIn("Круг", self.page("/post/999999"))


if __name__ == "__main__":
    unittest.main()
