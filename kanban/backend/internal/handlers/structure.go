package handlers

import (
	"errors"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/example/kanban/internal/httpx"
	"github.com/example/kanban/internal/models"
)

// =====================================================================
// Делегирование на время отсутствия
// =====================================================================

// ListDelegations отдаёт обе стороны: кого я замещаю и кто замещает
// меня. Разделять на два маршрута незачем — на экране это один список.
func (s *Server) ListDelegations(c *fiber.Ctx) error {
	uid := s.uid(c)
	items := []models.Delegation{}

	err := s.db.AsUser(c.Context(), uid, func(tx pgx.Tx) error {
		rows, e := tx.Query(c.Context(), `
			SELECT id, grantor_id, deputy_id,
			       to_char(starts_at, 'YYYY-MM-DD'), to_char(ends_at, 'YYYY-MM-DD'),
			       note, (current_date BETWEEN starts_at AND ends_at)
			  FROM app.delegations
			 ORDER BY starts_at DESC`)
		if e != nil {
			return e
		}
		defer rows.Close()
		for rows.Next() {
			var d models.Delegation
			if e := rows.Scan(&d.ID, &d.GrantorID, &d.DeputyID,
				&d.StartsAt, &d.EndsAt, &d.Note, &d.Active); e != nil {
				return e
			}
			items = append(items, d)
		}
		return rows.Err()
	})
	if err != nil {
		return httpx.Fail(c, err)
	}
	return httpx.JSON(c, fiber.StatusOK, items)
}

type delegationInput struct {
	DeputyID uuid.UUID `json:"deputyId"`
	StartsAt string    `json:"startsAt"`
	EndsAt   string    `json:"endsAt"`
	Note     string    `json:"note"`
}

func (s *Server) CreateDelegation(c *fiber.Ctx) error {
	var in delegationInput
	if err := httpx.Decode(c, &in); err != nil {
		return httpx.Fail(c, err)
	}
	uid := s.uid(c)

	if in.DeputyID == uuid.Nil {
		return httpx.Fail(c, httpx.Err(fiber.StatusBadRequest, "no_deputy", "Выберите заместителя"))
	}
	if in.DeputyID == uid {
		return httpx.Fail(c, httpx.Err(fiber.StatusBadRequest, "self_deputy",
			"Нельзя назначить заместителем самого себя"))
	}
	start, err1 := time.Parse("2006-01-02", in.StartsAt)
	end, err2 := time.Parse("2006-01-02", in.EndsAt)
	if err1 != nil || err2 != nil {
		return httpx.Fail(c, httpx.Err(fiber.StatusBadRequest, "bad_dates", "Укажите период замещения"))
	}
	if end.Before(start) {
		return httpx.Fail(c, httpx.Err(fiber.StatusBadRequest, "bad_period",
			"Дата окончания раньше даты начала"))
	}

	var d models.Delegation
	err := s.db.AsUser(c.Context(), uid, func(tx pgx.Tx) error {
		// grantor_id = текущий пользователь проверяется и политикой
		// delegations_write: назначить себя чужим заместителем — это
		// присвоение прав, и запрещено оно в базе, а не только здесь.
		return tx.QueryRow(c.Context(), `
			INSERT INTO app.delegations (grantor_id, deputy_id, starts_at, ends_at, note)
			VALUES ($1, $2, $3::date, $4::date, $5)
			RETURNING id, grantor_id, deputy_id,
			          to_char(starts_at, 'YYYY-MM-DD'), to_char(ends_at, 'YYYY-MM-DD'),
			          note, (current_date BETWEEN starts_at AND ends_at)`,
			uid, in.DeputyID, in.StartsAt, in.EndsAt, strings.TrimSpace(in.Note)).
			Scan(&d.ID, &d.GrantorID, &d.DeputyID, &d.StartsAt, &d.EndsAt, &d.Note, &d.Active)
	})
	if err != nil {
		return httpx.Fail(c, err)
	}

	// Заместителю сообщаем сразу: иначе он узнает о новых обязанностях,
	// только случайно заглянув в чужой проект.
	_ = s.db.AsUser(c.Context(), uid, func(tx pgx.Tx) error {
		_, e := tx.Exec(c.Context(), `SELECT app.notify($1, $2, NULL, NULL)`,
			in.DeputyID, "Вам переданы права на время отсутствия коллеги")
		return e
	})
	go s.pingNotifications([]uuid.UUID{in.DeputyID})

	return httpx.JSON(c, fiber.StatusCreated, d)
}

