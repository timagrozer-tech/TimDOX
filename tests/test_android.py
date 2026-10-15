"""Android-приложение: файл связи сайта с приложением (assetlinks) для полноэкранного режима без адресной строки."""
import unittest

from starlette.testclient import TestClient

from test_api import Client  # noqa: F401 — настраивает окружение и тестовую базу
from app.main import app


class AndroidTest(unittest.TestCase):
    def test_assetlinks(self):
        r = TestClient(app).get("/.well-known/assetlinks.json")
        self.assertEqual(r.status_code, 200)
        t = r.json()[0]["target"]
        self.assertEqual(t["package_name"], "space.yarko.app")
        self.assertRegex(t["sha256_cert_fingerprints"][0], r"^([0-9A-F]{2}:){31}[0-9A-F]{2}$")
        self.assertIn("delegate_permission/common.handle_all_urls", r.json()[0]["relation"])


if __name__ == "__main__":
    unittest.main()
