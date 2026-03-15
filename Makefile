.PHONY: help \
        dev dev-db dev-gsql2rsql dev-gsql2rsql-db \
        dev-databricks dev-databricks-db dev-databricks-lakebase \
        dev-stop dev-logs dev-logs-follow \
        lint lint-frontend lint-api format \
        test test-unit test-coverage test-e2e test-e2e-headed test-e2e-ui test-e2e-report \
        test-integration test-integration-headed test-all \
        build build-pypi build-frontend build-wheel-only build-verify \
        docs docs-build docs-preview docs-screenshots \
        install setup-gsql2rsql \
        run-api run-api-no-debug run-api-db run-warehouse run-warehouse-no-debug run-frontend \
        db-up db-down db-logs migrate migrate-create \
        perf-report \
        clean

CYAN := \033[36m
GREEN := \033[32m
YELLOW := \033[33m
DIM := \033[2m
BOLD := \033[1m
RESET := \033[0m

GSQL2RSQL_PATH ?= $(HOME)/phd/cyper2dsql/python

# ═══════════════════════════════════════════════════════════════════════════════
# Help
# ═══════════════════════════════════════════════════════════════════════════════

help:
	@echo ""
	@echo "$(BOLD)$(CYAN)Graph Lagoon Studio$(RESET) — Interactive Graph Visualization"
	@echo ""
	@echo "$(GREEN)Workflows$(RESET) $(DIM)(all services in background)$(RESET)"
	@echo "  make dev                   warehouse + API + frontend (in-memory)"
	@echo "  make dev-db                warehouse + API + frontend + PostgreSQL"
	@echo "  make dev-gsql2rsql         + local gsql2rsql (in-memory)"
	@echo "  make dev-gsql2rsql-db      + local gsql2rsql + PostgreSQL"
	@echo "  make dev-databricks        Databricks SQL (no persistence)"
	@echo "  make dev-databricks-db     Databricks SQL + local PostgreSQL"
	@echo "  make dev-stop              Stop all background services"
	@echo "  make dev-logs              Show logs"
	@echo ""
	@echo "$(GREEN)Quality$(RESET)"
	@echo "  make lint                  Run all linters (frontend + API)"
	@echo "  make format                Auto-format all code"
	@echo ""
	@echo "$(GREEN)Test$(RESET)"
	@echo "  make test                  Unit tests (Vitest)"
	@echo "  make test-coverage         Unit tests + coverage"
	@echo "  make test-e2e              E2E tests (Playwright, mocked API)"
	@echo "  make test-integration      Integration E2E (requires full stack)"
	@echo "  make test-all              All tests (unit + E2E)"
	@echo ""
	@echo "$(GREEN)Performance$(RESET)"
	@echo "  make perf-report           Collect perf metrics (needs running dev server)"
	@echo ""
	@echo "$(GREEN)Build$(RESET)"
	@echo "  make build                 Build frontend + Python wheel (local gsql2rsql)"
	@echo "  make build-pypi            Build frontend + Python wheel (gsql2rsql from PyPI)"
	@echo "  make build-verify          Verify wheel contains static assets"
	@echo ""
	@echo "$(GREEN)Docs$(RESET)"
	@echo "  make docs                  Start VitePress dev server"
	@echo "  make docs-build            Build documentation site"
	@echo "  make docs-screenshots      Generate screenshots with Playwright"
	@echo ""
	@echo "$(GREEN)Setup$(RESET)"
	@echo "  make install               Install all dependencies"
	@echo "  make setup-gsql2rsql       Link local gsql2rsql for development"
	@echo ""
	@echo "$(DIM)Advanced: run-api, run-warehouse, run-frontend, db-up, db-down, migrate, clean$(RESET)"
	@echo ""

# ═══════════════════════════════════════════════════════════════════════════════
# Workflows — run all services in background
# ═══════════════════════════════════════════════════════════════════════════════

# Local: warehouse (mock) + API + frontend — no persistence
dev:
	@cd warehouse && uv sync --extra dev
	@cd api && uv sync --extra dev
	@mkdir -p $(CURDIR)/.logs $(CURDIR)/.pids
	@echo "$(CYAN)Starting warehouse on :8001...$(RESET)"
	@cd warehouse && nohup uv run uvicorn src.main:app --host 0.0.0.0 --port 8001 > $(CURDIR)/.logs/warehouse.log 2>&1 & echo $$! > $(CURDIR)/.pids/warehouse.pid
	@sleep 2
	@echo "$(CYAN)Starting API on :8000...$(RESET)"
	@cd api && nohup uv run uvicorn graphlagoon.main:app --host 0.0.0.0 --port 8000 > $(CURDIR)/.logs/api.log 2>&1 & echo $$! > $(CURDIR)/.pids/api.pid
	@sleep 2
	@echo "$(CYAN)Starting frontend on :3000...$(RESET)"
	@cd frontend && nohup npm run dev > $(CURDIR)/.logs/frontend.log 2>&1 & echo $$! > $(CURDIR)/.pids/frontend.pid
	@sleep 3
	@echo ""
	@echo "$(GREEN)Ready!$(RESET)  warehouse :8001 | API :8000 | frontend :3000"
	@echo "$(DIM)make dev-logs · make dev-stop$(RESET)"

# Local: warehouse + API + frontend + PostgreSQL persistence
dev-db: db-up
	@cd warehouse && uv sync --extra dev
	@cd api && uv sync --extra dev --extra postgres
	@cd api && uv run alembic upgrade head
	@mkdir -p $(CURDIR)/.logs $(CURDIR)/.pids
	@echo "$(CYAN)Starting warehouse on :8001...$(RESET)"
	@cd warehouse && nohup uv run uvicorn src.main:app --host 0.0.0.0 --port 8001 > $(CURDIR)/.logs/warehouse.log 2>&1 & echo $$! > $(CURDIR)/.pids/warehouse.pid
	@sleep 2
	@echo "$(CYAN)Starting API on :8000 (database enabled)...$(RESET)"
	@cd api && nohup env GRAPH_LAGOON_DATABASE_ENABLED=true uv run uvicorn graphlagoon.main:app --host 0.0.0.0 --port 8000 > $(CURDIR)/.logs/api.log 2>&1 & echo $$! > $(CURDIR)/.pids/api.pid
	@sleep 2
	@echo "$(CYAN)Starting frontend on :3000...$(RESET)"
	@cd frontend && nohup env VITE_DATABASE_ENABLED=true npm run dev > $(CURDIR)/.logs/frontend.log 2>&1 & echo $$! > $(CURDIR)/.pids/frontend.pid
	@sleep 3
	@echo ""
	@echo "$(GREEN)Ready!$(RESET)  PostgreSQL :5432 | warehouse :8001 | API :8000 (db) | frontend :3000"
	@echo "$(DIM)make dev-logs · make dev-stop$(RESET)"

# Local: warehouse + API (local gsql2rsql) + frontend — no persistence
dev-gsql2rsql: _ensure-gsql2rsql
	@cd warehouse && uv sync --extra dev
	@cd api && uv sync --extra dev
	@mkdir -p $(CURDIR)/.logs $(CURDIR)/.pids
	@echo "$(CYAN)Starting warehouse on :8001...$(RESET)"
	@cd warehouse && nohup uv run uvicorn src.main:app --host 0.0.0.0 --port 8001 > $(CURDIR)/.logs/warehouse.log 2>&1 & echo $$! > $(CURDIR)/.pids/warehouse.pid
	@sleep 2
	@echo "$(CYAN)Starting API on :8000 (local gsql2rsql)...$(RESET)"
	@cd api && nohup uv run uvicorn graphlagoon.main:app --host 0.0.0.0 --port 8000 > $(CURDIR)/.logs/api.log 2>&1 & echo $$! > $(CURDIR)/.pids/api.pid
	@sleep 2
	@echo "$(CYAN)Starting frontend on :3000...$(RESET)"
	@cd frontend && nohup npm run dev > $(CURDIR)/.logs/frontend.log 2>&1 & echo $$! > $(CURDIR)/.pids/frontend.pid
	@sleep 3
	@echo ""
	@echo "$(GREEN)Ready!$(RESET)  warehouse :8001 | API :8000 (gsql2rsql) | frontend :3000"
	@echo "$(DIM)make dev-logs · make dev-stop$(RESET)"

# Local: warehouse + API (local gsql2rsql) + frontend + PostgreSQL
dev-gsql2rsql-db: _ensure-gsql2rsql db-up
	@cd warehouse && uv sync --extra dev
	@cd api && uv sync --extra dev --extra postgres
	@cd api && uv run alembic upgrade head
	@mkdir -p $(CURDIR)/.logs $(CURDIR)/.pids
	@echo "$(CYAN)Starting warehouse on :8001...$(RESET)"
	@cd warehouse && nohup uv run uvicorn src.main:app --host 0.0.0.0 --port 8001 > $(CURDIR)/.logs/warehouse.log 2>&1 & echo $$! > $(CURDIR)/.pids/warehouse.pid
	@sleep 2
	@echo "$(CYAN)Starting API on :8000 (local gsql2rsql + database)...$(RESET)"
	@cd api && nohup env GRAPH_LAGOON_DATABASE_ENABLED=true uv run uvicorn graphlagoon.main:app --host 0.0.0.0 --port 8000 > $(CURDIR)/.logs/api.log 2>&1 & echo $$! > $(CURDIR)/.pids/api.pid
	@sleep 2
	@echo "$(CYAN)Starting frontend on :3000...$(RESET)"
	@cd frontend && nohup env VITE_DATABASE_ENABLED=true npm run dev > $(CURDIR)/.logs/frontend.log 2>&1 & echo $$! > $(CURDIR)/.pids/frontend.pid
	@sleep 3
	@echo ""
	@echo "$(GREEN)Ready!$(RESET)  PostgreSQL :5432 | warehouse :8001 | API :8000 (gsql2rsql + db) | frontend :3000"
	@echo "$(DIM)make dev-logs · make dev-stop$(RESET)"

# Databricks SQL — no local warehouse, no persistence
dev-databricks: _ensure-databricks-env
	@mkdir -p $(CURDIR)/.logs $(CURDIR)/.pids
	@echo "$(CYAN)Starting API on :8000 (Databricks)...$(RESET)"
	@cd api && nohup uv run uvicorn graphlagoon.main:app --host 0.0.0.0 --port 8000 > $(CURDIR)/.logs/api.log 2>&1 & echo $$! > $(CURDIR)/.pids/api.pid
	@sleep 2
	@echo "$(CYAN)Starting frontend on :3000...$(RESET)"
	@cd frontend && nohup env VITE_DATABRICKS_USER_EMAIL="$(_DATABRICKS_EMAIL)" npm run dev > $(CURDIR)/.logs/frontend.log 2>&1 & echo $$! > $(CURDIR)/.pids/frontend.pid
	@sleep 3
	@echo ""
	@echo "$(GREEN)Ready!$(RESET)  API :8000 (Databricks) | frontend :3000"
	@echo "$(YELLOW)Note: Explorations/Contexts will NOT be persisted$(RESET)"
	@echo "$(DIM)make dev-logs · make dev-stop$(RESET)"

# Databricks SQL + local PostgreSQL
dev-databricks-db: _ensure-databricks-env db-up
	@cd api && uv sync --extra dev --extra postgres
	@cd api && uv run alembic upgrade head
	@mkdir -p $(CURDIR)/.logs $(CURDIR)/.pids
	@echo "$(CYAN)Starting API on :8000 (Databricks + database)...$(RESET)"
	@cd api && nohup env GRAPH_LAGOON_DATABASE_ENABLED=true uv run uvicorn graphlagoon.main:app --host 0.0.0.0 --port 8000 > $(CURDIR)/.logs/api.log 2>&1 & echo $$! > $(CURDIR)/.pids/api.pid
	@sleep 2
	@echo "$(CYAN)Starting frontend on :3000...$(RESET)"
	@cd frontend && nohup env VITE_DATABASE_ENABLED=true VITE_DATABRICKS_USER_EMAIL="$(_DATABRICKS_EMAIL)" npm run dev > $(CURDIR)/.logs/frontend.log 2>&1 & echo $$! > $(CURDIR)/.pids/frontend.pid
	@sleep 3
	@echo ""
	@echo "$(GREEN)Ready!$(RESET)  PostgreSQL :5432 | API :8000 (Databricks + db) | frontend :3000"
	@echo "$(DIM)make dev-logs · make dev-stop$(RESET)"

# Databricks SQL + Lakebase PostgreSQL
dev-databricks-lakebase: _ensure-databricks-env
	@mkdir -p $(CURDIR)/.logs $(CURDIR)/.pids
	@echo "$(CYAN)Starting API on :8000 (Databricks + Lakebase)...$(RESET)"
	@cd api && nohup uv run uvicorn graphlagoon.main:app --host 0.0.0.0 --port 8000 > $(CURDIR)/.logs/api.log 2>&1 & echo $$! > $(CURDIR)/.pids/api.pid
	@sleep 2
	@echo "$(CYAN)Starting frontend on :3000...$(RESET)"
	@cd frontend && nohup env VITE_DATABASE_ENABLED=true VITE_DATABRICKS_USER_EMAIL="$(_DATABRICKS_EMAIL)" npm run dev > $(CURDIR)/.logs/frontend.log 2>&1 & echo $$! > $(CURDIR)/.pids/frontend.pid
	@sleep 3
	@echo ""
	@echo "$(GREEN)Ready!$(RESET)  API :8000 (Databricks + Lakebase) | frontend :3000"
	@echo "$(DIM)make dev-logs · make dev-stop$(RESET)"

dev-stop:
	@echo "$(CYAN)Stopping all services...$(RESET)"
	@if [ -f .pids/frontend.pid ]; then kill $$(cat .pids/frontend.pid) 2>/dev/null || true; rm -f .pids/frontend.pid; fi
	@if [ -f .pids/api.pid ]; then kill $$(cat .pids/api.pid) 2>/dev/null || true; rm -f .pids/api.pid; fi
	@if [ -f .pids/warehouse.pid ]; then kill $$(cat .pids/warehouse.pid) 2>/dev/null || true; rm -f .pids/warehouse.pid; fi
	@pkill -f "uvicorn src.main:app" 2>/dev/null || true
	@pkill -f "uvicorn graphlagoon.main:app" 2>/dev/null || true
	@pkill -f "node.*vite" 2>/dev/null || true
	@echo "$(GREEN)All services stopped$(RESET)"

dev-logs:
	@echo "$(CYAN)=== warehouse ===$(RESET)"
	@tail -20 .logs/warehouse.log 2>/dev/null || echo "No logs"
	@echo ""
	@echo "$(CYAN)=== API ===$(RESET)"
	@tail -20 .logs/api.log 2>/dev/null || echo "No logs"
	@echo ""
	@echo "$(CYAN)=== frontend ===$(RESET)"
	@tail -20 .logs/frontend.log 2>/dev/null || echo "No logs"

dev-logs-follow:
	@tail -f .logs/*.log

# Internal helpers for workflows
_ensure-gsql2rsql:
	@if [ -d "$(GSQL2RSQL_PATH)" ] && ! grep -q 'tool.uv.sources' api/pyproject.toml 2>/dev/null; then \
		echo "$(CYAN)Setting up local gsql2rsql from $(GSQL2RSQL_PATH)...$(RESET)"; \
		cd api && uv add --editable "$(GSQL2RSQL_PATH)"; \
	elif [ ! -d "$(GSQL2RSQL_PATH)" ]; then \
		echo "$(YELLOW)Error: gsql2rsql not found at $(GSQL2RSQL_PATH)$(RESET)"; \
		echo "Usage: make dev-gsql2rsql GSQL2RSQL_PATH=/your/path"; \
		exit 1; \
	fi

_ensure-databricks-env:
	@cd api && uv sync --extra dev
	@if [ ! -f api/.env ]; then \
		echo "$(YELLOW)No api/.env file found. Copy from template:$(RESET)"; \
		echo "  cp api/.env.databricks api/.env"; \
		echo "  Then edit with your Databricks credentials"; \
		exit 1; \
	fi

# Resolve Databricks user email from SDK (best-effort)
_DATABRICKS_EMAIL = $(shell cd api && uv run python -c \
	"from databricks.sdk import WorkspaceClient; print(WorkspaceClient().current_user.me().user_name)" \
	2>/dev/null || echo "")

# ═══════════════════════════════════════════════════════════════════════════════
# Quality — lint & format
# ═══════════════════════════════════════════════════════════════════════════════

lint: lint-frontend lint-api

lint-frontend:
	@echo "$(CYAN)Linting frontend...$(RESET)"
	cd frontend && npm run lint
	cd frontend && npx vue-tsc --noEmit

lint-api:
	@echo "$(CYAN)Linting API...$(RESET)"
	cd api && uv run ruff check graphlagoon/
	cd api && uv run ruff format --check graphlagoon/

format:
	@echo "$(CYAN)Formatting code...$(RESET)"
	cd api && uv run ruff format graphlagoon/
	cd frontend && npm run lint -- --fix
	@echo "$(GREEN)Done$(RESET)"

# ═══════════════════════════════════════════════════════════════════════════════
# Test
# ═══════════════════════════════════════════════════════════════════════════════

test: test-unit-frontend test-unit-api

test-unit: test-unit-frontend test-unit-api

test-unit-frontend:
	@echo "$(CYAN)Running frontend unit tests...$(RESET)"
	cd frontend && npm run test:run

test-unit-api:
	@echo "$(CYAN)Running API unit tests...$(RESET)"
	cd api && uv run pytest tests/ -x -q

test-coverage:
	@echo "$(CYAN)Running unit tests with coverage...$(RESET)"
	cd frontend && npm run test:coverage

test-e2e:
	@echo "$(CYAN)Running E2E tests...$(RESET)"
	cd frontend && npm run e2e

test-e2e-headed:
	@echo "$(CYAN)Running E2E tests (headed)...$(RESET)"
	cd frontend && npm run e2e:headed

test-e2e-ui:
	@echo "$(CYAN)Opening Playwright UI...$(RESET)"
	cd frontend && npm run e2e:ui

test-e2e-report:
	@echo "$(CYAN)Opening Playwright report...$(RESET)"
	cd frontend && npm run e2e:report

test-integration:
	@echo "$(CYAN)Running integration E2E tests...$(RESET)"
	@echo "$(YELLOW)Requires full stack: make dev-db, then run this in another terminal$(RESET)"
	cd frontend && npm run e2e:integration

test-integration-headed:
	@echo "$(CYAN)Running integration tests (headed)...$(RESET)"
	cd frontend && npm run e2e:integration:headed

test-all: test-unit test-e2e
	@echo "$(GREEN)All tests passed!$(RESET)"

# ═══════════════════════════════════════════════════════════════════════════════
# Build — production package
# ═══════════════════════════════════════════════════════════════════════════════

build: build-frontend
	@echo "$(CYAN)Building Python wheel...$(RESET)"
	cd api && rm -rf dist/ && uv build
	@echo ""
	@echo "$(GREEN)Package built!$(RESET)  $$(ls api/dist/*.whl)"
	@echo "Install: pip install api/dist/graphlagoon-*.whl"

build-pypi: build-frontend
	@echo "$(CYAN)Building Python wheel for PyPI (gsql2rsql from PyPI)...$(RESET)"
	@cp api/pyproject.toml api/pyproject.toml.bak
	@grep -v '^\[tool\.uv\.sources\]' api/pyproject.toml | grep -v 'gsql2rsql = { path' > api/pyproject.toml.tmp && mv api/pyproject.toml.tmp api/pyproject.toml
	@cd api && rm -rf dist/ && uv build; STATUS=$$?; cp pyproject.toml.bak pyproject.toml && rm -f pyproject.toml.bak; exit $$STATUS
	@echo ""
	@echo "$(GREEN)Package built!$(RESET)  $$(ls api/dist/*.whl)"
	@echo "Install: pip install api/dist/graphlagoon-*.whl"

build-frontend:
	@echo "$(CYAN)Building frontend...$(RESET)"
	cd frontend && npm run build

build-wheel-only:
	@if [ ! -f api/graphlagoon/static/.vite/manifest.json ]; then \
		echo "$(YELLOW)Error: Frontend not built. Run 'make build-frontend' first$(RESET)"; \
		exit 1; \
	fi
	cd api && rm -rf dist/ && uv build
	@echo "$(GREEN)Wheel built!$(RESET)  $$(ls api/dist/*.whl)"

build-verify:
	@test -f api/dist/graphlagoon-*.whl || (echo "$(YELLOW)Error: No wheel found. Run 'make build' first$(RESET)"; exit 1)
	@python3 -c "import zipfile, glob; z=zipfile.ZipFile(glob.glob('api/dist/*.whl')[0]); assert any('static/assets' in n for n in z.namelist()), 'Static assets missing from wheel'"
	@echo "$(GREEN)Build verified: wheel contains static assets$(RESET)"

# ═══════════════════════════════════════════════════════════════════════════════
# Release — changelog & versioning
# ═══════════════════════════════════════════════════════════════════════════════

changelog: ## Generate CHANGELOG.md from conventional commits
	@command -v git-cliff >/dev/null 2>&1 || (echo "$(YELLOW)Install git-cliff: cargo install git-cliff$(RESET)"; exit 1)
	git-cliff -o CHANGELOG.md
	@echo "$(GREEN)CHANGELOG.md updated$(RESET)"

changelog-preview: ## Preview changelog for next release
	@command -v git-cliff >/dev/null 2>&1 || (echo "$(YELLOW)Install git-cliff: cargo install git-cliff$(RESET)"; exit 1)
	git-cliff --unreleased

release-dry: build-pypi build-verify ## Dry-run: build + verify (no publish)
	@echo "$(GREEN)Dry run complete. Wheel ready at:$(RESET) $$(ls api/dist/*.whl)"
	@echo "To publish, trigger the Release workflow on GitHub Actions."

# ═══════════════════════════════════════════════════════════════════════════════
# Docs
# ═══════════════════════════════════════════════════════════════════════════════

docs:
	cd docs && npx vitepress dev

docs-build:
	cd docs && npx vitepress build

docs-preview:
	cd docs && npx vitepress preview

docs-screenshots:
	@echo "$(CYAN)Generating documentation screenshots...$(RESET)"
	cd frontend && npm run screenshots
	@echo "$(GREEN)Screenshots saved to docs/public/screenshots/$(RESET)"

# ═══════════════════════════════════════════════════════════════════════════════
# Setup — first-time installation
# ═══════════════════════════════════════════════════════════════════════════════

install: _install-warehouse _install-api _install-frontend _install-hooks
	@echo "$(GREEN)All dependencies installed!$(RESET)"

_install-warehouse:
	@echo "$(CYAN)Installing warehouse deps...$(RESET)"
	cd warehouse && uv sync --extra dev

_install-api:
	@echo "$(CYAN)Installing API deps...$(RESET)"
	cd api && uv sync --extra dev

_install-frontend:
	@echo "$(CYAN)Initializing git submodules...$(RESET)"
	git submodule update --init --recursive
	@echo "$(CYAN)Installing frontend deps...$(RESET)"
	cd frontend && npm install

_install-hooks:
	@echo "$(CYAN)Installing pre-commit hooks...$(RESET)"
	@command -v pre-commit >/dev/null 2>&1 || uv tool install pre-commit
	pre-commit install
	pre-commit install --hook-type commit-msg
	pre-commit install --hook-type pre-push

setup-gsql2rsql:
	@if [ ! -d "$(GSQL2RSQL_PATH)" ]; then \
		echo "$(YELLOW)Error: gsql2rsql not found at $(GSQL2RSQL_PATH)$(RESET)"; \
		echo "Usage: make setup-gsql2rsql GSQL2RSQL_PATH=/your/path"; \
		exit 1; \
	fi
	cd api && uv add --editable "$(GSQL2RSQL_PATH)"
	@echo "$(GREEN)Installed gsql2rsql from $(GSQL2RSQL_PATH)$(RESET)"

# ═══════════════════════════════════════════════════════════════════════════════
# Advanced — individual services (foreground), database, cleanup
# ═══════════════════════════════════════════════════════════════════════════════

# Run individual services in foreground (for VS Code debugpy attach)
run-api:
	@cd api && uv sync --extra dev
	@echo "$(CYAN)API on :8000 (debugpy on :5678)$(RESET)"
	cd api && DEBUGPY_ENABLE=1 uv run uvicorn graphlagoon.main:app --host 0.0.0.0 --port 8000 --reload

run-api-no-debug:
	@cd api && uv sync --extra dev
	cd api && uv run uvicorn graphlagoon.main:app --host 0.0.0.0 --port 8000 --reload

run-api-db: db-up
	@cd api && uv sync --extra dev --extra postgres
	@echo "$(CYAN)API on :8000 (database enabled, debugpy on :5678)$(RESET)"
	cd api && GRAPH_LAGOON_DATABASE_ENABLED=true DEBUGPY_ENABLE=1 uv run uvicorn graphlagoon.main:app --host 0.0.0.0 --port 8000 --reload

run-warehouse:
	@cd warehouse && uv sync --extra dev
	@echo "$(CYAN)Warehouse on :8001 (debugpy on :5679)$(RESET)"
	cd warehouse && DEBUGPY_ENABLE=1 uv run uvicorn src.main:app --host 0.0.0.0 --port 8001 --reload

run-warehouse-no-debug:
	@cd warehouse && uv sync --extra dev
	cd warehouse && uv run uvicorn src.main:app --host 0.0.0.0 --port 8001 --reload

run-frontend:
	cd frontend && npm run dev

# Database
db-up:
	@echo "$(CYAN)Starting PostgreSQL...$(RESET)"
	docker-compose up -d
	@echo "$(GREEN)PostgreSQL running on :5432$(RESET)"

db-down:
	docker-compose down

db-logs:
	docker-compose logs -f postgres

# Migrations
migrate:
	cd api && uv sync --extra dev --extra postgres
	cd api && uv run alembic upgrade head

migrate-create:
	cd api && uv sync --extra dev --extra postgres
	@read -p "Migration name: " name; \
	cd api && uv run alembic revision --autogenerate -m "$$name"

# Performance report (requires dev server running on :3000)
perf-report:
	@echo "$(CYAN)Collecting performance metrics...$(RESET)"
	@cd frontend && npx tsx e2e/perf-report.ts > perf-report.json
	@echo "$(GREEN)Report written to frontend/perf-report.json$(RESET)"
	@echo "$(DIM)Tip: cat frontend/perf-report.json | python3 -m json.tool$(RESET)"

# Cleanup
clean: dev-stop db-down
	rm -rf .logs .pids
	rm -rf warehouse/.venv warehouse/__pycache__
	rm -rf api/.venv api/__pycache__
	rm -rf api/graphlagoon/static/assets api/graphlagoon/static/.vite
	rm -rf api/dist
	rm -rf frontend/node_modules frontend/dist
	find . -type d -name "__pycache__" -exec rm -rf {} + 2>/dev/null || true
	find . -type d -name ".pytest_cache" -exec rm -rf {} + 2>/dev/null || true
	@echo "$(GREEN)Clean$(RESET)"
