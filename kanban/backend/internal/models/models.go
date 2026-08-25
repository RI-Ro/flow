package models

import (
	"time"

	"github.com/google/uuid"
)

type User struct {
	ID          uuid.UUID `json:"id"`
	Email       string    `json:"email"`
	FullName    string    `json:"fullName"`
	Position    string    `json:"position"`
	Phone       string    `json:"phone"`
	AvatarColor string    `json:"avatarColor"`
	IsActive    bool      `json:"isActive"`
	Deleted     bool      `json:"deleted"`
	// Роль в системе: member | admin. Это не роль на доске
	// (owner/editor/reader) — та описывает права внутри проекта.
	Role string `json:"role"`
	// Заполняется только в панели администратора: обычному участнику
	// незачем знать, когда кто зарегистрировался.
	CreatedAt *time.Time `json:"createdAt,omitempty"`
	Sessions  int        `json:"sessions,omitempty"`
}

type BoardMember struct {
	UserID uuid.UUID `json:"userId"`
	Role   string    `json:"role"`
}

type Board struct {
	ID          uuid.UUID     `json:"id"`
	Title       string        `json:"title"`
	Description string        `json:"description"`
	BgPreset    string        `json:"bgPreset"`
	BgFileID    *uuid.UUID    `json:"bgFileId"`
	BgBlur      bool          `json:"bgBlur"`
	Archived    bool          `json:"archived"`
	MyRole      string        `json:"myRole"`
	// Дерево проектов. Если родитель недоступен текущему пользователю,
	// клиент кладёт узел в корень — сервер отдаёт parentId как есть.
	ParentID    *uuid.UUID    `json:"parentId"`
	Position    int           `json:"position"`
	CreatedBy   uuid.UUID     `json:"createdBy"`
	Members     []BoardMember `json:"members,omitempty"`
	UpdatedAt   time.Time     `json:"updatedAt"`
}

type Column struct {
	ID       uuid.UUID `json:"id"`
	BoardID  uuid.UUID `json:"boardId"`
	Title    string    `json:"title"`
	Color    string    `json:"color"`
	Position int       `json:"position"`
	WipLimit int       `json:"wipLimit"`
	IsDone   bool      `json:"isDone"`
}

type Step struct {
	ID       uuid.UUID `json:"id"`
	Body     string    `json:"body"`
	Done     bool      `json:"done"`
	Position int       `json:"position"`
}

type Grant struct {
	UserID uuid.UUID `json:"userId"`
	Access string    `json:"access"`
}

type Comment struct {
	ID        uuid.UUID  `json:"id"`
	TaskID    uuid.UUID  `json:"taskId"`
	AuthorID  uuid.UUID  `json:"authorId"`
	Body      string     `json:"body"`
	CreatedAt time.Time  `json:"createdAt"`
	EditedAt  *time.Time `json:"editedAt"`
	CanEdit   bool       `json:"canEdit"`
}

type Attachment struct {
	ID          uuid.UUID  `json:"id"`
	TaskID      uuid.UUID  `json:"taskId"`
	AuthorID    uuid.UUID  `json:"authorId"`
	Filename    string     `json:"filename"`
	Title       string     `json:"title"`
	MIME        string     `json:"mime"`
	Size        int64      `json:"size"`
	CreatedAt   time.Time  `json:"createdAt"`
	EditedAt    *time.Time `json:"editedAt"`
	CanEdit     bool       `json:"canEdit"`
	Previewable bool       `json:"previewable"`
}

type Activity struct {
	ID        uuid.UUID  `json:"id"`
	ActorID   *uuid.UUID `json:"actorId"`
	Body      string     `json:"body"`
	CreatedAt time.Time  `json:"createdAt"`
}

// Task. CreatedBy — автор задачи: используется в первую очередь во
// «Входящих», где человек видит чужой проект впервые и должен понимать,
// кто эту задачу поставил, не открывая карточку.
type Task struct {
	ID          uuid.UUID   `json:"id"`
	BoardID     uuid.UUID   `json:"boardId"`
	BoardTitle  string      `json:"boardTitle,omitempty"`
	ColumnID    uuid.UUID   `json:"columnId"`
	Title       string      `json:"title"`
	Description string      `json:"description"`
	Priority    string      `json:"priority"`
	// Идентификатор цвета из палитры, а не готовый оттенок: конкретные
	// значения зависят от темы и подставляются на клиенте.
	Color       string      `json:"color"`
	DueDate     *string     `json:"dueDate"`
	// Реквизиты входящего документа, по которому заведена задача.
	IncomingNumber string  `json:"incomingNumber"`
	IncomingDate   *string `json:"incomingDate"`
	Position    int         `json:"position"`
	Tags        []string    `json:"tags"`
	CompletedAt *time.Time  `json:"completedAt"`
	CreatedBy   uuid.UUID   `json:"createdBy"`
	Assignees   []uuid.UUID `json:"assignees"`
	// Кто из исполнителей уже отметил свою часть выполненной.
	// Отдельным списком, а не признаком внутри Assignees, чтобы не
	// ломать существующий формат: клиент просто проверяет вхождение.
	AssigneesDone []uuid.UUID `json:"assigneesDone"`
	Grants      []Grant     `json:"grants"`
	Steps       []Step      `json:"steps"`
	CommentCnt  int         `json:"commentCount"`
	AttachCnt   int         `json:"attachmentCount"`
	Access      string      `json:"access"`
	CreatedAt   time.Time   `json:"createdAt"`
	UpdatedAt   time.Time   `json:"updatedAt"`
}

type Notification struct {
	ID        uuid.UUID  `json:"id"`
	Body      string     `json:"body"`
	BoardID   *uuid.UUID `json:"boardId"`
	TaskID    *uuid.UUID `json:"taskId"`
	Read      bool       `json:"read"`
	CreatedAt time.Time  `json:"createdAt"`
}

// Delegation — передача прав заместителю на время отсутствия.
type Delegation struct {
	ID        uuid.UUID `json:"id"`
	GrantorID uuid.UUID `json:"grantorId"`
	DeputyID  uuid.UUID `json:"deputyId"`
	StartsAt  string    `json:"startsAt"`
	EndsAt    string    `json:"endsAt"`
	Note      string    `json:"note"`
	Active    bool      `json:"active"`
}

// TaskLink — связь между задачами: blocks | relates | subtask.
type TaskLink struct {
	ID        uuid.UUID `json:"id"`
	FromTask  uuid.UUID `json:"fromTask"`
	ToTask    uuid.UUID `json:"toTask"`
	Kind      string    `json:"kind"`
	// Заголовок и состояние связанной задачи, чтобы не запрашивать
	// каждую отдельно при отрисовке списка связей.
	Title     string    `json:"title"`
	Completed bool      `json:"completed"`
	BoardID   uuid.UUID `json:"boardId"`
}

// TaskTemplate — заготовка задачи, из которой создаётся экземпляр.
type TaskTemplate struct {
	ID          uuid.UUID   `json:"id"`
	BoardID     *uuid.UUID  `json:"boardId"`
	OwnerID     uuid.UUID   `json:"ownerId"`
	Name        string      `json:"name"`
	Title       string      `json:"title"`
	Description string      `json:"description"`
	Priority    string      `json:"priority"`
	Color       string      `json:"color"`
	Tags        []string    `json:"tags"`
	DueInDays   *int        `json:"dueInDays"`
	Steps       []string    `json:"steps"`
	Assignees   []uuid.UUID `json:"assignees"`
}
