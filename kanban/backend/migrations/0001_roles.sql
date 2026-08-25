-- =====================================================================
-- 0001_roles.sql — роли базы данных.
--
-- Выполняется суперпользователем ОДИН РАЗ на кластер:
--     sudo -u postgres psql -d kanban -f 0001_roles.sql
--
-- Роли общие для всех баз кластера, поэтому файл идемпотентен и его
-- безопасно применять повторно при разворачивании второй установки.
-- =====================================================================

-- Владелец схемы: ему принадлежат таблицы и SECURITY DEFINER функции.
-- Миграции выполняются от его имени либо от суперпользователя.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_owner') THEN
        CREATE ROLE app_owner LOGIN PASSWORD 'change_me_owner';
    END IF;
END $$;

-- Рабочая роль приложения.
--
-- Отсутствие BYPASSRLS и SUPERUSER здесь принципиально: всё
-- разграничение доступа держится на политиках RLS, а привилегированная
-- роль их полностью игнорирует. Подключившись такой ролью, приложение
-- продолжит работать, но каждый пользователь увидит задачи всех
-- проектов сразу. Приложение проверяет это при старте и откажется
-- запускаться — см. internal/database/db.go.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
        CREATE ROLE app_user LOGIN PASSWORD 'change_me_user';
    END IF;
END $$;

ALTER ROLE app_owner NOBYPASSRLS;
ALTER ROLE app_user  NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE;

-- Право подключаться к конкретной базе выдаётся отдельно: на момент
-- выполнения этого файла база может ещё не существовать.
--     GRANT CONNECT ON DATABASE kanban TO app_user, app_owner;

-- Схема public закрыта: приложение работает только со схемой app.
REVOKE ALL ON SCHEMA public FROM PUBLIC;
