"""Город: просмотр, стройка, улучшение, перенос, снос, казна, визиты друзей."""
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from .. import city, db
from ..web import ApiError, auth, body, limit


def _uid(username: str) -> int:
    uid = db.value("SELECT user_id FROM profiles WHERE username=?", (username,))
    if not uid:
        raise ApiError(404, "Пользователь не найден")
    return uid


def _run(fn, *a):
    try:
        return fn(*a)
    except city.CityError as e:
        raise ApiError(400, str(e))


def _int(d: dict, k: str) -> int:
    try:
        return int(d.get(k))
    except (TypeError, ValueError):
        raise ApiError(400, "Некорректные данные")


@auth()
async def get_city(request: Request):
    v = request.state.user["id"]
    uid = _uid(request.path_params["username"])
    from ..social import relation
    if uid != v and relation(v, uid).get("blocked_me"):
        raise ApiError(404, "Город недоступен")
    return JSONResponse(city.view(uid, v))


@auth()
async def build(request: Request):
    v = request.state.user["id"]
    limit(request, "write")
    d = await body(request)
    _run(city.build, v, str(d.get("kind") or ""), _int(d, "x"), _int(d, "y"))
    return JSONResponse(city.view(v, v), status_code=201)


@auth()
async def upgrade(request: Request):
    v = request.state.user["id"]
    limit(request, "write")
    _run(city.upgrade, v, int(request.path_params["id"]))
    return JSONResponse(city.view(v, v))


@auth()
async def move(request: Request):
    v = request.state.user["id"]
    d = await body(request)
    _run(city.move, v, int(request.path_params["id"]), _int(d, "x"), _int(d, "y"))
    return JSONResponse(city.view(v, v))


@auth()
async def demolish(request: Request):
    v = request.state.user["id"]
    _run(city.demolish, v, int(request.path_params["id"]))
    return JSONResponse(city.view(v, v))


@auth()
async def collect(request: Request):
    v = request.state.user["id"]
    limit(request, "write")
    got = _run(city.collect, v)
    return JSONResponse({"got": got, **city.view(v, v)})


@auth()
async def rename(request: Request):
    v = request.state.user["id"]
    d = await body(request)
    _run(city.rename, v, str(d.get("name") or ""))
    return JSONResponse(city.view(v, v))


@auth()
async def visit(request: Request):
    v = request.state.user["id"]
    limit(request, "write")
    uid = _uid(request.path_params["username"])
    d = await body(request)
    res = _run(city.visit, uid, v, str(d.get("action") or "postcard"))
    return JSONResponse({**res, **city.view(uid, v)})


routes = [
    Route("/api/city/build", build, methods=["POST"]),
    Route("/api/city/collect", collect, methods=["POST"]),
    Route("/api/city/name", rename, methods=["POST"]),
    Route("/api/city/buildings/{id:int}/upgrade", upgrade, methods=["POST"]),
    Route("/api/city/buildings/{id:int}/move", move, methods=["POST"]),
    Route("/api/city/buildings/{id:int}", demolish, methods=["DELETE"]),
    Route("/api/city/{username}", get_city, methods=["GET"]),
    Route("/api/city/{username}/visit", visit, methods=["POST"]),
]
