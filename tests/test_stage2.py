"""Тесты Этапа 2: истории, сообщества, беседы, мероприятия, круги, гости, одноклассники."""
import unittest
from datetime import datetime, timedelta, timezone

from starlette.testclient import TestClient

from test_api import Client, png_bytes  # noqa: F401 — настраивает окружение и тестовую базу
from app import db
from app.main import app
from app.security import rate_limiter


def make_friends(a: Client, b: Client):
    bid = b.refresh()["user"]["id"]
    aid = a.refresh()["user"]["id"]
    a.post(f"/api/people/{bid}/friend")
    b.post(f"/api/people/{aid}/friend/accept")
    return aid, bid


class Stage2Test(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.ctx = TestClient(app).__enter__()
        cls.kate = Client().register("kate", "Катя Белова", city="Тула")
        cls.lev = Client().register("lev", "Лев Орлов", city="Тула")
        cls.mila = Client().register("mila", "Мила Соколова")
        cls.nik = Client().register("nik", "Никита Зуев")  # посторонний
        cls.kid, cls.lid = make_friends(cls.kate, cls.lev)
        _, cls.mid = make_friends(cls.kate, cls.mila)
        cls.nid = cls.nik.refresh()["user"]["id"]

    def setUp(self):
        rate_limiter.reset()

    def test_stories(self):
        r = self.kate.post("/api/stories", data={"text": "Утро в Туле", "background": "orange", "visibility": "friends"},
                           files=[("photo", ("s.png", png_bytes(), "image/png"))])
        self.assertEqual(r.status_code, 201, r.text)
        sid = r.json()["id"]
        groups = self.lev.get("/api/stories").json()["groups"]
        kate_group = next(g for g in groups if g["user"]["username"] == "kate")
        self.assertTrue(kate_group["has_unseen"])
        self.lev.post(f"/api/stories/{sid}/view")
        groups = self.lev.get("/api/stories").json()["groups"]
        self.assertFalse(next(g for g in groups if g["user"]["username"] == "kate")["has_unseen"])
        self.assertEqual(self.kate.get(f"/api/stories/{sid}/viewers").json()["total"], 1)
        # посторонний не видит историю «для друзей»
        self.assertEqual(self.nik.post(f"/api/stories/{sid}/view").status_code, 404)
        # ответ приходит в личные сообщения
        rep = self.lev.post(f"/api/stories/{sid}/reply", {"text": "Красиво!"})
        self.assertEqual(rep.status_code, 201)
        msgs = self.kate.get(f"/api/conversations/{rep.json()['conversation_id']}/messages").json()["items"]
        self.assertEqual(msgs[-1]["kind"], "story_reply")
        # истёкшие истории удаляются
        db.run("UPDATE stories SET expires_at=? WHERE id=?", (db.future(hours=-1), sid))
        from app.api.stories import cleanup_expired
        self.assertGreaterEqual(cleanup_expired(), 1)
        self.assertIsNone(db.value("SELECT 1 FROM stories WHERE id=?", (sid,)))

    def test_communities(self):
        r = self.kate.post("/api/communities", {"name": "Тульские пряники", "slug": "tula_gingerbread", "description": "Рецепты"})
        self.assertEqual(r.status_code, 201, r.text)
        self.assertEqual(self.kate.post("/api/communities", {"name": "Дубль", "slug": "tula_gingerbread"}).status_code, 422)
        # публикация от имени сообщества
        p = self.kate.post("/api/posts", data={"text": "Добро пожаловать! #пряники", "community_id": str(r.json()["id"])})
        self.assertEqual(p.status_code, 201, p.text)
        self.assertTrue(p.json()["as_community"])
        self.assertEqual(p.json()["community"]["slug"], "tula_gingerbread")
        # участник без прав не может писать, пока стена закрыта
        self.lev.post("/api/communities/tula_gingerbread/join")
        self.assertEqual(self.lev.post("/api/posts", data={"text": "Привет", "community_id": str(r.json()["id"])}).status_code, 403)
        # запись сообщества появляется в ленте участника
        self.assertIn(p.json()["id"], [x["id"] for x in self.lev.get("/api/feed").json()["items"]])
        # закрепление
        self.kate.patch("/api/communities/tula_gingerbread", {"pinned_post_id": p.json()["id"], "wall_open": True})
        info = self.lev.get("/api/communities/tula_gingerbread").json()
        self.assertEqual(info["pinned"]["id"], p.json()["id"])
        self.assertTrue(info["can_post"])
        self.assertEqual(info["members_count"], 2)

        # закрытое сообщество: заявка и одобрение
        self.kate.post("/api/communities", {"name": "Клуб выпускников", "slug": "alumni", "is_private": True})
        secret = self.kate.post("/api/posts", data={"text": "Только для своих", "community_id": str(
            db.value("SELECT id FROM communities WHERE slug='alumni'"))}).json()
        self.assertEqual(self.nik.get(f"/api/posts/{secret['id']}").status_code, 404)
        self.assertEqual(self.nik.post("/api/communities/alumni/join").json()["membership"], "pending")
        self.assertEqual(self.nik.get(f"/api/posts/{secret['id']}").status_code, 404)
        pending = self.kate.get("/api/communities/alumni/members?status=pending").json()["items"]
        self.assertEqual(pending[0]["username"], "nik")
        self.kate.post(f"/api/communities/alumni/members/{self.nid}", {"action": "approve"})
        self.assertEqual(self.nik.get(f"/api/posts/{secret['id']}").status_code, 200)
        # репостить запись из закрытого сообщества нельзя
        self.assertEqual(self.nik.post(f"/api/posts/{secret['id']}/repost").status_code, 403)
        # единственный админ не может просто уйти
        self.assertEqual(self.kate.delete("/api/communities/alumni/join").status_code, 400)
        found = self.nik.get("/api/search?q=пряники&type=communities").json()["communities"]
        self.assertEqual(found[0]["slug"], "tula_gingerbread")

    def test_group_chat(self):
        r = self.kate.post("/api/conversations/group", {"title": "Выходные", "user_ids": [self.lid, self.mid]})
        self.assertEqual(r.status_code, 201, r.text)
        conv = r.json()
        self.assertEqual(len(conv["members"]), 3)
        self.lev.post(f"/api/conversations/{conv['id']}/messages", {"text": "Куда едем?"})
        self.assertEqual(self.mila.get("/api/counters").json()["messages"], 1)
        msgs = self.mila.get(f"/api/conversations/{conv['id']}/messages").json()
        self.assertEqual(msgs["items"][-1]["text"], "Куда едем?")
        self.assertIn(str(self.lid), msgs["senders"])
        # чужих (не друзей) добавить нельзя
        self.assertEqual(self.kate.post(f"/api/conversations/{conv['id']}/members", {"user_ids": [self.nid]}).status_code, 403)
        self.kate.patch(f"/api/conversations/{conv['id']}", {"title": "Поход"})
        self.mila.post(f"/api/conversations/{conv['id']}/leave")
        self.assertEqual(self.mila.get(f"/api/conversations/{conv['id']}").status_code, 404)
        info = self.kate.get(f"/api/conversations/{conv['id']}").json()
        self.assertEqual(info["title"], "Поход")
        self.assertEqual(len(info["members"]), 2)
        # в беседу нужно минимум двое друзей
        self.assertEqual(self.kate.post("/api/conversations/group", {"user_ids": [self.lid]}).status_code, 400)

    def test_events(self):
        start = (datetime.now(timezone.utc) + timedelta(days=3)).isoformat()
        r = self.kate.post("/api/events", data={"title": "Пикник в парке", "place": "Центральный парк",
                                                "starts_at": start, "visibility": "invited"})
        self.assertEqual(r.status_code, 201, r.text)
        eid = r.json()["id"]
        self.assertEqual(self.lev.get(f"/api/events/{eid}").status_code, 404)  # не приглашён
        self.assertEqual(self.kate.post(f"/api/events/{eid}/invite", {"user_ids": [self.lid, self.nid]}).json()["invited"], 1)
        self.assertEqual(self.lev.get("/api/counters").json()["events"], 1)
        self.assertEqual(self.lev.get("/api/events?tab=invites").json()["items"][0]["id"], eid)
        self.assertEqual(self.lev.post(f"/api/events/{eid}/rsvp", {"status": "going"}).json()["going"], 2)
        self.assertEqual(self.lev.get("/api/counters").json()["events"], 0)
        self.assertIn(eid, [e["id"] for e in self.lev.get("/api/events?tab=mine").json()["items"]])
        self.assertEqual(self.nik.get(f"/api/events/{eid}").status_code, 404)
        bad = self.kate.post("/api/events", data={"title": "Х", "starts_at": ""})
        self.assertEqual(bad.status_code, 422)

    def test_circles(self):
        circles = self.kate.get("/api/circles").json()["items"]
        close = next(c for c in circles if c["name"] == "Близкие друзья")
        self.kate.patch(f"/api/circles/{close['id']}", {"user_ids": [self.lid, self.nid]})  # nik не друг — отфильтруется
        circles = self.kate.get("/api/circles").json()["items"]
        self.assertEqual([m["username"] for m in next(c for c in circles if c["id"] == close["id"])["members"]], ["lev"])
        p = self.kate.post("/api/posts", data={"text": "Секрет для близких", "circle_id": str(close["id"])}).json()
        self.assertEqual(p["circle"], "Близкие друзья")
        self.assertEqual(self.lev.get(f"/api/posts/{p['id']}").status_code, 200)
        self.assertEqual(self.mila.get(f"/api/posts/{p['id']}").status_code, 404)  # друг, но не в круге
        # удаление круга не открывает запись всем друзьям
        self.kate.delete(f"/api/circles/{close['id']}")
        self.assertEqual(self.mila.get(f"/api/posts/{p['id']}").status_code, 404)

    def test_guests_and_classmates(self):
        self.kate.patch("/api/me/settings", {"school": "Лицей № 2", "school_year": 2012})
        self.mila.patch("/api/me/settings", {"school": "Лицей №2 г. Тулы", "school_year": 2012})
        self.nik.patch("/api/me/settings", {"school": "Лицей № 2", "school_year": 2015})
        found = self.kate.get("/api/classmates?school=лицей&year=2012").json()["items"]
        self.assertEqual([p["username"] for p in found], ["mila"])
        self.assertEqual(self.kate.patch("/api/me/settings", {"school_year": 1800}).status_code, 422)
        # гости
        self.nik.get("/api/users/kate")
        self.assertGreaterEqual(self.kate.get("/api/counters").json()["guests"], 1)
        g = self.kate.get("/api/guests").json()["items"]
        self.assertIn("nik", [x["username"] for x in g])
        self.assertEqual(self.kate.get("/api/counters").json()["guests"], 0)
        # невидимка не оставляет следов
        self.mila.patch("/api/me/settings", {"invisible": True})
        self.mila.get("/api/users/kate")
        self.assertNotIn("mila", [x["username"] for x in self.kate.get("/api/guests").json()["items"]])


if __name__ == "__main__":
    unittest.main()
