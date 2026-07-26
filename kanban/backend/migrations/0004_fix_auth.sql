-- =====================================================================
-- 0004_fix_auth.sql — исправление входа и регистрации.
--
-- Файл переписан. Предыдущая версия была не только неидемпотентной, но
-- и разрушала политику users_insert из 0005_admin.sql: повторный запуск
-- 0004 после 0005 удалял админскую политику вставки, и администратор
-- терял возможность создавать учётные записи.
--
-- Теперь файл применяется в любом порядке и любое число раз, не трогает
-- объекты более поздних миграций и не падает, если pgcrypto или
-- демо-данные отсутствуют.
--
-- Причина исходного сбоя: RLS была включена на app.users и
-- app.refresh_tokens, но политики INSERT для app.users не существовало
-- вовсе, а политика на app.refresh_tokens требовала совпадения с
-- app.current_user_id(), который на этапе входа ещё не выставлен — это
-- и есть смысл процедуры входа. PostgreSQL запрещает операцию, для
-- которой нет ни одной подходящей политики.
-- =====================================================================

SET search_path = app, public;

-- Сообщения уровня NOTICE подавляются: DROP ... IF EXISTS и подобные
-- конструкции штатно печатают «... does not exist, skipping», и в выводе
-- psql это неотличимо от настоящей ошибки. Всё, что действительно
-- требует внимания (WARNING и ERROR), по-прежнему видно.
SET client_min_messages = warning;


-- ---------------------------------------------------------------------
-- Проверка прав ПЕРЕД любыми изменениями.
--
-- Создавать и удалять политики может только владелец таблицы. Если файл
-- запущен строкой подключения приложения (роль app_user из .env), каждый
-- CREATE/DROP POLICY отвечает «must be owner of table …», и понять по
-- этому сообщению, что дело в выборе роли, а не в самом SQL, трудно.
-- Поэтому останавливаемся сразу и говорим прямо.
--
-- Правильно:   psql "postgres://postgres@localhost/kanban" -f 0004_fix_auth.sql
-- Неправильно: psql "$DATABASE_URL" -f 0004_fix_auth.sql   (там app_user)
-- ---------------------------------------------------------------------
DO $$
DECLARE
    owner_name text;
BEGIN
    SELECT tableowner INTO owner_name
      FROM pg_tables WHERE schemaname = 'app' AND tablename = 'users';

    IF owner_name IS NULL THEN
        RAISE EXCEPTION 'Схема app не найдена. Сначала примените 0001_schema.sql и 0002_rls.sql.';
    END IF;

    IF NOT pg_has_role(current_user, owner_name, 'MEMBER') THEN
        RAISE EXCEPTION
            'Миграцию нужно запускать владельцем таблиц (%), а не ролью %. '
            'Строка подключения приложения из .env для миграций не подходит: '
            'у app_user намеренно нет прав менять политики доступа.',
            owner_name, current_user;
    END IF;
END $$;

-- --------------------------------------------------- app.users: INSERT
--
-- Создаётся только если политики вставки ещё нет. Если 0005 уже создал
-- свою, более полную (users_insert, где учтён администратор), — не
-- вмешиваемся.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
         WHERE schemaname = 'app' AND tablename = 'users'
           AND policyname IN ('users_insert', 'users_insert_public')
    ) THEN
        CREATE POLICY users_insert_public ON app.users FOR INSERT
            WITH CHECK (app.current_user_id() IS NULL);
    END IF;
END $$;

-- ------------------------------------------------- app.refresh_tokens
--
-- Вход, регистрация и обновление токена читают строку по хешу,
-- вставляют новую и гасят старую — всё до появления app.user_id.
-- Первое условие покрывает эти предаутентификационные операции, второе —
-- работу вошедшего пользователя со своими сессиями.
DROP POLICY IF EXISTS refresh_own ON app.refresh_tokens;
DROP POLICY IF EXISTS refresh_tokens_service_or_own ON app.refresh_tokens;

CREATE POLICY refresh_tokens_service_or_own ON app.refresh_tokens FOR ALL
    USING (app.current_user_id() IS NULL OR user_id = app.current_user_id())
    WITH CHECK (app.current_user_id() IS NULL OR user_id = app.current_user_id());

-- ---------------------------------------------------- пароль демо-учёток
--
-- Ранняя версия 0003_seed.sql содержала bcrypt-хеш, вписанный строкой и
-- не проверенный вычислением, — он не соответствовал DemoPassword1!.
-- Здесь он считается настоящим bcrypt прямо в базе.
--
-- Проверка наличия pgcrypto нужна, чтобы файл сообщал понятную причину,
-- а не обрывался на «function crypt(unknown, text) does not exist».
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgcrypto') THEN
        RAISE WARNING '0004: pgcrypto не установлено, пароли не обновлены. Выполните CREATE EXTENSION pgcrypto;';
        RETURN;
    END IF;

    UPDATE app.users
       SET password_hash = crypt('DemoPassword1!', gen_salt('bf', 12))
     WHERE email LIKE '%@team.dev';
END $$;
