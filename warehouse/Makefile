.PHONY: install run dev test clean

install:
	uv sync

run:
	uv run uvicorn src.main:app --host 0.0.0.0 --port 8001 --reload

dev: run

test:
	uv run pytest -v

clean:
	rm -rf .venv __pycache__ .pytest_cache
	find . -type d -name "__pycache__" -exec rm -rf {} +
