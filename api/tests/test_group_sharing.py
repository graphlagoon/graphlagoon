"""Share a context, an exploration or an investigation with a group.

The share row holds ``group:<uuid>`` in the same column as e-mails and
wildcards (no migration); membership is resolved per request, so adding or
removing a member changes access on the next request. Memory mode end to end
through the real routers and the auth middleware.
"""

import sys
from uuid import uuid4

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
from graphlagoon.routers import graph_contexts  # noqa: E402
from graphlagoon.services import investigation_storage  # noqa: E402
from graphlagoon.services.blob_storage import LocalBlobStore  # noqa: E402
from graphlagoon.services.group_resolution import StubGroupResolver, set_group_resolver  # noqa: E402
from graphlagoon.utils.sharing import group_share_value  # noqa: E402

SUPERUSER = "admin@example.com"
OWNER = "owner@example.com"
MEMBER = "member@example.com"
OUTSIDER = "outsider@example.com"


def h(email):
    return {"X-Forwarded-Email": email}


class _UnreachableWarehouse:
    async def get_table_schema(self, table, database=None, catalog=None):
        raise Exception("connection refused")


@pytest.fixture
def store(monkeypatch, tmp_path):
    monkeypatch.setenv("GRAPH_LAGOON_SUPERUSER_EMAILS", SUPERUSER)
    monkeypatch.setenv("GRAPH_LAGOON_DEV_MODE", "true")
    monkeypatch.setenv("GRAPH_LAGOON_AGENTS_ENABLED", "true")
    get_settings.cache_clear()
    InMemoryStore.reset()
    set_group_resolver(StubGroupResolver())
    auth._agent_request_times.clear()
    monkeypatch.setattr(investigation_storage, "_store", LocalBlobStore(str(tmp_path)))
    yield InMemoryStore.get_instance()
    InMemoryStore.reset()
    set_group_resolver(StubGroupResolver())
    get_settings.cache_clear()


@pytest.fixture
def client(store):
    app = FastAPI()
    app.add_middleware(auth.AuthMiddleware)
    app.include_router(create_api_router())
    app.dependency_overrides[graph_contexts.get_warehouse] = lambda: _UnreachableWarehouse()
    yield TestClient(app)


@pytest.fixture
def group(store):
    return store.create_group("analysts", members=[{"kind": "email", "value": MEMBER}])


@pytest.fixture
def context(store):
    return store.create_graph_context(
        title="ctx", edge_table_name="e", node_table_name="n", owner_email=OWNER
    )


@pytest.fixture
def exploration(store, context):
    return store.create_exploration(
        graph_context_id=context.id, title="exp", owner_email=OWNER, state={}
    )


def _share_context(client, context, target, permission="read", as_email=OWNER):
    return client.post(
        f"/api/graph-contexts/{context.id}/share",
        json={"email": target, "permission": permission},
        headers=h(as_email),
    )


def _share_exploration(client, exploration, target, permission="read"):
    return client.post(
        f"/api/explorations/{exploration.id}/share",
        json={"email": target, "permission": permission},
        headers=h(OWNER),
    )


def _context_ids(client, email):
    return [c["id"] for c in client.get("/api/graph-contexts", headers=h(email)).json()]


def _exploration_ids(client, email):
    return [e["id"] for e in client.get("/api/explorations", headers=h(email)).json()]


