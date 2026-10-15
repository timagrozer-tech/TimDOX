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
        self.assertEqual([x["target"]["package_name"] for x in r.json()], ["space.yarko.app", "space.yarko.player"])

    def test_player_pages(self):
        c = TestClient(app)
        r = c.get("/player", follow_redirects=False)
        self.assertEqual(r.status_code, 302)
        self.assertEqual(r.headers["location"], "/static/player/index.html")
        for f in ("index.html", "player.js", "player.css", "sw.js", "manifest.webmanifest", "icon-512.png"):
            self.assertEqual(c.get("/static/player/" + f).status_code, 200, f)

    def test_merge_existing_static_file(self):
        """Чужая запись в уже существующем файле на хостинге сохраняется, запись Yarko добавляется один раз"""
        import json, os, tempfile
        from app import android
        d = tempfile.mkdtemp()
        os.makedirs(os.path.join(d, ".well-known"))
        path = os.path.join(d, ".well-known", "assetlinks.json")
        json.dump([{"relation": ["x"], "target": {"namespace": "android_app", "package_name": "other.app", "sha256_cert_fingerprints": ["AA"]}}], open(path, "w"))
        self.assertTrue(android.merge_static_assetlinks(d))
        self.assertFalse(android.merge_static_assetlinks(d))
        names = [x["target"]["package_name"] for x in json.load(open(path))]
        self.assertEqual(names, ["other.app", "space.yarko.app", "space.yarko.player"])
        self.assertFalse(android.merge_static_assetlinks(tempfile.mkdtemp()))  # файла нет — ничего не создаём


if __name__ == "__main__":
    unittest.main()
