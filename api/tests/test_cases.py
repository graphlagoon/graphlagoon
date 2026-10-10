"""Cases (05 §1, §3, §7): transitions, reopen, sharing, the agent's suggested
status change, a reproducible frozen hash the export verifies, InMemoryStore
parity and the 016 migration on SQLite."""

import sys
from datetime import datetime, timedelta
from uuid import UUID

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
from graphlagoon.db.memory_store import INVESTIGATION_CHILDREN, InMemoryStore  # noqa: E402
from graphlagoon.middleware import auth  # noqa: E402
from graphlagoon.services import cases as service  # noqa: E402
from graphlagoon.services import investigation_storage  # noqa: E402
from graphlagoon.services.blob_storage import LocalBlobStore  # noqa: E402

SUPERUSER = "admin@example.com"
OWNER = "owner@example.com"
READER = "reader@example.com"
EDITOR = "editor@example.com"


def h(email):
    return {"X-Forwarded-Email": email}


@pytest.fixture
def client(monkeypatch, tmp_path):
    monkeypatch.setenv("GRAPH_LAGOON_SUPERUSER_EMAILS", SUPERUSER)
    monkeypatch.setenv("GRAPH_LAGOON_DEV_MODE", "true")
    monkeypatch.setenv("GRAPH_LAGOON_AGENTS_ENABLED", "true")
    get_settings.cache_clear()
    InMemoryStore.reset()
    auth._agent_request_times.clear()
    monkeypatch.setattr(investigation_storage, "_store", LocalBlobStore(str(tmp_path)))
    app = FastAPI()
    app.add_middleware(auth.AuthMiddleware)
    app.include_router(create_api_router())
    yield TestClient(app)
    InMemoryStore.reset()
    get_settings.cache_clear()


def _case(client, **body):
    r = client.post("/api/investigations", json={"title": "Caso", **body}, headers=h(OWNER))
    assert r.status_code == 201, r.text
    return r.json()


def test_english_enums_transitions_and_reopen(client):
    inv = _case(client)
    assert (inv["status"], inv["kind_preset"], inv["deadline"]) == ("open", "livre", None)
    url = f"/api/investigations/{inv['id']}"
    r = client.patch(url, json={"status": "decided"}, headers=h(OWNER))
    assert r.status_code == 422  # only the decision route reaches "decided"
    assert client.patch(url, json={"status": "analysis"}, headers=h(OWNER)).json()["status"] == "analysis"
    assert client.patch(url, json={"status": "archived"}, headers=h(OWNER)).json()["status"] == "archived"
    r = client.patch(url, json={"status": "open"}, headers=h(OWNER))
    assert r.status_code == 409 and r.json()["detail"]["error"]["code"] == "INVALID_STATUS_TRANSITION"
    assert client.patch(url, json={"status": "analysis"}, headers=h(OWNER)).status_code == 200
    assert client.post(f"{url}/reopen", headers=h(OWNER)).status_code == 409  # not decided
    decided = client.post(
        f"{url}/decision", json={"outcome": "arquivar", "rationale": "nada"}, headers=h(OWNER)
    ).json()
    assert decided["status"] == "decided" and decided["frozen_hash"]
    reopened = client.post(f"{url}/reopen", headers=h(OWNER)).json()
    assert (reopened["status"], reopened["decision"], reopened["frozen_hash"]) == ("analysis", None, None)
    kinds = [e["kind"] for e in client.get(f"{url}/events", headers=h(OWNER)).json()]
    assert kinds[-3:] == ["case.updated", "decision.recorded", "case.reopened"]
    assert "hash" not in client.get(f"{url}/events", headers=h(OWNER)).json()[0]


def test_deadline_only_for_presets_with_phases(client, monkeypatch):
    alert = datetime(2026, 1, 1)
    monkeypatch.setattr(service, "_clock", lambda: alert + timedelta(days=10))
    pix = _case(client, kind_preset="pix_med", alert_at=alert.isoformat())
    assert pix["deadline"]["phase"] == "open" and pix["deadline"]["days_left"] == 35
    url = f"/api/investigations/{pix['id']}"
    analysis = client.patch(url, json={"status": "analysis"}, headers=h(OWNER)).json()
    assert analysis["deadline"]["days_left"] == 80  # 45 + 45 from the alert
    custom = client.patch(url, json={"deadline_days": {"open": 10, "analysis": 5}}, headers=h(OWNER)).json()
    assert custom["deadline"]["days_left"] == 5
    credito = _case(client, kind_preset="credito")
    assert credito["deadline"] is None
    custom = _case(client, kind_preset="credito", alert_at=alert.isoformat(), deadline_days={"open": 30})
    assert custom["deadline"]["days_left"] == 20


