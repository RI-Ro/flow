-- =====================================================================
-- 0003_rls.sql — разграничение доступа на уровне строк.
--
-- Модель:
--   * Приложение подключается ролью app_user без BYPASSRLS.
--   * На каждый запрос в транзакции выполняется
--       SELECT set_config('app.user_id', '<uuid>', true)
--     Параметр локален для транзакции и исчезает вместе с ней, поэтому
--     не может утечь на следующий запрос через тот же коннект пула.
--   * Помощники объявлены SECURITY DEFINER и принадлежат владельцу
--     таблиц. Владелец не под FORCE ROW LEVEL SECURITY, поэтому внутри
--     помощников RLS не применяется — единственный способ избежать
--     бесконечной рекурсии политик (политика tasks читает
--     board_members, у которой своя политика, и так далее).
--   * Ни одна политика не обращается к защищённым таблицам напрямую,
--     только через эти функции.
-- =====================================================================

SET search_path = app, public;
SET client_min_messages = warning;

-- =====================================================================
-- 1. Помощники
-- =====================================================================

-- Текущий пользователь. NULL, если параметр не выставлен: тогда все
-- политики дают false и запрос честно возвращает ноль строк. Забытая
-- установка контекста приводит к пустому ответу, а не к утечке.
CREATE OR REPLACE FUNCTION app.current_user_id() RETURNS uuid
LANGUAGE sql STABLE
AS $$
    SELECT nullif(current_setting('app.user_id', true), '')::uuid
$$;

-- Чьи права действуют у пользователя: свои плюс тех, кого он замещает
-- в текущую дату. Права именно расширяются, а не копируются: копия
-- разошлась бы с оригиналом при первом изменении состава участников.
CREATE OR REPLACE FUNCTION app.effective_users(p_user uuid)
RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, public
AS $$
    SELECT p_user
    UNION
    SELECT d.grantor_id FROM app.delegations d
     WHERE d.deputy_id = p_user
       AND current_date BETWEEN d.starts_at AND d.ends_at
$$;

-- Роль на доске с учётом замещения — берётся сильнейшая из доступных.
-- Порядок задан явно: сравнивать текстом нельзя, «editor» и «owner»
-- в алфавитном порядке идут наоборот.
CREATE OR REPLACE FUNCTION app.board_role(p_board uuid, p_user uuid)
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, public
AS $$
    SELECT m.role::text
      FROM app.board_members m
     WHERE m.board_id = p_board
       AND m.user_id IN (SELECT app.effective_users(p_user))
     ORDER BY CASE m.role WHEN 'owner' THEN 3 WHEN 'editor' THEN 2 ELSE 1 END DESC
     LIMIT 1
$$;

CREATE OR REPLACE FUNCTION app.can_edit_board(p_board uuid, p_user uuid)
RETURNS boolean LANGUAGE sql STABLE
AS $$ SELECT app.board_role(p_board, p_user) IN ('owner', 'editor') $$;

CREATE OR REPLACE FUNCTION app.is_board_owner(p_board uuid, p_user uuid)
RETURNS boolean LANGUAGE sql STABLE
AS $$ SELECT app.board_role(p_board, p_user) = 'owner' $$;

-- Видимость проекта. Участник видит проект целиком. Человек, которому
-- открыли одну задачу, видит только строку проекта — она нужна, чтобы
-- показать название источника во «Входящих», — но не его колонки и не
-- остальные задачи: у них свои политики.
CREATE OR REPLACE FUNCTION app.can_see_board(p_board uuid, p_user uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, public
AS $$
    SELECT app.board_role(p_board, p_user) IS NOT NULL
        OR EXISTS (
            SELECT 1 FROM app.tasks t
              JOIN app.task_grants g ON g.task_id = t.id
             WHERE t.board_id = p_board
               AND g.user_id IN (SELECT app.effective_users(p_user)))
        OR EXISTS (
            SELECT 1 FROM app.tasks t
              JOIN app.task_assignees a ON a.task_id = t.id
             WHERE t.board_id = p_board
               AND a.user_id IN (SELECT app.effective_users(p_user)))
$$;

-- Уровень доступа к задаче:
--   'edit'       — владелец или редактор проекта: полный контроль;
--   'contribute' — читатель проекта, назначенный исполнитель либо
--                  точечный грант «участие»: комментарии, файлы,
--                  отметки в чек-листе, но не правка самой задачи;
--   'read'       — точечный грант «просмотр»;
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
                WHERE a.task_id = p_task
                  AND a.user_id IN (SELECT app.effective_users(p_user))) THEN
        RETURN 'contribute';
    END IF;

    SELECT g.access::text INTO v_grant
      FROM app.task_grants g
     WHERE g.task_id = p_task
       AND g.user_id IN (SELECT app.effective_users(p_user))
     LIMIT 1;

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

