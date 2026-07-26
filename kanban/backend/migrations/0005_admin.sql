-- =====================================================================
-- 0005_admin.sql — администрирование пользователей + правки прав и
-- производительности, найденные при аудите.
--
-- Применять после 0004_fix_auth.sql. Идемпотентна: можно выполнять
-- повторно.
-- =====================================================================

SET search_path = app, public;

-- Сообщения уровня NOTICE подавляются: DROP ... IF EXISTS и подобные
-- конструкции штатно печатают «... does not exist, skipping», и в выводе
-- psql это неотличимо от настоящей ошибки. Всё, что действительно
-- требует внимания (WARNING и ERROR), по-прежнему видно.
SET client_min_messages = warning;


-- Триграммы нужны для быстрого поиска по справочнику (см. индексы ниже).
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- =====================================================================
-- 1. Роль пользователя в системе
--    Это НЕ роль на доске (owner/editor/reader из board_role) — та
--    описывает права внутри одного проекта. Здесь речь о праве
--    администрировать учётные записи целиком.
-- =====================================================================

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'system_role') THEN
        CREATE TYPE app.system_role AS ENUM ('member', 'admin');
    END IF;
END $$;

ALTER TABLE app.users
    ADD COLUMN IF NOT EXISTS role app.system_role NOT NULL DEFAULT 'member';

-- Частичный индекс: администраторов единицы, а проверка «есть ли вообще
-- хоть один админ» выполняется при каждом снятии прав.
CREATE INDEX IF NOT EXISTS users_admin_idx ON app.users (id)
    WHERE role = 'admin' AND deleted_at IS NULL;

-- =====================================================================
-- 2. Проверка прав администратора
--    SECURITY DEFINER — иначе политики на app.users, ссылающиеся на саму
--    app.users, зацикливаются.
-- =====================================================================

