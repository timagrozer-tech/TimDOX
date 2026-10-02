"""Голосовые в текст: авторасшифровка голосовых, кнопка «Текст» для коротких аудио, доступ только участникам."""
import io
import json
import os
import time
import unittest
from unittest import mock

from test_api import Client
from app import db, transcribe
from app.security import rate_limiter

OGG = b"OggS" + b"\x00" * 60


class TranscribeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        rate_limiter.reset()
        cls.a = Client().register("stt_a", "Голос Первый")
        cls.b = Client().register("stt_b", "Голос Второй")
        cls.c = Client().register("stt_c", "Чужой Человек")
        bid = cls.b.refresh()["user"]["id"]
        cls.conv = cls.a.post("/api/conversations", {"user_id": bid}).json()["id"]

    def setUp(self):
        rate_limiter.reset()

    def send(self, kind, **extra):
        data = {"type": kind, "duration": "4"}
        data.update(extra)
        r = self.a.post(f"/api/conversations/{self.conv}/media", data=data,
                        files={"file": ("v.ogg", io.BytesIO(OGG), "audio/ogg")})
        self.assertEqual(r.status_code, 201, r.text)
        return r.json()

    def wait_state(self, mid, timeout=3.0):
        t0 = time.time()
        while time.time() - t0 < timeout:
            info = json.loads(db.value("SELECT media FROM messages WHERE id=?", (mid,)) or "{}")
            if info.get("transcript_state") in ("done", "empty", "failed"):
                return info
            time.sleep(.05)
        return info

    def test_voice_auto(self):
        with mock.patch.dict(os.environ, {"GROQ_API_KEY": "test"}), \
                mock.patch.object(transcribe, "whisper", return_value="Привет, это голосовое") as w:
            m = self.send("voice", waveform="[10, 50, 90]")
            self.assertTrue(m["media"]["stt"])
            info = self.wait_state(m["id"])
            self.assertEqual(info["transcript"], "Привет, это голосовое")
            self.assertEqual(w.call_count, 1)
            # повторная просьба не гоняет Whisper снова
            r = self.b.post(f"/api/messages/{m['id']}/transcribe")
            self.assertEqual(r.json()["media"]["transcript"], "Привет, это голосовое")
            self.assertEqual(w.call_count, 1)

    def test_audio_on_demand(self):
        with mock.patch.dict(os.environ, {"GROQ_API_KEY": "test"}), \
                mock.patch.object(transcribe, "whisper", return_value="ква-ква") as w:
            m = self.send("audio", title="frog", waveform="[20, 40]")
            self.assertEqual(m["media"]["waveform"], [20, 40])
            time.sleep(.2)
            self.assertEqual(w.call_count, 0)                   # аудио само не расшифровывается
            self.assertEqual(self.c.post(f"/api/messages/{m['id']}/transcribe").status_code, 404)  # чужой — сообщение «не существует»
            r = self.b.post(f"/api/messages/{m['id']}/transcribe")
            self.assertEqual(r.status_code, 200, r.text)
            self.assertEqual(r.json()["media"]["transcript"], "ква-ква")

    def test_disabled_and_failures(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("GROQ_API_KEY", None)
            m = self.send("audio", title="x")
            self.assertFalse(m["media"]["stt"])
            self.assertEqual(self.b.post(f"/api/messages/{m['id']}/transcribe").status_code, 503)
        with mock.patch.dict(os.environ, {"GROQ_API_KEY": "test"}), \
                mock.patch.object(transcribe, "whisper", side_effect=OSError("down")):
            m = self.send("voice")
            self.assertEqual(self.wait_state(m["id"])["transcript_state"], "failed")
        long = self.send("audio", title="long", duration="900")
        self.assertNotIn("stt", long["media"])                  # длинные аудио не расшифровываем
        self.assertEqual(self.b.post(f"/api/messages/{long['id']}/transcribe").status_code, 400)


if __name__ == "__main__":
    unittest.main()
