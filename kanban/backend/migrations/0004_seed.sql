-- =====================================================================
-- 0004_seed.sql — демонстрационные данные.
--
-- В боевом контуре НЕ применять. Пароль всех учётных записей:
--     DemoPassword1!
--
-- Идемпотентна: повторный запуск обновляет пароли и не плодит дубли.
-- =====================================================================

SET search_path = app, public;
SET client_min_messages = warning;

-- Хеш считается через pgcrypto прямо в базе, а не вписывается строкой:
-- вручную вписанное значение негде проверить вычислением до реального
-- запуска, и оно однажды уже не совпало с заявленным паролем.
SELECT crypt('DemoPassword1!', gen_salt('bf', 12)) AS demo_hash \gset

INSERT INTO app.users (id, email, password_hash, full_name, position, phone, avatar_color, role, deleted_at)
VALUES
 ('11111111-1111-4111-8111-111111111111','anna@team.dev',   :'demo_hash','Анна Соколова',    'Продакт-менеджер',        '+7 900 100-10-01','#c8ff2d','admin',  NULL),
 ('22222222-2222-4222-8222-222222222222','igor@team.dev',   :'demo_hash','Игорь Петров',     'Backend-разработчик',     '+7 900 100-10-02','#7c5cff','member', NULL),
 ('33333333-3333-4333-8333-333333333333','maria@team.dev',  :'demo_hash','Мария Ким',        'Frontend-разработчик',    '+7 900 100-10-03','#4f8cff','member', NULL),
 ('44444444-4444-4444-8444-444444444444','dmitry@team.dev', :'demo_hash','Дмитрий Орлов',    'Backend-разработчик',     '+7 900 100-10-04','#38e8c8','member', NULL),
 ('55555555-5555-4555-8555-555555555555','elena@team.dev',  :'demo_hash','Елена Волкова',    'Дизайнер интерфейсов',    '+7 900 100-10-05','#f472b6','member', NULL),
 ('66666666-6666-4666-8666-666666666666','sergey@team.dev', :'demo_hash','Сергей Титов',     'Инженер по тестированию', '+7 900 100-10-06','#ff7849','member', NULL),
 ('77777777-7777-4777-8777-777777777777','olga@team.dev',   :'demo_hash','Ольга Лебедева',   'Аналитик',                '+7 900 100-10-07','#a78bfa','member', now()),
 ('88888888-8888-4888-8888-888888888888','pavel@team.dev',  :'demo_hash','Павел Морозов',    'DevOps-инженер',          '+7 900 100-10-08','#22d3ee','member', NULL),
 ('99999999-9999-4999-8999-999999999999','natalia@team.dev',:'demo_hash','Наталья Зимина',   'Арт-директор',            '+7 900 100-10-09','#ffd166','member', NULL),
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','alexey@team.dev', :'demo_hash','Алексей Гончаров', 'Архитектор',              '+7 900 100-10-10','#34d399','member', NULL),
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','irina@team.dev',  :'demo_hash','Ирина Белова',     'Инженер по тестированию', '+7 900 100-10-11','#fb7185','member', NULL),
 ('cccccccc-cccc-4ccc-8ccc-cccccccccccc','maxim@team.dev',  :'demo_hash','Максим Рудаков',   'Frontend-разработчик',    '+7 900 100-10-12','#6ee7b7','member', NULL),
 ('dddddddd-dddd-4ddd-8ddd-dddddddddddd','svetlana@team.dev',:'demo_hash','Светлана Егорова','Контент-менеджер',        '+7 900 100-10-13','#c8ff2d','member', NULL),
 ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','viktor@team.dev', :'demo_hash','Виктор Сомов',     'Руководитель направления','+7 900 100-10-14','#7c5cff','member', now()),
 ('ffffffff-ffff-4fff-8fff-ffffffffffff','yulia@team.dev',  :'demo_hash','Юлия Пахомова',    'Специалист поддержки',    '+7 900 100-10-15','#4f8cff','member', NULL),
 ('12121212-1212-4121-8121-121212121212','roman@team.dev',  :'demo_hash','Роман Кузьмин',    'Руководитель поддержки',  '+7 900 100-10-16','#38e8c8','member', NULL),
 ('13131313-1313-4131-8131-131313131313','daria@team.dev',  :'demo_hash','Дарья Никитина',   'Иллюстратор',             '+7 900 100-10-17','#f472b6','member', NULL),
 ('14141414-1414-4141-8141-141414141414','artem@team.dev',  :'demo_hash','Артём Савельев',   'Инженер данных',          '+7 900 100-10-18','#ff7849','member', NULL),
 ('15151515-1515-4151-8151-151515151515','ksenia@team.dev', :'demo_hash','Ксения Юдина',     'Аналитик',                '+7 900 100-10-19','#a78bfa','member', NULL),
 ('16161616-1616-4161-8161-161616161616','nikita@team.dev', :'demo_hash','Никита Фомин',     'Автоматизатор тестов',    '+7 900 100-10-20','#22d3ee','member', NULL)
ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash;

