package handlers

import (
	"context"
	"errors"
	"strings"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/example/kanban/internal/httpx"
	"github.com/example/kanban/internal/models"
)

// taskSelect — единая выборка задачи для всех обработчиков этого файла.
// created_by отдаётся всегда: на доске это неважно (там и так видно,
// кто исполнитель), а во «Входящих» это единственный способ понять, кто
// вообще поставил задачу в чужом проекте, не открывая карточку.
const taskSelect = `
	SELECT t.id, t.board_id, t.column_id, t.title, t.description, t.priority::text, t.color,
	       to_char(t.due_date, 'YYYY-MM-DD'), t.position, t.tags, t.completed_at, t.created_by,
	       COALESCE(app.task_access(t.id, $1), 'read'),
	       COALESCE(array_agg(DISTINCT a.user_id) FILTER (WHERE a.user_id IS NOT NULL), '{}'),
	       (SELECT count(*) FROM app.comments c    WHERE c.task_id = t.id),
	       (SELECT count(*) FROM app.attachments f WHERE f.task_id = t.id),
	       t.created_at, t.updated_at, b.title
	  FROM app.tasks t
	  JOIN app.boards b ON b.id = t.board_id
	  LEFT JOIN app.task_assignees a ON a.task_id = t.id`

func scanTasks(rows pgx.Rows) ([]models.Task, error) {
	out := []models.Task{}
	for rows.Next() {
		var t models.Task
		if err := rows.Scan(&t.ID, &t.BoardID, &t.ColumnID, &t.Title, &t.Description,
			&t.Priority, &t.Color, &t.DueDate, &t.Position, &t.Tags, &t.CompletedAt, &t.CreatedBy, &t.Access,
			&t.Assignees, &t.CommentCnt, &t.AttachCnt, &t.CreatedAt, &t.UpdatedAt,
			&t.BoardTitle); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// attachSteps и attachGrants подгружают вложенные коллекции одним
// запросом на всю выборку — иначе на доске из полусотни задач это было
// бы полсотни дополнительных обращений к базе на каждый рендер.
func attachSteps(ctx context.Context, tx pgx.Tx, tasks []models.Task) error {
	if len(tasks) == 0 {
		return nil
	}
	ids := make([]uuid.UUID, len(tasks))
	index := make(map[uuid.UUID]int, len(tasks))
	for i, t := range tasks {
		ids[i] = t.ID
		index[t.ID] = i
		tasks[i].Steps = []models.Step{}
		tasks[i].Grants = []models.Grant{}
	}

	rows, err := tx.Query(ctx, `
		SELECT task_id, id, body, done, position
		  FROM app.task_steps WHERE task_id = ANY($1) ORDER BY position`, ids)
	if err != nil {
		return err
	}
	for rows.Next() {
		var taskID uuid.UUID
		var st models.Step
		if err := rows.Scan(&taskID, &st.ID, &st.Body, &st.Done, &st.Position); err != nil {
			rows.Close()
			return err
		}
		if i, ok := index[taskID]; ok {
			tasks[i].Steps = append(tasks[i].Steps, st)
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}

	grantRows, err := tx.Query(ctx, `
		SELECT task_id, user_id, access::text
		  FROM app.task_grants WHERE task_id = ANY($1)`, ids)
	if err != nil {
		return err
	}
	defer grantRows.Close()
	for grantRows.Next() {
		var taskID uuid.UUID
		var g models.Grant
		if err := grantRows.Scan(&taskID, &g.UserID, &g.Access); err != nil {
			return err
		}
		if i, ok := index[taskID]; ok {
			tasks[i].Grants = append(tasks[i].Grants, g)
		}
	}
	return grantRows.Err()
}

func (s *Server) ListTasks(c *fiber.Ctx) error {
	boardID, err := param(c, "boardID")
	if err != nil {
		return httpx.Fail(c, err)
	}
	uid := s.uid(c)

	var tasks []models.Task
	err = s.db.AsUser(c.Context(), uid, func(tx pgx.Tx) error {
		rows, e := tx.Query(c.Context(), taskSelect+`
			 WHERE t.board_id = $2 AND NOT t.archived
			 GROUP BY t.id, b.title
			 ORDER BY t.position`, uid, boardID)
		if e != nil {
			return e
		}
		tasks, e = scanTasks(rows)
		rows.Close()
		if e != nil {
			return e
		}
		return attachSteps(c.Context(), tx, tasks)
	})
	if err != nil {
		return httpx.Fail(c, err)
	}
	return httpx.JSON(c, fiber.StatusOK, tasks)
}

// Inbox — задачи из чужих проектов, куда открыт точечный доступ или
// назначение. Условие «не участник доски» обязательно, иначе сюда
// попали бы и собственные задачи пользователя. Автор задачи (created_by
// в taskSelect) отдаётся вместе с остальным — фронт резолвит его через
// уже загруженный справочник и показывает на карточке.
func (s *Server) Inbox(c *fiber.Ctx) error {
	uid := s.uid(c)

	var tasks []models.Task
	err := s.db.AsUser(c.Context(), uid, func(tx pgx.Tx) error {
		rows, e := tx.Query(c.Context(), `
			SELECT t.id, t.board_id, t.column_id, t.title, t.description, t.priority::text, t.color,
			       to_char(t.due_date, 'YYYY-MM-DD'), t.position, t.tags, t.completed_at, t.created_by,
			       COALESCE(app.task_access(t.id, $1), 'read'),
			       COALESCE(array_agg(DISTINCT a.user_id) FILTER (WHERE a.user_id IS NOT NULL), '{}'),
			       (SELECT count(*) FROM app.comments c    WHERE c.task_id = t.id),
			       (SELECT count(*) FROM app.attachments f WHERE f.task_id = t.id),
			       t.created_at, t.updated_at, b.title
			  FROM app.tasks t
			  JOIN app.boards b ON b.id = t.board_id
			  LEFT JOIN app.task_assignees a ON a.task_id = t.id
			 WHERE app.board_role(t.board_id, $1) IS NULL
			   AND NOT t.archived
			 GROUP BY t.id, b.title
			 ORDER BY b.title, t.created_at DESC`, uid)
		if e != nil {
			return e
		}
		defer rows.Close()
		tasks = []models.Task{}
		for rows.Next() {
			var t models.Task
			if e := rows.Scan(&t.ID, &t.BoardID, &t.ColumnID, &t.Title, &t.Description,
				&t.Priority, &t.Color, &t.DueDate, &t.Position, &t.Tags, &t.CompletedAt, &t.CreatedBy, &t.Access,
				&t.Assignees, &t.CommentCnt, &t.AttachCnt, &t.CreatedAt, &t.UpdatedAt,
				&t.BoardTitle); e != nil {
				return e
			}
			tasks = append(tasks, t)
		}
		if e := rows.Err(); e != nil {
			return e
		}
		return attachSteps(c.Context(), tx, tasks)
	})
	if err != nil {
		return httpx.Fail(c, err)
	}
	return httpx.JSON(c, fiber.StatusOK, tasks)
}

func (s *Server) GetTask(c *fiber.Ctx) error {
	taskID, err := param(c, "taskID")
	if err != nil {
		return httpx.Fail(c, err)
	}
	t, err := s.loadTask(c, taskID)
	if errors.Is(err, pgx.ErrNoRows) {
		return httpx.Fail(c, httpx.ErrNotFound)
	}
	if err != nil {
		return httpx.Fail(c, err)
	}
	return httpx.JSON(c, fiber.StatusOK, t)
}

func (s *Server) loadTask(c *fiber.Ctx, taskID uuid.UUID) (models.Task, error) {
	uid := s.uid(c)
	var t models.Task

	err := s.db.AsUser(c.Context(), uid, func(tx pgx.Tx) error {
		rows, e := tx.Query(c.Context(), taskSelect+` WHERE t.id = $2 GROUP BY t.id, b.title, b.title`, uid, taskID)
		if e != nil {
			return e
		}
		tasks, e := scanTasks(rows)
		rows.Close()
		if e != nil {
			return e
		}
		if len(tasks) == 0 {
			return pgx.ErrNoRows
		}
		if e := attachSteps(c.Context(), tx, tasks); e != nil {
			return e
		}
		t = tasks[0]
		return nil
	})
	return t, err
}

// loadTasksByColumns — та же выборка, что и остальные, но по набору
// колонок сразу: используется после перемещения задачи, чтобы одним
// запросом получить актуальное состояние всех строк, чья позиция могла
// сдвинуться, и разослать их по WebSocket.
func (s *Server) loadTasksByColumns(c *fiber.Ctx, columnIDs []uuid.UUID) ([]models.Task, error) {
	uid := s.uid(c)
	var tasks []models.Task
	err := s.db.AsUser(c.Context(), uid, func(tx pgx.Tx) error {
		rows, e := tx.Query(c.Context(), taskSelect+`
			 WHERE t.column_id = ANY($2::uuid[])
			 GROUP BY t.id, b.title, b.title`, uid, columnIDs)
		if e != nil {
			return e
		}
		tasks, e = scanTasks(rows)
		rows.Close()
		if e != nil {
			return e
		}
		return attachSteps(c.Context(), tx, tasks)
	})
	return tasks, err
}

type taskInput struct {
	Title       string      `json:"title"`
	Description string      `json:"description"`
	Priority    string      `json:"priority"`
	Color       string      `json:"color"`
	ColumnID    uuid.UUID   `json:"columnId"`
	DueDate     *string     `json:"dueDate"`
	Tags        []string    `json:"tags"`
	Assignees   []uuid.UUID `json:"assignees"`
}

func (s *Server) CreateTask(c *fiber.Ctx) error {
	boardID, err := param(c, "boardID")
	if err != nil {
		return httpx.Fail(c, err)
	}
	var in taskInput
	if err := httpx.Decode(c, &in); err != nil {
		return httpx.Fail(c, err)
	}
	in.Title = strings.TrimSpace(in.Title)
	if in.Title == "" {
		return httpx.Fail(c, httpx.Err(fiber.StatusBadRequest, "empty_title", "Название задачи не может быть пустым"))
	}
	if in.Priority == "" {
		in.Priority = "medium"
	}
	if in.Color == "" {
		in.Color = "none"
	}
	if in.Tags == nil {
		in.Tags = []string{}
	}
	uid := s.uid(c)

	// Идентификатор задаём сами, а не получаем через RETURNING.
	//
	// Причина: политика tasks_select проверяет видимость через
	// app.can_see_task(), а та повторно читает app.tasks по этому же
	// идентификатору. При INSERT ... RETURNING проверка SELECT-политики
	// выполняется в рамках той же команды, и функция, объявленная
	// STABLE, работает со снимком, где вставляемой строки ещё нет, —
	// политика отвечает «не видно», и вся вставка отвергается как
	// отказ доступа. Владелец проекта при этом получал «Недостаточно
	// прав» на создание собственной задачи.
	//
	// Без RETURNING SELECT-политика не задействуется вообще, а
	// WITH CHECK политики tasks_insert проверяется по значениям новой
	// строки напрямую и отрабатывает как задумано.
	taskID := uuid.New()
	var pending []pendingNotif
	err = s.db.AsUser(c.Context(), uid, func(tx pgx.Tx) error {
		if _, e := tx.Exec(c.Context(), `
			INSERT INTO app.tasks (id, board_id, column_id, title, description, priority, color,
			                       due_date, tags, position, created_by)
			VALUES ($1, $2, $3, $4, $5, $6::app.task_priority, $7, $8::date, $9,
			        COALESCE((SELECT max(position) + 1 FROM app.tasks WHERE column_id = $3), 0), $10)`,
			taskID, boardID, in.ColumnID, in.Title, in.Description, in.Priority, in.Color,
			in.DueDate, in.Tags, uid); e != nil {
			return e
		}
		var e error
		pending, e = s.replaceAssignees(c.Context(), tx, taskID, in.Assignees, uid, boardID)
		if e != nil {
			return e
		}
		_, e = tx.Exec(c.Context(),
			`INSERT INTO app.activity (task_id, actor_id, body) VALUES ($1, $2, 'Задача создана')`,
			taskID, uid)
		return e
	})
	if err != nil {
		return httpx.Fail(c, err)
	}
	s.flushNotifs(pending)

	t, err := s.loadTask(c, taskID)
	if err != nil {
		return httpx.Fail(c, err)
	}
	go s.publishTask(t, "created")
	return httpx.JSON(c, fiber.StatusCreated, t)
}

func (s *Server) replaceAssignees(ctx context.Context, tx pgx.Tx, taskID uuid.UUID,
	assignees []uuid.UUID, actor, boardID uuid.UUID) ([]pendingNotif, error) {

	if _, err := tx.Exec(ctx, `DELETE FROM app.task_assignees WHERE task_id = $1`, taskID); err != nil {
		return nil, err
	}
	var pending []pendingNotif
	for _, a := range assignees {
		if _, err := tx.Exec(ctx, `
			INSERT INTO app.task_assignees (task_id, user_id) VALUES ($1, $2)
			ON CONFLICT DO NOTHING`, taskID, a); err != nil {
			return nil, err
		}
		if a != actor {
			n, err := notifyInsert(ctx, tx, a, "Вам назначена задача", &boardID, &taskID)
			if err != nil {
				return nil, err
			}
			pending = append(pending, pendingNotif{UserID: a, Notif: n})
		}
	}
	return pending, nil
}

type taskPatch struct {
	Title       *string      `json:"title"`
	Description *string      `json:"description"`
	Priority    *string      `json:"priority"`
	Color       *string      `json:"color"`
	ColumnID    *uuid.UUID   `json:"columnId"`
	DueDate     *string      `json:"dueDate"`
	Tags        *[]string    `json:"tags"`
	Assignees   *[]uuid.UUID `json:"assignees"`
}

func (s *Server) UpdateTask(c *fiber.Ctx) error {
	taskID, err := param(c, "taskID")
	if err != nil {
		return httpx.Fail(c, err)
	}
	var in taskPatch
	if err := httpx.Decode(c, &in); err != nil {
		return httpx.Fail(c, err)
	}
	uid := s.uid(c)

	var pending []pendingNotif
	err = s.db.AsUser(c.Context(), uid, func(tx pgx.Tx) error {
		var boardID uuid.UUID
		tag, e := tx.Exec(c.Context(), `
			UPDATE app.tasks SET
				title       = COALESCE($2, title),
				description = COALESCE($3, description),
				priority    = COALESCE($4::app.task_priority, priority),
				color       = COALESCE($5, color),
				column_id   = COALESCE($6, column_id),
				due_date    = COALESCE($7::date, due_date),
				tags        = COALESCE($8, tags)
			WHERE id = $1`,
			taskID, in.Title, in.Description, in.Priority, in.Color, in.ColumnID, in.DueDate, in.Tags)
		if e != nil {
			return e
		}
		if tag.RowsAffected() == 0 {
			return httpx.ErrForbidden
		}

		if e := tx.QueryRow(c.Context(),
			`SELECT board_id FROM app.tasks WHERE id = $1`, taskID).Scan(&boardID); e != nil {
			return e
		}
		if in.Assignees != nil {
			pending, e = s.replaceAssignees(c.Context(), tx, taskID, *in.Assignees, uid, boardID)
			if e != nil {
				return e
			}
		}
		_, e = tx.Exec(c.Context(),
			`INSERT INTO app.activity (task_id, actor_id, body) VALUES ($1, $2, 'Задача отредактирована')`,
			taskID, uid)
		return e
	})
	if err != nil {
		return httpx.Fail(c, err)
	}
	s.flushNotifs(pending)

	t, err := s.loadTask(c, taskID)
	if err != nil {
		return httpx.Fail(c, err)
	}
	go s.publishTask(t, "updated")
	return httpx.JSON(c, fiber.StatusOK, t)
}

type moveInput struct {
	ColumnID uuid.UUID `json:"columnId"`
	Position int       `json:"position"`
}

// MoveTask сдвигает соседей и уплотняет нумерацию в обеих затронутых
// колонках в одной транзакции — при двух одновременных перетаскиваниях
// порядок иначе разъезжается. Перенос в колонку с флагом «завершения»
// сам проставляет completed_at и наоборот.
func (s *Server) MoveTask(c *fiber.Ctx) error {
	taskID, err := param(c, "taskID")
	if err != nil {
		return httpx.Fail(c, err)
	}
	var in moveInput
	if err := httpx.Decode(c, &in); err != nil {
		return httpx.Fail(c, err)
	}
	if in.Position < 0 {
		in.Position = 0
	}
	uid := s.uid(c)
	// Захватывается внутри транзакции ниже и используется после её
	// коммита — нужна, чтобы понять, чьи ещё позиции сдвинулись.
	var oldColumn uuid.UUID

	err = s.db.AsUser(c.Context(), uid, func(tx pgx.Tx) error {
		if e := tx.QueryRow(c.Context(),
			`SELECT column_id FROM app.tasks WHERE id = $1 FOR UPDATE`, taskID).Scan(&oldColumn); e != nil {
			return e
		}

		if _, e := tx.Exec(c.Context(), `
			UPDATE app.tasks SET position = position + 1
			 WHERE column_id = $1 AND position >= $2 AND id <> $3`,
			in.ColumnID, in.Position, taskID); e != nil {
			return e
		}

		tag, e := tx.Exec(c.Context(),
			`UPDATE app.tasks SET column_id = $2, position = $3 WHERE id = $1`,
			taskID, in.ColumnID, in.Position)
		if e != nil {
			return e
		}
		if tag.RowsAffected() == 0 {
			return httpx.ErrForbidden
		}

		if _, e := tx.Exec(c.Context(), `
			WITH ordered AS (
				SELECT id, row_number() OVER (PARTITION BY column_id ORDER BY position, updated_at) - 1 AS pos
				  FROM app.tasks WHERE column_id = ANY($1::uuid[]))
			UPDATE app.tasks t SET position = o.pos FROM ordered o
			 WHERE t.id = o.id AND t.position <> o.pos`,
			[]uuid.UUID{oldColumn, in.ColumnID}); e != nil {
			return e
		}

		if oldColumn != in.ColumnID {
			var colTitle string
			var isDone bool
			if e := tx.QueryRow(c.Context(),
				`SELECT title, is_done FROM app.columns WHERE id = $1`, in.ColumnID).
				Scan(&colTitle, &isDone); e != nil {
				return e
			}
			if _, e := tx.Exec(c.Context(),
				`UPDATE app.tasks SET completed_at = CASE WHEN $2 THEN now() ELSE NULL END WHERE id = $1`,
				taskID, isDone); e != nil {
				return e
			}
			if _, e := tx.Exec(c.Context(),
				`INSERT INTO app.activity (task_id, actor_id, body) VALUES ($1, $2, $3)`,
				taskID, uid, "Перемещена в «"+colTitle+"»"); e != nil {
				return e
			}
		}
		return nil
	})
	if err != nil {
		return httpx.Fail(c, err)
	}

	// Уплотнение нумерации выше сдвигает position не только у самой
	// перемещённой задачи, но и у всех её соседей в обеих колонках.
	// Разослать нужно каждую из них — иначе на экране других участников
	// (и в других открытых вкладках этого же пользователя) соседние
	// карточки останутся в старом порядке до следующей полной
	// перезагрузки доски, чего мы и добиваемся избежать.
	touched, err := s.loadTasksByColumns(c, []uuid.UUID{oldColumn, in.ColumnID})
	if err != nil {
		return httpx.Fail(c, err)
	}
	var moved models.Task
	for _, t := range touched {
		action := "updated"
		if t.ID == taskID {
			action = "moved"
			moved = t
		}
		go s.publishTask(t, action)
	}
	return httpx.JSON(c, fiber.StatusOK, moved)
}

type completeInput struct {
	Completed bool `json:"completed"`
}

func (s *Server) CompleteTask(c *fiber.Ctx) error {
	taskID, err := param(c, "taskID")
	if err != nil {
		return httpx.Fail(c, err)
	}
	var in completeInput
	if err := httpx.Decode(c, &in); err != nil {
		return httpx.Fail(c, err)
	}
	uid := s.uid(c)

	err = s.db.AsUser(c.Context(), uid, func(tx pgx.Tx) error {
		var boardID uuid.UUID
		if e := tx.QueryRow(c.Context(),
			`SELECT board_id FROM app.tasks WHERE id = $1`, taskID).Scan(&boardID); e != nil {
			return e
		}

		query := `SELECT id FROM app.columns WHERE board_id = $1 AND is_done ORDER BY position LIMIT 1`
		if !in.Completed {
			query = `SELECT id FROM app.columns WHERE board_id = $1 AND NOT is_done ORDER BY position LIMIT 1`
		}
		var targetCol *uuid.UUID
		var col uuid.UUID
		switch e := tx.QueryRow(c.Context(), query, boardID).Scan(&col); {
		case e == nil:
			targetCol = &col
		case errors.Is(e, pgx.ErrNoRows):
			targetCol = nil
		default:
			return e
		}

		tag, e := tx.Exec(c.Context(), `
			UPDATE app.tasks
			   SET completed_at = CASE WHEN $2 THEN now() ELSE NULL END,
			       column_id    = COALESCE($3, column_id)
			 WHERE id = $1`, taskID, in.Completed, targetCol)
		if e != nil {
			return e
		}
		if tag.RowsAffected() == 0 {
			return httpx.ErrForbidden
		}

		body := "Задача завершена"
		if !in.Completed {
			body = "Задача возвращена в работу"
		}
		_, e = tx.Exec(c.Context(),
			`INSERT INTO app.activity (task_id, actor_id, body) VALUES ($1, $2, $3)`, taskID, uid, body)
		return e
	})
	if err != nil {
		return httpx.Fail(c, err)
	}

	t, err := s.loadTask(c, taskID)
	if err != nil {
		return httpx.Fail(c, err)
	}
	go s.publishTask(t, "updated")
	return httpx.JSON(c, fiber.StatusOK, t)
}

func (s *Server) DeleteTask(c *fiber.Ctx) error {
	taskID, err := param(c, "taskID")
	if err != nil {
		return httpx.Fail(c, err)
	}
	uid := s.uid(c)

	var boardID uuid.UUID
	if e := s.db.AsUser(c.Context(), uid, func(tx pgx.Tx) error {
		return tx.QueryRow(c.Context(), `SELECT board_id FROM app.tasks WHERE id = $1`, taskID).Scan(&boardID)
	}); e != nil {
		return httpx.Fail(c, httpx.ErrNotFound)
	}

	// Список получателей снимаем ДО удаления. task_grants и
	// task_assignees связаны с задачей через ON DELETE CASCADE, то есть
	// исчезают вместе с ней, — а именно эти строки и делают человека
	// наблюдателем. Спросив список после удаления, мы получили бы одних
	// участников доски, и у того, кому была открыта только эта задача,
	// она продолжала бы висеть на экране до перезагрузки страницы.
	watchCtx, cancelWatch := bgContext()
	watchers := s.watchersOfTaskForBoard(watchCtx, boardID, taskID)
	cancelWatch()

	var affected int64
	err = s.db.AsUser(c.Context(), uid, func(tx pgx.Tx) error {
		tag, e := tx.Exec(c.Context(), `DELETE FROM app.tasks WHERE id = $1`, taskID)
		affected = tag.RowsAffected()
		return e
	})
	if err != nil {
		return httpx.Fail(c, err)
	}
	if affected == 0 {
		return httpx.Fail(c, httpx.ErrForbidden)
	}
	go s.publishTaskDeletedTo(watchers, boardID, taskID)
	return httpx.NoContent(c)
}

// ------------------------------------------------------------- чек-лист
//
// Отметка выполнения и правка текста шага разнесены по разным
// маршрутам (POST .../toggle и PATCH .../:stepID) сознательно: раньше
// оба действия шли одним обработчиком, различавшим их по тому, какие
// поля пришли в JSON. На практике это было источником путаницы —
// пустая строка «текст не менялся» и «текст стёрт» неотличимы без
// дополнительного признака, а вместе с обновлением done той же строкой
// клиенту приходилось всякий раз собирать частично заполненный объект.
// Раздельные эндпоинты убирают саму возможность такой ошибки: у каждого
// ровно одно однозначное тело запроса и своя проверка прав.

type stepInput struct {
	Body string `json:"body"`
}

func (s *Server) CreateStep(c *fiber.Ctx) error {
	taskID, err := param(c, "taskID")
	if err != nil {
		return httpx.Fail(c, err)
	}
	var in stepInput
	if err := httpx.Decode(c, &in); err != nil {
		return httpx.Fail(c, err)
	}
	body := strings.TrimSpace(in.Body)
	if body == "" {
		return httpx.Fail(c, httpx.Err(fiber.StatusBadRequest, "empty_step", "Текст шага не может быть пустым"))
	}

	var st models.Step
	err = s.db.AsUser(c.Context(), s.uid(c), func(tx pgx.Tx) error {
		return tx.QueryRow(c.Context(), `
			INSERT INTO app.task_steps (task_id, body, position)
			VALUES ($1, $2, COALESCE((SELECT max(position) + 1 FROM app.task_steps WHERE task_id = $1), 0))
			RETURNING id, body, done, position`,
			taskID, body).Scan(&st.ID, &st.Body, &st.Done, &st.Position)
	})
	if err != nil {
		return httpx.Fail(c, err)
	}
	go s.publishStep(taskID, st, "created")
	return httpx.JSON(c, fiber.StatusCreated, st)
}

// RenameStep переписывает текст шага. Доступно только редактору задачи —
// это не проверка RLS (политика task_steps_update пускает contribute),
// а бизнес-правило: содержание чек-листа задаёт постановщик, отмечать
// прогресс по нему может любой участник.
func (s *Server) RenameStep(c *fiber.Ctx) error {
	taskID, err := param(c, "taskID")
	if err != nil {
		return httpx.Fail(c, err)
	}
	stepID, err := param(c, "stepID")
	if err != nil {
		return httpx.Fail(c, err)
	}
	var in stepInput
	if err := httpx.Decode(c, &in); err != nil {
		return httpx.Fail(c, err)
	}
	body := strings.TrimSpace(in.Body)
	if body == "" {
		return httpx.Fail(c, httpx.Err(fiber.StatusBadRequest, "empty_step", "Текст шага не может быть пустым"))
	}
	uid := s.uid(c)

	var st models.Step
	err = s.db.AsUser(c.Context(), uid, func(tx pgx.Tx) error {
		var canEdit bool
		if e := tx.QueryRow(c.Context(),
			`SELECT app.can_edit_task($1, $2)`, taskID, uid).Scan(&canEdit); e != nil {
			return e
		}
		if !canEdit {
			return httpx.Err(fiber.StatusForbidden, "forbidden", "Изменить текст шага может только редактор задачи")
		}
		return tx.QueryRow(c.Context(), `
			UPDATE app.task_steps SET body = $3
			 WHERE id = $1 AND task_id = $2
			 RETURNING id, body, done, position`,
			stepID, taskID, body).Scan(&st.ID, &st.Body, &st.Done, &st.Position)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return httpx.Fail(c, httpx.ErrNotFound)
	}
	if err != nil {
		return httpx.Fail(c, err)
	}
	go s.publishStep(taskID, st, "updated")
	return httpx.JSON(c, fiber.StatusOK, st)
}

type toggleInput struct {
	Done bool `json:"done"`
}

// ToggleStep — единственное, что нужно фронту для клика по чекбоксу:
// одно поле, один смысл, доступно любому участнику с правом contribute
// (читатель доски, назначенный исполнитель, точечный грант «участие»).
func (s *Server) ToggleStep(c *fiber.Ctx) error {
	taskID, err := param(c, "taskID")
	if err != nil {
		return httpx.Fail(c, err)
	}
	stepID, err := param(c, "stepID")
	if err != nil {
		return httpx.Fail(c, err)
	}
	var in toggleInput
	if err := httpx.Decode(c, &in); err != nil {
		return httpx.Fail(c, err)
	}
	uid := s.uid(c)

	var st models.Step
	var watchers []uuid.UUID
	err = s.db.AsUser(c.Context(), uid, func(tx pgx.Tx) error {
		if e := tx.QueryRow(c.Context(), `
			UPDATE app.task_steps
			   SET done    = $3,
			       -- Приведение $4::uuid обязательно. Внутри CASE с
			       -- ветвью ELSE NULL PostgreSQL не может вывести тип
			       -- параметра и считает его text, после чего
			       -- присваивание в uuid-колонку падает с «column
			       -- done_by is of type uuid but expression is of type
			       -- text». Отметка в чек-листе из-за этого не работала.
			       done_by = CASE WHEN $3 THEN $4::uuid ELSE NULL END,
			       done_at = CASE WHEN $3 THEN now() ELSE NULL END
			 WHERE id = $1 AND task_id = $2
			 RETURNING id, body, done, position`,
			stepID, taskID, in.Done, uid).Scan(&st.ID, &st.Body, &st.Done, &st.Position); e != nil {
			return e
		}

		verb := "Отмечен пункт"
		if !in.Done {
			verb = "Снята отметка с пункта"
		}
		body := verb + " «" + st.Body + "»"
		if _, e := tx.Exec(c.Context(),
			`INSERT INTO app.activity (task_id, actor_id, body) VALUES ($1, $2, $3)`,
			taskID, uid, body); e != nil {
			return e
		}
		var e error
		watchers, e = s.notifyWatchers(c.Context(), tx, taskID, uid, body)
		return e
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return httpx.Fail(c, httpx.ErrNotFound)
	}
	if err != nil {
		return httpx.Fail(c, err)
	}
	go s.publishStep(taskID, st, "updated")
	go s.pingNotifications(watchers)
	return httpx.JSON(c, fiber.StatusOK, st)
}

func (s *Server) DeleteStep(c *fiber.Ctx) error {
	taskID, err := param(c, "taskID")
	if err != nil {
		return httpx.Fail(c, err)
	}
	stepID, err := param(c, "stepID")
	if err != nil {
		return httpx.Fail(c, err)
	}
	var affected int64
	err = s.db.AsUser(c.Context(), s.uid(c), func(tx pgx.Tx) error {
		tag, e := tx.Exec(c.Context(),
			`DELETE FROM app.task_steps WHERE id = $1 AND task_id = $2`, stepID, taskID)
		affected = tag.RowsAffected()
		return e
	})
	if err != nil {
		return httpx.Fail(c, err)
	}
	if affected == 0 {
		return httpx.Fail(c, httpx.ErrForbidden)
	}
	go s.publishStep(taskID, models.Step{ID: stepID}, "deleted")
	return httpx.NoContent(c)
}

// --------------------------------------------------------------- гранты

type grantInput struct {
	UserID uuid.UUID `json:"userId"`
	Access string    `json:"access"`
}

func (s *Server) SetGrants(c *fiber.Ctx) error {
	taskID, err := param(c, "taskID")
	if err != nil {
		return httpx.Fail(c, err)
	}
	var in []grantInput
	if err := httpx.Decode(c, &in); err != nil {
		return httpx.Fail(c, err)
	}
	uid := s.uid(c)

	var pending []pendingNotif
	var revoked []uuid.UUID
	var boardOfTask uuid.UUID
	err = s.db.AsUser(c.Context(), uid, func(tx pgx.Tx) error {
		var canEdit bool
		if e := tx.QueryRow(c.Context(),
			`SELECT app.can_edit_task($1, $2)`, taskID, uid).Scan(&canEdit); e != nil {
			return e
		}
		if !canEdit {
			return httpx.ErrForbidden
		}

		var boardID uuid.UUID
		if e := tx.QueryRow(c.Context(),
			`SELECT board_id FROM app.tasks WHERE id = $1`, taskID).Scan(&boardID); e != nil {
			return e
		}
		boardOfTask = boardID

		// Кому доступ был открыт до правки — чтобы отличить снятых от
		// оставшихся. Участники доски здесь не учитываются: у них доступ
		// к задаче идёт от членства в проекте, а не от гранта.
		beforeGrants := map[uuid.UUID]bool{}
		gr, e := tx.Query(c.Context(),
			`SELECT user_id FROM app.task_grants WHERE task_id = $1`, taskID)
		if e != nil {
			return e
		}
		for gr.Next() {
			var id uuid.UUID
			if e := gr.Scan(&id); e != nil {
				gr.Close()
				return e
			}
			beforeGrants[id] = true
		}
		gr.Close()
		if e := gr.Err(); e != nil {
			return e
		}

		staysGrant := map[uuid.UUID]bool{}
		for _, g := range in {
			if g.Access == "read" || g.Access == "contribute" {
				staysGrant[g.UserID] = true
			}
		}
		for id := range beforeGrants {
			if !staysGrant[id] {
				revoked = append(revoked, id)
			}
		}

		if _, e := tx.Exec(c.Context(), `DELETE FROM app.task_grants WHERE task_id = $1`, taskID); e != nil {
			return e
		}
		for _, g := range in {
			if g.Access != "read" && g.Access != "contribute" {
				continue
			}
			if _, e := tx.Exec(c.Context(), `
				INSERT INTO app.task_grants (task_id, user_id, access, granted_by)
				VALUES ($1, $2, $3::app.grant_access, $4)`, taskID, g.UserID, g.Access, uid); e != nil {
				return e
			}
			n, e := notifyInsert(c.Context(), tx, g.UserID, "Вам открыт доступ к задаче", &boardID, &taskID)
			if e != nil {
				return e
			}
			pending = append(pending, pendingNotif{UserID: g.UserID, Notif: n})
		}
		// Присваивание, а не объявление: e уже объявлена выше в этом
		// же блоке вместе с курсором по действующим грантам.
		_, e = tx.Exec(c.Context(),
			`INSERT INTO app.activity (task_id, actor_id, body) VALUES ($1, $2, 'Изменён доступ к задаче')`,
			taskID, uid)
		return e
	})
	if err != nil {
		return httpx.Fail(c, err)
	}
	s.flushNotifs(pending)
	// Тем, у кого грант отозвали, — адресное событие: обычная рассылка
	// их уже не застанет, потому что в число наблюдателей задачи они
	// после удаления гранта не входят.
	go s.publishTaskAccessRevoked(boardOfTask, taskID, revoked)

	t, err := s.loadTask(c, taskID)
	if err != nil {
		return httpx.Fail(c, err)
	}
	go s.publishTask(t, "updated")
	return httpx.JSON(c, fiber.StatusOK, t)
}
