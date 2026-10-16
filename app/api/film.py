"""«Фильм о вас»: данные для ролика, который браузер монтирует сам — фото, друзья, цифры, лучший пост, слово года.

Только свои данные человека (то, что он и так видит у себя). Тексты проходят цензуру — ролик можно опубликовать в Клипы.
"""
import re
from collections import Counter

from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from .. import db, social
from ..security import censor
from ..web import auth, limit

IMAGE_RE = re.compile(r"\.(webp|jpe?g|png|gif)$", re.I)
WORD_RE = re.compile(r"[а-яёa-z]{4,}", re.I)
# частые слова, которые ничего не говорят о человеке
STOP = set("""это этот эта эти того тому того тоже только очень когда потом сейчас всегда себя свой своя свои
который которая которые просто будет было были была есть если чтобы можно нужно даже всех всем всё все
меня тебя тебе мне него неё нему нами вами вас нас ними там тут здесь где куда почему потому зачем ещё
уже снова опять теперь вообще конечно кстати спасибо привет пожалуйста какой какая какие такой такая такие
этого этой этом этим чего чем что как так ага угу даже вот них нее них его еще более менее сегодня завтра вчера
with that this have from your what just like will about http https www com""".split())


def _cnt(sql: str, params: tuple) -> int:
    try:
        return int(db.value(sql, params) or 0)
    except Exception:  # noqa: BLE001 — таблицы может не быть в старой базе
        return 0


@auth()
async def film(request: Request):
    limit(request, "film")
    v = request.state.user["id"]
    me = db.one("""SELECT p.user_id AS id, p.username, p.name, p.avatar, p.city, u.created_at
                   FROM profiles p JOIN users u ON u.id = p.user_id WHERE p.user_id=?""", (v,))
    posts = db.all("SELECT id, text, created_at FROM posts WHERE author_id=? AND is_repost=0 AND community_id IS NULL ORDER BY id", (v,))
    post_ids = [p["id"] for p in posts]

    photos = [r["path"] for r in db.all(
        """SELECT m.path FROM post_media m JOIN posts p ON p.id = m.post_id
           WHERE p.author_id=? ORDER BY p.id DESC, m.position LIMIT 60""", (v,)) if IMAGE_RE.search(r["path"] or "")]

    reactions_in = _cnt("SELECT count(*) FROM reactions r JOIN posts p ON p.id = r.post_id WHERE p.author_id=? AND r.user_id<>?", (v, v))
    comments_in = _cnt("SELECT count(*) FROM comments c JOIN posts p ON p.id = c.post_id WHERE p.author_id=? AND c.author_id<>?", (v, v))
    friends = social.friend_ids(v)

    # кто из друзей чаще всех ставил реакции на ваши посты
    fans = Counter()
    if friends:
        ph = db.placeholders(friends)
        for r in db.all(f"""SELECT r.user_id, count(*) AS n FROM reactions r JOIN posts p ON p.id = r.post_id
                             WHERE p.author_id=? AND r.user_id IN ({ph}) GROUP BY r.user_id""", (v, *friends)):
            fans[r["user_id"]] = r["n"]
    order = sorted(friends, key=lambda f: -fans.get(f, 0))[:16]
    cards = social.cards_by_ids(order)
    friend_cards = [cards[f] for f in order if f in cards]
    top_friend = None
    if order and fans.get(order[0]) and order[0] in cards:
        top_friend = {**cards[order[0]], "reactions": fans[order[0]]}

    top_post = None
    if post_ids:
        row = db.one(f"""SELECT p.id, p.text, p.created_at, count(r.user_id) AS n FROM posts p
                         LEFT JOIN reactions r ON r.post_id = p.id
                         WHERE p.author_id=? AND p.is_repost=0 AND p.community_id IS NULL AND p.text<>''
                         GROUP BY p.id, p.text, p.created_at ORDER BY n DESC, p.id DESC LIMIT 1""", (v,))
        if row:
            img = db.value("SELECT path FROM post_media WHERE post_id=? ORDER BY position LIMIT 1", (row["id"],))
            top_post = {"id": row["id"], "text": censor(row["text"])[:220], "reactions": row["n"], "created_at": row["created_at"],
                        "image": img if img and IMAGE_RE.search(img) else None}

    words = Counter()
    for p in posts:
        for w in WORD_RE.findall((p["text"] or "").lower().replace("ё", "е")):
            if w not in STOP and not w.startswith("http"):
                words[w] += 1
    word = None
    for w, n in words.most_common(10):
        if n >= 2 and censor(w) == w:
            word = {"word": w, "count": n}
            break

    first = next((p for p in posts if (p["text"] or "").strip()), None)
    return JSONResponse({
        "me": {**social.cards_by_ids([v]).get(v, {}), "city": me["city"], "joined": me["created_at"]},
        "counts": {
            "posts": len(posts), "photos": len(photos), "friends": len(friends),
            "reactions": reactions_in, "comments": comments_in,
            "messages": _cnt("SELECT count(*) FROM messages WHERE sender_id=?", (v,)),
            "reels": _cnt("SELECT count(*) FROM reels WHERE author_id=?", (v,)),
            "songs": _cnt("SELECT count(*) FROM songs WHERE author_id=?", (v,)),
        },
        "photos": photos[:10],
        "friends": friend_cards,
        "top_friend": top_friend,
        "top_post": top_post,
        "first_post": {"text": censor(first["text"])[:140], "created_at": first["created_at"]} if first else None,
        "word": word,
        "times": [p["created_at"] for p in posts[-400:]],
    })


routes = [Route("/api/film", film, methods=["GET"])]
