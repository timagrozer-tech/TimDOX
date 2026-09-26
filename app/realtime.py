"""Реальное время: концентратор событий для Server-Sent Events.

Каждая открытая вкладка пользователя держит одно SSE-соединение (/api/stream).
Сервер отправляет в него события: новое сообщение, «печатает…», «прочитано»,
уведомление, изменение статуса «в сети».

Для запуска на нескольких серверах этот модуль заменяется на Redis Pub/Sub —
интерфейс publish()/subscribe() останется тем же.
"""
import asyncio
import json
from collections import defaultdict


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


hub = Hub()
