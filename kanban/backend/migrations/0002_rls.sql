-- =====================================================================
-- 0002_rls.sql — разграничение доступа на уровне строк и получатели
-- для WebSocket-рассылки.
--
-- Модель:
--   * Приложение подключается ролью app_user. У неё НЕТ BYPASSRLS.
--   * На каждый запрос в транзакции выполняется
--       SELECT set_config('app.user_id', '<uuid>', true)
--     — параметр локален для транзакции и сбрасывается вместе с ней.
--   * Помощники объявлены SECURITY DEFINER и принадлежат app_owner.
--     Владелец таблиц не находится под FORCE ROW LEVEL SECURITY,
--     поэтому внутри помощников RLS не применяется — единственный
--     способ избежать рекурсии политик (политика tasks читает
--     board_members, у которой своя политика, и так далее).
--   * Никакая политика не ссылается на защищённые таблицы напрямую —
--     только через эти функции.
--
-- В конце файла — «зеркальные» функции app.board_watchers /
-- app.task_watchers: они отвечают не «видит ли пользователь X строку»,
-- а «кто вообще видит эту строку», и используются WebSocket-хабом,
-- чтобы разослать событие только тем, кому RLS и так разрешил бы его
-- увидеть через обычный REST-запрос. Если модель доступа выше
-- изменится, эти функции нужно поменять вместе с ней — они намеренно
-- держатся в одном файле, а не разнесены по времени добавления.
-- =====================================================================

SET search_path = app, public;

-- =====================================================================
-- 1. Помощники доступа
-- =====================================================================

