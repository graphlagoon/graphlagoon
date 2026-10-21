"""Security review of 2026-10-20 (internal deployment): restricted graph
sources stay restricted in every read, a case-scoped token stays in its cases,
agents leave people's material and settings alone, the case type no longer
moves after a decision, and identity-key regexes cannot stall the worker."""

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



OTHER = "other@example.com"
REVIEWER = "rev@example.com"
DOC = "078-05-1120"
SNAPSHOT = {
    "nodes": [
        {"id": "p1", "type": "Person", "properties": {"name": "Ana Secret", "national_id": DOC}},
    ],
    "edges": [],
}


class _Snapshots:
    async def load(self, exploration_id):
        return snapshot.compress_snapshot(SNAPSHOT)


@pytest.fixture
def blobs(env, tmp_path):
    env.setattr(investigation_storage, "_store", LocalBlobStore(str(tmp_path)))
    env.setattr(snapshot, "get_snapshot_service", lambda: _Snapshots())


def _case(client, title="A", who=OWNER, **body):
    r = client.post("/api/investigations", json={"title": title, **body}, headers=h(who))
    assert r.status_code == 201, r.text
    return r.json()


def _restricted_case(client, role="reader"):
    """A case with an exploration (and a query run) from a context OTHER cannot read."""
    store = InMemoryStore.get_instance()
    ctx = store.create_graph_context("Bank", "e", "n", OWNER)
    exp = store.create_exploration(ctx.id, "Accounts", OWNER, {"has_snapshot": True})
    a = _case(client)
    url = f"/api/investigations/{a['id']}"
    item = client.post(f"{url}/items", json={"kind": "graph", "subkind": "exploration_ref", "exploration_id": str(exp.id)}, headers=h(OWNER)).json()
    q = client.post(
        f"{url}/items",
        json={"kind": "query", "subkind": "sql", "title": "KYC", "context_id": str(ctx.id),
              "query": {"text": "SELECT 1", "language": "sql"},
              "content_json": {"columns": ["account", "holder"], "rows": [["1", "Ana Secret"]]}},
        headers=h(OWNER),
    ).json()
    assert client.post(f"{url}/share", json={"email": OTHER, "role": role}, headers=h(OWNER)).status_code == 200
    return url, item, q


def _code(r):
    return r.json()["detail"]["error"]["code"]


def test_a_restricted_source_is_never_read_through_content_text_search_or_pin(client, blobs):
    url, item, q = _restricted_case(client, role="editor")
    # The editor without the context cannot freeze the live exploration…
    r = client.post(f"{url}/items/{item['id']}/pin", json={}, headers=h(OTHER))
    assert r.status_code == 403 and _code(r) == "SOURCE_RESTRICTED"
    assert client.post(f"{url}/items/{item['id']}/pin", json={}, headers=h(OWNER)).status_code == 200
    # …nor read the frozen version, the query's run or their text.
    for it in (item, q):
        for path in ("content", "text"):
            r = client.get(f"{url}/items/{it['id']}/{path}", headers=h(OTHER))
            assert r.status_code == 403 and _code(r) == "SOURCE_RESTRICTED", (it["kind"], path)
        assert client.get(f"{url}/items/{it['id']}/content", headers=h(OWNER)).status_code == 200
    listed = {i["id"]: i["accessible"] for i in client.get(f"{url}/items", headers=h(OTHER)).json()}
    assert listed[item["id"]] is False and listed[q["id"]] is False
    # Search finds the item by title, never by the text of a restricted source.
    assert not [x for x in client.get(f"{url}/search", params={"q": "Ana Secret"}, headers=h(OTHER)).json() if x.get("snippet")]
    assert client.get(f"{url}/search", params={"q": "Ana Secret"}, headers=h(OWNER)).json()


