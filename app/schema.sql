-- Схема базы данных «Круг» (SQLite). Каждая таблица соответствует сущности из ТЗ.
PRAGMA foreign_keys = ON;

-- Учётная запись: вход, пароль, статус подтверждения почты
CREATE TABLE IF NOT EXISTS users (
    id                INTEGER PRIMARY KEY,
    email             TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash     TEXT NOT NULL,
    email_verified_at TEXT,
    is_admin          INTEGER NOT NULL DEFAULT 0,
    is_banned         INTEGER NOT NULL DEFAULT 0,
    consent_at        TEXT NOT NULL,             -- согласие на обработку персональных данных
    created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    last_seen_at      TEXT
);

-- Публичный профиль и настройки приватности
CREATE TABLE IF NOT EXISTS profiles (
    user_id            INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    username           TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name               TEXT NOT NULL,
    avatar             TEXT,
    cover              TEXT,
    bio                TEXT NOT NULL DEFAULT '',
    city               TEXT NOT NULL DEFAULT '',
    birth_date         TEXT,
    education          TEXT NOT NULL DEFAULT '',
    work               TEXT NOT NULL DEFAULT '',
    relationship       TEXT NOT NULL DEFAULT '',
    -- приватность
    profile_visibility TEXT NOT NULL DEFAULT 'public'  CHECK (profile_visibility IN ('public','friends')),
    message_privacy    TEXT NOT NULL DEFAULT 'all'     CHECK (message_privacy IN ('all','friends')),
    friends_visibility TEXT NOT NULL DEFAULT 'public'  CHECK (friends_visibility IN ('public','friends','only_me')),
    show_birth_date    INTEGER NOT NULL DEFAULT 1,
    default_visibility TEXT NOT NULL DEFAULT 'public'  CHECK (default_visibility IN ('public','friends','only_me')),
    theme              TEXT NOT NULL DEFAULT 'system'  CHECK (theme IN ('system','light','dark'))
);
CREATE INDEX IF NOT EXISTS idx_profiles_name ON profiles(name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS sessions (
    id          TEXT PRIMARY KEY,                -- sha256 от токена из cookie
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    csrf_token  TEXT NOT NULL,
    user_agent  TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    expires_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- Токены подтверждения почты и сброса пароля
CREATE TABLE IF NOT EXISTS email_tokens (
    id          TEXT PRIMARY KEY,                -- sha256 от токена
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL CHECK (kind IN ('verify','reset')),
    expires_at  TEXT NOT NULL,
    used_at     TEXT
);

-- Дружба: заявка -> подтверждение (двусторонняя)
CREATE TABLE IF NOT EXISTS friendships (
    id           INTEGER PRIMARY KEY,
    requester_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    addressee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status       TEXT NOT NULL CHECK (status IN ('pending','accepted')),
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    accepted_at  TEXT,
    user_low     INTEGER GENERATED ALWAYS AS (min(requester_id, addressee_id)) STORED,
    user_high    INTEGER GENERATED ALWAYS AS (max(requester_id, addressee_id)) STORED,
    UNIQUE (user_low, user_high)
);
CREATE INDEX IF NOT EXISTS idx_friend_req ON friendships(requester_id, status);
CREATE INDEX IF NOT EXISTS idx_friend_addr ON friendships(addressee_id, status);

-- Односторонняя подписка
CREATE TABLE IF NOT EXISTS follows (
    follower_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    followee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (follower_id, followee_id)
);
CREATE INDEX IF NOT EXISTS idx_follows_followee ON follows(followee_id);

CREATE TABLE IF NOT EXISTS blocks (
    blocker_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    blocked_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (blocker_id, blocked_id)
);

-- Посты. quote_of != NULL — репост (с пустым текстом) или репост с цитатой
CREATE TABLE IF NOT EXISTS posts (
    id          INTEGER PRIMARY KEY,
    author_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    text        TEXT NOT NULL DEFAULT '',
    visibility  TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','friends','only_me')),
    quote_of    INTEGER REFERENCES posts(id) ON DELETE SET NULL,
    is_repost   INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    edited_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_posts_author ON posts(author_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_posts_quote ON posts(quote_of);

CREATE TABLE IF NOT EXISTS post_media (
    id         INTEGER PRIMARY KEY,
    post_id    INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    path       TEXT NOT NULL,
    thumb      TEXT NOT NULL,
    width      INTEGER NOT NULL,
    height     INTEGER NOT NULL,
    alt        TEXT NOT NULL DEFAULT '',
    position   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_media_post ON post_media(post_id, position);

-- Реакции: like, love, haha, wow, sad, angry
CREATE TABLE IF NOT EXISTS reactions (
    post_id    INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type       TEXT NOT NULL CHECK (type IN ('like','love','haha','wow','sad','angry')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (post_id, user_id)
);

-- Комментарии: один уровень вложенности (parent_id указывает на корневой комментарий)
CREATE TABLE IF NOT EXISTS comments (
    id         INTEGER PRIMARY KEY,
    post_id    INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    author_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    parent_id  INTEGER REFERENCES comments(id) ON DELETE CASCADE,
    text       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id, id);

CREATE TABLE IF NOT EXISTS bookmarks (
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    post_id    INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (user_id, post_id)
);

CREATE TABLE IF NOT EXISTS hashtags (
    id  INTEGER PRIMARY KEY,
    tag TEXT NOT NULL UNIQUE COLLATE NOCASE
);
CREATE TABLE IF NOT EXISTS post_hashtags (
    post_id    INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    hashtag_id INTEGER NOT NULL REFERENCES hashtags(id) ON DELETE CASCADE,
    PRIMARY KEY (post_id, hashtag_id)
);
CREATE INDEX IF NOT EXISTS idx_post_hashtags_tag ON post_hashtags(hashtag_id, post_id DESC);

CREATE TABLE IF NOT EXISTS mentions (
    post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (post_id, user_id)
);

-- Переписка (в MVP — диалоги 1-на-1; структура готова к групповым чатам)
CREATE TABLE IF NOT EXISTS conversations (
    id              INTEGER PRIMARY KEY,
    is_group        INTEGER NOT NULL DEFAULT 0,
    direct_key      TEXT UNIQUE,                 -- "minId:maxId" для личного диалога
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    last_message_at TEXT
);
CREATE TABLE IF NOT EXISTS conversation_members (
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    last_read_id    INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_members_user ON conversation_members(user_id);
CREATE TABLE IF NOT EXISTS messages (
    id              INTEGER PRIMARY KEY,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    sender_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    text            TEXT NOT NULL,
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, id DESC);

-- Уведомления: reaction, comment, reply, mention, friend_request, friend_accept, follow, repost
CREATE TABLE IF NOT EXISTS notifications (
    id         INTEGER PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    actor_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type       TEXT NOT NULL,
    post_id    INTEGER REFERENCES posts(id) ON DELETE CASCADE,
    comment_id INTEGER REFERENCES comments(id) ON DELETE CASCADE,
    extra      TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    read_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, id DESC);

-- Жалобы
CREATE TABLE IF NOT EXISTS reports (
    id          INTEGER PRIMARY KEY,
    reporter_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    target_type TEXT NOT NULL CHECK (target_type IN ('post','comment','user')),
    target_id   INTEGER NOT NULL,
    reason      TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'open',
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
