package handlers

import (
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/example/kanban/internal/httpx"
)

// Дашборд считается агрегатами на стороне базы, а не выгрузкой всех
// задач в приложение.
//
// Разница принципиальна: на нескольких тысячах задач выгрузка означает
// мегабайты трафика и заметную паузу на отрисовке, тогда как GROUP BY
// возвращает десяток строк. Все запросы идут под RLS, поэтому в
// статистику попадает ровно то, что человеку доступно, — отдельной
// фильтрации по правам здесь нет и быть не должно.

type dashboardFilter struct {
	From      string
	To        string
	BoardID   *uuid.UUID
	Assignee  *uuid.UUID
	Status    string // all | open | done | overdue
}

func readDashboardFilter(c *fiber.Ctx) dashboardFilter {
	f := dashboardFilter{
		From:   c.Query("from"),
		To:     c.Query("to"),
		Status: c.Query("status", "all"),
	}
	if v := c.Query("boardId"); v != "" {
		if id, err := uuid.Parse(v); err == nil {
			f.BoardID = &id
		}
	}
	if v := c.Query("assignee"); v != "" {
		if id, err := uuid.Parse(v); err == nil {
			f.Assignee = &id
		}
	}
	if f.From == "" {
		// Полгода назад — разумное окно по умолчанию: годовой размах
		// на активной установке уже плохо читается на графике.
		f.From = time.Now().AddDate(0, -6, 0).Format("2006-01-02")
	}
	if f.To == "" {
		f.To = time.Now().AddDate(0, 0, 1).Format("2006-01-02")
	}
	return f
}

// Общее условие отбора. Вынесено в одну строку, чтобы все срезы
// дашборда считались по одной и той же выборке — иначе сумма по
// исполнителям не сойдётся с общим числом, и доверия к отчёту не будет.
const dashboardWhere = `
	WHERE NOT t.archived
	  AND t.created_at >= $1::date
	  AND t.created_at <  $2::date
	  AND ($3::uuid IS NULL OR t.board_id = $3::uuid)
	  AND ($4::uuid IS NULL OR EXISTS (
	        SELECT 1 FROM app.task_assignees ta
	         WHERE ta.task_id = t.id AND ta.user_id = $4::uuid))
	  AND ($5 = 'all'
	    OR ($5 = 'done'    AND t.completed_at IS NOT NULL)
	    OR ($5 = 'open'    AND t.completed_at IS NULL)
	    OR ($5 = 'overdue' AND t.completed_at IS NULL
	                       AND t.due_date IS NOT NULL AND t.due_date < current_date))`

