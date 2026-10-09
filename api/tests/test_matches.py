"""Entity matches (F2.8): ER parity with the shared fixture, suggestions stored
as "sugerido" (never merged on their own), decisions with a reason in the journal."""

import json
import sys
from pathlib import Path

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

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from graphlagoon.app import create_api_router  # noqa: E402
from graphlagoon.config import get_settings  # noqa: E402
from graphlagoon.db.memory_store import InMemoryStore  # noqa: E402
from graphlagoon.middleware import auth  # noqa: E402

OWNER = "owner@example.com"

from graphlagoon.services.entity_resolution import suggest  # noqa: E402

OWNER = "owner@example.com"
READER = "reader@example.com"
FIXTURE = Path(__file__).resolve().parents[2] / "frontend/src/__tests__/fixtures/er/matches.json"


def h(email):
    return {"X-Forwarded-Email": email}


def test_er_matches_the_shared_fixture():
    if not FIXTURE.is_file():
        pytest.skip("frontend fixtures not checked out")
    data = json.loads(FIXTURE.read_text())
    assert suggest(data["nodes"]) == data["expected"]


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("GRAPH_LAGOON_DEV_MODE", "true")
    get_settings.cache_clear()
    InMemoryStore.reset()
    app = FastAPI()
    app.add_middleware(auth.AuthMiddleware)
    app.include_router(create_api_router())
    yield TestClient(app)
    InMemoryStore.reset()
    get_settings.cache_clear()


MASKED = {
    "left": {"uid": "Pessoa:12341820790"},
    "right": {"uid": "s1@ctx-qsa"},
    "score": 0.94,
    "reasons": [{"term": "cpf_middle6", "weight": 0.3, "value": 1, "masked": True}],
    "status": "aceito",  # ignored: a suggestion is never stored decided
}


def test_masked_match_waits_for_a_reasoned_human_decision(client):
    url = f"/api/investigations/{client.post('/api/investigations', json={'title': 'x'}, headers=h(OWNER)).json()['id']}"
    client.post(f"{url}/share", json={"email": READER}, headers=h(OWNER))
    r = client.post(f"{url}/matches", json={"matches": [MASKED, MASKED]}, headers=h(OWNER))
    assert r.status_code == 201, r.text
    [m] = r.json()  # the same pair once
    assert m["status"] == "sugerido"
    assert client.post(f"{url}/matches", json={"matches": [MASKED]}, headers=h(READER)).status_code == 403

    patch = f"{url}/matches/{m['id']}"
    assert client.patch(patch, json={"status": "aceito", "reason_text": ""}, headers=h(OWNER)).status_code == 422
    r = client.patch(patch, json={"status": "adiado", "reason_text": "pedir KYC"}, headers=h(OWNER))
    assert r.json()["status"] == "adiado"
    r = client.patch(patch, json={"status": "aceito", "reason_text": "endereço do KYC"}, headers=h(OWNER))
    assert r.json()["status"] == "aceito" and r.json()["decided_by"] == OWNER
    assert client.patch(patch, json={"status": "recusado", "reason_text": "x"}, headers=h(OWNER)).status_code == 409

    decided = [e["payload"] for e in client.get(f"{url}/events", headers=h(OWNER)).json()
               if e["kind"] == "match.decided"]
    assert [(d["status"], d["reason"]) for d in decided] == [
        ("adiado", "pedir KYC"), ("aceito", "endereço do KYC")]
