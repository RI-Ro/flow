-- =====================================================================
-- 0003_seed.sql — демонстрационные данные для разработки.
-- В production не применять. Пароль у всех: DemoPassword1!
-- =====================================================================

SET search_path = app, public;

-- pgcrypto (подключён в 0001_schema.sql) считает настоящий bcrypt прямо
-- в базе. \gset забирает результат запроса в переменную psql —
-- надёжнее, чем вписывать хеш-строку вручную, которую негде проверить
-- вычислением до реального запуска.
SELECT crypt('DemoPassword1!', gen_salt('bf', 12)) AS demo_hash \gset

INSERT INTO app.users (id, email, password_hash, full_name, position, phone, avatar_color, deleted_at)
VALUES
 ('11111111-1111-4111-8111-111111111111','anna@team.dev',   :'demo_hash','Анна Соколова',     'Продакт-менеджер',        '+7 900 100-10-01','#3D5A80', NULL),
 ('22222222-2222-4222-8222-222222222222','igor@team.dev',   :'demo_hash','Игорь Петров',      'Backend-разработчик',     '+7 900 100-10-02','#E8734A', NULL),
 ('33333333-3333-4333-8333-333333333333','maria@team.dev',  :'demo_hash','Мария Ким',         'Frontend-разработчик',    '+7 900 100-10-03','#6B9B54', NULL),
 ('44444444-4444-4444-8444-444444444444','dmitry@team.dev', :'demo_hash','Дмитрий Орлов',     'Backend-разработчик',     '+7 900 100-10-04','#8B6BB1', NULL),
 ('55555555-5555-4555-8555-555555555555','elena@team.dev',  :'demo_hash','Елена Волкова',     'Дизайнер интерфейсов',    '+7 900 100-10-05','#3D9B94', NULL),
 ('66666666-6666-4666-8666-666666666666','sergey@team.dev', :'demo_hash','Сергей Титов',      'Инженер по тестированию', '+7 900 100-10-06','#C25450', NULL),
 ('77777777-7777-4777-8777-777777777777','olga@team.dev',   :'demo_hash','Ольга Лебедева',    'Аналитик',                '+7 900 100-10-07','#A87C3D', now()),
 ('88888888-8888-4888-8888-888888888888','pavel@team.dev',  :'demo_hash','Павел Морозов',     'DevOps-инженер',          '+7 900 100-10-08','#4A6B8A', NULL),
 ('99999999-9999-4999-8999-999999999999','natalia@team.dev',:'demo_hash','Наталья Зимина',    'Арт-директор',            '+7 900 100-10-09','#3D5A80', NULL),
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','alexey@team.dev', :'demo_hash','Алексей Гончаров',  'Архитектор',              '+7 900 100-10-10','#E8734A', NULL)
ON CONFLICT (email) DO UPDATE SET
    -- Пароль обновляется и при повторном запуске: иначе на базе, где
    -- seed однажды отработал со старым фиктивным хешем, демо-учётки
    -- навсегда оставались бы с неподходящим паролем.
    password_hash = EXCLUDED.password_hash;

INSERT INTO app.team_members (owner_id, member_id)
SELECT '11111111-1111-4111-8111-111111111111', id FROM app.users
 WHERE email IN ('igor@team.dev','maria@team.dev','dmitry@team.dev','elena@team.dev',
                 'sergey@team.dev','pavel@team.dev','olga@team.dev')
ON CONFLICT DO NOTHING;

INSERT INTO app.boards (id, title, description, bg_preset, bg_blur, created_by) VALUES
 ('a0000000-0000-4000-8000-000000000001','Мобильное приложение','Запуск клиента для iOS и Android','dune',  true,  '11111111-1111-4111-8111-111111111111'),
 ('a0000000-0000-4000-8000-000000000002','Инфраструктура API',  'Платформа и сервисы',             'deep',  false, '22222222-2222-4222-8222-222222222222')
ON CONFLICT DO NOTHING;

