"""Edge semantics on graph contexts (investigations F3.1, 03 §2.1)."""

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
from graphlagoon.services.file_mapping import MappingError, validate  # noqa: E402
from graphlagoon.services.file_mapping_presets import PRESETS  # noqa: E402

OWNER = "owner@example.com"
SEM = {"amount_prop": "valor", "amount_unit": "cents", "time_prop": "data", "currency": "BRL",
       "timestamp_prop": None, "weight_prop": None}


class TestValidation:
    @pytest.mark.parametrize("bad", [{"amount_unit": "reais"}, {"currency": "brl"}])
    def test_rejects(self, bad):
        with pytest.raises(ValidationError):
            GraphContextUpdate(edge_semantics=bad)

    def test_defaults_and_blank_props(self):
        sem = GraphContextUpdate(edge_semantics={"amount_prop": " ", "time_prop": "t"}).edge_semantics
        assert sem.model_dump() == {
            "amount_prop": None, "amount_unit": "units", "time_prop": "t", "currency": "BRL",
            "timestamp_prop": None, "weight_prop": None,
        }

    def test_file_mapping_checks_the_same_shape(self):
        spec = {**PRESETS["simba_v31"], "edge_semantics": {"amount_prop": "valor", "currency": "R$"}}
        with pytest.raises(MappingError, match="edge_semantics"):
            validate(spec)


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
    assert client.get(url, headers=h).json()["edge_semantics"]["amount_prop"] is None
    resp = client.put(url, json={"edge_semantics": SEM}, headers=h)
    assert resp.status_code == 200, resp.text
    assert client.get(url, headers=h).json()["edge_semantics"] == SEM
    # Another field's update leaves the semantics alone.
    client.put(url, json={"title": "pix 2"}, headers=h)
    assert client.get(url, headers=h).json()["edge_semantics"] == SEM
