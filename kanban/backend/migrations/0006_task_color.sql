-- =====================================================================
-- 0006_task_color.sql — цвет карточки задачи.
--
-- Цвет хранится идентификатором палитры ('none', 'amber', 'rose', …),
-- а не значением вроде '#FFAA00'. Причина: конкретные оттенки должны
-- различаться в светлых и тёмных темах, и если писать в базу готовый
-- цвет, при смене темы карточки станут нечитаемыми. Раскраску по
-- идентификатору делает фронтенд, зная текущую тему.
--
-- Применять после 0005_admin.sql. Идемпотентна.
-- =====================================================================

SET search_path = app, public;

-- Сообщения уровня NOTICE подавляются: DROP ... IF EXISTS и подобные
-- конструкции штатно печатают «... does not exist, skipping», и в выводе
-- psql это неотличимо от настоящей ошибки. Всё, что действительно
-- требует внимания (WARNING и ERROR), по-прежнему видно.
SET client_min_messages = warning;


ALTER TABLE app.tasks
    ADD COLUMN IF NOT EXISTS color text NOT NULL DEFAULT 'none';

-- Ограничение перечислением, а не ENUM: добавить оттенок в палитру
-- потом проще правкой CHECK, чем ALTER TYPE, который в транзакции
-- ведёт себя неудобно.
ALTER TABLE app.tasks DROP CONSTRAINT IF EXISTS tasks_color_check;
ALTER TABLE app.tasks ADD CONSTRAINT tasks_color_check CHECK (color IN (
    'none', 'amber', 'rose', 'violet', 'sky', 'emerald',
    'orange', 'slate', 'teal', 'crimson'
));

-- Отдельный индекс не нужен: фильтрация по цвету идёт по уже
-- выбранным задачам доски, отдельного запроса «все задачи такого-то
-- цвета» в приложении нет.

GRANT UPDATE (color) ON app.tasks TO app_user;