def test_tables_derived_from_a_restricted_source_keep_it(client, blobs):
    url, _item, q = _restricted_case(client, role="editor")
    mine = client.post(
        f"{url}/items",
        json={"kind": "table", "subkind": "result", "title": "Mine", "content_json": {"columns": ["account", "x"], "rows": [["1", "y"]]}},
        headers=h(OTHER),
    ).json()
    # The editor without the context cannot join, compare or promote it.
    r = client.post(f"{url}/items/join", json={"item_ids": [q["id"], mine["id"]]}, headers=h(OTHER))
    assert r.status_code == 403 and _code(r) == "SOURCE_RESTRICTED"
    r = client.post(f"{url}/items/promote", json={"item_ids": [q["id"]], "as": "enrichment", "options": {"key_column": "account"}}, headers=h(OTHER))
    assert r.status_code == 403
    # What the owner derives carries the source, so it stays out of reach too.
    joined = client.post(f"{url}/items/join", json={"item_ids": [q["id"], mine["id"]]}, headers=h(OWNER)).json()
    [promoted] = client.post(
        f"{url}/items/promote", json={"item_ids": [q["id"]], "as": "enrichment", "options": {"key_column": "account"}}, headers=h(OWNER)
    ).json()
    for derived in (joined, promoted):
        assert derived["provenance"]["context_ids"] == [q["context_id"]]
        assert client.get(f"{url}/items/{derived['id']}/content", headers=h(OTHER)).status_code == 403
        assert client.get(f"{url}/items/{derived['id']}/content", headers=h(OWNER)).status_code == 200
    # A mapping of the editor's own table that pulls the restricted run as an extra file is restricted too.
    mapping = {"as": "graph", "extra_item_ids": [q["id"]], "spec": {
        "version": 1, "name": "m", "inputs": {"t": {"match": "*", "delimiter": ","}},
        "nodes": [{"key": "a", "type": "Account", "from": "t", "id": "t.account"}], "edges": []}}
    assert client.patch(f"{url}/items/{mine['id']}", json={"mapping": mapping}, headers=h(OTHER)).status_code == 200
    graph = client.get(f"{url}/graph", headers=h(OTHER)).json()
    assert graph["restricted_sources"] >= 2 and not any("Ana" in str(n) for n in graph["nodes"])


def test_a_case_scoped_token_stays_inside_its_cases(client, blobs):
    store = InMemoryStore.get_instance()
    ctx = store.create_graph_context("Bank", "e", "n", OWNER)
    secret = store.create_exploration(ctx.id, "Unrelated secret", OWNER, {"has_snapshot": True})
    a = _case(client, "A")
    agent = bearer(mint(client, scope="case", investigation_ids=[a["id"]])["token"])
    for method, path in [
        ("GET", "/api/explorations"),
        ("GET", f"/api/explorations/{secret.id}/snapshot"),
        ("DELETE", f"/api/explorations/{secret.id}"),
        ("POST", f"/api/graph-contexts/{ctx.id}/query"),
        ("POST", f"/api/graph-contexts/{ctx.id}/cypher"),
    ]:
        r = client.request(method, path, headers=agent, json={})
        assert r.status_code == 403 and _code(r) == "AGENT_FORBIDDEN", (method, path)
    assert store.get_exploration(secret.id) is not None
    for path in (f"/api/investigations/{a['id']}", "/api/org/case-types", "/api/config"):
        assert client.get(path, headers=agent).status_code == 200, path
    # A user-scoped token keeps its owner's reach.
    assert client.get("/api/explorations", headers=bearer(mint(client)["token"])).status_code == 200


