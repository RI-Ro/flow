// Package realtime держит активные WebSocket-соединения и рассылает по
// ним события. Кому рассылать — решает не этот пакет: список
// получателей вычисляется в базе теми же правилами, что и политики RLS
// (app.board_watchers / app.task_watchers в 0003_rls.sql) и передаётся
// сюда готовым. Хаб отвечает только за доставку.
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
	writeWait    = 10 * time.Second
	// Размер очереди на соединение. События мелкие, а всплески бывают
	// при массовых операциях: сохранение колонок шлёт событие на каждую
	// затронутую задачу.
	sendBuffer = 64
)

type Hub struct {
	mu    sync.RWMutex
	conns map[uuid.UUID]map[*Conn]struct{}
}

// Conn — соединение с собственной очередью отправки.
//
// Почему очередь, а не прямая запись под мьютексом (как было раньше):
// WriteMessage блокируется, когда TCP-буфер получателя переполнен —
// например, у клиента с плохой сетью или у вкладки, усыплённой
// браузером. Рассылка идёт по получателям последовательно, поэтому
// один такой клиент задерживал ВСЮ рассылку, и остальные участники
// получали события с задержкой или не получали вовсе, если запись
// зависала до разрыва по таймауту.
//
// Теперь запись выполняет отдельная горутина на соединение, а SendTo
// только кладёт готовый кадр в очередь и никогда не блокируется. Если
// очередь переполнена — клиент безнадёжно отстал, и его соединение
// закрывается: он переподключится и получит состояние заново, что
// заведомо лучше, чем тормозить рассылку всем остальным.
type Conn struct {
	ws     *websocket.Conn
	send   chan []byte
	closeC chan struct{}
	once   sync.Once
}

func NewHub() *Hub {
	return &Hub{conns: make(map[uuid.UUID]map[*Conn]struct{})}
}

// Register регистрирует соединение и запускает его писателя.
// Возвращённый *Conn нужно передать в Unregister при закрытии.
func (h *Hub) Register(userID uuid.UUID, ws *websocket.Conn) *Conn {
	c := &Conn{
		ws:     ws,
		send:   make(chan []byte, sendBuffer),
		closeC: make(chan struct{}),
	}

	h.mu.Lock()
	if h.conns[userID] == nil {
		h.conns[userID] = make(map[*Conn]struct{})
	}
	h.conns[userID][c] = struct{}{}
	h.mu.Unlock()

	go c.writeLoop()
	return c
}

func (h *Hub) Unregister(userID uuid.UUID, c *Conn) {
	c.close()

	h.mu.Lock()
	defer h.mu.Unlock()
	if set, ok := h.conns[userID]; ok {
		delete(set, c)
		if len(set) == 0 {
			delete(h.conns, userID)
		}
	}
}

// Disconnect обрывает все соединения пользователя: при блокировке или
// удалении учётной записи. Сам WebSocket проверяет права только на
// рукопожатии, поэтому уже открытое соединение продолжало бы получать
// события.
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

// ConnectedUsers — число пользователей с хотя бы одним живым
// соединением. Используется в /healthz.
func (h *Hub) ConnectedUsers() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.conns)
}

// Connections — общее число соединений: у одного человека их столько,
// сколько открытых вкладок.
func (h *Hub) Connections() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	n := 0
	for _, set := range h.conns {
		n += len(set)
	}
	return n
}

type Event struct {
	Type    string `json:"type"`
	Action  string `json:"action,omitempty"`
	Payload any    `json:"payload,omitempty"`
}

// SendTo рассылает событие указанным пользователям. Не блокируется
// никогда: сериализация выполняется один раз на всю рассылку, а
// доставка идёт через очереди соединений.
func (h *Hub) SendTo(userIDs []uuid.UUID, event Event) {
	if len(userIDs) == 0 {
		return
	}
	data, err := json.Marshal(event)
	if err != nil {
		slog.Error("не удалось сериализовать событие", "error", err, "type", event.Type)
		return
	}

	// Снимок получателей под чтением, отправка — уже вне блокировки:
	// держать RLock во время доставки незачем, а мешать регистрации
	// новых соединений — вредно.
	h.mu.RLock()
	targets := make([]*Conn, 0, len(userIDs))
	for _, uid := range userIDs {
		for c := range h.conns[uid] {
			targets = append(targets, c)
		}
	}
	h.mu.RUnlock()

	for _, c := range targets {
		c.enqueue(data)
	}
}

// enqueue кладёт кадр в очередь соединения. Переполнение означает, что
// клиент не успевает читать; такое соединение закрывается — клиент
// переподключится и загрузит состояние заново.
func (c *Conn) enqueue(data []byte) {
	select {
	case <-c.closeC:
		return
	default:
	}

	select {
	case c.send <- data:
	default:
		slog.Warn("очередь соединения переполнена, закрываем — клиент не успевает читать")
		c.close()
	}
}

// writeLoop — единственное место, где выполняется запись в сокет.
// Библиотека не допускает конкурентную запись, и одна горутина на
// соединение снимает этот вопрос полностью: мьютекс вокруг записи
// больше не нужен.
func (c *Conn) writeLoop() {
	ticker := time.NewTicker(pingInterval)
	defer func() {
		ticker.Stop()
		_ = c.ws.Close()
	}()

	for {
		select {
		case <-c.closeC:
			// Прощальный кадр по возможности, но без ожидания.
			_ = c.ws.SetWriteDeadline(time.Now().Add(time.Second))
			_ = c.ws.WriteMessage(websocket.CloseMessage,
				websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""))
			return

		case data := <-c.send:
			// Крайний срок обязателен: без него запись в мёртвое
			// соединение висит до таймаута операционной системы —
			// десятки минут, всё это время занимая горутину.
			if err := c.ws.SetWriteDeadline(time.Now().Add(writeWait)); err != nil {
				return
			}
			if err := c.ws.WriteMessage(websocket.TextMessage, data); err != nil {
				slog.Debug("запись в сокет не удалась, закрываем", "error", err)
				return
			}

		case <-ticker.C:
			if err := c.ws.SetWriteDeadline(time.Now().Add(writeWait)); err != nil {
				return
			}
			if err := c.ws.WriteMessage(websocket.PingMessage, nil); err != nil {
				// Соединение мертво: закрываем, чтобы блокирующий
				// ReadMessage в обработчике вернул ошибку и освободил
				// свою горутину через defer Unregister.
				return
			}
		}
	}
}

func (c *Conn) close() {
	c.once.Do(func() { close(c.closeC) })
}
