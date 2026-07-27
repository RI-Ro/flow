-- =====================================================================
-- 0008_assignee_done.sql — отметка исполнителя о выполнении.
--
-- Отличается от completed_at у самой задачи: там решение автора или
-- редактора «задача закрыта», здесь — сообщение конкретного
-- исполнителя «свою часть я сделал». На задаче с несколькими
-- исполнителями это разные вещи: один может закончить, а другой ещё
-- нет, и до отметки всех закрывать задачу рано.
--
-- Применять после 0007_activity_notify.sql. Идемпотентна.
-- =====================================================================

SET search_path = app, public;
SET client_min_messages = warning;

ALTER TABLE app.task_assignees
    ADD COLUMN IF NOT EXISTS completed_at timestamptz;

-- Выборка «кто из исполнителей уже отметился» идёт по каждой задаче
-- при каждой загрузке доски.
CREATE INDEX IF NOT EXISTS task_assignees_done_idx
    ON app.task_assignees (task_id) WHERE completed_at IS NOT NULL;

-- ---------------------------------------------------------------------
-- Право отметиться есть только у самого исполнителя.
--
-- Раньше на task_assignees были политики лишь для вставки и удаления —
-- изменять строки не мог никто, и UPDATE отвергался бы независимо от
-- прав. Новая политика намеренно узкая: строку правит тот, чей это
-- user_id, и только при условии, что задача ему доступна. Владелец
-- задачи отметиться за исполнителя не может — иначе отметка перестала
-- бы что-либо значить.
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS task_assignees_self_update ON app.task_assignees;
CREATE POLICY task_assignees_self_update ON app.task_assignees FOR UPDATE
    USING (
        user_id = app.current_user_id()
        AND app.can_see_task(task_id, app.current_user_id())
    )
    WITH CHECK (
        user_id = app.current_user_id()
        AND app.can_see_task(task_id, app.current_user_id())
    );

GRANT UPDATE (completed_at) ON app.task_assignees TO app_user;