def test_share_roles_assignee_and_access(client):
    inv = _case(client, assignee_email=EDITOR)
    url = f"/api/investigations/{inv['id']}"
    assert inv["shared_with"] == [{"email": EDITOR, "role": "editor"}]  # assignee ⇒ editor share
    assert client.post(f"{url}/share", json={"email": "*@example.com"}, headers=h(OWNER)).status_code == 422
    assert client.post(f"{url}/share", json={"email": READER}, headers=h(OWNER)).status_code == 200
    as_reader = client.get(url, headers=h(READER)).json()
    assert (as_reader["has_write_access"], as_reader["can_manage"]) == (False, False)
    assert client.patch(url, json={"title": "x"}, headers=h(READER)).status_code == 403
    assert client.patch(url, json={"title": "x"}, headers=h(EDITOR)).status_code == 200
    # Only who can share assigns.
    assert client.patch(url, json={"assignee_email": READER}, headers=h(EDITOR)).status_code == 403
    assert client.get(url, headers=h("nobody@example.com")).status_code == 404
    assert client.delete(f"{url}/share/{READER}", headers=h(OWNER)).status_code == 200
    assert client.get(url, headers=h(READER)).status_code == 404
    listed = client.get("/api/investigations", headers=h(EDITOR)).json()
    assert [i["id"] for i in listed] == [inv["id"]] and listed[0]["item_count"] == 0


def test_agent_status_change_becomes_a_suggestion(client):
    inv = _case(client)
    url = f"/api/investigations/{inv['id']}"
    token = client.post("/api/agent-tokens", json={"name": "claude"}, headers=h(OWNER)).json()["token"]
    agent = {"Authorization": f"Bearer {token}"}
    r = client.patch(url, json={"status": "analysis"}, headers=agent)
    assert r.status_code == 200 and r.json()["status"] == "open"
    [suggestion] = client.get(f"{url}/annotations", headers=h(OWNER)).json()
    assert suggestion["kind"] == "status_change" and suggestion["status"] == "suggested"
    assert suggestion["author_kind"] == "agent" and suggestion["value"] == {"from": "open", "to": "analysis"}
    assert client.post(f"{url}/annotations/{suggestion['id']}/confirm", headers=agent).status_code == 403
    r = client.post(f"{url}/annotations/{suggestion['id']}/confirm", headers=h(OWNER))
    assert r.status_code == 200 and r.json()["confirmed_by"] == OWNER
    assert client.get(url, headers=h(OWNER)).json()["status"] == "analysis"
    assert client.get("/api/investigations", headers=h(OWNER)).json()[0]["suggested_count"] == 0
    # A kind outside agent_suggest_kinds applies directly.
    client.patch(url, json={"settings": {"agent_suggest_kinds": []}}, headers=h(OWNER))
    assert client.patch(url, json={"status": "open"}, headers=agent).json()["status"] == "open"


DECISION = {"outcome": "comunicar", "actions": ["dict", "spa"], "rationale": "Conta de passagem."}


def _hash_now(url):
    import asyncio

    inv = InMemoryStore.get_instance().get_investigation(UUID(url.rsplit("/", 1)[1]))
    return asyncio.run(service.compute_frozen_hash(None, inv))


