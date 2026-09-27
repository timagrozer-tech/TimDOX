-- Схема «Круга» для PostgreSQL (Supabase и др.). Та же структура, что и app/schema.sql для SQLite.
SET client_min_messages = warning;
-- Время хранится в текстовом виде ISO-8601 (UTC), как и в SQLite, чтобы запросы были одинаковыми.
CREATE EXTENSION IF NOT EXISTS citext;

CREATE OR REPLACE FUNCTION krug_now() RETURNS text LANGUAGE sql STABLE AS
$$ SELECT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') $$;

CREATE TABLE IF NOT EXISTS users (
    id                BIGSERIAL PRIMARY KEY,
    email             CITEXT NOT NULL UNIQUE,
    password_hash     TEXT NOT NULL,
    email_verified_at TEXT,
    is_admin          INTEGER NOT NULL DEFAULT 0,
    is_banned         INTEGER NOT NULL DEFAULT 0,
    consent_at        TEXT NOT NULL,
    created_at        TEXT NOT NULL DEFAULT krug_now(),
    last_seen_at      TEXT
);

CREATE TABLE IF NOT EXISTS profiles (
    user_id            BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    username           CITEXT NOT NULL UNIQUE,
    name               TEXT NOT NULL,
    avatar             TEXT,
    cover              TEXT,
    bio                TEXT NOT NULL DEFAULT '',
    city               TEXT NOT NULL DEFAULT '',
    birth_date         TEXT,
    education          TEXT NOT NULL DEFAULT '',
    work               TEXT NOT NULL DEFAULT '',
    relationship       TEXT NOT NULL DEFAULT '',
    profile_visibility TEXT NOT NULL DEFAULT 'public'  CHECK (profile_visibility IN ('public','friends')),
    message_privacy    TEXT NOT NULL DEFAULT 'all'     CHECK (message_privacy IN ('all','friends')),
    friends_visibility TEXT NOT NULL DEFAULT 'public'  CHECK (friends_visibility IN ('public','friends','only_me')),
    show_birth_date    INTEGER NOT NULL DEFAULT 1,
    default_visibility TEXT NOT NULL DEFAULT 'public'  CHECK (default_visibility IN ('public','friends','only_me')),
    theme              TEXT NOT NULL DEFAULT 'system'  CHECK (theme IN ('system','light','dark')),
    school             TEXT NOT NULL DEFAULT '',
    school_year        INTEGER,
    university         TEXT NOT NULL DEFAULT '',
    university_year    INTEGER,
    invisible          INTEGER NOT NULL DEFAULT 0,
    guests_seen_at     TEXT,
    appearance         TEXT,
    background         TEXT
);
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS appearance TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS background TEXT;
CREATE INDEX IF NOT EXISTS idx_profiles_name ON profiles(lower(name));
CREATE INDEX IF NOT EXISTS idx_profiles_school ON profiles(school_year);

