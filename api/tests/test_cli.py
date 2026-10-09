"""CLI smoke test (FA.5): the server entry point and the stdio MCP bridge."""

import json

import anyio
import httpx2
import pytest

from graphlagoon import cli

pytest.importorskip("mcp")

from mcp import Client  # noqa: E402

from tests.test_mcp_server import _rest, env  # noqa: E402,F401 (fixture)
from graphlagoon.mcp.server import mcp_lifespan  # noqa: E402


def test_serve_runs_the_packaged_app(monkeypatch):
    import uvicorn

    calls = []
    monkeypatch.setattr(uvicorn, "run", lambda app, **kw: calls.append((app, kw)))
    cli.main([])
    cli.main(["serve", "--port", "9001"])
    assert [c[0] for c in calls] == ["graphlagoon.main:app"] * 2
    assert calls[1][1]["port"] == 9001


def test_mcp_url_and_headers():
    assert cli.mcp_url("http://localhost:8000/") == "http://localhost:8000/graphlagoon/mcp"
    assert cli.mcp_url("https://x.databricksapps.com/mcp") == "https://x.databricksapps.com/mcp"
    assert cli.bridge_headers("glt_a", databricks=False) == {"Authorization": "Bearer glt_a"}
    assert cli.bridge_headers("glt_a", databricks=True) == {cli.AGENT_TOKEN_HEADER: "glt_a"}


@pytest.mark.asyncio
@pytest.mark.parametrize("databricks", [False, True])
async def test_bridge_forwards_tools_to_remote_mcp(env, databricks):  # noqa: F811
    app, _ = env
    async with mcp_lifespan(app), _rest(app) as rest:
        r = await rest.post("/api/agent-tokens", json={"name": "bridge", "scopes": ["read", "write"]})
        headers = cli.bridge_headers(r.json()["token"], databricks)
        if databricks:  # what the Apps proxy would see; the app ignores it
            headers["Authorization"] = "Bearer dapi-oauth"
        http = httpx2.AsyncClient(transport=httpx2.ASGITransport(app=app), headers=headers)

        # Two in-memory pipes stand in for the bridge's stdin/stdout.
        to_bridge_send, to_bridge_recv = anyio.create_memory_object_stream(16)
        to_client_send, to_client_recv = anyio.create_memory_object_stream(16)

        class _Stdio:
            async def __aenter__(self):
                return to_client_recv, to_bridge_send

            async def __aexit__(self, *exc):
                await to_bridge_send.aclose()

        async with anyio.create_task_group() as tg:
            tg.start_soon(
                cli.run_bridge, "http://test/mcp", http, (to_bridge_recv, to_client_send)
            )
            async with Client(_Stdio()) as client:
                tools = {t.name for t in (await client.list_tools()).tools}
                assert {"create_investigation", "propose"} <= tools
                result = await client.call_tool("create_investigation", {"title": "Via ponte"})
                assert not result.is_error, result.content
                case = json.loads(result.content[0].text)["untrusted_data"]
                assert case["title"] == "Via ponte"
