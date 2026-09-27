"""Опросы в записях: 2–10 вариантов, один или несколько ответов, срок голосования."""
import json

from . import db
from .security import censor, clean_text
from .web import ApiError

MAX_OPTIONS = 10


def parse(raw) -> dict | None:
    """Разбирает поле формы poll (JSON). None — опроса нет."""
    if not raw:
        return None
    try:
        data = json.loads(raw) if isinstance(raw, str) else raw
    except ValueError:
        raise ApiError(400, "Некорректный опрос")
    if not isinstance(data, dict):
        raise ApiError(400, "Некорректный опрос")
    options = [censor(clean_text(str(o), 100)).strip() for o in (data.get("options") or []) if str(o).strip()]
    options = list(dict.fromkeys(options))  # без повторов
    if len(options) < 2:
        raise ApiError(400, "В опросе нужно хотя бы 2 варианта ответа")
    if len(options) > MAX_OPTIONS:
        raise ApiError(400, f"Не больше {MAX_OPTIONS} вариантов")
    days = data.get("days")
    try:
        days = int(days) if days not in (None, "", 0, "0") else None
    except (TypeError, ValueError):
        days = None
    return {"question": censor(clean_text(str(data.get("question") or ""), 200)).strip(), "options": options,
            "multiple": bool(data.get("multiple")), "days": max(1, min(30, days)) if days else None}


def create(c, post_id: int, poll: dict) -> None:
    closes = db.future(days=poll["days"]) if poll["days"] else None
    pid = c.execute("INSERT INTO polls (post_id, question, multiple, closes_at) VALUES (?,?,?,?)",
                    (post_id, poll["question"], 1 if poll["multiple"] else 0, closes)).lastrowid
    for i, text in enumerate(poll["options"]):
        c.execute("INSERT INTO poll_options (poll_id, text, position) VALUES (?,?,?)", (pid, text, i))


def views(post_ids: list[int], v: int) -> dict[int, dict]:
    if not post_ids:
        return {}
    polls = db.all(f"SELECT * FROM polls WHERE post_id IN ({db.placeholders(post_ids)})", tuple(post_ids))
    if not polls:
        return {}
    ids = [p["id"] for p in polls]
    ph = db.placeholders(ids)
    opts = db.all(f"SELECT * FROM poll_options WHERE poll_id IN ({ph}) ORDER BY position", tuple(ids))
    counts = {r["option_id"]: r["n"] for r in db.all(
        f"SELECT option_id, count(*) AS n FROM poll_votes WHERE poll_id IN ({ph}) GROUP BY option_id", tuple(ids))}
    voters = {r["poll_id"]: r["n"] for r in db.all(
        f"SELECT poll_id, count(DISTINCT user_id) AS n FROM poll_votes WHERE poll_id IN ({ph}) GROUP BY poll_id", tuple(ids))}
    mine = {}
    for r in db.all(f"SELECT poll_id, option_id FROM poll_votes WHERE user_id=? AND poll_id IN ({ph})", (v, *ids)):
        mine.setdefault(r["poll_id"], []).append(r["option_id"])
    now = db.now()
    out = {}
    for p in polls:
        out[p["post_id"]] = {
            "id": p["id"], "question": p["question"], "multiple": bool(p["multiple"]), "closes_at": p["closes_at"],
            "closed": bool(p["closes_at"] and p["closes_at"] < now),
            "options": [{"id": o["id"], "text": o["text"], "votes": counts.get(o["id"], 0)} for o in opts if o["poll_id"] == p["id"]],
            "voters": voters.get(p["id"], 0), "voted": mine.get(p["id"], []),
        }
    return out
