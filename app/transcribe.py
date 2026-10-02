"""Расшифровка голосовых в текст (Whisper через Groq — тот же ключ GROQ_API_KEY, что у ИИ-мира).

Голосовое расшифровывается само сразу после отправки (в фоне), текст приходит в чат через message_update.
Для старых голосовых и коротких аудио — по кнопке «Текст». Без ключа функция просто выключена."""
import json
import logging
import os
import threading
import urllib.request
import uuid

from . import config, db, media

log = logging.getLogger("krug.transcribe")
URL = "https://api.groq.com/openai/v1/audio/transcriptions"
MAX_BYTES = 20 * 1024 * 1024
MAX_AUDIO_SEC = 180          # обычные аудио — только короткие (голосовые-мемы, заметки)
_running: set[int] = set()
_lock = threading.Lock()


def enabled() -> bool:
    return bool(os.environ.get("GROQ_API_KEY"))


def can_transcribe(kind: str, info: dict | None) -> bool:
    if not info:
        return False
    if kind == "voice":
        return True
    return kind == "audio" and 0 < float(info.get("duration") or 0) <= MAX_AUDIO_SEC


def _bytes(url: str) -> bytes | None:
    rel = url.split("/uploads/", 1)[1] if "/uploads/" in url else url.lstrip("/")
    data = media.read_file(rel)
    if data is None:
        pub = media.public_url(rel)
        if pub:
            with urllib.request.urlopen(pub, timeout=20) as r:
                data = r.read(MAX_BYTES)
    return data


def whisper(data: bytes, filename: str, mime: str) -> str:
    """Отправка в Whisper (multipart/form-data). Возвращает текст."""
    b = uuid.uuid4().hex
    parts = []
    for k, v in (("model", os.environ.get("WHISPER_MODEL", "whisper-large-v3-turbo")), ("response_format", "json"),
                 ("temperature", "0")):
        parts.append(f'--{b}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode())
    parts.append(f'--{b}\r\nContent-Disposition: form-data; name="file"; filename="{filename}"\r\nContent-Type: {mime}\r\n\r\n'.encode()
                 + data + b"\r\n")
    parts.append(f"--{b}--\r\n".encode())
    req = urllib.request.Request(URL, data=b"".join(parts), method="POST", headers={
        "Authorization": f"Bearer {os.environ['GROQ_API_KEY']}", "Content-Type": f"multipart/form-data; boundary={b}",
        "User-Agent": "KrugTranscribe/1.0"})
    with urllib.request.urlopen(req, timeout=60) as r:
        out = json.loads(r.read().decode("utf-8"))
    return " ".join(str(out.get("text") or "").split())[:4000]


def _save(mid: int, patch: dict) -> None:
    row = db.one("SELECT media FROM messages WHERE id=?", (mid,))
    if not row:
        return
    info = json.loads(row["media"] or "{}")
    info.update(patch)
    db.run("UPDATE messages SET media=? WHERE id=?", (json.dumps(info, ensure_ascii=False), mid))


def run(mid: int, broadcast) -> None:
    """Расшифровать сообщение mid и разослать обновление. Повторно не запускается, пока идёт первая попытка."""
    with _lock:
        if mid in _running:
            return
        _running.add(mid)
    try:
        row = db.one("SELECT kind, media FROM messages WHERE id=?", (mid,))
        if not row:
            return
        info = json.loads(row["media"] or "{}")
        if info.get("transcript") is not None or not can_transcribe(row["kind"], info):
            return
        _save(mid, {"transcript_state": "pending"})
        broadcast(mid)
        try:
            data = _bytes(info.get("url") or "")
            if not data:
                raise ValueError("файл не найден")
            mime = info.get("mime") or "audio/webm"
            ext = {"audio/ogg": "ogg", "audio/mp4": "m4a", "audio/mpeg": "mp3", "audio/wav": "wav", "audio/x-wav": "wav",
                   "audio/flac": "flac", "audio/aac": "aac"}.get(mime.split(";")[0], "webm")
            text = whisper(data, f"voice.{ext}", mime.split(";")[0])
            _save(mid, {"transcript": text, "transcript_state": "done" if text else "empty"})
        except Exception as e:
            log.warning("transcribe %s: %s", mid, e)
            _save(mid, {"transcript_state": "failed"})
        broadcast(mid)
    finally:
        with _lock:
            _running.discard(mid)


def run_async(mid: int, broadcast) -> None:
    if enabled():
        threading.Thread(target=run, args=(mid, broadcast), daemon=True).start()
