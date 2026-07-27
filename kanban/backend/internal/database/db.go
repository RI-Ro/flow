package database

import (
	"context"
	"log/slog"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// DB — тонкая обёртка над пулом. Единственная её задача — гарантировать,
// что ни один запрос не уйдёт в базу без выставленного app.user_id.
// Пока параметр не задан, RLS-политики возвращают false, и запрос
// честно не видит ни одной строки.
type DB struct{ Pool *pgxpool.Pool }

var ErrNoAccess = errors.New("нет доступа")

// New поднимает пул с размером под конкурентную нагрузку. При коротких
// транзакциях (единицы миллисекунд на запрос — см. индексы в
// 0001_schema.sql) пул из нескольких десятков соединений спокойно
// обслуживает сотни одновременных пользователей: соединение занято
// только на время самого запроса, а не на всё время сессии клиента,
// как было бы при одном соединении на пользователя.
func New(ctx context.Context, url string, poolSize, minIdle int) (*DB, error) {
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		return nil, fmt.Errorf("разбор DATABASE_URL: %w", err)
	}

	if poolSize <= 0 {
		poolSize = 40
	}
	if minIdle <= 0 {
		minIdle = poolSize / 5
	}

	cfg.MaxConns = int32(poolSize)
	cfg.MinConns = int32(minIdle)
	cfg.MaxConnLifetime = time.Hour
	cfg.MaxConnLifetimeJitter = 5 * time.Minute
	cfg.MaxConnIdleTime = 15 * time.Minute
	cfg.HealthCheckPeriod = 30 * time.Second
	// Таймаут получения соединения из пула: если под пиковой нагрузкой
	// все соединения заняты дольше пяти секунд — это сигнал, что пул
	// нужно увеличивать (DB_POOL_SIZE), а не подвешивать запрос молча.
	cfg.ConnConfig.ConnectTimeout = 10 * time.Second

	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("подключение к базе: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		return nil, fmt.Errorf("база не отвечает: %w", err)
	}

	// Проверка роли подключения — не формальность, а защита от самой
	// опасной ошибки развёртывания.
	//
	// Всё разграничение доступа в этом приложении держится на политиках
	// RLS. Суперпользователь и роль с BYPASSRLS их полностью
	// игнорируют: подключившись такой ролью, приложение продолжит
	// работать как ни в чём не бывало, но каждый пользователь увидит
	// задачи всех проектов сразу — включая те, к которым его никто не
	// приглашал. Снаружи это выглядит как ошибка в коде, хотя причина
	// в строке подключения: в DATABASE_URL указан postgres вместо
	// app_user. Тихо продолжать в таком режиме нельзя.
	var (
		roleName   string
		isSuper    bool
		bypassRLS  bool
	)
	if err := pool.QueryRow(ctx, `
		SELECT current_user, rolsuper, rolbypassrls
		  FROM pg_roles WHERE rolname = current_user`).
		Scan(&roleName, &isSuper, &bypassRLS); err != nil {
		return nil, fmt.Errorf("не удалось проверить роль подключения: %w", err)
	}
	if isSuper || bypassRLS {
		pool.Close()
		return nil, fmt.Errorf(
			"подключение выполнено ролью %q, которая обходит политики доступа "+
				"(superuser=%v, bypassrls=%v). В этом режиме разграничение прав не работает: "+
				"каждый пользователь увидит чужие проекты и задачи. "+
				"Укажите в DATABASE_URL роль app_user — она создаётся миграцией 0000_roles.sql "+
				"и намеренно лишена этих привилегий",
			roleName, isSuper, bypassRLS)
	}
	slog.Info("подключение к базе", "role", roleName)
	return &DB{Pool: pool}, nil
}

func (d *DB) Close() { d.Pool.Close() }

func (d *DB) Stats() *pgxpool.Stat { return d.Pool.Stat() }

// AsUser открывает транзакцию, выставляет в ней идентификатор
// пользователя и выполняет fn. set_config с third=true делает параметр
// локальным для транзакции: он гарантированно исчезает при COMMIT или
// ROLLBACK и не может утечь на следующий запрос через тот же коннект
// пула — это важно именно при пуле соединений, где один и тот же
// физический коннект обслуживает разных пользователей подряд.
func (d *DB) AsUser(ctx context.Context, userID uuid.UUID, fn func(pgx.Tx) error) error {
	tx, err := d.Pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("начало транзакции: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if _, err := tx.Exec(ctx, `SELECT set_config('app.user_id', $1, true)`, userID.String()); err != nil {
		return fmt.Errorf("установка контекста пользователя: %w", err)
	}
	if err := fn(tx); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// AsService — транзакция без пользовательского контекста. Применяется
// только там, где данные пользователя ещё неизвестны (вход, обновление
// токена, регистрация) или где нужен доступ к SECURITY DEFINER функциям
// для вычисления получателей WebSocket-события. Все такие запросы идут
// через функции с явной защитой, обычные таблицы под RLS остаются
// недоступны — AsService не эквивалентен BYPASSRLS.
func (d *DB) AsService(ctx context.Context, fn func(pgx.Tx) error) error {
	tx, err := d.Pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("начало транзакции: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if err := fn(tx); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func IsNoRows(err error) bool { return errors.Is(err, pgx.ErrNoRows) }
