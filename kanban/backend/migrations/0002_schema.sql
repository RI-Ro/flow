-- =====================================================================
-- 0002_schema.sql — структура базы целиком.
--
-- Собрана с нуля: все поля, добавлявшиеся ранее отдельными правками,
-- объявлены сразу в определениях таблиц. Порядок применения:
--     0001_roles → 0002_schema → 0003_rls → 0004_seed (по желанию)
--
-- Выполняется владельцем таблиц (app_owner или суперпользователем),
-- но НЕ ролью app_user: у неё намеренно нет прав менять структуру.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "citext";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

CREATE SCHEMA IF NOT EXISTS app;
SET search_path = app, public;
SET client_min_messages = warning;

-- =====================================================================
-- Типы
-- =====================================================================

-- Роль внутри проекта. Не путать с system_role: та про администрирование
-- учётных записей, эта — про права в конкретном проекте.
CREATE TYPE app.board_role AS ENUM ('owner', 'editor', 'reader');

-- Точечный доступ к одной задаче для человека вне проекта.
CREATE TYPE app.grant_access AS ENUM ('read', 'contribute');

-- Приоритеты в терминах делопроизводства, без англицизмов.
-- «dated» означает, что срок назначен явно и является главным
-- признаком задачи.
CREATE TYPE app.task_priority AS ENUM
    ('normal', 'dated', 'prompt', 'urgent', 'very_urgent');

-- Роль в системе целиком.
CREATE TYPE app.system_role AS ENUM ('member', 'admin');

-- Виды связей между задачами.
CREATE TYPE app.task_link_kind AS ENUM ('blocks', 'relates', 'subtask');

CREATE OR REPLACE FUNCTION app.touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END $$;

-- =====================================================================
-- Пользователи
-- =====================================================================

