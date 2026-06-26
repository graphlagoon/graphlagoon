# Deploy as a Databricks App

This guide shows how to deploy Graph Lagoon Studio as a [Databricks App](https://docs.databricks.com/aws/en/dev-tools/databricks-apps/) — the simplest production setup, because **you never manage a token**. The app runs as its own service principal and Databricks injects OAuth credentials into the runtime; Graph Lagoon's built-in [`get_oauth_service()`](#authentication-zero-token) turns those into a self-refreshing `header_provider`.

## Why Databricks Apps

- **No static token.** No `databricks_token` / PAT to rotate or leak.
- **Native identity.** The app authenticates as its own service principal, with its own Unity Catalog permissions.
- **One command to ship.** `databricks apps deploy` builds and starts the app from your source.

## Authentication (zero-token)

At runtime, Databricks Apps automatically inject these environment variables for the app's service principal:

| Variable | Injected by | Used for |
|---|---|---|
| `DATABRICKS_HOST` | App runtime | Workspace URL (token endpoint + warehouse base URL) |
| `DATABRICKS_CLIENT_ID` | App runtime | OAuth M2M client id |
| `DATABRICKS_CLIENT_SECRET` | App runtime | OAuth M2M client secret |
| `DATABRICKS_APP_PORT` | App runtime | Port your server must listen on |

Graph Lagoon ships [`get_oauth_service()`](https://github.com/graphlagoon/graphlagoon), which reads `DATABRICKS_HOST` / `DATABRICKS_CLIENT_ID` / `DATABRICKS_CLIENT_SECRET` and performs the OAuth M2M `client_credentials` exchange, caching the token and refreshing it (with a 5-minute safety margin) before it expires. Pass `get_oauth_service().get_token` as the `header_provider`:

```python
from graphlagoon import create_mountable_app, get_oauth_service

create_mountable_app(
    header_provider=get_oauth_service().get_token,  # OAuth M2M, auto-refreshed
)
```

No `databricks_token` is needed in this mode — the `header_provider` takes precedence.

## Project structure

A Databricks App is a directory deployed to your workspace. Minimal layout:

```
my-graphlagoon-app/
├── app.py            # entry point — exposes `app` (the ASGI app)
├── app.yaml          # how Databricks runs the app
└── requirements.txt  # Python dependencies
```

### `app.py`

```python
import os
from fastapi import FastAPI
from graphlagoon import (
    create_mountable_app,
    add_mount_redirect,
    get_oauth_service,
    Settings,
)

settings = Settings(
    databricks_mode=True,
    # DATABRICKS_HOST is injected by the App runtime (no GRAPH_LAGOON_ prefix)
    databricks_host=os.environ["DATABRICKS_HOST"].replace("https://", ""),
    databricks_warehouse_id=os.environ["DATABRICKS_WAREHOUSE_ID"],
    databricks_catalog="main",
    databricks_schema="default",
    # No databricks_token — auth comes from the header_provider below.
    # Optional persistence on a Unity Catalog Volume:
    # databricks_volume_path="/Volumes/main/default/graphlagoon_snapshots",
)

app = FastAPI(title="Graph Lagoon Studio")

add_mount_redirect(app, "/graphlagoon")
app.mount(
    "/graphlagoon",
    create_mountable_app(
        settings=settings,
        header_provider=get_oauth_service().get_token,
        mount_prefix="/graphlagoon",
    ),
)
```

> `DATABRICKS_WAREHOUSE_ID` is **not** auto-injected — set it yourself in `app.yaml` (see below) or hardcode it.

### `requirements.txt`

```
graphlagoon
```

### `app.yaml`

`app.yaml` defines the start command and any extra environment variables. The port **must** come from `DATABRICKS_APP_PORT`, which Databricks substitutes at runtime:

```yaml
command:
  - "uvicorn"
  - "app:app"
  - "--host"
  - "0.0.0.0"
  - "--port"
  - "$DATABRICKS_APP_PORT"

env:
  - name: "DATABRICKS_WAREHOUSE_ID"
    value: "your-warehouse-id"
  # Disable PostgreSQL persistence (in-memory store), or configure a database / Lakebase instead
  - name: "GRAPH_LAGOON_DATABASE_ENABLED"
    value: "false"
```

`app.yaml` keys: `command` (the exec sequence — defaults to `python app.py` if omitted) and `env` (a list of `{name, value}` or `{name, valueFrom}` entries). Everything `Settings` reads with the `GRAPH_LAGOON_` prefix can also be set here as `env` entries instead of in `app.py`.

## Deploy

Using the [Databricks CLI](https://docs.databricks.com/aws/en/dev-tools/cli/):

```bash
# 1. Create the app (once)
databricks apps create graphlagoon

# 2. Sync your local source to the workspace
databricks sync --watch . /Workspace/Users/you@example.com/graphlagoon

# 3. Deploy from the synced source
databricks apps deploy graphlagoon \
  --source-code-path /Workspace/Users/you@example.com/graphlagoon
```

After deployment, Databricks starts the app using the `command` from `app.yaml`. Open the app URL shown in the Databricks UI and append the mount prefix — e.g. `https://<app-url>/graphlagoon/`.

### Grant the app access

The app's service principal needs permission on the resources it reads:

- **SQL Warehouse** — `CAN USE` on the warehouse referenced by `DATABRICKS_WAREHOUSE_ID`.
- **Unity Catalog** — `SELECT` on the catalog/schema/tables you visualize (and `READ VOLUME` / `WRITE VOLUME` if you set `databricks_volume_path` for snapshots).

Grant these to the app's service principal from the app's **Authorization** settings or via `GRANT` statements.

## Persistence options

| Mode | How to enable | Use case |
|---|---|---|
| **In-memory** (default) | `GRAPH_LAGOON_DATABASE_ENABLED=false` | Development, demos — resets on restart |
| **Snapshots on a Volume** | `databricks_volume_path=/Volumes/...` | Stores explorations as gzipped JSON in Unity Catalog |
| **Lakebase** (managed Postgres) | `lakebase_enabled=true` + instance name | Production on Databricks Apps |
| **External Postgres** | `database_enabled=true` + `database_url` | Self-hosted deployments |

### Lakebase (recommended for production)

[Lakebase](https://docs.databricks.com/aws/en/oltp/) is Databricks-managed PostgreSQL, and the recommended persistence layer for a Databricks App because — like the warehouse OAuth — **you never manage a database password**. Graph Lagoon mints a short-lived OAuth credential from the app's service principal and refreshes it transparently: every 50 minutes in a background loop, with exponential-backoff retries on failure, plus an on-demand refresh if it detects an auth error mid-request.

Install the extra and enable it:

```
# requirements.txt
graphlagoon[lakebase]
```

```yaml
# app.yaml
env:
  - name: "GRAPH_LAGOON_LAKEBASE_ENABLED"
    value: "true"
  - name: "GRAPH_LAGOON_LAKEBASE_INSTANCE_NAME"
    value: "my-lakebase-instance"
  # Optional — defaults to the instance name:
  - name: "GRAPH_LAGOON_LAKEBASE_DATABASE_NAME"
    value: "graphlagoon"
  # Optional — sets the Postgres search_path:
  - name: "GRAPH_LAGOON_DEFAULT_POSTGRES_SCHEMA"
    value: "graphlagoon"
```

Setting `lakebase_enabled=true` implies `database_enabled=true`. The app's service principal needs permission on the Lakebase instance.

## Troubleshooting

**`KeyError: 'DATABRICKS_HOST'` at startup** — you're running outside a Databricks App (the var isn't injected locally). For local testing, export `DATABRICKS_HOST`, `DATABRICKS_CLIENT_ID`, `DATABRICKS_CLIENT_SECRET`, and `DATABRICKS_WAREHOUSE_ID` yourself, or use a static `databricks_token` (see [Databricks Integration → Static Token](/guide/integration#static-token)).

**401 / 403 from the warehouse** — the OAuth token is being minted but the app's service principal lacks permission. Grant it `CAN USE` on the warehouse and `SELECT` on the tables.

**App starts but is unreachable** — make sure the server binds `0.0.0.0` and uses `$DATABRICKS_APP_PORT` (not a hardcoded port) in `app.yaml`.

## References

- [Get started with Databricks Apps](https://docs.databricks.com/aws/en/dev-tools/databricks-apps/get-started)
- [Configure app execution with `app.yaml`](https://docs.databricks.com/aws/en/dev-tools/databricks-apps/app-runtime)
- [Deploy a Databricks app](https://docs.databricks.com/aws/en/dev-tools/databricks-apps/deploy)
- [Configure authorization in a Databricks app](https://docs.databricks.com/aws/en/dev-tools/databricks-apps/auth)
