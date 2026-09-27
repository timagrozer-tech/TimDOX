"""Служебная озвучка текста (для трейлеров и объявлений). Запрос кладётся в ai_state['tts:req'],
результат — mp3 кусками base64 в ai_state['tts:out:N'] и сводка в ai_state['tts:done'].
Голоса: Microsoft Edge (нейросетевые, ru-RU-DmitryNeural / SvetlanaNeural), запасной — Google Translate."""
import base64
import hashlib
import json
import logging
import time
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone

from .. import db

log = logging.getLogger("krug.tts")
TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4"
CHROMIUM = "143.0.3650.75"
VERSIONS = ["143.0.3650.75", "140.0.3485.14", "136.0.3240.64", "130.0.2849.68"]


def _gec() -> str:
    ticks = int(time.time()) + 11644473600
    ticks -= ticks % 300
    return hashlib.sha256(f"{ticks * 10_000_000}{TOKEN}".encode()).hexdigest().upper()


def _edge(text: str, voice: str, rate: str, pitch: str) -> bytes:
    last = None
    for v in VERSIONS:
        try:
            return _edge_v(text, voice, rate, pitch, v)
        except Exception as e:  # версия протокола могла смениться — пробуем следующую
            last = e
    raise last


def _edge_v(text: str, voice: str, rate: str, pitch: str, CHROMIUM: str) -> bytes:
    from websockets.sync.client import connect
    url = ("wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1"
           f"?TrustedClientToken={TOKEN}&Sec-MS-GEC={_gec()}&Sec-MS-GEC-Version=1-{CHROMIUM}&ConnectionId={uuid.uuid4().hex}")
    headers = {"Origin": "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold", "Pragma": "no-cache", "Cache-Control": "no-cache",
               "User-Agent": f"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{CHROMIUM.split('.')[0]}.0.0.0 Safari/537.36 Edg/{CHROMIUM.split('.')[0]}.0.0.0"}
    ts = datetime.now(timezone.utc).strftime("%a %b %d %Y %H:%M:%S GMT+0000 (Coordinated Universal Time)")
    audio = bytearray()
    with connect(url, additional_headers=headers, open_timeout=20, max_size=None) as ws:
        ws.send(f"X-Timestamp:{ts}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n"
                '{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},'
                '"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}')
        ssml = (f"<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='ru-RU'><voice name='{voice}'>"
                f"<prosody pitch='{pitch}' rate='{rate}' volume='+0%'>{text}</prosody></voice></speak>")
        ws.send(f"X-RequestId:{uuid.uuid4().hex}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:{ts}Z\r\nPath:ssml\r\n\r\n{ssml}")
        while True:
            msg = ws.recv(timeout=30)
            if isinstance(msg, bytes):
                hlen = int.from_bytes(msg[:2], "big")
                if b"Path:audio" in msg[2:2 + hlen]:
                    audio += msg[2 + hlen:]
            elif "Path:turn.end" in msg:
                break
    if not audio:
        raise RuntimeError("пустой ответ")
    return bytes(audio)


def _google(text: str) -> bytes:
    out = bytearray()
    parts, cur = [], ""
    for word in text.split():
        if len(cur) + len(word) > 180:
            parts.append(cur)
            cur = ""
        cur += (" " if cur else "") + word
    parts.append(cur)
    for p in parts:
        url = "https://translate.google.com/translate_tts?" + urllib.parse.urlencode({"ie": "UTF-8", "q": p, "tl": "ru", "client": "tw-ob"})
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=20) as r:
            out += r.read()
    return bytes(out)


def process() -> None:
    raw = db.value("SELECT value FROM ai_state WHERE key='tts:req'")
    if not raw:
        return
    db.run("DELETE FROM ai_state WHERE key='tts:req'")
    req = json.loads(raw)
    start = int(req.get("start", 0))  # номер первой строки (чтобы переозвучить часть, не трогая остальные)
    if req.get("keep"):
        for i in range(start, start + len(req.get("lines", []))):
            db.run("DELETE FROM ai_state WHERE key LIKE ?", (f"tts:out:{i}:%",))
        db.run("DELETE FROM ai_state WHERE key='tts:done'")
    else:
        db.run("DELETE FROM ai_state WHERE key LIKE 'tts:out:%' OR key='tts:done'")
    results = []
    for i, line in enumerate(req.get("lines", []), start):
        engine = "edge"
        audio, err = None, None
        for attempt in range(4):
            try:
                audio = _edge(line, req.get("voice", "ru-RU-DmitryNeural"), req.get("rate", "+6%"), req.get("pitch", "+0Hz"))
                break
            except Exception as e:  # сервис ограничивает частые подключения — ждём дольше с каждой попыткой
                err = e
                time.sleep(4 + attempt * 8)
        time.sleep(1.5)
        if audio is None:
            log.warning("TTS edge: %s", err)
            engine = "google"
            try:
                audio = _google(line)
            except Exception as e2:
                log.warning("TTS google: %s", e2)
                results.append({"i": i, "error": str(e2)[:200]})
                continue
        b64 = base64.b64encode(audio).decode()
        chunks = [b64[k:k + 60000] for k in range(0, len(b64), 60000)]
        for n, ch in enumerate(chunks):
            db.run("INSERT INTO ai_state (key, value) VALUES (?,?)", (f"tts:out:{i}:{n}", ch))
        results.append({"i": i, "engine": engine, "chunks": len(chunks), "bytes": len(audio)})
    db.run("INSERT INTO ai_state (key, value) VALUES ('tts:done', ?)", (json.dumps(results),))
