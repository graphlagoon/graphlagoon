"""Agent tokens, case scoping and the agent actor in the journal
(FA.1, F0 of 05-plano-v2), memory store."""

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

from datetime import datetime, timedelta  # noqa: E402
from uuid import UUID  # noqa: E402

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from graphlagoon.app import create_api_router  # noqa: E402
from graphlagoon.config import get_settings  # noqa: E402
from graphlagoon.db.memory_store import InMemoryStore  # noqa: E402
from graphlagoon.middleware import auth  # noqa: E402
from graphlagoon.services import investigation_storage, snapshot  # noqa: E402
from graphlagoon.services.blob_storage import LocalBlobStore  # noqa: E402

SUPERUSER = "admin@example.com"
OWNER = "owner@example.com"


def h(email):
    return {"X-Forwarded-Email": email}


def bearer(token):
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
def env(monkeypatch):
    monkeypatch.setenv("GRAPH_LAGOON_SUPERUSER_EMAILS", SUPERUSER)
    monkeypatch.setenv("GRAPH_LAGOON_DEV_MODE", "true")
    monkeypatch.setenv("GRAPH_LAGOON_AGENTS_ENABLED", "true")
    get_settings.cache_clear()
    InMemoryStore.reset()
    auth._agent_request_times.clear()
    yield monkeypatch
    InMemoryStore.reset()
    get_settings.cache_clear()


@pytest.fixture
def client(env):
    app = FastAPI()
    app.add_middleware(auth.AuthMiddleware)
    app.include_router(create_api_router())
    return TestClient(app)


def mint(client, email=OWNER, **extra):
    r = client.post("/api/agent-tokens", json={"name": "claude", **extra}, headers=h(email))
    assert r.status_code == 201, r.text
    return r.json()


def test_token_shown_once_and_acts_for_owner_in_the_journal(client):
    created = mint(client)
    assert created["token"].startswith("glt_")
    listed = client.get("/api/agent-tokens", headers=h(OWNER)).json()
    assert [t["id"] for t in listed] == [created["id"]]
    assert "token" not in listed[0]
    store = InMemoryStore.get_instance()
    assert created["token"] not in str(vars(next(iter(store.agent_tokens.values()))))

    agent = bearer(created["token"])
    case = client.post("/api/investigations", json={"title": "Pix"}, headers=agent)
    assert case.status_code == 201, case.text
    assert case.json()["owner_email"] == OWNER
    url = f"/api/investigations/{case.json()['id']}"
    note = client.post(f"{url}/items", json={"kind": "note", "subkind": "free", "content": "mule"}, headers=agent)
    assert note.status_code == 201, note.text
    assert note.json()["author_kind"] == "agent" and note.json()["agent_token_id"] == created["id"]

    events = client.get(f"{url}/events", headers=h(OWNER)).json()
    assert {e["actor_kind"] for e in events} == {"agent"}
    assert all(e["actor_email"] == OWNER for e in events)
    assert all(e["agent_name"] == "claude" for e in events)
    audit = [log for log in store.usage_logs if log.action == "investigation.create"]
    assert audit[0].log_metadata["agent"]["name"] == "claude"


def test_expired_or_revoked_token_is_401(client):
    expired, revoked = mint(client), mint(client)
    store = InMemoryStore.get_instance()
    store.agent_tokens[UUID(expired["id"])].expires_at = datetime.now() - timedelta(
        seconds=1
    )
    assert client.delete(
        f"/api/agent-tokens/{revoked['id']}", headers=h(OWNER)
    ).json() == {"status": "revoked"}
    for token in (expired, revoked):
        r = client.get("/api/investigations", headers=bearer(token["token"]))
        assert r.status_code == 401
        assert r.json()["detail"]["error"]["code"] == "INVALID_AGENT_TOKEN"
    assert client.get("/api/investigations", headers=bearer("glt_x")).status_code == 401


def test_agent_on_human_only_routes_is_403_even_for_superuser_owner(client):
    agent = bearer(mint(client, SUPERUSER)["token"])
    case = client.post("/api/investigations", json={"title": "Pix"}, headers=agent)
    url = f"/api/investigations/{case.json()['id']}"
    for method, path, body in (
        ("DELETE", url, None),
        ("POST", f"{url}/share", {"email": "x@example.com", "permission": "read"}),
        ("DELETE", f"{url}/share/x@example.com", None),
        ("POST", "/api/agent-tokens", {"name": "n"}),
        ("GET", "/api/agent-tokens", None),
        ("GET", "/api/admin/overview", None),
        ("GET", "/api/admin/agent-tokens", None),
    ):
        r = client.request(method, path, json=body, headers=agent)
        assert r.status_code == 403, (method, path, r.text)
        assert r.json()["detail"]["error"]["code"] == "AGENT_FORBIDDEN"
    # the same superuser, as a person, may delete
    assert client.delete(url, headers=h(SUPERUSER)).status_code == 200


