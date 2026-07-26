-- =====================================================================
-- 0001_schema.sql — структура базы и индексы.
--
-- Индексы расставлены не «на всякий случай», а под конкретные запросы
-- из internal/handlers — у каждого есть комментарий, какой запрос он
-- обслуживает. Это сознательно сделано одной миграцией со схемой
-- (а не отдельной «миграцией производительности» позже): новый индекс
-- под уже существующий запрос — это не эволюция схемы, а её изначальная
-- неполнота, и раскладывать его по времени добавления смысла нет.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "citext";

CREATE SCHEMA IF NOT EXISTS app;
SET search_path = app, public;

-- ---------------------------------------------------------------- типы
CREATE TYPE app.board_role AS ENUM ('owner', 'editor', 'reader');
CREATE TYPE app.grant_access AS ENUM ('read', 'contribute');
CREATE TYPE app.task_priority AS ENUM ('low', 'medium', 'high', 'urgent');

CREATE OR REPLACE FUNCTION app.touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END $$;

-- --------------------------------------------------------- пользователи
CREATE TABLE app.users (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email         citext NOT NULL UNIQUE,
    password_hash text   NOT NULL,
    full_name     text   NOT NULL,
    position      text   NOT NULL DEFAULT '',
    phone         text   NOT NULL DEFAULT '',
    avatar_color  text   NOT NULL DEFAULT '#3D5A80',
    is_active     boolean NOT NULL DEFAULT true,
    deleted_at    timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);
-- Directory() сортирует активных сначала и ищет по трём полям сразу.
CREATE INDEX users_active_idx ON app.users (deleted_at) WHERE deleted_at IS NULL;
CREATE TRIGGER users_touch BEFORE UPDATE ON app.users
    FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

CREATE TABLE app.team_members (
    owner_id  uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
    member_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
    added_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (owner_id, member_id)
);

