"""Новости для каналов персонажей из бесплатных RSS. Кэшируются в ai_state на 6 часов."""
import json
import logging
import re
import urllib.request
import xml.etree.ElementTree as ET
from html import unescape

from .. import db

log = logging.getLogger("krug.world.news")

FEEDS = {
    "tech": ["https://3dnews.ru/news/rss/", "https://habr.com/ru/rss/news/?fl=ru"],
    "ii": ["https://habr.com/ru/rss/hubs/artificial_intelligence/articles/?fl=ru", "https://habr.com/ru/rss/hubs/machine_learning/articles/?fl=ru"],
    "igry": ["https://stopgame.ru/rss/rss_news.xml", "https://www.igromania.ru/rss/news.rss"],
    "nauka": ["https://nplus1.ru/rss"],
    "kosmos": ["https://nplus1.ru/rss"],
    "kinozal": ["https://www.kinonews.ru/rss/"],
}
SPACE_WORDS = ("косм", "марс", "луна", "лун", "ракет", "спутник", "звезд", "галакт", "планет", "астероид", "мкс", "телескоп", "nasa", "роскосмос")


def _clean(t: str) -> str:
    return re.sub(r"\s+", " ", unescape(re.sub(r"<[^>]+>", " ", t or ""))).strip()


def _fetch(url: str) -> list[dict]:
    req = urllib.request.Request(url, headers={"user-agent": "Mozilla/5.0 (KrugWorld RSS)"})
    with urllib.request.urlopen(req, timeout=10) as resp:
        root = ET.fromstring(resp.read())
    items = []
    for it in root.iter("item"):
        title = _clean(it.findtext("title"))
        link = (it.findtext("link") or "").strip()
        if title and link.startswith("http"):
            items.append({"title": title[:160], "link": link, "summary": _clean(it.findtext("description"))[:300]})
    return items


def headlines(channel: str, n: int = 5) -> list[dict]:
    """Свежие заголовки канала (из кэша или из сети)."""
    key = f"news:{channel}"
    cached = db.value("SELECT value FROM ai_state WHERE key=?", (key,))
    if cached:
        try:
            data = json.loads(cached)
            if data.get("at", "") > db.future(hours=-6):
                return data["items"][:n]
        except ValueError:
            pass
    items = []
    for url in FEEDS.get(channel, []):
        try:
            items += _fetch(url)
        except Exception as e:  # сеть или формат — просто пропускаем источник
            log.info("RSS %s: %s", url, e)
    if channel == "kosmos":
        items = [i for i in items if any(w in i["title"].lower() for w in SPACE_WORDS)]
    seen, uniq = set(), []
    for i in items:
        if i["title"] not in seen:
            seen.add(i["title"])
            uniq.append(i)
    db.run("DELETE FROM ai_state WHERE key=?", (key,))
    db.run("INSERT INTO ai_state (key, value) VALUES (?,?)", (key, json.dumps({"at": db.now(), "items": uniq[:12]}, ensure_ascii=False)))
    return uniq[:n]
