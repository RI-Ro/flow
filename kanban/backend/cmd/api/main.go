package main

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/example/kanban/internal/auth"
	"github.com/example/kanban/internal/config"
	"github.com/example/kanban/internal/database"
	"github.com/example/kanban/internal/handlers"
	"github.com/example/kanban/internal/httpx"
	"github.com/example/kanban/internal/realtime"
	"github.com/example/kanban/internal/storage"
)

func main() {
	if err := run(); err != nil {
		slog.Error("запуск не удался", "error", err)
		os.Exit(1)
	}
}

func run() error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}

	level := slog.LevelDebug
	if cfg.IsProduction() {
		level = slog.LevelInfo
	}
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: level})))

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	db, err := database.New(ctx, cfg.DatabaseURL, cfg.DBPoolSize, cfg.DBMinIdle)
	if err != nil {
		return err
	}
	defer db.Close()

	files, err := storage.NewLocal(cfg.UploadDir, cfg.MaxUploadBytes)
	if err != nil {
		return err
	}

	// Вне production подробности ошибок БД возвращаются клиенту —
	// иначе «500» невозможно диагностировать, не имея доступа к логам.
	httpx.SetProduction(cfg.IsProduction())

	hub := realtime.NewHub()
	am := auth.NewManager(cfg.JWTSecret, cfg.AccessTTL, cfg.RefreshTTL)
	app := handlers.New(cfg, db, am, files, hub).App()

	errCh := make(chan error, 1)
	go func() {
		slog.Info("сервер запущен",
			"addr", cfg.Addr, "env", cfg.Env, "dbPool", cfg.DBPoolSize)
		if err := app.Listen(cfg.Addr); err != nil {
			errCh <- err
		}
	}()

	select {
	case err := <-errCh:
		return err
	case <-ctx.Done():
		slog.Info("получен сигнал завершения, останавливаемся")
	}

	shutdownCtx, stop := context.WithTimeout(context.Background(), 20*time.Second)
	defer stop()
	if err := app.ShutdownWithContext(shutdownCtx); err != nil && !errors.Is(err, context.DeadlineExceeded) {
		return err
	}
	return nil
}