-- Личная команда Анны
INSERT INTO app.team_members (owner_id, member_id)
SELECT '11111111-1111-4111-8111-111111111111', id FROM app.users
 WHERE email IN ('igor@team.dev','maria@team.dev','dmitry@team.dev','elena@team.dev',
                 'sergey@team.dev','pavel@team.dev','olga@team.dev')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------
-- Проекты. Третий вложен во второй — чтобы дерево было видно сразу.
-- Владелец проставляется триггером boards_owner_bootstrap.
-- ---------------------------------------------------------------------
INSERT INTO app.boards (id, title, description, parent_id, position, bg_preset, bg_blur, created_by) VALUES
 ('a0000000-0000-4000-8000-000000000001','Мобильное приложение','Запуск клиента для iOS и Android',
  NULL, 0, 'img:gorod-spb', true,  '11111111-1111-4111-8111-111111111111'),
 ('a0000000-0000-4000-8000-000000000002','Инфраструктура API','Платформа и сервисы',
  NULL, 1, 'img:priroda-elbrus', false, '22222222-2222-4222-8222-222222222222'),
 ('a0000000-0000-4000-8000-000000000003','Миграция хранилища','Подпроект инфраструктуры',
  'a0000000-0000-4000-8000-000000000002', 0, 'deep', false, '22222222-2222-4222-8222-222222222222')
ON CONFLICT DO NOTHING;

INSERT INTO app.board_members (board_id, user_id, role) VALUES
 ('a0000000-0000-4000-8000-000000000001','33333333-3333-4333-8333-333333333333','editor'),
 ('a0000000-0000-4000-8000-000000000001','55555555-5555-4555-8555-555555555555','editor'),
 ('a0000000-0000-4000-8000-000000000001','66666666-6666-4666-8666-666666666666','reader'),
 ('a0000000-0000-4000-8000-000000000002','44444444-4444-4444-8444-444444444444','editor'),
 ('a0000000-0000-4000-8000-000000000002','88888888-8888-4888-8888-888888888888','editor'),
 ('a0000000-0000-4000-8000-000000000002','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','reader'),
 ('a0000000-0000-4000-8000-000000000003','88888888-8888-4888-8888-888888888888','editor')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------
-- Колонки: ровно пять, те же, что создаёт приложение для нового
-- проекта. Набор без англицизмов.
-- ---------------------------------------------------------------------
INSERT INTO app.columns (board_id, title, color, position, wip_limit, is_done)
SELECT b.id, c.title, c.color, c.pos, c.wip, c.done
  FROM app.boards b
 CROSS JOIN (VALUES
    ('К выполнению',    '#8892A8', 0, 0, false),
    ('В работе',        '#C99A2E', 1, 4, false),
    ('На согласовании', '#3D9B94', 2, 3, false),
    ('На докладе',      '#C2703D', 3, 2, false),
    ('Исполнено',       '#4F9B6A', 4, 0, true)
 ) AS c(title, color, pos, wip, done)
 WHERE NOT EXISTS (SELECT 1 FROM app.columns x WHERE x.board_id = b.id);

