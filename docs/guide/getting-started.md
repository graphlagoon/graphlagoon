# Getting Started

## Installation

### As a pip package

```bash
pip install graphlagoon
```

### From source (development)

```bash
git clone https://github.com/graphlagoon/graphlagoon.git
cd graphlagoon
make install
```

## Quick Start

### Standalone

```bash
graphlagoon serve
# Open http://localhost:8000/graphlagoon/
```

### Embedded in FastAPI

```python
from fastapi import FastAPI
from graphlagoon import create_mountable_app

app = FastAPI()
app.mount("/graphlagoon", create_mountable_app(mount_prefix="/graphlagoon"))
```

### Development mode

```bash
make dev
# Frontend: http://localhost:3000
# API:      http://localhost:8000
# Warehouse: http://localhost:8001
```

Use `make dev-stop` to stop all services.

Once running, you'll see the graph visualization:

![Graph Visualization](/screenshots/graph-visualization.png)

## Prerequisites (for development)

- Node.js 18+
- Python 3.11+
- [uv](https://docs.astral.sh/uv/)
- Docker (optional, for PostgreSQL)
