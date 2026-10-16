"""Android-приложение Yarko (TWA): файл связи сайта с приложением и ссылка на скачивание.

assetlinks.json подтверждает Android, что приложение space.yarko.app принадлежит сайту, — тогда оно открывается
во весь экран, без адресной строки. Отпечаток — открытая часть ключа подписи (не секрет).
"""
from starlette.requests import Request
from starlette.responses import JSONResponse, RedirectResponse
from starlette.routing import Route

PACKAGE = "space.yarko.app"
# второе приложение — «Ярко Плеер» (офлайн-плеер своей музыки, /static/player/); подписано тем же ключом
PACKAGES = (PACKAGE, "space.yarko.player")
SHA256 = "88:C2:8E:0A:C0:16:67:9E:80:68:87:9D:89:AE:1B:CF:31:C0:B5:2F:EB:0E:7D:E8:F6:0C:A6:CE:E7:B3:46:F2"


def statement(package: str = PACKAGE) -> dict:
    return {"relation": ["delegate_permission/common.handle_all_urls"],
            "target": {"namespace": "android_app", "package_name": package, "sha256_cert_fingerprints": [SHA256]}}


def merge_static_assetlinks(site) -> bool:
    """Если на хостинге уже лежит свой .well-known/assetlinks.json (его отдаёт веб-сервер, минуя приложение),
    дописываем туда запись Yarko, ничего из существующего не удаляя. Возвращает True, если файл изменён."""
    import json
    import os
    from pathlib import Path
    f = Path(site) / ".well-known" / "assetlinks.json"
    if not f.is_file():
        return False
    try:
        data = json.loads(f.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    if not isinstance(data, list):
        return False
    changed = False
    for pkg in PACKAGES:
        for st in data:
            t = (st or {}).get("target") or {}
            if t.get("package_name") == pkg:
                if SHA256 not in (t.get("sha256_cert_fingerprints") or []):
                    t.setdefault("sha256_cert_fingerprints", []).append(SHA256)
                    changed = True
                break
        else:
            data.append(statement(pkg))
            changed = True
    if not changed:
        return False
    tmp = f.with_name("assetlinks.json.new")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, f)
    return True


async def assetlinks(request: Request):
    return JSONResponse([statement(p) for p in PACKAGES], headers={"Cache-Control": "public, max-age=3600", "Access-Control-Allow-Origin": "*"})


async def player(request: Request):
    return RedirectResponse("/static/player/index.html" + (("?" + request.url.query) if request.url.query else ""), status_code=302)


async def genesis(request: Request):
    return RedirectResponse("/static/genesis/index.html", status_code=302)


routes = [Route("/.well-known/assetlinks.json", assetlinks, methods=["GET"]),
          Route("/genesis", genesis, methods=["GET", "HEAD"]), Route("/genesis/", genesis, methods=["GET", "HEAD"]),
          Route("/player", player, methods=["GET", "HEAD"]), Route("/player/", player, methods=["GET", "HEAD"])]
