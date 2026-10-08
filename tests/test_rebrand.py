"""Ребрендинг KRUG → QEVI: старый адрес официального профиля, имя приложения, метаданные."""
import json
import unittest
from pathlib import Path

from test_api import Client
from app import config, db, updates


class RebrandTest(unittest.TestCase):
    def test_legacy_official_profile(self):
        # профиль со старым адресом (как на сайте до ребрендинга)
        if not db.value("SELECT 1 FROM profiles WHERE username='qevi'"):
            c = Client().register("krug_updates", "KRUG · Обновления")
            self.assertTrue(c)
        updates.migrate_legacy()
        self.assertIsNone(db.value("SELECT 1 FROM profiles WHERE username='krug_updates'"))
        row = db.one("SELECT username, name FROM profiles WHERE username='qevi'")
        self.assertEqual(row["name"], updates.NAME)
        viewer = Client().register("rebrand_viewer", "Зритель")
        # старая ссылка открывает новый профиль — и в API, и в превью ссылок
        self.assertEqual(viewer.get("/api/users/krug_updates").json()["user"]["username"], "qevi")
        page = viewer.c.get("/u/krug_updates").text
        self.assertIn("(@qevi) — QEVI", page)

    def test_brand_everywhere(self):
        self.assertEqual(config.APP_NAME, "QEVI")
        manifest = json.loads(Path("static/manifest.webmanifest").read_text())
        self.assertEqual((manifest["short_name"], manifest["theme_color"]), ("QEVI", "#0A0F2C"))
        html = Path("static/index.html").read_text()
        self.assertNotIn("Круг", html)
        self.assertNotIn("KRUG", html)


if __name__ == "__main__":
    unittest.main()