func (s *Server) DeleteDelegation(c *fiber.Ctx) error {
	id, err := param(c, "id")
	if err != nil {
		return httpx.Fail(c, err)
	}
	var affected int64
	err = s.db.AsUser(c.Context(), s.uid(c), func(tx pgx.Tx) error {
		tag, e := tx.Exec(c.Context(), `DELETE FROM app.delegations WHERE id = $1`, id)
		affected = tag.RowsAffected()
		return e
	})
	if err != nil {
		return httpx.Fail(c, err)
	}
	if affected == 0 {
		return httpx.Fail(c, httpx.ErrForbidden)
	}
	return httpx.NoContent(c)
}

// =====================================================================
// Связи между задачами
// =====================================================================

func (s *Server) ListTaskLinks(c *fiber.Ctx) error {
	taskID, err := param(c, "taskID")
	if err != nil {
		return httpx.Fail(c, err)
	}
	items := []models.TaskLink{}

	err = s.db.AsUser(c.Context(), s.uid(c), func(tx pgx.Tx) error {
		// Обе стороны связи в одной выборке: «блокирует» и
		// «заблокирована» — одна и та же строка, читаемая с разных
		// концов, и человеку нужно видеть оба направления.
		rows, e := tx.Query(c.Context(), `
			SELECT l.id, l.from_task, l.to_task, l.kind::text,
			       t.title, (t.completed_at IS NOT NULL), t.board_id
			  FROM app.task_links l
			  JOIN app.tasks t ON t.id = CASE WHEN l.from_task = $1 THEN l.to_task ELSE l.from_task END
			 WHERE l.from_task = $1 OR l.to_task = $1
			 ORDER BY l.created_at`, taskID)
		if e != nil {
			return e
		}
		defer rows.Close()
		for rows.Next() {
			var l models.TaskLink
			if e := rows.Scan(&l.ID, &l.FromTask, &l.ToTask, &l.Kind,
				&l.Title, &l.Completed, &l.BoardID); e != nil {
				return e
			}
			items = append(items, l)
		}
		return rows.Err()
	})
	if err != nil {
		return httpx.Fail(c, err)
	}
	return httpx.JSON(c, fiber.StatusOK, items)
}

type taskLinkInput struct {
	ToTask uuid.UUID `json:"toTask"`
	Kind   string    `json:"kind"`
}

func (s *Server) CreateTaskLink(c *fiber.Ctx) error {
	taskID, err := param(c, "taskID")
	if err != nil {
		return httpx.Fail(c, err)
	}
	var in taskLinkInput
	if err := httpx.Decode(c, &in); err != nil {
		return httpx.Fail(c, err)
	}
	if in.Kind != "blocks" && in.Kind != "relates" && in.Kind != "subtask" {
		in.Kind = "relates"
	}
	if in.ToTask == taskID {
		return httpx.Fail(c, httpx.Err(fiber.StatusBadRequest, "self_link",
			"Задачу нельзя связать с самой собой"))
	}
	uid := s.uid(c)

	var l models.TaskLink
	err = s.db.AsUser(c.Context(), uid, func(tx pgx.Tx) error {
		if e := tx.QueryRow(c.Context(), `
			INSERT INTO app.task_links (from_task, to_task, kind, created_by)
			VALUES ($1, $2, $3::app.task_link_kind, $4)
			RETURNING id, from_task, to_task, kind::text`,
			taskID, in.ToTask, in.Kind, uid).
			Scan(&l.ID, &l.FromTask, &l.ToTask, &l.Kind); e != nil {
			return e
		}
		if e := tx.QueryRow(c.Context(),
			`SELECT title, (completed_at IS NOT NULL), board_id FROM app.tasks WHERE id = $1`,
			in.ToTask).Scan(&l.Title, &l.Completed, &l.BoardID); e != nil {
			return e
		}
		_, e := tx.Exec(c.Context(),
			`INSERT INTO app.activity (task_id, actor_id, body) VALUES ($1, $2, $3)`,
			taskID, uid, "Добавлена связь с задачей «"+l.Title+"»")
		return e
	})
	if err != nil {
		return httpx.Fail(c, err)
	}
	return httpx.JSON(c, fiber.StatusCreated, l)
}

func (s *Server) DeleteTaskLink(c *fiber.Ctx) error {
	id, err := param(c, "id")
	if err != nil {
		return httpx.Fail(c, err)
	}
	var affected int64
	err = s.db.AsUser(c.Context(), s.uid(c), func(tx pgx.Tx) error {
		tag, e := tx.Exec(c.Context(), `DELETE FROM app.task_links WHERE id = $1`, id)
		affected = tag.RowsAffected()
		return e
	})
	if err != nil {
		return httpx.Fail(c, err)
	}
	if affected == 0 {
		return httpx.Fail(c, httpx.ErrForbidden)
	}
	return httpx.NoContent(c)
}

