.PHONY: install run dev test clean migrate migrate-create

install:
	uv sync

run:
	uv run uvicorn src.main:app --host 0.0.0.0 --port 8000 --reload

dev: run

test:
	uv run pytest -v

migrate:
	uv run alembic -c graphlagoon/alembic.ini upgrade head

migrate-create:
	uv run alembic -c graphlagoon/alembic.ini revision --autogenerate -m "$(name)"

clean:
	rm -rf .venv __pycache__ .pytest_cache
	find . -type d -name "__pycache__" -exec rm -rf {} +
