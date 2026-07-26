package handlers

import (
	"errors"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/example/kanban/internal/auth"
	"github.com/example/kanban/internal/httpx"
	"github.com/example/kanban/internal/models"
)

// RequireAdmin — middleware для группы /api/admin.
//
// Права проверяются запросом к базе, а не по полю в JWT: токен живёт 15
// минут, и если бы роль хранилась в нём, снятие прав администратора
// вступало бы в силу с задержкой, а свежеразжалованный успел бы за это
// время сделать что угодно. Один индексный запрос по первичному ключу
// (users_admin_idx) на админский вызов — приемлемая цена за то, чтобы
// отзыв прав действовал немедленно.
func (s *Server) RequireAdmin(c *fiber.Ctx) error {
	uid := s.uid(c)
	var ok bool
	if err := s.db.AsService(c.Context(), func(tx pgx.Tx) error {
		return tx.QueryRow(c.Context(), `SELECT app.is_admin($1)`, uid).Scan(&ok)
	}); err != nil {
		return httpx.Fail(c, err)
	}
	if !ok {
		// 404, а не 403: существование админской панели не подтверждаем
		// тем, у кого нет к ней доступа.
		return httpx.Fail(c, httpx.ErrNotFound)
	}
	return c.Next()
}

// AdminListUsers — полный список учётных записей, включая отключённые и
// удалённые, с числом активных сессий у каждой.
func (s *Server) AdminListUsers(c *fiber.Ctx) error {
	q := strings.TrimSpace(c.Query("q"))
	limit := httpx.QueryInt(c, "limit", 100, 1, 500)
	offset := httpx.QueryInt(c, "offset", 0, 0, 1000000)

	users := []models.User{}
	var total int

	err := s.db.AsUser(c.Context(), s.uid(c), func(tx pgx.Tx) error {
		if e := tx.QueryRow(c.Context(), `
			SELECT count(*) FROM app.users
			 WHERE ($1 = '' OR (full_name || ' ' || position || ' ' || phone) ILIKE '%' || $1 || '%'
			                OR email ILIKE '%' || $1 || '%')`, q).Scan(&total); e != nil {
			return e
		}

		// Число сессий берётся подзапросом с частичным индексом
		// refresh_tokens_active_idx — без него это был бы отдельный
		// запрос на каждого пользователя.
		rows, e := tx.Query(c.Context(), `
			SELECT u.id, u.email, u.full_name, u.position, u.phone, u.avatar_color,
			       u.is_active, u.deleted_at, u.role::text, u.created_at,
			       (SELECT count(*) FROM app.refresh_tokens r
			         WHERE r.user_id = u.id AND r.revoked_at IS NULL
			           AND r.expires_at > now())
			  FROM app.users u
			 WHERE ($1 = '' OR (u.full_name || ' ' || u.position || ' ' || u.phone) ILIKE '%' || $1 || '%'
			                OR u.email ILIKE '%' || $1 || '%')
			 ORDER BY (u.deleted_at IS NOT NULL), u.full_name
			 LIMIT $2 OFFSET $3`, q, limit, offset)
		if e != nil {
			return e
		}
		defer rows.Close()
		for rows.Next() {
			var u models.User
			var deletedAt *time.Time
			var createdAt time.Time
			if e := rows.Scan(&u.ID, &u.Email, &u.FullName, &u.Position, &u.Phone,
				&u.AvatarColor, &u.IsActive, &deletedAt, &u.Role, &createdAt, &u.Sessions); e != nil {
				return e
			}
			u.Deleted = deletedAt != nil
			u.CreatedAt = &createdAt
			users = append(users, u)
		}
		return rows.Err()
	})
	if err != nil {
		return httpx.Fail(c, err)
	}

	return httpx.JSON(c, fiber.StatusOK, fiber.Map{
		"items": users, "total": total, "limit": limit, "offset": offset,
	})
}