def test_agents_never_delete_and_edit_only_what_agents_wrote(client, blobs):
    a = _case(client)
    url = f"/api/investigations/{a['id']}"
    item = client.post(f"{url}/items", json={"kind": "note", "subkind": "free", "content": "human note"}, headers=h(OWNER)).json()
    table = client.post(
        f"{url}/items", json={"kind": "table", "subkind": "result", "title": "T", "content_json": {"columns": ["a"], "rows": [["1"]]}},
        headers=h(OWNER),
    ).json()
    role = client.post(f"{url}/annotations", json={"kind": "role", "targets": ["Person:p1"], "value": {"role": "suspect"}}, headers=h(OWNER)).json()
    hyp = client.post(f"{url}/annotations", json={"kind": "hypothesis", "value": {"text": "t"}}, headers=h(OWNER)).json()
    agent = bearer(mint(client)["token"])
    for path in (f"{url}/annotations/{role['id']}", f"{url}/items/{item['id']}"):
        r = client.delete(path, headers=agent)
        assert r.status_code == 403 and _code(r) == "AGENT_FORBIDDEN", path
    r = client.patch(f"{url}/annotations/{role['id']}", json={"value": {"role": "victim"}}, headers=agent)
    assert r.status_code == 403 and _code(r) == "ANNOTATION_NOT_YOURS"
    r = client.patch(f"{url}/annotations/{hyp['id']}", json={"value": {"status": "supported"}}, headers=agent)
    assert r.status_code == 403
    mapping = {"as": "graph", "spec": {
        "version": 1, "name": "m", "inputs": {"t": {"match": "*", "delimiter": ","}},
        "nodes": [{"key": "a", "type": "Account", "from": "t", "id": "t.a"}], "edges": []}}
    r = client.patch(f"{url}/items/{table['id']}", json={"mapping": mapping}, headers=agent)
    assert r.status_code == 403 and _code(r) == "ITEM_NOT_YOURS"
    assert client.patch(f"{url}/items/{table['id']}", json={"title": "Renamed"}, headers=agent).status_code == 200
    # The agent's own role, once a person confirmed it, is a suggestion again after the agent edits it.
    own = client.post(f"{url}/annotations", json={"kind": "role", "targets": ["Person:p2"], "value": {"role": "suspect"}}, headers=agent).json()
    assert own["status"] == "suggested"
    assert client.post(f"{url}/annotations/{own['id']}/confirm", headers=h(OWNER)).json()["status"] == "confirmed"
    r = client.patch(f"{url}/annotations/{own['id']}", json={"value": {"role": "victim"}}, headers=agent)
    assert r.status_code == 200 and r.json()["status"] == "suggested"
    assert client.get(f"{url}/annotations", headers=h(OWNER)).status_code == 200


def test_update_task_only_moves_tasks():
    import asyncio

    from graphlagoon.services import case_annotations
    from graphlagoon.services.cases import InvestigationError

    async def run():
        InMemoryStore.reset()
        from graphlagoon.services import cases

        inv, _ = await cases.create_investigation(OWNER, {"title": "T"})
        role = await case_annotations.create_annotation(inv["id"], OWNER, "role", ["Person:p1"], {"role": "suspect"}, None)
        with pytest.raises(InvestigationError) as err:
            await case_annotations.update_annotation(inv["id"], OWNER, role["id"], {"value": {"state": "done"}}, kind="task")
        return err.value

    assert asyncio.run(run()).status_code == 404
    InMemoryStore.reset()


def test_agents_leave_settings_type_deadlines_and_assignment_to_people(client, blobs):
    a = _case(client)
    url = f"/api/investigations/{a['id']}"
    agent = bearer(mint(client)["token"])
    for body in (
        {"settings": {"agent_suggest_kinds": []}},
        {"case_type": "general"},
        {"sla_hours": {"open": 1}},
        {"assignee_email": OTHER},
    ):
        r = client.patch(url, json=body, headers=agent)
        assert r.status_code == 403 and _code(r) == "AGENT_FORBIDDEN", body
    for body in ({"assignee_email": OTHER}, {"settings": {"agent_suggest_kinds": []}}):
        r = client.post("/api/investigations", json={"title": "C", **body}, headers=agent)
        assert r.status_code == 403, body
    # Its writes still arrive as suggestions, and its status change is one too.
    role = client.post(f"{url}/annotations", json={"kind": "role", "targets": ["Person:p1"], "value": {"role": "suspect"}}, headers=agent).json()
    assert role["status"] == "suggested"
    assert client.patch(url, json={"status": "analysis"}, headers=agent).json()["status"] == "open"
    assert client.patch(url, json={"title": "Renamed", "stage": None}, headers=agent).status_code == 200


def test_the_case_type_no_longer_moves_after_a_decision(client, blobs):
    spec = {"label": "AML", "outcomes": [{"id": "sar", "label": "File SAR", "closes_case": True, "requires_review": True}]}
    assert client.put("/api/admin/case-types/aml", json=spec, headers=h(SUPERUSER)).status_code == 200
    a = _case(client, case_type="aml")
    url = f"/api/investigations/{a['id']}"
    d = client.post(f"{url}/decisions", json={"outcome": "sar", "rationale": "x"}, headers=h(OWNER)).json()["decisions"][-1]["id"]
    assert client.post(f"{url}/decisions/{d}/review", json={"approve": False}, headers=h(OWNER)).status_code == 200
    r = client.patch(url, json={"case_type": "general"}, headers=h(OWNER))
    assert r.status_code == 409 and _code(r) == "CASE_TYPE_LOCKED"
    # The same type again, and its fields, still go through.
    assert client.patch(url, json={"case_type": "aml", "title": "AML 1"}, headers=h(OWNER)).status_code == 200
    # Before any decision a person still changes the type.
    b = _case(client, "B", case_type="aml")
    assert client.patch(f"/api/investigations/{b['id']}", json={"case_type": "general"}, headers=h(OWNER)).status_code == 200


