"""Журнал действий администрации и модераторов: кто, что, с кем и когда сделал.

Записи только добавляются (изменять и удалять их через API нельзя). Хранится краткое описание цели —
чтобы журнал оставался понятным, даже если сам контент уже удалён."""
import json

from . import db

ACTIONS = {
    "report_dismiss": "Жалоба отклонена", "report_delete": "Контент удалён по жалобе",
    "report_ban": "Автор заблокирован по жалобе", "report_delete_ban": "Контент удалён, автор заблокирован",
    "ban": "Пользователь заблокирован", "unban": "Блокировка снята",
    "verify": "Выдана галочка", "unverify": "Галочка снята",
    "delete_post": "Удалена запись", "delete_comment": "Удалён комментарий",
    "delete_reel": "Удалён клип", "delete_reel_comment": "Удалён комментарий к клипу",
    "calls_settings": "Изменены ретрансляторы звонков",
}


def log(actor_id: int, action: str, target_type: str | None = None, target_id: int | None = None,
        target_user_id: int | None = None, role: str = "admin", details: dict | None = None) -> None:
    db.run("""INSERT INTO mod_log (actor_id, role, action, target_type, target_id, target_user_id, details)
              VALUES (?,?,?,?,?,?,?)""",
           (actor_id, role, action, target_type, target_id, target_user_id,
            json.dumps(details, ensure_ascii=False)[:2000] if details else None))


def snippet(text: str | None, n: int = 120) -> str:
    t = " ".join((text or "").split())
    return t if len(t) <= n else t[: n - 1] + "…"


def items(before: int | None = None, limit: int = 50, actor: int | None = None) -> tuple[list[dict], bool]:
    from . import social
    where, args = [], []
    if before:
        where.append("id < ?"); args.append(before)
    if actor:
        where.append("actor_id = ?"); args.append(actor)
    sql = "SELECT * FROM mod_log" + (" WHERE " + " AND ".join(where) if where else "") + " ORDER BY id DESC LIMIT ?"
    rows = db.all(sql, (*args, limit + 1))
    more = len(rows) > limit
    rows = rows[:limit]
    ids = {r["actor_id"] for r in rows} | {r["target_user_id"] for r in rows if r["target_user_id"]}
    cards = social.cards_by_ids(list(ids)) if ids else {}
    out = []
    for r in rows:
        try:
            details = json.loads(r["details"]) if r["details"] else {}
        except ValueError:
            details = {}
        out.append({"id": r["id"], "created_at": r["created_at"], "role": r["role"], "action": r["action"],
                    "label": ACTIONS.get(r["action"], r["action"]), "target_type": r["target_type"], "target_id": r["target_id"],
                    "actor": cards.get(r["actor_id"]), "target_user": cards.get(r["target_user_id"]), "details": details})
    return out, more
