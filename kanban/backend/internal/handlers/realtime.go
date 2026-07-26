package handlers

import (
	"context"
	"log/slog"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/websocket/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/example/kanban/internal/models"
	"github.com/example/kanban/internal/realtime"
)

// wsAuth проверяет access-токен из query-параметра ДО апгрейда
// соединения (в момент апгрейда заголовок Authorization браузер
// выставить не может — соединение открывает конструктор WebSocket,
// а не fetch) и кладёт userID в Locals под тем же ключом, что кладёт
// обычный REST middleware, чтобы значение доехало до wsHandler через
// механизм gofiber/websocket, копирующий Locals в момент апгрейда.
func (s *Server) wsAuth(c *fiber.Ctx) error {
	if !websocket.IsWebSocketUpgrade(c) {
		return fiber.NewError(fiber.StatusUpgradeRequired, "Требуется WebSocket-подключение")
	}
	token := c.Query("access_token")
	userID, err := s.auth.ParseAccess(token)
	if err != nil {
		return fiber.NewError(fiber.StatusUnauthorized, "Требуется вход в систему")
	}

	// Состояние учётной записи проверяется именно здесь, а не только в
	// middleware Auth для REST. Hub.Disconnect обрывает уже открытые
	// соединения заблокированного пользователя, но без этой проверки он
	// тут же открыл бы новое: access-токен остаётся подписанным и
	// валидным ещё до 15 минут после блокировки. Соединение живёт долго,
	// поэтому один запрос к базе на рукопожатие погоды не делает —
	// в отличие от такой же проверки на каждый REST-вызов.
	var (
		active  bool
		deleted bool
		role    string
	)
	if e := s.db.AsService(c.Context(), func(tx pgx.Tx) error {
		return tx.QueryRow(c.Context(),
			`SELECT is_active, deleted, role FROM app.account_state($1)`, userID).
			Scan(&active, &deleted, &role)
	}); e != nil {
		return fiber.NewError(fiber.StatusUnauthorized, "Требуется вход в систему")
	}
	if deleted || !active {
		return fiber.NewError(fiber.StatusForbidden, "Учётная запись отключена")
	}

	c.Locals(wsUserIDKey, userID)
	return c.Next()
}

const wsUserIDKey = "wsUserID"

// wsHandler держит соединение живым до разрыва. Сама рассылка событий
// в это соединение происходит не отсюда, а из hub.SendTo — вызванного
// из обработчиков мутаций где угодно в приложении. Цикл чтения нужен
// только чтобы: 1) обнаружить разрыв соединения (ReadMessage вернёт
// ошибку) и освободить горутину; 2) дать библиотеке обработать
// control-фреймы (pong в ответ на наш ping из hub.pingLoop).
func (s *Server) wsHandler(c *websocket.Conn) {
	userID, ok := c.Locals(wsUserIDKey).(uuid.UUID)
	if !ok || userID == uuid.Nil {
		_ = c.Close()
		return
	}

	conn := s.hub.Register(userID, c)
	defer s.hub.Unregister(userID, conn)

	for {
		if _, _, err := c.ReadMessage(); err != nil {
			return
		}
	}
}

// bgContext — отдельный контекст для фоновой публикации событий.
// c.Context() из fiber/fasthttp привязан к RequestCtx, который
// пересоздаётся сразу после того, как обработчик вернул управление —
// использовать его в горутине, запущенной через `go s.publishX(...)`
// после return, значит читать из уже переиспользованного (а то и
// освобождённого) объекта. Публикация поэтому всегда работает со своим
// независимым контекстом и коротким таймаутом.
func bgContext() (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), 5*time.Second)
}

