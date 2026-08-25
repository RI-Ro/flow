DB ?= postgres://postgres:postgres@localhost:5432/kanban?sslmode=disable

.PHONY: help migrate seed test run front build

help:
	@echo "make migrate   — роли, схема, RLS (без seed)"
	@echo "make seed      — демонстрационные данные поверх migrate"
	@echo "make test      — проверка политик RLS ролью app_user"
	@echo "make run       — запустить API локально (go run)"
	@echo "make front     — запустить фронтенд (vite dev)"
	@echo "make build     — собрать бинарник API и статику фронтенда"

migrate:
	psql "$(DB)" -v ON_ERROR_STOP=1 -f backend/migrations/0001_roles.sql
	psql "$(DB)" -v ON_ERROR_STOP=1 -f backend/migrations/0002_schema.sql
	psql "$(DB)" -v ON_ERROR_STOP=1 -f backend/migrations/0003_rls.sql

seed:
	psql "$(DB)" -v ON_ERROR_STOP=1 -f backend/migrations/0004_seed.sql


test:
	psql "postgres://app_user:change_me_user@localhost:5432/kanban?sslmode=disable" \
		-v ON_ERROR_STOP=1 -f backend/scripts/rls_test.sql

run:
	cd backend && go run ./cmd/api

front:
	cd frontend && npm install && npm run dev

# Полная сборка «всё в одном»: фронтенд собирается в статику и кладётся
# рядом с бинарником, который её же и раздаёт. Результат — один
# исполняемый файл + каталог web, доступные по одному адресу и порту.
build:
	cd backend && go mod tidy && go build -o ../bin/api ./cmd/api
	cd frontend && npm install && npm run build
	rm -rf bin/web && cp -r frontend/dist bin/web
	@echo ""
	@echo "Готово. Запуск:"
	@echo "  cd bin && STATIC_DIR=./web APP_ADDR=:8080 DATABASE_URL=... JWT_SECRET=... ./api"

# Запуск собранного приложения на всех сетевых интерфейсах.
serve:
	cd bin && STATIC_DIR=./web APP_ADDR=$${APP_ADDR:-:8080} ./api
