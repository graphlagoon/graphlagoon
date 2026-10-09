"""MCP server at /mcp (FA.4): the SDK client runs the acceptance script."""

import json
import sys

import pytest

pytest.importorskip("mcp")

try:
    import gsql2rsql  # noqa: F401
except ImportError:
    from unittest.mock import MagicMock as _MagicMock

    for _name in (
        "gsql2rsql",
        "gsql2rsql.parser",
        "gsql2rsql.parser.opencypher_parser",
        "gsql2rsql.planner",
        "gsql2rsql.planner.logical_plan",
        "gsql2rsql.planner.subquery_flattening",
        "gsql2rsql.planner.pass_manager",
        "gsql2rsql.renderer",
        "gsql2rsql.renderer.sql_renderer",
        "gsql2rsql.renderer.schema_provider",
        "gsql2rsql.common",
        "gsql2rsql.common.schema",
    ):
        sys.modules[_name] = _MagicMock()

import httpx  # noqa: E402
import httpx2  # noqa: E402
from fastapi import FastAPI  # noqa: E402
from mcp import Client  # noqa: E402
from mcp.client.streamable_http import streamable_http_client  # noqa: E402

from graphlagoon.app import create_api_router  # noqa: E402
from graphlagoon.config import get_settings  # noqa: E402
from graphlagoon.db.memory_store import InMemoryStore  # noqa: E402
from graphlagoon.mcp.server import mask_text, mcp_lifespan, mount_mcp  # noqa: E402
from graphlagoon.middleware import auth  # noqa: E402
from graphlagoon.services import investigation_storage, snapshot  # noqa: E402
from graphlagoon.services.blob_storage import LocalBlobStore  # noqa: E402

OWNER = "owner@example.com"
CPF = "123.456.789-01"
SNAPSHOT = {
    "nodes": [
        {"id": "p1", "type": "Pessoa", "properties": {"nome": "Ana", "cpf": CPF}},
        {"id": "c1", "type": "Conta", "properties": {"conta": "0341-1234-567890"}},
    ],
    "edges": [{"id": "e1", "source": "p1", "target": "c1", "type": "TITULAR", "properties": {}}],
}


class _Snapshots:
    async def load(self, exploration_id):
        return snapshot.compress_snapshot(SNAPSHOT)


@pytest.fixture
def env(monkeypatch, tmp_path):
    monkeypatch.setenv("GRAPH_LAGOON_DEV_MODE", "true")
    monkeypatch.setenv("GRAPH_LAGOON_AGENTS_ENABLED", "true")
    get_settings.cache_clear()
    InMemoryStore.reset()
    auth._agent_request_times.clear()
    monkeypatch.setattr(investigation_storage, "_store", LocalBlobStore(str(tmp_path)))
    monkeypatch.setattr(snapshot, "get_snapshot_service", lambda: _Snapshots())
    store = InMemoryStore.get_instance()
    context = store.create_graph_context(
        "Pix",
        "e",
        "n",
        OWNER,
        identity_keys=[
            {
                "node_type": "Pessoa",
                "entity": "Pessoa",
                "source": {"name": "cpf"},
                "normalize": "cpf_cnpj",
            }
        ],
    )
    exploration = store.create_exploration(
        context.id, "Contas mula", OWNER, {"has_snapshot": True}
    )
    app = FastAPI()
    app.add_middleware(auth.AuthMiddleware)
    app.include_router(create_api_router())
    mount_mcp(app)
    yield app, exploration
    InMemoryStore.reset()
    get_settings.cache_clear()


def _rest(app):
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://test",
        headers={"X-Forwarded-Email": OWNER},
    )


def _mcp(app, token):
    http = httpx2.AsyncClient(
        transport=httpx2.ASGITransport(app=app),
        headers={"Authorization": f"Bearer {token}"},
    )
    return Client(streamable_http_client("http://test/mcp", http_client=http))


async def _tool(client, tool, **args):
    result = await client.call_tool(tool, args)
    assert not result.is_error, result.content
    return json.loads(result.content[0].text)["untrusted_data"]


