"""Route-level enforcement of the permission catalog (memory-store path).

The evaluation core is covered in test_permissions.py; here the concern is
the FastAPI wiring: gated routes 403 with PERMISSION_DENIED, ungated flows
keep working in the default posture, and /api/config carries the effective
permission list.
"""

import sys

import pytest

# Stub gsql2rsql package tree so graphlagoon can be imported without the dep.
# IMPORTANT: only stub when the real package is genuinely unavailable — a
# `not in sys.modules` guard would stub gsql2rsql for the whole session and
# break test_transpile_options.
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

from graphlagoon.config import get_settings  # noqa: E402
from graphlagoon.db.memory_store import InMemoryStore  # noqa: E402
from graphlagoon.middleware.auth import AuthMiddleware  # noqa: E402
from graphlagoon.routers import config, explorations, graph_contexts  # noqa: E402
from graphlagoon.services.group_resolution import (  # noqa: E402
    StubGroupResolver,
    set_group_resolver,
)

SUPERUSER = "admin@example.com"
MEMBER = "member@example.com"
OUTSIDER = "outsider@example.com"


def _headers(email):
    return {"X-Forwarded-Email": email}


class _UnreachableWarehouse:
    """Table validation skips unreachable warehouses (documented behavior in
    test_context_table_validation) — exactly what these tests want."""

    async def get_table_schema(self, table, database=None, catalog=None):
        raise Exception("connection refused")


@pytest.fixture
def superuser_env(monkeypatch):
    monkeypatch.setenv("GRAPH_LAGOON_SUPERUSER_EMAILS", SUPERUSER)
    monkeypatch.setenv("GRAPH_LAGOON_DEV_MODE", "true")
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


@pytest.fixture
def store():
    InMemoryStore.reset()
    set_group_resolver(StubGroupResolver())
    yield InMemoryStore.get_instance()
    InMemoryStore.reset()
    set_group_resolver(StubGroupResolver())


@pytest.fixture
def client(superuser_env, store):
    app = FastAPI()
    app.add_middleware(AuthMiddleware)
    app.include_router(graph_contexts.router)
    app.include_router(explorations.router)
    app.include_router(config.router)
    app.dependency_overrides[graph_contexts.get_warehouse] = (
        lambda: _UnreachableWarehouse()
    )
    yield TestClient(app)


CONTEXT_PAYLOAD = {
    "title": "ctx",
    "edge_table_name": "db.edges",
    "node_table_name": "db.nodes",
}


def _restrict_context_create_to(store, *emails) -> None:
    group = store.create_group(
        "builders", members=[{"kind": "email", "value": e} for e in emails]
    )
    store.set_permission(
        "context.create", "restricted", [{"group_id": group.id, "effect": "allow"}]
    )
    return group


class TestDefaultPosture:
    def test_anyone_can_create_context_with_no_rules(self, client):
        response = client.post(
            "/api/graph-contexts", json=CONTEXT_PAYLOAD, headers=_headers(OUTSIDER)
        )
        assert response.status_code == 200, response.text

    def test_anyone_can_save_exploration_with_no_rules(self, client, store):
        context = store.create_graph_context("t", "e", "n", OUTSIDER)
        response = client.post(
            f"/api/graph-contexts/{context.id}/explorations",
            json={"title": "x", "state": {}},
            headers=_headers(OUTSIDER),
        )
        assert response.status_code == 200, response.text


class TestRestrictedCreate:
    def test_member_can_create(self, client, store):
        _restrict_context_create_to(store, MEMBER)
        response = client.post(
            "/api/graph-contexts", json=CONTEXT_PAYLOAD, headers=_headers(MEMBER)
        )
        assert response.status_code == 200, response.text

    def test_outsider_gets_permission_denied(self, client, store):
        _restrict_context_create_to(store, MEMBER)
        response = client.post(
            "/api/graph-contexts", json=CONTEXT_PAYLOAD, headers=_headers(OUTSIDER)
        )
        assert response.status_code == 403
        error = response.json()["detail"]["error"]
        assert error["code"] == "PERMISSION_DENIED"
        assert error["details"]["permission"] == "context.create"
        assert error["details"]["reason"] == "restricted_no_match"
        assert "Create graph contexts" in error["message"]

    def test_superuser_bypasses(self, client, store):
        _restrict_context_create_to(store, MEMBER)
        response = client.post(
            "/api/graph-contexts", json=CONTEXT_PAYLOAD, headers=_headers(SUPERUSER)
        )
        assert response.status_code == 200, response.text

    def test_databricks_group_member_can_create(self, client, store):
        group = store.create_group(
            "dbx-builders",
            members=[{"kind": "databricks_group", "value": "data-analysts"}],
        )
        store.set_permission(
            "context.create", "restricted", [{"group_id": group.id, "effect": "allow"}]
        )
        set_group_resolver(StubGroupResolver({MEMBER: frozenset({"data-analysts"})}))
        assert (
            client.post(
                "/api/graph-contexts", json=CONTEXT_PAYLOAD, headers=_headers(MEMBER)
            ).status_code
            == 200
        )
        assert (
            client.post(
                "/api/graph-contexts", json=CONTEXT_PAYLOAD, headers=_headers(OUTSIDER)
            ).status_code
            == 403
        )