// =====================================================================
// Шаблоны задач
// =====================================================================

func (s *Server) ListTemplates(c *fiber.Ctx) error {
	items := []models.TaskTemplate{}
	err := s.db.AsUser(c.Context(), s.uid(c), func(tx pgx.Tx) error {
		rows, e := tx.Query(c.Context(), `
			SELECT id, board_id, owner_id, name, title, description,
			       priority::text, color, tags, due_in_days, steps, assignees
			  FROM app.task_templates ORDER BY name`)
		if e != nil {
			return e
		}
		defer rows.Close()
		for rows.Next() {
			var t models.TaskTemplate
			if e := rows.Scan(&t.ID, &t.BoardID, &t.OwnerID, &t.Name, &t.Title, &t.Description,
				&t.Priority, &t.Color, &t.Tags, &t.DueInDays, &t.Steps, &t.Assignees); e != nil {
				return e
			}
			items = append(items, t)
		}
		return rows.Err()
	})
	if err != nil {
		return httpx.Fail(c, err)
	}
	return httpx.JSON(c, fiber.StatusOK, items)
}

type templateInput struct {
	BoardID     *uuid.UUID  `json:"boardId"`
	Name        string      `json:"name"`
	Title       string      `json:"title"`
	Description string      `json:"description"`
	Priority    string      `json:"priority"`
	Color       string      `json:"color"`
	Tags        []string    `json:"tags"`
	DueInDays   *int        `json:"dueInDays"`
	Steps       []string    `json:"steps"`
	Assignees   []uuid.UUID `json:"assignees"`
}

func (s *Server) CreateTemplate(c *fiber.Ctx) error {
	var in templateInput
	if err := httpx.Decode(c, &in); err != nil {
		return httpx.Fail(c, err)
	}
	in.Name = strings.TrimSpace(in.Name)
	if in.Name == "" {
		return httpx.Fail(c, httpx.Err(fiber.StatusBadRequest, "no_name", "Укажите название шаблона"))
	}
	if in.Priority == "" {
		in.Priority = "normal"
	}
	if in.Color == "" {
		in.Color = "none"
	}
	if in.Tags == nil {
		in.Tags = []string{}
	}
	if in.Steps == nil {
		in.Steps = []string{}
	}
	if in.Assignees == nil {
		in.Assignees = []uuid.UUID{}
	}
	uid := s.uid(c)

	var t models.TaskTemplate
	err := s.db.AsUser(c.Context(), uid, func(tx pgx.Tx) error {
		return tx.QueryRow(c.Context(), `
			INSERT INTO app.task_templates (board_id, owner_id, name, title, description,
			                                priority, color, tags, due_in_days, steps, assignees)
			VALUES ($1, $2, $3, $4, $5, $6::app.task_priority, $7, $8, $9, $10, $11)
			RETURNING id, board_id, owner_id, name, title, description,
			          priority::text, color, tags, due_in_days, steps, assignees`,
			in.BoardID, uid, in.Name, in.Title, in.Description, in.Priority, in.Color,
			in.Tags, in.DueInDays, in.Steps, in.Assignees).
			Scan(&t.ID, &t.BoardID, &t.OwnerID, &t.Name, &t.Title, &t.Description,
				&t.Priority, &t.Color, &t.Tags, &t.DueInDays, &t.Steps, &t.Assignees)
	})
	if err != nil {
		return httpx.Fail(c, err)
	}
	return httpx.JSON(c, fiber.StatusCreated, t)
}

func (s *Server) DeleteTemplate(c *fiber.Ctx) error {
	id, err := param(c, "id")
	if err != nil {
		return httpx.Fail(c, err)
	}
	var affected int64
	err = s.db.AsUser(c.Context(), s.uid(c), func(tx pgx.Tx) error {
		tag, e := tx.Exec(c.Context(), `DELETE FROM app.task_templates WHERE id = $1`, id)
		affected = tag.RowsAffected()
		return e
	})
	if err != nil {
		return httpx.Fail(c, err)
	}
	if affected == 0 {
		return httpx.Fail(c, httpx.ErrForbidden)
	}
	return httpx.NoContent(c)
}

type applyTemplateInput struct {
	BoardID  uuid.UUID `json:"boardId"`
	ColumnID uuid.UUID `json:"columnId"`
}