// ВНИМАНИЕ при правке запросов ниже: board_watchers/task_watchers
// объявлены как RETURNS SETOF uuid. Это одна безымянная колонка,
// названная по имени функции, а не колонка user_id. Запрос вида
// `SELECT user_id FROM app.board_watchers($1)` завершается ошибкой
// «column "user_id" does not exist» — и, поскольку публикация событий
// идёт в фоновой горутине, ошибка попадала только в лог, а снаружи
// выглядела как полное отсутствие синхронизации между пользователями.
func (s *Server) watchersOfBoard(ctx context.Context, boardID uuid.UUID) []uuid.UUID {
	var ids []uuid.UUID
	err := s.db.AsService(ctx, func(tx pgx.Tx) error {
		rows, e := tx.Query(ctx, `SELECT * FROM app.board_watchers($1)`, boardID)
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
		slog.Error("не удалось получить наблюдателей доски", "error", err, "board", boardID)
		return nil
	}
	return ids
}

func (s *Server) watchersOfTask(ctx context.Context, taskID uuid.UUID) []uuid.UUID {
	var ids []uuid.UUID
	err := s.db.AsService(ctx, func(tx pgx.Tx) error {
		rows, e := tx.Query(ctx, `SELECT * FROM app.task_watchers($1)`, taskID)
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
		slog.Error("не удалось получить наблюдателей задачи", "error", err, "task", taskID)
		return nil
	}
	return ids
}

func (s *Server) watchersOfTaskForBoard(ctx context.Context, boardID, taskID uuid.UUID) []uuid.UUID {
	var ids []uuid.UUID
	err := s.db.AsService(ctx, func(tx pgx.Tx) error {
		rows, e := tx.Query(ctx, `SELECT * FROM app.task_watchers_for_board($1, $2)`, boardID, taskID)
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
		slog.Error("не удалось получить наблюдателей удалённой задачи", "error", err, "board", boardID, "task", taskID)
		return nil
	}
	return ids
}

// publishTask рассылает актуальное состояние задачи всем, кому она
// видна — участникам доски и точечным получателям гранта/назначения.
// Вызывается со свежим объектом, который обработчик и так уже вернул
// бы клиенту REST-ответом, поэтому дополнительного похода в базу за
// самой задачей не требуется — только за списком получателей.
func (s *Server) publishTask(task models.Task, action string) {
	ctx, cancel := bgContext()
	defer cancel()
	watchers := s.watchersOfTask(ctx, task.ID)
	s.hub.SendTo(watchers, realtime.Event{Type: "task", Action: action, Payload: task})
}

// publishTaskDeletedTo рассылает событие заранее снятому списку
// получателей. Нужна там, где к моменту публикации связи, определяющие
// наблюдателей, уже удалены каскадом вместе с самой задачей.
func (s *Server) publishTaskDeletedTo(watchers []uuid.UUID, boardID, taskID uuid.UUID) {
	s.hub.SendTo(watchers, realtime.Event{
		Type: "task", Action: "deleted",
		Payload: fiber.Map{"id": taskID, "boardId": boardID},
	})
}

// Получателей ОБЯЗАН снимать вызывающий, до удаления строки:
// task_grants и task_assignees уходят вместе с задачей по каскаду, а
// именно они делают человека наблюдателем. Версия, которая считала
// список сама уже после удаления, находила одних участников доски —
// и у того, кому была открыта только эта задача, она оставалась на
// экране до перезагрузки страницы. Отдельной функции без параметра
// watchers здесь намеренно нет, чтобы эту ошибку нельзя было повторить.

func (s *Server) publishColumns(boardID uuid.UUID, columns []models.Column) {
	ctx, cancel := bgContext()
	defer cancel()
	watchers := s.watchersOfBoard(ctx, boardID)
	s.hub.SendTo(watchers, realtime.Event{
		Type: "columns", Action: "updated",
		Payload: fiber.Map{"boardId": boardID, "columns": columns},
	})
}

func (s *Server) publishBoard(board models.Board, action string) {
	ctx, cancel := bgContext()
	defer cancel()
	watchers := s.watchersOfBoard(ctx, board.ID)
	s.hub.SendTo(watchers, realtime.Event{Type: "board", Action: action, Payload: board})
}

// publishBoardDeleted шлётся отдельно от publishBoard(archived-подобной
// мутации): к моменту рассылки участников в board_members уже нет
// (каскадное удаление), поэтому получателей нужно было собрать ДО
// удаления и передать явным списком.
func (s *Server) publishBoardDeleted(boardID uuid.UUID, watchers []uuid.UUID) {
	s.hub.SendTo(watchers, realtime.Event{Type: "board", Action: "deleted", Payload: fiber.Map{"id": boardID}})
}

// publishBoardMemberAdded уведомляет конкретного нового участника: до
// этого момента доска ему не была видна вообще, поэтому обычная
// рассылка «наблюдателям доски» его бы и не нашла — они вычисляются
// уже ПОСЛЕ вставки строки в board_members, значит формально включают
// и его, но фронту нужен явный сигнал «перечитай список своих
// проектов», а не просто событие board.updated.
// publishAccessRevoked сообщает пользователю, что доступ к проекту у него
// снят.
//
// Отправляется адресно и ТОЛЬКО тем, кого только что убрали. Обычная
// рассылка здесь не работает по определению: board_watchers возвращает
// текущих участников, а снятый в их число уже не входит — он бы не
// получил ровно то событие, которое адресовано именно ему.
//
// Без этого у снятого участника на экране оставалась работоспособная с
// виду копия проекта: RLS блокировала запись, но интерфейс об этом не
// знал и продолжал показывать задачи и принимать ввод до перезагрузки
// страницы.
func (s *Server) publishAccessRevoked(boardID uuid.UUID, userIDs []uuid.UUID, reason string) {
	if len(userIDs) == 0 {
		return
	}
	s.hub.SendTo(userIDs, realtime.Event{
		Type:    "access",
		Action:  "revoked",
		Payload: map[string]any{"boardId": boardID, "reason": reason},
	})
}

// publishTaskAccessRevoked — то же самое для точечного доступа к одной
// задаче: человек не участник доски, у него отозвали грант.
func (s *Server) publishTaskAccessRevoked(boardID, taskID uuid.UUID, userIDs []uuid.UUID) {
	if len(userIDs) == 0 {
		return
	}
	s.hub.SendTo(userIDs, realtime.Event{
		Type:   "access",
		Action: "task_revoked",
		Payload: map[string]any{
			"boardId": boardID,
			"taskId":  taskID,
			"reason":  "Доступ к задаче отозван",
		},
	})
}

func (s *Server) publishBoardMemberAdded(boardID, userID uuid.UUID) {
	s.hub.SendTo([]uuid.UUID{userID}, realtime.Event{
		Type: "board", Action: "member_added",
		Payload: fiber.Map{"boardId": boardID},
	})
}

func (s *Server) publishComment(taskID uuid.UUID, c models.Comment, action string) {
	ctx, cancel := bgContext()
	defer cancel()
	watchers := s.watchersOfTask(ctx, taskID)
	s.hub.SendTo(watchers, realtime.Event{Type: "comment", Action: action, Payload: c})
}

func (s *Server) publishAttachment(taskID uuid.UUID, a models.Attachment, action string) {
	ctx, cancel := bgContext()
	defer cancel()
	watchers := s.watchersOfTask(ctx, taskID)
	s.hub.SendTo(watchers, realtime.Event{Type: "attachment", Action: action, Payload: a})
}

// publishStep — событие уровня чек-листа. Именно этот путь чинит
// «неработающую» отметку выполнения на фронте: раньше клиент узнавал
// об изменении только из ответа собственного запроса, и второй
// открытый таб (или повторный быстрый клик) видели устаревшее
// состояние до следующей полной перезагрузки. Теперь событие приходит
// всем вкладкам сразу, включая ту, что инициировала изменение —
// это не лишняя работа, а гарантия единого источника истины.
func (s *Server) publishStep(taskID uuid.UUID, step models.Step, action string) {
	ctx, cancel := bgContext()
	defer cancel()
	watchers := s.watchersOfTask(ctx, taskID)
	s.hub.SendTo(watchers, realtime.Event{
		Type: "step", Action: action,
		Payload: fiber.Map{"taskId": taskID, "step": step},
	})
}

func (s *Server) publishNotification(userID uuid.UUID, n models.Notification) {
	s.hub.SendTo([]uuid.UUID{userID}, realtime.Event{Type: "notification", Action: "created", Payload: n})
}

// pendingNotif копится внутри AsUser-транзакции и рассылается ПОСЛЕ её
// успешного коммита — WebSocket-событие не должно уйти получателю
// раньше, чем строка реально видна снаружи транзакции: иначе клиент,
// среагировав на событие обычным REST-запросом, получит 404 на ещё не
// закоммиченную запись.
type pendingNotif struct {
	UserID uuid.UUID
	Notif  models.Notification
}

// notifyInsert вставляет уведомление через app.notify (SECURITY DEFINER,
// единственный способ для app_user записать чужую строку notifications)
// и возвращает вставленную запись для последующей публикации.
// notifyTaskWatchers рассылает уведомление всем, кому задача доступна,
// кроме самого инициатора действия. Список получателей считает та же
// SQL-функция, что и для WebSocket-рассылки, поэтому уведомление не
// может прийти тому, кто задачу не видит.
func (s *Server) notifyTaskWatchers(ctx context.Context, tx pgx.Tx,
	taskID, boardID, actor uuid.UUID, body string) ([]pendingNotif, error) {

	rows, err := tx.Query(ctx, `SELECT * FROM app.task_watchers($1)`, taskID)
	if err != nil {
		return nil, err
	}
	var targets []uuid.UUID
	for rows.Next() {
		var id uuid.UUID
		if e := rows.Scan(&id); e != nil {
			rows.Close()
			return nil, e
		}
		if id != actor {
			targets = append(targets, id)
		}
	}
	rows.Close()
	if e := rows.Err(); e != nil {
		return nil, e
	}

	var out []pendingNotif
	for _, id := range targets {
		n, e := notifyInsert(ctx, tx, id, body, &boardID, &taskID)
		if e != nil {
			return nil, e
		}
		out = append(out, pendingNotif{UserID: id, Notif: n})
	}
	return out, nil
}

func notifyInsert(ctx context.Context, tx pgx.Tx, userID uuid.UUID, body string, boardID, taskID *uuid.UUID) (models.Notification, error) {
	n := models.Notification{Body: body, BoardID: boardID, TaskID: taskID}
	err := tx.QueryRow(ctx, `SELECT id, created_at FROM app.notify($1, $2, $3, $4)`,
		userID, body, boardID, taskID).Scan(&n.ID, &n.CreatedAt)
	return n, err
}

func (s *Server) flushNotifs(pending []pendingNotif) {
	for _, p := range pending {
		go s.publishNotification(p.UserID, p.Notif)
	}
}

// notifyWatchers создаёт уведомление всем, кому доступна задача, кроме
// самого инициатора, и сразу шлёт им событие — чтобы счётчик на
// колокольчике и звук сработали без перезагрузки.
//
// Получателей считает SQL-функция app.notify_task_watchers: она
// опирается на тот же app.task_watchers, что и обычная рассылка, то
// есть на правила RLS. Повторять эту логику на стороне Go нельзя —
// она неминуемо разойдётся с политиками.
func (s *Server) notifyWatchers(ctx context.Context, tx pgx.Tx, taskID, actor uuid.UUID, body string) ([]uuid.UUID, error) {
	rows, err := tx.Query(ctx,
		`SELECT * FROM app.notify_task_watchers($1, $2, $3)`, taskID, actor, body)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var ids []uuid.UUID
	for rows.Next() {
		var id uuid.UUID
		if e := rows.Scan(&id); e != nil {
			return nil, e
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// pingNotifications — лёгкое событие «есть новое уведомление».
// Содержимое не передаётся: панель уведомлений всё равно запрашивает
// список сама, а здесь важно лишь вовремя обновить счётчик и дать звук.
func (s *Server) pingNotifications(userIDs []uuid.UUID) {
	if len(userIDs) == 0 {
		return
	}
	s.hub.SendTo(userIDs, realtime.Event{
		Type: "notification", Action: "created",
	})
}