class TestDenyExplorationSave:
    @pytest.fixture
    def denied(self, store):
        group = store.create_group(
            "banned", members=[{"kind": "email", "value": MEMBER}]
        )
        store.set_permission(
            "exploration.save", "everyone", [{"group_id": group.id, "effect": "deny"}]
        )
        return group

    def test_deny_beats_everyone_mode_on_create(self, client, store, denied):
        context = store.create_graph_context("t", "e", "n", MEMBER)
        response = client.post(
            f"/api/graph-contexts/{context.id}/explorations",
            json={"title": "x", "state": {}},
            headers=_headers(MEMBER),
        )
        assert response.status_code == 403
        error = response.json()["detail"]["error"]
        assert error["details"] == {
            "permission": "exploration.save",
            "reason": "deny_rule",
        }

    def test_deny_applies_to_update_even_for_the_owner(self, client, store, denied):
        context = store.create_graph_context("t", "e", "n", MEMBER)
        exploration = store.create_exploration(context.id, "x", MEMBER, {})
        response = client.put(
            f"/api/explorations/{exploration.id}",
            json={"title": "renamed"},
            headers=_headers(MEMBER),
        )
        assert response.status_code == 403
        assert response.json()["detail"]["error"]["code"] == "PERMISSION_DENIED"

    def test_others_still_save(self, client, store, denied):
        context = store.create_graph_context("t", "e", "n", OUTSIDER)
        response = client.post(
            f"/api/graph-contexts/{context.id}/explorations",
            json={"title": "x", "state": {}},
            headers=_headers(OUTSIDER),
        )
        assert response.status_code == 200, response.text


class TestConfigCarriesPermissions:
    def test_superuser_gets_full_catalog(self, client, store):
        _restrict_context_create_to(store, MEMBER)
        payload = client.get("/api/config", headers=_headers(SUPERUSER)).json()
        assert payload["permissions"] == ["context.create", "exploration.save"]

    def test_restricted_outsider_lacks_the_id(self, client, store):
        _restrict_context_create_to(store, MEMBER)
        payload = client.get("/api/config", headers=_headers(OUTSIDER)).json()
        assert payload["permissions"] == ["exploration.save"]
        member_payload = client.get("/api/config", headers=_headers(MEMBER)).json()
        assert member_payload["permissions"] == [
            "context.create",
            "exploration.save",
        ]


# ── Query scope: two tiers keyed on context.create ───────────────────────────
#
# Authors (context.create holders) read anything in the configured
# catalog.schema allowlist; everyone else only the open context's own tables.
# A denial is 403 QUERY_SCOPE_DENIED and happens before any warehouse work, so
# these need no warehouse. The "allowed" cases assert only the ABSENCE of that
# code — the unconfigured warehouse fails later, which is what proves the scope
# gate let the query through.

from graphlagoon.routers import catalog as catalog_router  # noqa: E402
from graphlagoon.routers import graph as graph_router  # noqa: E402


@pytest.fixture
def query_client(superuser_env, store):
    app = FastAPI()
    app.add_middleware(AuthMiddleware)
    app.include_router(graph_router.router)
    app.include_router(catalog_router.router)
    yield TestClient(app)


def _scope_error(response):
    """The QUERY_SCOPE_DENIED payload, or None if the query was not blocked."""
    if response.status_code != 403:
        return None
    error = response.json()["detail"]["error"]
    return error if error["code"] == "QUERY_SCOPE_DENIED" else None


def _run_sql(client, context_id, sql, email):
    return client.post(
        f"/api/graph-contexts/{context_id}/query",
        json={"query": sql},
        headers=_headers(email),
    )