def test_tokens_have_no_scopes_the_agent_acts_as_its_owner(client):
    # 05 §6: identity plus a short human-only list; no read/analyze/write scopes.
    token = mint(client, scopes=["read"])  # ignored
    assert "scopes" not in token and token["scope"] == "user"
    agent = bearer(token["token"])
    assert client.get("/api/investigations", headers=agent).status_code == 200
    r = client.post("/api/investigations", json={"title": "Pix"}, headers=agent)
    assert r.status_code == 201


def test_case_scoped_token_reaches_only_its_cases(client):
    a = client.post("/api/investigations", json={"title": "A"}, headers=h(OWNER)).json()
    b = client.post("/api/investigations", json={"title": "B"}, headers=h(OWNER)).json()
    r = client.post("/api/agent-tokens", json={"name": "n", "scope": "case"}, headers=h(OWNER))
    assert r.status_code == 422  # a case token names its cases
    agent = bearer(
        mint(client, scope="case", investigation_ids=[a["id"]])["token"]
    )
    assert client.get(f"/api/investigations/{a['id']}", headers=agent).status_code == 200
    r = client.get(f"/api/investigations/{b['id']}", headers=agent)
    assert r.status_code == 403
    assert r.json()["detail"]["error"]["code"] == "AGENT_FORBIDDEN"
    r = client.get(f"/api/investigations/{b['id']}/items", headers=agent)
    assert r.status_code == 403
    listed = client.get("/api/investigations", headers=agent).json()["items"]
    assert [i["id"] for i in listed] == [a["id"]]
    r = client.post("/api/investigations", json={"title": "C"}, headers=agent)
    assert r.status_code == 403
    # the service predicate also hides B from a case token acting in-process (MCP)
    auth._current_actor.set(
        {"kind": "agent", "scope": "case", "investigation_ids": [a["id"]]}
    )
    try:
        from graphlagoon.services.cases import can_read_case

        store = InMemoryStore.get_instance()
        assert can_read_case(store.get_investigation(UUID(a["id"])), OWNER)
        assert not can_read_case(store.get_investigation(UUID(b["id"])), OWNER)
    finally:
        auth._current_actor.set(None)


def test_agent_outside_the_allowlist_and_on_shares_is_403(client):
    store = InMemoryStore.get_instance()
    context = store.create_graph_context("Pix", "e", "n", OWNER)
    exploration = store.create_exploration(context.id, "x", OWNER, {})
    agent = bearer(mint(client)["token"])
    share = {"email": "x@example.com", "permission": "read"}
    for method, path, body in (
        ("POST", f"/api/graph-contexts/{context.id}/share", share),
        ("DELETE", f"/api/graph-contexts/{context.id}/share/x@example.com", None),
        ("POST", f"/api/explorations/{exploration.id}/share", share),
        ("DELETE", f"/api/explorations/{exploration.id}/share/x@example.com", None),
        ("GET", "/api/graph-contexts", None),
        ("GET", f"/api/graph-contexts/{context.id}", None),
        ("GET", "/api/datasets", None),
    ):
        r = client.request(method, path, json=body, headers=agent)
        assert r.status_code == 403, (method, path, r.text)
        assert r.json()["detail"]["error"]["code"] == "AGENT_FORBIDDEN"
    # the person may still share
    r = client.post(f"/api/explorations/{exploration.id}/share", json=share, headers=h(OWNER))
    assert r.status_code == 200, r.text
    # the allowlist does cover the context's queries and the agent's own cases
    r = client.get(f"/api/graph-contexts/{context.id}/explorations", headers=agent)
    assert r.status_code == 200, r.text


DOC = "078-05-1120"
SNAPSHOT = {
    "nodes": [
        {"id": "p1", "type": "Person", "properties": {"name": "Ana", "national_id": DOC}},
        {"id": "c1", "type": "Account", "properties": {"account": "0341-1234-567890"}},
    ],
    "edges": [],
}


class _Snapshots:
    async def load(self, exploration_id):
        return snapshot.compress_snapshot(SNAPSHOT)


@pytest.fixture
def case_with_source(client, env, tmp_path):
    env.setattr(investigation_storage, "_store", LocalBlobStore(str(tmp_path)))
    env.setattr(snapshot, "get_snapshot_service", lambda: _Snapshots())
    store = InMemoryStore.get_instance()
    context = store.create_graph_context("Bank", "e", "n", OWNER)
    exploration = store.create_exploration(
        context.id, "Accounts", OWNER, {"has_snapshot": True}
    )
    case = client.post("/api/investigations", json={"title": "A"}, headers=h(OWNER)).json()
    url = f"/api/investigations/{case['id']}"
    r = client.post(
        f"{url}/items",
        json={"kind": "graph", "subkind": "exploration_ref", "exploration_id": str(exploration.id)},
        headers=h(OWNER),
    )
    assert r.status_code == 201, r.text
    return url, r.json()["id"], exploration


