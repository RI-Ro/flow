package handlers

import (
	"errors"
	"strings"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/example/kanban/internal/httpx"
	"github.com/example/kanban/internal/models"
	"github.com/example/kanban/internal/storage"
)

// ListBoards возвращает только те доски, где пользователь состоит
// участником. Доски, где ему открыта одна задача, сюда не попадают —
// они живут во «Входящих».
func (s *Server) ListBoards(c *fiber.Ctx) error {
	uid := s.uid(c)
	boards := []models.Board{}

	err := s.db.AsUser(c.Context(), uid, func(tx pgx.Tx) error {
		rows, e := tx.Query(c.Context(), `
			SELECT b.id, b.title, b.description, b.bg_preset, b.bg_file_id, b.bg_blur,
			       b.archived, m.role::text, b.updated_at
			  FROM app.boards b
			  JOIN app.board_members m ON m.board_id = b.id AND m.user_id = $1
			 ORDER BY b.title`, uid)
		if e != nil {
			return e
		}
		defer rows.Close()
		for rows.Next() {
			var b models.Board
			if e := rows.Scan(&b.ID, &b.Title, &b.Description, &b.BgPreset, &b.BgFileID,
				&b.BgBlur, &b.Archived, &b.MyRole, &b.UpdatedAt); e != nil {
				return e
			}
			boards = append(boards, b)
		}
		return rows.Err()
	})
	if err != nil {
		return httpx.Fail(c, err)
	}
	return httpx.JSON(c, fiber.StatusOK, boards)
}

