# Contributing to Graph Lagoon Studio

## Development Setup

### Prerequisites

- Node.js 18+
- Python 3.11+
- [uv](https://docs.astral.sh/uv/) (Python package manager)
- Docker (for PostgreSQL, optional)

### Getting started

```bash
git clone https://github.com/graphlagoon/graphlagoon.git
cd graphlagoon
make install
make dev
```

This starts all three services:

| Service | URL | Description |
|---------|-----|-------------|
| Frontend | http://localhost:3000 | Vue 3 dev server with hot reload |
| API | http://localhost:8000 | FastAPI backend |
| Warehouse | http://localhost:8001 | PySpark SQL warehouse |

Use `make dev-stop` to stop all services, `make dev-logs` to view logs.

## Project Structure

```
graphlagoon/
├── frontend/          # Vue 3 + TypeScript + Pinia
│   ├── src/
│   │   ├── components/    # Vue components
│   │   ├── stores/        # Pinia stores
│   │   ├── services/      # API client, localStorage
│   │   ├── views/         # Page components
│   │   ├── utils/         # Helper functions
│   │   └── types/         # TypeScript types
│   └── e2e/               # Playwright E2E tests
├── api/               # FastAPI backend
│   └── graphlagoon/
│       ├── routers/       # API endpoints
│       ├── services/      # Business logic
│       ├── db/            # Database models
│       └── models/        # Pydantic schemas
├── warehouse/         # PySpark SQL warehouse (dev tool)
├── docs/              # Documentation (VitePress)
├── Makefile           # All commands run from root
└── docker-compose.yml # PostgreSQL
```

## Running Tests

```bash
# Unit tests (Vitest, 446 tests)
make test

# Unit tests with coverage report
make test-coverage

# E2E tests (Playwright, 30 tests — mocked API, no backend needed)
make test-e2e

# E2E tests with visible browser
make test-e2e-headed

# All tests
make test-all
```

The pre-commit hook automatically runs `vitest related` on staged `.ts` files.

## Code Style

### Frontend
- TypeScript with Vue 3 Composition API
- Pinia stores using setup syntax (`defineStore('name', () => { ... })`)
- All code, comments, and variable names in English

### Backend
- Python 3.11+ with type hints
- FastAPI with async/await
- Pydantic v2 for validation
- SQLAlchemy 2.0 async ORM

### Linting

```bash
make lint              # Run all linters
make lint-frontend     # ESLint + TypeScript
make lint-api          # Ruff check + format
```

## Build

The frontend builds into the API's static directory. The wheel package includes both:

```bash
make build             # Build frontend + Python wheel
```

The wheel is created at `api/dist/graphlagoon-*.whl`.

## Pull Request Process

1. Branch from `main`
2. Make your changes
3. Run `make test-all` and `make lint`
4. Submit PR with a clear description

## Reporting Issues

Please open an issue on [GitHub](https://github.com/graphlagoon/graphlagoon/issues) with:
- Steps to reproduce
- Expected vs actual behavior
- Browser/environment details
