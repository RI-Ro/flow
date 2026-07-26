package handlers

import (
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/example/kanban/internal/auth"
	"github.com/example/kanban/internal/httpx"
	"github.com/example/kanban/internal/models"
)

func (s *Server) Me(c *fiber.Ctx) error {
	u, err := s.loadUser(c.Context(), s.uid(c))
	if err != nil {
		return httpx.Fail(c, err)
	}
	return httpx.JSON(c, fiber.StatusOK, u)
}

type profilePatch struct {
	FullName    *string `json:"fullName"`
	Position    *string `json:"position"`
	Phone       *string `json:"phone"`
	AvatarColor *string `json:"avatarColor"`
}

func (s *Server) UpdateMe(c *fiber.Ctx) error {
	var in profilePatch
	if err := httpx.Decode(c, &in); err != nil {
		return httpx.Fail(c, err)
	}
	uid := s.uid(c)

	err := s.db.AsUser(c.Context(), uid, func(tx pgx.Tx) error {
		_, e := tx.Exec(c.Context(), `
			UPDATE app.users SET
				full_name    = COALESCE($2, full_name),
				position     = COALESCE($3, position),
				phone        = COALESCE($4, phone),
				avatar_color = COALESCE($5, avatar_color)
			WHERE id = $1`, uid, in.FullName, in.Position, in.Phone, in.AvatarColor)
		return e
	})
	if err != nil {
		return httpx.Fail(c, err)
	}
	return s.Me(c)
}

type passwordChange struct {
	Current string `json:"currentPassword"`
	New     string `json:"newPassword"`
}

func (s *Server) ChangePassword(c *fiber.Ctx) error {
	var in passwordChange
	if err := httpx.Decode(c, &in); err != nil {
		return httpx.Fail(c, err)
	}
	if len(in.New) < 10 {
		return httpx.Fail(c, httpx.Err(fiber.StatusBadRequest, "weak_password", "Пароль должен быть не короче 10 символов"))
	}
	uid := s.uid(c)

	var email, hash string
	err := s.db.AsUser(c.Context(), uid, func(tx pgx.Tx) error {
		return tx.QueryRow(c.Context(), `SELECT email FROM app.users WHERE id = $1`, uid).Scan(&email)
	})
	if err != nil {
		return httpx.Fail(c, err)
	}
	err = s.db.AsService(c.Context(), func(tx pgx.Tx) error {
		var id uuid.UUID
		var active bool
		var role string
		return tx.QueryRow(c.Context(),
			`SELECT id, password_hash, is_active, role FROM app.authenticate($1)`, email).
			Scan(&id, &hash, &active, &role)
	})
	if err != nil || !auth.CheckPassword(hash, in.Current) {
		return httpx.Fail(c, httpx.Err(fiber.StatusForbidden, "bad_password", "Текущий пароль указан неверно"))
	}

	newHash, err := auth.HashPassword(in.New)
	if err != nil {
		return httpx.Fail(c, err)
	}
	err = s.db.AsUser(c.Context(), uid, func(tx pgx.Tx) error {
		if _, e := tx.Exec(c.Context(),
			`UPDATE app.users SET password_hash = $2 WHERE id = $1`, uid, newHash); e != nil {
			return e
		}
		// Гасим все сессии, включая текущую: пароль сменился, и старые
		// refresh-токены больше не должны работать нигде.
		_, e := tx.Exec(c.Context(),
			`UPDATE app.refresh_tokens SET revoked_at = now()
			  WHERE user_id = $1 AND revoked_at IS NULL`, uid)
		return e
	})
	if err != nil {
		return httpx.Fail(c, err)
	}

	// А текущему устройству сразу выдаём новую пару токенов.
	//
	// Иначе получалось расхождение между обещанием и поведением:
	// сообщение говорило, что выполнен выход из всех сессий, но человек
	// продолжал работать — его access-токен подписан и живёт ещё до
	// 15 минут, отозвать его нельзя. Выход происходил внезапно и позже,
	// при первой попытке обновить токен. Теперь честно: остальные
	// устройства действительно разлогинены, текущее — остаётся в строю.
	//
	// Ответ содержит новую пару токенов, клиент их сохраняет.
	return s.issue(c, uid)
}

// Directory — общий справочник сотрудников с поиском.
func (s *Server) Directory(c *fiber.Ctx) error {
	q := strings.TrimSpace(c.Query("q"))
	limit := httpx.QueryInt(c, "limit", 200, 1, 1000)

	users := []models.User{}
	err := s.db.AsUser(c.Context(), s.uid(c), func(tx pgx.Tx) error {
		// Условие и порядок записаны ровно теми выражениями, на которых
		// построены индексы users_search_trgm_idx и
		// users_directory_sort_idx (0005_admin.sql). Три отдельных ILIKE
		// по разным колонкам и ORDER BY deleted_at NULLS FIRST выглядели
		// эквивалентно, но не могли задействовать ни один из них — поиск
		// по справочнику выполнялся полным проходом по таблице.
		rows, e := tx.Query(c.Context(), `
			SELECT id, email, full_name, position, phone, avatar_color, is_active, deleted_at
			  FROM app.users
			 WHERE ($1 = ''
			        OR (full_name || ' ' || position || ' ' || phone) ILIKE '%' || $1 || '%')
			 ORDER BY (deleted_at IS NOT NULL), full_name
			 LIMIT $2`, q, limit)
		if e != nil {
			return e
		}
		defer rows.Close()
		for rows.Next() {
			var u models.User
			var deletedAt *time.Time
			if e := rows.Scan(&u.ID, &u.Email, &u.FullName, &u.Position, &u.Phone,
				&u.AvatarColor, &u.IsActive, &deletedAt); e != nil {
				return e
			}
			u.Deleted = deletedAt != nil
			users = append(users, u)
		}
		return rows.Err()
	})
	if err != nil {
		return httpx.Fail(c, err)
	}
	return httpx.JSON(c, fiber.StatusOK, users)
}

