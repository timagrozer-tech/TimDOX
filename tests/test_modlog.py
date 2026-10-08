"""Журнал действий администрации: решения по жалобам, блокировки, галочки, удаление чужого контента."""
import unittest

from test_api import Client
from app import db
from app.security import rate_limiter


class ModLogTest(unittest.TestCase):
    def setUp(self):
        rate_limiter.reset()

    def test_log(self):
        admin = Client().register("ml_admin", "Админ Журнал")
        bad = Client().register("ml_bad", "Нарушитель")
        user = Client().register("ml_user", "Жалобщик")
        aid, bid = admin.refresh()["user"]["id"], bad.refresh()["user"]["id"]
        db.run("UPDATE users SET is_admin=1 WHERE id=?", (aid,))
        admin.refresh()
        post = bad.c.post("/api/posts", headers=bad._h(), data={"text": "запрещённый текст"}).json()
        pid = post.get("id") or post["post"]["id"]
        user.post("/api/reports", {"target_type": "post", "target_id": pid, "reason": "Спам"})
        self.assertEqual(admin.post("/api/admin/reports/resolve", {"target_type": "post", "target_id": pid, "action": "delete"}).status_code, 200)
        admin.post(f"/api/admin/users/{bid}/ban", {})
        admin.delete(f"/api/admin/users/{bid}/ban")
        admin.post(f"/api/admin/users/{bid}/verify", {"badge": "Тест"})
        log = admin.get("/api/admin/modlog").json()["items"]
        self.assertEqual([x["action"] for x in log][:4], ["verify", "unban", "ban", "report_delete"])
        first = log[3]
        self.assertEqual((first["actor"]["id"], first["target_user"]["id"], first["details"]["text"]), (aid, bid, "запрещённый текст"))
        self.assertIn("Спам", first["details"]["reasons"])
        # обычный человек журнал не видит
        self.assertIn(user.get("/api/admin/modlog").status_code, (403, 404))


if __name__ == "__main__":
    unittest.main()