CREATE OR REPLACE FUNCTION app.is_admin(p_user uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, public
AS $$
    SELECT EXISTS (
        SELECT 1 FROM app.users u
         WHERE u.id = p_user
           AND u.role = 'admin'
           AND u.deleted_at IS NULL
           AND u.is_active)
$$;

-- Сколько останется администраторов, если исключить указанного.
-- Нужна, чтобы не дать снять права у последнего админа и запереть
-- систему без возможности управления.
CREATE OR REPLACE FUNCTION app.other_admins_count(p_except uuid)
RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, public
AS $$
    SELECT count(*)::integer FROM app.users u
     WHERE u.role = 'admin' AND u.deleted_at IS NULL AND u.is_active
       AND u.id <> p_except
$$;

-- =====================================================================
-- 3. Политики RLS на app.users с учётом администратора
-- =====================================================================

-- INSERT: либо предаутентификационная регистрация (app.user_id ещё нет,
-- см. 0004_fix_auth.sql), либо действующий администратор создаёт учётную
-- запись из панели.
DROP POLICY IF EXISTS users_insert_public ON app.users;
DROP POLICY IF EXISTS users_insert ON app.users;
CREATE POLICY users_insert ON app.users FOR INSERT
    WITH CHECK (
        app.current_user_id() IS NULL
        OR app.is_admin(app.current_user_id())
    );

-- UPDATE: свой профиль либо любой профиль администратором.
DROP POLICY IF EXISTS users_update_self ON app.users;
DROP POLICY IF EXISTS users_update ON app.users;
CREATE POLICY users_update ON app.users FOR UPDATE
    USING (
        id = app.current_user_id()
        OR app.is_admin(app.current_user_id())
    )
    WITH CHECK (
        id = app.current_user_id()
        OR app.is_admin(app.current_user_id())
    );

-- Физического DELETE у пользователей нет намеренно: created_by в boards,
-- tasks, comments, attachments объявлены ON DELETE RESTRICT, и удаление
-- строки уничтожило бы историю или было бы просто отвергнуто базой.
-- Вместо этого «удаление» — это deleted_at + is_active = false, то есть
-- обычный UPDATE, покрытый политикой выше. Явной политики DELETE не
-- создаём: её отсутствие само запрещает операцию.

-- =====================================================================
-- 4. Привилегии на колонки
--    Ранее app_user мог менять только профильные поля, поэтому
--    администратор физически не мог ни деактивировать учётную запись,
--    ни сменить адрес, ни выдать права.
-- =====================================================================

GRANT UPDATE (full_name, position, phone, avatar_color, password_hash,
              email, is_active, deleted_at, role)
    ON app.users TO app_user;

-- role и is_active нужны на чтение, чтобы панель показывала состояние.
GRANT SELECT (id, email, full_name, position, phone, avatar_color,
              is_active, deleted_at, created_at, updated_at, role)
    ON app.users TO app_user;

-- =====================================================================
-- 5. Аутентификация с учётом блокировки
--    Прежняя версия возвращала is_active, но не смотрела на deleted_at:
--    «удалённый» администратором пользователь мог продолжать входить.
-- =====================================================================

-- ВАЖНО: именно DROP, а не CREATE OR REPLACE. Функция уже существует
-- с тремя колонками (0002_rls.sql), а здесь добавляется четвёртая —
-- role. Изменить набор возвращаемых колонок через CREATE OR REPLACE
-- PostgreSQL не позволяет: «cannot change return type of existing
-- function». Миграция обрывалась на этом месте, в базе оставалась
-- старая трёхколоночная версия, а код уже читал четыре значения — и
-- вход переставал работать вообще у всех.
DROP FUNCTION IF EXISTS app.authenticate(citext);
CREATE FUNCTION app.authenticate(p_email citext)
RETURNS TABLE (id uuid, password_hash text, is_active boolean, role text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, public
AS $$
    SELECT u.id, u.password_hash, u.is_active, u.role::text
      FROM app.users u
     WHERE u.email = p_email AND u.deleted_at IS NULL
$$;

-- Состояние учётной записи для проверки при обновлении токена.
-- Отдельная функция, а не SELECT из app.users в обработчике: обновление
-- токена выполняется до появления app.user_id, когда политика
-- users_select ещё не пропускает чтение.
CREATE OR REPLACE FUNCTION app.account_state(p_user uuid)
RETURNS TABLE (is_active boolean, deleted boolean, role text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, public
AS $$
    SELECT u.is_active, (u.deleted_at IS NOT NULL), u.role::text
      FROM app.users u WHERE u.id = p_user
$$;

-- Погасить все сессии пользователя. Вызывается при деактивации,
-- удалении и сбросе пароля администратором — иначе выданный ранее
-- refresh-токен продолжал бы работать месяц.
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

GRANT EXECUTE ON FUNCTION app.is_admin(uuid) TO app_user;
GRANT EXECUTE ON FUNCTION app.other_admins_count(uuid) TO app_user;
GRANT EXECUTE ON FUNCTION app.authenticate(citext) TO app_user;
GRANT EXECUTE ON FUNCTION app.account_state(uuid) TO app_user;
GRANT EXECUTE ON FUNCTION app.revoke_user_sessions(uuid) TO app_user;

-- =====================================================================
-- 6. Индексы, найденные при аудите производительности
-- =====================================================================

-- Directory() и панель администратора ищут по ФИО, должности и телефону
-- через ILIKE '%подстрока%'. B-tree такому запросу не помогает вообще —
-- нужен триграммный индекс, иначе каждый поиск это полный проход по
-- таблице пользователей.
CREATE INDEX IF NOT EXISTS users_search_trgm_idx ON app.users
    USING gin ((full_name || ' ' || position || ' ' || phone) gin_trgm_ops);

-- Сортировка справочника: активные сначала, внутри по алфавиту.
-- Прежний users_active_idx (deleted_at) WHERE deleted_at IS NULL для
-- ORDER BY бесполезен.
CREATE INDEX IF NOT EXISTS users_directory_sort_idx ON app.users
    ((deleted_at IS NOT NULL), full_name);

-- Чистка просроченных токенов и выборка активных сессий пользователя.
CREATE INDEX IF NOT EXISTS refresh_tokens_active_idx ON app.refresh_tokens (user_id)
    WHERE revoked_at IS NULL;

-- =====================================================================
-- 7. Первый администратор
--    Без этого после установки некому зайти в панель. Если админов ещё
--    нет — назначаем самую раннюю учётную запись.
-- =====================================================================

UPDATE app.users SET role = 'admin'
 WHERE id = (SELECT id FROM app.users
              WHERE deleted_at IS NULL ORDER BY created_at LIMIT 1)
   AND NOT EXISTS (SELECT 1 FROM app.users WHERE role = 'admin' AND deleted_at IS NULL);

-- =====================================================================
-- 8. Пароль демо-учётных записей
--    Дублирует 0004 намеренно: если тот прервался на ошибке политики,
--    пароль так и остался неверным. Здесь он выставляется гарантированно
--    и только для демо-доменa — на реальные учётные записи не влияет.
-- =====================================================================
UPDATE app.users
   SET password_hash = crypt('DemoPassword1!', gen_salt('bf', 12))
 WHERE email LIKE '%@team.dev';