def test_decision_hash_is_reproducible_and_the_export_verifies_it(client):
    inv = _case(client)
    url = f"/api/investigations/{inv['id']}"
    client.post(f"{url}/share", json={"email": READER}, headers=h(OWNER))
    item = client.post(
        f"{url}/items",
        json={"kind": "document", "subkind": "markdown", "title": "KYC", "content": "# KYC\nrenda 1800"},
        headers=h(OWNER),
    ).json()
    pin = client.post(f"{url}/items/{item['id']}/pin", json={"label": "E1"}, headers=h(OWNER))
    assert pin.status_code == 200 and pin.json()["pinned_by"] == OWNER
    assert client.post(f"{url}/decision", json=DECISION, headers=h(READER)).status_code == 403
    assert client.post(f"{url}/decision", json={**DECISION, "rationale": " "}, headers=h(OWNER)).status_code == 422

    r = client.post(f"{url}/decision", json=DECISION, headers=h(OWNER))
    assert r.status_code == 200, r.text
    decided = r.json()
    assert decided["status"] == "decided" and decided["decision"]["actions"] == ["dict", "spa"]
    assert _hash_now(url) == decided["frozen_hash"]
    # A later share stays outside the hash; tampering with a pinned version is detected.
    assert client.post(f"{url}/share", json={"email": "x@example.com"}, headers=h(OWNER)).status_code == 200
    assert _hash_now(url) == decided["frozen_hash"]
    export = client.get(f"{url}/export?format=json", headers=h(OWNER))
    assert export.status_code == 200 and export.headers["X-Content-SHA256"]
    package = export.json()
    assert package["frozen_hash_valid"] is True and package["evidence"][0]["pin_label"] == "E1"
    version = next(iter(InMemoryStore.get_instance().case_item_versions.values()))
    version.sha256 = "0" * 64
    assert client.get(f"{url}/export?format=json", headers=h(OWNER)).json()["frozen_hash_valid"] is False
    assert client.get(f"{url}/export?format=csv", headers=h(OWNER)).status_code == 200
    assert client.get(f"{url}/export?format=siscoaf", headers=h(OWNER)).json()["ready_to_communicate"]

    # Read-only afterwards, except archiving; retained from deletion.
    for method, path, body in (
        ("patch", url, {"title": "y"}),
        ("post", f"{url}/items", {"kind": "note", "subkind": "free", "content": "x"}),
        ("post", f"{url}/annotations", {"kind": "tag", "targets": ["a"], "value": {"tag": "t"}}),
        ("post", f"{url}/items/{item['id']}/pin", {}),
        ("post", f"{url}/decision", DECISION),
        ("delete", url, None),
    ):
        r = getattr(client, method)(path, headers=h(OWNER), **({"json": body} if body is not None else {}))
        assert r.status_code == 409, (method, path, r.text)
    assert client.patch(url, json={"status": "archived"}, headers=h(OWNER)).status_code == 200
    actions = [e.action for e in InMemoryStore.get_instance().usage_logs]
    assert {"investigation.decide", "investigation.export"} <= set(actions)


def test_superuser_deletes_a_retained_case_with_a_reason(client):
    inv = _case(client)
    url = f"/api/investigations/{inv['id']}"
    client.post(f"{url}/decision", json=DECISION, headers=h(OWNER))
    assert client.delete(url, headers=h(SUPERUSER)).status_code == 409
    assert client.delete(f"{url}?reason=audit", headers=h(SUPERUSER)).status_code == 200


# ---------------------------------------------------------------------------
# InMemoryStore parity
# ---------------------------------------------------------------------------

CHILD_FIELDS = {
    "case_items": {"kind": "note", "subkind": "free", "title": "t", "author_email": OWNER},
    "case_item_versions": {
        "item_id": None, "version": 1, "sha256": "0" * 64, "blob_key": "k", "size_bytes": 1,
        "content_type": "text/plain", "created_by": OWNER,
    },
    "case_annotations": {"kind": "role", "author_email": OWNER},
    "investigation_events": {"actor_email": OWNER, "kind": "case.created"},
}


def test_child_fields_cover_every_table():
    assert set(CHILD_FIELDS) == set(INVESTIGATION_CHILDREN)


@pytest.mark.parametrize("table", sorted(CHILD_FIELDS))
def test_memory_child_crud_and_cascade(table):
    store = InMemoryStore()
    inv = store.create_investigation("c", OWNER)
    row = store.add_investigation_child(table, investigation_id=inv.id, **CHILD_FIELDS[table])
    assert store.get_investigation_child(table, row.id) is row
    assert store.list_investigation_children(table, inv.id) == [row]
    field = next(iter(CHILD_FIELDS[table]))
    store.update_investigation_child(table, row.id, **{field: "changed"})
    assert getattr(row, field) == "changed"
    store.delete_investigation(inv.id)
    assert store.get_investigation_child(table, row.id) is None


def test_memory_item_delete_cascades_versions_and_exploration_delete_nulls_the_ref():
    store = InMemoryStore()
    ctx = store.create_graph_context("t", "e", "n", OWNER)
    exp = store.create_exploration(ctx.id, "x", OWNER, {})
    inv = store.create_investigation("c", OWNER)
    item = store.add_investigation_child(
        "case_items", investigation_id=inv.id, kind="graph", subkind="exploration_ref", title="x",
        author_email=OWNER, exploration_id=exp.id, context_id=ctx.id,
    )
    version = store.add_investigation_child(
        "case_item_versions", investigation_id=inv.id, item_id=item.id, version=1, sha256="0" * 64,
        blob_key="k", size_bytes=1, content_type="text/plain", created_by=OWNER,
    )
    store.delete_exploration(exp.id)
    assert item.exploration_id is None and item.context_id == ctx.id
    store.delete_investigation_child("case_items", item.id)
    assert store.get_investigation_child("case_item_versions", version.id) is None
    store.share_investigation(inv.id, "a@example.com")
    store.share_investigation(inv.id, "a@example.com", "editor")  # upsert
    assert [(s.email, s.role) for s in inv.shares] == [("a@example.com", "editor")]
    assert store.unshare_investigation(inv.id, "a@example.com")


