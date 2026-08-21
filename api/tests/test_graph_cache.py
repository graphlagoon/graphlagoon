"""Tests for the named graph cache — service selection and HTTP endpoints."""

import gzip
import sys
from uuid import uuid4

import orjson
import pytest

# Stub gsql2rsql package tree so graphlagoon can be imported without the dep.
# IMPORTANT: only stub when the real package is genuinely unavailable — a
# `not in sys.modules` guard would stub gsql2rsql for the whole session and break
# test_transpile_options.
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

from graphlagoon.config import Settings, get_settings  # noqa: E402
from graphlagoon.db.memory_store import InMemoryStore  # noqa: E402
from graphlagoon.routers import graph_cache as graph_cache_router  # noqa: E402
from graphlagoon.services.graph_cache import (  # noqa: E402
    configure_graph_cache_service,
    reset_graph_cache_service,
)

OWNER = "owner@example.com"
READER = "reader@example.com"
STRANGER = "stranger@example.com"
SUPERUSER = "admin@example.com"


def _headers(email):
    return {"X-Forwarded-Email": email}


def _graph(node_count=2):
    return {
        "nodes": [
            {
                "node_id": f"n{i}",
                "node_type": "Account",
                "properties": {"score": i},
            }
            for i in range(node_count)
        ],
        "edges": [
            {
                "edge_id": "e0",
                "src": "n0",
                "dst": "n1",
                "relationship_type": "SENT",
                "properties": {},
            }
        ][: max(0, node_count - 1)],
        "truncated": False,
    }


def _body(node_count=2, **graph_overrides):
    graph = _graph(node_count)
    graph.update(graph_overrides)
    return {
        "graph": graph,
        "source": {"kind": "cypher", "query": "MATCH (n) RETURN n"},
    }


@pytest.fixture
def store():
    InMemoryStore.reset()
    yield InMemoryStore.get_instance()
    InMemoryStore.reset()


@pytest.fixture
def context(store):
    return store.create_graph_context(
        title="ctx", edge_table_name="e", node_table_name="n", owner_email=OWNER
    )


def _configure(tmp_path, **overrides):
    settings = Settings(
        graph_cache_dir=str(tmp_path / "cache"),
        databricks_volume_path=None,
        graph_cache_volume_path=None,
        **overrides,
    )
    reset_graph_cache_service()
    configure_graph_cache_service(settings)
    return settings


@pytest.fixture
def client(tmp_path):
    """Dev mode on: writes allowed."""
    _configure(tmp_path, dev_mode=True)
    app = FastAPI()
    app.include_router(graph_cache_router.router)
    yield TestClient(app)
    reset_graph_cache_service()


@pytest.fixture
def prod_client(tmp_path):
    """Dev mode off: reads allowed, writes refused."""
    _configure(tmp_path, dev_mode=True)  # seed through the writable service first
    app = FastAPI()
    app.include_router(graph_cache_router.router)
    yield TestClient(app), (lambda: _configure(tmp_path, dev_mode=False))
    reset_graph_cache_service()


def _url(context_id, name=None):
    base = f"/api/graph-contexts/{context_id}/graph-cache"
    return base if name is None else f"{base}/{name}"