-- Завершить задачу вправе только её автор или владелец проекта.
-- Исполнитель сообщает о готовности отметкой о сдаче — принимает
-- работу поставивший.
CREATE OR REPLACE FUNCTION app.can_close_task(p_task uuid, p_user uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, public
AS $$
    SELECT EXISTS (
        SELECT 1 FROM app.tasks t
         WHERE t.id = p_task
           AND (t.created_by IN (SELECT app.effective_users(p_user))
                OR app.board_role(t.board_id, p_user) = 'owner'))
$$;

-- Права администратора. Проверяются запросом к базе на каждый вызов,
-- а не по полю в токене: иначе снятие прав вступало бы в силу только
-- через время жизни access-токена.
CREATE OR REPLACE FUNCTION app.is_admin(p_user uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, public
AS $$
    SELECT EXISTS (
        SELECT 1 FROM app.users u
         WHERE u.id = p_user AND u.role = 'admin'
           AND u.deleted_at IS NULL AND u.is_active)
$$;

-- Сколько останется администраторов, если исключить указанного.
-- Нужна, чтобы не дать снять права у последнего и запереть систему.
CREATE OR REPLACE FUNCTION app.other_admins_count(p_except uuid)
RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, public
AS $$
    SELECT count(*)::integer FROM app.users u
     WHERE u.role = 'admin' AND u.deleted_at IS NULL AND u.is_active
       AND u.id <> p_except
$$;

-- Вход: пароль лежит в колонке, к которой у app_user нет привилегии
-- SELECT. Единственный способ достать хеш — эта функция.
CREATE OR REPLACE FUNCTION app.authenticate(p_email citext)
RETURNS TABLE (id uuid, password_hash text, is_active boolean, role text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, public
AS $$
    SELECT u.id, u.password_hash, u.is_active, u.role::text
      FROM app.users u
     WHERE u.email = p_email AND u.deleted_at IS NULL
$$;

-- Состояние учётной записи для проверки при обновлении токена.
-- Отдельная функция, потому что обновление выполняется до появления
-- app.user_id, когда политика users_select ещё не пропускает чтение.
CREATE OR REPLACE FUNCTION app.account_state(p_user uuid)
RETURNS TABLE (is_active boolean, deleted boolean, role text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, public
AS $$
    SELECT u.is_active, (u.deleted_at IS NOT NULL), u.role::text
      FROM app.users u WHERE u.id = p_user
$$;

-- Погасить все сессии пользователя: при блокировке, удалении и
-- принудительной смене пароля — иначе выданный ранее refresh-токен
-- продолжал бы работать месяц.
CREATE OR REPLACE FUNCTION app.revoke_user_sessions(p_user uuid)
RETURNS integer
LANGUAGE sql SECURITY DEFINER SET search_path = app, public
AS $$
    WITH killed AS (
        UPDATE app.refresh_tokens SET revoked_at = now()
         WHERE user_id = p_user AND revoked_at IS NULL
        RETURNING 1)
    SELECT count(*)::integer FROM killed
$$;

-- =====================================================================
-- 2. Получатели событий реального времени
--
-- Список считают SQL-функции, а не Go: они зеркалят те же условия
-- видимости, что и политики ниже. Повторять эту логику в приложении
-- нельзя — она неминуемо разойдётся с политиками, и событие уйдёт
-- тому, кому задача недоступна.
-- =====================================================================

CREATE OR REPLACE FUNCTION app.board_watchers(p_board uuid)
RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, public
AS $$
    SELECT DISTINCT m.user_id FROM app.board_members m WHERE m.board_id = p_board
    UNION
    SELECT DISTINCT d.deputy_id
      FROM app.board_members m
      JOIN app.delegations d ON d.grantor_id = m.user_id
     WHERE m.board_id = p_board
       AND current_date BETWEEN d.starts_at AND d.ends_at
$$;

CREATE OR REPLACE FUNCTION app.task_watchers(p_task uuid)
RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, public
AS $$
    WITH base AS (
        SELECT m.user_id FROM app.tasks t
          JOIN app.board_members m ON m.board_id = t.board_id
         WHERE t.id = p_task
        UNION
        SELECT a.user_id FROM app.task_assignees a WHERE a.task_id = p_task
        UNION
        SELECT g.user_id FROM app.task_grants g WHERE g.task_id = p_task
    )
    SELECT user_id FROM base
    UNION
    SELECT d.deputy_id FROM base b
      JOIN app.delegations d ON d.grantor_id = b.user_id
     WHERE current_date BETWEEN d.starts_at AND d.ends_at
$$;

-- Получатели для уже удалённой задачи: board_id передаётся явно,
-- поэтому функция работает и после DELETE.
CREATE OR REPLACE FUNCTION app.task_watchers_for_board(p_board uuid, p_task uuid)
RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, public
AS $$
    SELECT app.board_watchers(p_board)
    UNION
    SELECT a.user_id FROM app.task_assignees a WHERE a.task_id = p_task
    UNION
    SELECT g.user_id FROM app.task_grants g WHERE g.task_id = p_task
$$;

-- Уведомление пишется от имени сервиса: напрямую вставлять строки для
-- других пользователей app_user не может.
CREATE OR REPLACE FUNCTION app.notify(
    p_user uuid, p_body text, p_board uuid DEFAULT NULL, p_task uuid DEFAULT NULL)
RETURNS TABLE (id uuid, created_at timestamptz)
LANGUAGE sql SECURITY DEFINER SET search_path = app, public
AS $$
    INSERT INTO app.notifications (user_id, body, board_id, task_id)
    VALUES (p_user, p_body, p_board, p_task)
    RETURNING notifications.id, notifications.created_at
$$;

-- Действующие замещения по всем сотрудникам.
--
-- Политика delegations_select намеренно узкая: чужие прошедшие и
-- будущие договорённости никого не касаются. Но факт «человек сейчас
-- в отпуске, обращайтесь к заместителю» нужен всем, кто видит его
-- карточку, — иначе задачи уходят в пустоту. Поэтому отдельная
-- функция, отдающая только действующие периоды.
CREATE OR REPLACE FUNCTION app.active_delegations()
RETURNS TABLE (id uuid, grantor_id uuid, deputy_id uuid,
               starts_at text, ends_at text, note text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, public
AS $$
    SELECT d.id, d.grantor_id, d.deputy_id,
           to_char(d.starts_at, 'YYYY-MM-DD'),
           to_char(d.ends_at, 'YYYY-MM-DD'),
           d.note
      FROM app.delegations d
     WHERE current_date BETWEEN d.starts_at AND d.ends_at
$$;

-- Уведомить всех наблюдателей задачи, кроме инициатора.
CREATE OR REPLACE FUNCTION app.notify_task_watchers(
    p_task uuid, p_actor uuid, p_body text)
RETURNS SETOF uuid
LANGUAGE sql SECURITY DEFINER SET search_path = app, public
AS $$
    INSERT INTO app.notifications (user_id, body, board_id, task_id)
    SELECT DISTINCT w.user_id, p_body, t.board_id, t.id
      FROM app.tasks t
      CROSS JOIN LATERAL app.task_watchers(t.id) AS w(user_id)
      JOIN app.users u ON u.id = w.user_id
     WHERE t.id = p_task
       -- Инициатор не уведомляется о собственном действии. Проверка
       -- идёт по всей его действующей личности: замещая коллегу,
       -- человек не должен получать уведомление о том, что сделал сам.
       AND w.user_id <> ALL (SELECT app.effective_users(p_actor))
       -- Отключённым и удалённым уведомления не нужны: они всё равно
       -- не войдут, а строки копятся.
       AND u.deleted_at IS NULL AND u.is_active
    RETURNING notifications.user_id
$$;

-- =====================================================================
-- 3. Включение RLS
-- =====================================================================

ALTER TABLE app.users           ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.team_members    ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.refresh_tokens  ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.delegations     ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.files           ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.boards          ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.board_members   ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.columns         ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.tasks           ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.task_assignees  ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.task_grants     ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.task_steps      ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.task_links      ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.task_templates  ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.comments        ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.attachments     ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.activity        ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.notifications   ENABLE ROW LEVEL SECURITY;

-- =====================================================================
-- 4. Политики
-- =====================================================================

-- ------------------------------------------------------------- users
-- Справочник виден всем вошедшим: без него нельзя выбрать исполнителя.
-- Удалённые видны тоже — иначе в старых задачах и комментариях остались
-- бы «висячие» идентификаторы без имени.
CREATE POLICY users_select ON app.users FOR SELECT
    USING (app.current_user_id() IS NOT NULL);

-- Регистрация выполняется до появления app.user_id (человек ещё не
-- аутентифицирован — в этом её смысл). NULL здесь означает «наш
-- собственный бэкенд на предаутентификационном шаге»: прямого доступа
-- к роли app_user снаружи нет.
CREATE POLICY users_insert ON app.users FOR INSERT
    WITH CHECK (
        app.current_user_id() IS NULL
        OR app.is_admin(app.current_user_id())
    );

CREATE POLICY users_update ON app.users FOR UPDATE
    USING (
        id = app.current_user_id()
        OR app.is_admin(app.current_user_id())
    )
    WITH CHECK (
        id = app.current_user_id()
        OR app.is_admin(app.current_user_id())
    );

-- Политики DELETE нет намеренно: её отсутствие запрещает операцию.
-- «Удаление» пользователя — это deleted_at + is_active = false.

-- ------------------------------------------------------ team_members
CREATE POLICY team_own ON app.team_members FOR ALL
    USING (owner_id = app.current_user_id())
    WITH CHECK (owner_id = app.current_user_id());

-- ---------------------------------------------------- refresh_tokens
-- Вход, регистрация и обновление токена читают и пишут эти строки до
-- появления app.user_id — отсюда первая ветвь условия. Вторая
-- покрывает операции вошедшего над собственными сессиями.
CREATE POLICY refresh_tokens_service_or_own ON app.refresh_tokens FOR ALL
    USING (app.current_user_id() IS NULL OR user_id = app.current_user_id())
    WITH CHECK (app.current_user_id() IS NULL OR user_id = app.current_user_id());

-- -------------------------------------------------------- delegations
-- Видят обе стороны; заводит и отменяет только замещаемый: назначить
-- себя чужим заместителем означало бы присвоить права.
CREATE POLICY delegations_select ON app.delegations FOR SELECT
    USING (grantor_id = app.current_user_id() OR deputy_id = app.current_user_id());

CREATE POLICY delegations_write ON app.delegations FOR INSERT
    WITH CHECK (grantor_id = app.current_user_id());

CREATE POLICY delegations_delete ON app.delegations FOR DELETE
    USING (grantor_id = app.current_user_id());

-- ------------------------------------------------------------- files
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

-- ------------------------------------------------------------ boards
CREATE POLICY boards_select ON app.boards FOR SELECT
    USING (app.can_see_board(id, app.current_user_id()));

CREATE POLICY boards_insert ON app.boards FOR INSERT
    WITH CHECK (created_by = app.current_user_id());

CREATE POLICY boards_update ON app.boards FOR UPDATE
    USING (app.is_board_owner(id, app.current_user_id()))
    WITH CHECK (app.is_board_owner(id, app.current_user_id()));

CREATE POLICY boards_delete ON app.boards FOR DELETE
    USING (app.is_board_owner(id, app.current_user_id()));

-- Владелец проставляется триггером: иначе после INSERT в boards
-- пользователь не прошёл бы политику board_members и не смог бы
-- записать сам себя.
CREATE OR REPLACE FUNCTION app.board_owner_bootstrap() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, public AS $$
BEGIN
    INSERT INTO app.board_members (board_id, user_id, role)
    VALUES (NEW.id, NEW.created_by, 'owner');
    RETURN NEW;
END $$;

CREATE TRIGGER boards_owner_bootstrap AFTER INSERT ON app.boards
    FOR EACH ROW EXECUTE FUNCTION app.board_owner_bootstrap();

-- ----------------------------------------------------- board_members
CREATE POLICY board_members_select ON app.board_members FOR SELECT
    USING (app.board_role(board_id, app.current_user_id()) IS NOT NULL);

CREATE POLICY board_members_write ON app.board_members FOR INSERT
    WITH CHECK (app.is_board_owner(board_id, app.current_user_id()));

CREATE POLICY board_members_update ON app.board_members FOR UPDATE
    USING (app.is_board_owner(board_id, app.current_user_id()))
    WITH CHECK (app.is_board_owner(board_id, app.current_user_id()));

-- Владелец убирает кого угодно, кроме себя; участник может уйти сам.
CREATE POLICY board_members_delete ON app.board_members FOR DELETE
    USING (
        (app.is_board_owner(board_id, app.current_user_id()) AND role <> 'owner')
        OR (user_id = app.current_user_id() AND role <> 'owner')
    );

-- ----------------------------------------------------------- columns
-- Колонки видит только участник проекта. Для точечного гранта колонок
-- не существует — поэтому «Входящие» и группируются по проектам.
CREATE POLICY columns_select ON app.columns FOR SELECT
    USING (app.board_role(board_id, app.current_user_id()) IS NOT NULL);

CREATE POLICY columns_write ON app.columns FOR INSERT
    WITH CHECK (app.can_edit_board(board_id, app.current_user_id()));

CREATE POLICY columns_update ON app.columns FOR UPDATE
    USING (app.can_edit_board(board_id, app.current_user_id()))
    WITH CHECK (app.can_edit_board(board_id, app.current_user_id()));

CREATE POLICY columns_delete ON app.columns FOR DELETE
    USING (app.can_edit_board(board_id, app.current_user_id()));

-- ------------------------------------------------------------- tasks
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

-- --------------------------------------------------- task_assignees
CREATE POLICY task_assignees_select ON app.task_assignees FOR SELECT
    USING (app.can_see_task(task_id, app.current_user_id()));

CREATE POLICY task_assignees_write ON app.task_assignees FOR INSERT
    WITH CHECK (app.can_edit_task(task_id, app.current_user_id()));

-- Отметку о сдаче ставит только сам исполнитель: право поставить её за
-- другого лишило бы отметку смысла.
CREATE POLICY task_assignees_self_update ON app.task_assignees FOR UPDATE
    USING (
        user_id = app.current_user_id()
        AND app.can_see_task(task_id, app.current_user_id())
    )
    WITH CHECK (
        user_id = app.current_user_id()
        AND app.can_see_task(task_id, app.current_user_id())
    );

CREATE POLICY task_assignees_delete ON app.task_assignees FOR DELETE
    USING (app.can_edit_task(task_id, app.current_user_id()));

-- ------------------------------------------------------- task_grants
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

-- -------------------------------------------------------- task_steps
-- Отметить шаг может участник (включая читателя и гостя с грантом
-- «участие»). Менять текст и состав — только редактор; это проверяется
-- в обработчике, RLS отвечает за видимость строк.
CREATE POLICY task_steps_select ON app.task_steps FOR SELECT
    USING (app.can_see_task(task_id, app.current_user_id()));

CREATE POLICY task_steps_insert ON app.task_steps FOR INSERT
    WITH CHECK (app.can_edit_task(task_id, app.current_user_id()));

CREATE POLICY task_steps_update ON app.task_steps FOR UPDATE
    USING (app.can_contribute_task(task_id, app.current_user_id()))
    WITH CHECK (app.can_contribute_task(task_id, app.current_user_id()));

CREATE POLICY task_steps_delete ON app.task_steps FOR DELETE
    USING (app.can_edit_task(task_id, app.current_user_id()));

-- -------------------------------------------------------- task_links
-- Связь видна, только если видны ОБЕ задачи: иначе через неё можно
-- было бы узнать о существовании и названии закрытой задачи.
CREATE POLICY task_links_select ON app.task_links FOR SELECT
    USING (
        app.can_see_task(from_task, app.current_user_id())
        AND app.can_see_task(to_task, app.current_user_id())
    );

CREATE POLICY task_links_write ON app.task_links FOR INSERT
    WITH CHECK (
        app.can_edit_task(from_task, app.current_user_id())
        AND app.can_see_task(to_task, app.current_user_id())
        AND created_by = app.current_user_id()
    );

CREATE POLICY task_links_delete ON app.task_links FOR DELETE
    USING (app.can_edit_task(from_task, app.current_user_id()));

-- ---------------------------------------------------- task_templates
CREATE POLICY task_templates_select ON app.task_templates FOR SELECT
    USING (
        owner_id = app.current_user_id()
        OR (board_id IS NOT NULL
            AND app.board_role(board_id, app.current_user_id()) IS NOT NULL)
    );

CREATE POLICY task_templates_write ON app.task_templates FOR INSERT
    WITH CHECK (
        owner_id = app.current_user_id()
        AND (board_id IS NULL OR app.can_edit_board(board_id, app.current_user_id()))
    );

CREATE POLICY task_templates_update ON app.task_templates FOR UPDATE
    USING (owner_id = app.current_user_id())
    WITH CHECK (owner_id = app.current_user_id());

CREATE POLICY task_templates_delete ON app.task_templates FOR DELETE
    USING (
        owner_id = app.current_user_id()
        OR (board_id IS NOT NULL AND app.is_board_owner(board_id, app.current_user_id()))
    );

-- ---------------------------------------------------------- comments
-- Правка своего — в течение часа: обсуждение не должно переписываться
-- задним числом. Удаление редактором задачи бессрочно: убрать
-- неуместное вложение нужно уметь всегда.
CREATE POLICY comments_select ON app.comments FOR SELECT
    USING (app.can_see_task(task_id, app.current_user_id()));

CREATE POLICY comments_insert ON app.comments FOR INSERT
    WITH CHECK (
        app.can_contribute_task(task_id, app.current_user_id())
        AND author_id = app.current_user_id()
    );

CREATE POLICY comments_update ON app.comments FOR UPDATE
    USING (
        author_id = app.current_user_id()
        AND created_at > now() - interval '1 hour'
    )
    WITH CHECK (
        author_id = app.current_user_id()
        AND created_at > now() - interval '1 hour'
    );

CREATE POLICY comments_delete ON app.comments FOR DELETE
    USING (
        (author_id = app.current_user_id() AND created_at > now() - interval '1 hour')
        OR app.can_edit_task(task_id, app.current_user_id())
    );

-- ------------------------------------------------------- attachments
CREATE POLICY attachments_select ON app.attachments FOR SELECT
    USING (app.can_see_task(task_id, app.current_user_id()));

CREATE POLICY attachments_insert ON app.attachments FOR INSERT
    WITH CHECK (
        app.can_contribute_task(task_id, app.current_user_id())
        AND author_id = app.current_user_id()
    );

CREATE POLICY attachments_update ON app.attachments FOR UPDATE
    USING (
        author_id = app.current_user_id()
        AND created_at > now() - interval '1 hour'
    )
    WITH CHECK (
        author_id = app.current_user_id()
        AND created_at > now() - interval '1 hour'
    );

CREATE POLICY attachments_delete ON app.attachments FOR DELETE
    USING (
        (author_id = app.current_user_id() AND created_at > now() - interval '1 hour')
        OR app.can_edit_task(task_id, app.current_user_id())
    );

-- ---------------------------------------------------------- activity
-- Журнал должен оставаться журналом: правок и удалений нет ни у кого.
CREATE POLICY activity_select ON app.activity FOR SELECT
    USING (app.can_see_task(task_id, app.current_user_id()));

CREATE POLICY activity_insert ON app.activity FOR INSERT
    WITH CHECK (
        app.can_contribute_task(task_id, app.current_user_id())
        AND actor_id = app.current_user_id()
    );

-- ----------------------------------------------------- notifications
CREATE POLICY notifications_own ON app.notifications FOR SELECT
    USING (user_id = app.current_user_id());

CREATE POLICY notifications_update ON app.notifications FOR UPDATE
    USING (user_id = app.current_user_id())
    WITH CHECK (user_id = app.current_user_id());

CREATE POLICY notifications_delete ON app.notifications FOR DELETE
    USING (user_id = app.current_user_id());

-- =====================================================================
-- 5. Привилегии рабочей роли
-- =====================================================================

GRANT USAGE ON SCHEMA app TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO app_user;

-- Хеш пароля недоступен даже на чтение: только через app.authenticate.
REVOKE SELECT ON app.users FROM app_user;
GRANT SELECT (id, email, full_name, position, phone, avatar_color,
              role, is_active, deleted_at, created_at, updated_at)
    ON app.users TO app_user;
GRANT UPDATE (full_name, position, phone, avatar_color, password_hash,
              email, is_active, deleted_at, role)
    ON app.users TO app_user;

-- Уведомления вставляются только через app.notify.
REVOKE INSERT ON app.notifications FROM app_user;

-- Из task_assignees рабочая роль меняет только отметку о сдаче.
REVOKE UPDATE ON app.task_assignees FROM app_user;
GRANT UPDATE (completed_at) ON app.task_assignees TO app_user;

-- Связи не редактируются: только создаются и удаляются.
REVOKE UPDATE ON app.task_links FROM app_user;

GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO app_user;

ALTER DEFAULT PRIVILEGES IN SCHEMA app
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