type adminUserCreate struct {
	Email    string `json:"email"`
	Password string `json:"password"`
	FullName string `json:"fullName"`
	Position string `json:"position"`
	Phone    string `json:"phone"`
	Role     string `json:"role"`
}

func (s *Server) AdminCreateUser(c *fiber.Ctx) error {
	var in adminUserCreate
	if err := httpx.Decode(c, &in); err != nil {
		return httpx.Fail(c, err)
	}
	in.Email = strings.TrimSpace(strings.ToLower(in.Email))
	in.FullName = strings.TrimSpace(in.FullName)

	if !strings.Contains(in.Email, "@") || in.FullName == "" {
		return httpx.Fail(c, httpx.Err(fiber.StatusBadRequest, "invalid_input",
			"Нужны корректный адрес почты и имя"))
	}
	if len(in.Password) < 10 {
		return httpx.Fail(c, httpx.Err(fiber.StatusBadRequest, "weak_password",
			"Пароль должен быть не короче 10 символов"))
	}
	if in.Role != "admin" {
		in.Role = "member"
	}

	hash, err := auth.HashPassword(in.Password)
	if err != nil {
		return httpx.Fail(c, err)
	}

	colors := strings.Split(avatarPalette, ",")
	color := colors[int(uuid.New().ID())%len(colors)]

	var u models.User
	var createdAt time.Time
	err = s.db.AsUser(c.Context(), s.uid(c), func(tx pgx.Tx) error {
		return tx.QueryRow(c.Context(), `
			INSERT INTO app.users (email, password_hash, full_name, position, phone,
			                       avatar_color, role)
			VALUES ($1, $2, $3, $4, $5, $6, $7::app.system_role)
			RETURNING id, email, full_name, position, phone, avatar_color,
			          is_active, role::text, created_at`,
			in.Email, hash, in.FullName, in.Position, in.Phone, color, in.Role).
			Scan(&u.ID, &u.Email, &u.FullName, &u.Position, &u.Phone, &u.AvatarColor,
				&u.IsActive, &u.Role, &createdAt)
	})
	if err != nil {
		return httpx.Fail(c, err)
	}
	u.CreatedAt = &createdAt
	return httpx.JSON(c, fiber.StatusCreated, u)
}

type adminUserPatch struct {
	Email    *string `json:"email"`
	FullName *string `json:"fullName"`
	Position *string `json:"position"`
	Phone    *string `json:"phone"`
	Role     *string `json:"role"`
	IsActive *bool   `json:"isActive"`
}

