"""Подготовка при запуске контейнера: создаёт базу и, если задано SEED_DEMO=1, наполняет пустую базу демо-данными."""
import os

from app import db


def main() -> None:
    db.connect()
    if os.environ.get("SEED_DEMO", "").lower() in ("1", "true", "yes") and not db.value("SELECT count(*) FROM users"):
        from scripts import seed
        seed.main()
        print("Демо-данные загружены (SEED_DEMO=1).")


if __name__ == "__main__":
    main()