// ApplyTemplate создаёт задачу из шаблона вместе с чек-листом и
// исполнителями. Срок вычисляется от сегодняшнего дня по смещению —
// в шаблоне хранится «через сколько дней», а не конкретная дата.
func (s *Server) ApplyTemplate(c *fiber.Ctx) error {
	tplID, err := param(c, "id")
	if err != nil {
		return httpx.Fail(c, err)
	}
	var in applyTemplateInput
	if err := httpx.Decode(c, &in); err != nil {
		return httpx.Fail(c, err)
	}
	uid := s.uid(c)
	taskID := uuid.New()

	var pending []pendingNotif
	err = s.db.AsUser(c.Context(), uid, func(tx pgx.Tx) error {
		var t models.TaskTemplate
		if e := tx.QueryRow(c.Context(), `
			SELECT board_id, name, title, description, priority::text, color,
			       tags, due_in_days, steps, assignees
			  FROM app.task_templates WHERE id = $1`, tplID).
			Scan(&t.BoardID, &t.Name, &t.Title, &t.Description, &t.Priority, &t.Color,
				&t.Tags, &t.DueInDays, &t.Steps, &t.Assignees); e != nil {
			return e
		}

		title := t.Title
		if strings.TrimSpace(title) == "" {
			title = t.Name
		}

		if _, e := tx.Exec(c.Context(), `
			INSERT INTO app.tasks (id, board_id, column_id, title, description, priority, color,
			                       due_date, tags, position, created_by)
			VALUES ($1, $2, $3, $4, $5, $6::app.task_priority, $7,
			        CASE WHEN $8::int IS NULL THEN NULL ELSE current_date + $8::int END,
			        $9,
			        COALESCE((SELECT max(position) + 1 FROM app.tasks WHERE column_id = $3), 0), $10)`,
			taskID, in.BoardID, in.ColumnID, title, t.Description, t.Priority, t.Color,
			t.DueInDays, t.Tags, uid); e != nil {
			return e
		}

		for i, step := range t.Steps {
			if strings.TrimSpace(step) == "" {
				continue
			}
			if _, e := tx.Exec(c.Context(),
				`INSERT INTO app.task_steps (task_id, body, position) VALUES ($1, $2, $3)`,
				taskID, step, i); e != nil {
				return e
			}
		}

		var e error
		pending, e = s.replaceAssignees(c.Context(), tx, taskID, t.Assignees, uid, in.BoardID)
		if e != nil {
			return e
		}

		_, e = tx.Exec(c.Context(),
			`INSERT INTO app.activity (task_id, actor_id, body) VALUES ($1, $2, $3)`,
			taskID, uid, "Задача создана по шаблону «"+t.Name+"»")
		return e
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return httpx.Fail(c, httpx.ErrNotFound)
	}
	if err != nil {
		return httpx.Fail(c, err)
	}
	s.flushNotifs(pending)

	task, err := s.loadTask(c, taskID)
	if err != nil {
		return httpx.Fail(c, err)
	}
	go s.publishTask(task, "created")
	return httpx.JSON(c, fiber.StatusCreated, task)
}

// ActiveDelegations — действующие сейчас замещения по всем сотрудникам.
//
// Отдельно от ListDelegations: тот показывает только свои договорённости
// (кого я замещаю и кто меня), а этот нужен всем — увидев в задаче
// человека в отпуске, коллега должен понимать, к кому обращаться. Здесь
// нет ни истории, ни будущих периодов: только то, что действует
// сегодня, и без служебных подробностей.
func (s *Server) ActiveDelegations(c *fiber.Ctx) error {
	items := []models.Delegation{}
	err := s.db.AsUser(c.Context(), s.uid(c), func(tx pgx.Tx) error {
		// Читается через SECURITY DEFINER: политика delegations_select
		// намеренно узкая — показывать всем чужие будущие и прошедшие
		// замещения незачем, а действующие нужны.
		rows, e := tx.Query(c.Context(), `SELECT * FROM app.active_delegations()`)
		if e != nil {
			return e
		}
		defer rows.Close()
		for rows.Next() {
			var d models.Delegation
			if e := rows.Scan(&d.ID, &d.GrantorID, &d.DeputyID,
				&d.StartsAt, &d.EndsAt, &d.Note); e != nil {
				return e
			}
			d.Active = true
			items = append(items, d)
		}
		return rows.Err()
	})
	if err != nil {
		return httpx.Fail(c, err)
	}
	return httpx.JSON(c, fiber.StatusOK, items)
}
