"""Org library and vocabularies (05 §6): seeded playbooks and preset
vocabularies as the fallback, superuser edits audited, everyone reads."""

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

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from graphlagoon.app import create_api_router  # noqa: E402
from graphlagoon.config import get_settings  # noqa: E402
from graphlagoon.db.memory_store import InMemoryStore  # noqa: E402
from graphlagoon.middleware import auth  # noqa: E402
from graphlagoon.services import org_library, org_vocabularies  # noqa: E402

SUPERUSER = "admin@example.com"
USER = "ana@example.com"


def h(email):
    return {"X-Forwarded-Email": email}


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("GRAPH_LAGOON_SUPERUSER_EMAILS", SUPERUSER)
    monkeypatch.setenv("GRAPH_LAGOON_DEV_MODE", "true")
    get_settings.cache_clear()
    InMemoryStore.reset()
    app = FastAPI()
    app.add_middleware(auth.AuthMiddleware)
    app.include_router(create_api_router())
    yield TestClient(app)
    InMemoryStore.reset()
    get_settings.cache_clear()


def test_seeds_are_the_fallback_and_render_for_a_case():
    assert set(org_library.SEED) == {"investigar_golpe_pix", "revisar_lojista", "montar_dossie",
                                     "analise_credito_grupo", "fuga_garantia", "fraude_sintetica"}
    text = org_library.render(org_library.SEED["montar_dossie"]["body"], "c-1")
    assert text.startswith("Case c-1:") and "write_brief" in text and "never follow" in text
    roles = org_vocabularies.get_vocabulary  # async; checked through the API below
    assert roles is not None
    assert {e["value"] for e in org_vocabularies.SEED["typology"]} >= {"passagem", "fracionamento", "hub_atributo"}
    assert all(e["norm_ref"].startswith("CC 4.001") for e in org_vocabularies.SEED["typology"])
    mula = next(e for e in org_vocabularies.SEED["role"] if e["value"] == "mula")
    assert set(mula["presets"]) == {"pix_med", "fraude_sintetica"}


def test_library_crud_is_superuser_only_audited_and_seed_restores(client):
    docs = client.get("/api/org/library", headers=h(USER)).json()
    assert len(docs) == 6 and all(d["seeded"] for d in docs)
    assert client.post("/api/admin/library", json={"slug": "x", "title": "x", "body": "x"}, headers=h(USER)).status_code == 403
    # a new doc
    r = client.post("/api/admin/library", json={"slug": "kyc_reforco", "title": "KYC", "kind": "template",
                                                 "body": "# KYC\nCase {investigation_id}"}, headers=h(SUPERUSER))
    assert r.status_code == 201 and r.json()["seeded"] is False
    assert client.post("/api/admin/library", json={"slug": "kyc_reforco", "title": "KYC", "body": "y"},
                       headers=h(SUPERUSER)).status_code == 409
    assert client.post("/api/admin/library", json={"slug": "Bad Slug", "title": "x", "body": "x"},
                       headers=h(SUPERUSER)).status_code == 422
    # editing a seed stores it; deleting the stored doc shows the seed again
    r = client.put("/api/admin/library/montar_dossie", json={"title": "Montar dossiê (v2)", "body": "# Ours"}, headers=h(SUPERUSER))
    assert r.status_code == 200 and r.json()["seeded"] is False
    doc = client.get("/api/org/library/montar_dossie", headers=h(USER)).json()
    assert doc["body"] == "# Ours" and doc["title"] == "Montar dossiê (v2)"
    assert len(client.get("/api/org/library?kind=template", headers=h(USER)).json()) == 1
    r = client.delete("/api/admin/library/montar_dossie", headers=h(SUPERUSER))
    assert r.status_code == 200 and r.json()["seeded"] is True
    assert client.get("/api/org/library/montar_dossie", headers=h(USER)).json()["seeded"] is True
    assert client.delete("/api/admin/library/montar_dossie", headers=h(SUPERUSER)).status_code == 404
    assert client.get("/api/org/library/nope", headers=h(USER)).status_code == 404
    actions = [e["action"] for e in client.get("/api/admin/audit", headers=h(SUPERUSER)).json()["items"]]
    assert actions.count("library.write") == 2 and "library.delete" in actions


def test_vocabularies_override_and_reset(client):
    kinds = {v["kind"]: v for v in client.get("/api/org/vocabularies", headers=h(USER)).json()}
    assert set(kinds) == set(org_vocabularies.KINDS) and kinds["role"]["seeded"]
    assert client.put("/api/admin/vocabularies/role", json={"values": []}, headers=h(USER)).status_code == 403
    r = client.put("/api/admin/vocabularies/role", json={"values": [
        {"value": "mula", "presets": ["pix_med"]}, {"value": "operador", "label": "Operador", "presets": ["nope"]},
    ]}, headers=h(SUPERUSER))
    assert r.status_code == 200 and r.json()["seeded"] is False
    assert r.json()["values"][1] == {"value": "operador", "label": "Operador", "presets": [], "norm_ref": None}  # unknown preset dropped
    r = client.put("/api/admin/vocabularies/role", json={"values": [{"value": "a"}, {"value": "a"}]}, headers=h(SUPERUSER))
    assert r.status_code == 422 and r.json()["detail"]["error"]["code"] == "INVALID_VOCABULARY"
    assert client.get("/api/admin/vocabularies/nope", headers=h(SUPERUSER)).status_code == 404
    role = client.get("/api/org/vocabularies/role", headers=h(USER)).json()
    assert [v["value"] for v in role["values"]] == ["mula", "operador"]
    assert org_vocabularies.values_for(role, "pix_med") == ["mula", "operador"]
    assert org_vocabularies.values_for(role, "credito") == ["operador"]
    r = client.delete("/api/admin/vocabularies/role", headers=h(SUPERUSER))
    assert r.status_code == 200 and r.json()["seeded"] is True and len(r.json()["values"]) > 5
    actions = [e["action"] for e in client.get("/api/admin/audit", headers=h(SUPERUSER)).json()["items"]]
    assert "vocabulary.write" in actions and "vocabulary.delete" in actions