class TestContext:
    def test_member_reads_and_writes_outsider_does_not(self, client, store, context, group):
        sentinel = group_share_value(group.id)
        assert _share_context(client, context, sentinel, "write").status_code == 200
        assert [s.shared_with_email for s in context.shares] == [sentinel]

        listed = client.get("/api/graph-contexts", headers=h(MEMBER)).json()
        assert [c["id"] for c in listed] == [str(context.id)]
        assert listed[0]["has_write_access"] is True
        assert listed[0]["shared_with"] == [sentinel]
        assert client.get(f"/api/graph-contexts/{context.id}/explorations", headers=h(MEMBER)).status_code == 200
        assert (
            client.put(f"/api/graph-contexts/{context.id}", json={"title": "renamed"}, headers=h(MEMBER)).status_code
            == 200
        )

        assert _context_ids(client, OUTSIDER) == []
        assert client.get(f"/api/graph-contexts/{context.id}/explorations", headers=h(OUTSIDER)).status_code == 403
        assert (
            client.put(f"/api/graph-contexts/{context.id}", json={"title": "x"}, headers=h(OUTSIDER)).status_code
            == 403
        )

    def test_read_share_does_not_write_and_never_manages(self, client, context, group):
        _share_context(client, context, group_share_value(group.id), "read")
        assert client.get("/api/graph-contexts", headers=h(MEMBER)).json()[0]["has_write_access"] is False
        assert client.put(f"/api/graph-contexts/{context.id}", json={"title": "x"}, headers=h(MEMBER)).status_code == 403
        # A group share never grants owner powers.
        assert _share_context(client, context, OUTSIDER, as_email=MEMBER).status_code == 403

    def test_membership_changes_apply_on_the_next_request(self, client, store, context, group):
        _share_context(client, context, group_share_value(group.id), "read")
        url = f"/api/graph-contexts/{context.id}/explorations"
        assert client.get(url, headers=h(MEMBER)).status_code == 200

        store.update_group(group.id, members=[])
        assert client.get(url, headers=h(MEMBER)).status_code == 403
        assert _context_ids(client, MEMBER) == []

        store.update_group(group.id, members=[{"kind": "email", "value": MEMBER}])
        assert client.get(url, headers=h(MEMBER)).status_code == 200
        assert _context_ids(client, MEMBER) == [str(context.id)]

    def test_databricks_group_member(self, client, store, context):
        group = store.create_group("db-analysts", members=[{"kind": "databricks_group", "value": "data-analysts"}])
        _share_context(client, context, group_share_value(group.id), "read")
        url = f"/api/graph-contexts/{context.id}/explorations"

        set_group_resolver(StubGroupResolver({MEMBER: frozenset({"data-analysts"})}))
        assert client.get(url, headers=h(MEMBER)).status_code == 200
        assert client.get(url, headers=h(OUTSIDER)).status_code == 403

        set_group_resolver(StubGroupResolver({MEMBER: frozenset({"other-team"})}))
        assert client.get(url, headers=h(MEMBER)).status_code == 403

    def test_unknown_or_malformed_group_refused(self, client, context):
        r = _share_context(client, context, f"group:{uuid4()}")
        assert r.status_code == 400 and "Group not found" in r.json()["detail"]
        r = _share_context(client, context, "group:not-a-uuid")
        assert r.status_code == 400 and "Invalid group share target" in r.json()["detail"]
        assert context.shares == []

    def test_target_is_canonicalized_and_unshare_works(self, client, context, group):
        upper = f"GROUP:{str(group.id).upper()}"
        assert _share_context(client, context, upper, "read").status_code == 200
        sentinel = group_share_value(group.id)
        assert [s.shared_with_email for s in context.shares] == [sentinel]
        # Re-sharing updates the same row instead of adding a second one.
        assert _share_context(client, context, upper, "write").status_code == 200
        assert [(s.shared_with_email, s.permission) for s in context.shares] == [(sentinel, "write")]
        assert client.get("/api/graph-contexts", headers=h(MEMBER)).json()[0]["has_write_access"] is True

        assert client.delete(f"/api/graph-contexts/{context.id}/share/{sentinel}", headers=h(OWNER)).status_code == 200
        assert context.shares == []
        assert _context_ids(client, MEMBER) == []

    def test_deleting_the_group_removes_its_shares(self, client, store, context, exploration, group):
        sentinel = group_share_value(group.id)
        _share_context(client, context, sentinel, "read")
        _share_exploration(client, exploration, sentinel, "read")
        assert _context_ids(client, MEMBER) == [str(context.id)]

        r = client.delete(f"/api/admin/groups/{group.id}", headers=h(SUPERUSER))
        assert r.status_code == 200
        assert context.shares == [] and exploration.shares == []
        assert _context_ids(client, MEMBER) == []
        assert _exploration_ids(client, MEMBER) == []