def test_identity_key_regexes_that_backtrack_are_refused(client, blobs):
    import time

    from graphlagoon.services.case_graph import _normalize
    from graphlagoon.utils.safe_regex import MAX_INPUT, search, unsafe_reason

    a = _case(client)
    url = f"/api/investigations/{a['id']}"
    key = {"node_type": "Person", "entity": "p", "normalize": "regex"}
    for bad in ("^(a+)+$", "(a|aa)*$", "(\\w+\\s?)+$", "(x)\\1", "("):
        r = client.patch(url, json={"settings": {"identity_keys": [{**key, "pattern": bad}]}}, headers=h(OWNER))
        assert r.status_code == 422, bad
        r = client.post("/api/investigations", json={"title": "x", "settings": {"identity_keys": [{**key, "pattern": bad}]}}, headers=h(OWNER))
        assert r.status_code == 422, bad
    r = client.patch(url, json={"settings": {"identity_keys": [{**key, "pattern": "^0*(\\d{6,})$"}], "other": 1}}, headers=h(OWNER))
    assert r.status_code == 200 and r.json()["settings"]["identity_keys"][0]["source"] == "node_id"
    assert r.json()["settings"]["other"] == 1
    # A pattern stored before the check, or an id longer than an identifier, is not run.
    assert unsafe_reason("^(\\d+)$") is None and search("^(\\d+)$", "1" * (MAX_INPUT + 1)) is None
    t0 = time.perf_counter()
    assert _normalize("a" * 40 + "!", "regex", "^(a+)+$") is None
    assert time.perf_counter() - t0 < 0.5


# --- quick wins (same review): assigning, token permission, broken items, query
# parameters, body limit, content types ----------------------------------------


def _restrict(permission: str, members: list[str]):
    store = InMemoryStore.get_instance()
    group = store.create_group(f"g-{permission}", members=[{"kind": "email", "value": m} for m in members])
    store.set_permission(permission, "restricted", [{"group_id": group.id, "effect": "allow"}])


def test_assigning_a_case_takes_the_share_permission(client, blobs):
    _restrict("investigation.share", ["nobody@example.com"])
    a = _case(client)
    url = f"/api/investigations/{a['id']}"
    r = client.patch(url, json={"assignee_email": OTHER}, headers=h(OWNER))
    assert r.status_code == 403 and _code(r) == "PERMISSION_DENIED"
    r = client.post("/api/investigations", json={"title": "B", "assignee_email": OTHER}, headers=h(OWNER))
    assert r.status_code == 403
    # Assigning yourself, and unassigning, need no share permission.
    assert client.patch(url, json={"assignee_email": OWNER}, headers=h(OWNER)).status_code == 200
    assert client.patch(url, json={"assignee_email": None}, headers=h(OWNER)).status_code == 200
    assert client.get(url, headers=h(OTHER)).status_code == 404


def test_a_token_stops_when_its_owner_loses_the_agent_permission(client, blobs):
    token = bearer(mint(client)["token"])
    assert client.get("/api/investigations", headers=token).status_code == 200
    _restrict("investigation.agent", ["nobody@example.com"])
    r = client.get("/api/investigations", headers=token)
    assert r.status_code == 403 and _code(r) == "AGENT_PERMISSION_REVOKED"


