package middleware

import (
	"strings"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"

	"github.com/example/kanban/internal/auth"
	"github.com/example/kanban/internal/httpx"
)

const localsUserID = "userID"

// Auth проверяет подпись access-токена и кладёт идентификатор
// пользователя в fiber.Locals. Дальше этот идентификатор попадает
// в app.user_id внутри транзакции, и уже RLS решает, что человеку видно.
func Auth(m *auth.Manager) fiber.Handler {
	return func(c *fiber.Ctx) error {
		token := bearerToken(c)
		if token == "" {
			// Для скачивания файлов и подключения WebSocket ссылка
			// открывается напрямую, где заголовок Authorization не
			// выставить — токен передаётся параметром запроса.
			token = c.Query("access_token")
		}
		if token == "" {
			return httpx.Fail(c, httpx.ErrUnauthorized)
		}

		userID, err := m.ParseAccess(token)
		if err != nil {
			code := "unauthorized"
			if err == auth.ErrExpired {
				code = "token_expired"
			}
			return httpx.JSON(c, fiber.StatusUnauthorized,
				httpx.ErrorBody{Error: "Требуется вход в систему", Code: code})
		}
		c.Locals(localsUserID, userID)
		return c.Next()
	}
}

func bearerToken(c *fiber.Ctx) string {
	header := c.Get("Authorization")
	token, ok := strings.CutPrefix(header, "Bearer ")
	if !ok {
		return ""
	}
	return token
}

func UserID(c *fiber.Ctx) uuid.UUID {
	id, _ := c.Locals(localsUserID).(uuid.UUID)
	return id
}
