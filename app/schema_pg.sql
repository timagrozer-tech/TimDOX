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
    circle_id    BIGINT REFERENCES circles(id) ON DELETE SET NULL,
    music        TEXT
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
    target_type TEXT NOT NULL CHECK (target_type IN ('post','comment','user','reel','reel_comment','message','story','community')),
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
ALTER TABLE stories ADD COLUMN IF NOT EXISTS style TEXT;
-- индексы для частых запросов и каскадных удалений
CREATE INDEX IF NOT EXISTS idx_notif_post ON notifications(post_id);
CREATE INDEX IF NOT EXISTS idx_notif_comment ON notifications(comment_id);
CREATE INDEX IF NOT EXISTS idx_notif_actor ON notifications(actor_id);
CREATE INDEX IF NOT EXISTS idx_notif_unread ON notifications(user_id) WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_comments_author ON comments(author_id);
CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id);
CREATE INDEX IF NOT EXISTS idx_reactions_user ON reactions(user_id);
CREATE INDEX IF NOT EXISTS idx_mentions_user ON mentions(user_id);
CREATE INDEX IF NOT EXISTS idx_bookmarks_post ON bookmarks(post_id);
CREATE INDEX IF NOT EXISTS idx_reel_likes_user ON reel_likes(user_id);
CREATE INDEX IF NOT EXISTS idx_story_views_viewer ON story_views(viewer_id);
CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at);
CREATE INDEX IF NOT EXISTS idx_posts_circle ON posts(circle_id);
-- жалобы на всё: клипы, сообщения, истории, сообщества
ALTER TABLE reports DROP CONSTRAINT IF EXISTS reports_target_type_check;
ALTER TABLE reports ADD CONSTRAINT reports_target_type_check CHECK (target_type IN ('post','comment','user','reel','reel_comment','message','story','community'));
CREATE INDEX IF NOT EXISTS idx_reports_target ON reports(status, target_type, target_id);

-- ============================================================================
-- Мир Круга: ИИ-организации, персонажи, очередь контента, задания, репутация, память, сюжеты
-- ============================================================================
CREATE TABLE IF NOT EXISTS ai_orgs (
    id           BIGSERIAL PRIMARY KEY,
    slug         TEXT NOT NULL UNIQUE,
    name         TEXT NOT NULL,
    motto        TEXT NOT NULL DEFAULT '',
    color        TEXT NOT NULL DEFAULT '#7c5cff',
    emoji        TEXT NOT NULL DEFAULT '✦',
    community_id BIGINT REFERENCES communities(id) ON DELETE SET NULL,
    influence    INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS ai_personas (
    user_id        BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    slug           TEXT NOT NULL UNIQUE,
    org_id         BIGINT REFERENCES ai_orgs(id) ON DELETE SET NULL,
    role           TEXT NOT NULL DEFAULT '',
    specialty      TEXT NOT NULL DEFAULT '',
    state          TEXT NOT NULL DEFAULT 'rest',
    energy         INTEGER NOT NULL DEFAULT 3,
    reputation     INTEGER NOT NULL DEFAULT 0,
    next_action_at TEXT
);
CREATE TABLE IF NOT EXISTS ai_queue (
    id         BIGSERIAL PRIMARY KEY,
    persona_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL,
    payload    TEXT NOT NULL DEFAULT '{}',
    run_at     TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'pending',
    source     TEXT NOT NULL DEFAULT 'template',
    created_at TEXT NOT NULL DEFAULT krug_now()
);
CREATE INDEX IF NOT EXISTS idx_ai_queue_due ON ai_queue(status, run_at);
CREATE TABLE IF NOT EXISTS ai_quests (
    id          BIGSERIAL PRIMARY KEY,
    code        TEXT NOT NULL UNIQUE,
    org_id      BIGINT REFERENCES ai_orgs(id) ON DELETE CASCADE,
    persona_id  BIGINT REFERENCES users(id) ON DELETE SET NULL,
    title       TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    rule        TEXT NOT NULL DEFAULT '{}',
    reward      INTEGER NOT NULL DEFAULT 10,
    secret      INTEGER NOT NULL DEFAULT 0,
    starts_at   TEXT NOT NULL,
    ends_at     TEXT
);
CREATE TABLE IF NOT EXISTS ai_quest_progress (
    user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    quest_id     BIGINT NOT NULL REFERENCES ai_quests(id) ON DELETE CASCADE,
    status       TEXT NOT NULL DEFAULT 'open',
    progress     INTEGER NOT NULL DEFAULT 0,
    completed_at TEXT,
    PRIMARY KEY (user_id, quest_id)
);
CREATE TABLE IF NOT EXISTS ai_rep (
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    org_id  BIGINT NOT NULL REFERENCES ai_orgs(id) ON DELETE CASCADE,
    points  INTEGER NOT NULL DEFAULT 0,
    week_points INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, org_id)
);
CREATE TABLE IF NOT EXISTS ai_memory (
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    persona_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    closeness  INTEGER NOT NULL DEFAULT 0,
    facts      TEXT NOT NULL DEFAULT '[]',
    chats_day  TEXT NOT NULL DEFAULT '',
    last_at    TEXT,
    PRIMARY KEY (user_id, persona_id)
);
CREATE TABLE IF NOT EXISTS ai_arcs (
    id       BIGSERIAL PRIMARY KEY,
    code     TEXT NOT NULL UNIQUE,
    org_id   BIGINT REFERENCES ai_orgs(id) ON DELETE CASCADE,
    title    TEXT NOT NULL,
    stage    TEXT NOT NULL DEFAULT 'start',
    post_id  BIGINT REFERENCES posts(id) ON DELETE SET NULL,
    status   TEXT NOT NULL DEFAULT 'active',
    history  TEXT NOT NULL DEFAULT '[]',
    next_at  TEXT
);
CREATE TABLE IF NOT EXISTS ai_state (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT ''
);