-- ------------------------------------------------------ refresh-токены
CREATE TABLE app.refresh_tokens (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
    token_hash  bytea NOT NULL UNIQUE,
    family_id   uuid NOT NULL,
    expires_at  timestamptz NOT NULL,
    revoked_at  timestamptz,
    user_agent  text NOT NULL DEFAULT '',
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refresh_tokens_user_idx ON app.refresh_tokens (user_id);
CREATE INDEX refresh_tokens_family_idx ON app.refresh_tokens (family_id);
-- Логин чистит просроченные токены раз в ~100 попыток входа — если
-- таблица большая, полезен индекс на сам факт просрочки.
CREATE INDEX refresh_tokens_expiry_idx ON app.refresh_tokens (expires_at) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------- файлы
CREATE TABLE app.files (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id     uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
    storage_key  text NOT NULL,
    filename     text NOT NULL,
    mime_type    text NOT NULL,
    size_bytes   bigint NOT NULL,
    checksum     text NOT NULL DEFAULT '',
    created_at   timestamptz NOT NULL DEFAULT now()
);

-- --------------------------------------------------------------- доски
CREATE TABLE app.boards (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    title        text NOT NULL CHECK (length(btrim(title)) > 0),
    description  text NOT NULL DEFAULT '',
    bg_preset    text NOT NULL DEFAULT 'none',
    bg_file_id   uuid REFERENCES app.files(id) ON DELETE SET NULL,
    bg_blur      boolean NOT NULL DEFAULT false,
    archived     boolean NOT NULL DEFAULT false,
    created_by   uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER boards_touch BEFORE UPDATE ON app.boards
    FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

CREATE TABLE app.board_members (
    board_id  uuid NOT NULL REFERENCES app.boards(id) ON DELETE CASCADE,
    user_id   uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
    role      app.board_role NOT NULL DEFAULT 'reader',
    added_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (board_id, user_id)
);
-- Обратный порядок к первичному ключу: ListBoards и Inbox фильтруют
-- «мои доски» по user_id, а board_id идёт вторым условием или вовсе
-- используется в JOIN — первичный ключ (board_id, user_id) для этого
-- не покрывающий.
CREATE INDEX board_members_user_board_idx ON app.board_members (user_id, board_id);
CREATE UNIQUE INDEX board_single_owner_idx ON app.board_members (board_id)
    WHERE role = 'owner';

-- ------------------------------------------------------------- колонки
CREATE TABLE app.columns (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    board_id   uuid NOT NULL REFERENCES app.boards(id) ON DELETE CASCADE,
    title      text NOT NULL CHECK (length(btrim(title)) > 0),
    color      text NOT NULL DEFAULT '#8892A8',
    position   integer NOT NULL DEFAULT 0,
    wip_limit  integer NOT NULL DEFAULT 0 CHECK (wip_limit >= 0),
    is_done    boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX columns_board_idx ON app.columns (board_id, position);

-- -------------------------------------------------------------- задачи
CREATE TABLE app.tasks (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    board_id     uuid NOT NULL REFERENCES app.boards(id) ON DELETE CASCADE,
    column_id    uuid NOT NULL REFERENCES app.columns(id) ON DELETE CASCADE,
    title        text NOT NULL CHECK (length(btrim(title)) > 0),
    description  text NOT NULL DEFAULT '',
    priority     app.task_priority NOT NULL DEFAULT 'medium',
    due_date     date,
    position     integer NOT NULL DEFAULT 0,
    tags         text[] NOT NULL DEFAULT '{}',
    completed_at timestamptz,
    archived     boolean NOT NULL DEFAULT false,
    created_by   uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tasks_column_idx ON app.tasks (column_id, position);
-- ListTasks и Inbox фильтруют по board_id и NOT archived на каждый
-- рендер доски — частичный индекс держит в себе только живые задачи.
CREATE INDEX tasks_board_active_idx ON app.tasks (board_id) WHERE NOT archived;
CREATE INDEX tasks_search_idx ON app.tasks
    USING gin (to_tsvector('russian', title || ' ' || description));
CREATE TRIGGER tasks_touch BEFORE UPDATE ON app.tasks
    FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

CREATE TABLE app.task_assignees (
    task_id uuid NOT NULL REFERENCES app.tasks(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
    PRIMARY KEY (task_id, user_id)
);
-- Покрывающий индекс: агрегация исполнителей на список задач доски
-- читает только индекс, не трогая кучу таблицы.
CREATE INDEX task_assignees_user_idx ON app.task_assignees (user_id) INCLUDE (task_id);

CREATE TABLE app.task_grants (
    task_id    uuid NOT NULL REFERENCES app.tasks(id) ON DELETE CASCADE,
    user_id    uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
    access     app.grant_access NOT NULL DEFAULT 'read',
    granted_by uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (task_id, user_id)
);
CREATE INDEX task_grants_user_idx ON app.task_grants (user_id) INCLUDE (task_id, access);

CREATE TABLE app.task_steps (
    id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id  uuid NOT NULL REFERENCES app.tasks(id) ON DELETE CASCADE,
    body     text NOT NULL CHECK (length(btrim(body)) > 0),
    done     boolean NOT NULL DEFAULT false,
    position integer NOT NULL DEFAULT 0,
    done_by  uuid REFERENCES app.users(id) ON DELETE SET NULL,
    done_at  timestamptz
);
CREATE INDEX task_steps_task_idx ON app.task_steps (task_id, position);

CREATE TABLE app.comments (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id    uuid NOT NULL REFERENCES app.tasks(id) ON DELETE CASCADE,
    author_id  uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
    body       text NOT NULL CHECK (length(btrim(body)) > 0),
    edited_at  timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);
-- Покрывающий индекс под подсчёт count(*) на карточку в списке задач
-- (taskSelect делает это коррелированным подзапросом на каждую строку).
CREATE INDEX comments_task_idx ON app.comments (task_id, created_at) INCLUDE (id);

CREATE TABLE app.attachments (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id    uuid NOT NULL REFERENCES app.tasks(id) ON DELETE CASCADE,
    file_id    uuid NOT NULL REFERENCES app.files(id) ON DELETE RESTRICT,
    author_id  uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
    title      text NOT NULL DEFAULT '',
    edited_at  timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX attachments_task_idx ON app.attachments (task_id, created_at) INCLUDE (id);

CREATE TABLE app.activity (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id    uuid NOT NULL REFERENCES app.tasks(id) ON DELETE CASCADE,
    actor_id   uuid REFERENCES app.users(id) ON DELETE SET NULL,
    body       text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX activity_task_idx ON app.activity (task_id, created_at DESC);

CREATE TABLE app.notifications (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
    body       text NOT NULL,
    board_id   uuid REFERENCES app.boards(id) ON DELETE CASCADE,
    task_id    uuid REFERENCES app.tasks(id) ON DELETE CASCADE,
    read_at    timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);
-- Панель уведомлений листает страницами по (user_id, created_at DESC);
-- бейдж считает непрочитанные — второй индекс держит только их и почти
-- не растёт, даже когда история уведомлений большая.
CREATE INDEX notifications_user_created_idx ON app.notifications (user_id, created_at DESC);
CREATE INDEX notifications_unread_idx ON app.notifications (user_id) WHERE read_at IS NULL;