class TestExploration:
    def test_group_share_grants_the_exploration_and_its_context(self, client, store, context, exploration, group):
        sentinel = group_share_value(group.id)
        assert _share_exploration(client, exploration, sentinel, "read").status_code == 200

        assert _exploration_ids(client, MEMBER) == [str(exploration.id)]
        got = client.get(f"/api/explorations/{exploration.id}", headers=h(MEMBER)).json()
        assert got["has_write_access"] is False and got["shared_with"] == [sentinel]
        # An exploration share opens its context (list + graph gate), like an e-mail share.
        assert _context_ids(client, MEMBER) == [str(context.id)]
        assert client.get(f"/api/graph-contexts/{context.id}/explorations", headers=h(MEMBER)).status_code == 200
        # The snapshot route reads through the same predicate (404 = no snapshot, not 403).
        assert client.get(f"/api/explorations/{exploration.id}/snapshot", headers=h(MEMBER)).status_code == 404
        assert client.get(f"/api/explorations/{exploration.id}/snapshot", headers=h(OUTSIDER)).status_code == 403

        assert client.get(f"/api/explorations/{exploration.id}", headers=h(OUTSIDER)).status_code == 403
        assert _exploration_ids(client, OUTSIDER) == []
        assert _context_ids(client, OUTSIDER) == []

    def test_write_share_and_membership_removal(self, client, store, exploration, group):
        _share_exploration(client, exploration, group_share_value(group.id), "write")
        url = f"/api/explorations/{exploration.id}"
        assert client.put(url, json={"title": "by member"}, headers=h(MEMBER)).status_code == 200

        store.update_group(group.id, members=[{"kind": "email", "value": OUTSIDER}])
        assert client.put(url, json={"title": "again"}, headers=h(MEMBER)).status_code == 403
        assert client.get(url, headers=h(MEMBER)).status_code == 403
        assert client.put(url, json={"title": "now outsider"}, headers=h(OUTSIDER)).status_code == 200

    def test_unknown_group_refused(self, client, exploration):
        assert _share_exploration(client, exploration, f"group:{uuid4()}").status_code == 400
        assert exploration.shares == []


