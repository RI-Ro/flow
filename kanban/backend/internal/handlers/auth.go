package handlers

import (
	"context"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/example/kanban/internal/auth"
	"github.com/example/kanban/internal/httpx"
	"github.com/example/kanban/internal/models"
)

type credentials struct {
	Email    string `json:"email"`
	Password string `json:"password"`
	FullName string `json:"fullName,omitempty"`
	Position string `json:"position,omitempty"`
	Phone    string `json:"phone,omitempty"`
}

type tokenPair struct {
	AccessToken  string      `json:"accessToken"`
	RefreshToken string      `json:"refreshToken"`
	ExpiresIn    int         `json:"expiresIn"`
	User         models.User `json:"user"`
}

const avatarPalette = "#3D5A80,#E8734A,#6B9B54,#8B6BB1,#3D9B94,#C25450,#A87C3D,#4A6B8A"

func (s *Server) Register(c *fiber.Ctx) error {
	var in credentials
	if err := httpx.Decode(c, &in); err != nil {
		return httpx.Fail(c, err)
	}
	in.Email = strings.TrimSpace(strings.ToLower(in.Email))
	in.FullName = strings.TrimSpace(in.FullName)

	if !strings.Contains(in.Email, "@") || len(in.Password) < 10 || in.FullName == "" {
		return httpx.Fail(c, httpx.Err(fiber.StatusBadRequest, "invalid_input",
			"Нужны корректная почта, имя и пароль не короче 10 символов"))
	}

	// Самостоятельная регистрация по умолчанию закрыта: учётные записи
	// заводит администратор. Исключение — совершенно пустая база: иначе
	// после установки войти было бы некому, и первого администратора
	// пришлось бы создавать руками в psql. Первая созданная учётная
	// запись сразу получает права администратора (см. ниже).
	var firstUser bool
	if err := s.db.AsService(c.Context(), func(tx pgx.Tx) error {
		return tx.QueryRow(c.Context(),
			`SELECT NOT EXISTS (SELECT 1 FROM app.users WHERE deleted_at IS NULL)`).Scan(&firstUser)
	}); err != nil {
		return httpx.Fail(c, err)
	}
	if !firstUser && !s.cfg.AllowSelfRegistration {
		return httpx.Fail(c, httpx.Err(fiber.StatusForbidden, "registration_closed",
			"Регистрация закрыта — учётную запись создаёт администратор"))
	}

	hash, err := auth.HashPassword(in.Password)
	if err != nil {
		return httpx.Fail(c, err)
	}

	colors := strings.Split(avatarPalette, ",")
	color := colors[int(uuid.New().ID())%len(colors)]

	role := "member"
	if firstUser {
		role = "admin"
	}

	var userID uuid.UUID
	err = s.db.AsService(c.Context(), func(tx pgx.Tx) error {
		return tx.QueryRow(c.Context(), `
			INSERT INTO app.users (email, password_hash, full_name, position, phone,
			                       avatar_color, role)
			VALUES ($1, $2, $3, $4, $5, $6, $7::app.system_role) RETURNING id`,
			in.Email, hash, in.FullName, in.Position, in.Phone, color, role).Scan(&userID)
	})
	if err != nil {
		return httpx.Fail(c, err)
	}

	return s.issue(c, userID)
}

func (s *Server) Login(c *fiber.Ctx) error {
	var in credentials
	if err := httpx.Decode(c, &in); err != nil {
		return httpx.Fail(c, err)
	}

	var (
		userID   uuid.UUID
		hash     string
		isActive bool
		role     string
	)
	err := s.db.AsService(c.Context(), func(tx pgx.Tx) error {
		return tx.QueryRow(c.Context(),
			`SELECT id, password_hash, is_active, role FROM app.authenticate($1)`,
			strings.TrimSpace(strings.ToLower(in.Email))).Scan(&userID, &hash, &isActive, &role)
	})

	// Пароль сравнивается всегда, даже если пользователя нет: иначе
	// разница во времени ответа выдаёт, какие адреса зарегистрированы.
	if err != nil {
		auth.CheckPassword("$2a$12$0000000000000000000000000000000000000000000000000000", in.Password)
		return httpx.Fail(c, httpx.Err(fiber.StatusUnauthorized, "bad_credentials", "Неверная почта или пароль"))
	}
	if !auth.CheckPassword(hash, in.Password) || !isActive {
		return httpx.Fail(c, httpx.Err(fiber.StatusUnauthorized, "bad_credentials", "Неверная почта или пароль"))
	}

	return s.issue(c, userID)
}

