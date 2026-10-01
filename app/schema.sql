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
    target_type TEXT NOT NULL CHECK (target_type IN ('post','comment','user','reel','reel_comment','message','story','community')),
    target_id   INTEGER NOT NULL,
    reason      TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'open',
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ============================================================================
-- Этап 2
-- ============================================================================

-- Круги: списки друзей («Близкие друзья», «Семья», «Работа»…) для публикации узкому кругу
CREATE TABLE IF NOT EXISTS circles (
    id         INTEGER PRIMARY KEY,
    owner_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE (owner_id, name)
);
CREATE TABLE IF NOT EXISTS circle_members (
    circle_id INTEGER NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
    user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (circle_id, user_id)
);

-- Истории на 24 часа
CREATE TABLE IF NOT EXISTS stories (
    id         INTEGER PRIMARY KEY,
    author_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    media      TEXT,                              -- фото (или NULL для текстовой истории)
    thumb      TEXT,
    text       TEXT NOT NULL DEFAULT '',
    background TEXT NOT NULL DEFAULT 'blue',
    style      TEXT,                              -- оформление: шрифт, стиль текста, стикеры (JSON)
    visibility TEXT NOT NULL DEFAULT 'friends' CHECK (visibility IN ('public','friends')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stories_author ON stories(author_id, expires_at);
CREATE TABLE IF NOT EXISTS story_views (
    story_id  INTEGER NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
    viewer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    viewed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (story_id, viewer_id)
);

-- Сообщества и паблики
CREATE TABLE IF NOT EXISTS communities (
    id             INTEGER PRIMARY KEY,
    slug           TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name           TEXT NOT NULL,
    description    TEXT NOT NULL DEFAULT '',
    avatar         TEXT,
    cover          TEXT,
    is_private     INTEGER NOT NULL DEFAULT 0,    -- закрытое: вступление по заявке, записи видят участники
    wall_open      INTEGER NOT NULL DEFAULT 0,    -- участники могут публиковать на стене
    pinned_post_id INTEGER REFERENCES posts(id) ON DELETE SET NULL,
    created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS community_members (
    community_id INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role         TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin','moderator','member')),
    status       TEXT NOT NULL DEFAULT 'member' CHECK (status IN ('member','pending')),
    joined_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (community_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_cm_user ON community_members(user_id, status);

-- Мероприятия
CREATE TABLE IF NOT EXISTS events (
    id           INTEGER PRIMARY KEY,
    creator_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    community_id INTEGER REFERENCES communities(id) ON DELETE CASCADE,
    title        TEXT NOT NULL,
    description  TEXT NOT NULL DEFAULT '',
    place        TEXT NOT NULL DEFAULT '',
    starts_at    TEXT NOT NULL,
    ends_at      TEXT,
    cover        TEXT,
    visibility   TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','friends','invited')),
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_events_start ON events(starts_at);
CREATE TABLE IF NOT EXISTS event_members (
    event_id   INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status     TEXT NOT NULL CHECK (status IN ('going','maybe','declined','invited')),
    invited_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (event_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_event_members_user ON event_members(user_id, status);

-- «Гости»: кто заходил на страницу
CREATE TABLE IF NOT EXISTS profile_visits (
    visited_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    visitor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    visited_at TEXT NOT NULL,
    PRIMARY KEY (visited_id, visitor_id)
);
CREATE INDEX IF NOT EXISTS idx_visits ON profile_visits(visited_id, visited_at DESC);

-- Файлы (фото) внутри базы — используется, если MEDIA_STORAGE=db
CREATE TABLE IF NOT EXISTS media_files (
    path         TEXT PRIMARY KEY,
    content_type TEXT NOT NULL,
    data         BLOB NOT NULL,
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Коллекционные предметы (выдаются за активность)
CREATE TABLE IF NOT EXISTS user_items (
    user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    item_id   TEXT NOT NULL,
    earned_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (user_id, item_id)
);

-- Коды подтверждения почты и смены e-mail
CREATE TABLE IF NOT EXISTS email_codes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    purpose    TEXT NOT NULL,
    code_hash  TEXT NOT NULL,
    new_email  TEXT,
    attempts   INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_email_codes_user ON email_codes(user_id, purpose);

-- Наборы стикеров (как в Telegram): свои и добавленные чужие
CREATE TABLE IF NOT EXISTS sticker_packs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id   INTEGER REFERENCES users(id) ON DELETE CASCADE,
    slug       TEXT NOT NULL UNIQUE,
    title      TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS stickers (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    pack_id    INTEGER NOT NULL REFERENCES sticker_packs(id) ON DELETE CASCADE,
    file       TEXT NOT NULL,
    emoji      TEXT NOT NULL DEFAULT '🙂',
    animated   INTEGER NOT NULL DEFAULT 0,
    position   INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_stickers_pack ON stickers(pack_id, position);
CREATE TABLE IF NOT EXISTS user_sticker_packs (
    user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    pack_id  INTEGER NOT NULL REFERENCES sticker_packs(id) ON DELETE CASCADE,
    added_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (user_id, pack_id)
);

-- Клипы (короткие вертикальные видео)
CREATE TABLE IF NOT EXISTS reels (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    author_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    video      TEXT NOT NULL,
    poster     TEXT,
    caption    TEXT NOT NULL DEFAULT '',
    duration   REAL NOT NULL DEFAULT 0,
    width      INTEGER,
    height     INTEGER,
    views      INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_reels_author ON reels(author_id, id DESC);
CREATE TABLE IF NOT EXISTS reel_likes (
    reel_id    INTEGER NOT NULL REFERENCES reels(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (reel_id, user_id)
);
CREATE TABLE IF NOT EXISTS reel_comments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    reel_id    INTEGER NOT NULL REFERENCES reels(id) ON DELETE CASCADE,
    author_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    text       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_reel_comments ON reel_comments(reel_id, id);

-- Реакции на сообщения (одна реакция от человека на сообщение)
CREATE TABLE IF NOT EXISTS message_reactions (
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji      TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (message_id, user_id)
);

-- Опросы в записях
CREATE TABLE IF NOT EXISTS polls (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id   INTEGER NOT NULL UNIQUE REFERENCES posts(id) ON DELETE CASCADE,
    question  TEXT NOT NULL DEFAULT '',
    multiple  INTEGER NOT NULL DEFAULT 0,
    closes_at TEXT
);
CREATE TABLE IF NOT EXISTS poll_options (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    poll_id  INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
    text     TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_poll_options ON poll_options(poll_id, position);
CREATE TABLE IF NOT EXISTS poll_votes (
    poll_id    INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
    option_id  INTEGER NOT NULL REFERENCES poll_options(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (option_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_poll_votes ON poll_votes(poll_id, user_id);

-- ============================================================================
-- Мир Круга: ИИ-организации, персонажи, очередь контента, задания, репутация, память, сюжеты
-- ============================================================================
CREATE TABLE IF NOT EXISTS ai_orgs (
    id           INTEGER PRIMARY KEY,
    slug         TEXT NOT NULL UNIQUE,
    name         TEXT NOT NULL,
    motto        TEXT NOT NULL DEFAULT '',
    color        TEXT NOT NULL DEFAULT '#7c5cff',
    emoji        TEXT NOT NULL DEFAULT '✦',
    community_id INTEGER REFERENCES communities(id) ON DELETE SET NULL,
    influence    INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS ai_personas (
    user_id        INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    slug           TEXT NOT NULL UNIQUE,
    org_id         INTEGER REFERENCES ai_orgs(id) ON DELETE SET NULL,
    role           TEXT NOT NULL DEFAULT '',
    specialty      TEXT NOT NULL DEFAULT '',
    state          TEXT NOT NULL DEFAULT 'rest',
    energy         INTEGER NOT NULL DEFAULT 3,
    reputation     INTEGER NOT NULL DEFAULT 0,
    next_action_at TEXT
);
CREATE TABLE IF NOT EXISTS ai_queue (
    id         INTEGER PRIMARY KEY,
    persona_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL,
    payload    TEXT NOT NULL DEFAULT '{}',
    run_at     TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'pending',
    source     TEXT NOT NULL DEFAULT 'template',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_ai_queue_due ON ai_queue(status, run_at);
CREATE TABLE IF NOT EXISTS ai_quests (
    id          INTEGER PRIMARY KEY,
    code        TEXT NOT NULL UNIQUE,
    org_id      INTEGER REFERENCES ai_orgs(id) ON DELETE CASCADE,
    persona_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    title       TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    rule        TEXT NOT NULL DEFAULT '{}',
    reward      INTEGER NOT NULL DEFAULT 10,
    secret      INTEGER NOT NULL DEFAULT 0,
    starts_at   TEXT NOT NULL,
    ends_at     TEXT
);
CREATE TABLE IF NOT EXISTS ai_quest_progress (
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    quest_id     INTEGER NOT NULL REFERENCES ai_quests(id) ON DELETE CASCADE,
    status       TEXT NOT NULL DEFAULT 'open',
    progress     INTEGER NOT NULL DEFAULT 0,
    completed_at TEXT,
    PRIMARY KEY (user_id, quest_id)
);
CREATE TABLE IF NOT EXISTS ai_rep (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    org_id  INTEGER NOT NULL REFERENCES ai_orgs(id) ON DELETE CASCADE,
    points  INTEGER NOT NULL DEFAULT 0,
    week_points INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, org_id)
);
CREATE TABLE IF NOT EXISTS ai_memory (
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    persona_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    closeness  INTEGER NOT NULL DEFAULT 0,
    facts      TEXT NOT NULL DEFAULT '[]',
    chats_day  TEXT NOT NULL DEFAULT '',
    last_at    TEXT,
    PRIMARY KEY (user_id, persona_id)
);
CREATE TABLE IF NOT EXISTS ai_arcs (
    id       INTEGER PRIMARY KEY,
    code     TEXT NOT NULL UNIQUE,
    org_id   INTEGER REFERENCES ai_orgs(id) ON DELETE CASCADE,
    title    TEXT NOT NULL,
    stage    TEXT NOT NULL DEFAULT 'start',
    post_id  INTEGER REFERENCES posts(id) ON DELETE SET NULL,
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
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    track_key  TEXT NOT NULL,
    data       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (user_id, track_key)
);
CREATE INDEX IF NOT EXISTS idx_music_likes_key ON music_likes(track_key, created_at);
CREATE INDEX IF NOT EXISTS idx_music_likes_time ON music_likes(created_at);

-- Дневные квоты загрузок (сутки по UTC)
CREATE TABLE IF NOT EXISTS upload_usage (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    day     TEXT NOT NULL,
    bytes   INTEGER NOT NULL DEFAULT 0,
    files   INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, day)
);

-- Безопасность: секреты приложения, двухфакторная защита, журнал входов
CREATE TABLE IF NOT EXISTS app_secrets (name TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS user_totp (
    user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    secret_enc TEXT NOT NULL,
    enabled_at TEXT,
    last_step  INTEGER
);
CREATE TABLE IF NOT EXISTS backup_codes (
    user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash TEXT NOT NULL,
    used_at   TEXT,
    PRIMARY KEY (user_id, code_hash)
);
CREATE TABLE IF NOT EXISTS mfa_tickets (
    id         TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    attempts   INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS login_events (
    id         INTEGER PRIMARY KEY,
    user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
    ok         INTEGER NOT NULL,
    method     TEXT NOT NULL,
    reason     TEXT,
    device     TEXT,
    ip_prefix  TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_login_events_user ON login_events(user_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_login_events_time ON login_events(created_at);

-- Приглашения: коды, переходы, кто кого пригласил, дни активности, выданные награды
CREATE TABLE IF NOT EXISTS invite_codes (
    code        TEXT PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    label       TEXT,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
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
    invitee_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    inviter_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code          TEXT,
    net           TEXT,
    status        TEXT NOT NULL DEFAULT 'pending',
    reject_reason TEXT,
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    qualified_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_referrals_inviter ON referrals(inviter_id, status, qualified_at);
CREATE INDEX IF NOT EXISTS idx_referrals_status ON referrals(status);
CREATE TABLE IF NOT EXISTS user_active_days (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    day     TEXT NOT NULL,
    PRIMARY KEY (user_id, day)
);
CREATE TABLE IF NOT EXISTS referral_rewards (
    id         INTEGER PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL,
    tier       TEXT,
    payload    TEXT,
    granted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE (user_id, kind, tier)
);

-- Звонки: голос и видео (WebRTC), журнал участников
CREATE TABLE IF NOT EXISTS calls (
    id              TEXT PRIMARY KEY,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    started_by      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    video           INTEGER NOT NULL DEFAULT 0,
    started_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    ended_at        TEXT
);
CREATE INDEX IF NOT EXISTS idx_calls_conv ON calls(conversation_id, started_at DESC);
CREATE TABLE IF NOT EXISTS call_participants (
    call_id   TEXT NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
    user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    left_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_call_parts ON call_participants(call_id, user_id);

-- Экономика Э0: кошельки, журнал проводок, лимиты, задания
CREATE TABLE IF NOT EXISTS ledger_tx (
    id         INTEGER PRIMARY KEY,
    kind       TEXT NOT NULL,
    ref        TEXT,
    idem       TEXT UNIQUE,
    meta       TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS ledger_entries (
    id       INTEGER PRIMARY KEY,
    tx_id    INTEGER NOT NULL REFERENCES ledger_tx(id) ON DELETE CASCADE,
    account  INTEGER NOT NULL,
    currency TEXT NOT NULL,
    delta    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_acc ON ledger_entries(account, currency, tx_id);
CREATE TABLE IF NOT EXISTS wallets (
    account  INTEGER NOT NULL,
    currency TEXT NOT NULL,
    balance  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (account, currency)
);
CREATE TABLE IF NOT EXISTS econ_counters (
    user_id INTEGER NOT NULL,
    day     TEXT NOT NULL,
    source  TEXT NOT NULL,
    n       INTEGER NOT NULL DEFAULT 0,
    amount  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, day, source)
);
CREATE TABLE IF NOT EXISTS econ_state (
    user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    streak     INTEGER NOT NULL DEFAULT 0,
    last_day   TEXT,
    grace_week TEXT
);
CREATE TABLE IF NOT EXISTS user_quests (
    user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
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
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    week    TEXT NOT NULL,
    days    INTEGER NOT NULL DEFAULT 0,
    claimed INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, week)
);
