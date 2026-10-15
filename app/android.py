"""Android-приложение Yarko (TWA): файл связи сайта с приложением и ссылка на скачивание.

assetlinks.json подтверждает Android, что приложение space.yarko.app принадлежит сайту, — тогда оно открывается
во весь экран, без адресной строки. Отпечаток — открытая часть ключа подписи (не секрет).
"""
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

PACKAGE = "space.yarko.app"
SHA256 = "88:C2:8E:0A:C0:16:67:9E:80:68:87:9D:89:AE:1B:CF:31:C0:B5:2F:EB:0E:7D:E8:F6:0C:A6:CE:E7:B3:46:F2"


async def assetlinks(request: Request):
    return JSONResponse([{
        "relation": ["delegate_permission/common.handle_all_urls"],
        "target": {"namespace": "android_app", "package_name": PACKAGE, "sha256_cert_fingerprints": [SHA256]},
    }], headers={"Cache-Control": "public, max-age=3600", "Access-Control-Allow-Origin": "*"})


routes = [Route("/.well-known/assetlinks.json", assetlinks, methods=["GET"])]