type refreshRequest struct {
	RefreshToken string `json:"refreshToken"`
}

// Refresh реализует ротацию с обнаружением повторного использования:
// каждый обмен выдаёт новый токен и гасит старый. Если пришёл уже
// погашенный токен, значит копию кто-то перехватил — рубим всё семейство.
func (s *Server) Refresh(c *fiber.Ctx) error {
	var in refreshRequest
	if err := httpx.Decode(c, &in); err != nil {
		return httpx.Fail(c, err)
	}
	if in.RefreshToken == "" {
		return httpx.Fail(c, httpx.ErrUnauthorized)
	}

	hash := auth.HashRefresh(in.RefreshToken)

	var (
		userID    uuid.UUID
		familyID  uuid.UUID
		expiresAt time.Time
		revokedAt *time.Time
	)
	err := s.db.AsService(c.Context(), func(tx pgx.Tx) error {
		return tx.QueryRow(c.Context(), `
			SELECT user_id, family_id, expires_at, revoked_at
			  FROM app.refresh_tokens WHERE token_hash = $1`, hash).
			Scan(&userID, &familyID, &expiresAt, &revokedAt)
	})
	if err != nil {
		return httpx.Fail(c, httpx.Err(fiber.StatusUnauthorized, "bad_refresh", "Сессия недействительна"))
	}

	if revokedAt != nil {
		_ = s.db.AsService(c.Context(), func(tx pgx.Tx) error {
			_, e := tx.Exec(c.Context(),
				`UPDATE app.refresh_tokens SET revoked_at = now()
				  WHERE family_id = $1 AND revoked_at IS NULL`, familyID)
			return e
		})
		return httpx.Fail(c, httpx.Err(fiber.StatusUnauthorized, "token_reuse",
			"Сессия завершена по соображениям безопасности, войдите заново"))
	}
	if time.Now().After(expiresAt) {
		return httpx.Fail(c, httpx.Err(fiber.StatusUnauthorized, "bad_refresh", "Сессия истекла"))
	}

	// Состояние учётной записи проверяется именно здесь. Access-токен
	// подписан и живёт 15 минут — его отозвать нельзя, поэтому обновление
	// токена остаётся единственной точкой, где блокировка вступает в
	// силу. Без этой проверки деактивированный или удалённый
	// администратором пользователь продолжал бы обновлять токен до
	// истечения refresh-срока, то есть месяц, и «удаление» из панели
	// администратора ничего бы фактически не значило.
	var (
		accActive  bool
		accDeleted bool
		accRole    string
	)
	if e := s.db.AsService(c.Context(), func(tx pgx.Tx) error {
		return tx.QueryRow(c.Context(),
			`SELECT is_active, deleted, role FROM app.account_state($1)`, userID).
			Scan(&accActive, &accDeleted, &accRole)
	}); e != nil {
		return httpx.Fail(c, httpx.Err(fiber.StatusUnauthorized, "bad_refresh", "Сессия недействительна"))
	}
	if accDeleted || !accActive {
		// Гасим всё семейство: смысла держать живые токены у
		// заблокированной учётной записи нет.
		_ = s.db.AsService(c.Context(), func(tx pgx.Tx) error {
			_, e := tx.Exec(c.Context(), `SELECT app.revoke_user_sessions($1)`, userID)
			return e
		})
		return httpx.Fail(c, httpx.Err(fiber.StatusUnauthorized, "account_disabled",
			"Учётная запись отключена — обратитесь к администратору"))
	}

	raw, newHash, err := auth.NewRefreshToken()
	if err != nil {
		return httpx.Fail(c, err)
	}

	err = s.db.AsService(c.Context(), func(tx pgx.Tx) error {
		if _, e := tx.Exec(c.Context(),
			`UPDATE app.refresh_tokens SET revoked_at = now() WHERE token_hash = $1`, hash); e != nil {
			return e
		}
		_, e := tx.Exec(c.Context(), `
			INSERT INTO app.refresh_tokens (user_id, token_hash, family_id, expires_at, user_agent)
			VALUES ($1, $2, $3, $4, $5)`,
			userID, newHash, familyID, time.Now().Add(s.auth.RefreshTTL()), c.Get("User-Agent"))
		return e
	})
	if err != nil {
		return httpx.Fail(c, err)
	}

	access, err := s.auth.IssueAccess(userID)
	if err != nil {
		return httpx.Fail(c, err)
	}
	user, err := s.loadUser(c.Context(), userID)
	if err != nil {
		return httpx.Fail(c, err)
	}

	return httpx.JSON(c, fiber.StatusOK, tokenPair{
		AccessToken:  access,
		RefreshToken: raw,
		ExpiresIn:    int(s.auth.AccessTTL().Seconds()),
		User:         user,
	})
}

