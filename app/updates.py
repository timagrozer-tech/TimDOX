"""Официальный ИИ-профиль @krug_updates: после каждой выкладки публикует посты о новом (с обложкой и экранами)
и отвечает на вопросы под ними с помощью нейросети. Вопросы и жалобы под постами получают и администраторы.

Источник правды — app/releases.py. Публикация идемпотентна (ключ release:<id> в ai_state), поэтому
перезапуски и несколько экземпляров сервера не дублируют посты."""
import logging
import re
import secrets
import threading
from pathlib import Path

from . import config, db, social
from .releases import RELEASES
from .security import censor, clean_text, hash_password

log = logging.getLogger("krug.updates")
USERNAME = "yarko"
LEGACY_USERNAMES = ("qevi", "krug_updates")   # прежние адреса — открываются как алиасы (social.USERNAME_ALIASES)
NAME = "Yarko"
BIO = "Официальный канал Yarko: новые функции, анонсы и ответы на ваши вопросы в комментариях ✨"
GAP_MINUTES = 40           # пауза между постами, если вышло сразу несколько обновлений
REPLIES_PER_HOUR = 4       # ответов одному человеку в час
IMG_DIR = Path(config.STATIC_DIR) / "img" / "updates"
_reply_lock = threading.Lock()


def account_id() -> int | None:
    return db.value("SELECT user_id FROM profiles WHERE username=?", (USERNAME,))


def migrate_legacy() -> None:
    """Ребрендинг: профиль со старым адресом (@qevi, @krug_updates) становится @yarko с новым именем и аватаром (один раз)."""
    if account_id():
        return
    old = legacy = None
    for legacy in LEGACY_USERNAMES:
        old = db.value("SELECT user_id FROM profiles WHERE username=?", (legacy,))
        if old:
            break
    if not old:
        return
    db.run("UPDATE profiles SET username=?, name=?, bio=?, verified=1, badge='Официальный' WHERE user_id=?", (USERNAME, NAME, BIO, old))
    ava = _store(IMG_DIR / "avatar.png", "avatar")
    cov = _store(IMG_DIR / "cover.jpg", "cover")
    if ava or cov:
        db.run("UPDATE profiles SET avatar=COALESCE(?, avatar), cover=COALESCE(?, cover) WHERE user_id=?",
               (ava and ava["path"], cov and cov["path"], old))
    log.info("Официальный профиль переименован: @%s → @%s", legacy, USERNAME)


def _store(path: Path, preset: str) -> dict | None:
    from .media import process_and_store
    try:
        return process_and_store(path.read_bytes(), preset)
    except Exception:
        log.exception("Не удалось сохранить %s", path)
        return None


CHANNEL_GENERATION = "2"   # смена значения — старый официальный канал удаляется и создаётся новый (один раз)


def reset_channel() -> bool:
    """Пересоздание официального канала: старый профиль удаляется вместе с постами, комментариями к ним и файлами,
    затем ensure_account() создаёт новый (все пользователи снова подписаны). Уже вышедшие обновления заново не публикуются."""
    if not _claim(f"channel:generation:{CHANNEL_GENERATION}"):
        return False
    old = account_id()
    if not old:
        for legacy in LEGACY_USERNAMES:
            old = db.value("SELECT user_id FROM profiles WHERE username=?", (legacy,))
            if old:
                break
    if not old:
        return False
    from . import media
    from .api.posts import delete_post_files
    post_ids = [r["id"] for r in db.all("SELECT id FROM posts WHERE author_id=?", (old,))]
    if post_ids:
        delete_post_files(post_ids)
    prof = db.one("SELECT avatar, cover, background FROM profiles WHERE user_id=?", (old,))
    if prof:
        media.delete_files(prof["avatar"], prof["cover"], prof["background"])
    db.run("DELETE FROM reports WHERE target_type='user' AND target_id=?", (old,))
    db.run("DELETE FROM users WHERE id=?", (old,))  # посты, комментарии, подписки — каскадно
    log.info("Старый официальный канал удалён (пользователь %s, постов %s)", old, len(post_ids))
    return True


def ensure_account() -> int:
    migrate_legacy()
    reset_channel()
    uid = account_id()
    if uid:
        return uid
    with db.tx() as c:
        uid = c.execute("INSERT INTO users (email, password_hash, email_verified_at, consent_at) VALUES (?,?,?,?)",
                        ("updates@system.krug", hash_password(secrets.token_urlsafe(32)), db.now(), db.now())).lastrowid
        c.execute("""INSERT INTO profiles (user_id, username, name, bio, profile_visibility, message_privacy, verified, badge)
                     VALUES (?,?,?,?, 'public', 'friends', 1, 'Официальный')""", (uid, USERNAME, NAME, BIO))
    ava = _store(IMG_DIR / "avatar.png", "avatar")
    cov = _store(IMG_DIR / "cover.jpg", "cover")
    db.run("UPDATE profiles SET avatar=?, cover=? WHERE user_id=?", (ava and ava["path"], cov and cov["path"], uid))
    # официальный канал: подписаны все (отписаться можно как от любого профиля)
    for r in db.all("SELECT id FROM users WHERE id<>?", (uid,)):
        db.run("INSERT OR IGNORE INTO follows (follower_id, followee_id) VALUES (?,?)", (r["id"], uid))
    log.info("Создан официальный профиль @%s", USERNAME)
    return uid


def follow_new_user(user_id: int) -> None:
    uid = account_id()
    if uid and uid != user_id:
        db.run("INSERT OR IGNORE INTO follows (follower_id, followee_id) VALUES (?,?)", (user_id, uid))


