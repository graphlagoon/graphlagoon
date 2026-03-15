# Graph Lagoon Studio

Graph visualization and exploration tool with FastAPI backend.

## Installation

```bash
pip install graphlagoon
```

## Quick Start

```bash
# Start the server
uvicorn graphlagoon.app:app --host 0.0.0.0 --port 8000
```

## Usage

### Standalone Mode

```python
from graphlagoon import create_app

app = create_app()
```

### Embedded Mode

```python
from fastapi import FastAPI
from graphlagoon import create_api_router

app = FastAPI()
app.include_router(create_api_router(), prefix="/graphlagoon")
```

## Configuration

Environment variables:

- `DATABASE_ENABLED` - Enable/disable PostgreSQL (default: true)
- `DATABASE_URL` - PostgreSQL connection string
- `DATABRICKS_MODE` - Connect to Databricks directly (default: false)
- `DATABRICKS_HOST` - Databricks workspace host
- `DATABRICKS_TOKEN` - Databricks access token
- `DATABRICKS_WAREHOUSE_ID` - SQL warehouse ID