INSERT INTO app.board_members (board_id, user_id, role) VALUES
 ('a0000000-0000-4000-8000-000000000001','33333333-3333-4333-8333-333333333333','editor'),
 ('a0000000-0000-4000-8000-000000000001','55555555-5555-4555-8555-555555555555','editor'),
 ('a0000000-0000-4000-8000-000000000001','66666666-6666-4666-8666-666666666666','reader'),
 ('a0000000-0000-4000-8000-000000000002','44444444-4444-4444-8444-444444444444','editor'),
 ('a0000000-0000-4000-8000-000000000002','88888888-8888-4888-8888-888888888888','editor'),
 ('a0000000-0000-4000-8000-000000000002','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','reader')
ON CONFLICT DO NOTHING;

INSERT INTO app.columns (board_id, title, color, position, wip_limit, is_done)
SELECT b.id, c.title, c.color, c.pos, c.wip, c.done
  FROM app.boards b
 CROSS JOIN (VALUES
    ('Бэклог',       '#8892A8', 0, 0, false),
    ('К выполнению', '#3D9B94', 1, 6, false),
    ('В работе',     '#C99A2E', 2, 4, false),
    ('На проверке',  '#8B6BB1', 3, 3, false),
    ('Готово',       '#4F9B6A', 4, 0, true)
 ) AS c(title, color, pos, wip, done)
 WHERE b.id IN ('a0000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000002')
   AND NOT EXISTS (SELECT 1 FROM app.columns x WHERE x.board_id = b.id);

INSERT INTO app.tasks (board_id, column_id, title, description, priority, due_date, position, tags, created_by)
SELECT b.id, c.id, t.title, t.descr, t.prio::app.task_priority,
       current_date + t.due, t.pos, t.tags, b.created_by
  FROM app.boards b
  CROSS JOIN (VALUES
   ('Спроектировать онбординг','Экраны первого запуска и приветственный тур','high',    3, 0, 0, ARRAY['интерфейс']),
   ('Дизайн карточки задачи',  'Компактный и развёрнутый вид карточки',      'medium',  5, 0, 1, ARRAY['дизайн']),
   ('Форма создания задачи',   'Валидация полей и быстрые действия',         'urgent', -2, 0, 2, ARRAY['интерфейс']),
   ('Тестирование перетаскивания','Проверка на сенсорных экранах',           'medium',  7, 1, 0, ARRAY['тесты']),
   ('Темизация интерфейса',    'Светлые и тёмные схемы оформления',          'low',    10, 1, 1, ARRAY['интерфейс']),
   ('Адаптив под планшеты',    'Раскладка от 768 до 1024 пикселей',          'medium',  4, 2, 0, ARRAY['интерфейс']),
   ('Экран пустого состояния', 'Что видит пользователь без задач',           'low',     9, 3, 0, ARRAY['дизайн']),
   ('Иконки для тегов',        'Набор пиктограмм для меток',                 'low',    -5, 4, 0, ARRAY['дизайн'])
 ) AS t(title, descr, prio, due, col, pos, tags)
  -- JOIN обязан идти ПОСЛЕ CROSS JOIN: ссылаться на псевдоним t в
  -- условии соединения раньше, чем он объявлен в FROM, нельзя —
  -- PostgreSQL отвечает "invalid reference to FROM-clause entry".
  JOIN app.columns c ON c.board_id = b.id AND c.position = t.col
 WHERE b.id = 'a0000000-0000-4000-8000-000000000001'
   AND NOT EXISTS (SELECT 1 FROM app.tasks x WHERE x.board_id = b.id);

