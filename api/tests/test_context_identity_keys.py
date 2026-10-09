"""Identity keys on graph contexts (investigations F1.4, 03 §2.1)."""

import sys

import pytest

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

from pydantic import ValidationError  # noqa: E402

from graphlagoon.db.memory_store import InMemoryStore  # noqa: E402
from graphlagoon.models.schemas import GraphContextUpdate  # noqa: E402

OWNER = "owner@example.com"
KEYS = [
    {
        "node_type": "Pessoa",
        "entity": "Pessoa",
        "source": {"kind": "prop", "name": "titular_cpf"},
        "normalize": "cpf_cnpj",
    },
    {"node_type": "Conta", "entity": "Conta", "source": "node_id", "normalize": "account"},
]


class TestValidation:
    def test_rejects_unknown_normalizer(self):
        with pytest.raises(ValidationError):
            GraphContextUpdate(
                identity_keys=[{"node_type": "A", "entity": "A", "normalize": "x"}]
            )

    def test_rejects_blank_entity(self):
        with pytest.raises(ValidationError):
            GraphContextUpdate(identity_keys=[{"node_type": "A", "entity": "  "}])

    def test_rejects_two_keys_for_one_node_type(self):
        with pytest.raises(ValidationError):
            GraphContextUpdate(identity_keys=[KEYS[0], {**KEYS[0], "entity": "Outra"}])

    def test_defaults_source_and_normalize(self):
        key = GraphContextUpdate(
            identity_keys=[{"node_type": "A", "entity": "A"}]
        ).identity_keys[0]
        assert key.source == "node_id" and key.normalize == "none"


@pytest.fixture
def client():
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from graphlagoon.routers import graph_contexts

    InMemoryStore.reset()
    app = FastAPI()
    app.include_router(graph_contexts.router)
    yield TestClient(app)
    InMemoryStore.reset()


def test_save_and_reload(client):
    ctx = InMemoryStore.get_instance().create_graph_context(
        title="pix", edge_table_name="e", node_table_name="n", owner_email=OWNER
    )
    h = {"X-Forwarded-Email": OWNER}
    url = f"/api/graph-contexts/{ctx.id}"
    assert client.get(url, headers=h).json()["identity_keys"] == []
    resp = client.put(url, json={"identity_keys": KEYS}, headers=h)
    assert resp.status_code == 200, resp.text
    assert client.get(url, headers=h).json()["identity_keys"] == KEYS
    # Another field's update leaves the keys alone.
    client.put(url, json={"title": "pix 2"}, headers=h)
    assert client.get(url, headers=h).json()["identity_keys"] == KEYS
