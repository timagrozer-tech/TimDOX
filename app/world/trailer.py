"""Служебная сборка видео: берёт готовую картинку и музыку (по ссылкам), озвучку из tts:out, сводит звук и
кладёт итоговый mp4 в медиахранилище. Запрос — ai_state['trailer:req'], итог — ai_state['trailer:done']."""
import base64
import json
import logging
import os
import re
import subprocess
import sys
import urllib.request
from pathlib import Path

from .. import db

log = logging.getLogger("krug.trailer")
WORK = Path("/tmp/trailer")


def _ffmpeg() -> str:
    sys.path.insert(0, "/tmp/iiof")
    try:
        import imageio_ffmpeg
    except ImportError:
        subprocess.run([sys.executable, "-m", "pip", "install", "--quiet", "--target", "/tmp/iiof", "imageio-ffmpeg"],
                       check=True, timeout=300)
        import imageio_ffmpeg
    return imageio_ffmpeg.get_ffmpeg_exe()


def _get(url: str, path: Path) -> None:
    req = urllib.request.Request(url, headers={"User-Agent": "KrugTrailer/1.0"})
    with urllib.request.urlopen(req, timeout=120) as r, open(path, "wb") as f:
        while chunk := r.read(1 << 20):
            f.write(chunk)


def process() -> None:
    raw = db.value("SELECT value FROM ai_state WHERE key='trailer:req'")
    if not raw:
        return
    db.run("DELETE FROM ai_state WHERE key IN ('trailer:req', 'trailer:done')")
    req = json.loads(raw)
    result = {"ok": False}
    try:
        WORK.mkdir(parents=True, exist_ok=True)
        ff = _ffmpeg()
        video, music = WORK / "video.mp4", WORK / "music.m4a"
        _get(req["video"], video)
        _get(req["music"], music)
        inputs = ["-i", str(video), "-i", str(music)]
        base, labels = [], []
        fmt = "aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo"
        for n, line in enumerate(req["lines"]):
            rows = db.all("SELECT key, value FROM ai_state WHERE key LIKE ?", (f"tts:out:{line['i']}:%",))
            chunks = [r["value"] for r in sorted(rows, key=lambda r: int(r["key"].rsplit(":", 1)[1]))]
            path = WORK / f"vo{line['i']}.mp3"
            path.write_bytes(base64.b64decode("".join(chunks)))
            inputs += ["-i", str(path)]
            ms = int(line["at"] * 1000)
            base.append(f"[{n + 2}:a]{fmt},adelay={ms}|{ms},volume={req.get('vo_gain', 1.9)}[v{n}]")
            labels.append(f"[v{n}]")
        base.append(f"[1:a]{fmt},volume={req.get('music_gain', 1.0)}[m]")
        base.append(f"{''.join(labels)}amix=inputs={len(labels)}:normalize=0,apad=whole_dur={req.get('duration', 40)},asplit=2[vo][sc]")
        dk = req.get("duck")  # приглушение музыки под голос
        if dk:
            base.append(f"[m][sc]sidechaincompress=threshold={dk.get('threshold', 0.05)}:ratio={dk.get('ratio', 3)}:"
                        f"attack={dk.get('attack', 20)}:release={dk.get('release', 400)}[md]")
        else:
            base.append("[sc]anullsink;[m]anull[md]")
        fade = req.get("fade")
        tail = f",afade=t=out:st={fade[0]}:d={fade[1]}" if fade else ""
        filters = base + [f"[md][vo]amix=inputs=2:normalize=0:duration=first{tail},"
                          "loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[a]"]
        out = WORK / "out.mp4"
        cmd = [ff, "-y", *inputs, "-filter_complex", ";".join(filters), "-map", "0:v", "-map", "[a]",
               "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-shortest", str(out)]
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
        if p.returncode:
            raise RuntimeError(p.stderr[-1500:])

        def levels(graph_tail: str) -> dict:
            g = ";".join(base + [graph_tail])
            s = subprocess.run([ff, "-i", str(video), *inputs[2:], "-filter_complex", g, "-map", "[x]", "-f", "null", "-"],
                               capture_output=True, text=True, timeout=300)
            return dict(re.findall(r"(mean_volume|max_volume): (-?[\d.]+) dB", s.stderr))

        stat = subprocess.run([ff, "-i", str(out), "-af", "volumedetect", "-f", "null", "-"], capture_output=True, text=True, timeout=300)
        vol = dict(re.findall(r"(mean_volume|max_volume): (-?[\d.]+) dB", stat.stderr))
        dur = re.search(r"Duration: ([\d:.]+)", stat.stderr)
        try:  # уровни голоса и приглушённой музыки по отдельности (до нормализации)
            vol["voice"] = levels("[md]anullsink;[vo]volumedetect[x]")
            vol["music"] = levels("[vo]anullsink;[md]volumedetect[x]")
        except Exception as e:
            vol["levels_error"] = str(e)[:200]
        data = out.read_bytes()
        rel = f"trailer/{req.get('name', 'krug-trailer')}.mp4"
        from ..media import _put
        db.run("DELETE FROM media_files WHERE path=?", (rel,)) if os.environ.get("MEDIA_STORAGE", "disk") == "db" else None
        _put(rel, data, "video/mp4")
        result = {"ok": True, "url": f"/uploads/{rel}", "bytes": len(data), "volume": dict(vol), "duration": dur and dur.group(1)}
    except Exception as e:
        log.exception("Сборка трейлера")
        result = {"ok": False, "error": str(e)[-1500:]}
    db.run("INSERT INTO ai_state (key, value) VALUES ('trailer:done', ?)", (json.dumps(result, ensure_ascii=False),))
