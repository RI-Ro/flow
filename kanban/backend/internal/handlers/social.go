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

// ---------------------------------------------------------- комментарии

func (s *Server) ListComments(c *fiber.Ctx) error {
	taskID, err := param(c, "taskID")
	if err != nil {
		return httpx.Fail(c, err)
	}
	uid := s.uid(c)

	items := []models.Comment{}
	err = s.db.AsUser(c.Context(), uid, func(tx pgx.Tx) error {
		rows, e := tx.Query(c.Context(), `
			SELECT id, task_id, author_id, body, created_at, edited_at
			  FROM app.comments WHERE task_id = $1 ORDER BY created_at`, taskID)
		if e != nil {
			return e
		}
		defer rows.Close()
		for rows.Next() {
			var cm models.Comment
			if e := rows.Scan(&cm.ID, &cm.TaskID, &cm.AuthorID, &cm.Body, &cm.CreatedAt, &cm.EditedAt); e != nil {
				return e
			}
			cm.CanEdit = cm.AuthorID == uid
			items = append(items, cm)
		}
		return rows.Err()
	})
	if err != nil {
		return httpx.Fail(c, err)
	}
	return httpx.JSON(c, fiber.StatusOK, items)
}

type commentInput struct {
	Body string `json:"body"`
}

func (s *Server) CreateComment(c *fiber.Ctx) error {
	taskID, err := param(c, "taskID")
	if err != nil {
		return httpx.Fail(c, err)
	}
	var in commentInput
	if err := httpx.Decode(c, &in); err != nil {
		return httpx.Fail(c, err)
	}
	body := strings.TrimSpace(in.Body)
	if body == "" {
		return httpx.Fail(c, httpx.Err(fiber.StatusBadRequest, "empty_comment", "Комментарий не может быть пустым"))
	}
	uid := s.uid(c)

	var cm models.Comment
	var pending []pendingNotif
	var watchers []uuid.UUID
	err = s.db.AsUser(c.Context(), uid, func(tx pgx.Tx) error {
		if e := tx.QueryRow(c.Context(), `
			INSERT INTO app.comments (task_id, author_id, body) VALUES ($1, $2, $3)
			RETURNING id, task_id, author_id, body, created_at, edited_at`,
			taskID, uid, body).
			Scan(&cm.ID, &cm.TaskID, &cm.AuthorID, &cm.Body, &cm.CreatedAt, &cm.EditedAt); e != nil {
			return e
		}
		if _, e := tx.Exec(c.Context(),
			`INSERT INTO app.activity (task_id, actor_id, body) VALUES ($1, $2, 'Добавлен комментарий')`,
			taskID, uid); e != nil {
			return e
		}

		var boardID uuid.UUID
		if e := tx.QueryRow(c.Context(),
			`SELECT board_id FROM app.tasks WHERE id = $1`, taskID).Scan(&boardID); e != nil {
			return e
		}
		// Уведомление получают все, кому задача доступна: исполнители,
		// участники доски и те, кому её открыли точечно. Отдельной
		// рассылки исполнителям больше нет — они входят в тот же
		// список, и раньше получали два уведомления на один
		// комментарий. Кто именно попадёт в список, решает
		// app.notify_task_watchers по правилам RLS: дублировать эту
		// логику здесь нельзя, она разойдётся с политиками.
		var e error
		watchers, e = s.notifyWatchers(c.Context(), tx, taskID, uid,
			"Новый комментарий в задаче")
		return e
	})
	if err != nil {
		return httpx.Fail(c, err)
	}
	s.flushNotifs(pending)

	cm.CanEdit = true
	go s.publishComment(taskID, cm, "created")
	go s.pingNotifications(watchers)
	return httpx.JSON(c, fiber.StatusCreated, cm)
}

