-- =====================================================================
-- 0007_activity_notify.sql — уведомления всем, кто следит за задачей.
--
-- Раньше уведомление создавалось точечно: назначили исполнителя, выдали
-- грант, написали комментарий. Всё остальное — перемещение, правка,
-- отметки в чек-листе, файлы — проходило молча, и человек узнавал об
-- изменениях, только открыв задачу.
--
-- Применять после 0006_task_color.sql. Идемпотентна.
-- =====================================================================

SET search_path = app, public;
SET client_min_messages = warning;

-- Разослать уведомление всем наблюдателям задачи, кроме инициатора.
--
-- Список получателей берётся из той же app.task_watchers, что и
-- WebSocket-рассылка, — то есть уведомление приходит ровно тем, кому
-- задача доступна по правилам RLS, и никому больше. Дублировать эту
-- логику на стороне Go нельзя: разойдётся с политиками.
CREATE OR REPLACE FUNCTION app.notify_task_watchers(
    p_task uuid, p_actor uuid, p_body text)
RETURNS SETOF uuid
LANGUAGE sql SECURITY DEFINER SET search_path = app, public
AS $$
    INSERT INTO app.notifications (user_id, body, board_id, task_id)
    SELECT w.user_id, p_body, t.board_id, t.id
      FROM app.tasks t
      CROSS JOIN LATERAL app.task_watchers(t.id) AS w(user_id)
     WHERE t.id = p_task
       AND w.user_id <> p_actor
    RETURNING notifications.user_id
$$;

GRANT EXECUTE ON FUNCTION app.notify_task_watchers(uuid, uuid, text) TO app_user;

-- Уведомлений станет заметно больше, поэтому выборка непрочитанных
-- должна оставаться дешёвой при любом их количестве.
CREATE INDEX IF NOT EXISTS notifications_user_unread_idx
    ON app.notifications (user_id, created_at DESC)
    WHERE read_at IS NULL;