INSERT INTO app.tasks (board_id, column_id, title, description, priority, due_date, position, tags, created_by)
SELECT b.id, c.id, t.title, t.descr, t.prio::app.task_priority,
       current_date + t.due, t.pos, t.tags, b.created_by
  FROM app.boards b
  CROSS JOIN (VALUES
   ('Настроить пайплайн сборки','Сборка, тесты и выкладка по коммиту','high',   2, 0, 0, ARRAY['инфраструктура']),
   ('Схема таблиц комментариев','Модель данных обсуждений',           'medium', 6, 0, 1, ARRAY['база']),
   ('Миграция базы данных',     'Переезд на новую схему без простоя', 'urgent', 1, 2, 0, ARRAY['база']),
   ('Оптимизация запросов',     'Профилирование медленных выборок',   'high',  -1, 2, 1, ARRAY['сервер']),
   ('Уведомления по почте',     'Отправка писем о событиях задач',    'medium', 8, 1, 0, ARRAY['сервер']),
   ('Ограничение частоты',      'Защита публичных ручек от перебора', 'high',   3, 3, 0, ARRAY['сервер']),
   ('Резервное копирование',    'Ежедневные копии и проверка',        'medium',12, 4, 0, ARRAY['инфраструктура'])
 ) AS t(title, descr, prio, due, col, pos, tags)
  -- JOIN обязан идти ПОСЛЕ CROSS JOIN: ссылаться на псевдоним t в
  -- условии соединения раньше, чем он объявлен в FROM, нельзя —
  -- PostgreSQL отвечает "invalid reference to FROM-clause entry".
  JOIN app.columns c ON c.board_id = b.id AND c.position = t.col
 WHERE b.id = 'a0000000-0000-4000-8000-000000000002'
   AND NOT EXISTS (SELECT 1 FROM app.tasks x WHERE x.board_id = b.id);

INSERT INTO app.task_assignees (task_id, user_id)
SELECT t.id, u.id FROM app.tasks t
  JOIN app.users u ON u.email IN ('maria@team.dev','elena@team.dev')
 WHERE t.board_id = 'a0000000-0000-4000-8000-000000000001'
ON CONFLICT DO NOTHING;

INSERT INTO app.task_assignees (task_id, user_id)
SELECT t.id, u.id FROM app.tasks t
  JOIN app.users u ON u.email IN ('dmitry@team.dev','pavel@team.dev')
 WHERE t.board_id = 'a0000000-0000-4000-8000-000000000002'
ON CONFLICT DO NOTHING;

INSERT INTO app.task_assignees (task_id, user_id)
SELECT t.id, '77777777-7777-4777-8777-777777777777' FROM app.tasks t
 WHERE t.title = 'Экран пустого состояния'
ON CONFLICT DO NOTHING;

INSERT INTO app.task_steps (task_id, body, done, position)
SELECT t.id, s.body, s.done, s.pos FROM app.tasks t
 CROSS JOIN (VALUES ('Согласовать требования', true, 0),
                    ('Реализовать', false, 1),
                    ('Показать команде', false, 2)) AS s(body, done, pos)
 WHERE t.title IN ('Спроектировать онбординг','Миграция базы данных');

INSERT INTO app.task_grants (task_id, user_id, access, granted_by)
SELECT t.id, '11111111-1111-4111-8111-111111111111', 'contribute',
       '22222222-2222-4222-8222-222222222222'
  FROM app.tasks t WHERE t.title = 'Схема таблиц комментариев'
ON CONFLICT DO NOTHING;

INSERT INTO app.task_grants (task_id, user_id, access, granted_by)
SELECT t.id, '11111111-1111-4111-8111-111111111111', 'read',
       '22222222-2222-4222-8222-222222222222'
  FROM app.tasks t WHERE t.title = 'Резервное копирование'
ON CONFLICT DO NOTHING;

INSERT INTO app.comments (task_id, author_id, body)
SELECT t.id, '33333333-3333-4333-8333-333333333333', 'Начала работу, синхронизируемся завтра.'
  FROM app.tasks t WHERE t.title = 'Спроектировать онбординг';

INSERT INTO app.activity (task_id, actor_id, body)
SELECT t.id, t.created_by, 'Задача создана' FROM app.tasks t;

INSERT INTO app.notifications (user_id, body, board_id, task_id, read_at)
SELECT '11111111-1111-4111-8111-111111111111',
       'Вам открыт доступ к задаче «' || t.title || '»',
       t.board_id, t.id,
       CASE WHEN random() > 0.6 THEN now() ELSE NULL END
  FROM app.tasks t LIMIT 15;