-- Музыка: любимые треки (копия данных трека из источника — Audius или радио)
CREATE TABLE IF NOT EXISTS music_likes (
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    track_key  TEXT NOT NULL,
    data       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT krug_now(),
    PRIMARY KEY (user_id, track_key)
);
CREATE INDEX IF NOT EXISTS idx_music_likes_key ON music_likes(track_key, created_at);
CREATE INDEX IF NOT EXISTS idx_music_likes_time ON music_likes(created_at);

-- Дневные квоты загрузок (сутки по UTC)
CREATE TABLE IF NOT EXISTS upload_usage (
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    day     TEXT NOT NULL,
    bytes   BIGINT NOT NULL DEFAULT 0,
    files   INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, day)
);

-- Безопасность: секреты приложения, двухфакторная защита, журнал входов
CREATE TABLE IF NOT EXISTS app_secrets (name TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS user_totp (
    user_id    BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    secret_enc TEXT NOT NULL,
    enabled_at TEXT,
    last_step  BIGINT
);
CREATE TABLE IF NOT EXISTS backup_codes (
    user_id   BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash TEXT NOT NULL,
    used_at   TEXT,
    PRIMARY KEY (user_id, code_hash)
);
CREATE TABLE IF NOT EXISTS mfa_tickets (
    id         TEXT PRIMARY KEY,
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    attempts   INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS login_events (
    id         BIGSERIAL PRIMARY KEY,
    user_id    BIGINT REFERENCES users(id) ON DELETE CASCADE,
    ok         INTEGER NOT NULL,
    method     TEXT NOT NULL,
    reason     TEXT,
    device     TEXT,
    ip_prefix  TEXT,
    created_at TEXT NOT NULL DEFAULT krug_now()
);
CREATE INDEX IF NOT EXISTS idx_login_events_user ON login_events(user_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_login_events_time ON login_events(created_at);
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS ip_prefix TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_seen_at TEXT;

-- Приглашения: коды, переходы, кто кого пригласил, дни активности, выданные награды
CREATE TABLE IF NOT EXISTS invite_codes (
    code        TEXT PRIMARY KEY,
    user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    label       TEXT,
    created_at  TEXT NOT NULL DEFAULT krug_now(),
    disabled_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_invite_codes_user ON invite_codes(user_id);
CREATE TABLE IF NOT EXISTS invite_clicks (
    code    TEXT NOT NULL REFERENCES invite_codes(code) ON DELETE CASCADE,
    day     TEXT NOT NULL,
    visitor TEXT NOT NULL,
    source  TEXT,
    PRIMARY KEY (code, day, visitor)
);
CREATE TABLE IF NOT EXISTS referrals (
    invitee_id    BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    inviter_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code          TEXT,
    net           TEXT,
    status        TEXT NOT NULL DEFAULT 'pending',
    reject_reason TEXT,
    created_at    TEXT NOT NULL DEFAULT krug_now(),
    qualified_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_referrals_inviter ON referrals(inviter_id, status, qualified_at);
CREATE INDEX IF NOT EXISTS idx_referrals_status ON referrals(status);
CREATE TABLE IF NOT EXISTS user_active_days (
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    day     TEXT NOT NULL,
    PRIMARY KEY (user_id, day)
);
CREATE TABLE IF NOT EXISTS referral_rewards (
    id         BIGSERIAL PRIMARY KEY,
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL,
    tier       TEXT,
    payload    TEXT,
    granted_at TEXT NOT NULL DEFAULT krug_now(),
    UNIQUE (user_id, kind, tier)
);
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS invite_tier TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS invites_qualified INTEGER NOT NULL DEFAULT 0;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS onboarding TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS constellation TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS space TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS shop_title TEXT;

-- Звонки: голос и видео (WebRTC), журнал участников
CREATE TABLE IF NOT EXISTS calls (
    id              TEXT PRIMARY KEY,
    conversation_id BIGINT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    started_by      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    video           INTEGER NOT NULL DEFAULT 0,
    started_at      TEXT NOT NULL DEFAULT krug_now(),
    ended_at        TEXT
);
CREATE INDEX IF NOT EXISTS idx_calls_conv ON calls(conversation_id, started_at DESC);
CREATE TABLE IF NOT EXISTS call_participants (
    call_id   TEXT NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
    user_id   BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at TEXT NOT NULL DEFAULT krug_now(),
    left_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_call_parts ON call_participants(call_id, user_id);

-- Экономика Э0: кошельки, журнал проводок, лимиты, задания
CREATE TABLE IF NOT EXISTS ledger_tx (
    id         BIGSERIAL PRIMARY KEY,
    kind       TEXT NOT NULL,
    ref        TEXT,
    idem       TEXT UNIQUE,
    meta       TEXT,
    created_at TEXT NOT NULL DEFAULT krug_now()
);
CREATE TABLE IF NOT EXISTS ledger_entries (
    id       BIGSERIAL PRIMARY KEY,
    tx_id    BIGINT NOT NULL REFERENCES ledger_tx(id) ON DELETE CASCADE,
    account  BIGINT NOT NULL,
    currency TEXT NOT NULL,
    delta    BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_acc ON ledger_entries(account, currency, tx_id);
CREATE TABLE IF NOT EXISTS wallets (
    account  BIGINT NOT NULL,
    currency TEXT NOT NULL,
    balance  BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (account, currency)
);
CREATE TABLE IF NOT EXISTS econ_counters (
    user_id BIGINT NOT NULL,
    day     TEXT NOT NULL,
    source  TEXT NOT NULL,
    n       INTEGER NOT NULL DEFAULT 0,
    amount  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, day, source)
);
CREATE TABLE IF NOT EXISTS econ_state (
    user_id    BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    streak     INTEGER NOT NULL DEFAULT 0,
    last_day   TEXT,
    grace_week TEXT
);
CREATE TABLE IF NOT EXISTS user_quests (
    user_id  BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    day      TEXT NOT NULL,
    slot     INTEGER NOT NULL,
    code     TEXT NOT NULL,
    event    TEXT NOT NULL,
    target   INTEGER NOT NULL,
    progress INTEGER NOT NULL DEFAULT 0,
    claimed  INTEGER NOT NULL DEFAULT 0,
    swapped  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, day, slot)
);
CREATE TABLE IF NOT EXISTS econ_weekly (
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    week    TEXT NOT NULL,
    days    INTEGER NOT NULL DEFAULT 0,
    claimed INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, week)
);

-- Город (Э1)
CREATE TABLE IF NOT EXISTS cities (
    user_id     BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    name        TEXT,
    treasury_at TEXT,
    created_at  TEXT NOT NULL DEFAULT krug_now()
);
CREATE TABLE IF NOT EXISTS city_buildings (
    id       BIGSERIAL PRIMARY KEY,
    user_id  BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind     TEXT NOT NULL,
    x        INTEGER NOT NULL,
    y        INTEGER NOT NULL,
    level    INTEGER NOT NULL DEFAULT 1,
    built_at TEXT NOT NULL DEFAULT krug_now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_city_cell ON city_buildings(user_id, x, y);
CREATE TABLE IF NOT EXISTS city_visits (
    id         BIGSERIAL PRIMARY KEY,
    host_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    guest_id   BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    day        TEXT NOT NULL,
    action     TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT krug_now(),
    UNIQUE (host_id, guest_id, day)
);
CREATE INDEX IF NOT EXISTS idx_city_visits_host ON city_visits(host_id, created_at);

-- Поддержка авторов (Э2)
CREATE TABLE IF NOT EXISTS post_supports (
    id         BIGSERIAL PRIMARY KEY,
    post_id    BIGINT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    amount     INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT krug_now()
);
CREATE INDEX IF NOT EXISTS idx_post_supports ON post_supports(post_id);

CREATE TABLE IF NOT EXISTS account_links (
    a          BIGINT NOT NULL,
    b          BIGINT NOT NULL,
    created_at TEXT NOT NULL DEFAULT krug_now(),
    PRIMARY KEY (a, b)
);

-- Магазин оформления (Э2)
CREATE TABLE IF NOT EXISTS shop_items (
    user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    item_id     TEXT NOT NULL,
    source      TEXT NOT NULL DEFAULT 'buy',
    acquired_at TEXT NOT NULL DEFAULT krug_now(),
    PRIMARY KEY (user_id, item_id)
);
CREATE TABLE IF NOT EXISTS gifts (
    id         BIGSERIAL PRIMARY KEY,
    from_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    to_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    item_id    TEXT NOT NULL,
    note       TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT krug_now()
);
CREATE INDEX IF NOT EXISTS idx_gifts_to ON gifts(to_id, id);

-- Рынок (Э3)
CREATE TABLE IF NOT EXISTS market_listings (
    id         BIGSERIAL PRIMARY KEY,
    seller_id  BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    item_id    TEXT NOT NULL,
    price      INTEGER NOT NULL,
    status     TEXT NOT NULL DEFAULT 'active',
    buyer_id   BIGINT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT krug_now(),
    closed_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_market_active ON market_listings(status, id);
CREATE INDEX IF NOT EXISTS idx_market_item ON market_listings(item_id, status, closed_at);
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS avatar3d TEXT;

-- Стикеры 2.0: избранное, реакции, недавние, папки, покупки, импорт, GIF
CREATE TABLE IF NOT EXISTS sticker_saved (
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    sticker_id BIGINT NOT NULL REFERENCES stickers(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL DEFAULT 'fav',
    created_at TEXT NOT NULL DEFAULT krug_now(),
    PRIMARY KEY (user_id, sticker_id, kind)
);
CREATE TABLE IF NOT EXISTS sticker_recent (
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    sticker_id BIGINT NOT NULL REFERENCES stickers(id) ON DELETE CASCADE,
    used_at    TEXT NOT NULL DEFAULT krug_now(),
    PRIMARY KEY (user_id, sticker_id)
);
CREATE TABLE IF NOT EXISTS sticker_folders (
    id         BIGSERIAL PRIMARY KEY,
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title      TEXT NOT NULL,
    emoji      TEXT NOT NULL DEFAULT '📁',
    position   INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT krug_now()
);
CREATE INDEX IF NOT EXISTS idx_sticker_folders_user ON sticker_folders(user_id, position);
CREATE TABLE IF NOT EXISTS sticker_folder_items (
    folder_id  BIGINT NOT NULL REFERENCES sticker_folders(id) ON DELETE CASCADE,
    sticker_id BIGINT NOT NULL REFERENCES stickers(id) ON DELETE CASCADE,
    added_at   TEXT NOT NULL DEFAULT krug_now(),
    PRIMARY KEY (folder_id, sticker_id)
);
CREATE TABLE IF NOT EXISTS sticker_purchases (
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    pack_id    BIGINT NOT NULL REFERENCES sticker_packs(id) ON DELETE CASCADE,
    price      INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT krug_now(),
    PRIMARY KEY (user_id, pack_id)
);
CREATE TABLE IF NOT EXISTS sticker_imports (
    id         BIGSERIAL PRIMARY KEY,
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source     TEXT NOT NULL,
    ref        TEXT NOT NULL DEFAULT '',
    title      TEXT NOT NULL DEFAULT '',
    status     TEXT NOT NULL DEFAULT 'running',
    total      INTEGER NOT NULL DEFAULT 0,
    done       INTEGER NOT NULL DEFAULT 0,
    pack_id    BIGINT,
    error      TEXT,
    created_at TEXT NOT NULL DEFAULT krug_now()
);
CREATE INDEX IF NOT EXISTS idx_sticker_imports_user ON sticker_imports(user_id, id);
CREATE TABLE IF NOT EXISTS user_gifs (
    id         BIGSERIAL PRIMARY KEY,
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    file       TEXT NOT NULL,
    format     TEXT NOT NULL DEFAULT 'webp',
    width      INTEGER NOT NULL DEFAULT 0,
    height     INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT krug_now()
);
CREATE INDEX IF NOT EXISTS idx_user_gifs_user ON user_gifs(user_id, id);
ALTER TABLE sticker_packs ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'own';
ALTER TABLE sticker_packs ADD COLUMN IF NOT EXISTS source_ref TEXT;
ALTER TABLE sticker_packs ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '';
ALTER TABLE sticker_packs ADD COLUMN IF NOT EXISTS cover_id BIGINT;
ALTER TABLE sticker_packs ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'stickers';
ALTER TABLE sticker_packs ADD COLUMN IF NOT EXISTS published INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sticker_packs ADD COLUMN IF NOT EXISTS price INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sticker_packs ADD COLUMN IF NOT EXISTS installs INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sticker_packs ADD COLUMN IF NOT EXISTS shared INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sticker_packs ADD COLUMN IF NOT EXISTS remix_of BIGINT;
ALTER TABLE stickers ADD COLUMN IF NOT EXISTS format TEXT NOT NULL DEFAULT 'webp';
ALTER TABLE stickers ADD COLUMN IF NOT EXISTS tags TEXT NOT NULL DEFAULT '';
ALTER TABLE stickers ADD COLUMN IF NOT EXISTS ai_tagged INTEGER NOT NULL DEFAULT 0;
ALTER TABLE stickers ADD COLUMN IF NOT EXISTS thumb TEXT;
ALTER TABLE stickers ADD COLUMN IF NOT EXISTS remix_of BIGINT;
ALTER TABLE user_sticker_packs ADD COLUMN IF NOT EXISTS favorite INTEGER NOT NULL DEFAULT 0;
ALTER TABLE comments ADD COLUMN IF NOT EXISTS media TEXT;
CREATE INDEX IF NOT EXISTS idx_packs_published ON sticker_packs(published, installs);
CREATE INDEX IF NOT EXISTS idx_packs_source ON sticker_packs(source, source_ref);

-- Бот Telegram: привязка аккаунта, уведомления, вход из мини-приложения
CREATE TABLE IF NOT EXISTS tg_links (
    user_id         BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    tg_id           BIGINT NOT NULL UNIQUE,
    tg_username     TEXT NOT NULL DEFAULT '',
    tg_name         TEXT NOT NULL DEFAULT '',
    notify_messages INTEGER NOT NULL DEFAULT 1,
    notify_social   INTEGER NOT NULL DEFAULT 1,
    webapp_login    INTEGER NOT NULL DEFAULT 1,
    linked_at       TEXT NOT NULL DEFAULT krug_now()
);
CREATE TABLE IF NOT EXISTS tg_link_codes (
    code       TEXT PRIMARY KEY,
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL
);
ALTER TABLE tg_links ADD COLUMN IF NOT EXISTS tg_name TEXT NOT NULL DEFAULT '';
ALTER TABLE tg_links ADD COLUMN IF NOT EXISTS notify_messages INTEGER NOT NULL DEFAULT 1;
ALTER TABLE tg_links ADD COLUMN IF NOT EXISTS notify_social INTEGER NOT NULL DEFAULT 1;
ALTER TABLE tg_links ADD COLUMN IF NOT EXISTS webapp_login INTEGER NOT NULL DEFAULT 1;
ALTER TABLE tg_links ADD COLUMN IF NOT EXISTS linked_at TEXT NOT NULL DEFAULT krug_now();

-- Наборы из Telegram-аккаунта, которые человек показал боту
CREATE TABLE IF NOT EXISTS tg_seen_sets (
    user_id  BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name     TEXT NOT NULL,
    title    TEXT NOT NULL DEFAULT '',
    kind     TEXT NOT NULL DEFAULT 'stickers',
    count    INTEGER NOT NULL DEFAULT 0,
    thumbs   TEXT,
    hidden   INTEGER NOT NULL DEFAULT 0,
    seen_at  TEXT NOT NULL DEFAULT krug_now(),
    PRIMARY KEY (user_id, name)
);

-- Наборы KRUG, отправленные в Telegram настоящими стикерпаками
CREATE TABLE IF NOT EXISTS tg_exports (
    pack_id     BIGINT PRIMARY KEY REFERENCES sticker_packs(id) ON DELETE CASCADE,
    user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    set_name    TEXT NOT NULL,
    version     INTEGER NOT NULL DEFAULT 1,
    count       INTEGER NOT NULL DEFAULT 0,
    exported_at TEXT NOT NULL DEFAULT krug_now()
);