class TestReaderTierScope:
    """No context.create ⇒ only the open context's own tables."""

    @pytest.fixture
    def reader_context(self, store):
        # Restricting context.create to MEMBER makes OUTSIDER a reader.
        _restrict_context_create_to(store, MEMBER)
        return store.create_graph_context(
            "t", "main.graphs.edges", "main.graphs.nodes", OUTSIDER
        )

    def test_context_tables_allowed(self, query_client, reader_context):
        response = _run_sql(
            query_client,
            reader_context.id,
            "SELECT * FROM main.graphs.edges LIMIT 10",
            OUTSIDER,
        )
        assert _scope_error(response) is None, response.text

    def test_other_table_in_same_schema_denied(self, query_client, reader_context):
        response = _run_sql(
            query_client,
            reader_context.id,
            "SELECT * FROM main.graphs.salaries",
            OUTSIDER,
        )
        error = _scope_error(response)
        assert error is not None, response.text
        assert "main.graphs.salaries" in error["message"]

    def test_other_catalog_denied(self, query_client, reader_context):
        response = _run_sql(
            query_client,
            reader_context.id,
            "SELECT * FROM hr.private.salaries",
            OUTSIDER,
        )
        assert _scope_error(response) is not None, response.text

    def test_join_smuggling_an_extra_table_denied(self, query_client, reader_context):
        response = _run_sql(
            query_client,
            reader_context.id,
            "SELECT e.* FROM main.graphs.edges e "
            "JOIN hr.private.salaries s ON e.src = s.id",
            OUTSIDER,
        )
        assert _scope_error(response) is not None, response.text

    def test_subquery_smuggling_denied(self, query_client, reader_context):
        response = _run_sql(
            query_client,
            reader_context.id,
            "SELECT * FROM main.graphs.edges WHERE src IN "
            "(SELECT id FROM hr.private.salaries)",
            OUTSIDER,
        )
        assert _scope_error(response) is not None, response.text

    def test_cte_name_is_not_mistaken_for_a_table(self, query_client, reader_context):
        response = _run_sql(
            query_client,
            reader_context.id,
            "WITH picked AS (SELECT * FROM main.graphs.edges) " "SELECT * FROM picked",
            OUTSIDER,
        )
        assert _scope_error(response) is None, response.text


class TestAuthorTierScope:
    """With context.create ⇒ anything inside the configured allowlist."""

    @pytest.fixture
    def author_env(self, monkeypatch, store):
        monkeypatch.setenv("GRAPH_LAGOON_CATALOG_SCHEMAS", "main.graphs,main.staging")
        get_settings.cache_clear()
        yield store.create_graph_context(
            "t", "main.graphs.edges", "main.graphs.nodes", MEMBER
        )
        get_settings.cache_clear()

    def test_other_table_inside_allowlist_allowed(self, query_client, author_env):
        response = _run_sql(
            query_client,
            author_env.id,
            "SELECT * FROM main.staging.other_edges",
            MEMBER,
        )
        assert _scope_error(response) is None, response.text

    def test_table_outside_allowlist_denied(self, query_client, author_env):
        response = _run_sql(
            query_client, author_env.id, "SELECT * FROM hr.private.salaries", MEMBER
        )
        error = _scope_error(response)
        assert error is not None, response.text
        assert "hr.private.salaries" in error["message"]


class TestRawScriptFeatureFlag:
    @pytest.fixture
    def context(self, store):
        return store.create_graph_context(
            "t", "main.graphs.edges", "main.graphs.nodes", MEMBER
        )

    SCRIPT = "BEGIN\n  INSERT INTO main.graphs.edges VALUES (1);\nEND"

    def test_blocked_by_default(self, query_client, context):
        response = _run_sql(query_client, context.id, self.SCRIPT, MEMBER)
        assert response.status_code == 400, response.text
        assert response.json()["detail"]["error"]["code"] == "SCRIPT_NOT_ALLOWED"

    def test_allowed_when_flag_is_on(self, query_client, context, monkeypatch):
        monkeypatch.setenv("GRAPH_LAGOON_ALLOW_RAW_SQL_SCRIPTS", "true")
        get_settings.cache_clear()
        try:
            response = _run_sql(query_client, context.id, self.SCRIPT, MEMBER)
            # Past the gate: no SCRIPT_NOT_ALLOWED, no scope denial (a script
            # cannot be scoped — that is the documented cost of the flag).
            assert response.status_code != 400 or (
                response.json()["detail"]["error"]["code"] != "SCRIPT_NOT_ALLOWED"
            ), response.text
            assert _scope_error(response) is None, response.text
        finally:
            get_settings.cache_clear()


