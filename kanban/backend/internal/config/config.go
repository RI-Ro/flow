package config

import (
	"crypto/rand"
	"fmt"
	"log/slog"
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	Addr            string
	DatabaseURL     string
	JWTSecret       []byte
	AccessTTL       time.Duration
	RefreshTTL      time.Duration
	AllowedOrigins  []string
	UploadDir       string
	MaxUploadBytes  int64
	RateLimitPerMin int
	// Разрешена ли самостоятельная регистрация. По умолчанию выключена:
	// учётными записями управляет администратор через панель, а открытая
	// форма регистрации в корпоративном инструменте означает, что завести
	// себе доступ может любой, кто дотянулся до адреса сервера.
	AllowSelfRegistration bool
	// Каталог с собранным фронтендом. Если задан, тот же сервер отдаёт
	// и статику, и API — всё приложение доступно по одному адресу и
	// одному порту, без отдельного веб-сервера и без CORS.
	StaticDir string
	// Адреса обратных прокси, чьему заголовку X-Forwarded-For можно
	// верить. Пустой список означает прямую работу без прокси.
	TrustedProxies []string

	// --- Возможности, управляемые конфигурацией ---
	// Видеовызовы: скрывают кнопки «Видеозвонок» и «Видеоконференция»
	// целиком, если в организации нет клиента телефонии.
	VideoCalls bool
	// Массовая почтовая рассылка участникам задачи.
	GroupEmail bool
	// Название в интерфейсе и заголовке вкладки.
	AppName string
	Env             string

	// Размер пула соединений с БД. При множестве коротких транзакций
	// (каждый REST-запрос — своя транзакция AsUser) 300 одновременных
	// пользователей не значит 300 одновременных соединений: запросы
	// занимают пул на единицы миллисекунд. По умолчанию берём с запасом
	// под пиковую конкурентность, оставляя резерв до max_connections
	// в postgresql.conf (по умолчанию 100) — см. README про подбор
	// под конкретное железо.
	DBPoolSize    int
	DBMinIdle     int
	StatementCache bool
}

// Load собирает конфигурацию из трёх источников в порядке
// возрастания приоритета: значения по умолчанию, config.yaml,
// переменные окружения. Окружение выше файла сознательно — в systemd
// и контейнерах секреты передаются именно так, и переопределить один
// параметр, не трогая общий файл, нужно чаще, чем наоборот.
//
// Пустой configPath означает «искать ./config.yaml, но не требовать».
func Load(explicitPath string) (*Config, error) {
	c := &Config{
		Addr:            env("APP_ADDR", ":8080"),
		DatabaseURL:     os.Getenv("DATABASE_URL"),
		JWTSecret:       []byte(os.Getenv("JWT_SECRET")),
		AccessTTL:       envDuration("ACCESS_TTL", 15*time.Minute),
		RefreshTTL:      envDuration("REFRESH_TTL", 720*time.Hour),
		AllowedOrigins:  strings.Split(env("ALLOWED_ORIGINS", "http://localhost:5173"), ","),
		UploadDir:       env("UPLOAD_DIR", defaultUploadDir),
		MaxUploadBytes:  int64(envInt("MAX_UPLOAD_MB", 25)) << 20,
		RateLimitPerMin: envInt("RATE_LIMIT_PER_MIN", 600),
		AllowSelfRegistration: envBool("ALLOW_SELF_REGISTRATION", false),
		StaticDir:             env("STATIC_DIR", ""),
		TrustedProxies:        splitList(env("TRUSTED_PROXIES", "")),
		VideoCalls:            envBool("FEATURE_VIDEO_CALLS", true),
		GroupEmail:            envBool("FEATURE_GROUP_EMAIL", true),
		AppName:               env("APP_NAME", "Команда"),
		Env:             env("APP_ENV", "development"),
		DBPoolSize:      envInt("DB_POOL_SIZE", 40),
		DBMinIdle:       envInt("DB_MIN_IDLE", 8),
		StatementCache:  env("DB_STATEMENT_CACHE", "true") == "true",
	}

	// Конфигурационный файл применяется ДО проверок ниже: заданные в
	// нём значения должны считаться такими же полноценными, как
	// переменные окружения, и не приводить к отказу «параметр не задан».
	// Путь берётся из параметра. Функции configPath() и
	// explicitConfigPath() ниже вызывать нельзя: одноимённый параметр
	// Load их затеняет, и обращение к ним компилятор считает попыткой
	// вызвать строку. Они остаются для тех, кто вызывает Load("").
	// Явно переданный путь важнее: он приходит из флага --config,
	// разобранного в main. Если параметр пуст, путь ищет configPath()
	// сама — по флагу, переменной CONFIG_FILE и ./config.yaml.
	path, explicit := explicitPath, true
	if path == "" {
		path, explicit = configPath(), explicitConfigPath()
	}
	fc, ferr := loadFile(path, explicit)
	if ferr != nil {
		return nil, ferr
	}
	c.applyFile(fc)

	// --- значения по умолчанию, когда окружение не задано ---
	//
	// Смысл в том, чтобы `go run ./cmd/api` на свежей машине просто
	// поднялся и дал посмотреть систему, а не упал с требованием
	// заполнить переменные. При этом в production поблажек нет: там
	// отсутствие настроек означает ошибку конфигурации, а не удобство.

	if c.DatabaseURL == "" {
		if c.IsProduction() {
			return nil, fmt.Errorf("DATABASE_URL не задан")
		}
		c.DatabaseURL = defaultDatabaseURL
		slog.Warn("DATABASE_URL не задан, используется значение по умолчанию",
			"url", defaultDatabaseURL)
	}

	if len(c.JWTSecret) < 32 {
		if c.IsProduction() {
			return nil, fmt.Errorf("JWT_SECRET не задан или короче 32 байт")
		}
		// Ключ генерируется случайно на каждый запуск. Это намеренно:
		// зашитый в исходники «ключ для разработки» рано или поздно
		// уезжает в production, а случайный лишь разлогинивает всех при
		// перезапуске — неприятно, но безопасно.
		secret := make([]byte, 48)
		if _, err := rand.Read(secret); err != nil {
			return nil, fmt.Errorf("не удалось сгенерировать временный JWT_SECRET: %w", err)
		}
		c.JWTSecret = secret
		slog.Warn("JWT_SECRET не задан — сгенерирован временный ключ. " +
			"Все сессии будут сброшены при перезапуске. " +
			"Для постоянного ключа: openssl rand -base64 48")
	}

	if c.UploadDir == "" {
		c.UploadDir = defaultUploadDir
	}

	return c, nil
}

