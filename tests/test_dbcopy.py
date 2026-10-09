"""Переезд базы на хостинг: копия всех таблиц в локальный SQLite с проверкой числа строк."""
import sqlite3
import tempfile
import unittest
from pathlib import Path

from test_api import Client  # noqa: F401 — настраивает окружение и тестовую базу
from app import db, dbcopy


class DbCopyTest(unittest.TestCase):
    def test_copy_all_tables(self):
        Client().register("dbcopy_user", "Копия Базы")
        db.run("INSERT OR IGNORE INTO media_files (path, content_type, data) VALUES (?,?,?)", ("t/x.bin", "image/png", b"\x00\x01blob"))
        with tempfile.TemporaryDirectory() as d:
            target = Path(d) / "yarko.db"
            stats = dbcopy.copy_to_sqlite(db.conn(), target, log=lambda m: None)
            self.assertTrue(target.exists())
            c = sqlite3.connect(target)
            for t in ("users", "profiles", "media_files"):
                self.assertEqual(c.execute(f"SELECT count(*) FROM {t}").fetchone()[0], db.value(f"SELECT count(*) FROM {t}"))
                self.assertEqual(stats[t], db.value(f"SELECT count(*) FROM {t}"))
            self.assertEqual(c.execute("SELECT data FROM media_files WHERE path='t/x.bin'").fetchone()[0], b"\x00\x01blob")
            self.assertNotIn("rt_events", stats)
            c.close()
            self.assertIsNotNone(dbcopy.backup(target))
            self.assertEqual(len(list((Path(d) / "backups").glob("yarko-*.db"))), 1)