func (s *Server) AdminUpdateUser(c *fiber.Ctx) error {
	targetID, err := param(c, "userID")
	if err != nil {
		return httpx.Fail(c, err)
	}
	var in adminUserPatch
	if err := httpx.Decode(c, &in); err != nil {
		return httpx.Fail(c, err)
	}
	actor := s.uid(c)

	if in.Role != nil && *in.Role != "admin" && *in.Role != "member" {
		return httpx.Fail(c, httpx.Err(fiber.StatusBadRequest, "bad_role", "Недопустимая роль"))
	}
	if in.Email != nil {
		normalized := strings.TrimSpace(strings.ToLower(*in.Email))
		if !strings.Contains(normalized, "@") {
			return httpx.Fail(c, httpx.Err(fiber.StatusBadRequest, "bad_email", "Некорректный адрес почты"))
		}
		in.Email = &normalized
	}

	// Снятие прав администратора и деактивация — операции, которыми можно
	// запереть систему: если убрать последнего админа, управлять учётными
	// записями станет некому и восстановить доступ можно будет только
	// напрямую в базе.
	losingAdmin := (in.Role != nil && *in.Role == "member") ||
		(in.IsActive != nil && !*in.IsActive)

	var u models.User
	var deletedAt *time.Time
	var createdAt time.Time
	err = s.db.AsUser(c.Context(), actor, func(tx pgx.Tx) error {
		if losingAdmin {
			var others int
			if e := tx.QueryRow(c.Context(),
				`SELECT app.other_admins_count($1)`, targetID).Scan(&others); e != nil {
				return e
			}
			var targetIsAdmin bool
			if e := tx.QueryRow(c.Context(),
				`SELECT app.is_admin($1)`, targetID).Scan(&targetIsAdmin); e != nil {
				return e
			}
			if targetIsAdmin && others == 0 {
				return httpx.Err(fiber.StatusConflict, "last_admin",
					"Это последний администратор — сначала назначьте другого")
			}
		}

		if e := tx.QueryRow(c.Context(), `
			UPDATE app.users SET
				email     = COALESCE($2, email),
				full_name = COALESCE($3, full_name),
				position  = COALESCE($4, position),
				phone     = COALESCE($5, phone),
				role      = COALESCE($6::app.system_role, role),
				is_active = COALESCE($7, is_active)
			WHERE id = $1
			RETURNING id, email, full_name, position, phone, avatar_color,
			          is_active, deleted_at, role::text, created_at`,
			targetID, in.Email, in.FullName, in.Position, in.Phone, in.Role, in.IsActive).
			Scan(&u.ID, &u.Email, &u.FullName, &u.Position, &u.Phone, &u.AvatarColor,
				&u.IsActive, &deletedAt, &u.Role, &createdAt); e != nil {
			return e
		}

		// Деактивация обязана немедленно оборвать доступ: без этого
		// человек продолжал бы обновлять токен и работать.
		if in.IsActive != nil && !*in.IsActive {
			if _, e := tx.Exec(c.Context(), `SELECT app.revoke_user_sessions($1)`, targetID); e != nil {
				return e
			}
		}
		return nil
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return httpx.Fail(c, httpx.ErrNotFound)
	}
	if err != nil {
		return httpx.Fail(c, err)
	}
	u.Deleted = deletedAt != nil
	u.CreatedAt = &createdAt

	if in.IsActive != nil && !*in.IsActive {
		s.hub.Disconnect(targetID)
	}
	return httpx.JSON(c, fiber.StatusOK, u)
}

type adminPasswordReset struct {
	NewPassword string `json:"newPassword"`
}

// AdminResetPassword задаёт новый пароль и обрывает все сессии
// пользователя: если пароль меняют принудительно, старые сессии почти
// всегда нужно завершить (типовой случай — увольнение или утечка).
func (s *Server) AdminResetPassword(c *fiber.Ctx) error {
	targetID, err := param(c, "userID")
	if err != nil {
		return httpx.Fail(c, err)
	}
	var in adminPasswordReset
	if err := httpx.Decode(c, &in); err != nil {
		return httpx.Fail(c, err)
	}
	if len(in.NewPassword) < 10 {
		return httpx.Fail(c, httpx.Err(fiber.StatusBadRequest, "weak_password",
			"Пароль должен быть не короче 10 символов"))
	}

	hash, err := auth.HashPassword(in.NewPassword)
	if err != nil {
		return httpx.Fail(c, err)
	}

	var affected int64
	err = s.db.AsUser(c.Context(), s.uid(c), func(tx pgx.Tx) error {
		tag, e := tx.Exec(c.Context(),
			`UPDATE app.users SET password_hash = $2 WHERE id = $1`, targetID, hash)
		if e != nil {
			return e
		}
		affected = tag.RowsAffected()
		if affected == 0 {
			return nil
		}
		_, e = tx.Exec(c.Context(), `SELECT app.revoke_user_sessions($1)`, targetID)
		return e
	})
	if err != nil {
		return httpx.Fail(c, err)
	}
	if affected == 0 {
		return httpx.Fail(c, httpx.ErrNotFound)
	}
	s.hub.Disconnect(targetID)
	return httpx.NoContent(c)
}

// AdminDeleteUser — мягкое удаление. Физического DELETE нет намеренно:
// created_by в проектах, задачах, комментариях и файлах объявлены
// ON DELETE RESTRICT, поэтому удаление строки либо было бы отвергнуто
// базой, либо (при каскаде) уничтожило бы историю работы. Учётная
// запись помечается удалённой, сессии обрываются, а имя продолжает
// отображаться в старых задачах — интерфейс показывает такие записи
// зачёркнутыми.
func (s *Server) AdminDeleteUser(c *fiber.Ctx) error {
	targetID, err := param(c, "userID")
	if err != nil {
		return httpx.Fail(c, err)
	}
	actor := s.uid(c)

	if targetID == actor {
		return httpx.Fail(c, httpx.Err(fiber.StatusConflict, "self_delete",
			"Нельзя удалить собственную учётную запись"))
	}

	var affected int64
	err = s.db.AsUser(c.Context(), actor, func(tx pgx.Tx) error {
		var others int
		if e := tx.QueryRow(c.Context(),
			`SELECT app.other_admins_count($1)`, targetID).Scan(&others); e != nil {
			return e
		}
		var targetIsAdmin bool
		if e := tx.QueryRow(c.Context(),
			`SELECT app.is_admin($1)`, targetID).Scan(&targetIsAdmin); e != nil {
			return e
		}
		if targetIsAdmin && others == 0 {
			return httpx.Err(fiber.StatusConflict, "last_admin",
				"Это последний администратор — сначала назначьте другого")
		}

		tag, e := tx.Exec(c.Context(), `
			UPDATE app.users
			   SET deleted_at = now(), is_active = false, role = 'member'
			 WHERE id = $1 AND deleted_at IS NULL`, targetID)
		if e != nil {
			return e
		}
		affected = tag.RowsAffected()
		if affected == 0 {
			return nil
		}

		// Личные связи чистим: держать удалённого в чужих командах и
		// участником досок незачем, он всё равно не сможет войти.
		if _, e := tx.Exec(c.Context(),
			`DELETE FROM app.team_members WHERE member_id = $1 OR owner_id = $1`, targetID); e != nil {
			return e
		}
		if _, e := tx.Exec(c.Context(),
			`DELETE FROM app.task_grants WHERE user_id = $1`, targetID); e != nil {
			return e
		}
		if _, e := tx.Exec(c.Context(), `SELECT app.revoke_user_sessions($1)`, targetID); e != nil {
			return e
		}
		return nil
	})
	if err != nil {
		return httpx.Fail(c, err)
	}
	if affected == 0 {
		return httpx.Fail(c, httpx.ErrNotFound)
	}
	s.hub.Disconnect(targetID)
	return httpx.NoContent(c)
}

// AdminRestoreUser возвращает мягко удалённую учётную запись.
// Членство в досках и командах при удалении было снято и автоматически
// не восстанавливается — это осознанно: восстановить доступ к проектам
// должен их владелец, а не администратор системы.
func (s *Server) AdminRestoreUser(c *fiber.Ctx) error {
	targetID, err := param(c, "userID")
	if err != nil {
		return httpx.Fail(c, err)
	}

	var u models.User
	var deletedAt *time.Time
	var createdAt time.Time
	err = s.db.AsUser(c.Context(), s.uid(c), func(tx pgx.Tx) error {
		return tx.QueryRow(c.Context(), `
			UPDATE app.users SET deleted_at = NULL, is_active = true
			 WHERE id = $1 AND deleted_at IS NOT NULL
			RETURNING id, email, full_name, position, phone, avatar_color,
			          is_active, deleted_at, role::text, created_at`, targetID).
			Scan(&u.ID, &u.Email, &u.FullName, &u.Position, &u.Phone, &u.AvatarColor,
				&u.IsActive, &deletedAt, &u.Role, &createdAt)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return httpx.Fail(c, httpx.ErrNotFound)
	}
	if err != nil {
		return httpx.Fail(c, err)
	}
	u.Deleted = deletedAt != nil
	u.CreatedAt = &createdAt
	return httpx.JSON(c, fiber.StatusOK, u)
}
