"""Живые миры GitHub и Telegram: разбор ответов, безопасные ссылки, кеш, доступ только к своему нику."""
import json
import unittest
from unittest import mock

from test_api import Client
from app import db, worlds
from app.security import rate_limiter

GH_USER = {"login": "timagrozer-tech", "name": "Tima", "avatar_url": "https://avatars.githubusercontent.com/u/1?v=4",
           "bio": "Yarko", "location": "Moscow", "public_repos": 7, "followers": 12, "following": 3,
           "created_at": "2024-05-01T00:00:00Z", "html_url": "https://github.com/timagrozer-tech"}
GH_REPOS = [
    {"name": "TimDOX", "description": "Соцсеть", "stargazers_count": 5, "language": "Python", "html_url": "https://github.com/timagrozer-tech/TimDOX", "fork": False, "pushed_at": "2026-10-01"},
    {"name": "forked", "stargazers_count": 999, "fork": True, "html_url": "https://github.com/x/forked"},
    {"name": "evil", "stargazers_count": 1, "html_url": "javascript:alert(1)", "fork": False},
]
TG_HTML = """<html><head>
<meta property="og:title" content="Yarko &amp; друзья">
<meta property="og:image" content="https://cdn4.telesco.pe/file/abc.jpg">
<meta property="og:description" content="Новости соцсети Yarko">
</head><body><div class="tgme_page_title" dir="auto"><span dir="auto">Yarko</span></div>
<div class="tgme_page_extra">12 345 subscribers</div></body></html>"""
TG_USER = """<meta property="og:title" content="Tima"><meta property="og:image" content="https://evil.example.com/p.jpg">
<meta property="og:description" content="You can contact @groom005 right away.">
<div class="tgme_page_title"><span>Tima</span></div><div class="tgme_page_extra">@groom005</div>"""


class WorldsTest(unittest.TestCase):
    def setUp(self):
        rate_limiter.reset()
        worlds._cache.clear()

    def test_github_parse(self):
        d = worlds.parse_github(GH_USER, GH_REPOS)
        self.assertTrue(d["ok"])
        self.assertEqual(d["repos"], 7)
        self.assertEqual([r["name"] for r in d["top"]], ["TimDOX", "evil"])  # форки не показываем
        self.assertIsNone(d["top"][1]["url"])                                # javascript: не пропускаем
        self.assertEqual(worlds.parse_github({}, [])["reason"], "not_found")
        self.assertEqual(worlds.github("../etc")["reason"], "bad_handle")

    def test_telegram_parse(self):
        d = worlds.parse_telegram(TG_HTML, "krug")
        self.assertEqual((d["title"], d["type"], d["count"]), ("Yarko & друзья", "channel", 12345))
        self.assertTrue(d["photo"].startswith("https://cdn4.telesco.pe/"))
        u = worlds.parse_telegram(TG_USER, "groom005")
        self.assertEqual((u["type"], u["desc"], u["photo"]), ("user", "", None))  # чужой домен картинки отброшен
        self.assertEqual(worlds.parse_telegram("<html></html>", "x")["reason"], "not_found")

    def test_endpoint(self):
        a = Client().register("world_owner", "Мир Владелец")
        b = Client().register("world_guest", "Мир Гость")
        items = [{"kind": "github", "value": "timagrozer-tech"}, {"kind": "telegram", "value": "groom005"}]
        self.assertEqual(a.put("/api/me/constellation", {"style": "cosmos", "items": items}).status_code, 200)

        def fake(url, accept="*/*"):
            if "api.github.com/users/timagrozer-tech/repos" in url:
                return json.dumps(GH_REPOS).encode()
            if "api.github.com/users/timagrozer-tech" in url:
                return json.dumps(GH_USER).encode()
            if url == "https://t.me/groom005":
                return TG_USER.encode()
            raise AssertionError(url)

        with mock.patch.object(worlds, "_get", side_effect=fake) as g:
            r = b.get("/api/users/world_owner/world/github")
            self.assertEqual(r.status_code, 200, r.text)
            self.assertEqual(r.json()["login"], "timagrozer-tech")
            b.get("/api/users/world_owner/world/github")
            self.assertEqual(g.call_count, 2)  # пользователь + репозитории, второй раз — из кеша
            self.assertEqual(b.get("/api/users/world_owner/world/telegram").json()["title"], "Tima")
        self.assertEqual(b.get("/api/users/world_owner/world/steam").status_code, 404)    # Steam не привязан
        self.assertEqual(b.get("/api/users/world_owner/world/youtube").status_code, 404)  # живого профиля нет
        db.run("UPDATE profiles SET profile_visibility='friends' WHERE username='world_owner'")
        self.assertEqual(b.get("/api/users/world_owner/world/github").status_code, 404)


if __name__ == "__main__":
    unittest.main()