func (s *Server) Logout(c *fiber.Ctx) error {
	var in refreshRequest
	if err := httpx.Decode(c, &in); err != nil {
		return httpx.NoContent(c)
	}
	if in.RefreshToken != "" {
		_ = s.db.AsService(c.Context(), func(tx pgx.Tx) error {
			_, e := tx.Exec(c.Context(), `
				UPDATE app.refresh_tokens SET revoked_at = now()
				 WHERE family_id = (SELECT family_id FROM app.refresh_tokens WHERE token_hash = $1)
				   AND revoked_at IS NULL`, auth.HashRefresh(in.RefreshToken))
			return e
		})
	}
	return httpx.NoContent(c)
}

func (s *Server) issue(c *fiber.Ctx, userID uuid.UUID) error {
	access, err := s.auth.IssueAccess(userID)
	if err != nil {
		return httpx.Fail(c, err)
	}
	raw, hash, err := auth.NewRefreshToken()
	if err != nil {
		return httpx.Fail(c, err)
	}

	err = s.db.AsService(c.Context(), func(tx pgx.Tx) error {
		_, e := tx.Exec(c.Context(), `
			INSERT INTO app.refresh_tokens (user_id, token_hash, family_id, expires_at, user_agent)
			VALUES ($1, $2, gen_random_uuid(), $3, $4)`,
			userID, hash, time.Now().Add(s.auth.RefreshTTL()), c.Get("User-Agent"))
		return e
	})
	if err != nil {
		return httpx.Fail(c, err)
	}

	user, err := s.loadUser(c.Context(), userID)
	if err != nil {
		return httpx.Fail(c, err)
	}

	return httpx.JSON(c, fiber.StatusOK, tokenPair{
		AccessToken:  access,
		RefreshToken: raw,
		ExpiresIn:    int(s.auth.AccessTTL().Seconds()),
		User:         user,
	})
}

func (s *Server) loadUser(ctx context.Context, id uuid.UUID) (models.User, error) {
	var u models.User
	var deletedAt *time.Time
	err := s.db.AsUser(ctx, id, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
			SELECT id, email, full_name, position, phone, avatar_color,
			       is_active, deleted_at, role::text
			  FROM app.users WHERE id = $1`, id).
			Scan(&u.ID, &u.Email, &u.FullName, &u.Position, &u.Phone, &u.AvatarColor,
				&u.IsActive, &deletedAt, &u.Role)
	})
	u.Deleted = deletedAt != nil
	return u, err
}
