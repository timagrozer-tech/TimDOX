"""Подготовка при запуске контейнера: создаёт базу и, если задано SEED_DEMO=1, наполняет пустую базу демо-данными."""
import os


def migrate_env() -> None:
    """Переезд: при первом запуске на новом сервере забрать настройки со старого (один раз, по токену MIGRATE_TOKEN).
    Сохраняются в DATA_DIR/migrated.env и подхватываются настройками при каждом следующем запуске."""
    import json
    import urllib.request
    from pathlib import Path
    src = os.environ.get("MIGRATE_FROM", "https://krug-social.onrender.com")
    token = os.environ.get("MIGRATE_TOKEN", "")
    targets = [Path(os.environ.get("DATA_DIR", "data")) / "migrated.env", Path("/tmp/yarko-migrated.env")]
    if not (src and token) or targets[0].exists():
        return
    req = urllib.request.Request(src.rstrip("/") + "/api/edge/env", data=b"{}", method="POST",
                                 headers={"x-migrate-token": token, "content-type": "application/json"})
    try:
        env = json.load(urllib.request.urlopen(req, timeout=60))
    except Exception as e:  # noqa: BLE001
        print(f"Переезд: не удалось забрать настройки с {src}: {e}")
        return
    body = "".join(f"{k}={v}\n" for k, v in env.items() if "\n" not in str(v))
    for target in targets:  # постоянная папка, а если в неё нельзя писать — временная (тогда заберём снова при перезапуске)
        try:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(body, encoding="utf-8")
            target.chmod(0o600)
            print(f"Переезд: перенесено настроек — {len(env)} → {target}")
            return
        except OSError as e:
            print(f"Переезд: нет записи в {target}: {e}")


def main() -> None:
    migrate_env()  # до импорта приложения: настройки должны подхватиться при его загрузке
    from app import db
    db.connect()
    if os.environ.get("SEED_DEMO", "").lower() in ("1", "true", "yes") and not db.value("SELECT count(*) FROM users"):
        from scripts import seed
        seed.main()
        print("Демо-данные загружены (SEED_DEMO=1).")


if __name__ == "__main__":
    main()
