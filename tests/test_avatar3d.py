"""3D-аватар: проверка параметров, сохранение, снимок не сбрасывает 3D, обычное фото — сбрасывает."""
import io
import unittest

from PIL import Image

from test_api import Client
from app import avatar3d
from app.security import rate_limiter


def png():
    b = io.BytesIO()
    Image.new("RGB", (64, 64), (120, 80, 255)).save(b, "PNG")
    return b.getvalue()


class Avatar3DTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        rate_limiter.reset()
        cls.a = Client().register("av3d_a", "Трёхмерный Человек")
        cls.b = Client().register("av3d_b", "Зритель Профиля")

    def setUp(self):
        rate_limiter.reset()

    def test_validate(self):
        self.assertEqual(avatar3d.validate({})["hair"], "short")
        with self.assertRaises(avatar3d.Invalid):
            avatar3d.validate({"hair": "<script>"})
        with self.assertRaises(avatar3d.Invalid):
            avatar3d.validate({"skin": 99})
        self.assertNotIn("evil", avatar3d.validate({"evil": 1, "acc": "crown"}))

    def test_flow(self):
        spec = {"skin": 5, "hair": "curly", "hairColor": 3, "acc": "headphones", "mouth": "grin", "bg": 2}
        self.assertEqual(self.a.put("/api/me/avatar3d", {"spec": {"hair": "wig"}}).status_code, 400)
        # снимок 3D (keep3d=1), затем параметры
        r = self.a.post("/api/me/avatar", data={"keep3d": "1"}, files={"file": ("a.png", io.BytesIO(png()), "image/png")})
        self.assertEqual(r.status_code, 200, r.text)
        r = self.a.put("/api/me/avatar3d", {"spec": spec})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["avatar3d"]["hair"], "curly")
        seen = self.b.get("/api/users/av3d_a").json()
        self.assertEqual(seen["avatar3d"]["acc"], "headphones")       # гости видят живой 3D
        # ещё один снимок с keep3d — 3D остаётся
        self.a.post("/api/me/avatar", data={"keep3d": "1"}, files={"file": ("a.png", io.BytesIO(png()), "image/png")})
        self.assertIsNotNone(self.a.get("/api/users/av3d_a").json()["avatar3d"])
        # обычное фото — 3D снимается
        self.a.post("/api/me/avatar", files={"file": ("p.png", io.BytesIO(png()), "image/png")})
        self.assertIsNone(self.a.get("/api/users/av3d_a").json()["avatar3d"])
        # DELETE
        self.a.put("/api/me/avatar3d", {"spec": spec})
        self.assertEqual(self.a.delete("/api/me/avatar3d").status_code, 200)
        self.assertIsNone(self.a.get("/api/users/av3d_a").json()["avatar3d"])


if __name__ == "__main__":
    unittest.main()
