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

if __name__ == "__main__":
    unittest.main()
