"""«Что угодно» в сообщениях: любые файлы (только скачиванием), местоположение, контакт."""
import io
import unittest
from unittest import mock

from test_api import Client
from app import config
from app.security import rate_limiter


class AttachmentsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        rate_limiter.reset()
        cls.a = Client().register("att_a", "Файл Отправитель")
        cls.b = Client().register("att_b", "Файл Получатель")
        cls.c = Client().register("att_c", "Посторонний Человек")
        cls.bid = cls.b.refresh()["user"]["id"]
        cls.cid = cls.c.refresh()["user"]["id"]
        cls.conv = cls.a.post("/api/conversations", {"user_id": cls.bid}).json()["id"]

    def setUp(self):
        rate_limiter.reset()

    def send_file(self, name, data, ctype="application/octet-stream", client=None):
        return (client or self.a).post(f"/api/conversations/{self.conv}/media", data={"type": "file"},
                                       files={"file": (name, io.BytesIO(data), ctype)})

    def test_any_file_download_only(self):
        r = self.send_file("Отчёт за 2026.pdf", b"%PDF-1.7 hello", "application/pdf")
        self.assertEqual(r.status_code, 201, r.text)
        m = r.json()
        self.assertEqual((m["kind"], m["media"]["name"], m["media"]["ext"]), ("file", "Отчёт за 2026.pdf", "pdf"))
        self.assertTrue(m["media"]["url"].endswith(".bin"))
        d = self.b.get(m["media"]["url"] + "?dl=Отчёт за 2026.pdf")
        self.assertEqual(d.status_code, 200)
        self.assertEqual(d.content, b"%PDF-1.7 hello")
        self.assertEqual(d.headers["content-type"], "application/octet-stream")
        self.assertIn("attachment", d.headers["content-disposition"])
        self.assertIn("filename*=UTF-8''", d.headers["content-disposition"])

    def test_html_never_renders(self):
        m = self.send_file("evil.html", b"<script>alert(1)</script>", "text/html").json()
        d = self.b.get(m["media"]["url"])
        self.assertEqual(d.headers["content-type"], "application/octet-stream")
        self.assertIn("attachment", d.headers["content-disposition"])
        self.assertEqual(d.headers.get("x-content-type-options"), "nosniff")
        # имя с путём и кавычками не ломает заголовок
        m = self.send_file('../../etc/"pass".txt', b"x").json()
        self.assertEqual(m["media"]["name"], '"pass".txt')
        h = self.b.get(m["media"]["url"] + "?dl=%22a%22%0D%0AX-Evil:%201").headers
        self.assertNotIn("x-evil", h)

    def test_limits_and_access(self):
        with mock.patch.object(config, "MAX_FILE_MB", 1):
            self.assertEqual(self.send_file("big.zip", b"0" * (1024 * 1024 + 10)).status_code, 413)
        self.assertEqual(self.send_file("empty.txt", b"").status_code, 400)
        self.assertIn(self.send_file("x.txt", b"x", client=self.c).status_code, (403, 404))  # не участник беседы

    def test_location_and_contact(self):
        r = self.a.post(f"/api/conversations/{self.conv}/share", {"type": "location", "lat": 55.751244, "lon": 37.618423, "acc": 12})
        self.assertEqual(r.status_code, 201, r.text)
        self.assertEqual((r.json()["kind"], r.json()["media"]["lat"], r.json()["media"]["acc"]), ("location", 55.751244, 12))
        self.assertEqual(self.a.post(f"/api/conversations/{self.conv}/share", {"type": "location", "lat": 95, "lon": 0}).status_code, 400)
        r = self.a.post(f"/api/conversations/{self.conv}/share", {"type": "contact", "user_id": self.cid})
        self.assertEqual(r.status_code, 201, r.text)
        self.assertEqual((r.json()["kind"], r.json()["media"]["username"]), ("contact", "att_c"))
        self.assertEqual(self.a.post(f"/api/conversations/{self.conv}/share", {"type": "contact", "user_id": 999999}).status_code, 404)
        self.assertEqual(self.a.post(f"/api/conversations/{self.conv}/share", {"type": "rocket"}).status_code, 400)
        items = self.b.get("/api/conversations").json()["items"]
        last = next(c for c in items if c["id"] == self.conv)["last_message"]
        self.assertEqual(last["kind"], "contact")


if __name__ == "__main__":
    unittest.main()