// Значения по умолчанию для локального запуска без переменных
// окружения. Совпадают с тем, что создают миграции 0000_roles.sql
// и docker-compose.yml.
const (
	defaultDatabaseURL = "postgres://app_user:change_me_user@localhost:5432/kanban?sslmode=disable"
	defaultUploadDir   = "./var/uploads"
)

func (c *Config) IsProduction() bool { return c.Env == "production" }

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

// splitList разбирает список через запятую, отбрасывая пустые элементы:
// «TRUSTED_PROXIES=» должно давать пустой список, а не список из одной
// пустой строки — иначе Fiber посчитал бы доверенным адрес "".
func splitList(v string) []string {
	out := []string{}
	for _, part := range strings.Split(v, ",") {
		if p := strings.TrimSpace(part); p != "" {
			out = append(out, p)
		}
	}
	return out
}

func envBool(k string, def bool) bool {
	switch strings.ToLower(os.Getenv(k)) {
	case "1", "true", "yes", "on":
		return true
	case "0", "false", "no", "off":
		return false
	}
	return def
}

func envInt(k string, def int) int {
	if v, err := strconv.Atoi(os.Getenv(k)); err == nil {
		return v
	}
	return def
}

func envDuration(k string, def time.Duration) time.Duration {
	if v, err := time.ParseDuration(os.Getenv(k)); err == nil {
		return v
	}
	return def
}

// configPath возвращает путь к config.yaml.
//
// Порядок поиска: флаг --config, затем переменная CONFIG_FILE, затем
// ./config.yaml рядом с исполняемым файлом. Последний вариант — просто
// удобство: если файла нет, приложение работает на значениях по
// умолчанию, а не падает.
func configPath() string {
	for i, arg := range os.Args {
		if arg == "--config" || arg == "-config" {
			if i+1 < len(os.Args) {
				return os.Args[i+1]
			}
		}
		if v, ok := strings.CutPrefix(arg, "--config="); ok {
			return v
		}
	}
	if v := os.Getenv("CONFIG_FILE"); v != "" {
		return v
	}
	return "config.yaml"
}

// explicitConfigPath сообщает, был ли путь указан явно. Если да,
// отсутствие файла — ошибка запуска: человек рассчитывал на этот
// файл, и молча проигнорировать его нельзя. Если нет — просто
// работаем на значениях по умолчанию.
func explicitConfigPath() bool {
	for _, arg := range os.Args {
		if arg == "--config" || arg == "-config" || strings.HasPrefix(arg, "--config=") {
			return true
		}
	}
	return os.Getenv("CONFIG_FILE") != ""
}
