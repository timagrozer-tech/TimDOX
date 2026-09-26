"""Почта (коды, смена адреса) и коллекционные профили."""
import unittest
from unittest import mock

from starlette.testclient import TestClient

from test_api import Client  # noqa: F401 — настраивает окружение и тестовую базу
from test_stage2 import make_friends
from app import collection, db, mailer
from app.main import app
from app.security import rate_limiter


class MailCapture:
    def __init__(self):
        self.sent = []

    async def __call__(self, to, subject, text, link=None, code=None):
        self.sent.append({"to": to, "subject": subject, "code": code, "link": link})
        return True


class Stage3Test(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.ctx = TestClient(app).__enter__()
        cls.olga = Client().register("olga", "Ольга Ветрова")
        cls.petr = Client().register("petr", "Пётр Лесной")

    def setUp(self):
        rate_limiter.reset()

    def test_verify_code(self):
        cap = MailCapture()
        with mock.patch.object(mailer, "configured", return_value=True), mock.patch.object(mailer, "send", cap):
            self.assertEqual(self.olga.post("/api/auth/resend").status_code, 200)
            code = cap.sent[-1]["code"]
            self.assertRegex(code, r"^\d{6}$")
            self.assertIn("/verify?token=", cap.sent[-1]["link"])
            bad = self.olga.post("/api/auth/verify-code", {"code": "000000" if code != "000000" else "111111"})
            self.assertEqual(bad.status_code, 400)
            self.assertIn("Осталось попыток", bad.json()["error"])
            self.assertEqual(self.olga.post("/api/auth/verify-code", {"code": code}).status_code, 200)
        self.assertTrue(self.olga.refresh()["user"]["email_verified"])

    def test_resend_without_mail(self):
        with mock.patch.object(mailer, "configured", return_value=False):
            r = self.petr.post("/api/auth/resend")
        self.assertEqual(r.status_code, 503)

    def test_change_email(self):
        c = Client().register("sveta", "Света Ключ")
        self.assertEqual(c.post("/api/me/email", {"email": "petr@example.com", "password": "secret123"}).status_code, 422)
        self.assertEqual(c.post("/api/me/email", {"email": "new@mail.ru", "password": "wrong-pass"}).status_code, 422)
        cap = MailCapture()
        with mock.patch.object(mailer, "configured", return_value=True), mock.patch.object(mailer, "send", cap):
            r = c.post("/api/me/email", {"email": "Sveta.New@Mail.ru", "password": "secret123"})
            self.assertEqual(r.status_code, 200, r.text)
            self.assertEqual(r.json()["pending"], "sveta.new@mail.ru")
            self.assertEqual(cap.sent[-1]["to"], "sveta.new@mail.ru")
            self.assertEqual(c.get("/api/me/settings").json()["pending_email"], "sveta.new@mail.ru")
            ok = c.post("/api/me/email/confirm", {"code": cap.sent[-1]["code"]})
            self.assertEqual(ok.status_code, 200, ok.text)
            self.assertEqual(cap.sent[-1]["to"], "sveta@example.com")  # уведомление на старый адрес
        me = c.refresh()["user"]
        self.assertEqual(me["email"], "sveta.new@mail.ru")
        self.assertTrue(me["email_verified"])
        # без настроенной почты адрес меняется сразу, но становится неподтверждённым
        with mock.patch.object(mailer, "configured", return_value=False):
            r = c.post("/api/me/email", {"email": "sveta3@mail.ru", "password": "secret123"})
        self.assertTrue(r.json()["changed"])
        self.assertFalse(c.refresh()["user"]["email_verified"])

    def test_collection(self):
        c = Client().register("kolya", "Коля Звонов")
        friend = Client().register("tanya2", "Таня Смелая")
        col = c.get("/api/collection").json()
        self.assertEqual(col["owned_count"], 0)
        self.assertEqual(col["total"], len(collection.ITEMS))
        # нельзя надеть то, чего нет
        self.assertEqual(c.patch("/api/collection/equip", {"slot": "frame", "item_id": "frame_bronze"}).status_code, 403)
        # первая запись → бронзовая рамка, первый друг → «Пульс»
        c.post("/api/posts", data={"text": "Привет, Круг!"})
        make_friends(c, friend)
        col = c.get("/api/collection").json()
        owned = {i["id"] for i in col["items"] if i["owned"]}
        self.assertTrue({"frame_bronze", "anim_pulse"} <= owned, owned)
        notif = c.get("/api/notifications").json()["items"]
        self.assertTrue(any(n["type"] == "item" for n in notif))
        r = c.patch("/api/collection/equip", {"slot": "frame", "item_id": "frame_bronze"})
        self.assertEqual(r.json()["equipped"], {"frame": "frame_bronze"})
        self.assertEqual(c.patch("/api/collection/equip", {"slot": "pet", "item_id": "frame_bronze"}).status_code, 400)
        # рамку видят другие — в профиле и в карточках записей
        prof = friend.get("/api/users/kolya").json()
        self.assertEqual(prof["equipped"]["frame"], "frame_bronze")
        self.assertEqual(prof["user"]["frame"], "frame_bronze")
        self.assertTrue(any(i["id"] == "frame_bronze" for i in prof["showcase"]["owned"]))
        feed = friend.get("/api/feed").json()["items"]
        self.assertEqual(next(p for p in feed if p["author"]["username"] == "kolya")["author"]["frame"], "frame_bronze")
        # предмет остаётся навсегда, даже если запись удалена
        db.run("DELETE FROM posts WHERE author_id=(SELECT user_id FROM profiles WHERE username='kolya')")
        self.assertIn("frame_bronze", collection.owned(c.refresh()["user"]["id"]))
        c.patch("/api/collection/equip", {"slot": "frame", "item_id": None})
        self.assertEqual(friend.get("/api/users/kolya").json()["equipped"], {})


if __name__ == "__main__":
    unittest.main()