class TestCatalogBrowsingNeedsContextCreate:
    CATALOG_ROUTES = [
        ("GET", "/api/catalog/catalogs", None),
        ("GET", "/api/catalog/databases", None),
        ("GET", "/api/catalog/tables", None),
        ("GET", "/api/catalog/schema?table=t", None),
        ("GET", "/api/catalog/preview?table=t", None),
        ("POST", "/api/catalog/refresh", {}),
        ("GET", "/api/datasets", None),
        (
            "POST",
            "/api/schema-discovery",
            {
                "datasource_type": "sql_warehouse",
                "edge_table": "main.graphs.edges",
                "columns": {"src_col": "s", "dst_col": "d"},
            },
        ),
    ]

    def test_non_author_gets_403_on_every_catalog_route(self, query_client, store):
        _restrict_context_create_to(store, MEMBER)
        for method, path, payload in self.CATALOG_ROUTES:
            response = query_client.request(
                method, path, json=payload, headers=_headers(OUTSIDER)
            )
            assert response.status_code == 403, (path, response.text)
            error = response.json()["detail"]["error"]
            assert error["details"]["permission"] == "context.create", path

    def test_hostile_identifier_rejected_before_sql(self, query_client, store):
        response = query_client.get(
            "/api/catalog/preview",
            params={"table": "x; DROP TABLE users", "database": "db"},
            headers=_headers(MEMBER),
        )
        assert response.status_code == 400, response.text
        assert response.json()["detail"]["error"]["code"] == "INVALID_IDENTIFIER"


class TestCtePrefilterCannotSmuggleTables:
    """The CTE pre-filter is raw client SQL spliced into every mode — it is
    the one place a foreign table could ride into a Cypher (or procedural,
    hence unparseable) statement. Regression for that hole."""

    HOSTILE = "MY_FINAL_EDGES AS (SELECT * FROM hr.private.salaries)"
    BENIGN = "MY_FINAL_EDGES AS (SELECT * FROM __EDGES__ WHERE 1=1)"

    @pytest.fixture
    def reader_context(self, store):
        _restrict_context_create_to(store, MEMBER)
        return store.create_graph_context(
            "t", "main.graphs.edges", "main.graphs.nodes", OUTSIDER
        )

    def _post(self, client, context_id, suffix, payload):
        return client.post(
            f"/api/graph-contexts/{context_id}/{suffix}",
            json=payload,
            headers=_headers(OUTSIDER),
        )

    @pytest.mark.parametrize(
        "suffix,payload",
        [
            ("cypher", {"query": "MATCH (n)-[r]->(m) RETURN r"}),
            ("cypher/async", {"query": "MATCH (n)-[r]->(m) RETURN r"}),
            ("query/table", {"query": "MATCH (n) RETURN n", "mode": "cypher"}),
            ("query", {"query": "SELECT * FROM main.graphs.edges"}),
        ],
    )
    def test_hostile_prefilter_denied_on_every_path(
        self, query_client, reader_context, suffix, payload
    ):
        response = self._post(
            query_client,
            reader_context.id,
            suffix,
            {**payload, "cte_prefilter": self.HOSTILE},
        )
        error = _scope_error(response)
        assert error is not None, (suffix, response.text)
        assert "hr.private.salaries" in error["message"]

    def test_benign_prefilter_over_context_tables_allowed(
        self, query_client, reader_context
    ):
        response = self._post(
            query_client,
            reader_context.id,
            "query",
            {
                "query": "SELECT * FROM main.graphs.edges",
                "cte_prefilter": self.BENIGN,
            },
        )
        assert _scope_error(response) is None, response.text


class TestPrefilterInsideOpaqueScript:
    """The case the route tests cannot reach without a live transpiler: when
    the final statement is a procedural BEGIN...END, it is unscopeable — so
    the pre-filter check at the source is the ONLY thing standing between a
    reader and a foreign table."""

    def test_hostile_prefilter_denied_even_when_sql_is_a_script(self, store):
        import asyncio

        from fastapi import HTTPException

        from graphlagoon.routers.graph import enforce_query_scope

        _restrict_context_create_to(store, MEMBER)
        context = store.create_graph_context(
            "t", "main.graphs.edges", "main.graphs.nodes", OUTSIDER
        )
        with pytest.raises(HTTPException) as exc:
            asyncio.run(
                enforce_query_scope(
                    context,
                    OUTSIDER,
                    "BEGIN\n  SELECT * FROM whatever;\nEND",
                    "MY_FINAL_EDGES AS (SELECT * FROM hr.private.salaries)",
                )
            )
        assert exc.value.status_code == 403
        error = exc.value.detail["error"]
        assert error["code"] == "QUERY_SCOPE_DENIED"
        assert "hr.private.salaries" in error["message"]

    def test_placeholders_resolve_to_the_context_tables(self, store):
        import asyncio

        from graphlagoon.routers.graph import enforce_query_scope

        _restrict_context_create_to(store, MEMBER)
        context = store.create_graph_context(
            "t", "main.graphs.edges", "main.graphs.nodes", OUTSIDER
        )
        # __EDGES__/__NODES__ are the context's own tables — must not be
        # mistaken for foreign ones.
        asyncio.run(
            enforce_query_scope(
                context,
                OUTSIDER,
                None,
                "MY_FINAL_EDGES AS (SELECT * FROM __EDGES__ " "JOIN __NODES__ ON 1=1)",
            )
        )
