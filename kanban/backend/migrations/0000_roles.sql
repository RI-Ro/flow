-- =====================================================================
-- 0000_roles.sql — роли базы. Выполняется суперпользователем один раз
-- при разворачивании кластера.
-- =====================================================================

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_owner') THEN
        CREATE ROLE app_owner LOGIN PASSWORD 'change_me_owner';
    END IF;
END $$;

-- Рабочая роль приложения. Без BYPASSRLS и без SUPERUSER — это
-- принципиально: любая политика ниже — украшение, если роль может её
-- обойти. CONNECTION LIMIT задаёт верхнюю границу на случай утечки
-- соединений в приложении — пул на стороне Go настраивается отдельно
-- (см. DB_POOL_SIZE в .env), но полезно иметь страховку и на стороне БД.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
        CREATE ROLE app_user LOGIN PASSWORD 'change_me_user' CONNECTION LIMIT 100;
    END IF;
END $$;

ALTER ROLE app_owner NOBYPASSRLS;
ALTER ROLE app_user  NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE;

-- Публичная схема закрыта: приложение работает только со схемой app.
REVOKE ALL ON SCHEMA public FROM PUBLIC;

-- Подключение к целевой базе нужно выдать явно после её создания:
--   GRANT CONNECT ON DATABASE kanban TO app_user, app_owner;