class TestInvestigation:
    def _case(self, client):
        r = client.post("/api/investigations", json={"title": "Case"}, headers=h(OWNER))
        assert r.status_code == 201, r.text
        return r.json()

    def test_reader_then_editor_through_a_group(self, client, store, group):
        inv = self._case(client)
        url = f"/api/investigations/{inv['id']}"
        sentinel = group_share_value(group.id)

        r = client.post(f"{url}/share", json={"email": sentinel}, headers=h(OWNER))
        assert r.status_code == 200
        as_member = client.get(url, headers=h(MEMBER)).json()
        assert as_member["shared_with"] == [{"email": sentinel, "role": "reader"}]
        assert (as_member["has_write_access"], as_member["can_manage"]) == (False, False)
        assert client.patch(url, json={"title": "x"}, headers=h(MEMBER)).status_code == 403
        listed = client.get("/api/investigations", headers=h(MEMBER)).json()["items"]
        assert [i["id"] for i in listed] == [inv["id"]]
        assert client.get(url, headers=h(OUTSIDER)).status_code == 404
        assert client.get("/api/investigations", headers=h(OUTSIDER)).json()["items"] == []

        assert client.post(f"{url}/share", json={"email": sentinel, "role": "editor"}, headers=h(OWNER)).status_code == 200
        assert client.patch(url, json={"title": "by member"}, headers=h(MEMBER)).status_code == 200
        # Sharing stays the owner's: the group editor cannot share or assign.
        assert client.post(f"{url}/share", json={"email": OUTSIDER}, headers=h(MEMBER)).status_code == 403

        # A group editor may be the reviewer of a decision (four eyes).
        r = client.post(
            f"{url}/decisions",
            json={"outcome_label": "Escalate", "closes_case": False, "rationale": "needs a look", "reviewer_email": MEMBER},
            headers=h(OWNER),
        )
        assert r.status_code == 200, r.text

    def test_membership_removal_and_group_delete(self, client, store, group):
        inv = self._case(client)
        url = f"/api/investigations/{inv['id']}"
        sentinel = group_share_value(group.id)
        client.post(f"{url}/share", json={"email": sentinel}, headers=h(OWNER))
        assert client.get(url, headers=h(MEMBER)).status_code == 200

        store.update_group(group.id, members=[])
        assert client.get(url, headers=h(MEMBER)).status_code == 404
        assert client.get("/api/investigations", headers=h(MEMBER)).json()["items"] == []
        store.update_group(group.id, members=[{"kind": "email", "value": MEMBER}])
        assert client.get(url, headers=h(MEMBER)).status_code == 200

        assert client.delete(f"/api/admin/groups/{group.id}", headers=h(SUPERUSER)).status_code == 200
        assert client.get(url, headers=h(OWNER)).json()["shared_with"] == []
        assert client.get(url, headers=h(MEMBER)).status_code == 404

    def test_unshare_and_refusals(self, client, group):
        inv = self._case(client)
        url = f"/api/investigations/{inv['id']}"
        sentinel = group_share_value(group.id)
        client.post(f"{url}/share", json={"email": sentinel}, headers=h(OWNER))
        assert client.delete(f"{url}/share/{sentinel}", headers=h(OWNER)).status_code == 200
        assert client.get(url, headers=h(MEMBER)).status_code == 404

        # Uppercase and the hyphenless form land on the same canonical row.
        upper = f"GROUP:{str(group.id).upper().replace('-', '')}"
        assert client.post(f"{url}/share", json={"email": upper}, headers=h(OWNER)).status_code == 200
        assert client.get(url, headers=h(OWNER)).json()["shared_with"] == [{"email": sentinel, "role": "reader"}]
        assert client.delete(f"{url}/share/{sentinel}", headers=h(OWNER)).status_code == 200

        r = client.post(f"{url}/share", json={"email": f"group:{uuid4()}"}, headers=h(OWNER))
        assert (r.status_code, r.json()["detail"]["error"]["code"]) == (422, "GROUP_NOT_FOUND")
        r = client.post(f"{url}/share", json={"email": "group:nope"}, headers=h(OWNER))
        assert (r.status_code, r.json()["detail"]["error"]["code"]) == (422, "INVALID_GROUP_SHARE")
        r = client.post(f"{url}/share", json={"email": "*@example.com"}, headers=h(OWNER))
        assert (r.status_code, r.json()["detail"]["error"]["code"]) == (422, "WILDCARD_SHARE_REFUSED")


class TestGroupsEndpoint:
    def test_superuser_list_sees_group_write_without_warnings(self, client, store, context, group, caplog):
        """A superuser who is also a member: lists prime membership for everyone."""
        store.update_group(group.id, members=[{"kind": "email", "value": SUPERUSER}])
        _share_context(client, context, group_share_value(group.id), "write")
        inv = client.post("/api/investigations", json={"title": "Case"}, headers=h(OWNER)).json()
        client.post(f"/api/investigations/{inv['id']}/share", json={"email": group_share_value(group.id), "role": "editor"}, headers=h(OWNER))
        with caplog.at_level("WARNING", logger="graphlagoon.utils.sharing"):
            assert client.get("/api/graph-contexts", headers=h(SUPERUSER)).json()[0]["has_write_access"] is True
            [listed] = client.get("/api/investigations", headers=h(SUPERUSER)).json()["items"]
            assert listed["has_write_access"] is True
        assert "before membership was resolved" not in caplog.text

    def test_lists_labels_only_for_any_person(self, client, store, group):
        store.create_group("builders", description="Context authors", members=[{"kind": "email", "value": OUTSIDER}])
        r = client.get("/api/groups", headers=h(OUTSIDER))
        assert r.status_code == 200
        assert r.json() == {
            "items": [
                {"id": str(group.id), "name": "analysts", "description": None},
                {"id": str(store.get_group_by_name("builders").id), "name": "builders", "description": "Context authors"},
            ]
        }

    def test_agents_are_refused(self, client):
        token = client.post("/api/agent-tokens", json={"name": "claude"}, headers=h(OWNER)).json()["token"]
        assert client.get("/api/groups", headers={"Authorization": f"Bearer {token}"}).status_code == 403
