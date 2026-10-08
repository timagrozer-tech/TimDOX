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


if __name__ == "__main__":
    unittest.main()
