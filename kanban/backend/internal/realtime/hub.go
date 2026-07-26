// Package realtime держит активные WebSocket-соединения и рассылает по
// ним события. Кому конкретно рассылать — решает не этот пакет: список
// получателей вычисляется в базе теми же правилами, что и политики RLS
// (см. app.board_watchers / app.task_watchers в 0002_rls.sql) и
// передаётся сюда уже готовым. Хаб отвечает только за то, кто сейчас
// подключён и как до него безопасно достучаться из многих горутин
// одновременно — ровно то, ради чего Fiber/fasthttp и берут: каждое
// WebSocket-соединение и каждый HTTP-запрос обслуживаются в своей
// горутине, и события в один и тот же коннект могут прийти параллельно
// из обработчиков разных запросов.
package realtime

import (
	"encoding/json"
	"log/slog"
	"sync"
	"time"

	"github.com/gofiber/websocket/v2"
	"github.com/google/uuid"
)

const (
	pingInterval = 25 * time.Second
	pongWait     = 60 * time.Second
)

type Hub struct {
	mu    sync.RWMutex
	conns map[uuid.UUID]map[*Conn]struct{}
}

// Conn оборачивает *websocket.Conn собственным мьютексом: библиотека
// не допускает конкурентную запись из разных горутин в одно соединение,
// а разные события (задача, комментарий, уведомление) могут прилететь
// на рассылку почти одновременно из разных обработчиков запросов.
type Conn struct {
	ws     *websocket.Conn
	mu     sync.Mutex
	closed bool
}

func NewHub() *Hub {
	return &Hub{conns: make(map[uuid.UUID]map[*Conn]struct{})}
}

// Register регистрирует соединение и запускает его собственный цикл
// пингов. Возвращает *Conn, который вызывающий код обязан передать
// в Unregister при закрытии (обычно — в defer сразу после Register).
func (h *Hub) Register(userID uuid.UUID, ws *websocket.Conn) *Conn {
	c := &Conn{ws: ws}

	h.mu.Lock()
	if h.conns[userID] == nil {
		h.conns[userID] = make(map[*Conn]struct{})
	}
	h.conns[userID][c] = struct{}{}
	h.mu.Unlock()

	_ = ws.SetReadDeadline(time.Now().Add(pongWait))
	ws.SetPongHandler(func(string) error {
		return ws.SetReadDeadline(time.Now().Add(pongWait))
	})

	go c.pingLoop()
	return c
}

func (h *Hub) Unregister(userID uuid.UUID, c *Conn) {
	c.mu.Lock()
	c.closed = true
	c.mu.Unlock()

	h.mu.Lock()
	defer h.mu.Unlock()
	if set, ok := h.conns[userID]; ok {
		delete(set, c)
		if len(set) == 0 {
			delete(h.conns, userID)
		}
	}
}

// ConnectedUsers — для /healthz и диагностики: сколько человек сейчас
// на связи по WebSocket.
func (h *Hub) ConnectedUsers() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.conns)
}

// Event — конверт сообщения. Type группирует сущность (task, columns,
// board, comment, attachment, notification), Action — что произошло
// (created/updated/deleted/moved). Payload — уже готовый JSON нужной
// модели (models.Task, models.Comment и т.д.), сериализуется один раз
// на всю рассылку, а не по разу на получателя.
type Event struct {
	Type    string `json:"type"`
	Action  string `json:"action"`
	Payload any    `json:"payload"`
}

// SendTo рассылает событие списку пользователей. Список получен из
// app.board_watchers/app.task_watchers — это уже отфильтрованный по
// правам доступа набор, хабу остаётся только доставить. Пользователи
// без активного соединения просто пропускаются: событие не буферизуется,
// при следующем обычном REST-запросе клиент и так получит актуальное
// состояние.
func (h *Hub) SendTo(userIDs []uuid.UUID, event Event) {
	if len(userIDs) == 0 {
		return
	}
	data, err := json.Marshal(event)
	if err != nil {
		slog.Error("не удалось сериализовать событие реального времени", "error", err)
		return
	}

	h.mu.RLock()
	targets := make([]*Conn, 0, len(userIDs))
	for _, uid := range userIDs {
		for c := range h.conns[uid] {
			targets = append(targets, c)
		}
	}
	h.mu.RUnlock()

	for _, c := range targets {
		c.write(data)
	}
}

// Disconnect обрывает все живые соединения пользователя.
//
// Нужен при блокировке и удалении учётной записи администратором: сам
// WebSocket проверяет права только один раз, на рукопожатии, поэтому
// уже открытое соединение продолжало бы получать события проектов, пока
// клиент его не закроет. Обработчик чтения на другой стороне увидит
// ошибку и штатно снимет регистрацию через Unregister.
func (h *Hub) Disconnect(userID uuid.UUID) {
	h.mu.RLock()
	targets := make([]*Conn, 0, len(h.conns[userID]))
	for c := range h.conns[userID] {
		targets = append(targets, c)
	}
	h.mu.RUnlock()

	for _, c := range targets {
		c.close()
	}
}

// close помечает соединение закрытым и закрывает сокет. Блокирующий
// ReadMessage в обработчике после этого вернёт ошибку и освободит
// горутину через defer Unregister — тот же приём, что и в pingLoop при
// мёртвом соединении.
func (c *Conn) close() {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return
	}
	c.closed = true
	c.mu.Unlock()
	_ = c.ws.Close()
}

func (c *Conn) write(data []byte) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return
	}
	if err := c.ws.WriteMessage(websocket.TextMessage, data); err != nil {
		slog.Debug("не удалось отправить событие в сокет", "error", err)
	}
}

func (c *Conn) pingLoop() {
	ticker := time.NewTicker(pingInterval)
	defer ticker.Stop()

	for range ticker.C {
		c.mu.Lock()
		if c.closed {
			c.mu.Unlock()
			return
		}
		err := c.ws.WriteMessage(websocket.PingMessage, nil)
		c.mu.Unlock()

		if err != nil {
			// Запись не удалась — соединение мертво. Закрываем его,
			// чтобы блокирующий ReadMessage в обработчике вернул
			// ошибку и освободил горутину через defer Unregister.
			_ = c.ws.Close()
			return
		}
	}
}
