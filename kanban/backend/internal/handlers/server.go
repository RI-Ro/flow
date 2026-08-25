package handlers

import (
	"path/filepath"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/cors"
	"github.com/gofiber/fiber/v2/middleware/limiter"
	"github.com/gofiber/fiber/v2/middleware/logger"
	"github.com/gofiber/fiber/v2/middleware/recover"
	"github.com/gofiber/fiber/v2/middleware/requestid"
	"github.com/gofiber/websocket/v2"
	"github.com/google/uuid"

	"github.com/example/kanban/internal/auth"
	"github.com/example/kanban/internal/config"
	"github.com/example/kanban/internal/database"
	"github.com/example/kanban/internal/httpx"
	mw "github.com/example/kanban/internal/middleware"
	"github.com/example/kanban/internal/realtime"
	"github.com/example/kanban/internal/storage"
)

type Server struct {
	cfg   *config.Config
	db    *database.DB
	auth  *auth.Manager
	files *storage.Local
	hub   *realtime.Hub
}

func New(cfg *config.Config, db *database.DB, am *auth.Manager, files *storage.Local, hub *realtime.Hub) *Server {
	return &Server{cfg: cfg, db: db, auth: am, files: files, hub: hub}
}

// App собирает Fiber-приложение целиком. Prefork намеренно выключен:
// хаб реального времени и пул соединений с БД живут в памяти одного
// процесса, а prefork форкает несколько независимых процессов с
// отдельной памятью каждый — WebSocket-подписчик в одном воркере не
// узнал бы о событии, обработанном в другом. Многопоточность здесь
// получаем не форком процессов, а горутинами: fasthttp (транспорт
// Fiber) обслуживает каждое соединение в своей горутине и задействует
// все ядра через стандартный планировщик Go — этого достаточно на
// порядок выше 300 одновременных пользователей на одной машине.
func (s *Server) App() *fiber.App {
	app := fiber.New(fiber.Config{
		AppName:               "Команда",
		DisableStartupMessage: false,

		// За обратным прокси адрес клиента приходит в X-Forwarded-For,
		// а в самом соединении стоит адрес прокси. Без этих настроек
		// c.IP() возвращал бы адрес прокси для ВСЕХ запросов, и общий
		// лимит частоты складывался бы на всех пользователей сразу:
		// достаточно активный сотрудник исчерпывал бы его за остальных.
		//
		// Доверять заголовку можно только от известных адресов — иначе
		// любой клиент подделает его и обойдёт лимит. Поэтому проверка
		// включается лишь при заданном TRUSTED_PROXIES.
		ProxyHeader:             proxyHeader(s.cfg.TrustedProxies),
		EnableTrustedProxyCheck: len(s.cfg.TrustedProxies) > 0,
		TrustedProxies:          s.cfg.TrustedProxies,
		BodyLimit:             int(s.cfg.MaxUploadBytes) + (2 << 20),
		ReadTimeout:           60 * time.Second,
		WriteTimeout:          120 * time.Second, // с запасом на отдачу больших файлов
		IdleTimeout:           120 * time.Second,
		ErrorHandler: func(c *fiber.Ctx, err error) error {
			if fe, ok := err.(*fiber.Error); ok {
				return httpx.JSON(c, fe.Code, httpx.ErrorBody{Error: fe.Message, Code: "http_error"})
			}
			return httpx.Fail(c, err)
		},
	})

	app.Use(requestid.New())
	app.Use(recover.New(recover.Config{EnableStackTrace: !s.cfg.IsProduction()}))
	app.Use(logger.New(logger.Config{
		Format: "${time} ${status} ${latency} ${method} ${path} reqid=${locals:requestid}\n",
	}))
	app.Use(cors.New(cors.Config{
		AllowOrigins:     joinOrigins(s.cfg.AllowedOrigins),
		AllowMethods:     "GET,POST,PATCH,PUT,DELETE,OPTIONS",
		AllowHeaders:     "Authorization,Content-Type,X-Request-Id",
		ExposeHeaders:    "X-Request-Id",
		AllowCredentials: true,
		MaxAge:           300,
	}))

	app.Get("/healthz", func(c *fiber.Ctx) error {
		stat := s.db.Stats()
		return httpx.JSON(c, fiber.StatusOK, fiber.Map{
			"status":        "ok",
			"wsConnections": s.hub.ConnectedUsers(),
			"dbConnsInUse":  stat.AcquiredConns(),
			"dbConnsIdle":   stat.IdleConns(),
			"dbConnsTotal":  stat.TotalConns(),
			"dbConnsMax":    stat.MaxConns(),
		})
	})

	api := app.Group("/api")

	// Публичные маршруты — жёсткий лимит частоты защищает от перебора
	// паролей и создания учётных записей ботами.
	authGroup := api.Group("/auth", limiter.New(limiter.Config{
		Max:          20,
		Expiration:   time.Minute,
		KeyGenerator: func(c *fiber.Ctx) string { return c.IP() },
	}))
	authGroup.Post("/register", s.Register)
	authGroup.Post("/login", s.Login)
	authGroup.Post("/refresh", s.Refresh)
	authGroup.Post("/logout", s.Logout)

	// Апгрейд WebSocket требует токен ДО стандартного REST-middleware
	// Auth (там нет заголовка Authorization — только query-параметр),
	// поэтому у него отдельная проверка в realtime.go.
	api.Get("/ws", s.wsAuth, websocket.New(s.wsHandler, websocket.Config{
		HandshakeTimeout: 10 * time.Second,
	}))

	// Всё остальное REST API — с действующим access-токеном и общим
	// лимитом частоты на IP-адрес.
	private := api.Group("", limiter.New(limiter.Config{
		Max:          s.cfg.RateLimitPerMin,
		Expiration:   time.Minute,
		KeyGenerator: func(c *fiber.Ctx) string { return c.IP() },
	}), mw.Auth(s.auth))

	private.Get("/me", s.Me)
	private.Patch("/me", s.UpdateMe)
	private.Post("/me/password", s.ChangePassword)

	private.Get("/users", s.Directory)
	private.Get("/team", s.GetTeam)
	private.Put("/team", s.SetTeam)

	private.Get("/notifications", s.ListNotifications)
	private.Post("/notifications/:id/read", s.ReadNotification)
	private.Post("/notifications/read-all", s.ReadAllNotifications)

	boards := private.Group("/boards")
	boards.Get("/", s.ListBoards)
	boards.Post("/", s.CreateBoard)
	boards.Get("/:boardID", s.GetBoard)
	boards.Patch("/:boardID", s.UpdateBoard)
	boards.Delete("/:boardID", s.DeleteBoard)
	boards.Post("/:boardID/background", s.UploadBackground)
	boards.Get("/:boardID/background", s.GetBackground)
	boards.Delete("/:boardID/background", s.DeleteBackground)
	boards.Put("/:boardID/members", s.SetMembers)
	boards.Get("/:boardID/columns", s.ListColumns)
	boards.Put("/:boardID/columns", s.SaveColumns)
	boards.Get("/:boardID/tasks", s.ListTasks)
	boards.Post("/:boardID/tasks", s.CreateTask)

	private.Get("/inbox", s.Inbox)

	tasks := private.Group("/tasks/:taskID")
	tasks.Get("/", s.GetTask)
	tasks.Patch("/", s.UpdateTask)
	tasks.Delete("/", s.DeleteTask)
	tasks.Post("/move", s.MoveTask)
	tasks.Post("/complete", s.CompleteTask)
	// Отметка исполнителя о своей части — отдельно от закрытия задачи
	// целиком: это разные действия с разными правами.
	tasks.Post("/assignment", s.CompleteAssignment)
	tasks.Get("/links", s.ListTaskLinks)
	tasks.Post("/links", s.CreateTaskLink)
	tasks.Post("/steps", s.CreateStep)
	tasks.Patch("/steps/:stepID", s.RenameStep)
	tasks.Post("/steps/:stepID/toggle", s.ToggleStep)
	tasks.Delete("/steps/:stepID", s.DeleteStep)
	tasks.Get("/comments", s.ListComments)
	tasks.Post("/comments", s.CreateComment)
	tasks.Get("/attachments", s.ListAttachments)
	tasks.Post("/attachments", s.UploadAttachment)
	tasks.Get("/activity", s.ListActivity)
	tasks.Put("/grants", s.SetGrants)

	private.Patch("/comments/:id", s.UpdateComment)
	private.Delete("/comments/:id", s.DeleteComment)

	private.Get("/attachments/:id/content", s.DownloadAttachment)
	private.Patch("/attachments/:id", s.RenameAttachment)
	private.Delete("/attachments/:id", s.DeleteAttachment)

	// Администрирование учётных записей. RequireAdmin проверяет права
	// запросом к базе на каждый вызов, а не по полю в токене, — иначе
	// снятие прав вступало бы в силу только через 15 минут.
	// Делегирование, связи задач, шаблоны — три возможности, чья схема
	// заведена миграцией 0010_structure.sql.
	// Дашборд: агрегаты считаются в базе под RLS, поэтому в статистику
	// попадает ровно то, что человеку доступно.
	// Календарь: задачи со сроком в диапазоне, из всех доступных
	// проектов сразу.
	private.Get("/calendar", s.Calendar)

	private.Get("/dashboard", s.Dashboard)
	private.Get("/dashboard/users/:userID/tasks", s.DashboardUserTasks)

	private.Get("/delegations", s.ListDelegations)
	// Действующие замещения всех сотрудников: нужны, чтобы в карточке
	// человека было видно, что он в отпуске и кто его замещает.
	private.Get("/delegations/active", s.ActiveDelegations)
	private.Post("/delegations", s.CreateDelegation)
	private.Delete("/delegations/:id", s.DeleteDelegation)

	private.Get("/templates", s.ListTemplates)
	private.Post("/templates", s.CreateTemplate)
	private.Delete("/templates/:id", s.DeleteTemplate)
	private.Post("/templates/:id/apply", s.ApplyTemplate)

	private.Delete("/links/:id", s.DeleteTaskLink)

	admin := private.Group("/admin", s.RequireAdmin)
	admin.Get("/users", s.AdminListUsers)
	admin.Post("/users", s.AdminCreateUser)
	admin.Patch("/users/:userID", s.AdminUpdateUser)
	admin.Delete("/users/:userID", s.AdminDeleteUser)
	admin.Post("/users/:userID/restore", s.AdminRestoreUser)
	admin.Post("/users/:userID/password", s.AdminResetPassword)

	// ------------------------------------------------------------------
	// Раздача собранного фронтенда тем же сервером.
	//
	// Регистрируется ПОСЛЕ всех маршрутов API — иначе обработчик
	// «вернуть index.html» перехватил бы и запросы к /api.
	//
	// Возврат index.html на неизвестный путь обязателен: адреса вида
	// /b/<uuid> и /inbox существуют только в браузере, на сервере таких
	// файлов нет. Без этого обновление страницы на открытом проекте
	// давало бы 404.
	if s.cfg.StaticDir != "" {
		app.Static("/", s.cfg.StaticDir, fiber.Static{
			Compress:  true,
			ByteRange: true,
			Index:     "index.html",
			MaxAge:    3600,
		})

		indexFile := filepath.Join(s.cfg.StaticDir, "index.html")
		app.Use(func(c *fiber.Ctx) error {
			// Несуществующий путь внутри /api — это ошибка запроса,
			// а не клиентский маршрут: отдавать на него HTML нельзя,
			// иначе клиент получит страницу вместо понятного JSON.
			if strings.HasPrefix(c.Path(), "/api") {
				return httpx.Fail(c, httpx.ErrNotFound)
			}
			if c.Method() != fiber.MethodGet {
				return httpx.Fail(c, httpx.ErrNotFound)
			}
			return c.SendFile(indexFile)
		})
	}

	return app
}

func (s *Server) uid(c *fiber.Ctx) uuid.UUID { return mw.UserID(c) }

func param(c *fiber.Ctx, name string) (uuid.UUID, error) {
	return httpx.UUIDParam(c, name)
}

func joinOrigins(origins []string) string {
	out := ""
	for i, o := range origins {
		if i > 0 {
			out += ","
		}
		out += o
	}
	return out
}

// proxyHeader включает разбор X-Forwarded-For только когда список
// доверенных прокси не пуст. При прямой работе без прокси заголовок
// игнорируется: верить ему от произвольного клиента нельзя.
func proxyHeader(trusted []string) string {
	if len(trusted) == 0 {
		return ""
	}
	return fiber.HeaderXForwardedFor
}
