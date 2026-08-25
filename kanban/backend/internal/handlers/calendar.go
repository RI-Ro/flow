package handlers

import (
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/example/kanban/internal/httpx"
)

// calendarTask — задача в календарном представлении.
//
// Отдаём только то, что рисуется в клетке дня: полная задача со
// списками шагов и грантов на месяц вперёд — это сотни лишних записей,
// которые всё равно не показываются, пока карточку не откроют.
type calendarTask struct {
	ID          uuid.UUID   `json:"id"`
	Title       string      `json:"title"`
	BoardID     uuid.UUID   `json:"boardId"`
	BoardTitle  string      `json:"boardTitle"`
	ColumnID    uuid.UUID   `json:"columnId"`
	Priority    string      `json:"priority"`
	Color       string      `json:"color"`
	DueDate     string      `json:"dueDate"`
	Completed   bool        `json:"completed"`
	Assignees   []uuid.UUID `json:"assignees"`
	IncomingNum string      `json:"incomingNumber"`
	// Автор задачи и уровень доступа зрителя. Без них календарь не мог
	// объяснить, почему задача не редактируется, и не показывал, кто
	// её поставил, — в отличие от «Входящих».
	CreatedBy   uuid.UUID   `json:"createdBy"`
	Access      string      `json:"access"`
}

// Calendar возвращает задачи со сроком в заданном диапазоне.
//
// Диапазон обязателен и ограничен: без верхнего предела запрос
// «покажи всё» на большой установке вернул бы десятки тысяч строк, а
// календарь всё равно рисует максимум пару месяцев за раз.
func (s *Server) Calendar(c *fiber.Ctx) error {
	uid := s.uid(c)

	from := c.Query("from")
	to := c.Query("to")
	if from == "" || to == "" {
		// По умолчанию — текущий месяц с запасом на соседние недели,
		// которые видны в сетке месяца.
		now := time.Now()
		first := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC)
		from = first.AddDate(0, 0, -7).Format("2006-01-02")
		to = first.AddDate(0, 1, 7).Format("2006-01-02")
	}

	fromDate, err1 := time.Parse("2006-01-02", from)
	toDate, err2 := time.Parse("2006-01-02", to)
	if err1 != nil || err2 != nil {
		return httpx.Fail(c, httpx.Err(fiber.StatusBadRequest, "bad_range",
			"Некорректный диапазон дат"))
	}
	if toDate.Sub(fromDate) > 400*24*time.Hour {
		return httpx.Fail(c, httpx.Err(fiber.StatusBadRequest, "range_too_wide",
			"Диапазон не может превышать год"))
	}

	// mine=1 — только мои задачи: на общей установке календарь всех
	// проектов сразу превращается в кашу, и чаще нужен личный срез.
	onlyMine := c.Query("mine") == "1"
	var boardFilter *uuid.UUID
	if v := c.Query("boardId"); v != "" {
		if id, e := uuid.Parse(v); e == nil {
			boardFilter = &id
		}
	}

	items := []calendarTask{}
	err := s.db.AsUser(c.Context(), uid, func(tx pgx.Tx) error {
		rows, e := tx.Query(c.Context(), `
			SELECT t.id, t.title, t.board_id, b.title, t.column_id,
			       t.priority::text, t.color,
			       to_char(t.due_date, 'YYYY-MM-DD'),
			       (t.completed_at IS NOT NULL),
			       COALESCE(array_agg(DISTINCT a.user_id)
			                FILTER (WHERE a.user_id IS NOT NULL), '{}'),
			       t.incoming_number, t.created_by,
			       COALESCE(app.task_access(t.id, $5), 'read')
			  FROM app.tasks t
			  JOIN app.boards b ON b.id = t.board_id
			  LEFT JOIN app.task_assignees a ON a.task_id = t.id
			 WHERE NOT t.archived
			   AND t.due_date BETWEEN $1::date AND $2::date
			   AND ($3::uuid IS NULL OR t.board_id = $3::uuid)
			   AND (NOT $4::boolean OR EXISTS (
			         SELECT 1 FROM app.task_assignees ta
			          WHERE ta.task_id = t.id AND ta.user_id = $5))
			 GROUP BY t.id, b.title
			 ORDER BY t.due_date, t.priority DESC`,
			from, to, boardFilter, onlyMine, uid)
		if e != nil {
			return e
		}
		defer rows.Close()
		for rows.Next() {
			var ct calendarTask
			if e := rows.Scan(&ct.ID, &ct.Title, &ct.BoardID, &ct.BoardTitle, &ct.ColumnID,
				&ct.Priority, &ct.Color, &ct.DueDate, &ct.Completed,
				&ct.Assignees, &ct.IncomingNum, &ct.CreatedBy, &ct.Access); e != nil {
				return e
			}
			items = append(items, ct)
		}
		return rows.Err()
	})
	if err != nil {
		return httpx.Fail(c, err)
	}

	return httpx.JSON(c, fiber.StatusOK, fiber.Map{
		"items": items, "from": from, "to": to,
	})
}