class TestRoundTrip:
    def test_put_then_get_replays_the_graph(self, client, store, context):
        resp = client.put(
            _url(context.id, "fraude-2024"), json=_body(), headers=_headers(OWNER)
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["name"] == "fraude-2024"
        assert resp.json()["size_bytes"] > 0

        resp = client.get(_url(context.id, "fraude-2024"), headers=_headers(OWNER))
        assert resp.status_code == 200
        payload = resp.json()
        assert payload["name"] == "fraude-2024"
        assert payload["created_by"] == OWNER
        assert payload["node_count"] == 2
        assert payload["edge_count"] == 1
        assert payload["source"]["query"] == "MATCH (n) RETURN n"
        assert [n["node_id"] for n in payload["graph"]["nodes"]] == ["n0", "n1"]
        assert payload["graph"]["edges"][0]["src"] == "n0"

    def test_response_is_served_gzip_encoded(self, client, store, context, tmp_path):
        """The read path hands back the stored bytes untouched — that is why the
        codec is gzip. Checked at the transport level, with automatic decoding off.
        """
        client.put(_url(context.id, "c1"), json=_body(), headers=_headers(OWNER))

        resp = client.get(
            _url(context.id, "c1"),
            headers={**_headers(OWNER), "Accept-Encoding": "gzip"},
        )
        assert resp.headers["content-encoding"] == "gzip"
        assert resp.headers["cache-control"] == "no-cache"
        # httpx decodes Content-Encoding transparently, so reaching valid JSON here
        # is itself the proof that the body was a well-formed gzip stream — and
        # that GZipMiddleware did not wrap it a second time.
        assert orjson.loads(resp.content)["name"] == "c1"

        # And the bytes on disk are exactly what was served: no re-encoding.
        stored = (
            tmp_path / "cache" / "cache" / str(context.id) / "c1.jsonz"
        ).read_bytes()
        assert orjson.loads(gzip.decompress(stored))["name"] == "c1"

    def test_delete_removes_the_entry(self, client, store, context):
        client.put(_url(context.id, "c1"), json=_body(), headers=_headers(OWNER))

        resp = client.delete(_url(context.id, "c1"), headers=_headers(OWNER))
        assert resp.status_code == 204

        assert (
            client.get(_url(context.id, "c1"), headers=_headers(OWNER)).status_code
            == 404
        )

    def test_deleting_a_missing_entry_is_not_an_error(self, client, store, context):
        """Without a listing there is no way to check first, so delete has to be
        idempotent — otherwise a retry after a lost response reports failure."""
        resp = client.delete(_url(context.id, "never-existed"), headers=_headers(OWNER))
        assert resp.status_code == 204

    def test_overwrite_replaces_content(self, client, store, context):
        client.put(_url(context.id, "c1"), json=_body(2), headers=_headers(OWNER))
        client.put(_url(context.id, "c1"), json=_body(5), headers=_headers(OWNER))

        payload = client.get(_url(context.id, "c1"), headers=_headers(OWNER)).json()
        assert payload["node_count"] == 5

    def test_missing_entry_is_404(self, client, store, context):
        resp = client.get(_url(context.id, "nope"), headers=_headers(OWNER))
        assert resp.status_code == 404
        assert resp.json()["detail"]["error"]["code"] == "GRAPH_CACHE_NOT_FOUND"

    def test_missing_context_is_404(self, client, store):
        resp = client.get(_url(uuid4(), "c1"), headers=_headers(OWNER))
        assert resp.status_code == 404


class TestNoListingEndpoint:
    """Enumeration is the one operation that does not survive scale: a directory
    listing is O(entries) — ~16 µs and ~100 bytes of JSON each, measured locally
    — so a context with a million entries would mean a 16-second call returning
    100 MB. Paging would only move the cost, since the Databricks Files API has
    no server-side name filter to page toward. So the endpoint does not exist.
    """

    def test_the_collection_url_is_not_routable(self, client, store, context):
        resp = client.get(_url(context.id), headers=_headers(OWNER))
        assert resp.status_code in (404, 405)

    def test_the_service_exposes_no_list_method(self):
        from graphlagoon.services.graph_cache import GraphCacheService

        assert not hasattr(GraphCacheService, "list")


class TestNameValidation:
    @pytest.mark.parametrize(
        "name",
        [
            "_index",
            ".hidden",
            "-leading",
            "a" * 65,
            "with space",
            "with\\backslash",
            "unicode-é",
            "semi;colon",
            "dollar$sign",
        ],
    )
    def test_rejects_unsafe_names(self, client, store, context, name):
        resp = client.put(
            _url(context.id, name), json=_body(), headers=_headers(OWNER)
        )
        assert resp.status_code == 400, resp.text
        assert resp.json()["detail"]["error"]["code"] == "INVALID_CACHE_NAME"

    @pytest.mark.parametrize("name", ["with/slash", ".."])
    def test_names_that_change_the_url_shape_never_reach_storage(
        self, client, store, context, name
    ):
        """A slash or a dot-segment is resolved by the URL layer before routing,
        so these can only ever 404/405 — never land as a key."""
        resp = client.put(
            _url(context.id, name), json=_body(), headers=_headers(OWNER)
        )
        assert resp.status_code in (400, 404, 405), resp.text

    @pytest.mark.parametrize("name", ["a", "fraude-2024", "v1.2_final", "A1"])
    def test_accepts_reasonable_names(self, client, store, context, name):
        resp = client.put(
            _url(context.id, name), json=_body(), headers=_headers(OWNER)
        )
        assert resp.status_code == 200, resp.text

    def test_percent_encoded_slash_cannot_traverse(self, client, store, context):
        """`%2F` is decoded before the handler sees it, so validation must run on
        the decoded value — otherwise `../` reaches the store."""
        resp = client.get(
            _url(context.id, "..%2F..%2Fetc%2Fpasswd"), headers=_headers(OWNER)
        )
        assert resp.status_code in (400, 404)
        assert "passwd" not in resp.text or resp.status_code == 400

    def test_traversal_cannot_reach_another_context(
        self, client, store, context, tmp_path
    ):
        other = store.create_graph_context(
            title="other", edge_table_name="e", node_table_name="n", owner_email=OWNER
        )
        client.put(_url(other.id, "secret"), json=_body(), headers=_headers(OWNER))

        resp = client.get(
            _url(context.id, f"..{'%2F'}{other.id}{'%2F'}secret"),
            headers=_headers(OWNER),
        )
        assert resp.status_code in (400, 404)


class TestIsolation:
    def test_a_cache_is_scoped_to_its_context(self, client, store, context):
        other = store.create_graph_context(
            title="other", edge_table_name="e", node_table_name="n", owner_email=OWNER
        )
        client.put(_url(context.id, "shared-name"), json=_body(), headers=_headers(OWNER))

        resp = client.get(_url(other.id, "shared-name"), headers=_headers(OWNER))
        assert resp.status_code == 404

    def test_same_name_in_two_contexts_holds_different_graphs(
        self, client, store, context
    ):
        other = store.create_graph_context(
            title="other", edge_table_name="e", node_table_name="n", owner_email=OWNER
        )
        client.put(_url(context.id, "n"), json=_body(2), headers=_headers(OWNER))
        client.put(_url(other.id, "n"), json=_body(4), headers=_headers(OWNER))

        assert (
            client.get(_url(context.id, "n"), headers=_headers(OWNER)).json()[
                "node_count"
            ]
            == 2
        )
        assert (
            client.get(_url(other.id, "n"), headers=_headers(OWNER)).json()[
                "node_count"
            ]
            == 4
        )


class TestAuthorization:
    def test_stranger_cannot_read(self, client, store, context):
        client.put(_url(context.id, "c1"), json=_body(), headers=_headers(OWNER))

        assert (
            client.get(_url(context.id, "c1"), headers=_headers(STRANGER)).status_code
            == 403
        )

    def test_stranger_cannot_write(self, client, store, context):
        resp = client.put(
            _url(context.id, "c1"), json=_body(), headers=_headers(STRANGER)
        )
        assert resp.status_code == 403

    def test_shared_reader_can_read(self, client, store, context):
        store.share_graph_context(context.id, READER, permission="read")
        client.put(_url(context.id, "c1"), json=_body(), headers=_headers(OWNER))

        assert (
            client.get(_url(context.id, "c1"), headers=_headers(READER)).status_code
            == 200
        )

    def test_shared_reader_cannot_delete(self, client, store, context):
        store.share_graph_context(context.id, READER, permission="write")
        client.put(_url(context.id, "c1"), json=_body(), headers=_headers(OWNER))

        resp = client.delete(_url(context.id, "c1"), headers=_headers(READER))
        assert resp.status_code == 403
        # ...and the entry survives.
        assert (
            client.get(_url(context.id, "c1"), headers=_headers(OWNER)).status_code
            == 200
        )

    def test_public_share_grants_read(self, client, store, context):
        store.share_graph_context(context.id, "*", permission="read")
        client.put(_url(context.id, "c1"), json=_body(), headers=_headers(OWNER))

        assert (
            client.get(
                _url(context.id, "c1"), headers=_headers("anyone@elsewhere.com")
            ).status_code
            == 200
        )

    def test_superuser_can_read_any_context(self, client, store, context, monkeypatch):
        monkeypatch.setenv("GRAPH_LAGOON_SUPERUSER_EMAILS", SUPERUSER)
        get_settings.cache_clear()
        try:
            client.put(_url(context.id, "c1"), json=_body(), headers=_headers(OWNER))
            assert (
                client.get(
                    _url(context.id, "c1"), headers=_headers(SUPERUSER)
                ).status_code
                == 200
            )
        finally:
            get_settings.cache_clear()


class TestDevGate:
    def test_writes_are_refused_outside_dev_mode(self, prod_client, store, context):
        client, make_prod = prod_client
        client.put(_url(context.id, "c1"), json=_body(), headers=_headers(OWNER))
        make_prod()

        resp = client.put(_url(context.id, "c2"), json=_body(), headers=_headers(OWNER))
        assert resp.status_code == 403
        assert resp.json()["detail"]["error"]["code"] == "FORBIDDEN"

    def test_deletes_are_refused_outside_dev_mode(self, prod_client, store, context):
        client, make_prod = prod_client
        client.put(_url(context.id, "c1"), json=_body(), headers=_headers(OWNER))
        make_prod()

        assert (
            client.delete(_url(context.id, "c1"), headers=_headers(OWNER)).status_code
            == 403
        )

    def test_reads_still_work_outside_dev_mode(self, prod_client, store, context):
        """The whole point of the feature: production replays caches."""
        client, make_prod = prod_client
        client.put(_url(context.id, "c1"), json=_body(), headers=_headers(OWNER))
        make_prod()

        assert (
            client.get(_url(context.id, "c1"), headers=_headers(OWNER)).status_code
            == 200
        )


class TestIncompleteGraphs:
    def test_refuses_a_graph_still_being_enriched(self, client, store, context):
        """Caching mid-enrichment would persist null properties and defeat the
        purpose — the entry would replay empty or re-query the warehouse."""
        resp = client.put(
            _url(context.id, "c1"),
            json=_body(properties_deferred=True),
            headers=_headers(OWNER),
        )
        assert resp.status_code == 400
        assert resp.json()["detail"]["error"]["code"] == "CACHE_INCOMPLETE"

    def test_stored_entries_record_completeness(self, client, store, context):
        client.put(_url(context.id, "c1"), json=_body(), headers=_headers(OWNER))
        payload = client.get(_url(context.id, "c1"), headers=_headers(OWNER)).json()
        assert payload["properties_complete"] is True
        assert payload["graph"]["properties_deferred"] is False


class TestSizeLimit:
    def test_oversized_entry_is_rejected(self, tmp_path, store, context):
        _configure(tmp_path, dev_mode=True, graph_cache_max_bytes=64)
        app = FastAPI()
        app.include_router(graph_cache_router.router)
        client = TestClient(app)
        try:
            resp = client.put(
                _url(context.id, "big"), json=_body(200), headers=_headers(OWNER)
            )
            assert resp.status_code == 413
            assert resp.json()["detail"]["error"]["code"] == "CACHE_TOO_LARGE"
        finally:
            reset_graph_cache_service()

    def test_oversized_body_is_rejected_before_parsing(self, tmp_path, store, context):
        """Content-Length is the only signal available before Starlette reads the
        body, so the pre-check has to run there."""
        _configure(tmp_path, dev_mode=True, graph_cache_max_bytes=16)
        app = FastAPI()
        app.include_router(graph_cache_router.router)
        client = TestClient(app)
        try:
            resp = client.put(
                _url(context.id, "big"),
                content=orjson.dumps(_body(400)),
                headers={**_headers(OWNER), "Content-Type": "application/json"},
            )
            assert resp.status_code == 413
        finally:
            reset_graph_cache_service()


class TestCorruptEntries:
    def test_unreadable_entry_reports_502_not_a_blank_graph(
        self, client, store, context, tmp_path
    ):
        """A volume overwrite is not atomic, so a reader can catch a partial
        object. That must say so, not render an empty canvas."""
        client.put(_url(context.id, "c1"), json=_body(), headers=_headers(OWNER))

        path = tmp_path / "cache" / "cache" / str(context.id) / "c1.jsonz"
        assert path.is_file()
        path.write_bytes(b"not gzip at all")

        resp = client.get(_url(context.id, "c1"), headers=_headers(OWNER))
        assert resp.status_code == 502
        assert resp.json()["detail"]["error"]["code"] == "CACHE_UNREADABLE"


class TestGzipMiddlewareInteraction:
    """The reason the codec is gzip rather than something denser.

    Starlette's GZipMiddleware forwards any body that already declares a
    Content-Encoding, so the read path can hand back the stored bytes untouched.
    If that ever stopped holding, the server would silently start double-encoding
    every cached graph — hence a test against the real middleware.
    """

    @pytest.fixture
    def gzipped_client(self, tmp_path):
        from starlette.middleware.gzip import GZipMiddleware

        _configure(tmp_path, dev_mode=True)
        app = FastAPI()
        app.add_middleware(GZipMiddleware, minimum_size=1)
        app.include_router(graph_cache_router.router)
        yield TestClient(app)
        reset_graph_cache_service()

    def test_body_is_not_compressed_twice(self, gzipped_client, store, context):
        gzipped_client.put(
            _url(context.id, "c1"), json=_body(50), headers=_headers(OWNER)
        )

        resp = gzipped_client.get(
            _url(context.id, "c1"),
            headers={**_headers(OWNER), "Accept-Encoding": "gzip"},
        )
        assert resp.status_code == 200
        assert resp.headers["content-encoding"] == "gzip"
        # One layer of decoding (httpx's) is enough to reach JSON. A second gzip
        # wrap would leave binary here and this would raise.
        assert orjson.loads(resp.content)["name"] == "c1"

    def test_ordinary_json_responses_still_go_through_the_middleware(
        self, gzipped_client, store, context
    ):
        """Only the replay endpoint opts out. A normal JSON response — here the
        write receipt — keeps being handled by the middleware as before."""
        resp = gzipped_client.put(
            _url(context.id, "c1"),
            json=_body(),
            headers={**_headers(OWNER), "Accept-Encoding": "gzip"},
        )
        assert resp.status_code == 200
        assert resp.json()["name"] == "c1"


class TestStorageLayout:
    def test_files_land_where_the_spec_says(self, client, store, context, tmp_path):
        client.put(_url(context.id, "fraude-2024"), json=_body(), headers=_headers(OWNER))
        expected = tmp_path / "cache" / "cache" / str(context.id) / "fraude-2024.jsonz"
        assert expected.is_file()

    def test_stored_file_is_gzip_json(self, client, store, context, tmp_path):
        client.put(_url(context.id, "c1"), json=_body(), headers=_headers(OWNER))
        raw = (tmp_path / "cache" / "cache" / str(context.id) / "c1.jsonz").read_bytes()
        assert raw[:2] == b"\x1f\x8b"
        assert orjson.loads(gzip.decompress(raw))["name"] == "c1"


class TestServiceSelection:
    def test_local_backend_without_a_volume_path(self, tmp_path):
        from graphlagoon.services.blob_storage import LocalBlobStore
        from graphlagoon.services.graph_cache import get_graph_cache_service

        _configure(tmp_path, dev_mode=True)
        try:
            assert isinstance(get_graph_cache_service()._store, LocalBlobStore)
        finally:
            reset_graph_cache_service()

    def test_databricks_backend_when_a_volume_path_is_set(self, tmp_path):
        from graphlagoon.services.blob_storage import DatabricksBlobStore
        from graphlagoon.services.graph_cache import get_graph_cache_service

        settings = Settings(
            graph_cache_dir=str(tmp_path),
            graph_cache_volume_path="/Volumes/main/default/vol/graph-cache",
            databricks_host="adb-test.azuredatabricks.net",
            databricks_token="dapi-xxx",
        )
        reset_graph_cache_service()
        configure_graph_cache_service(settings)
        try:
            assert isinstance(get_graph_cache_service()._store, DatabricksBlobStore)
        finally:
            reset_graph_cache_service()

    def test_snapshot_volume_supplies_a_default_subdirectory(self, tmp_path):
        """An existing Databricks deployment gets a correct location without a
        second environment variable."""
        settings = Settings(
            databricks_volume_path="/Volumes/main/default/vol/explorations",
        )
        assert (
            settings.graph_cache_volume_path_effective
            == "/Volumes/main/default/vol/explorations/graph-cache"
        )

    def test_explicit_cache_volume_wins(self, tmp_path):
        settings = Settings(
            databricks_volume_path="/Volumes/a/b/c",
            graph_cache_volume_path="/Volumes/x/y/z",
        )
        assert settings.graph_cache_volume_path_effective == "/Volumes/x/y/z"

    def test_no_volume_means_no_effective_path(self):
        assert Settings().graph_cache_volume_path_effective is None

    def test_missing_host_is_a_clear_error(self, tmp_path):
        from graphlagoon.services.graph_cache import get_graph_cache_service

        settings = Settings(
            graph_cache_volume_path="/Volumes/main/default/vol/graph-cache",
            databricks_token="dapi-xxx",
        )
        reset_graph_cache_service()
        configure_graph_cache_service(settings)
        try:
            with pytest.raises(ValueError, match="DATABRICKS_HOST"):
                get_graph_cache_service()
        finally:
            reset_graph_cache_service()


class TestDisabled:
    def test_every_endpoint_reports_disabled(self, tmp_path, store, context):
        _configure(tmp_path, dev_mode=True, graph_cache_enabled=False)
        app = FastAPI()
        app.include_router(graph_cache_router.router)
        client = TestClient(app)
        try:
            for resp in (
                client.get(_url(context.id, "c1"), headers=_headers(OWNER)),
                client.put(_url(context.id, "c1"), json=_body(), headers=_headers(OWNER)),
                client.delete(_url(context.id, "c1"), headers=_headers(OWNER)),
            ):
                assert resp.status_code == 404
                assert resp.json()["detail"]["error"]["code"] == "GRAPH_CACHE_DISABLED"
        finally:
            reset_graph_cache_service()

    def test_writable_requires_both_flags(self, tmp_path):
        from graphlagoon.services.graph_cache import graph_cache_writable

        for enabled, dev, expected in (
            (True, True, True),
            (True, False, False),
            (False, True, False),
            (False, False, False),
        ):
            _configure(tmp_path, dev_mode=dev, graph_cache_enabled=enabled)
            assert graph_cache_writable() is expected
        reset_graph_cache_service()


class TestContextDeletionCascade:
    def test_deleting_a_context_purges_its_caches(
        self, client, store, context, tmp_path
    ):
        import asyncio

        from graphlagoon.routers.graph_contexts import _purge_graph_caches

        client.put(_url(context.id, "c1"), json=_body(), headers=_headers(OWNER))
        directory = tmp_path / "cache" / "cache" / str(context.id)
        assert directory.is_dir()

        asyncio.run(_purge_graph_caches(context.id))
        assert not directory.exists()

    def test_purge_never_raises_for_an_uncached_context(self, client, store):
        import asyncio

        from graphlagoon.routers.graph_contexts import _purge_graph_caches

        asyncio.run(_purge_graph_caches(uuid4()))