CREATE TABLE app.users (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email         citext NOT NULL UNIQUE,
    password_hash text   NOT NULL,
    full_name     text   NOT NULL,
    position      text   NOT NULL DEFAULT '',
    phone         text   NOT NULL DEFAULT '',
    avatar_color  text   NOT NULL DEFAULT '#3D5A80',
    role          app.system_role NOT NULL DEFAULT 'member',
    is_active     boolean NOT NULL DEFAULT true,
    -- Удаление мягкое: created_by в проектах, задачах и комментариях
    -- объявлены ON DELETE RESTRICT, и физическое удаление либо было бы
    -- отвергнуто базой, либо уничтожило бы историю работы.
    deleted_at    timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Поиск по справочнику идёт через ILIKE '%подстрока%'. B-tree такому
-- запросу не помогает вовсе — нужен триграммный индекс, иначе каждый
-- поиск это полный проход по таблице.
CREATE INDEX users_search_trgm_idx ON app.users
    USING gin ((full_name || ' ' || position || ' ' || phone) gin_trgm_ops);

-- Сортировка справочника: действующие сначала, внутри по алфавиту.
CREATE INDEX users_directory_sort_idx ON app.users ((deleted_at IS NOT NULL), full_name);

-- Администраторов единицы, а проверка прав идёт на каждый админский
-- вызов — частичный индекс держит её дешёвой.
CREATE INDEX users_admin_idx ON app.users (id)
    WHERE role = 'admin' AND deleted_at IS NULL;

CREATE TRIGGER users_touch BEFORE UPDATE ON app.users
    FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Личная команда: кого пользователь держит под рукой для назначения
-- исполнителями.
CREATE TABLE app.team_members (
    owner_id  uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
    member_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
    added_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (owner_id, member_id),
    CONSTRAINT team_members_not_self CHECK (owner_id <> member_id)
);

-- =====================================================================
-- Сессии
-- =====================================================================

CREATE TABLE app.refresh_tokens (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
    -- Хранится SHA-256, а не сам токен: дамп таблицы не даёт войти.
    token_hash  bytea NOT NULL UNIQUE,
    family_id   uuid NOT NULL,
    expires_at  timestamptz NOT NULL,
    revoked_at  timestamptz,
    user_agent  text NOT NULL DEFAULT '',
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX refresh_tokens_user_idx   ON app.refresh_tokens (user_id);
CREATE INDEX refresh_tokens_family_idx ON app.refresh_tokens (family_id);
CREATE INDEX refresh_tokens_active_idx ON app.refresh_tokens (user_id)
    WHERE revoked_at IS NULL;

-- =====================================================================
-- Замещение на время отсутствия
-- =====================================================================

CREATE TABLE app.delegations (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    grantor_id  uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
    deputy_id   uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
    starts_at   date NOT NULL,
    ends_at     date NOT NULL,
    note        text NOT NULL DEFAULT '',
    created_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT delegations_period_check CHECK (ends_at >= starts_at),
    CONSTRAINT delegations_not_self CHECK (grantor_id <> deputy_id)
);

CREATE INDEX delegations_deputy_idx  ON app.delegations (deputy_id, starts_at, ends_at);
CREATE INDEX delegations_grantor_idx ON app.delegations (grantor_id);

-- =====================================================================
-- Файлы
-- =====================================================================

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

-- =====================================================================
-- Проекты
-- =====================================================================

CREATE TABLE app.boards (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    title        text NOT NULL CHECK (length(btrim(title)) > 0),
    description  text NOT NULL DEFAULT '',
    -- Дерево проектов. Если родитель недоступен пользователю, клиент
    -- поднимает узел в корень — сервер отдаёт parent_id как есть.
    parent_id    uuid REFERENCES app.boards(id) ON DELETE SET NULL,
    position     integer NOT NULL DEFAULT 0,
    bg_preset    text NOT NULL DEFAULT 'none',
    bg_file_id   uuid REFERENCES app.files(id) ON DELETE SET NULL,
    bg_blur      boolean NOT NULL DEFAULT false,
    archived     boolean NOT NULL DEFAULT false,
    created_by   uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX boards_parent_idx ON app.boards (parent_id, position);

CREATE TRIGGER boards_touch BEFORE UPDATE ON app.boards
    FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Защита от цикла в дереве. Без неё рекурсивный обход зациклится
-- намертво, а исправить это можно будет только правкой в базе.
CREATE OR REPLACE FUNCTION app.check_board_cycle() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, public AS $$
DECLARE
    cur uuid := NEW.parent_id;
    depth int := 0;
BEGIN
    IF NEW.parent_id IS NULL THEN
        RETURN NEW;
    END IF;
    IF NEW.parent_id = NEW.id THEN
        RAISE EXCEPTION 'Проект не может быть вложен сам в себя';
    END IF;

    WHILE cur IS NOT NULL LOOP
        depth := depth + 1;
        IF depth > 32 THEN
            RAISE EXCEPTION 'Слишком глубокая вложенность проектов';
        END IF;
        SELECT parent_id INTO cur FROM app.boards WHERE id = cur;
        IF cur = NEW.id THEN
            RAISE EXCEPTION 'Нельзя вложить проект внутрь его собственного подпроекта';
        END IF;
    END LOOP;
    RETURN NEW;
END $$;

CREATE TRIGGER boards_cycle_check BEFORE INSERT OR UPDATE OF parent_id ON app.boards
    FOR EACH ROW EXECUTE FUNCTION app.check_board_cycle();

CREATE TABLE app.board_members (
    board_id  uuid NOT NULL REFERENCES app.boards(id) ON DELETE CASCADE,
    user_id   uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
    role      app.board_role NOT NULL DEFAULT 'reader',
    added_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (board_id, user_id)
);

CREATE INDEX board_members_user_idx ON app.board_members (user_id);

-- У проекта всегда ровно один владелец.
CREATE UNIQUE INDEX board_single_owner_idx ON app.board_members (board_id)
    WHERE role = 'owner';

-- =====================================================================
-- Колонки
-- =====================================================================

CREATE TABLE app.columns (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    board_id   uuid NOT NULL REFERENCES app.boards(id) ON DELETE CASCADE,
    title      text NOT NULL CHECK (length(btrim(title)) > 0),
    color      text NOT NULL DEFAULT '#8892A8',
    position   integer NOT NULL DEFAULT 0,
    -- 0 означает «предел не задан».
    wip_limit  integer NOT NULL DEFAULT 0 CHECK (wip_limit >= 0),
    -- Колонка завершения: перенос в неё закрывает задачу.
    is_done    boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX columns_board_idx ON app.columns (board_id, position);

-- =====================================================================
-- Задачи
-- =====================================================================

CREATE TABLE app.tasks (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    board_id     uuid NOT NULL REFERENCES app.boards(id) ON DELETE CASCADE,
    column_id    uuid NOT NULL REFERENCES app.columns(id) ON DELETE CASCADE,
    title        text NOT NULL CHECK (length(btrim(title)) > 0),
    description  text NOT NULL DEFAULT '',
    priority     app.task_priority NOT NULL DEFAULT 'normal',
    -- Идентификатор цвета из палитры, а не готовый оттенок: конкретные
    -- значения зависят от темы оформления и подставляются на клиенте.
    color        text NOT NULL DEFAULT 'none',
    due_date     date,
    -- Реквизиты входящего документа, по которому заведена задача.
    incoming_number text NOT NULL DEFAULT '',
    incoming_date   date,
    position     integer NOT NULL DEFAULT 0,
    tags         text[] NOT NULL DEFAULT '{}',
    completed_at timestamptz,
    archived     boolean NOT NULL DEFAULT false,
    created_by   uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT tasks_color_check CHECK (color IN (
        'none', 'amber', 'rose', 'violet', 'sky', 'emerald',
        'orange', 'slate', 'teal', 'crimson'))
);

CREATE INDEX tasks_board_idx  ON app.tasks (board_id);
CREATE INDEX tasks_column_idx ON app.tasks (column_id, position);
CREATE INDEX tasks_author_idx ON app.tasks (created_by);
CREATE INDEX tasks_search_idx ON app.tasks
    USING gin (to_tsvector('russian', title || ' ' || description));

-- Календарь всегда запрашивает диапазон дат, поэтому индекс частичный:
-- задачи без срока в него не попадают, а их на живой доске обычно треть.
CREATE INDEX tasks_due_date_idx ON app.tasks (due_date, board_id)
    WHERE due_date IS NOT NULL AND NOT archived;

-- Поиск по номеру документа — частый сценарий канцелярии.
CREATE INDEX tasks_incoming_number_idx ON app.tasks (incoming_number)
    WHERE incoming_number <> '';

CREATE TRIGGER tasks_touch BEFORE UPDATE ON app.tasks
    FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

CREATE TABLE app.task_assignees (
    task_id      uuid NOT NULL REFERENCES app.tasks(id) ON DELETE CASCADE,
    user_id      uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
    -- Отметка исполнителя «свою часть сделал». Отличается от
    -- tasks.completed_at: там решение автора «задача принята».
    completed_at timestamptz,
    PRIMARY KEY (task_id, user_id)
);

CREATE INDEX task_assignees_user_idx ON app.task_assignees (user_id);
CREATE INDEX task_assignees_done_idx ON app.task_assignees (task_id)
    WHERE completed_at IS NOT NULL;

CREATE TABLE app.task_grants (
    task_id    uuid NOT NULL REFERENCES app.tasks(id) ON DELETE CASCADE,
    user_id    uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
    access     app.grant_access NOT NULL DEFAULT 'read',
    granted_by uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (task_id, user_id)
);

CREATE INDEX task_grants_user_idx ON app.task_grants (user_id);

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

CREATE TABLE app.task_links (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    from_task  uuid NOT NULL REFERENCES app.tasks(id) ON DELETE CASCADE,
    to_task    uuid NOT NULL REFERENCES app.tasks(id) ON DELETE CASCADE,
    kind       app.task_link_kind NOT NULL DEFAULT 'relates',
    created_by uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT task_links_not_self CHECK (from_task <> to_task),
    CONSTRAINT task_links_unique UNIQUE (from_task, to_task, kind)
);

CREATE INDEX task_links_from_idx ON app.task_links (from_task);
CREATE INDEX task_links_to_idx   ON app.task_links (to_task);

-- =====================================================================
-- Обсуждение и вложения
-- =====================================================================

CREATE TABLE app.comments (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id    uuid NOT NULL REFERENCES app.tasks(id) ON DELETE CASCADE,
    author_id  uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
    body       text NOT NULL CHECK (length(btrim(body)) > 0),
    edited_at  timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX comments_task_idx ON app.comments (task_id, created_at);

CREATE TABLE app.attachments (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id    uuid NOT NULL REFERENCES app.tasks(id) ON DELETE CASCADE,
    file_id    uuid NOT NULL REFERENCES app.files(id) ON DELETE RESTRICT,
    author_id  uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
    title      text NOT NULL DEFAULT '',
    edited_at  timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX attachments_task_idx ON app.attachments (task_id, created_at);

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

CREATE INDEX notifications_user_idx ON app.notifications (user_id, created_at DESC);
CREATE INDEX notifications_user_unread_idx ON app.notifications (user_id, created_at DESC)
    WHERE read_at IS NULL;

-- =====================================================================
-- Шаблоны задач
--
-- Заменяют цикличные задачи: экземпляр появляется по действию человека,
-- поэтому мусор не накапливается.
-- =====================================================================

CREATE TABLE app.task_templates (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- NULL означает личный шаблон, доступный владельцу в любом проекте.
    board_id    uuid REFERENCES app.boards(id) ON DELETE CASCADE,
    owner_id    uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
    name        text NOT NULL CHECK (length(btrim(name)) > 0),
    title       text NOT NULL DEFAULT '',
    description text NOT NULL DEFAULT '',
    priority    app.task_priority NOT NULL DEFAULT 'normal',
    color       text NOT NULL DEFAULT 'none',
    tags        text[] NOT NULL DEFAULT '{}',
    -- Срок задаётся смещением в днях от момента применения: абсолютная
    -- дата в шаблоне устарела бы после первого же использования.
    due_in_days integer,
    steps       text[] NOT NULL DEFAULT '{}',
    assignees   uuid[] NOT NULL DEFAULT '{}',
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX task_templates_board_idx ON app.task_templates (board_id);
CREATE INDEX task_templates_owner_idx ON app.task_templates (owner_id);