def test_one_unreadable_item_never_takes_the_case_graph_down(client, blobs):
    store = InMemoryStore.get_instance()
    ctx = store.create_graph_context("Bank", "e", "n", OWNER)
    exp = store.create_exploration(ctx.id, "Accounts", OWNER, {"has_snapshot": True})
    a = _case(client)
    url = f"/api/investigations/{a['id']}"
    client.post(f"{url}/items", json={"kind": "graph", "subkind": "exploration_ref", "exploration_id": str(exp.id)}, headers=h(OWNER))
    bad = client.post(
        f"{url}/items", content=b"not json at all",
        params={"filename": "graph.json", "kind": "graph", "subkind": "snapshot"},
        headers={**h(OWNER), "Content-Type": "application/octet-stream"},
    )
    assert bad.status_code == 201, bad.text
    graph = client.get(f"{url}/graph", headers=h(OWNER))
    assert graph.status_code == 200
    assert [b["item_id"] for b in graph.json()["broken_sources"]] == [bad.json()["id"]]
    assert [n["properties"]["name"] for n in graph.json()["nodes"]] == ["Ana Secret"]
    r = client.get(f"{url}/items/{bad.json()['id']}/snapshot", headers=h(OWNER))
    assert r.status_code == 422 and _code(r) == "ITEM_UNREADABLE"
    assert client.get("/api/investigations/entities/cases", params={"uid": "Person:x"}, headers=h(OWNER)).status_code == 200
    # A mapping that could never be read is refused when it is saved.
    table = client.post(
        f"{url}/items", json={"kind": "table", "subkind": "result", "title": "T", "content_json": {"columns": ["a"], "rows": [["1"]]}},
        headers=h(OWNER),
    ).json()
    spec = {"version": 1, "name": "m", "inputs": {"t": {"match": "*", "delimiter": ",", "encoding": "rot13x"}},
            "nodes": [{"key": "a", "type": "Account", "from": "t", "id": "t.a"}], "edges": []}
    for mapping in ({"as": "graph", "spec": spec},
                    {"as": "graph", "spec": {**spec, "inputs": {"t": {"match": "*", "delimiter": ","}}}, "extra_item_ids": ["nope"]}):
        r = client.patch(f"{url}/items/{table['id']}", json={"mapping": mapping}, headers=h(OWNER))
        assert r.status_code == 422 and _code(r) == "INVALID_MAPPING", mapping


def test_query_parameters_skip_strings_and_cypher_labels():
    from graphlagoon.services.case_queries import parameter_names, substitute

    cypher = "MATCH (a:Person)-[:KNOWS|OWNS]->(:Account {id: :acc}) WHERE a.note <> ':no' RETURN a"
    assert parameter_names(cypher, "cypher") == ["acc"]
    assert substitute(cypher, [], {"acc": "A1"}, "cypher")[0] == (
        "MATCH (a:Person)-[:KNOWS|OWNS]->(:Account {id: 'A1'}) WHERE a.note <> ':no' RETURN a"
    )
    assert parameter_names("SELECT * FROM t WHERE id IN (:ids) AND x::int = :x AND y = 'it\\'s :z'") == ["ids", "x"]


def test_json_bodies_stop_at_the_file_limit(env, client, blobs):
    a = _case(client)
    url = f"/api/investigations/{a['id']}"
    env.setenv("GRAPH_LAGOON_INVESTIGATION_FILE_MAX_BYTES", "2000")
    get_settings.cache_clear()
    r = client.post(f"{url}/items", json={"kind": "note", "subkind": "free", "content": "x" * 5000}, headers=h(OWNER))
    assert r.status_code == 413 and _code(r) == "BODY_TOO_LARGE"
    assert client.post(f"{url}/items", json={"kind": "note", "subkind": "free", "content": "small"}, headers=h(OWNER)).status_code == 201


def test_a_declared_content_type_is_one_well_formed_type(client, blobs):
    a = _case(client)
    url = f"/api/investigations/{a['id']}"
    item = client.post(
        f"{url}/items", content=b"<script>alert(1)</script>",
        params={"filename": "notes.bin", "kind": "document", "subkind": "upload"},
        headers={**h(OWNER), "Content-Type": "text/plain, text/html"},
    ).json()
    assert item["latest"]["content_type"] == "application/octet-stream"
    got = client.get(f"{url}/items/{item['id']}/content", headers=h(OWNER))
    assert got.headers["content-type"].startswith("application/octet-stream") and "attachment" in got.headers["content-disposition"]
    csv = client.post(
        f"{url}/items", content=b"a;b\n1;2\n",
        params={"filename": "t.csv", "kind": "table", "subkind": "csv"},
        headers={**h(OWNER), "Content-Type": "TEXT/CSV; charset=Latin-1"},
    ).json()
    assert csv["latest"]["content_type"] == "text/csv; charset=latin-1"
