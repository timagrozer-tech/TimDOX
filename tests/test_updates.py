"""Официальный ИИ-профиль @krug_updates: аккаунт, публикация обновлений с картинками, паузы, ответы в комментариях."""
import unittest
from unittest import mock

from test_api import Client
from app import db, updates
from app.releases import RELEASES
from app.security import rate_limiter


class UpdatesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        rate_limiter.reset()
        cls.old = Client().register("upd_old", "Старый Пользователь")
        cls.old_id = cls.old.refresh()["user"]["id"]
        cls.uid = updates.ensure_account()

    def setUp(self):
        rate_limiter.reset()

    def test_account(self):
        p = db.one("SELECT * FROM profiles WHERE user_id=?", (self.uid,))
        self.assertEqual((p["username"], p["verified"], p["badge"], p["profile_visibility"]), ("qevi", 1, "Официальный", "public"))
        self.assertTrue(p["avatar"])
        self.assertEqual(updates.ensure_account(), self.uid)  # повторно не создаётся
        self.assertTrue(db.value("SELECT 1 FROM follows WHERE follower_id=? AND followee_id=?", (self.old_id, self.uid)))
        new = Client().register("upd_new", "Новый Пользователь")
        nid = new.refresh()["user"]["id"]
        self.assertTrue(db.value("SELECT 1 FROM follows WHERE follower_id=? AND followee_id=?", (nid, self.uid)))

    def test_publish_order_gap_images(self):
        db.run("DELETE FROM ai_state WHERE key LIKE 'release:%'")
        db.run("DELETE FROM posts WHERE author_id=?", (self.uid,))
        pid = updates.publish_next()
        self.assertTrue(pid)
        post = db.one("SELECT * FROM posts WHERE id=?", (pid,))
        self.assertIn("QEVI Обновления", post["text"])
        self.assertEqual(db.value("SELECT count(*) FROM post_media WHERE post_id=?", (pid,)), 1)  # обложка
        self.assertIsNone(updates.publish_next())                                                # пауза между постами
        db.run("UPDATE posts SET created_at=? WHERE author_id=?", (db.future(hours=-2), self.uid))
        pid2 = updates.publish_next()
        self.assertEqual(db.value("SELECT count(*) FROM post_media WHERE post_id=?", (pid2,)), 1 + RELEASES[1]["images"])
        self.assertIn("Созвездие", db.value("SELECT text FROM posts WHERE id=?", (pid2,)))
        # пост видят подписчики, хэштеги проиндексированы
        feed = self.old.get(f"/api/posts/{pid2}").json()
        self.assertEqual(feed["author"]["username"], "qevi")
        self.assertTrue(db.value("SELECT 1 FROM ai_state WHERE key='release:constellation-live'"))

    def test_ai_reply_and_admin_notice(self):
        db.run("UPDATE users SET is_admin=1 WHERE id=?", (self.old_id,))
        pid = db.run("INSERT INTO posts (author_id, text, visibility) VALUES (?, 'Тест обновления', 'public')", (self.uid,)).lastrowid
        asker = Client().register("upd_asker", "Любопытный Человек")
        aid = asker.refresh()["user"]["id"]
        with mock.patch("app.updates.threading.Thread") as th:
            r = asker.post(f"/api/posts/{pid}/comments", {"text": "А как добавить Steam в созвездие?"})
            self.assertEqual(r.status_code, 201, r.text)
            self.assertTrue(th.called)                     # ответ готовится в фоне
        cid = r.json()["id"]
        self.assertTrue(db.value("SELECT 1 FROM notifications WHERE user_id=? AND actor_id=? AND post_id=?", (self.old_id, aid, pid)))
        with mock.patch("app.world.llm.enabled", return_value=True), \
                mock.patch("app.world.llm.complete", return_value="**Нажмите ✦ → «Настроить» и выберите Steam.**"):
            rid = updates.reply(cid)
        row = db.one("SELECT * FROM comments WHERE id=?", (rid,))
        self.assertEqual((row["author_id"], row["parent_id"]), (self.uid, cid))
        self.assertNotIn("*", row["text"])
        # без нейросети — молчит, на чужие посты — не отвечает
        with mock.patch("app.world.llm.enabled", return_value=False):
            self.assertIsNone(updates.reply(cid))
        other = db.run("INSERT INTO comments (post_id, author_id, text) VALUES (?,?, 'x')",
                       (db.run("INSERT INTO posts (author_id, text, visibility) VALUES (?, 'чужой', 'public')", (aid,)).lastrowid, self.old_id)).lastrowid
        with mock.patch("app.world.llm.enabled", return_value=True), mock.patch("app.world.llm.complete", return_value="ответ"):
            self.assertIsNone(updates.reply(other))


if __name__ == "__main__":
    unittest.main()
