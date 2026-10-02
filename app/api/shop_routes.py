"""Магазин оформления: рамки, титулы, подарки."""
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from .. import db, shop
from ..web import ApiError, auth, body, limit


def _run(fn, *a):
    try:
        return fn(*a)
    except shop.ShopError as e:
        raise ApiError(400, str(e))


@auth()
async def get_shop(request: Request):
    return JSONResponse(shop.catalog(request.state.user["id"]))


@auth()
async def buy(request: Request):
    v = request.state.user["id"]
    limit(request, "write")
    d = await body(request)
    _run(shop.buy, v, str(d.get("item_id") or ""))
    return JSONResponse(shop.catalog(v))


@auth()
async def title(request: Request):
    v = request.state.user["id"]
    d = await body(request)
    _run(shop.set_title, v, d.get("item_id") or None)
    return JSONResponse(shop.catalog(v))


@auth()
async def equip(request: Request):
    v = request.state.user["id"]
    limit(request, "write")
    d = await body(request)
    _run(shop.equip, v, str(d.get("slot") or ""), d.get("item_id") or None)
    return JSONResponse(shop.catalog(v))


@auth()
async def gift(request: Request):
    v = request.state.user["id"]
    limit(request, "write")
    d = await body(request)
    to = db.value("SELECT user_id FROM profiles WHERE username=?", (str(d.get("to") or "").lstrip("@"),))
    if not to:
        raise ApiError(404, "Получатель не найден")
    from ..social import relation
    if relation(v, to).get("blocked_me") or relation(v, to).get("blocked_by_me"):
        raise ApiError(403, "Этому человеку нельзя отправить подарок")
    res = _run(shop.gift, v, to, str(d.get("item_id") or ""), str(d.get("note") or ""))
    return JSONResponse({**res, "kc": shop.economy.balances(v)["KC"]}, status_code=201)


@auth()
async def user_gifts(request: Request):
    uid = db.value("SELECT user_id FROM profiles WHERE username=?", (request.path_params["username"],))
    if not uid:
        raise ApiError(404, "Пользователь не найден")
    return JSONResponse({"items": shop.gifts_of(uid)})


routes = [
    Route("/api/shop", get_shop, methods=["GET"]),
    Route("/api/shop/buy", buy, methods=["POST"]),
    Route("/api/shop/equip", equip, methods=["POST"]),
    Route("/api/shop/title", title, methods=["POST"]),
    Route("/api/shop/gift", gift, methods=["POST"]),
    Route("/api/users/{username}/gifts", user_gifts, methods=["GET"]),
]
