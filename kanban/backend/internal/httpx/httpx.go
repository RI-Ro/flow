package httpx

import (
	"bytes"
	"encoding/json"
	"errors"
	"log/slog"
	"strconv"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
)

type ErrorBody struct {
	Error string `json:"error"`
	Code  string `json:"code,omitempty"`
	// Подробности ошибки базы данных. Заполняются только вне production
	// (см. Fail ниже): в боевом контуре сообщения СУБД раскрывают
	// структуру схемы, а при разработке без них «500» не диагностируется.
	Details map[string]string `json:"details,omitempty"`
}

type APIError struct {
	Status  int
	Code    string
	Message string
}

func (e APIError) Error() string { return e.Message }

func Err(status int, code, msg string) APIError {
	return APIError{Status: status, Code: code, Message: msg}
}

var (
	ErrUnauthorized = Err(fiber.StatusUnauthorized, "unauthorized", "Требуется вход в систему")
	ErrForbidden    = Err(fiber.StatusForbidden, "forbidden", "Недостаточно прав")
	ErrNotFound     = Err(fiber.StatusNotFound, "not_found", "Объект не найден или недоступен")
	ErrBadRequest   = Err(fiber.StatusBadRequest, "bad_request", "Некорректный запрос")
)

func JSON(c *fiber.Ctx, status int, body any) error {
	return c.Status(status).JSON(body)
}

func NoContent(c *fiber.Ctx) error { return c.SendStatus(fiber.StatusNoContent) }

// Fail превращает ошибку в ответ и возвращает nil, чтобы вызывающий код
// мог сделать `return httpx.Fail(c, err)`: ответ уже записан, Fiber
// не должен запускать поверх него глобальный ErrorHandler повторно.
//
// Отсутствие строки под RLS выглядит снаружи как 404, а не как 403:
// иначе по коду ответа можно было бы перебором выяснить, какие
// идентификаторы существуют в чужих проектах.
func Fail(c *fiber.Ctx, err error) error {
	// Защита от Fail(c, nil): без неё вызов err.Error() ниже уронил бы
	// обработчик паникой. Такой вызов — всегда ошибка в коде выше по
	// стеку, но ронять из-за неё запрос незачем.
	if err == nil {
		slog.Error("Fail вызван без ошибки", "path", c.Path(), "method", c.Method())
		return JSON(c, fiber.StatusInternalServerError,
			ErrorBody{Error: "Внутренняя ошибка сервера", Code: "internal"})
	}

	var apiErr APIError
	if errors.As(err, &apiErr) {
		return JSON(c, apiErr.Status, ErrorBody{Error: apiErr.Message, Code: apiErr.Code})
	}

	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		switch pgErr.Code {
		case "23505":
			return JSON(c, fiber.StatusConflict, ErrorBody{Error: "Такая запись уже существует", Code: "conflict"})
		case "23503":
			return JSON(c, fiber.StatusBadRequest, ErrorBody{Error: "Ссылка на несуществующий объект", Code: "bad_reference"})
		case "23514":
			return JSON(c, fiber.StatusBadRequest, ErrorBody{Error: "Значение не прошло проверку", Code: "check_failed"})
		case "42501":
			// Сюда попадают отказы RLS. Раньше наружу уходило только
			// «Недостаточно прав» — по такому ответу невозможно понять,
			// какая политика и на какой таблице отказала, а причин может
			// быть несколько в одной транзакции. Вне production
			// возвращаем таблицу и текст СУБД.
			slog.Warn("отказ политики доступа",
				"table", pgErr.TableName, "message", pgErr.Message,
				"detail", pgErr.Detail, "path", c.Path(), "method", c.Method())
			if !isProduction() {
				return JSON(c, fiber.StatusForbidden, ErrorBody{
					Error: "Недостаточно прав: " + pgErr.Message,
					Code:  "forbidden",
					Details: map[string]string{
						"table":  pgErr.TableName,
						"detail": pgErr.Detail,
						"hint":   pgErr.Hint,
					},
				})
			}
			return JSON(c, fiber.StatusForbidden, ErrorBody{Error: "Недостаточно прав", Code: "forbidden"})
		}
	}

	// Подробности ошибки PostgreSQL попадают и в лог, и (вне production)
	// в тело ответа. Без этого «ошибка 500» на клиенте не содержит
	// вообще ничего, по чему можно понять причину, и разбор превращается
	// в угадывание. В production наружу по-прежнему уходит только общая
	// формулировка: сообщения СУБД раскрывают структуру базы.
	if pgErr != nil {
		slog.Error("ошибка базы данных",
			"code", pgErr.Code, "message", pgErr.Message, "detail", pgErr.Detail,
			"table", pgErr.TableName, "column", pgErr.ColumnName,
			"constraint", pgErr.ConstraintName,
			"path", c.Path(), "method", c.Method())

		if !isProduction() {
			return JSON(c, fiber.StatusInternalServerError, ErrorBody{
				Error: "Ошибка базы данных: " + pgErr.Message,
				Code:  "db_" + pgErr.Code,
				Details: map[string]string{
					"detail":     pgErr.Detail,
					"table":      pgErr.TableName,
					"column":     pgErr.ColumnName,
					"constraint": pgErr.ConstraintName,
					"hint":       pgErr.Hint,
				},
			})
		}
	} else {
		slog.Error("внутренняя ошибка", "error", err, "path", c.Path(), "method", c.Method())
		if !isProduction() {
			return JSON(c, fiber.StatusInternalServerError, ErrorBody{
				Error: "Внутренняя ошибка: " + err.Error(),
				Code:  "internal",
			})
		}
	}

	return JSON(c, fiber.StatusInternalServerError, ErrorBody{Error: "Внутренняя ошибка сервера", Code: "internal"})
}

// Определяется один раз при старте: httpx не должен зависеть от пакета
// config, иначе получится цикл импорта.
var production bool

func SetProduction(v bool) { production = v }
func isProduction() bool   { return production }

// Decode — строгий разбор JSON (запрещены неизвестные поля), в отличие
// от стандартного c.BodyParser, который их молча пропускает. Опечатка
// в имени поля на фронте должна быть видна как ошибка запроса, а не
// тихо проигнорирована.
func Decode(c *fiber.Ctx, dst any) error {
	body := c.Body()
	if len(body) == 0 {
		return nil
	}
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		return Err(fiber.StatusBadRequest, "malformed_json", "Не удалось разобрать тело запроса: "+err.Error())
	}
	return nil
}

func UUIDParam(c *fiber.Ctx, name string) (uuid.UUID, error) {
	id, err := uuid.Parse(c.Params(name))
	if err != nil {
		return uuid.Nil, Err(fiber.StatusBadRequest, "bad_uuid", "Некорректный идентификатор «"+name+"»")
	}
	return id, nil
}

func QueryInt(c *fiber.Ctx, name string, def, min, max int) int {
	v, err := strconv.Atoi(c.Query(name))
	if err != nil {
		return def
	}
	if v < min {
		return min
	}
	if v > max {
		return max
	}
	return v
}