func (s *Server) GetTeam(c *fiber.Ctx) error {
	ids := []uuid.UUID{}
	err := s.db.AsUser(c.Context(), s.uid(c), func(tx pgx.Tx) error {
		rows, e := tx.Query(c.Context(),
			`SELECT member_id FROM app.team_members WHERE owner_id = $1`, s.uid(c))
		if e != nil {
			return e
		}
		defer rows.Close()
		for rows.Next() {
			var id uuid.UUID
			if e := rows.Scan(&id); e != nil {
				return e
			}
			ids = append(ids, id)
		}
		return rows.Err()
	})
	if err != nil {
		return httpx.Fail(c, err)
	}
	return httpx.JSON(c, fiber.StatusOK, ids)
}

func (s *Server) SetTeam(c *fiber.Ctx) error {
	var ids []uuid.UUID
	if err := httpx.Decode(c, &ids); err != nil {
		return httpx.Fail(c, err)
	}
	uid := s.uid(c)

	err := s.db.AsUser(c.Context(), uid, func(tx pgx.Tx) error {
		if _, e := tx.Exec(c.Context(), `DELETE FROM app.team_members WHERE owner_id = $1`, uid); e != nil {
			return e
		}
		if len(ids) == 0 {
			return nil
		}
		_, e := tx.Exec(c.Context(), `
			INSERT INTO app.team_members (owner_id, member_id)
			SELECT $1, u.id FROM unnest($2::uuid[]) AS u(id)
			ON CONFLICT DO NOTHING`, uid, ids)
		return e
	})
	if err != nil {
		return httpx.Fail(c, err)
	}
	return httpx.JSON(c, fiber.StatusOK, ids)
}

func (s *Server) ListNotifications(c *fiber.Ctx) error {
	limit := httpx.QueryInt(c, "limit", 10, 1, 50)
	offset := httpx.QueryInt(c, "offset", 0, 0, 100000)
	includeRead := c.Query("includeRead") == "true"

	items := []models.Notification{}
	var total, unread int

	err := s.db.AsUser(c.Context(), s.uid(c), func(tx pgx.Tx) error {
		if e := tx.QueryRow(c.Context(), `
			SELECT count(*) FILTER (WHERE $1 OR read_at IS NULL), count(*) FILTER (WHERE read_at IS NULL)
			  FROM app.notifications`, includeRead).Scan(&total, &unread); e != nil {
			return e
		}
		rows, e := tx.Query(c.Context(), `
			SELECT id, body, board_id, task_id, read_at, created_at
			  FROM app.notifications
			 WHERE ($1 OR read_at IS NULL)
			 ORDER BY created_at DESC
			 LIMIT $2 OFFSET $3`, includeRead, limit, offset)
		if e != nil {
			return e
		}
		defer rows.Close()
		for rows.Next() {
			var n models.Notification
			var readAt *time.Time
			if e := rows.Scan(&n.ID, &n.Body, &n.BoardID, &n.TaskID, &readAt, &n.CreatedAt); e != nil {
				return e
			}
			n.Read = readAt != nil
			items = append(items, n)
		}
		return rows.Err()
	})
	if err != nil {
		return httpx.Fail(c, err)
	}

	return httpx.JSON(c, fiber.StatusOK, fiber.Map{
		"items": items, "total": total, "unread": unread,
		"limit": limit, "offset": offset,
	})
}

func (s *Server) ReadNotification(c *fiber.Ctx) error {
	id, err := param(c, "id")
	if err != nil {
		return httpx.Fail(c, err)
	}
	err = s.db.AsUser(c.Context(), s.uid(c), func(tx pgx.Tx) error {
		_, e := tx.Exec(c.Context(),
			`UPDATE app.notifications SET read_at = now() WHERE id = $1 AND read_at IS NULL`, id)
		return e
	})
	if err != nil {
		return httpx.Fail(c, err)
	}
	return httpx.NoContent(c)
}

func (s *Server) ReadAllNotifications(c *fiber.Ctx) error {
	err := s.db.AsUser(c.Context(), s.uid(c), func(tx pgx.Tx) error {
		_, e := tx.Exec(c.Context(),
			`UPDATE app.notifications SET read_at = now() WHERE read_at IS NULL`)
		return e
	})
	if err != nil {
		return httpx.Fail(c, err)
	}
	return httpx.NoContent(c)
}
