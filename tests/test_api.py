"""Интеграционные тесты API. Запуск: python -m unittest discover -s tests -v"""
import io
import os
import tempfile
import logging
import unittest

_tmp = tempfile.mkdtemp()
os.environ["DB_PATH"] = os.path.join(_tmp, "test.db")
os.environ["UPLOAD_DIR"] = os.path.join(_tmp, "uploads")
os.environ["DATA_DIR"] = _tmp
os.environ["SMTP_HOST"] = ""
os.environ.setdefault("REGISTER_PER_HOUR", "100000")  # в тестах все аккаунты создаются с одного адреса
os.environ.setdefault("REGISTER_PER_DAY", "100000")
os.environ.setdefault("NEW_DIALOGS_NEW_ACCOUNT", "100000")

logging.disable(logging.WARNING)
from PIL import Image  # noqa: E402
from starlette.testclient import TestClient  # noqa: E402

from app import config, db  # noqa: E402
from app.main import app  # noqa: E402
from app.security import rate_limiter  # noqa: E402


def png_bytes(color=(200, 50, 50), size=(800, 600)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, "PNG")
    return buf.getvalue()


class Client:
    def __init__(self):
        self.c = TestClient(app, base_url="http://testserver")
        self.csrf = None

    def _h(self):
        return {"X-CSRF-Token": self.csrf} if self.csrf else {}

    def refresh(self):
        me = self.c.get("/api/auth/me").json()
        self.csrf = me.get("csrf")
        return me

    def get(self, url, **kw):
        return self.c.get(url, **kw)

    def post(self, url, json=None, **kw):
        return self.c.post(url, json=json, headers=self._h(), **kw)

    def patch(self, url, json=None):
        return self.c.patch(url, json=json, headers=self._h())

    def delete(self, url, json=None):
        return self.c.request("DELETE", url, json=json, headers=self._h())

    def register(self, username, name, email=None, city=""):
        r = self.post("/api/auth/register", {"email": email or f"{username}@example.com", "password": "secret123",
                                             "name": name, "username": username, "consent": True})
        assert r.status_code == 201, r.text
        self.refresh()
        if city:
            self.patch("/api/me/settings", {"city": city})
        return self


class ApiTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.ctx = TestClient(app).__enter__()  # запускает lifespan (подключение к БД)

    def setUp(self):
        rate_limiter.reset()

    def test_full_mvp_flow(self):
        anna = Client().register("anna", "Анна Смирнова", city="Казань")
        boris = Client().register("boris", "Борис Иванов", city="Казань")
        me = anna.refresh()["user"]
        bid = boris.refresh()["user"]["id"]

        # без CSRF-токена запись запрещена
        r = anna.c.post("/api/posts", data={"text": "x"})
        self.assertEqual(r.status_code, 403)

        # подтверждение почты по ссылке из письма
        outbox = (config.DATA_DIR / "outbox.log").read_text(encoding="utf-8")
        token = outbox.split("/verify?token=")[1].split()[0]
        self.assertEqual(anna.post("/api/auth/verify", {"token": token}).status_code, 200)
        self.assertTrue(anna.refresh()["user"]["email_verified"])

        # поиск и заявка в друзья
        found = anna.get("/api/search?q=борис").json()["people"]
        self.assertEqual(found[0]["username"], "boris")
        self.assertEqual(anna.post(f"/api/people/{bid}/friend").json()["relation"]["status"], "request_sent")
        self.assertEqual(boris.get("/api/auth/me").json()["counters"]["friend_requests"], 1)
        self.assertEqual(boris.post(f"/api/people/{me['id']}/friend/accept").json()["relation"]["status"], "friends")

        # пост с фото, хэштегом и упоминанием; только для друзей
        r = anna.post("/api/posts", data={"text": "Привет, #Казань! @boris смотри", "visibility": "friends",
                                          "alts": ["Закат"]},
                      files=[("photos", ("a.png", png_bytes(), "image/png"))])
        self.assertEqual(r.status_code, 201, r.text)
        post = r.json()
        self.assertEqual(len(post["media"]), 1)
        self.assertTrue(post["media"][0]["url"].endswith(".webp"))
        self.assertEqual(anna.get(post["media"][0]["url"]).status_code, 200)

        # в ленте у Бориса
        feed = boris.get("/api/feed").json()["items"]
        self.assertEqual(feed[0]["id"], post["id"])

        # реакция и комментарий -> уведомления у Анны
        self.assertEqual(boris.post(f"/api/posts/{post['id']}/react", {"type": "love"}).json()["total"], 1)
        c = boris.post(f"/api/posts/{post['id']}/comments", {"text": "Красиво!"}).json()
        anna.post(f"/api/posts/{post['id']}/comments", {"text": "Спасибо", "parent_id": c["id"]})
        tree = anna.get(f"/api/posts/{post['id']}/comments").json()
        self.assertEqual(len(tree["items"][0]["replies"]), 1)
        types = [n["type"] for n in anna.get("/api/notifications").json()["items"]]
        self.assertIn("reaction", types)
        self.assertIn("comment", types)
        self.assertIn("friend_accept", types)
        self.assertIn("mention", [n["type"] for n in boris.get("/api/notifications").json()["items"]])

        # хэштег и тренды (пост «для друзей» не должен попасть в публичные тренды)
        self.assertEqual(boris.get("/api/tags/казань").json()["items"][0]["id"], post["id"])
        pub = anna.post("/api/posts", data={"text": "Публичный #казань"}).json()
        self.assertIn("казань", [t["tag"] for t in anna.get("/api/trends").json()["items"]])

        # посторонний не видит пост «для друзей»
        vera = Client().register("vera", "Вера")
        self.assertEqual(vera.get(f"/api/posts/{post['id']}").status_code, 404)
        self.assertEqual(vera.get(f"/api/posts/{pub['id']}").status_code, 200)

        # репост и цитата
        self.assertTrue(boris.post(f"/api/posts/{pub['id']}/repost").json()["reposted"])
        q = boris.post("/api/posts", data={"text": "Согласен", "quote_of": str(pub["id"])}).json()
        self.assertEqual(q["quote"]["id"], pub["id"])
        self.assertEqual(anna.get(f"/api/posts/{pub['id']}").json()["reposts_count"], 2)

        # закладки
        boris.post(f"/api/posts/{pub['id']}/bookmark")
        self.assertEqual(boris.get("/api/bookmarks").json()["items"][0]["id"], pub["id"])

        # сообщения
        conv = anna.post("/api/conversations", {"user_id": bid}).json()
        m = anna.post(f"/api/conversations/{conv['id']}/messages", {"text": "Привет, Борис!"})
        self.assertEqual(m.status_code, 201)
        self.assertEqual(boris.get("/api/counters").json()["messages"], 1)
        convs = boris.get("/api/conversations").json()["items"]
        self.assertEqual(convs[0]["last_message"]["text"], "Привет, Борис!")
        boris.post(f"/api/conversations/{convs[0]['id']}/read")
        self.assertEqual(boris.get("/api/counters").json()["messages"], 0)

        # блокировка: разрывает дружбу и запрещает писать
        anna.post(f"/api/people/{bid}/block")
        self.assertEqual(boris.post(f"/api/conversations/{conv['id']}/messages", {"text": "?"}).status_code, 403)
        self.assertEqual(boris.get(f"/api/posts/{post['id']}").status_code, 404)
        anna.delete(f"/api/people/{bid}/block")

        # профиль и приватность
        anna.patch("/api/me/settings", {"profile_visibility": "friends", "bio": "Люблю Казань"})
        prof = vera.get("/api/users/anna").json()
        self.assertTrue(prof["hidden"])
        self.assertNotIn("bio", prof)

        # фильтр запрещённых слов
        bad = vera.post("/api/posts", data={"text": "ну ты и мудак"}).json()
        self.assertNotIn("мудак", bad["text"])

        # экспорт и удаление аккаунта
        exp = vera.get("/api/me/export")
        self.assertEqual(exp.status_code, 200)
        self.assertEqual(exp.json()["profile"]["username"], "vera")
        self.assertEqual(vera.delete("/api/me", {"password": "wrong"}).status_code, 400)
        self.assertEqual(vera.delete("/api/me", {"password": "secret123"}).status_code, 200)
        self.assertIsNone(db.value("SELECT 1 FROM users WHERE email='vera@example.com'"))

    def test_password_reset_and_validation(self):
        c = Client().register("gleb", "Глеб")
        r = c.post("/api/auth/register", {"email": "bad", "password": "123", "name": "x", "username": "!", "consent": False})
        self.assertEqual(r.status_code, 422)
        self.assertEqual(set(r.json()["fields"]), {"email", "password", "name", "username", "consent"})
        anon = Client()
        anon.post("/api/auth/forgot", {"email": "gleb@example.com"})
        outbox = (config.DATA_DIR / "outbox.log").read_text(encoding="utf-8")
        token = outbox.rsplit("/reset?token=", 1)[1].split()[0]
        self.assertEqual(anon.post("/api/auth/reset", {"token": token, "password": "newpass123"}).status_code, 200)
        anon.refresh()  # после сброса пароля выдаётся новая сессия
        self.assertEqual(anon.post("/api/auth/reset", {"token": token, "password": "newpass123"}).status_code, 400)
        fresh = Client()
        self.assertEqual(fresh.post("/api/auth/login", {"email": "gleb", "password": "newpass123"}).status_code, 200)
        self.assertEqual(Client().post("/api/auth/login", {"email": "gleb", "password": "secret123"}).status_code, 400)

    def test_rate_limit_login(self):
        c = Client()
        codes = [c.post("/api/auth/login", {"email": "nobody", "password": "x"}).status_code for _ in range(12)]
        self.assertIn(429, codes)

    def test_rejects_non_image(self):
        c = Client().register("dina", "Дина")
        r = c.post("/api/posts", data={"text": "файл"}, files=[("photos", ("x.png", b"not an image", "image/png"))])
        self.assertEqual(r.status_code, 400)


if __name__ == "__main__":
    unittest.main()
