"""Реферальная экосистема: ссылки, переходы, засчёт приглашений, галочки 3/10/50/100, рейтинг, дерево."""
import unittest

from test_api import Client
from app import db, referrals
from app.security import rate_limiter


def make_active(uid: int, days: int = 3, avatar: bool = True):
    for i in range(days):
        db.run("INSERT OR IGNORE INTO user_active_days (user_id, day) VALUES (?,?)", (uid, f"2026-01-0{i + 1}"))
    if avatar:
        db.run("UPDATE profiles SET avatar='/uploads/x.webp' WHERE user_id=?", (uid,))


class InvitesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        rate_limiter.reset()
        cls.host = Client().register("inv_host", "Хозяин Приглашений")
        cls.hid = cls.host.refresh()["user"]["id"]

    def setUp(self):
        rate_limiter.reset()

    def _invitee(self, name: str, code: str, via_cookie=False, net=None) -> tuple[Client, int]:
        c = Client()
        data = {"email": f"{name}@example.com", "password": "secret123", "name": "Новичок Тест", "username": name, "consent": True}
        if via_cookie:
            r = c.c.get(f"/i/{code}", follow_redirects=False)
            self.assertEqual(r.status_code, 302)
            self.assertIn(f"ref={code}", r.headers["location"])
        else:
            data["ref"] = code
        r = c.post("/api/auth/register", data)
        self.assertEqual(r.status_code, 201, r.text)
        uid = c.refresh()["user"]["id"]
        if net:
            db.run("UPDATE referrals SET net=? WHERE invitee_id=?", (net, uid))
        return c, uid

    def test_flow_and_tiers(self):
        me = self.host.get("/api/invites/me").json()
        code = me["code"]
        self.assertTrue(me["link"].endswith(f"/i/{code}"))
        self.assertEqual(me["totals"]["signups"], 0)
        info = Client().get(f"/api/invites/code/{code}").json()
        self.assertEqual(info["inviter"]["username"], "inv_host")
        self.assertEqual(Client().get("/api/invites/code/nope").status_code, 404)

        c1, u1 = self._invitee("inv_a1", code, via_cookie=True)
        self.assertTrue(db.value("SELECT 1 FROM follows WHERE follower_id=? AND followee_id=?", (u1, self.hid)), "подписка на пригласившего")
        uids = [u1] + [self._invitee(f"inv_a{i}", code)[1] for i in range(2, 4)]
        me = self.host.get("/api/invites/me").json()
        self.assertEqual(me["totals"]["signups"], 3)
        self.assertEqual(me["totals"]["clicks"], 1)
        self.assertEqual(me["totals"]["pending"], 3)
        # пока новички не активны — не засчитано
        referrals.qualify_pending()
        self.assertIsNone(self.host.get("/api/invites/me").json()["progress"]["tier"])
        hist = self.host.get("/api/invites/history").json()["items"]
        self.assertEqual(hist[0]["status"], "pending")
        self.assertEqual(hist[0]["steps"]["days_need"], 3)
        for u in uids:
            make_active(u)
        self.assertEqual(referrals.qualify_pending(), 3)
        me = self.host.get("/api/invites/me").json()
        self.assertEqual(me["progress"]["tier"], "base")
        self.assertEqual(me["progress"]["next"]["tier"], "silver")
        self.assertEqual(me["progress"]["next"]["left"], 7)
        self.assertEqual(me["rank"], 1)
        # галочка видна в карточке и в профиле
        referrals.reset_tier_cache()
        prof = c1.get("/api/users/inv_host").json()
        self.assertEqual(prof["user"]["tier"], "base")
        self.assertEqual(prof["counts"]["invited"], 3)
        notes = [n["type"] for n in self.host.get("/api/notifications").json()["items"]]
        self.assertIn("invite_tier", notes)
        self.assertIn("invite_joined", notes)
        # рейтинг и дерево
        lb = c1.get("/api/invites/leaderboard", params={"period": "all"}).json()
        self.assertTrue(any(i["user"]["username"] == "inv_host" and i["count"] == 3 for i in lb["items"]))
        t = c1.get("/api/invites/tree").json()
        self.assertTrue(any(n["username"] == "inv_host" and n["depth"] == -1 for n in t["nodes"]), "предок в дереве")
        t = self.host.get("/api/invites/tree").json()
        self.assertEqual(len([e for e in t["edges"] if e["from"] == self.hid]), 3)
        self.assertEqual(len(self.host.get("/api/invites/tree", params={"scope": "all"}).json()["edges"]) >= 3, True)

    def test_tier_thresholds(self):
        self.assertEqual([referrals.tier_for(n) for n in (0, 2, 3, 9, 10, 49, 50, 99, 100, 500)],
                         [None, None, "base", "base", "silver", "silver", "gold", "gold", "legend", "legend"])

    def test_antifraud(self):
        h = Client().register("inv_fraud", "Фрод Тест")
        code = h.get("/api/invites/me").json()["code"]
        ids = [self._invitee(f"inv_f{i}", code, net="10.0.0.*")[1] for i in range(5)]
        for u in ids:
            make_active(u)
        lazy = self._invitee("inv_lazy", code)[1]
        make_active(lazy, days=1)
        referrals.qualify_pending()
        me = h.get("/api/invites/me").json()
        self.assertEqual(me["totals"]["qualified"], 3, "из одной сети засчитываются максимум 3")
        self.assertEqual(me["totals"]["rejected"], 2)
        self.assertEqual(me["totals"]["pending"], 1)
        # самоприглашение не работает
        self.assertIsNone(referrals.attach(h.refresh()["user"]["id"], code, None))

    def test_extra_codes(self):
        h = Client().register("inv_codes", "Коды Тест")
        main = h.get("/api/invites/me").json()["code"]
        self.assertEqual(h.post("/api/invites/codes", {"label": ""}).status_code, 400)
        r = h.post("/api/invites/codes", {"label": "для Telegram"})
        self.assertEqual(r.status_code, 201)
        extra = r.json()["code"]
        self.assertEqual(len(h.get("/api/invites/me").json()["codes"]), 2)
        self.assertEqual(h.delete(f"/api/invites/codes/{main}").status_code, 400)
        self.assertEqual(h.delete(f"/api/invites/codes/{extra}").status_code, 200)
        self.assertEqual(h.c.get(f"/i/{extra}", follow_redirects=False).headers["location"], "/register")
        qr = h.get("/api/invites/qr")
        self.assertEqual(qr.headers["content-type"], "image/svg+xml")


if __name__ == "__main__":
    unittest.main()
