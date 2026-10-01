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
async def econ_admin(request: Request):
    if not request.state.user["is_admin"]:
        raise ApiError(404, "Не найдено")
    return JSONResponse({"stats": economy.stats(), "audit": economy.audit()})


routes = [
    Route("/api/wallet", wallet, methods=["GET"]),
    Route("/api/wallet/checkin", checkin, methods=["POST"]),
    Route("/api/wallet/history", history, methods=["GET"]),
    Route("/api/quests/weekly/claim", weekly_claim, methods=["POST"]),
    Route("/api/quests/{slot:int}/claim", quest_claim, methods=["POST"]),
    Route("/api/quests/{slot:int}/swap", quest_swap, methods=["POST"]),
    Route("/api/admin/economy", econ_admin, methods=["GET"]),
]