@pytest.mark.asyncio
async def test_agent_script_is_journaled_as_agent_and_masked(env):
    app, exploration = env
    async with mcp_lifespan(app), _rest(app) as rest:
        r = await rest.post(
            "/api/agent-tokens",
            json={"name": "claude", "scopes": ["read", "write", "propose"]},
        )
        token = r.json()["token"]

        async with _mcp(app, token) as client:
            tools = {t.name for t in (await client.list_tools()).tools}
            assert {"create_investigation", "get_graph", "propose"} <= tools
            assert not tools & {"delete_investigation", "share_investigation", "approve_artifact"}
            prompts = {p.name for p in (await client.list_prompts()).prompts}
            assert prompts == {"investigar_golpe_pix", "revisar_lojista", "montar_dossie"}
            prompt = await client.get_prompt("montar_dossie", {"investigation_id": "c-1"})
            assert "c-1" in prompt.messages[0].content.text

            case = await _tool(client, "create_investigation", title="Golpe Pix")
            cid = case["id"]
            await _tool(
                client, "add_source", investigation_id=cid, exploration_id=str(exploration.id)
            )
            graph = await _tool(client, "get_graph", investigation_id=cid)
            dump = json.dumps(graph)
            # CPF and account leave masked, in properties and in the unified id.
            assert "456.789" in dump and CPF not in dump and "12345678901" not in dump
            assert "1234-567890" not in dump
            person = next(n for n in graph["nodes"] if n["type"] == "Pessoa")
            assert person["uid"] == "Pessoa:***.456.789-**"

            await _tool(
                client,
                "add_note",
                investigation_id=cid,
                body="Recebeu de 5 vítimas",
                anchor_kind="node",
                anchor_id=person["uid"],
            )
            await _tool(
                client,
                "upload_artifact",
                investigation_id=cid,
                name="resumo.md",
                text=f"# Resumo\nTitular {CPF}",
            )
            arts = await _tool(client, "list_artifacts", investigation_id=cid)
            content = await _tool(
                client, "get_artifact", investigation_id=cid, artifact_id=arts[0]["id"]
            )
            assert CPF not in content["text"]
            up = await _tool(
                client,
                "upload_file",
                investigation_id=cid,
                filename="qsa.csv",
                role="enrichment",
                text=f"cnpj;socio\n12.345.678/0001-90;{CPF}",
            )
            got = await _tool(client, "get_file", investigation_id=cid, file_id=up["id"])
            assert CPF not in got["text"] and "0001-90" not in got["text"]
            mapped = await _tool(
                client,
                "set_file_mapping",
                investigation_id=cid,
                file_id=up["id"],
                mapping={"name": "QSA", "input": {"delimiter": ";"}, "key_column": "cnpj",
                         "columns": ["socio"], "match_node_types": ["Lojista"]},
            )
            assert mapped["mapping"]["key_column"] == "cnpj"
            await _tool(
                client,
                "propose",
                investigation_id=cid,
                kind="role",
                payload={"entity": person["uid"], "role": "mule"},
                rationale="Repassa em minutos",
            )
            entity = await _tool(client, "get_entity", investigation_id=cid, uid=person["uid"])
            assert entity["notes"][0]["body"] == "Recebeu de 5 vítimas"

        # A person sees the real id; every write shows the agent acting for OWNER.
        proposals = (await rest.get(f"/api/investigations/{cid}/proposals")).json()
        assert proposals[0]["payload"]["entity"] == "Pessoa:12345678901"
        events = (await rest.get(f"/api/investigations/{cid}/events")).json()
        assert {e["kind"] for e in events} >= {
            "source.added",
            "note.created",
            "artifact.created",
            "file.uploaded",
            "proposal.created",
        }
        assert all(
            e["actor_kind"] == "agent" and e["agent_name"] == "claude" for e in events
        )
        assert all(e["actor_email"] == OWNER for e in events)


@pytest.mark.asyncio
async def test_scopes_and_people_are_kept_out(env):
    app, _ = env
    async with mcp_lifespan(app), _rest(app) as rest:
        token = (
            await rest.post("/api/agent-tokens", json={"name": "ro", "scopes": ["read"]})
        ).json()["token"]
        async with _mcp(app, token) as client:
            result = await client.call_tool("create_investigation", {"title": "x"})
            assert result.is_error and "write" in result.content[0].text
        # Without an agent token there is no MCP: a person uses the UI.
        assert (await rest.post("/mcp", json={})).status_code == 401


@pytest.mark.asyncio
async def test_lookup_enrichment_reads_the_context_table_masked(env, monkeypatch):
    from graphlagoon.services import warehouse as warehouse_module

    app, exploration = env
    InMemoryStore.get_instance().update_graph_context(
        exploration.graph_context_id,
        enrichment_tables=[
            {
                "name": "devices",
                "label": "Dispositivos",
                "table": "main.graphs.devices",
                "key_column": "account_id",
                "match_node_types": ["Conta"],
                "match_source": "node_id",
                "cardinality": "many",
                "columns": ["device_id", "conta_destino"],
            }
        ],
    )
    seen = []

    class _Warehouse:
        async def execute_statement(self, statement, parameters=None, **_):
            from graphlagoon.models.schemas import StatementResponse

            seen.append(parameters)
            names = ["account_id", "device_id", "conta_destino"]
            return StatementResponse(
                statement_id="s",
                status={"state": "SUCCEEDED"},
                manifest={
                    "schema": {
                        "column_count": 3,
                        "columns": [
                            {"name": n, "type_name": "STRING", "type_text": "STRING", "position": i}
                            for i, n in enumerate(names)
                        ],
                    },
                    "total_row_count": 1,
                },
                result={"data_array": [["c1", "dev-9", "0001-99887766"]]},
            )

    monkeypatch.setattr(warehouse_module, "get_warehouse_client", lambda: _Warehouse())
    async with mcp_lifespan(app), _rest(app) as rest:
        token = (
            await rest.post("/api/agent-tokens", json={"name": "ro", "scopes": ["read"]})
        ).json()["token"]
        cid = (await rest.post("/api/investigations", json={"title": "x"})).json()["id"]
        await rest.post(
            f"/api/investigations/{cid}/sources",
            json={"exploration_id": str(exploration.id)},
        )
        async with _mcp(app, token) as client:
            graph = await _tool(client, "get_graph", investigation_id=cid)
            conta = next(n for n in graph["nodes"] if n["type"] == "Conta")
            out = await _tool(
                client, "lookup_enrichment", investigation_id=cid, uid=conta["uid"], table="devices"
            )
            assert out["rows"] == [{"device_id": "dev-9", "conta_destino": "****-******66"}]
            assert seen[0][0]["value"] == "c1"
            missing = await client.call_tool(
                "lookup_enrichment",
                {"investigation_id": cid, "uid": conta["uid"], "table": "kyc"},
            )
            assert missing.is_error and "ENRICHMENT_TABLE_NOT_FOUND" in missing.content[0].text


def test_mask_text_keeps_the_middle_digits():
    assert mask_text("CPF 123.456.789-01") == "CPF ***.456.789-**"
    assert mask_text("12345678000199") == "**.345.678/****-**"
    assert mask_text("sha 0a12345678901b") == "sha 0a12345678901b"  # not a document
