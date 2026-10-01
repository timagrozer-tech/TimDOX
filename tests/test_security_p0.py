"""Этап 1: исправления P0 из аудита — IP за прокси, лимит тела запроса, жалобы, квоты загрузок,
поток событий после выхода, потокобезопасность базы, сжатие ответов."""
import threading
import time
import unittest

from starlette.requests import Request

from test_api import Client, png_bytes  # noqa: F401 — настраивает окружение и тестовую базу
from app import config, db, main, media, web
from app.api import messages
from app.security import rate_limiter, token_hash


def _req(headers: dict, client=("10.0.0.9", 1234)) -> Request:
    return Request({"type": "http", "method": "GET", "path": "/", "client": client,
                    "headers": [(k.lower().encode(), v.encode()) for k, v in headers.items()]})


class ClientIpTest(unittest.TestCase):
    def tearDown(self):
        config.ON_RENDER, config.TRUSTED_PROXY_HOPS = False, 0

    def test_spoofed_forwarded_for_is_ignored(self):
        # без доверенного прокси заголовок присылает сам клиент — ему не верим
        self.assertEqual(web.client_ip(_req({"X-Forwarded-For": "1.2.3.4"})), "10.0.0.9")

    def test_render_uses_cloudflare_header(self):
        config.ON_RENDER = True
        r = _req({"X-Forwarded-For": "6.6.6.6, 81.97.145.24, 172.71.195.123, 10.226.90.65", "CF-Connecting-IP": "81.97.145.24"})
        self.assertEqual(web.client_ip(r), "81.97.145.24")
        # без заголовков Cloudflare — третий с конца адрес цепочки, а не подделанный первый
        r = _req({"X-Forwarded-For": "6.6.6.6, 81.97.145.24, 172.71.195.123, 10.226.90.65"})
        self.assertEqual(web.client_ip(r), "81.97.145.24")

    def test_trusted_hops(self):
        config.TRUSTED_PROXY_HOPS = 1
        self.assertEqual(web.client_ip(_req({"X-Forwarded-For": "6.6.6.6, 5.5.5.5"})), "5.5.5.5")


class P0Test(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        rate_limiter.reset()
        cls.a = Client().register("p0anna", "Анна Пэноль")
        cls.b = Client().register("p0boris", "Борис Пэноль")
        cls.aid = cls.a.refresh()["user"]["id"]
        cls.bid = cls.b.refresh()["user"]["id"]

    def setUp(self):
        rate_limiter.reset()

    def test_json_body_limit(self):
        big = "x" * (config.MAX_JSON_KB * 1024 + 10)
        r = self.a.post("/api/posts/1/comments", {"text": big})
        self.assertEqual(r.status_code, 413)

    def test_streamed_body_without_length_is_cut(self):
        def gen():
            for _ in range(config.MAX_JSON_KB + 8):
                yield b"x" * 1024
        r = self.a.c.post("/api/reports", content=gen(), headers={**self.a._h(), "Content-Type": "application/json"})
        self.assertEqual(r.status_code, 413)

    def test_reports_require_visibility(self):
        r = self.b.c.post("/api/posts", data={"text": "Только для друзей", "visibility": "friends"}, headers=self.b._h())
        self.assertEqual(r.status_code, 201, r.text)
        pid = r.json()["id"]
        self.assertEqual(self.a.post("/api/reports", {"target_type": "post", "target_id": pid, "reason": "спам"}).status_code, 404)
        pub = self.b.c.post("/api/posts", data={"text": "Всем привет", "visibility": "public"}, headers=self.b._h()).json()["id"]
        self.assertEqual(self.a.post("/api/reports", {"target_type": "post", "target_id": pub, "reason": "спам"}).status_code, 200)
        self.assertEqual(self.a.post("/api/reports", {"target_type": "message", "target_id": 999999, "reason": "спам"}).status_code, 404)
        self.assertEqual(self.a.post("/api/reports", {"target_type": "user", "target_id": self.aid, "reason": "спам"}).status_code, 404)
        self.assertEqual(self.a.post("/api/reports", {"target_type": "user", "target_id": self.bid, "reason": "спам"}).status_code, 200)

    def test_upload_quota(self):
        saved = config.UPLOAD_DAY_FILES_UNVERIFIED
        config.UPLOAD_DAY_FILES_UNVERIFIED = 2
        try:
            c = Client().register("p0quota", "Квота Тест")
            codes = []
            for _ in range(3):
                rate_limiter.reset()
                r = c.c.post("/api/me/avatar", files={"file": ("a.png", png_bytes(), "image/png")}, headers=c._h())
                codes.append(r.status_code)
            self.assertEqual(codes, [200, 200, 429])
            self.assertIn("e-mail", c.c.post("/api/me/avatar", files={"file": ("a.png", png_bytes(), "image/png")},
                                            headers=c._h()).json()["error"])
        finally:
            config.UPLOAD_DAY_FILES_UNVERIFIED = saved

    def test_stream_session_check(self):
        c = Client().register("p0stream", "Поток Тест")
        token = c.c.cookies.get(config.SESSION_COOKIE)
        sid = token_hash(token)
        self.assertTrue(messages.session_alive(sid))
        c.post("/api/auth/logout")
        self.assertFalse(messages.session_alive(sid))

    def test_gzip_api(self):
        r = self.a.c.get("/api/auth/me", headers={"Accept-Encoding": "gzip"})
        self.assertEqual(r.status_code, 200)
        page = self.a.c.get("/static/js/app.js", headers={"Accept-Encoding": "gzip"})
        self.assertEqual(page.headers.get("content-encoding"), "gzip")
        spa = self.a.c.get("/feed", headers={"Accept-Encoding": "gzip"})
        self.assertEqual(spa.headers.get("content-encoding"), "gzip")


class DbThreadSafetyTest(unittest.TestCase):
    def test_transaction_does_not_swallow_other_threads(self):
        db.run("CREATE TABLE IF NOT EXISTS _lock_probe (n INTEGER)")
        db.run("DELETE FROM _lock_probe")
        started = threading.Event()

        def failing_tx():
            try:
                with db.tx() as c:
                    c.execute("INSERT INTO _lock_probe (n) VALUES (1)")
                    started.set()
                    time.sleep(0.3)
                    raise RuntimeError("откат")
            except RuntimeError:
                pass

        t = threading.Thread(target=failing_tx)
        t.start()
        started.wait(2)
        db.run("INSERT INTO _lock_probe (n) VALUES (2)")  # раньше попадала в чужую транзакцию и откатывалась вместе с ней
        t.join()
        self.assertEqual([r["n"] for r in db.all("SELECT n FROM _lock_probe")], [2])
        db.run("DROP TABLE _lock_probe")


if __name__ == "__main__":
    unittest.main()
