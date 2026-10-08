"""Реальное время: концентратор событий.

Два режима (переменная REALTIME):
- memory (по умолчанию) — один процесс сервера, каждая вкладка держит SSE-соединение /api/stream;
- db — несколько процессов (обычный хостинг с Passenger, где постоянные соединения недоступны):
  события пишутся в таблицу rt_events, вкладки забирают их коротким опросом /api/poll раз в 1–2 секунды,
  а «в сети» — это «опрашивал сервер за последние ONLINE_SECONDS секунд» (таблица rt_online).

Интерфейс publish()/publish_many()/is_online()/online_ids() одинаков в обоих режимах.
"""
import asyncio
import json
import os
import threading
import time
from collections import defaultdict

MODE = os.environ.get("REALTIME", "memory").strip().lower()
ONLINE_SECONDS = 25      # без опроса дольше — человек не в сети
KEEP_EVENTS_SECONDS = 120


class Hub:
    def __init__(self):
        self._subs: dict[int, set[asyncio.Queue]] = defaultdict(set)

    def subscribe(self, user_id: int) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=200)
        first = not self._subs[user_id]
        self._subs[user_id].add(q)
        return q, first

    def unsubscribe(self, user_id: int, q: asyncio.Queue) -> bool:
        """Возвращает True, если это было последнее соединение пользователя."""
        subs = self._subs.get(user_id)
        if not subs:
            return False
        subs.discard(q)
        if not subs:
            del self._subs[user_id]
            return True
        return False

    def is_online(self, user_id: int) -> bool:
        return bool(self._subs.get(user_id))

    def online_ids(self) -> set[int]:
        return set(self._subs.keys())

    def publish(self, user_id: int, event: str, data) -> None:
        payload = json.dumps(data, ensure_ascii=False)
        for q in list(self._subs.get(user_id, ())):
            try:
                q.put_nowait((event, payload))
            except asyncio.QueueFull:
                pass  # медленный клиент — событие пропускается, клиент дозагрузит данные сам

    def publish_many(self, user_ids, event: str, data) -> None:
        for uid in set(user_ids):
            self.publish(uid, event, data)


class DbHub:
    """События через базу — работает, когда запросы обслуживают разные процессы сервера."""

    polling = True

    def __init__(self):
        self._online_cache: tuple[float, set[int]] = (0.0, set())
        self._sweep_at = 0.0
        self._sweep_lock = threading.Lock()

    @staticmethod
    def _db():
        from . import db
        return db

    def _since(self, seconds: int) -> str:
        from datetime import datetime, timedelta, timezone
        return (datetime.now(timezone.utc) - timedelta(seconds=seconds)).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"

    # -------------------------------------------------- отправка
    def publish(self, user_id: int, event: str, data) -> None:
        self.publish_many([user_id], event, data)

    def publish_many(self, user_ids, event: str, data) -> None:
        ids = sorted({int(u) for u in user_ids if u})
        if not ids:
            return
        payload = json.dumps(data, ensure_ascii=False)
        db = self._db()
        # «печатает…» и «в сети» нужны только тем, кто сейчас на сайте — остальным не пишем
        if event in ("typing", "presence"):
            online = self.online_ids()
            ids = [u for u in ids if u in online]
        for uid in ids:
            db.run("INSERT INTO rt_events (user_id, event, data) VALUES (?,?,?)", (uid, event, payload))

    # -------------------------------------------------- кто в сети
    def online_ids(self) -> set[int]:
        at, ids = self._online_cache
        if time.monotonic() - at < 3:
            return ids
        rows = self._db().all("SELECT user_id FROM rt_online WHERE seen_at > ?", (self._since(ONLINE_SECONDS),))
        ids = {r["user_id"] for r in rows}
        self._online_cache = (time.monotonic(), ids)
        return ids

    def is_online(self, user_id: int) -> bool:
        return user_id in self.online_ids()

    # -------------------------------------------------- опрос
    def poll(self, user_id: int, after: int | None, friends) -> dict:
        """Отмечает человека «в сети» и отдаёт его события после after. after=None — первый опрос: только курсор."""
        db = self._db()
        now = db.now()
        was = db.value("SELECT seen_at FROM rt_online WHERE user_id=?", (user_id,))
        if was is None:
            db.run("INSERT OR IGNORE INTO rt_online (user_id, seen_at) VALUES (?,?)", (user_id, now))
        else:
            db.run("UPDATE rt_online SET seen_at=? WHERE user_id=?", (now, user_id))
        if was is None or was <= self._since(ONLINE_SECONDS):
            self._online_cache = (0.0, set())
            self.publish_many(friends(), "presence", {"user_id": user_id, "online": True})
        self.sweep()
        if after is None:
            cursor = db.value("SELECT max(id) FROM rt_events WHERE user_id=?", (user_id,)) or 0
            return {"cursor": int(cursor), "events": []}
        rows = db.all("SELECT id, event, data FROM rt_events WHERE user_id=? AND id > ? ORDER BY id LIMIT 300",
                      (user_id, after))
        events = []
        for r in rows:
            try:
                events.append({"event": r["event"], "data": json.loads(r["data"])})
            except (TypeError, ValueError):
                continue
        return {"cursor": int(rows[-1]["id"]) if rows else after, "events": events}

    def sweep(self, force: bool = False) -> None:
        """Раз в 15 секунд: кто перестал опрашивать — вышел из сети (друзьям уходит событие), старые события удаляются."""
        if not force and time.monotonic() - self._sweep_at < 15:
            return
        if not self._sweep_lock.acquire(blocking=False):
            return
        try:
            self._sweep_at = time.monotonic()
            db = self._db()
            gone = db.all("SELECT user_id FROM rt_online WHERE seen_at <= ?", (self._since(ONLINE_SECONDS + 15),))
            if gone:
                from . import social
                for r in gone:
                    uid = r["user_id"]
                    # другой процесс мог убрать запись раньше — событие «вышел» шлёт только тот, кто её удалил
                    cur = db.run("DELETE FROM rt_online WHERE user_id=? AND seen_at <= ?", (uid, self._since(ONLINE_SECONDS + 15)))
                    if getattr(cur, "rowcount", 1):
                        db.run("UPDATE users SET last_seen_at=? WHERE id=?", (db.now(), uid))
                        self.publish_many(social.friend_ids(uid), "presence", {"user_id": uid, "online": False})
                self._online_cache = (0.0, set())
            db.run("DELETE FROM rt_events WHERE created_at < ?", (self._since(KEEP_EVENTS_SECONDS),))
        finally:
            self._sweep_lock.release()


hub = DbHub() if MODE == "db" else Hub()
POLLING = MODE == "db"
