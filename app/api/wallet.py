"""Кошелёк и задания: баланс, уровень, история, ежедневный вход, задания дня и недели."""
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from .. import economy
from ..web import ApiError, auth, body, limit

KIND_TITLES = {
    "login": "Вход за день", "streak7": "Серия 7 дней", "post": "Запись", "comment": "Комментарий",
    "reactions_in": "Реакции на ваши записи", "comments_in": "Комментарии к вашим записям",
    "quest": "Задание дня", "quest_all": "Все задания дня", "weekly": "Задание недели", "clawback": "Отмена награды",
    "treasury": "Казна города", "visit_guest": "Визит в город друга", "visit_host": "Гости в вашем городе",
    "build": "Стройка", "upgrade": "Улучшение здания",
    "support": "Поддержка автора", "transfer": "Перевод", "ai_stipend": "Стипендия Мира", "founder_grant": "Начисление создателю проекта", "shop": "Покупка в магазине", "gift": "Подарок",
}


def _summary(v: int) -> dict:
    b = economy.balances(v)
    st = economy.db.one("SELECT streak, last_day FROM econ_state WHERE user_id=?", (v,)) or {"streak": 0, "last_day": None}
    return {"kc": b["KC"], "kr": b["KR"], "level": economy.level_for(b["XP"]), "streak": st["streak"],
            "checked_in": st["last_day"] == economy.today()}


@auth()
async def wallet(request: Request):
    v = request.state.user["id"]
    return JSONResponse({**_summary(v), "quests": economy.quests(v), "weekly": economy.weekly(v)})


@auth()
async def checkin(request: Request):
    v = request.state.user["id"]
    limit(request, "write")
    r = economy.checkin(v)
    return JSONResponse({**r, **_summary(v)})


@auth()
async def history(request: Request):
    v = request.state.user["id"]
    before = request.query_params.get("before")
    rows = economy.history(v, int(before) if before and before.isdigit() else None)
    items = [{"id": r["id"], "title": KIND_TITLES.get(r["kind"], r["kind"]), "kind": r["kind"], "currency": r["currency"],
              "delta": r["delta"], "at": r["created_at"]} for r in rows]
    return JSONResponse({"items": items, "more": len(rows) == 30})


@auth()
async def quest_claim(request: Request):
    v = request.state.user["id"]
    limit(request, "write")
    slot = int(request.path_params["slot"])
    if slot not in (1, 2, 3):
        raise ApiError(404, "Задание не найдено")
    try:
        got = economy.claim(v, slot)
    except ValueError as e:
        raise ApiError(400, str(e))
    return JSONResponse({"got": got, **_summary(v), "quests": economy.quests(v), "weekly": economy.weekly(v)})


@auth()
async def quest_swap(request: Request):
    v = request.state.user["id"]
    limit(request, "write")
    try:
        q = economy.swap(v, int(request.path_params["slot"]))
    except ValueError as e:
        raise ApiError(400, str(e))
    return JSONResponse({"quests": q})


@auth()
async def weekly_claim(request: Request):
    v = request.state.user["id"]
    limit(request, "write")
    try:
        got = economy.claim_weekly(v)
    except ValueError as e:
        raise ApiError(400, str(e))
    return JSONResponse({"got": got, **_summary(v), "weekly": economy.weekly(v)})


@auth()
async def transfer(request: Request):
    """Перевод другу: 5% сгорает, суточный лимит по доверию, больше 1 000 KC — с кодом 2FA."""
    v = request.state.user["id"]
    limit(request, "write")
    d = await body(request)
    to = economy.db.value("SELECT user_id FROM profiles WHERE username=?", (str(d.get("to") or "").lstrip("@"),))
    if not to:
        raise ApiError(404, "Получатель не найден")
    try:
        amount = int(d.get("amount") or 0)
    except (TypeError, ValueError):
        raise ApiError(400, "Некорректная сумма")
    cap = economy.transfer_limit(v)
    if cap == 0:
        raise ApiError(403, "Переводы открываются через 14 дней после регистрации")
    from ..social import friend_ids
    if not economy.is_admin(v) and to not in set(friend_ids(v)):
        raise ApiError(403, "Переводить можно только друзьям")
    if economy.linked(v, to):
        raise ApiError(403, "Нельзя переводить своим же аккаунтам — вы входите в них с одного устройства")
    sent = economy._count(v, economy.today(), "_sent:transfer")["amount"]
    if amount < 10 or sent + amount > cap:
        raise ApiError(400, f"От 10 KC; сегодня можно перевести ещё {max(0, cap - sent)} KC")
    if amount > 1000:
        from .. import twofa
        if not twofa.check(v, str(d.get("code") or "")):
            raise ApiError(400, "Для перевода больше 1 000 KC нужен код из приложения 2FA")
    note = str(d.get("note") or "")[:120]
    try:
        res = economy.transfer(v, to, amount, "transfer", economy.TRANSFER_FEE, ref=f"to{to}", meta={"note": note} if note else None)
    except economy.EconError as e:
        raise ApiError(400, str(e))
    from .. import social
    social.notify(to, v, "transfer", extra={"amount": res["net"], "note": note})
    return JSONResponse({**res, **_summary(v)})


@auth()
async def econ_admin(request: Request):
    if not request.state.user["is_admin"]:
        raise ApiError(404, "Не найдено")
    return JSONResponse({"stats": economy.stats(), "audit": economy.audit()})


routes = [
    Route("/api/wallet", wallet, methods=["GET"]),
    Route("/api/wallet/checkin", checkin, methods=["POST"]),
    Route("/api/wallet/history", history, methods=["GET"]),
    Route("/api/wallet/transfer", transfer, methods=["POST"]),
    Route("/api/quests/weekly/claim", weekly_claim, methods=["POST"]),
    Route("/api/quests/{slot:int}/claim", quest_claim, methods=["POST"]),
    Route("/api/quests/{slot:int}/swap", quest_swap, methods=["POST"]),
    Route("/api/admin/economy", econ_admin, methods=["GET"]),
]
