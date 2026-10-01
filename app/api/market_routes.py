"""Рынок: лоты, покупка, снятие, мои лоты, что можно продать."""
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from .. import economy, market
from ..web import ApiError, auth, body, limit


def _run(fn, *a):
    try:
        return fn(*a)
    except market.MarketError as e:
        raise ApiError(400, str(e))


@auth()
async def index(request: Request):
    v = request.state.user["id"]
    kind = request.query_params.get("kind")
    sort = request.query_params.get("sort") or "new"
    return JSONResponse({"items": market.listings(v, kind if kind in ("frame", "title") else None, sort),
                         "kc": economy.balances(v)["KC"]})


@auth()
async def mine(request: Request):
    v = request.state.user["id"]
    return JSONResponse({"items": market.mine(v), "sellable": market.sellable(v), "kc": economy.balances(v)["KC"]})


@auth()
async def create(request: Request):
    v = request.state.user["id"]
    limit(request, "write")
    d = await body(request)
    try:
        price = int(d.get("price") or 0)
    except (TypeError, ValueError):
        raise ApiError(400, "Некорректная цена")
    lid = _run(market.create, v, str(d.get("item_id") or ""), price)
    return JSONResponse({"id": lid}, status_code=201)


@auth()
async def buy(request: Request):
    v = request.state.user["id"]
    limit(request, "write")
    res = _run(market.buy, v, int(request.path_params["id"]))
    return JSONResponse({**res, "kc": economy.balances(v)["KC"]})


@auth()
async def cancel(request: Request):
    v = request.state.user["id"]
    _run(market.cancel, v, int(request.path_params["id"]))
    return JSONResponse({"ok": True})


routes = [
    Route("/api/market", index, methods=["GET"]),
    Route("/api/market", create, methods=["POST"]),
    Route("/api/market/mine", mine, methods=["GET"]),
    Route("/api/market/{id:int}/buy", buy, methods=["POST"]),
    Route("/api/market/{id:int}", cancel, methods=["DELETE"]),
]
