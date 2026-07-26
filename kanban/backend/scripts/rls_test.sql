-- =====================================================================
-- rls_test.sql — проверка политик доступа и наблюдателей WebSocket.
--
-- Запускать РОЛЬЮ app_user (не владельцем и не суперпользователем):
--   psql "postgres://app_user:...@localhost/kanban" -f scripts/rls_test.sql
--
-- Всё в транзакции, которая откатывается — данные не меняются.
-- =====================================================================

\set ON_ERROR_STOP on
BEGIN;
SET search_path = app, public;

DO $$
BEGIN
    IF current_setting('is_superuser') = 'on' THEN
        RAISE EXCEPTION 'Тест запущен суперпользователем — RLS не применяется';
    END IF;
    IF (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) THEN
        RAISE EXCEPTION 'У роли % есть BYPASSRLS — политики не проверяются', current_user;
    END IF;
END $$;

\echo '--- 1. Без app.user_id не видно ничего ---'
SELECT set_config('app.user_id', '', true);
DO $$
DECLARE n int;
BEGIN
    SELECT count(*) INTO n FROM app.boards;
    IF n <> 0 THEN RAISE EXCEPTION 'Анонимный запрос увидел % досок', n; END IF;
    SELECT count(*) INTO n FROM app.tasks;
    IF n <> 0 THEN RAISE EXCEPTION 'Анонимный запрос увидел % задач', n; END IF;
END $$;
\echo '    ок'

\echo '--- 2. Участник видит свой проект и не видит чужой ---'
SELECT set_config('app.user_id', '11111111-1111-4111-8111-111111111111', true);
DO $$
DECLARE n int;
BEGIN
    SELECT count(*) INTO n FROM app.columns WHERE board_id = 'a0000000-0000-4000-8000-000000000001';
    IF n = 0 THEN RAISE EXCEPTION 'Владелец не видит колонки собственного проекта'; END IF;

    SELECT count(*) INTO n FROM app.columns WHERE board_id = 'a0000000-0000-4000-8000-000000000002';
    IF n <> 0 THEN RAISE EXCEPTION 'Видны % колонок чужого проекта', n; END IF;

    SELECT count(*) INTO n FROM app.board_members WHERE board_id = 'a0000000-0000-4000-8000-000000000002';
    IF n <> 0 THEN RAISE EXCEPTION 'Виден состав участников чужого проекта'; END IF;
END $$;
\echo '    ок'

\echo '--- 3. Точечный грант открывает ровно нужные задачи ---'
DO $$
DECLARE granted int;
BEGIN
    SELECT count(*) INTO granted FROM app.tasks WHERE board_id = 'a0000000-0000-4000-8000-000000000002';
    IF granted = 0 THEN RAISE EXCEPTION 'Гранты не работают: ни одной чужой задачи не видно'; END IF;
    IF granted > 2 THEN RAISE EXCEPTION 'Грант протёк: видно % задач вместо 2', granted; END IF;
END $$;
\echo '    ок'

\echo '--- 4. Уровни доступа различаются ---'
DO $$
DECLARE lvl text;
BEGIN
    SELECT app.task_access(t.id, '11111111-1111-4111-8111-111111111111')
      INTO lvl FROM app.tasks t WHERE t.title = 'Резервное копирование';
    IF lvl <> 'read' THEN RAISE EXCEPTION 'Грант «просмотр» дал уровень %', lvl; END IF;

    SELECT app.task_access(t.id, '11111111-1111-4111-8111-111111111111')
      INTO lvl FROM app.tasks t WHERE t.title = 'Схема таблиц комментариев';
    IF lvl <> 'contribute' THEN RAISE EXCEPTION 'Грант «участие» дал уровень %', lvl; END IF;
END $$;
\echo '    ок'

\echo '--- 5. Читатель доски не может править задачи, но может комментировать и отмечать шаги ---'
SELECT set_config('app.user_id', '66666666-6666-4666-8666-666666666666', true);
DO $$
DECLARE affected int; task_id uuid; step_id uuid;
BEGIN
    SELECT id INTO task_id FROM app.tasks WHERE board_id = 'a0000000-0000-4000-8000-000000000001' LIMIT 1;
    IF task_id IS NULL THEN RAISE EXCEPTION 'Читатель не видит задачи доски, хотя должен'; END IF;

    UPDATE app.tasks SET title = 'Взлом' WHERE id = task_id;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 0 THEN RAISE EXCEPTION 'Читатель изменил задачу — tasks_update дырявая'; END IF;

    DELETE FROM app.tasks WHERE id = task_id;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 0 THEN RAISE EXCEPTION 'Читатель удалил задачу — tasks_delete дырявая'; END IF;

    INSERT INTO app.comments (task_id, author_id, body)
    VALUES (task_id, '66666666-6666-4666-8666-666666666666', 'Проверка прав читателя');

    INSERT INTO app.task_steps (task_id, body) VALUES (task_id, 'Тестовый шаг')
    RETURNING id INTO step_id;
    UPDATE app.task_steps SET done = true, done_by = '66666666-6666-4666-8666-666666666666', done_at = now()
     WHERE id = step_id;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 1 THEN RAISE EXCEPTION 'Читатель не может отметить шаг чек-листа — task_steps_update дырявая'; END IF;
END $$;
\echo '    ок'

\echo '--- 6. Нельзя писать от чужого имени ---'
DO $$
DECLARE task_id uuid;
BEGIN
    SELECT id INTO task_id FROM app.tasks LIMIT 1;
    BEGIN
        INSERT INTO app.comments (task_id, author_id, body)
        VALUES (task_id, '11111111-1111-4111-8111-111111111111', 'Подделка авторства');
        RAISE EXCEPTION 'Удалось подписать комментарий чужим именем';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
END $$;
\echo '    ок'

\echo '--- 7. Чужие уведомления недоступны ---'
DO $$
DECLARE n int;
BEGIN
    SELECT count(*) INTO n FROM app.notifications WHERE user_id <> '66666666-6666-4666-8666-666666666666';
    IF n <> 0 THEN RAISE EXCEPTION 'Видно % чужих уведомлений', n; END IF;
END $$;
\echo '    ок'

\echo '--- 8. Хеш пароля недоступен на чтение ---'
DO $$
BEGIN
    BEGIN
        PERFORM password_hash FROM app.users LIMIT 1;
        RAISE EXCEPTION 'Хеш пароля читается напрямую';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
END $$;
\echo '    ок'

\echo '--- 9. Наблюдатели WebSocket совпадают с составом участников ---'
SELECT set_config('app.user_id', '11111111-1111-4111-8111-111111111111', true);
DO $$
DECLARE watchers int; members int;
BEGIN
    SELECT count(*) INTO watchers FROM app.board_watchers('a0000000-0000-4000-8000-000000000001');
    SELECT count(*) INTO members FROM app.board_members WHERE board_id = 'a0000000-0000-4000-8000-000000000001';
    IF watchers <> members THEN
        RAISE EXCEPTION 'board_watchers вернул % вместо % участников', watchers, members;
    END IF;
END $$;
\echo '    ок'

ROLLBACK;
\echo ''
\echo 'Все проверки пройдены.'