func (s *Server) UpdateComment(c *fiber.Ctx) error {
	id, err := param(c, "id")
	if err != nil {
		return httpx.Fail(c, err)
	}
	var in commentInput
	if err := httpx.Decode(c, &in); err != nil {
		return httpx.Fail(c, err)
	}
	body := strings.TrimSpace(in.Body)
	if body == "" {
		return httpx.Fail(c, httpx.Err(fiber.StatusBadRequest, "empty_comment", "Комментарий не может быть пустым"))
	}
	uid := s.uid(c)

	var cm models.Comment
	err = s.db.AsUser(c.Context(), uid, func(tx pgx.Tx) error {
		// Политика comments_update пропускает только автора — отдельная
		// проверка владельца тут не нужна, ROW не вернётся, если это
		// не так.
		return tx.QueryRow(c.Context(), `
			UPDATE app.comments SET body = $2, edited_at = now() WHERE id = $1
			RETURNING id, task_id, author_id, body, created_at, edited_at`, id, body).
			Scan(&cm.ID, &cm.TaskID, &cm.AuthorID, &cm.Body, &cm.CreatedAt, &cm.EditedAt)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return httpx.Fail(c, httpx.Err(fiber.StatusForbidden, "forbidden", "Править можно только свои комментарии"))
	}
	if err != nil {
		return httpx.Fail(c, err)
	}
	cm.CanEdit = true
	go s.publishComment(cm.TaskID, cm, "updated")
	return httpx.JSON(c, fiber.StatusOK, cm)
}

func (s *Server) DeleteComment(c *fiber.Ctx) error {
	id, err := param(c, "id")
	if err != nil {
		return httpx.Fail(c, err)
	}
	uid := s.uid(c)

	var taskID uuid.UUID
	err = s.db.AsUser(c.Context(), uid, func(tx pgx.Tx) error {
		return tx.QueryRow(c.Context(),
			`DELETE FROM app.comments WHERE id = $1 RETURNING task_id`, id).Scan(&taskID)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return httpx.Fail(c, httpx.ErrForbidden)
	}
	if err != nil {
		return httpx.Fail(c, err)
	}
	go s.publishComment(taskID, models.Comment{ID: id, TaskID: taskID}, "deleted")
	return httpx.NoContent(c)
}

// -------------------------------------------------------------- вложения

var previewable = map[string]bool{
	"image/jpeg": true, "image/png": true, "image/gif": true,
	"image/webp": true, "application/pdf": true,
}

func (s *Server) ListAttachments(c *fiber.Ctx) error {
	taskID, err := param(c, "taskID")
	if err != nil {
		return httpx.Fail(c, err)
	}
	uid := s.uid(c)

	items := []models.Attachment{}
	err = s.db.AsUser(c.Context(), uid, func(tx pgx.Tx) error {
		rows, e := tx.Query(c.Context(), `
			SELECT a.id, a.task_id, a.author_id, f.filename, a.title,
			       f.mime_type, f.size_bytes, a.created_at, a.edited_at
			  FROM app.attachments a JOIN app.files f ON f.id = a.file_id
			 WHERE a.task_id = $1 ORDER BY a.created_at`, taskID)
		if e != nil {
			return e
		}
		defer rows.Close()
		for rows.Next() {
			var a models.Attachment
			if e := rows.Scan(&a.ID, &a.TaskID, &a.AuthorID, &a.Filename, &a.Title,
				&a.MIME, &a.Size, &a.CreatedAt, &a.EditedAt); e != nil {
				return e
			}
			a.CanEdit = a.AuthorID == uid
			a.Previewable = previewable[a.MIME]
			items = append(items, a)
		}
		return rows.Err()
	})
	if err != nil {
		return httpx.Fail(c, err)
	}
	return httpx.JSON(c, fiber.StatusOK, items)
}

func (s *Server) UploadAttachment(c *fiber.Ctx) error {
	taskID, err := param(c, "taskID")
	if err != nil {
		return httpx.Fail(c, err)
	}
	uid := s.uid(c)

	header, err := c.FormFile("file")
	if err != nil {
		return httpx.Fail(c, httpx.Err(fiber.StatusBadRequest, "no_file", "Файл не передан"))
	}
	file, err := header.Open()
	if err != nil {
		return httpx.Fail(c, err)
	}
	defer file.Close()

	stored, err := s.files.Save(file, header.Filename)
	if err != nil {
		return httpx.Fail(c, httpx.Err(fiber.StatusBadRequest, "upload_failed", err.Error()))
	}

	var a models.Attachment
	err = s.db.AsUser(c.Context(), uid, func(tx pgx.Tx) error {
		var fileID uuid.UUID
		if e := tx.QueryRow(c.Context(), `
			INSERT INTO app.files (owner_id, storage_key, filename, mime_type, size_bytes, checksum)
			VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
			uid, stored.Key, stored.Filename, stored.MIME, stored.Size, stored.Checksum).Scan(&fileID); e != nil {
			return e
		}
		if e := tx.QueryRow(c.Context(), `
			INSERT INTO app.attachments (task_id, file_id, author_id, title)
			VALUES ($1, $2, $3, $4)
			RETURNING id, task_id, author_id, title, created_at, edited_at`,
			taskID, fileID, uid, stored.Filename).
			Scan(&a.ID, &a.TaskID, &a.AuthorID, &a.Title, &a.CreatedAt, &a.EditedAt); e != nil {
			return e
		}
		_, e := tx.Exec(c.Context(),
			`INSERT INTO app.activity (task_id, actor_id, body) VALUES ($1, $2, $3)`,
			taskID, uid, "Загружен файл "+stored.Filename)
		return e
	})
	if err != nil {
		_ = s.files.Delete(stored.Key)
		return httpx.Fail(c, err)
	}

	a.Filename = stored.Filename
	a.MIME = stored.MIME
	a.Size = stored.Size
	a.CanEdit = true
	a.Previewable = previewable[stored.MIME]
	go s.publishAttachment(taskID, a, "created")
	return httpx.JSON(c, fiber.StatusCreated, a)
}

// DownloadAttachment отдаёт содержимое. Право на файл вытекает из права
// на задачу: политика files_select пускает к строке только того, кто
// видит вложение. Прямой ссылки на диск не существует.
func (s *Server) DownloadAttachment(c *fiber.Ctx) error {
	id, err := param(c, "id")
	if err != nil {
		return httpx.Fail(c, err)
	}
	forceDownload := c.Query("download") == "1"

	var key, mimeType, filename string
	err = s.db.AsUser(c.Context(), s.uid(c), func(tx pgx.Tx) error {
		return tx.QueryRow(c.Context(), `
			SELECT f.storage_key, f.mime_type, f.filename
			  FROM app.attachments a JOIN app.files f ON f.id = a.file_id
			 WHERE a.id = $1`, id).Scan(&key, &mimeType, &filename)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return httpx.Fail(c, httpx.ErrNotFound)
	}
	if err != nil {
		return httpx.Fail(c, err)
	}
	return s.stream(c, key, mimeType, filename, forceDownload)
}

type attachmentPatch struct {
	Title string `json:"title"`
}

func (s *Server) RenameAttachment(c *fiber.Ctx) error {
	id, err := param(c, "id")
	if err != nil {
		return httpx.Fail(c, err)
	}
	var in attachmentPatch
	if err := httpx.Decode(c, &in); err != nil {
		return httpx.Fail(c, err)
	}
	title := strings.TrimSpace(in.Title)
	if title == "" {
		return httpx.Fail(c, httpx.Err(fiber.StatusBadRequest, "empty_title", "Название не может быть пустым"))
	}

	var a models.Attachment
	var editedAt *time.Time
	err = s.db.AsUser(c.Context(), s.uid(c), func(tx pgx.Tx) error {
		return tx.QueryRow(c.Context(), `
			UPDATE app.attachments SET title = $2, edited_at = now() WHERE id = $1
			RETURNING id, task_id, author_id, title, created_at, edited_at`, id, title).
			Scan(&a.ID, &a.TaskID, &a.AuthorID, &a.Title, &a.CreatedAt, &editedAt)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return httpx.Fail(c, httpx.Err(fiber.StatusForbidden, "forbidden", "Переименовать файл может только загрузивший"))
	}
	if err != nil {
		return httpx.Fail(c, err)
	}
	a.EditedAt = editedAt
	a.CanEdit = true
	go s.publishAttachment(a.TaskID, a, "updated")
	return httpx.JSON(c, fiber.StatusOK, a)
}

func (s *Server) DeleteAttachment(c *fiber.Ctx) error {
	id, err := param(c, "id")
	if err != nil {
		return httpx.Fail(c, err)
	}
	uid := s.uid(c)

	var key string
	var taskID uuid.UUID
	err = s.db.AsUser(c.Context(), uid, func(tx pgx.Tx) error {
		var fileID uuid.UUID
		if e := tx.QueryRow(c.Context(), `
			DELETE FROM app.attachments WHERE id = $1 RETURNING file_id, task_id`, id).
			Scan(&fileID, &taskID); e != nil {
			return e
		}
		if e := tx.QueryRow(c.Context(),
			`DELETE FROM app.files WHERE id = $1 RETURNING storage_key`, fileID).Scan(&key); e != nil {
			return e
		}
		_, e := tx.Exec(c.Context(),
			`INSERT INTO app.activity (task_id, actor_id, body) VALUES ($1, $2, 'Удалён файл')`, taskID, uid)
		return e
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return httpx.Fail(c, httpx.ErrForbidden)
	}
	if err != nil {
		return httpx.Fail(c, err)
	}
	_ = s.files.Delete(key)
	go s.publishAttachment(taskID, models.Attachment{ID: id, TaskID: taskID}, "deleted")
	return httpx.NoContent(c)
}

// --------------------------------------------------------------- история

func (s *Server) ListActivity(c *fiber.Ctx) error {
	taskID, err := param(c, "taskID")
	if err != nil {
		return httpx.Fail(c, err)
	}
	limit := httpx.QueryInt(c, "limit", 50, 1, 200)

	items := []models.Activity{}
	err = s.db.AsUser(c.Context(), s.uid(c), func(tx pgx.Tx) error {
		rows, e := tx.Query(c.Context(), `
			SELECT id, actor_id, body, created_at FROM app.activity
			 WHERE task_id = $1 ORDER BY created_at DESC LIMIT $2`, taskID, limit)
		if e != nil {
			return e
		}
		defer rows.Close()
		for rows.Next() {
			var a models.Activity
			if e := rows.Scan(&a.ID, &a.ActorID, &a.Body, &a.CreatedAt); e != nil {
				return e
			}
			items = append(items, a)
		}
		return rows.Err()
	})
	if err != nil {
		return httpx.Fail(c, err)
	}
	return httpx.JSON(c, fiber.StatusOK, items)
}
