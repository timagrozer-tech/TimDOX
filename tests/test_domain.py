"""Свой домен: страницы со старого адреса onrender.com перенаправляются на APP_URL, API — нет."""
import unittest

from starlette.testclient import TestClient

from app import main


class DomainTest(unittest.TestCase):
    def test_redirect_only_pages(self):
        c = TestClient(main.CanonicalHost(main.app.app), base_url="https://krug-social.onrender.com")
        c.app.host = "qevi.ru"
        r = c.get("/u/yarko?tab=posts", follow_redirects=False)
        self.assertEqual((r.status_code, r.headers["location"]), (301, "https://qevi.ru/u/yarko?tab=posts"))
        self.assertNotEqual(c.get("/api/health", follow_redirects=False).status_code, 301)
        # пока APP_URL на onrender — никаких перенаправлений
        c.app.host = "krug-social.onrender.com"
        self.assertNotEqual(c.get("/", follow_redirects=False).status_code, 301)

    def test_legacy_domain_redirect(self):
        """Прежний домен qevi.ru открывается напрямую на Render (в России замедлен) — уводим на основной адрес"""
        c = TestClient(main.CanonicalHost(main.app.app), base_url="https://qevi.ru")
        c.app.host = "xn--j1aie3d.space"
        r = c.get("/music", follow_redirects=False)
        self.assertEqual((r.status_code, r.headers["location"]), (301, "https://xn--j1aie3d.space/music"))
        self.assertNotEqual(c.get("/api/health", follow_redirects=False).status_code, 301)
        own = TestClient(main.CanonicalHost(main.app.app), base_url="https://xn--j1aie3d.space")
        own.app.host = "xn--j1aie3d.space"
        self.assertNotEqual(own.get("/", follow_redirects=False).status_code, 301)


    def test_edge_proxy(self):
        """Российский прокси: подписанный запрос не перенаправляется, адрес посетителя берётся из его заголовка."""
        from unittest import mock
        from starlette.requests import Request
        from app import config, web
        c = TestClient(main.CanonicalHost(main.app.app), base_url="https://krug-social.onrender.com")
        c.app.host = "xn--j1aie3d.space"
        with mock.patch.object(config, "EDGE_SECRET", "s3cret"):
            self.assertEqual(c.get("/", headers={"x-yarko-edge": "wrong"}, follow_redirects=False).status_code, 301)
            self.assertNotEqual(c.get("/", headers={"x-yarko-edge": "s3cret"}, follow_redirects=False).status_code, 301)
            scope = {"type": "http", "headers": [(b"x-yarko-edge", b"s3cret"), (b"x-edge-client-ip", b"95.1.2.3")], "client": ("10.0.0.1", 1)}
            self.assertEqual(web.client_ip(Request(scope)), "95.1.2.3")
            forged = {"type": "http", "headers": [(b"x-yarko-edge", b"nope"), (b"x-edge-client-ip", b"95.1.2.3")], "client": ("10.0.0.1", 1)}
            self.assertNotEqual(web.client_ip(Request(forged)), "95.1.2.3")

    def test_migrate_env(self):
        """Переезд: настройки отдаются только с верным токеном и только пока он задан."""
        import os
        from unittest import mock
        c = TestClient(main.app)
        tok = "t" * 40
        with mock.patch.dict(os.environ, {"MIGRATE_TOKEN": tok, "GROQ_API_KEY": "gk-test", "RENDER": "true"}):
            self.assertEqual(c.post("/api/edge/env", headers={"x-migrate-token": "wrong"}).status_code, 404)
            r = c.post("/api/edge/env", headers={"x-migrate-token": tok})
            self.assertEqual(r.status_code, 200, r.text)
            self.assertEqual(r.json().get("GROQ_API_KEY"), "gk-test")
            self.assertNotIn("RENDER", r.json())
        self.assertEqual(c.post("/api/edge/env", headers={"x-migrate-token": tok}).status_code, 404)  # без токена в окружении

    def test_own_turn_credentials(self):
        import os, base64, hashlib, hmac
        from unittest import mock
        from app.api import calls
        with mock.patch.dict(os.environ, {"TURN_SECRET": "sec", "TURN_HOST": "turn.example"}):
            srv = calls.ice_servers(7)[0]
            self.assertIn("turn:turn.example:3478?transport=udp", srv["urls"])
            self.assertTrue(srv["username"].endswith(":7"))
            exp = base64.b64encode(hmac.new(b"sec", srv["username"].encode(), hashlib.sha1).digest()).decode()
            self.assertEqual(srv["credential"], exp)

if __name__ == "__main__":
    unittest.main()