func (s *Server) Dashboard(c *fiber.Ctx) error {
	f := readDashboardFilter(c)
	uid := s.uid(c)
	args := []any{f.From, f.To, f.BoardID, f.Assignee, f.Status}

	type counters struct {
		Total     int `json:"total"`
		Done      int `json:"done"`
		Open      int `json:"open"`
		Overdue   int `json:"overdue"`
		DueSoon   int `json:"dueSoon"`
		NoDueDate int `json:"noDueDate"`
	}
	var totals counters

	byPriority := []map[string]any{}
	byBoard := []map[string]any{}
	byAssignee := []map[string]any{}
	byWeek := []map[string]any{}
	myLoad := map[string]int{}

	err := s.db.AsUser(c.Context(), uid, func(tx pgx.Tx) error {
		// --- сводные счётчики ---
		if e := tx.QueryRow(c.Context(), `
			SELECT count(*),
			       count(*) FILTER (WHERE t.completed_at IS NOT NULL),
			       count(*) FILTER (WHERE t.completed_at IS NULL),
			       count(*) FILTER (WHERE t.completed_at IS NULL
			                          AND t.due_date IS NOT NULL
			                          AND t.due_date < current_date),
			       count(*) FILTER (WHERE t.completed_at IS NULL
			                          AND t.due_date BETWEEN current_date AND current_date + 7),
			       count(*) FILTER (WHERE t.due_date IS NULL)
			  FROM app.tasks t`+dashboardWhere, args...).
			Scan(&totals.Total, &totals.Done, &totals.Open, &totals.Overdue,
				&totals.DueSoon, &totals.NoDueDate); e != nil {
			return e
		}

		// --- по приоритетам ---
		rows, e := tx.Query(c.Context(), `
			SELECT t.priority::text, count(*),
			       count(*) FILTER (WHERE t.completed_at IS NOT NULL)
			  FROM app.tasks t`+dashboardWhere+`
			 GROUP BY t.priority ORDER BY count(*) DESC`, args...)
		if e != nil {
			return e
		}
		for rows.Next() {
			var name string
			var total, done int
			if e := rows.Scan(&name, &total, &done); e != nil {
				rows.Close()
				return e
			}
			byPriority = append(byPriority, map[string]any{
				"priority": name, "total": total, "done": done,
			})
		}
		rows.Close()

		// --- по проектам ---
		rows, e = tx.Query(c.Context(), `
			SELECT b.id, b.title, count(*),
			       count(*) FILTER (WHERE t.completed_at IS NOT NULL),
			       count(*) FILTER (WHERE t.completed_at IS NULL
			                          AND t.due_date IS NOT NULL
			                          AND t.due_date < current_date)
			  FROM app.tasks t
			  JOIN app.boards b ON b.id = t.board_id`+dashboardWhere+`
			 GROUP BY b.id, b.title ORDER BY count(*) DESC LIMIT 20`, args...)
		if e != nil {
			return e
		}
		for rows.Next() {
			var id uuid.UUID
			var title string
			var total, done, overdue int
			if e := rows.Scan(&id, &title, &total, &done, &overdue); e != nil {
				rows.Close()
				return e
			}
			byBoard = append(byBoard, map[string]any{
				"boardId": id, "title": title,
				"total": total, "done": done, "overdue": overdue,
			})
		}
		rows.Close()

		// --- по исполнителям ---
		// Задача с несколькими исполнителями попадает в строку каждого:
		// это нагрузка на человека, а не разбиение задач на доли.
		rows, e = tx.Query(c.Context(), `
			SELECT ta.user_id, count(*),
			       count(*) FILTER (WHERE t.completed_at IS NOT NULL),
			       count(*) FILTER (WHERE t.completed_at IS NULL
			                          AND t.due_date IS NOT NULL
			                          AND t.due_date < current_date),
			       count(*) FILTER (WHERE ta.completed_at IS NOT NULL)
			  FROM app.tasks t
			  JOIN app.task_assignees ta ON ta.task_id = t.id`+dashboardWhere+`
			 GROUP BY ta.user_id ORDER BY count(*) DESC LIMIT 30`, args...)
		if e != nil {
			return e
		}
		for rows.Next() {
			var id uuid.UUID
			var total, done, overdue, selfDone int
			if e := rows.Scan(&id, &total, &done, &overdue, &selfDone); e != nil {
				rows.Close()
				return e
			}
			byAssignee = append(byAssignee, map[string]any{
				"userId": id, "total": total, "done": done,
				"overdue": overdue, "selfDone": selfDone,
			})
		}
		rows.Close()

		// --- динамика по неделям ---
		rows, e = tx.Query(c.Context(), `
			SELECT to_char(date_trunc('week', t.created_at), 'YYYY-MM-DD'),
			       count(*),
			       count(*) FILTER (WHERE t.completed_at IS NOT NULL)
			  FROM app.tasks t`+dashboardWhere+`
			 GROUP BY 1 ORDER BY 1`, args...)
		if e != nil {
			return e
		}
		for rows.Next() {
			var week string
			var created, done int
			if e := rows.Scan(&week, &created, &done); e != nil {
				rows.Close()
				return e
			}
			byWeek = append(byWeek, map[string]any{
				"week": week, "created": created, "done": done,
			})
		}
		rows.Close()

		// --- лично мне ---
		// Считается без общего фильтра: это личная сводка «что на мне
		// сейчас», и сужать её выбранным периодом было бы неверно —
		// поручение месячной давности никуда не делось.
		var assigned, assignedOverdue, delegatedOut, granted int
		if e := tx.QueryRow(c.Context(), `
			SELECT
			  (SELECT count(*) FROM app.tasks t
			     JOIN app.task_assignees ta ON ta.task_id = t.id
			    WHERE ta.user_id = $1 AND NOT t.archived AND t.completed_at IS NULL),
			  (SELECT count(*) FROM app.tasks t
			     JOIN app.task_assignees ta ON ta.task_id = t.id
			    WHERE ta.user_id = $1 AND NOT t.archived AND t.completed_at IS NULL
			      AND t.due_date IS NOT NULL AND t.due_date < current_date),
			  (SELECT count(*) FROM app.tasks t
			    WHERE t.created_by = $1 AND NOT t.archived AND t.completed_at IS NULL),
			  (SELECT count(*) FROM app.tasks t
			     JOIN app.task_grants g ON g.task_id = t.id
			    WHERE g.user_id = $1 AND NOT t.archived AND t.completed_at IS NULL)`, uid).
			Scan(&assigned, &assignedOverdue, &delegatedOut, &granted); e != nil {
			return e
		}
		myLoad["assigned"] = assigned
		myLoad["assignedOverdue"] = assignedOverdue
		myLoad["createdByMe"] = delegatedOut
		myLoad["grantedToMe"] = granted
		return nil
	})
	if err != nil {
		return httpx.Fail(c, err)
	}

	return httpx.JSON(c, fiber.StatusOK, fiber.Map{
		"totals":     totals,
		"byPriority": byPriority,
		"byBoard":    byBoard,
		"byAssignee": byAssignee,
		"byWeek":     byWeek,
		"myLoad":     myLoad,
		"filter": fiber.Map{
			"from": f.From, "to": f.To, "status": f.Status,
			"boardId": f.BoardID, "assignee": f.Assignee,
		},
	})
}

