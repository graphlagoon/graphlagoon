"""CLI entry point for Graph Lagoon Studio.

``graphlagoon [serve]`` runs the server; ``graphlagoon mcp-bridge --url <app>``
is a local stdio MCP server that forwards every message to the app's remote
``/mcp`` endpoint (for agents that cannot reach it directly, 03 §8 / Q7).
"""

import argparse
import os
import sys
from urllib.parse import urlsplit

DEFAULT_MCP_PATH = "/graphlagoon/mcp"
# Behind the Databricks Apps proxy the Authorization header carries the
# Databricks OAuth token, so the agent token travels in its own header.
AGENT_TOKEN_HEADER = "X-Graphlagoon-Agent-Token"


def mcp_url(url: str) -> str:
    """The app URL as given if it already ends in ``/mcp``; else ``{url}/graphlagoon/mcp``."""
    url = url.rstrip("/")
    return url if urlsplit(url).path.endswith("/mcp") else url + DEFAULT_MCP_PATH


def _databricks_auth():
    """httpx2 auth that adds the Databricks CLI/SDK OAuth headers to each request
    (refreshed by the SDK), or None without ``databricks-sdk`` or a configured
    profile (``databricks auth login`` / ``DATABRICKS_*`` env vars)."""
    try:
        from databricks.sdk.core import Config

        config = Config()
    except Exception:  # not installed or no profile: agent token only
        return None
    import httpx2

    class _Auth(httpx2.Auth):
        def auth_flow(self, request):
            request.headers.update(config.authenticate())
            yield request

    return _Auth()


def bridge_headers(token, databricks: bool) -> dict:
    if not token:
        return {}
    if databricks:
        return {AGENT_TOKEN_HEADER: token}
    return {"Authorization": f"Bearer {token}"}


async def run_bridge(url: str, http_client, local_streams) -> None:
    """Forward MCP messages between ``local_streams`` (read, write) and the
    Streamable HTTP endpoint at ``url`` until the local side closes."""
    import anyio
    from mcp.client.streamable_http import streamable_http_client

    async def pump(source, sink):
        async for message in source:
            if isinstance(message, Exception):
                print(f"mcp-bridge: {message}", file=sys.stderr)
                continue
            await sink.send(message)

    local_read, local_write = local_streams
    async with streamable_http_client(url, http_client=http_client) as (remote_read, remote_write):
        async with anyio.create_task_group() as tg:
            tg.start_soon(pump, remote_read, local_write)
            await pump(local_read, remote_write)
            tg.cancel_scope.cancel()
    await local_write.aclose()  # lets stdio_server's stdout writer finish on EOF


async def _bridge_stdio(args) -> None:
    from mcp.server.stdio import stdio_server
    from mcp.shared._httpx_utils import create_mcp_http_client

    auth = _databricks_auth()
    headers = bridge_headers(args.token, databricks=auth is not None)
    if not headers:
        sys.exit("mcp-bridge: pass --token glt_… or set GRAPHLAGOON_AGENT_TOKEN")
    url = mcp_url(args.url)
    print(
        f"mcp-bridge: {url} ({'Databricks OAuth + ' if auth else ''}agent token)",
        file=sys.stderr,
    )
    async with create_mcp_http_client(headers=headers, auth=auth) as http:
        async with stdio_server() as streams:
            await run_bridge(url, http, streams)


def _serve(args) -> None:
    if args.no_frontend:
        os.environ["GRAPH_LAGOON_NO_FRONTEND"] = "true"

    import uvicorn

    uvicorn.run("graphlagoon.main:app", host=args.host, port=args.port, reload=args.reload)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="graphlagoon",
        description="Graph Lagoon Studio - Graph visualization and exploration tool",
    )
    commands = parser.add_subparsers(dest="command")

    serve = commands.add_parser("serve", help="Run the server (default)")
    for p in (parser, serve):
        p.add_argument("--host", default="0.0.0.0", help="Host to bind to (default: 0.0.0.0)")
        p.add_argument(
            "--port",
            type=int,
            default=int(os.getenv("GRAPH_LAGOON_PORT", "8000")),
            help="Port to bind to (default: 8000 or GRAPH_LAGOON_PORT env var)",
        )
        p.add_argument("--reload", action="store_true", help="Enable auto-reload for development")
        p.add_argument(
            "--no-frontend", action="store_true", help="Disable frontend serving (API only)"
        )

    bridge = commands.add_parser(
        "mcp-bridge", help="Local stdio MCP server that forwards to the app's /mcp"
    )
    bridge.add_argument(
        "--url",
        required=True,
        help=f"App URL (…{DEFAULT_MCP_PATH} is appended unless it ends in /mcp)",
    )
    bridge.add_argument(
        "--token",
        default=os.getenv("GRAPHLAGOON_AGENT_TOKEN"),
        help="Agent token glt_… (default: GRAPHLAGOON_AGENT_TOKEN env var)",
    )
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    if args.command == "mcp-bridge":
        import anyio

        anyio.run(_bridge_stdio, args)
    else:
        _serve(args)


if __name__ == "__main__":
    main()