CREATE OR REPLACE FUNCTION app.current_user_id() RETURNS uuid
LANGUAGE sql STABLE
AS $$
    SELECT nullif(current_setting('app.user_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION app.board_role(p_board uuid, p_user uuid)
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, public
AS $$
    SELECT m.role::text
      FROM app.board_members m
     WHERE m.board_id = p_board AND m.user_id = p_user
$$;

CREATE OR REPLACE FUNCTION app.can_edit_board(p_board uuid, p_user uuid)
RETURNS boolean
LANGUAGE sql STABLE
AS $$
    SELECT app.board_role(p_board, p_user) IN ('owner', 'editor')
$$;

CREATE OR REPLACE FUNCTION app.is_board_owner(p_board uuid, p_user uuid)
RETURNS boolean
LANGUAGE sql STABLE
AS $$
    SELECT app.board_role(p_board, p_user) = 'owner'
$$;

-- Видимость доски: участник видит доску целиком. Человек, которому
-- открыли одну задачу, видит только строку доски (нужно для названия
-- проекта-источника во «Входящих»), но не её колонки и не остальные
-- задачи — у них свои политики.
CREATE OR REPLACE FUNCTION app.can_see_board(p_board uuid, p_user uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, public
AS $$
    SELECT app.board_role(p_board, p_user) IS NOT NULL
        OR EXISTS (
            SELECT 1 FROM app.tasks t
              JOIN app.task_grants g ON g.task_id = t.id
             WHERE t.board_id = p_board AND g.user_id = p_user)
        OR EXISTS (
            SELECT 1 FROM app.tasks t
              JOIN app.task_assignees a ON a.task_id = t.id
             WHERE t.board_id = p_board AND a.user_id = p_user)
$$;

-- Уровень доступа к конкретной задаче:
--   'edit'       — владелец или редактор доски: полный контроль;
--   'contribute' — читатель доски, назначенный исполнитель либо
--                  точечный грант «участие»: комментарии, файлы,
--                  отметки в чек-листе, но не правка самой задачи;
--   'read'       — точечный грант «просмотр»: ничего не меняет;
--   NULL         — задачи для этого пользователя не существует.
CREATE OR REPLACE FUNCTION app.task_access(p_task uuid, p_user uuid)
RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = app, public
AS $$
DECLARE
    v_board uuid;
    v_role  text;
    v_grant text;
BEGIN
    IF p_user IS NULL OR p_task IS NULL THEN
        RETURN NULL;
    END IF;

    SELECT t.board_id INTO v_board FROM app.tasks t WHERE t.id = p_task;
    IF v_board IS NULL THEN
        RETURN NULL;
    END IF;

    v_role := app.board_role(v_board, p_user);
    IF v_role IN ('owner', 'editor') THEN
        RETURN 'edit';
    ELSIF v_role = 'reader' THEN
        RETURN 'contribute';
    END IF;

    IF EXISTS (SELECT 1 FROM app.task_assignees a
                WHERE a.task_id = p_task AND a.user_id = p_user) THEN
        RETURN 'contribute';
    END IF;

    SELECT g.access::text INTO v_grant
      FROM app.task_grants g
     WHERE g.task_id = p_task AND g.user_id = p_user;

    RETURN v_grant;
END $$;

CREATE OR REPLACE FUNCTION app.can_see_task(p_task uuid, p_user uuid)
RETURNS boolean LANGUAGE sql STABLE
AS $$ SELECT app.task_access(p_task, p_user) IS NOT NULL $$;

CREATE OR REPLACE FUNCTION app.can_contribute_task(p_task uuid, p_user uuid)
RETURNS boolean LANGUAGE sql STABLE
AS $$ SELECT app.task_access(p_task, p_user) IN ('edit', 'contribute') $$;

CREATE OR REPLACE FUNCTION app.can_edit_task(p_task uuid, p_user uuid)
RETURNS boolean LANGUAGE sql STABLE
AS $$ SELECT app.task_access(p_task, p_user) = 'edit' $$;

-- Логин: пароль лежит в таблице, к которой app_user не имеет SELECT на
-- колонку password_hash. Единственный способ достать хеш — эта функция.
CREATE OR REPLACE FUNCTION app.authenticate(p_email citext)
RETURNS TABLE (id uuid, password_hash text, is_active boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, public
AS $$
    SELECT u.id, u.password_hash, u.is_active
      FROM app.users u
     WHERE u.email = p_email AND u.deleted_at IS NULL
$$;

-- =====================================================================
-- 2. Включение RLS
-- =====================================================================
ALTER TABLE app.users           ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.team_members    ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.refresh_tokens  ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.files           ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.boards          ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.board_members   ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.columns         ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.tasks           ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.task_assignees  ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.task_grants     ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.task_steps      ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.comments        ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.attachments     ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.activity        ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.notifications   ENABLE ROW LEVEL SECURITY;

-- =====================================================================
-- 3. Политики
-- =====================================================================

CREATE POLICY users_select ON app.users FOR SELECT
    USING (app.current_user_id() IS NOT NULL);

-- Регистрация выполняется через AsService — без app.user_id в
-- транзакции, поскольку в этот момент человек ещё не аутентифицирован
-- в смысле RLS (это и есть цель регистрации). current_user_id() IS
-- NULL здесь означает «наш собственный бэкенд на предаутентификационном
-- шаге», а не произвольного анонимного клиента: прямого доступа к роли
-- app_user снаружи бэкенда нет.
CREATE POLICY users_insert_public ON app.users FOR INSERT
    WITH CHECK (app.current_user_id() IS NULL);

CREATE POLICY users_update_self ON app.users FOR UPDATE
    USING (id = app.current_user_id())
    WITH CHECK (id = app.current_user_id());

CREATE POLICY team_own ON app.team_members FOR ALL
    USING (owner_id = app.current_user_id())
    WITH CHECK (owner_id = app.current_user_id());

-- Вход, регистрация и обновление токена читают/пишут/гасят строки
-- refresh_tokens через AsService — до появления app.user_id в
-- транзакции. current_user_id() IS NULL покрывает эти
-- предаутентификационные операции; user_id = current_user_id() —
-- операции уже вошедшего пользователя над собственными сессиями
-- (например, смена пароля гасит все свои токены через AsUser).
CREATE POLICY refresh_tokens_service_or_own ON app.refresh_tokens FOR ALL
    USING (app.current_user_id() IS NULL OR user_id = app.current_user_id())
    WITH CHECK (app.current_user_id() IS NULL OR user_id = app.current_user_id());

CREATE POLICY files_select ON app.files FOR SELECT
    USING (
        owner_id = app.current_user_id()
        OR EXISTS (
            SELECT 1 FROM app.attachments a
             WHERE a.file_id = files.id
               AND app.can_see_task(a.task_id, app.current_user_id()))
        OR EXISTS (
            SELECT 1 FROM app.boards b
             WHERE b.bg_file_id = files.id
               AND app.can_see_board(b.id, app.current_user_id()))
    );

CREATE POLICY files_insert ON app.files FOR INSERT
    WITH CHECK (owner_id = app.current_user_id());

CREATE POLICY files_delete ON app.files FOR DELETE
    USING (owner_id = app.current_user_id());

CREATE POLICY boards_select ON app.boards FOR SELECT
    USING (app.can_see_board(id, app.current_user_id()));

CREATE POLICY boards_insert ON app.boards FOR INSERT
    WITH CHECK (created_by = app.current_user_id());

CREATE POLICY boards_update ON app.boards FOR UPDATE
    USING (app.is_board_owner(id, app.current_user_id()))
    WITH CHECK (app.is_board_owner(id, app.current_user_id()));

CREATE POLICY boards_delete ON app.boards FOR DELETE
    USING (app.is_board_owner(id, app.current_user_id()));

CREATE OR REPLACE FUNCTION app.board_owner_bootstrap() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, public AS $$
BEGIN
    INSERT INTO app.board_members (board_id, user_id, role)
    VALUES (NEW.id, NEW.created_by, 'owner');
    RETURN NEW;
END $$;

CREATE TRIGGER boards_owner_bootstrap AFTER INSERT ON app.boards
    FOR EACH ROW EXECUTE FUNCTION app.board_owner_bootstrap();

CREATE POLICY board_members_select ON app.board_members FOR SELECT
    USING (app.board_role(board_id, app.current_user_id()) IS NOT NULL);

CREATE POLICY board_members_write ON app.board_members FOR INSERT
    WITH CHECK (app.is_board_owner(board_id, app.current_user_id()));

CREATE POLICY board_members_update ON app.board_members FOR UPDATE
    USING (app.is_board_owner(board_id, app.current_user_id()))
    WITH CHECK (app.is_board_owner(board_id, app.current_user_id()));

CREATE POLICY board_members_delete ON app.board_members FOR DELETE
    USING (
        (app.is_board_owner(board_id, app.current_user_id()) AND role <> 'owner')
        OR (user_id = app.current_user_id() AND role <> 'owner')
    );

CREATE POLICY columns_select ON app.columns FOR SELECT
    USING (app.board_role(board_id, app.current_user_id()) IS NOT NULL);

CREATE POLICY columns_write ON app.columns FOR INSERT
    WITH CHECK (app.can_edit_board(board_id, app.current_user_id()));

CREATE POLICY columns_update ON app.columns FOR UPDATE
    USING (app.can_edit_board(board_id, app.current_user_id()))
    WITH CHECK (app.can_edit_board(board_id, app.current_user_id()));

CREATE POLICY columns_delete ON app.columns FOR DELETE
    USING (app.can_edit_board(board_id, app.current_user_id()));

CREATE POLICY tasks_select ON app.tasks FOR SELECT
    USING (app.can_see_task(id, app.current_user_id()));

CREATE POLICY tasks_insert ON app.tasks FOR INSERT
    WITH CHECK (
        app.can_edit_board(board_id, app.current_user_id())
        AND created_by = app.current_user_id()
    );

CREATE POLICY tasks_update ON app.tasks FOR UPDATE
    USING (app.can_edit_task(id, app.current_user_id()))
    WITH CHECK (app.can_edit_board(board_id, app.current_user_id()));

CREATE POLICY tasks_delete ON app.tasks FOR DELETE
    USING (app.can_edit_task(id, app.current_user_id()));

CREATE POLICY task_assignees_select ON app.task_assignees FOR SELECT
    USING (app.can_see_task(task_id, app.current_user_id()));

CREATE POLICY task_assignees_write ON app.task_assignees FOR INSERT
    WITH CHECK (app.can_edit_task(task_id, app.current_user_id()));

CREATE POLICY task_assignees_delete ON app.task_assignees FOR DELETE
    USING (app.can_edit_task(task_id, app.current_user_id()));

CREATE POLICY task_grants_select ON app.task_grants FOR SELECT
    USING (
        user_id = app.current_user_id()
        OR app.can_edit_task(task_id, app.current_user_id())
    );

CREATE POLICY task_grants_write ON app.task_grants FOR INSERT
    WITH CHECK (
        app.can_edit_task(task_id, app.current_user_id())
        AND granted_by = app.current_user_id()
    );

CREATE POLICY task_grants_update ON app.task_grants FOR UPDATE
    USING (app.can_edit_task(task_id, app.current_user_id()))
    WITH CHECK (app.can_edit_task(task_id, app.current_user_id()));

CREATE POLICY task_grants_delete ON app.task_grants FOR DELETE
    USING (app.can_edit_task(task_id, app.current_user_id()));

-- Отметить шаг чек-листа может любой участник (в том числе читатель
-- доски и гость с грантом «участие») — политика на UPDATE это уже
-- допускает через can_contribute_task; различие между «отметить» и
-- «переписать текст» проверяется в обработчике (см. handlers/tasks.go),
-- RLS отвечает только за то, какие строки вообще доступны.
CREATE POLICY task_steps_select ON app.task_steps FOR SELECT
    USING (app.can_see_task(task_id, app.current_user_id()));

CREATE POLICY task_steps_insert ON app.task_steps FOR INSERT
    WITH CHECK (app.can_edit_task(task_id, app.current_user_id()));

CREATE POLICY task_steps_update ON app.task_steps FOR UPDATE
    USING (app.can_contribute_task(task_id, app.current_user_id()))
    WITH CHECK (app.can_contribute_task(task_id, app.current_user_id()));

CREATE POLICY task_steps_delete ON app.task_steps FOR DELETE
    USING (app.can_edit_task(task_id, app.current_user_id()));

CREATE POLICY comments_select ON app.comments FOR SELECT
    USING (app.can_see_task(task_id, app.current_user_id()));

CREATE POLICY comments_insert ON app.comments FOR INSERT
    WITH CHECK (
        app.can_contribute_task(task_id, app.current_user_id())
        AND author_id = app.current_user_id()
    );

CREATE POLICY comments_update ON app.comments FOR UPDATE
    USING (author_id = app.current_user_id())
    WITH CHECK (author_id = app.current_user_id());

CREATE POLICY comments_delete ON app.comments FOR DELETE
    USING (
        author_id = app.current_user_id()
        OR app.can_edit_task(task_id, app.current_user_id())
    );

CREATE POLICY attachments_select ON app.attachments FOR SELECT
    USING (app.can_see_task(task_id, app.current_user_id()));

CREATE POLICY attachments_insert ON app.attachments FOR INSERT
    WITH CHECK (
        app.can_contribute_task(task_id, app.current_user_id())
        AND author_id = app.current_user_id()
    );

CREATE POLICY attachments_update ON app.attachments FOR UPDATE
    USING (author_id = app.current_user_id())
    WITH CHECK (author_id = app.current_user_id());

CREATE POLICY attachments_delete ON app.attachments FOR DELETE
    USING (
        author_id = app.current_user_id()
        OR app.can_edit_task(task_id, app.current_user_id())
    );

CREATE POLICY activity_select ON app.activity FOR SELECT
    USING (app.can_see_task(task_id, app.current_user_id()));

CREATE POLICY activity_insert ON app.activity FOR INSERT
    WITH CHECK (
        app.can_contribute_task(task_id, app.current_user_id())
        AND actor_id = app.current_user_id()
    );

CREATE POLICY notifications_own ON app.notifications FOR SELECT
    USING (user_id = app.current_user_id());

CREATE POLICY notifications_update ON app.notifications FOR UPDATE
    USING (user_id = app.current_user_id())
    WITH CHECK (user_id = app.current_user_id());

CREATE POLICY notifications_delete ON app.notifications FOR DELETE
    USING (user_id = app.current_user_id());

-- Уведомления пишет сервис от имени получателя через SECURITY DEFINER:
-- напрямую вставлять чужие строки app_user не может. Функция
-- возвращает вставленную строку целиком — обработчик тут же толкает её
-- получателю по WebSocket, без отдельного запроса на дочитывание.
CREATE OR REPLACE FUNCTION app.notify(
    p_user uuid, p_body text, p_board uuid DEFAULT NULL, p_task uuid DEFAULT NULL)
RETURNS TABLE (id uuid, created_at timestamptz)
LANGUAGE sql SECURITY DEFINER SET search_path = app, public
AS $$
    INSERT INTO app.notifications (user_id, body, board_id, task_id)
    VALUES (p_user, p_body, p_board, p_task)
    RETURNING notifications.id, notifications.created_at
$$;

-- =====================================================================
-- 4. Привилегии рабочей роли
-- =====================================================================
GRANT USAGE ON SCHEMA app TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO app_user;

REVOKE SELECT ON app.users FROM app_user;
GRANT SELECT (id, email, full_name, position, phone, avatar_color,
              is_active, deleted_at, created_at, updated_at)
    ON app.users TO app_user;
GRANT UPDATE (full_name, position, phone, avatar_color, password_hash)
    ON app.users TO app_user;

REVOKE INSERT ON app.notifications FROM app_user;

GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA app
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA app
    GRANT EXECUTE ON FUNCTIONS TO app_user;

-- =====================================================================
-- 5. Наблюдатели для WebSocket-рассылки
--
-- Отвечают не «видит ли пользователь X строку Y» (это can_see_board /
-- can_see_task выше), а «кто вообще видит эту строку» — обратная
-- выборка по тем же таблицам. WebSocket-хаб на стороне Go сам ничего
-- не знает о правах: он получает готовый список user_id и просто
-- рассылает тем, кто сейчас подключён.
-- =====================================================================

CREATE OR REPLACE FUNCTION app.board_watchers(p_board uuid)
RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, public
AS $$
    SELECT user_id FROM app.board_members WHERE board_id = p_board
$$;

CREATE OR REPLACE FUNCTION app.task_watchers(p_task uuid)
RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, public
AS $$
    SELECT m.user_id
      FROM app.tasks t
      JOIN app.board_members m ON m.board_id = t.board_id
     WHERE t.id = p_task
    UNION
    SELECT user_id FROM app.task_grants WHERE task_id = p_task
    UNION
    SELECT user_id FROM app.task_assignees WHERE task_id = p_task
$$;

-- К моменту рассылки события «задача удалена» строки в app.tasks уже
-- нет — JOIN в task_watchers ничего не вернёт. Эта версия принимает
-- board_id напрямую, снятый до DELETE.
CREATE OR REPLACE FUNCTION app.task_watchers_for_board(p_board uuid, p_task uuid)
RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, public
AS $$
    SELECT user_id FROM app.board_members WHERE board_id = p_board
    UNION
    SELECT user_id FROM app.task_grants WHERE task_id = p_task
    UNION
    SELECT user_id FROM app.task_assignees WHERE task_id = p_task
$$;

GRANT EXECUTE ON FUNCTION app.board_watchers(uuid) TO app_user;
GRANT EXECUTE ON FUNCTION app.task_watchers(uuid) TO app_user;
GRANT EXECUTE ON FUNCTION app.task_watchers_for_board(uuid, uuid) TO app_user;
