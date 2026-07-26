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

func Load() (*Config, error) {
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
		Env:             env("APP_ENV", "development"),
		DBPoolSize:      envInt("DB_POOL_SIZE", 40),
		DBMinIdle:       envInt("DB_MIN_IDLE", 8),
		StatementCache:  env("DB_STATEMENT_CACHE", "true") == "true",
	}

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