def _claim(key: str) -> bool:
    if db.value("SELECT 1 FROM ai_state WHERE key=?", (key,)):
        return False
    try:
        db.run("INSERT INTO ai_state (key, value) VALUES (?, ?)", (key, db.now()))
        return True
    except Exception:  # другой экземпляр успел первым
        return False


def _images(rid: str, n: int) -> list[Path]:
    out = [IMG_DIR / f"{rid}.jpg"]
    out += [IMG_DIR / f"{rid}-{i}.jpg" for i in range(1, n + 1)]
    return [p for p in out if p.is_file()][:10]


def publish(rel: dict, uid: int) -> int:
    from .api.posts import _index_text
    saved = [s for s in (_store(p, "post") for p in _images(rel["id"], int(rel.get("images") or 0))) if s]
    text = censor(clean_text(rel["text"], 3000))
    with db.tx() as c:
        pid = c.execute("INSERT INTO posts (author_id, text, visibility) VALUES (?,?, 'public')", (uid, text)).lastrowid
        for i, s in enumerate(saved):
            c.execute("INSERT INTO post_media (post_id, path, thumb, width, height, alt, position) VALUES (?,?,?,?,?,?,?)",
                      (pid, s["path"], s["thumb"], s["width"], s["height"], "Обновление Yarko" if i == 0 else "Экран новой функции", i))
    _index_text(pid, uid, text, "public", notify_mentions=False)
    db.run("UPDATE ai_state SET value=? WHERE key=?", (str(pid), f"release:{rel['id']}"))
    log.info("Опубликовано обновление %s (пост %s)", rel["id"], pid)
    return pid


def publish_next() -> int | None:
    """Публикует одно ещё не опубликованное обновление, если с прошлого поста прошло достаточно времени."""
    uid = ensure_account()
    last = db.value("SELECT max(created_at) FROM posts WHERE author_id=?", (uid,))
    if last and last > db.future(minutes=-GAP_MINUTES):
        return None
    for rel in RELEASES:
        if db.value("SELECT 1 FROM ai_state WHERE key=?", (f"release:{rel['id']}",)):
            continue
        if _claim(f"release:{rel['id']}"):
            return publish(rel, uid)
        return None
    return None


def run_once() -> None:
    try:
        publish_next()
    except Exception:
        log.exception("Публикация обновлений")


# ---------------------------------------------------------------- ответы в комментариях
SYSTEM = (
    "Ты — официальный канал «Yarko» платформы Yarko. Отвечаешь на комментарии под "
    "постами об обновлениях. Пиши по-русски, дружелюбно и коротко: 1–3 предложения, без markdown и без списков. "
    "Опирайся только на факты из журнала обновлений ниже. Если ответа там нет или это жалоба на ошибку — честно скажи, "
    "что передал вопрос создателю Yarko. Не обещай сроков, не выдумывай функции, не раскрывай технические детали, "
    "не обсуждай темы вне сайта. Не здоровайся каждый раз заново."
)


def _context() -> str:
    return "\n\n".join(r["text"] for r in RELEASES)[:6000]


def reply(comment_id: int) -> int | None:
    from .world import llm
    uid = account_id()
    row = db.one("""SELECT c.id, c.text, c.author_id, c.parent_id, c.post_id, p.author_id AS post_author, p.text AS post_text
                    FROM comments c JOIN posts p ON p.id = c.post_id WHERE c.id=?""", (comment_id,))
    if not row or not uid or row["post_author"] != uid or row["author_id"] == uid:
        return None
    hour_ago = db.future(minutes=-60)
    mine = db.value("""SELECT count(*) FROM comments r JOIN comments q ON q.id = r.parent_id
                       WHERE r.author_id=? AND q.author_id=? AND r.created_at>?""", (uid, row["author_id"], hour_ago)) or 0
    from . import consents
    if mine >= REPLIES_PER_HOUR or not llm.enabled() or not consents.has(row["author_id"], "ai"):
        return None
    name = db.value("SELECT name FROM profiles WHERE user_id=?", (row["author_id"],)) or "пользователь"
    user = (f"Журнал обновлений:\n{_context()}\n\nПост, под которым вопрос:\n{row['post_text'][:1500]}\n\n"
            f"Комментарий от {name}: «{row['text'][:600]}»\n\nНапиши ответ.")
    text = llm.complete(SYSTEM, user, max_tokens=260)
    if not text:
        return None
    text = re.sub(r"[*_#`]+", "", text).strip().strip("«»\"")
    text = censor(clean_text(text, 700))
    if not text:
        return None
    parent = row["parent_id"] or row["id"]
    cid = db.run("INSERT INTO comments (post_id, author_id, parent_id, text) VALUES (?,?,?,?)",
                 (row["post_id"], uid, parent, text)).lastrowid
    social.notify(row["author_id"], uid, "reply", post_id=row["post_id"], comment_id=cid)
    return cid


def on_comment(post_author: int, post_id: int, comment_id: int, commenter: int) -> None:
    """Вызывается после нового комментария. Для постов @krug_updates: ответить и показать вопрос администраторам."""
    uid = account_id()
    if not uid or post_author != uid or commenter == uid:
        return
    for r in db.all("SELECT id FROM users WHERE is_admin=1 AND id<>?", (commenter,)):
        social.notify(r["id"], commenter, "comment", post_id=post_id, comment_id=comment_id)

    def work():
        with _reply_lock:
            try:
                reply(comment_id)
            except Exception:
                log.exception("Ответ на комментарий %s", comment_id)
    threading.Thread(target=work, daemon=True).start()
