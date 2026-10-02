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

    def test_emotions_and_sketch_items(self):
        # старый формат (один слот acc) переводится в новые слоты
        v = avatar3d.validate({"hair": "none", "acc": "shades", "accColor": 3, "outfit": "coat", "mouth": "smirk", "emotion": "cool"})
        self.assertEqual((v["glasses"], v["glassesColor"], v["outfit"], v["emotion"]), ("shades", 3, "coat", "cool"))
        self.assertNotIn("acc", v)
        self.assertEqual(avatar3d.validate({"acc": "crown"})["hat"], "crown")
        self.assertEqual(avatar3d.validate({"acc": "headphones"})["earwear"], "headphones")
        self.assertEqual(avatar3d.validate({})["emotion"], "neutral")
        with self.assertRaises(avatar3d.Invalid):
            avatar3d.validate({"emotion": "evil"})
        with self.assertRaises(avatar3d.Invalid):
            avatar3d.validate({"acc": "jetpack"})

    def test_custom_colors_and_new_slots(self):
        v = avatar3d.validate({"hairColor": "#FF00aa", "hat": "wizard", "pet": "cat", "fx": "snow", "bgStyle": "space", "lipstick": 1})
        self.assertEqual((v["hairColor"], v["hat"], v["pet"], v["lipstick"]), ("#ff00aa", "wizard", "cat", True))
        for bad in ({"hairColor": "red"}, {"hairColor": "#ff00"}, {"skin": 99}, {"skin": True}, {"bg": "url(x)"}, {"hat": "tank"}):
            with self.assertRaises(avatar3d.Invalid):
                avatar3d.validate(bad)

    def test_js_and_server_lists_match(self):
        import re, pathlib
        js = pathlib.Path("static/js/components/avatar3d.js").read_text()
        block = js[js.index("export const OPTIONS = {"):js.index("};", js.index("export const OPTIONS = {"))]
        js_opts = {m.group(1): re.findall(r'\["([a-z]+)", ', m.group(2)) for m in re.finditer(r"^  (\w+): (\[\[.*\]\]),$", block, re.M)}
        self.assertEqual(js_opts, avatar3d.OPTIONS)
        pal = js[js.index("export const PALETTES = {"):js.index("};", js.index("export const PALETTES = {"))]
        for name, size in avatar3d.PALETTE_SIZE.items():
            body = pal[pal.index(f"  {name}: ["):]
            body = body[:body.index("]],") + 3] if name == "bg" else body[:body.index("],") + 2]
            self.assertEqual(len(re.findall(r'"#[0-9a-f]{6}"', body)) // (2 if name == "bg" else 1), size, name)
        defaults = js[js.index("export const DEFAULT_SPEC = {"):js.index("};", js.index("export const DEFAULT_SPEC = {"))]
        self.assertEqual(sorted(re.findall(r"(\w+): ", defaults)), sorted(avatar3d.DEFAULT))

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
        self.assertEqual(seen["avatar3d"]["earwear"], "headphones")   # гости видят живой 3D (старый acc → новый слот)
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
