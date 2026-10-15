"""Стена: друзья оставляют записи и граффити на странице, хозяин стены может их удалить или закрыть стену."""
import unittest

from starlette.testclient import TestClient

from test_api import Client, png_bytes  # noqa: F401 — настраивает окружение и тестовую базу
from app.main import app
from app.security import rate_limiter


def befriend(a, b, b_id, a_id):
    a.post(f"/api/people/{b_id}/friend")
    b.post(f"/api/people/{a_id}/friend/accept")


class WallTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.ctx = TestClient(app).__enter__()
        cls.owner = Client().register("wall_owner", "Хозяин Стены")
        cls.friend = Client().register("wall_friend", "Друг Стены")
        cls.stranger = Client().register("wall_stranger", "Чужой")
        cls.owner_id = cls.owner.refresh()["user"]["id"]
        cls.friend_id = cls.friend.refresh()["user"]["id"]
        befriend(cls.friend, cls.owner, cls.owner_id, cls.friend_id)

    def setUp(self):
        rate_limiter.reset()

    def test_wall_post_and_graffiti(self):
        self.assertTrue(self.friend.get("/api/users/wall_owner").json()["can_wall"])
        self.assertFalse(self.stranger.get("/api/users/wall_owner").json()["can_wall"])
        r = self.friend.post("/api/posts", data={"text": "Привет на стене!", "wall_id": str(self.owner_id)})
        self.assertEqual(r.status_code, 201, r.text)
        p = r.json()
        self.assertEqual(p["wall"]["username"], "wall_owner")
        # граффити — картинка с пометкой
        g = self.friend.post("/api/posts", data={"text": "", "wall_id": str(self.owner_id), "graffiti": "1"},
                             files=[("photos", ("graffiti.png", png_bytes(), "image/png"))]).json()
        self.assertTrue(g["graffiti"])
        # видно на стене хозяина, а не на странице автора
        wall = [x["id"] for x in self.stranger.get("/api/users/wall_owner/posts").json()["items"]]
        self.assertIn(p["id"], wall)
        self.assertNotIn(p["id"], [x["id"] for x in self.owner.get("/api/users/wall_friend/posts").json()["items"]])
        # граффити не попадает в фотографии автора
        self.assertEqual(self.owner.get("/api/users/wall_friend/photos").json()["items"], [])
        notes = self.owner.get("/api/notifications").json()["items"]
        self.assertTrue(any(n["type"] == "wall_post" for n in notes))
        # чужим нельзя
        self.assertEqual(self.stranger.post("/api/posts", data={"text": "x", "wall_id": str(self.owner_id)}).status_code, 403)
        # хозяин удаляет запись со своей стены
        mine = next(x for x in self.owner.get("/api/users/wall_owner/posts").json()["items"] if x["id"] == p["id"])
        self.assertTrue(mine["can_delete"])
        self.assertEqual(self.owner.delete(f"/api/posts/{p['id']}").status_code, 200)
        # закрыл стену — писать нельзя
        self.owner.patch("/api/me/settings", {"wall_open": False})
        self.assertFalse(self.friend.get("/api/users/wall_owner").json()["can_wall"])
        self.assertEqual(self.friend.post("/api/posts", data={"text": "x", "wall_id": str(self.owner_id)}).status_code, 403)
        self.owner.patch("/api/me/settings", {"wall_open": True})


if __name__ == "__main__":
    unittest.main()
