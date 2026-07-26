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
	Position    int         `json:"position"`
	Tags        []string    `json:"tags"`
	CompletedAt *time.Time  `json:"completedAt"`
	CreatedBy   uuid.UUID   `json:"createdBy"`
	Assignees   []uuid.UUID `json:"assignees"`
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
