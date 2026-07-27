package config

import (
	"fmt"
	"log/slog"
	"os"
	"time"

	"gopkg.in/yaml.v3"
)

// fileConfig — представление config.yaml.
//
// Все поля — указатели. Это принципиально: нужно отличать «параметр не
// указан в файле» от «указан и равен нулю или false». Без указателей
// пропущенный features.video_calls был бы неотличим от явного false,
// и значение по умолчанию никогда бы не применилось.
type fileConfig struct {
	Server *struct {
		Addr      *string `yaml:"addr"`
		Env       *string `yaml:"env"`
		StaticDir *string `yaml:"static_dir"`
		// Адреса обратных прокси, чьему X-Forwarded-For можно верить.
		TrustedProxies []string `yaml:"trusted_proxies"`
		AllowedOrigins []string `yaml:"allowed_origins"`
		RateLimit      *int     `yaml:"rate_limit_per_min"`
	} `yaml:"server"`

	Database *struct {
		// Либо готовая строка подключения, либо поля по отдельности —
		// так удобнее держать пароль в отдельном месте.
		URL      *string `yaml:"url"`
		Host     *string `yaml:"host"`
		Port     *int    `yaml:"port"`
		Name     *string `yaml:"name"`
		User     *string `yaml:"user"`
		Password *string `yaml:"password"`
		SSLMode  *string `yaml:"sslmode"`
		PoolSize *int    `yaml:"pool_size"`
		MinIdle  *int    `yaml:"min_idle"`
	} `yaml:"database"`

	Auth *struct {
		JWTSecret             *string `yaml:"jwt_secret"`
		AccessTTL             *string `yaml:"access_ttl"`
		RefreshTTL            *string `yaml:"refresh_ttl"`
		AllowSelfRegistration *bool   `yaml:"allow_self_registration"`
	} `yaml:"auth"`

	Uploads *struct {
		Dir      *string `yaml:"dir"`
		MaxSizeM *int    `yaml:"max_size_mb"`
	} `yaml:"uploads"`

	Features *struct {
		// Управляет и кнопками в интерфейсе, и самой возможностью
		// собрать ссылку вызова. Выключено — кнопок «Видеозвонок» и
		// «Видеоконференция» нет вовсе.
		VideoCalls *bool `yaml:"video_calls"`
		// Массовая почтовая рассылка участникам задачи.
		GroupEmail *bool `yaml:"group_email"`
	} `yaml:"features"`

	Branding *struct {
		AppName *string `yaml:"app_name"`
	} `yaml:"branding"`
}

// loadFile читает YAML. Отсутствие файла — не ошибка, если путь не был
// указан явно: приложение обязано подниматься и без конфигурации.
func loadFile(path string, explicit bool) (*fileConfig, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) && !explicit {
			return nil, nil
		}
		return nil, fmt.Errorf("не удалось прочитать %s: %w", path, err)
	}

	var fc fileConfig
	if err := yaml.Unmarshal(data, &fc); err != nil {
		return nil, fmt.Errorf("ошибка разбора %s: %w", path, err)
	}
	slog.Info("конфигурация загружена", "file", path)
	return &fc, nil
}

// applyFile переносит заданные в файле значения в конфигурацию.
//
// Порядок приоритетов: переменные окружения > config.yaml > значения по
// умолчанию. Окружение выше файла сознательно — в systemd и контейнерах
// секреты передаются именно так, и возможность переопределить один
// параметр, не трогая файл, нужна чаще, чем обратное.
func (c *Config) applyFile(fc *fileConfig) {
	if fc == nil {
		return
	}

	if s := fc.Server; s != nil {
		setStr(&c.Addr, s.Addr, "APP_ADDR")
		setStr(&c.Env, s.Env, "APP_ENV")
		setStr(&c.StaticDir, s.StaticDir, "STATIC_DIR")
		setInt(&c.RateLimitPerMin, s.RateLimit, "RATE_LIMIT_PER_MIN")
		if len(s.TrustedProxies) > 0 && os.Getenv("TRUSTED_PROXIES") == "" {
			c.TrustedProxies = s.TrustedProxies
		}
		if len(s.AllowedOrigins) > 0 && os.Getenv("ALLOWED_ORIGINS") == "" {
			c.AllowedOrigins = s.AllowedOrigins
		}
	}

	if d := fc.Database; d != nil {
		if os.Getenv("DATABASE_URL") == "" {
			if d.URL != nil && *d.URL != "" {
				c.DatabaseURL = *d.URL
			} else if d.Host != nil || d.Name != nil {
				c.DatabaseURL = buildDSN(d.Host, d.Port, d.Name, d.User, d.Password, d.SSLMode)
			}
		}
		setInt(&c.DBPoolSize, d.PoolSize, "DB_POOL_SIZE")
		setInt(&c.DBMinIdle, d.MinIdle, "DB_MIN_IDLE")
	}

	if a := fc.Auth; a != nil {
		if a.JWTSecret != nil && *a.JWTSecret != "" && os.Getenv("JWT_SECRET") == "" {
			c.JWTSecret = []byte(*a.JWTSecret)
		}
		setDuration(&c.AccessTTL, a.AccessTTL, "ACCESS_TTL")
		setDuration(&c.RefreshTTL, a.RefreshTTL, "REFRESH_TTL")
		setBool(&c.AllowSelfRegistration, a.AllowSelfRegistration, "ALLOW_SELF_REGISTRATION")
	}

	if u := fc.Uploads; u != nil {
		setStr(&c.UploadDir, u.Dir, "UPLOAD_DIR")
		if u.MaxSizeM != nil && os.Getenv("MAX_UPLOAD_MB") == "" {
			c.MaxUploadBytes = int64(*u.MaxSizeM) << 20
		}
	}

	if f := fc.Features; f != nil {
		setBool(&c.VideoCalls, f.VideoCalls, "FEATURE_VIDEO_CALLS")
		setBool(&c.GroupEmail, f.GroupEmail, "FEATURE_GROUP_EMAIL")
	}

	if b := fc.Branding; b != nil {
		setStr(&c.AppName, b.AppName, "APP_NAME")
	}
}

// Помощники ниже применяют значение из файла, только если та же
// настройка не задана переменной окружения.

func setStr(dst *string, v *string, envKey string) {
	if v != nil && os.Getenv(envKey) == "" {
		*dst = *v
	}
}

func setInt(dst *int, v *int, envKey string) {
	if v != nil && os.Getenv(envKey) == "" {
		*dst = *v
	}
}

func setBool(dst *bool, v *bool, envKey string) {
	if v != nil && os.Getenv(envKey) == "" {
		*dst = *v
	}
}

func setDuration(dst *time.Duration, v *string, envKey string) {
	if v == nil || os.Getenv(envKey) != "" {
		return
	}
	if d, err := time.ParseDuration(*v); err == nil {
		*dst = d
	} else {
		slog.Warn("не удалось разобрать длительность из конфигурации",
			"key", envKey, "value", *v, "error", err)
	}
}

func buildDSN(host *string, port *int, name, user, password, sslmode *string) string {
	h := "localhost"
	if host != nil {
		h = *host
	}
	p := 5432
	if port != nil {
		p = *port
	}
	n := "kanban"
	if name != nil {
		n = *name
	}
	u := "app_user"
	if user != nil {
		u = *user
	}
	pw := ""
	if password != nil {
		pw = *password
	}
	ssl := "disable"
	if sslmode != nil {
		ssl = *sslmode
	}
	return fmt.Sprintf("postgres://%s:%s@%s:%d/%s?sslmode=%s", u, pw, h, p, n, ssl)
}