// DashboardUserTasks — задачи конкретного человека для окна, которое
// открывается нажатием на строку в срезе по исполнителям.
//
// kind различает две роли: assigned — что ему поручено, created — что
// он поручил другим. Это разные вопросы к одному человеку, и смешивать
// их в одном списке нельзя.
func (s *Server) DashboardUserTasks(c *fiber.Ctx) error {
	userID, err := param(c, "userID")
	if err != nil {
		return httpx.Fail(c, err)
	}
	kind := c.Query("kind", "assigned")
	f := readDashboardFilter(c)
	uid := s.uid(c)

	// Три разреза по одному человеку: что ему поручено, что он поручил
	// другим и что ему открыто точечно. Это разные вопросы, и валить их
	// в один список нельзя.
	var join, extra string
	switch kind {
	case "created":
		extra = ` AND t.created_by = $6`
	case "granted":
		join = `JOIN app.task_grants g ON g.task_id = t.id AND g.user_id = $6`
	default:
		join = `JOIN app.task_assignees ta ON ta.task_id = t.id AND ta.user_id = $6`
	}

	var tasks []taskBrief
	err = s.db.AsUser(c.Context(), uid, func(tx pgx.Tx) error {
		rows, e := tx.Query(c.Context(), `
			SELECT t.id, t.title, t.board_id, b.title, t.priority::text,
			       to_char(t.due_date, 'YYYY-MM-DD'),
			       (t.completed_at IS NOT NULL)
			  FROM app.tasks t
			  JOIN app.boards b ON b.id = t.board_id
			  `+join+dashboardWhere+extra+`
			 ORDER BY t.due_date NULLS LAST, t.created_at DESC
			 LIMIT 200`,
			f.From, f.To, f.BoardID, f.Assignee, f.Status, userID)
		if e != nil {
			return e
		}
		defer rows.Close()
		tasks = []taskBrief{}
		for rows.Next() {
			var t taskBrief
			if e := rows.Scan(&t.ID, &t.Title, &t.BoardID, &t.BoardTitle,
				&t.Priority, &t.DueDate, &t.Completed); e != nil {
				return e
			}
			tasks = append(tasks, t)
		}
		return rows.Err()
	})
	if err != nil {
		return httpx.Fail(c, err)
	}
	return httpx.JSON(c, fiber.StatusOK, tasks)
}

// taskBrief — укороченное представление для списков дашборда:
// полная задача с чек-листом и грантами здесь избыточна.
type taskBrief struct {
	ID         uuid.UUID `json:"id"`
	Title      string    `json:"title"`
	BoardID    uuid.UUID `json:"boardId"`
	BoardTitle string    `json:"boardTitle"`
	Priority   string    `json:"priority"`
	DueDate    *string   `json:"dueDate"`
	Completed  bool      `json:"completed"`
}
