"""API коллекции: список предметов с прогрессом, надевание, витрина чужого профиля."""
import json

from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from .. import collection, db
from ..web import ApiError, auth, body, limit


@auth()
async def my_collection(request: Request):
    uid = request.state.user["id"]
    new = collection.check(uid, force=True)
    have = collection.owned(uid)
    st = collection.stats(uid)
    equipped = collection.parse_equipped(db.value("SELECT equipped FROM profiles WHERE user_id=?", (uid,)))
    return JSONResponse({
        "items": [collection.item_view(i, have, st) for i in collection.ITEMS],
        "slots": collection.SLOTS,
        "rarities": collection.RARITIES,
        "stats": st,
        "equipped": equipped,
        "new": new,
        "owned_count": len(have),
        "total": len(collection.ITEMS),
    })


@auth()
async def equip(request: Request):
    limit(request, "write")
    uid = request.state.user["id"]
    data = await body(request)
    slot = data.get("slot")
    item_id = data.get("item_id")
    if slot not in collection.SLOTS:
        raise ApiError(400, "Неизвестный слот")
    equipped = collection.parse_equipped(db.value("SELECT equipped FROM profiles WHERE user_id=?", (uid,)))
    if item_id:
        item = collection.ITEM_BY_ID.get(item_id)
        if not item or item[1] != slot:
            raise ApiError(400, "Неизвестный предмет")
        if item_id not in collection.owned(uid):
            raise ApiError(403, "Этот предмет ещё не получен — его можно только заработать")
        equipped[slot] = item_id
    else:
        equipped.pop(slot, None)
    db.run("UPDATE profiles SET equipped=? WHERE user_id=?", (json.dumps(equipped) if equipped else None, uid))
    return JSONResponse({"equipped": equipped})


def showcase(uid: int) -> dict:
    """Витрина для профиля: надетые предметы и полученные (без прогресса)."""
    have = collection.owned(uid)
    items = [collection.item_view(i) for i in collection.ITEMS if i[0] in have]
    order = list(collection.RARITIES)
    items.sort(key=lambda x: -order.index(x["rarity"]))
    return {"owned": items, "total": len(collection.ITEMS)}


routes = [
    Route("/api/collection", my_collection, methods=["GET"]),
    Route("/api/collection/equip", equip, methods=["PATCH"]),
]