func (s *Server) GetBoard(c *fiber.Ctx) error {
	boardID, err := param(c, "boardID")
	if err != nil {
		return httpx.Fail(c, err)
	}
	uid := s.uid(c)

	var b models.Board
	err = s.db.AsUser(c.Context(), uid, func(tx pgx.Tx) error {
		e := tx.QueryRow(c.Context(), `
			SELECT b.id, b.title, b.description, b.bg_preset, b.bg_file_id, b.bg_blur,
			       b.archived, COALESCE(app.board_role(b.id, $2), ''), b.updated_at
			  FROM app.boards b WHERE b.id = $1`, boardID, uid).
			Scan(&b.ID, &b.Title, &b.Description, &b.BgPreset, &b.BgFileID,
				&b.BgBlur, &b.Archived, &b.MyRole, &b.UpdatedAt)
		if e != nil {
			return e
		}

		rows, e := tx.Query(c.Context(),
			`SELECT user_id, role::text FROM app.board_members WHERE board_id = $1`, boardID)
		if e != nil {
			return e
		}
		defer rows.Close()
		for rows.Next() {
			var m models.BoardMember
			if e := rows.Scan(&m.UserID, &m.Role); e != nil {
				return e
			}
			b.Members = append(b.Members, m)
		}
		return rows.Err()
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return httpx.Fail(c, httpx.ErrNotFound)
	}
	if err != nil {
		return httpx.Fail(c, err)
	}
	return httpx.JSON(c, fiber.StatusOK, b)
}

type boardInput struct {
	Title       string `json:"title"`
	Description string `json:"description"`
	BgPreset    string `json:"bgPreset"`
	BgBlur      bool   `json:"bgBlur"`
}

var defaultColumns = []struct {
	Title  string
	Color  string
	Wip    int
	IsDone bool
}{
	{"К выполнению", "#8892A8", 0, false},
	{"В работе", "#C99A2E", 4, false},
	{"На проверке", "#8B6BB1", 3, false},
	{"На согласовании", "#3D9B94", 3, false},
	{"На докладе", "#C2703D", 2, false},
	{"Готово", "#4F9B6A", 0, true},
}

func (s *Server) CreateBoard(c *fiber.Ctx) error {
	var in boardInput
	if err := httpx.Decode(c, &in); err != nil {
		return httpx.Fail(c, err)
	}
	in.Title = strings.TrimSpace(in.Title)
	if in.Title == "" {
		return httpx.Fail(c, httpx.Err(fiber.StatusBadRequest, "empty_title", "Название проекта не может быть пустым"))
	}
	if in.BgPreset == "" {
		in.BgPreset = "none"
	}
	uid := s.uid(c)

	boardID := uuid.New()
	err := s.db.AsUser(c.Context(), uid, func(tx pgx.Tx) error {
		// Строка в board_members с ролью owner создаётся триггером
		// boards_owner_bootstrap — до неё политики ещё не пропустили бы
		// пользователя к собственной свежесозданной доске.
		// Идентификатор задаём сами — по той же причине, что и у задач:
		// политика boards_select проверяет доступ через
		// app.can_see_board(), которая читает app.board_members, а
		// строку владельца туда добавляет триггер boards_owner_bootstrap
		// уже ПОСЛЕ вставки. Во время INSERT ... RETURNING участника
		// ещё нет, политика отвечает «не видно», и создание проекта
		// отвергается как отказ доступа.
		if _, e := tx.Exec(c.Context(), `
			INSERT INTO app.boards (id, title, description, bg_preset, bg_blur, created_by)
			VALUES ($1, $2, $3, $4, $5, $6)`,
			boardID, in.Title, in.Description, in.BgPreset, in.BgBlur, uid); e != nil {
			return e
		}
		for i, col := range defaultColumns {
			if _, e := tx.Exec(c.Context(), `
				INSERT INTO app.columns (board_id, title, color, position, wip_limit, is_done)
				VALUES ($1, $2, $3, $4, $5, $6)`,
				boardID, col.Title, col.Color, i, col.Wip, col.IsDone); e != nil {
				return e
			}
		}
		return nil
	})
	if err != nil {
		return httpx.Fail(c, err)
	}
	return httpx.JSON(c, fiber.StatusCreated, fiber.Map{"id": boardID})
}

type boardPatch struct {
	Title       *string `json:"title"`
	Description *string `json:"description"`
	BgPreset    *string `json:"bgPreset"`
	BgBlur      *bool   `json:"bgBlur"`
	Archived    *bool   `json:"archived"`
}

func (s *Server) UpdateBoard(c *fiber.Ctx) error {
	boardID, err := param(c, "boardID")
	if err != nil {
		return httpx.Fail(c, err)
	}
	var in boardPatch
	if err := httpx.Decode(c, &in); err != nil {
		return httpx.Fail(c, err)
	}

	var affected int64
	err = s.db.AsUser(c.Context(), s.uid(c), func(tx pgx.Tx) error {
		tag, e := tx.Exec(c.Context(), `
			UPDATE app.boards SET
				title       = COALESCE($2, title),
				description = COALESCE($3, description),
				bg_preset   = COALESCE($4, bg_preset),
				bg_blur     = COALESCE($5, bg_blur),
				archived    = COALESCE($6, archived)
			WHERE id = $1`,
			boardID, in.Title, in.Description, in.BgPreset, in.BgBlur, in.Archived)
		affected = tag.RowsAffected()
		return e
	})
	if err != nil {
		return httpx.Fail(c, err)
	}
	if affected == 0 {
		return httpx.Fail(c, httpx.ErrForbidden)
	}

	board, err := s.fetchBoard(c, boardID)
	if err != nil {
		return httpx.Fail(c, err)
	}
	go s.publishBoard(board, "updated")
	return httpx.JSON(c, fiber.StatusOK, board)
}

// fetchBoard — та же выборка, что GetBoard, но возвращает значение
// напрямую для повторного использования из обработчиков, которым нужен
// объект доски для публикации события, а не для ответа клиенту.
func (s *Server) fetchBoard(c *fiber.Ctx, boardID uuid.UUID) (models.Board, error) {
	var b models.Board
	uid := s.uid(c)
	err := s.db.AsUser(c.Context(), uid, func(tx pgx.Tx) error {
		e := tx.QueryRow(c.Context(), `
			SELECT b.id, b.title, b.description, b.bg_preset, b.bg_file_id, b.bg_blur,
			       b.archived, COALESCE(app.board_role(b.id, $2), ''), b.updated_at
			  FROM app.boards b WHERE b.id = $1`, boardID, uid).
			Scan(&b.ID, &b.Title, &b.Description, &b.BgPreset, &b.BgFileID,
				&b.BgBlur, &b.Archived, &b.MyRole, &b.UpdatedAt)
		if e != nil {
			return e
		}
		rows, e := tx.Query(c.Context(),
			`SELECT user_id, role::text FROM app.board_members WHERE board_id = $1`, boardID)
		if e != nil {
			return e
		}
		defer rows.Close()
		for rows.Next() {
			var m models.BoardMember
			if e := rows.Scan(&m.UserID, &m.Role); e != nil {
				return e
			}
			b.Members = append(b.Members, m)
		}
		return rows.Err()
	})
	return b, err
}

func (s *Server) DeleteBoard(c *fiber.Ctx) error {
	boardID, err := param(c, "boardID")
	if err != nil {
		return httpx.Fail(c, err)
	}
	uid := s.uid(c)

	// Список наблюдателей нужно снять ДО удаления: после DELETE
	// board_members опустеет каскадом, и рассылать «проект удалён»
	// будет некому.
	watchCtx, cancel := bgContext()
	watchers := s.watchersOfBoard(watchCtx, boardID)
	cancel()

	var affected int64
	err = s.db.AsUser(c.Context(), uid, func(tx pgx.Tx) error {
		tag, e := tx.Exec(c.Context(), `DELETE FROM app.boards WHERE id = $1`, boardID)
		affected = tag.RowsAffected()
		return e
	})
	if err != nil {
		return httpx.Fail(c, err)
	}
	if affected == 0 {
		return httpx.Fail(c, httpx.ErrForbidden)
	}
	go s.publishBoardDeleted(boardID, watchers)
	return httpx.NoContent(c)
}

// ---------------------------------------------------------------- фон

func (s *Server) UploadBackground(c *fiber.Ctx) error {
	boardID, err := param(c, "boardID")
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
	if !strings.HasPrefix(stored.MIME, "image/") {
		_ = s.files.Delete(stored.Key)
		return httpx.Fail(c, httpx.Err(fiber.StatusBadRequest, "not_an_image", "Фоном может быть только изображение"))
	}

	var fileID uuid.UUID
	var affected int64
	err = s.db.AsUser(c.Context(), uid, func(tx pgx.Tx) error {
		if e := tx.QueryRow(c.Context(), `
			INSERT INTO app.files (owner_id, storage_key, filename, mime_type, size_bytes, checksum)
			VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
			uid, stored.Key, stored.Filename, stored.MIME, stored.Size, stored.Checksum).Scan(&fileID); e != nil {
			return e
		}
		tag, e := tx.Exec(c.Context(),
			`UPDATE app.boards SET bg_file_id = $2, bg_preset = 'custom' WHERE id = $1`, boardID, fileID)
		affected = tag.RowsAffected()
		return e
	})
	if err != nil || affected == 0 {
		_ = s.files.Delete(stored.Key)
		if affected == 0 && err == nil {
			return httpx.Fail(c, httpx.ErrForbidden)
		}
		return httpx.Fail(c, err)
	}

	if board, e := s.fetchBoard(c, boardID); e == nil {
		go s.publishBoard(board, "updated")
	}
	return httpx.JSON(c, fiber.StatusCreated, fiber.Map{"fileId": fileID})
}

func (s *Server) GetBackground(c *fiber.Ctx) error {
	boardID, err := param(c, "boardID")
	if err != nil {
		return httpx.Fail(c, err)
	}

	var key, mimeType, filename string
	err = s.db.AsUser(c.Context(), s.uid(c), func(tx pgx.Tx) error {
		return tx.QueryRow(c.Context(), `
			SELECT f.storage_key, f.mime_type, f.filename
			  FROM app.boards b JOIN app.files f ON f.id = b.bg_file_id
			 WHERE b.id = $1`, boardID).Scan(&key, &mimeType, &filename)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return httpx.Fail(c, httpx.ErrNotFound)
	}
	if err != nil {
		return httpx.Fail(c, err)
	}
	return s.stream(c, key, mimeType, filename, false)
}

func (s *Server) DeleteBackground(c *fiber.Ctx) error {
	boardID, err := param(c, "boardID")
	if err != nil {
		return httpx.Fail(c, err)
	}
	err = s.db.AsUser(c.Context(), s.uid(c), func(tx pgx.Tx) error {
		_, e := tx.Exec(c.Context(),
			`UPDATE app.boards SET bg_file_id = NULL, bg_preset = 'none' WHERE id = $1`, boardID)
		return e
	})
	if err != nil {
		return httpx.Fail(c, err)
	}
	if board, e := s.fetchBoard(c, boardID); e == nil {
		go s.publishBoard(board, "updated")
	}
	return httpx.NoContent(c)
}

func (s *Server) stream(c *fiber.Ctx, key, mimeType, filename string, forceDownload bool) error {
	f, err := s.files.Open(key)
	if err != nil {
		return httpx.Fail(c, httpx.ErrNotFound)
	}
	// Закрывать файл здесь НЕЛЬЗЯ. SendStream только запоминает
	// источник, а читает из него fasthttp уже после возврата из
	// обработчика — defer закрыл бы файл раньше, чем начнётся отдача,
	// и любой запрос за содержимым (фон доски, миниатюра вложения,
	// скачивание) отвечал бы 500. Закрытие делает сам fasthttp:
	// SetBodyStream вызывает Close, если источник реализует io.Closer,
	// а *os.File его реализует.
	c.Set("Content-Type", mimeType)
	c.Set("Content-Disposition", storage.Disposition(mimeType, filename, forceDownload))
	c.Set("Cache-Control", "private, max-age=3600")
	c.Set("X-Content-Type-Options", "nosniff")
	return c.SendStream(f)
}

// ------------------------------------------------------------ участники

type memberInput struct {
	UserID uuid.UUID `json:"userId"`
	Role   string    `json:"role"`
}

func (s *Server) SetMembers(c *fiber.Ctx) error {
	boardID, err := param(c, "boardID")
	if err != nil {
		return httpx.Fail(c, err)
	}
	var in []memberInput
	if err := httpx.Decode(c, &in); err != nil {
		return httpx.Fail(c, err)
	}
	uid := s.uid(c)

	var pending []pendingNotif
	var removed []uuid.UUID
	err = s.db.AsUser(c.Context(), uid, func(tx pgx.Tx) error {
		var role string
		if e := tx.QueryRow(c.Context(),
			`SELECT COALESCE(app.board_role($1, $2), '')`, boardID, uid).Scan(&role); e != nil {
			return e
		}
		if role != "owner" {
			return httpx.ErrForbidden
		}

		// Состав ДО изменения нужен, чтобы вычислить снятых. После
		// DELETE узнать, кто был участником, уже неоткуда, а именно им
		// нужно отправить событие об отзыве доступа.
		before := map[uuid.UUID]bool{}
		rows, e := tx.Query(c.Context(),
			`SELECT user_id FROM app.board_members WHERE board_id = $1 AND role <> 'owner'`, boardID)
		if e != nil {
			return e
		}
		for rows.Next() {
			var id uuid.UUID
			if e := rows.Scan(&id); e != nil {
				rows.Close()
				return e
			}
			before[id] = true
		}
		rows.Close()
		if e := rows.Err(); e != nil {
			return e
		}

		stays := map[uuid.UUID]bool{}
		for _, m := range in {
			if m.Role == "editor" || m.Role == "reader" {
				stays[m.UserID] = true
			}
		}
		for id := range before {
			if !stays[id] {
				removed = append(removed, id)
			}
		}

		if _, e := tx.Exec(c.Context(),
			`DELETE FROM app.board_members WHERE board_id = $1 AND role <> 'owner'`, boardID); e != nil {
			return e
		}
		for _, m := range in {
			if m.Role != "editor" && m.Role != "reader" {
				continue
			}
			if _, e := tx.Exec(c.Context(), `
				INSERT INTO app.board_members (board_id, user_id, role)
				VALUES ($1, $2, $3::app.board_role)
				ON CONFLICT (board_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
				boardID, m.UserID, m.Role); e != nil {
				return e
			}
			n, e := notifyInsert(c.Context(), tx, m.UserID, "Вам открыт доступ к проекту", &boardID, nil)
			if e != nil {
				return e
			}
			pending = append(pending, pendingNotif{UserID: m.UserID, Notif: n})
		}
		return nil
	})
	if err != nil {
		return httpx.Fail(c, err)
	}
	s.flushNotifs(pending)
	for _, m := range in {
		go s.publishBoardMemberAdded(boardID, m.UserID)
	}
	// Снятым участникам — адресное событие: интерфейс закроет у них
	// проект немедленно, не дожидаясь перезагрузки страницы.
	go s.publishAccessRevoked(boardID, removed, "Доступ к проекту закрыт владельцем")

	board, err := s.fetchBoard(c, boardID)
	if err != nil {
		return httpx.Fail(c, err)
	}
	go s.publishBoard(board, "updated")
	return httpx.JSON(c, fiber.StatusOK, board)
}

// -------------------------------------------------------------- колонки

func (s *Server) ListColumns(c *fiber.Ctx) error {
	boardID, err := param(c, "boardID")
	if err != nil {
		return httpx.Fail(c, err)
	}
	cols, err := s.loadColumns(c, boardID)
	if err != nil {
		return httpx.Fail(c, err)
	}
	return httpx.JSON(c, fiber.StatusOK, cols)
}

func (s *Server) loadColumns(c *fiber.Ctx, boardID uuid.UUID) ([]models.Column, error) {
	cols := []models.Column{}
	err := s.db.AsUser(c.Context(), s.uid(c), func(tx pgx.Tx) error {
		rows, e := tx.Query(c.Context(), `
			SELECT id, board_id, title, color, position, wip_limit, is_done
			  FROM app.columns WHERE board_id = $1 ORDER BY position`, boardID)
		if e != nil {
			return e
		}
		defer rows.Close()
		for rows.Next() {
			var col models.Column
			if e := rows.Scan(&col.ID, &col.BoardID, &col.Title, &col.Color,
				&col.Position, &col.WipLimit, &col.IsDone); e != nil {
				return e
			}
			cols = append(cols, col)
		}
		return rows.Err()
	})
	return cols, err
}

type columnInput struct {
	ID       *uuid.UUID `json:"id"`
	Title    string     `json:"title"`
	Color    string     `json:"color"`
	WipLimit int        `json:"wipLimit"`
	IsDone   bool       `json:"isDone"`
}

// SaveColumns принимает итоговый список колонок целиком. Пропавшие
// удаляются, задачи из них переезжают в первую оставшуюся — иначе
// внешний ключ увёл бы задачи в небытие вместе с колонкой.
func (s *Server) SaveColumns(c *fiber.Ctx) error {
	boardID, err := param(c, "boardID")
	if err != nil {
		return httpx.Fail(c, err)
	}
	var in []columnInput
	if err := httpx.Decode(c, &in); err != nil {
		return httpx.Fail(c, err)
	}
	if len(in) == 0 {
		return httpx.Fail(c, httpx.Err(fiber.StatusBadRequest, "no_columns", "На доске должна остаться хотя бы одна колонка"))
	}
	uid := s.uid(c)

	err = s.db.AsUser(c.Context(), uid, func(tx pgx.Tx) error {
		var canEdit bool
		if e := tx.QueryRow(c.Context(),
			`SELECT app.can_edit_board($1, $2)`, boardID, uid).Scan(&canEdit); e != nil {
			return e
		}
		if !canEdit {
			return httpx.ErrForbidden
		}

		kept := make([]uuid.UUID, 0, len(in))
		var firstID uuid.UUID

		for i, col := range in {
			title := strings.TrimSpace(col.Title)
			if title == "" {
				title = "Без названия"
			}
			var id uuid.UUID
			if col.ID != nil {
				if e := tx.QueryRow(c.Context(), `
					UPDATE app.columns
					   SET title = $3, color = $4, position = $5, wip_limit = $6, is_done = $7
					 WHERE id = $1 AND board_id = $2 RETURNING id`,
					*col.ID, boardID, title, col.Color, i, col.WipLimit, col.IsDone).Scan(&id); e != nil {
					return e
				}
			} else {
				if e := tx.QueryRow(c.Context(), `
					INSERT INTO app.columns (board_id, title, color, position, wip_limit, is_done)
					VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
					boardID, title, col.Color, i, col.WipLimit, col.IsDone).Scan(&id); e != nil {
					return e
				}
			}
			kept = append(kept, id)
			if i == 0 {
				firstID = id
			}
		}

		if _, e := tx.Exec(c.Context(), `
			UPDATE app.tasks SET column_id = $2
			 WHERE board_id = $1 AND column_id <> ALL($3::uuid[])`,
			boardID, firstID, kept); e != nil {
			return e
		}
		_, e := tx.Exec(c.Context(),
			`DELETE FROM app.columns WHERE board_id = $1 AND id <> ALL($2::uuid[])`, boardID, kept)
		return e
	})
	if err != nil {
		return httpx.Fail(c, err)
	}

	cols, err := s.loadColumns(c, boardID)
	if err != nil {
		return httpx.Fail(c, err)
	}
	go s.publishColumns(boardID, cols)
	return httpx.JSON(c, fiber.StatusOK, cols)
}