CREATE TABLE IF NOT EXISTS sessions (
    id          TEXT PRIMARY KEY,
    user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    csrf_token  TEXT NOT NULL,
    user_agent  TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL DEFAULT krug_now(),
    expires_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS email_tokens (
    id          TEXT PRIMARY KEY,
    user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL CHECK (kind IN ('verify','reset')),
    expires_at  TEXT NOT NULL,
    used_at     TEXT
);

CREATE TABLE IF NOT EXISTS friendships (
    id           BIGSERIAL PRIMARY KEY,
    requester_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    addressee_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status       TEXT NOT NULL CHECK (status IN ('pending','accepted')),
    created_at   TEXT NOT NULL DEFAULT krug_now(),
    accepted_at  TEXT,
    user_low     BIGINT GENERATED ALWAYS AS (least(requester_id, addressee_id)) STORED,
    user_high    BIGINT GENERATED ALWAYS AS (greatest(requester_id, addressee_id)) STORED,
    UNIQUE (user_low, user_high)
);
CREATE INDEX IF NOT EXISTS idx_friend_req ON friendships(requester_id, status);
CREATE INDEX IF NOT EXISTS idx_friend_addr ON friendships(addressee_id, status);

CREATE TABLE IF NOT EXISTS follows (
    follower_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    followee_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  TEXT NOT NULL DEFAULT krug_now(),
    PRIMARY KEY (follower_id, followee_id)
);
CREATE INDEX IF NOT EXISTS idx_follows_followee ON follows(followee_id);

CREATE TABLE IF NOT EXISTS blocks (
    blocker_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    blocked_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT krug_now(),
    PRIMARY KEY (blocker_id, blocked_id)
);

CREATE TABLE IF NOT EXISTS circles (
    id         BIGSERIAL PRIMARY KEY,
    owner_id   BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT krug_now(),
    UNIQUE (owner_id, name)
);
CREATE TABLE IF NOT EXISTS circle_members (
    circle_id BIGINT NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
    user_id   BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (circle_id, user_id)
);

CREATE TABLE IF NOT EXISTS communities (
    id             BIGSERIAL PRIMARY KEY,
    slug           CITEXT NOT NULL UNIQUE,
    name           TEXT NOT NULL,
    description    TEXT NOT NULL DEFAULT '',
    avatar         TEXT,
    cover          TEXT,
    is_private     INTEGER NOT NULL DEFAULT 0,
    wall_open      INTEGER NOT NULL DEFAULT 0,
    pinned_post_id BIGINT,
    created_by     BIGINT REFERENCES users(id) ON DELETE SET NULL,
    created_at     TEXT NOT NULL DEFAULT krug_now()
);

CREATE TABLE IF NOT EXISTS posts (
    id           BIGSERIAL PRIMARY KEY,
    author_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    text         TEXT NOT NULL DEFAULT '',
    visibility   TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','friends','only_me')),
    quote_of     BIGINT REFERENCES posts(id) ON DELETE SET NULL,
    is_repost    INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL DEFAULT krug_now(),
    edited_at    TEXT,
    community_id BIGINT REFERENCES communities(id) ON DELETE CASCADE,
    as_community INTEGER NOT NULL DEFAULT 0,
    circle_id    BIGINT REFERENCES circles(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_posts_author ON posts(author_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_posts_quote ON posts(quote_of);
CREATE INDEX IF NOT EXISTS idx_posts_community ON posts(community_id, id DESC);
DO $$ BEGIN
  ALTER TABLE communities ADD CONSTRAINT communities_pinned_fk FOREIGN KEY (pinned_post_id) REFERENCES posts(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS post_media (
    id         BIGSERIAL PRIMARY KEY,
    post_id    BIGINT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    path       TEXT NOT NULL,
    thumb      TEXT NOT NULL,
    width      INTEGER NOT NULL,
    height     INTEGER NOT NULL,
    alt        TEXT NOT NULL DEFAULT '',
    position   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_media_post ON post_media(post_id, position);

CREATE TABLE IF NOT EXISTS reactions (
    post_id    BIGINT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type       TEXT NOT NULL CHECK (type IN ('like','love','haha','wow','sad','angry')),
    created_at TEXT NOT NULL DEFAULT krug_now(),
    PRIMARY KEY (post_id, user_id)
);

CREATE TABLE IF NOT EXISTS comments (
    id         BIGSERIAL PRIMARY KEY,
    post_id    BIGINT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    author_id  BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    parent_id  BIGINT REFERENCES comments(id) ON DELETE CASCADE,
    text       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT krug_now()
);
CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id, id);

CREATE TABLE IF NOT EXISTS bookmarks (
    rowid      BIGSERIAL UNIQUE,
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    post_id    BIGINT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT krug_now(),
    PRIMARY KEY (user_id, post_id)
);

CREATE TABLE IF NOT EXISTS hashtags (
    id  BIGSERIAL PRIMARY KEY,
    tag CITEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS post_hashtags (
    post_id    BIGINT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    hashtag_id BIGINT NOT NULL REFERENCES hashtags(id) ON DELETE CASCADE,
    PRIMARY KEY (post_id, hashtag_id)
);
CREATE INDEX IF NOT EXISTS idx_post_hashtags_tag ON post_hashtags(hashtag_id, post_id DESC);

CREATE TABLE IF NOT EXISTS mentions (
    post_id BIGINT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (post_id, user_id)
);

CREATE TABLE IF NOT EXISTS conversations (
    id              BIGSERIAL PRIMARY KEY,
    is_group        INTEGER NOT NULL DEFAULT 0,
    direct_key      TEXT UNIQUE,
    created_at      TEXT NOT NULL DEFAULT krug_now(),
    last_message_at TEXT,
    title           TEXT,
    created_by      BIGINT REFERENCES users(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS conversation_members (
    conversation_id BIGINT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    last_read_id    BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_members_user ON conversation_members(user_id);
CREATE TABLE IF NOT EXISTS messages (
    id              BIGSERIAL PRIMARY KEY,
    conversation_id BIGINT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    sender_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    text            TEXT NOT NULL,
    created_at      TEXT NOT NULL DEFAULT krug_now(),
    kind            TEXT NOT NULL DEFAULT 'text'
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, id DESC);

CREATE TABLE IF NOT EXISTS notifications (
    id         BIGSERIAL PRIMARY KEY,
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    actor_id   BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type       TEXT NOT NULL,
    post_id    BIGINT REFERENCES posts(id) ON DELETE CASCADE,
    comment_id BIGINT REFERENCES comments(id) ON DELETE CASCADE,
    extra      TEXT,
    created_at TEXT NOT NULL DEFAULT krug_now(),
    read_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, id DESC);

CREATE TABLE IF NOT EXISTS reports (
    id          BIGSERIAL PRIMARY KEY,
    reporter_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    target_type TEXT NOT NULL CHECK (target_type IN ('post','comment','user')),
    target_id   BIGINT NOT NULL,
    reason      TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'open',
    created_at  TEXT NOT NULL DEFAULT krug_now()
);

CREATE TABLE IF NOT EXISTS stories (
    id         BIGSERIAL PRIMARY KEY,
    author_id  BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    media      TEXT,
    thumb      TEXT,
    text       TEXT NOT NULL DEFAULT '',
    background TEXT NOT NULL DEFAULT 'blue',
    visibility TEXT NOT NULL DEFAULT 'friends' CHECK (visibility IN ('public','friends')),
    created_at TEXT NOT NULL DEFAULT krug_now(),
    expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stories_author ON stories(author_id, expires_at);
CREATE TABLE IF NOT EXISTS story_views (
    story_id  BIGINT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
    viewer_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    viewed_at TEXT NOT NULL DEFAULT krug_now(),
    PRIMARY KEY (story_id, viewer_id)
);

CREATE TABLE IF NOT EXISTS community_members (
    community_id BIGINT NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role         TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin','moderator','member')),
    status       TEXT NOT NULL DEFAULT 'member' CHECK (status IN ('member','pending')),
    joined_at    TEXT NOT NULL DEFAULT krug_now(),
    PRIMARY KEY (community_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_cm_user ON community_members(user_id, status);

CREATE TABLE IF NOT EXISTS events (
    id           BIGSERIAL PRIMARY KEY,
    creator_id   BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    community_id BIGINT REFERENCES communities(id) ON DELETE CASCADE,
    title        TEXT NOT NULL,
    description  TEXT NOT NULL DEFAULT '',
    place        TEXT NOT NULL DEFAULT '',
    starts_at    TEXT NOT NULL,
    ends_at      TEXT,
    cover        TEXT,
    visibility   TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','friends','invited')),
    created_at   TEXT NOT NULL DEFAULT krug_now()
);
CREATE INDEX IF NOT EXISTS idx_events_start ON events(starts_at);
CREATE TABLE IF NOT EXISTS event_members (
    event_id   BIGINT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status     TEXT NOT NULL CHECK (status IN ('going','maybe','declined','invited')),
    invited_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
    updated_at TEXT NOT NULL DEFAULT krug_now(),
    PRIMARY KEY (event_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_event_members_user ON event_members(user_id, status);

CREATE TABLE IF NOT EXISTS profile_visits (
    visited_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    visitor_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    visited_at TEXT NOT NULL,
    PRIMARY KEY (visited_id, visitor_id)
);
CREATE INDEX IF NOT EXISTS idx_visits ON profile_visits(visited_id, visited_at DESC);

-- Файлы (фото) внутри базы — для бесплатного хостинга без постоянного диска
CREATE TABLE IF NOT EXISTS media_files (
    path         TEXT PRIMARY KEY,
    content_type TEXT NOT NULL,
    data         BYTEA NOT NULL,
    created_at   TEXT NOT NULL DEFAULT krug_now()
);

-- Коллекционные предметы (выдаются за активность)
CREATE TABLE IF NOT EXISTS user_items (
    user_id   BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    item_id   TEXT NOT NULL,
    earned_at TEXT NOT NULL DEFAULT krug_now(),
    PRIMARY KEY (user_id, item_id)
);

-- Коды подтверждения почты и смены e-mail
CREATE TABLE IF NOT EXISTS email_codes (
    id         BIGSERIAL PRIMARY KEY,
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    purpose    TEXT NOT NULL,
    code_hash  TEXT NOT NULL,
    new_email  TEXT,
    attempts   INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT krug_now()
);
CREATE INDEX IF NOT EXISTS idx_email_codes_user ON email_codes(user_id, purpose);
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS equipped TEXT;

-- Наборы стикеров (как в Telegram): свои и добавленные чужие
CREATE TABLE IF NOT EXISTS sticker_packs (
    id         BIGSERIAL PRIMARY KEY,
    owner_id   BIGINT REFERENCES users(id) ON DELETE CASCADE,
    slug       TEXT NOT NULL UNIQUE,
    title      TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT krug_now()
);
CREATE TABLE IF NOT EXISTS stickers (
    id         BIGSERIAL PRIMARY KEY,
    pack_id    BIGINT NOT NULL REFERENCES sticker_packs(id) ON DELETE CASCADE,
    file       TEXT NOT NULL,
    emoji      TEXT NOT NULL DEFAULT '🙂',
    animated   INTEGER NOT NULL DEFAULT 0,
    position   INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT krug_now()
);
CREATE INDEX IF NOT EXISTS idx_stickers_pack ON stickers(pack_id, position);
CREATE TABLE IF NOT EXISTS user_sticker_packs (
    user_id  BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    pack_id  BIGINT NOT NULL REFERENCES sticker_packs(id) ON DELETE CASCADE,
    added_at TEXT NOT NULL DEFAULT krug_now(),
    PRIMARY KEY (user_id, pack_id)
);

-- Клипы (короткие вертикальные видео)
CREATE TABLE IF NOT EXISTS reels (
    id         BIGSERIAL PRIMARY KEY,
    author_id  BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    video      TEXT NOT NULL,
    poster     TEXT,
    caption    TEXT NOT NULL DEFAULT '',
    duration   REAL NOT NULL DEFAULT 0,
    width      INTEGER,
    height     INTEGER,
    views      INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT krug_now()
);
CREATE INDEX IF NOT EXISTS idx_reels_author ON reels(author_id, id DESC);
CREATE TABLE IF NOT EXISTS reel_likes (
    reel_id    BIGINT NOT NULL REFERENCES reels(id) ON DELETE CASCADE,
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT krug_now(),
    PRIMARY KEY (reel_id, user_id)
);
CREATE TABLE IF NOT EXISTS reel_comments (
    id         BIGSERIAL PRIMARY KEY,
    reel_id    BIGINT NOT NULL REFERENCES reels(id) ON DELETE CASCADE,
    author_id  BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    text       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT krug_now()
);
CREATE INDEX IF NOT EXISTS idx_reel_comments ON reel_comments(reel_id, id);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS media TEXT;

-- Реакции на сообщения (одна реакция от человека на сообщение)
CREATE TABLE IF NOT EXISTS message_reactions (
    message_id BIGINT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji      TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT krug_now(),
    PRIMARY KEY (message_id, user_id)
);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to BIGINT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS edited_at TEXT;

-- Опросы в записях
CREATE TABLE IF NOT EXISTS polls (
    id        BIGSERIAL PRIMARY KEY,
    post_id   BIGINT NOT NULL UNIQUE REFERENCES posts(id) ON DELETE CASCADE,
    question  TEXT NOT NULL DEFAULT '',
    multiple  INTEGER NOT NULL DEFAULT 0,
    closes_at TEXT
);
CREATE TABLE IF NOT EXISTS poll_options (
    id       BIGSERIAL PRIMARY KEY,
    poll_id  BIGINT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
    text     TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_poll_options ON poll_options(poll_id, position);
CREATE TABLE IF NOT EXISTS poll_votes (
    poll_id    BIGINT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
    option_id  BIGINT NOT NULL REFERENCES poll_options(id) ON DELETE CASCADE,
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT krug_now(),
    PRIMARY KEY (option_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_poll_votes ON poll_votes(poll_id, user_id);
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS status_emoji TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS status_text TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS status_until TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS verified INTEGER NOT NULL DEFAULT 0;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS badge TEXT;