def test_agents_read_what_the_person_reads_but_never_the_bytes(client, env, case_with_source):
    url, item_id, exploration = case_with_source
    agent = bearer(mint(client)["token"])
    person = client.get(f"{url}/items/{item_id}/snapshot", headers=h(OWNER))
    got = client.get(f"{url}/items/{item_id}/snapshot", headers=agent)
    assert got.status_code == 200 and got.json() == person.json() and DOC in got.text
    assert client.get(f"{url}/graph", headers=agent).json() == client.get(f"{url}/graph", headers=h(OWNER)).json()
    assert client.get(f"/api/explorations/{exploration.id}/snapshot", headers=agent).status_code == 200

    # items: the agent reads the text extraction; bytes never reach it
    up = client.post(
        f"{url}/items?filename=ids.csv&kind=table&subkind=csv",
        content=f"national_id\n{DOC}".encode(),
        headers={**agent, "Content-Type": "application/octet-stream"},
    )
    assert up.status_code == 201, up.text
    got = client.get(f"{url}/items/{up.json()['id']}/text", headers=agent)
    assert got.status_code == 200 and DOC in got.json()["text"]
    r = client.get(f"{url}/items/{up.json()['id']}/content", headers=agent)
    assert r.status_code == 403
    assert r.json()["detail"]["error"]["code"] == "AGENT_FORBIDDEN"
    assert DOC in client.get(f"{url}/items/{up.json()['id']}/content", headers=h(OWNER)).text


def test_upload_checks_access_before_reading_the_body(client, case_with_source):
    url, _, _ = case_with_source
    outsider = bearer(mint(client, "outsider@example.com")["token"])
    r = client.post(
        f"{url}/items?filename=a.csv&kind=table&subkind=csv",
        content=b"x",
        headers={**outsider, "Content-Type": "application/octet-stream"},
    )
    assert r.status_code == 404
    r = client.post(f"{url}/items", json={"kind": "note", "subkind": "free", "content": "x"}, headers=outsider)
    assert r.status_code == 404


def test_agent_may_not_assign_a_case(client):
    agent = bearer(mint(client)["token"])
    case = client.post("/api/investigations", json={"title": "A"}, headers=agent).json()
    url = f"/api/investigations/{case['id']}"
    assert client.patch(url, json={"title": "B"}, headers=agent).status_code == 200
    r = client.patch(url, json={"assignee_email": "x@example.com"}, headers=agent)
    assert r.status_code == 403
    assert r.json()["detail"]["error"]["code"] == "AGENT_FORBIDDEN"


def test_max_validity_and_rate_limit(client, env):
    r = client.post("/api/agent-tokens", json={"name": "n", "expires_in_days": 91}, headers=h(OWNER))
    assert r.status_code == 422
    env.setenv("GRAPH_LAGOON_AGENT_RATE_LIMIT_PER_MINUTE", "2")
    get_settings.cache_clear()
    agent = bearer(mint(client)["token"])
    codes = [
        client.get("/api/investigations", headers=agent).status_code for _ in "abc"
    ]
    assert codes == [200, 200, 429]


def test_admin_lists_and_revokes_any_token(client):
    token = mint(client)
    listed = client.get("/api/admin/agent-tokens", headers=h(SUPERUSER)).json()
    assert [(t["id"], t["owner_email"]) for t in listed] == [(token["id"], OWNER)]
    assert (
        client.delete(f"/api/admin/agent-tokens/{token['id']}", headers=h(OWNER))
    ).status_code == 403
    assert (
        client.delete(f"/api/admin/agent-tokens/{token['id']}", headers=h(SUPERUSER))
    ).status_code == 200
    r = client.get("/api/investigations", headers=bearer(token["token"]))
    assert r.status_code == 401


def test_agents_disabled_hides_token_routes_and_rejects_tokens(client, env):
    token = mint(client)
    env.setenv("GRAPH_LAGOON_AGENTS_ENABLED", "false")
    get_settings.cache_clear()
    for method, path in (
        ("GET", "/api/agent-tokens"),
        ("POST", "/api/agent-tokens"),
        ("DELETE", f"/api/agent-tokens/{token['id']}"),
        ("GET", "/api/admin/agent-tokens"),
    ):
        r = client.request(method, path, json={}, headers=h(SUPERUSER))
        assert r.status_code == 404, (method, path)
    r = client.get("/api/investigations", headers=bearer(token["token"]))
    assert r.status_code == 401


def test_token_use_is_recorded_and_a_case_token_stays_in_its_cases(client, env, case_with_source):
    """Each use bumps ``last_used_at`` (at most once a minute); a case token
    that names another case gets 403 here."""
    url, _, _ = case_with_source
    doc = client.post(f"{url}/items", json={"kind": "document", "subkind": "markdown", "title": "d", "content": f"ID {DOC}"},
                      headers=h(OWNER)).json()
    plain = mint(client)
    assert plain["last_used_at"] is None and "unmasked" not in plain
    r = client.get(f"{url}/items/{doc['id']}/text", headers=bearer(plain["token"]))
    assert r.status_code == 200 and r.json()["text"] == f"ID {DOC}"
    listed = {t["id"]: t for t in client.get("/api/agent-tokens", headers=h(OWNER)).json()}
    assert listed[plain["id"]]["last_used_at"] is not None
    other = client.post("/api/investigations", json={"title": "other"}, headers=h(OWNER)).json()
    scoped = mint(client, scope="case", investigation_ids=[other["id"]])
    assert client.get(f"{url}/items/{doc['id']}/text", headers=bearer(scoped["token"])).status_code == 403