-- ---------------------------------------------------------------------
-- Задачи. CROSS JOIN обязан идти ДО JOIN: ссылаться на псевдоним t в
-- условии соединения раньше, чем он объявлен в FROM, нельзя.
-- ---------------------------------------------------------------------
INSERT INTO app.tasks (board_id, column_id, title, description, priority, color,
                       due_date, incoming_number, incoming_date, position, tags, created_by)
SELECT b.id, c.id, t.title, t.descr, t.prio::app.task_priority, t.colour,
       current_date + t.due, t.num,
       CASE WHEN t.num = '' THEN NULL ELSE current_date - 3 END,
       t.pos, t.tags, b.created_by
  FROM app.boards b
 CROSS JOIN (VALUES
   ('Спроектировать онбординг','Экраны первого запуска и приветственный тур','urgent',      'amber',   3, 0, 0, ARRAY['интерфейс'], '01-15/238'),
   ('Дизайн карточки задачи',  'Компактный и развёрнутый вид карточки',      'normal',      'none',    5, 0, 1, ARRAY['дизайн'],    ''),
   ('Форма создания задачи',   'Валидация полей и быстрые действия',         'very_urgent', 'crimson',-2, 1, 0, ARRAY['интерфейс'], '01-15/241'),
   ('Тестирование перетаскивания','Проверка на сенсорных экранах',           'prompt',      'sky',     7, 1, 1, ARRAY['тесты'],     ''),
   ('Темизация интерфейса',    'Светлые и тёмные схемы оформления',          'normal',      'violet', 10, 2, 0, ARRAY['интерфейс'], ''),
   ('Адаптив под планшеты',    'Раскладка от 768 до 1024 пикселей',          'dated',       'none',   17, 2, 1, ARRAY['интерфейс'], ''),
   ('Экран пустого состояния', 'Что видит пользователь без задач',           'normal',      'none',   23, 3, 0, ARRAY['дизайн'],    ''),
   ('Иконки для тегов',        'Набор пиктограмм для меток',                 'normal',      'teal',   -5, 4, 0, ARRAY['дизайн'],    '')
 ) AS t(title, descr, prio, colour, due, col, pos, tags, num)
  JOIN app.columns c ON c.board_id = b.id AND c.position = t.col
 WHERE b.id = 'a0000000-0000-4000-8000-000000000001'
   AND NOT EXISTS (SELECT 1 FROM app.tasks x WHERE x.board_id = b.id);

INSERT INTO app.tasks (board_id, column_id, title, description, priority, color,
                       due_date, incoming_number, incoming_date, position, tags, created_by)
SELECT b.id, c.id, t.title, t.descr, t.prio::app.task_priority, t.colour,
       current_date + t.due, t.num,
       CASE WHEN t.num = '' THEN NULL ELSE current_date - 5 END,
       t.pos, t.tags, b.created_by
  FROM app.boards b
 CROSS JOIN (VALUES
   ('Настроить пайплайн сборки','Сборка, тесты и выкладка по коммиту','urgent',      'orange',  2, 0, 0, ARRAY['инфраструктура'], '02-08/117'),
   ('Схема таблиц комментариев','Модель данных обсуждений',           'normal',      'none',    6, 0, 1, ARRAY['база'],           ''),
   ('Миграция базы данных',     'Переезд на новую схему без простоя', 'very_urgent', 'crimson', 1, 1, 0, ARRAY['база'],           '02-08/120'),
   ('Оптимизация запросов',     'Профилирование медленных выборок',   'prompt',      'amber',  -1, 1, 1, ARRAY['сервер'],         ''),
   ('Уведомления по почте',     'Отправка писем о событиях задач',    'normal',      'none',    8, 2, 0, ARRAY['сервер'],         ''),
   ('Ограничение частоты',      'Защита публичных ручек от перебора', 'dated',       'sky',    15, 3, 0, ARRAY['сервер'],         ''),
   ('Резервное копирование',    'Ежедневные копии и проверка',        'normal',      'emerald',26, 4, 0, ARRAY['инфраструктура'], '')
 ) AS t(title, descr, prio, colour, due, col, pos, tags, num)
  JOIN app.columns c ON c.board_id = b.id AND c.position = t.col
 WHERE b.id = 'a0000000-0000-4000-8000-000000000002'
   AND NOT EXISTS (SELECT 1 FROM app.tasks x WHERE x.board_id = b.id);

