"""Ретрансляторы звонков (TURN), которые создатель сети подключает сам в «Модерация → Звонки».

Если оба собеседника за «серыми» адресами мобильных операторов, прямое соединение WebRTC не строится —
нужен ретранслятор. Бесплатные варианты:
- Cloudflare Realtime TURN — 1000 ГБ в месяц бесплатно; нужны ID ключа TURN и API-токен из панели Cloudflare;
  временные логины выдаёт их API (POST …/turn/keys/<id>/credentials/generate-ice-servers);
- любой TURN с постоянным логином (ExpressTURN — 1000 ГБ бесплатно, свой coturn и т. п.).
Ключи хранятся в базе зашифрованными (twofa.encrypt) и никогда не отдаются в браузер целиком.
"""
import json
import logging
import time
import urllib.request

from . import db, twofa

log = logging.getLogger("krug.turn")
CF_API = "https://rtc.live.cloudflare.com/v1/turn/keys/{key}/credentials/generate-ice-servers"
_cf_cache: dict = {"at": 0.0, "servers": None, "key": ""}


def load() -> dict:
    raw = db.value("SELECT value FROM app_secrets WHERE name='turn_config'")
    if not raw:
        return {}
    try:
        return json.loads(twofa.decrypt(raw))
    except Exception:  # noqa: BLE001
        return {}


def save(cfg: dict) -> None:
    value = twofa.encrypt(json.dumps(cfg, ensure_ascii=False))
    if db.value("SELECT 1 FROM app_secrets WHERE name='turn_config'"):
        db.run("UPDATE app_secrets SET value=? WHERE name='turn_config'", (value,))
    else:
        db.run("INSERT INTO app_secrets (name, value) VALUES ('turn_config', ?)", (value,))
    _cf_cache.update(at=0.0, servers=None)


def public_view(cfg: dict) -> dict:
    """Что показать в настройках: без секретов"""
    cf, custom = cfg.get("cloudflare") or {}, cfg.get("custom") or {}
    key = cf.get("key_id", "")
    return {"cloudflare": {"configured": bool(key and cf.get("token")), "key_id": (key[:6] + "…" + key[-4:]) if len(key) > 12 else key},
            "custom": {"urls": custom.get("urls", []), "username": custom.get("username", ""), "has_credential": bool(custom.get("credential"))}}


def _cloudflare(cf: dict) -> list[dict]:
    key, token = cf.get("key_id", ""), cf.get("token", "")
    if not (key and token):
        return []
    if _cf_cache["servers"] is not None and _cf_cache["key"] == key and time.time() - _cf_cache["at"] < 6 * 3600:
        return _cf_cache["servers"]
    req = urllib.request.Request(CF_API.format(key=key), data=json.dumps({"ttl": 86400}).encode(), method="POST",
                                 headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as r:
        data = json.loads(r.read().decode())
    servers = data.get("iceServers") or []
    if isinstance(servers, dict):
        servers = [servers]
    servers = [s for s in servers if s.get("urls")]
    _cf_cache.update(at=time.time(), servers=servers, key=key)
    return servers


def servers(cfg: dict | None = None) -> list[dict]:
    cfg = load() if cfg is None else cfg
    out = []
    try:
        out += _cloudflare(cfg.get("cloudflare") or {})
    except Exception as e:  # noqa: BLE001 — ключ неверный или API недоступно: звонки пойдут через остальное
        log.warning("Cloudflare TURN: %s", e)
    custom = cfg.get("custom") or {}
    if custom.get("urls"):
        out.append({"urls": custom["urls"], "username": custom.get("username", ""), "credential": custom.get("credential", "")})
    return out