# ---------------------------------------------------------------------------
# Migration 016 on SQLite: upgrade, idempotent upgrade, downgrade, re-upgrade
# ---------------------------------------------------------------------------


def _migration():
    import importlib.util
    from pathlib import Path

    import graphlagoon

    path = Path(graphlagoon.__file__).parent / "alembic" / "versions" / "016_cases.py"
    spec = importlib.util.spec_from_file_location("migration_016", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_016_runs_on_sqlite_and_replaces_the_old_chain():
    import sqlalchemy as sa
    from alembic.migration import MigrationContext
    from alembic.operations import Operations

    migration = _migration()
    assert (migration.revision, migration.down_revision) == ("016", "015")
    from pathlib import Path

    import graphlagoon

    names = {p.name for p in (Path(graphlagoon.__file__).parent / "alembic" / "versions").glob("01[6-9]*.py")}
    assert names == {"016_cases.py"}

    engine = sa.create_engine("sqlite://")
    with engine.begin() as conn:
        conn.execute(sa.text("CREATE TABLE graph_contexts (id CHAR(32) PRIMARY KEY)"))
        conn.execute(sa.text("CREATE TABLE explorations (id CHAR(32) PRIMARY KEY)"))
        for _ in range(2):  # idempotent
            with Operations.context(MigrationContext.configure(conn)):
                migration.upgrade()
        tables = set(sa.inspect(conn).get_table_names())
        assert set(migration.TABLES) <= tables
        assert {c["name"] for c in sa.inspect(conn).get_columns("case_items")} >= {
            "kind", "subkind", "status", "author_kind", "provenance", "query", "mapping", "anchor", "deleted_at",
        }
        assert {c["name"] for c in sa.inspect(conn).get_columns("graph_contexts")} >= {"identity_keys", "edge_semantics"}
        assert "scopes" not in {c["name"] for c in sa.inspect(conn).get_columns("agent_tokens")}
        with Operations.context(MigrationContext.configure(conn)):
            migration.downgrade()
        assert not set(migration.TABLES) & set(sa.inspect(conn).get_table_names())
        with Operations.context(MigrationContext.configure(conn)):
            migration.upgrade()
        assert set(migration.TABLES) <= set(sa.inspect(conn).get_table_names())


def test_preset_defaults_and_settings_patch(client):
    """A preset only fills defaults (05 §4b); the settings PATCH keeps identity keys,
    edge semantics by type, vocabularies and label templates as given."""
    inv = _case(client, kind_preset="fraude_sintetica")
    vocab = inv["settings"]["vocabularies"]
    assert vocab["roles"] == ["identidade real", "identidade sintética", "mula", "ponto de cash-out"]
    assert vocab["link_attributes"] == ["telefone", "email", "device_id", "endereco"]
    assert _case(client)["settings"]["vocabularies"] == {"roles": [], "link_attributes": []}
    assert _case(client, settings={"vocabularies": {"roles": ["x"]}})["settings"]["vocabularies"] == {"roles": ["x"]}

    url = f"/api/investigations/{inv['id']}"
    settings = {
        "identity_keys": [{"node_type": "Login", "entity": "Sessao", "source": {"kind": "prop", "name": "ua"}, "normalize": "regex", "pattern": "sid=(\\w+)"}],
        "edge_semantics": {"USA": {"weight_prop": "vezes", "timestamp_prop": "quando"}, "*": {"amount_prop": "valor", "time_prop": "data"}},
        "vocabularies": {"roles": ["mula"], "tags": ["kyc"], "link_attributes": ["telefone"]},
        "label_templates": {"Pessoa": "{nome} · {cpf_mascarado}"},
        "agent_suggest_kinds": ["role"],
    }
    r = client.patch(url, json={"settings": settings}, headers=h(OWNER))
    assert r.status_code == 200 and r.json()["settings"] == settings
    assert client.get(url, headers=h(OWNER)).json()["settings"] == settings
    events = client.get(f"{url}/events", headers=h(OWNER)).json()
    assert events[-1]["kind"] == "case.updated" and "settings" in events[-1]["payload"]