-- Исполнители
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

-- Задача с удалённым исполнителем: проверка отрисовки таких случаев.
INSERT INTO app.task_assignees (task_id, user_id)
SELECT t.id, '77777777-7777-4777-8777-777777777777' FROM app.tasks t
 WHERE t.title = 'Экран пустого состояния'
ON CONFLICT DO NOTHING;

-- Один исполнитель уже отметил свою часть выполненной.
UPDATE app.task_assignees SET completed_at = now() - interval '2 hours'
 WHERE task_id = (SELECT id FROM app.tasks WHERE title = 'Дизайн карточки задачи')
   AND user_id = '33333333-3333-4333-8333-333333333333';

-- Чек-листы
INSERT INTO app.task_steps (task_id, body, done, position)
SELECT t.id, s.body, s.done, s.pos FROM app.tasks t
 CROSS JOIN (VALUES ('Согласовать требования', true, 0),
                    ('Реализовать', false, 1),
                    ('Показать команде', false, 2)) AS s(body, done, pos)
 WHERE t.title IN ('Спроектировать онбординг','Миграция базы данных');

-- Точечные гранты: Анна не участник второго проекта, но две задачи ей
-- открыты — они появятся у неё во «Входящих».
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

-- Связь между задачами
INSERT INTO app.task_links (from_task, to_task, kind, created_by)
SELECT a.id, b.id, 'blocks', '22222222-2222-4222-8222-222222222222'
  FROM app.tasks a, app.tasks b
 WHERE a.title = 'Миграция базы данных' AND b.title = 'Оптимизация запросов'
ON CONFLICT DO NOTHING;

-- Шаблон задачи
INSERT INTO app.task_templates (board_id, owner_id, name, title, description,
                                priority, due_in_days, steps, assignees)
VALUES ('a0000000-0000-4000-8000-000000000002',
        '22222222-2222-4222-8222-222222222222',
        'Еженедельный отчёт', 'Отчёт за неделю',
        'Сводка по выполненным работам за прошедшую неделю',
        'dated', 7,
        ARRAY['Собрать данные','Согласовать с отделом','Отправить руководителю'],
        ARRAY['44444444-4444-4444-8444-444444444444']::uuid[])
ON CONFLICT DO NOTHING;

-- Замещение: Игорь замещает Анну две недели.
INSERT INTO app.delegations (grantor_id, deputy_id, starts_at, ends_at, note)
VALUES ('11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222',
        current_date - 2, current_date + 12, 'отпуск')
ON CONFLICT DO NOTHING;

-- Обсуждение и журнал
INSERT INTO app.comments (task_id, author_id, body)
SELECT t.id, '33333333-3333-4333-8333-333333333333', 'Начала работу, синхронизируемся завтра.'
  FROM app.tasks t WHERE t.title = 'Спроектировать онбординг';

INSERT INTO app.activity (task_id, actor_id, body)
SELECT t.id, t.created_by, 'Задача создана' FROM app.tasks t;

-- Уведомления Анне
INSERT INTO app.notifications (user_id, body, board_id, task_id, read_at)
SELECT '11111111-1111-4111-8111-111111111111',
       'Вам открыт доступ к задаче «' || t.title || '»',
       t.board_id, t.id,
       CASE WHEN random() > 0.6 THEN now() ELSE NULL END
  FROM app.tasks t LIMIT 12;
