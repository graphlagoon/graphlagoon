"""Tests for precomputed graphs served by the built-in volume provider.

This module covers the HTTP surface and the volume provider specifically. The
provider *chain* — declining, matching, ordering, capabilities — lives in
test_precomputed_providers.py, and parameter coercion in
test_precomputed_params.py.

Authorization note: writing and deleting is restricted to superusers
(GRAPH_LAGOON_SUPERUSER_EMAILS) — unlike a style preset, a precomputed graph is
a published, administered artifact, not something context ownership or a
write-share grants power over. The `client` fixture configures SUPERUSER as the
superuser for the whole module, so every "arrange" write below is performed by
SUPERUSER; OWNER/WRITER/READER/STRANGER exist to exercise context-level *read*
access and to prove none of them can write or delete.
"""

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
from graphlagoon.routers import precomputed_graphs as precomputed_router  # noqa: E402
from graphlagoon.services.precomputed import (  # noqa: E402
    clear_precomputed_graph_registry,
    configure_precomputed_storage,
    register_precomputed_graph_provider,
    reset_precomputed_storage,
    volume_provider,
)

OWNER = "owner@example.com"
WRITER = "writer@example.com"
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
    ctx = store.create_graph_context(
        title="ctx", edge_table_name="e", node_table_name="n", owner_email=OWNER
    )
    store.share_graph_context(ctx.id, WRITER, permission="write")
    store.share_graph_context(ctx.id, READER, permission="read")
    return ctx


def _configure(tmp_path, **overrides):
    """Point the default store at a temp directory and register a volume provider.

    Registering is part of configuring here because the router resolves through
    the registry: settings alone no longer make a graph readable, a provider
    claiming the request does.
    """
    settings = Settings(
        precomputed_graphs_dir=str(tmp_path / "store"),
        databricks_volume_path=None,
        precomputed_graphs_volume_path=None,
        **overrides,
    )
    reset_precomputed_storage()
    clear_precomputed_graph_registry()
    configure_precomputed_storage(settings)
    register_precomputed_graph_provider(volume_provider())
    return settings


def _make_superuser(monkeypatch, *emails):
    """Configure GRAPH_LAGOON_SUPERUSER_EMAILS on the global settings cache.

    `is_superuser` (utils/authz.py) always reads `get_settings()`, not the
    settings object handed to `configure_precomputed_storage` — the same
    convention every other router in this codebase follows, so this mirrors it
    rather than special-casing this feature.
    """
    monkeypatch.setenv("GRAPH_LAGOON_SUPERUSER_EMAILS", ",".join(emails))
    get_settings.cache_clear()


@pytest.fixture
def client(tmp_path, monkeypatch):
    _make_superuser(monkeypatch, SUPERUSER)
    _configure(tmp_path)
    app = FastAPI()
    app.include_router(precomputed_router.router)
    yield TestClient(app)
    reset_precomputed_storage()
    clear_precomputed_graph_registry()
    get_settings.cache_clear()


def _url(context_id, name=None):
    base = f"/api/graph-contexts/{context_id}/precomputed-graphs"
    return base if name is None else f"{base}/{name}"


class TestRoundTrip:
    def test_put_then_get_replays_the_graph(self, client, store, context):
        resp = client.put(
            _url(context.id, "fraude-2024"), json=_body(), headers=_headers(SUPERUSER)
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["name"] == "fraude-2024"
        assert resp.json()["size_bytes"] > 0

        resp = client.get(_url(context.id, "fraude-2024"), headers=_headers(OWNER))
        assert resp.status_code == 200
        payload = resp.json()
        assert payload["name"] == "fraude-2024"
        assert payload["created_by"] == SUPERUSER
        assert payload["node_count"] == 2
        assert payload["edge_count"] == 1
        assert payload["source"]["query"] == "MATCH (n) RETURN n"
        assert [n["node_id"] for n in payload["graph"]["nodes"]] == ["n0", "n1"]
        assert payload["graph"]["edges"][0]["src"] == "n0"

    def test_response_is_served_gzip_encoded(self, client, store, context, tmp_path):
        """The read path hands back the stored bytes untouched — that is why the
        codec is gzip. Checked at the transport level, with automatic decoding off.
        """
        client.put(_url(context.id, "c1"), json=_body(), headers=_headers(SUPERUSER))

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
            tmp_path / "store" / "precomputed" / str(context.id) / "c1.jsonz"
        ).read_bytes()
        assert orjson.loads(gzip.decompress(stored))["name"] == "c1"

    def test_delete_removes_the_entry(self, client, store, context):
        client.put(_url(context.id, "c1"), json=_body(), headers=_headers(SUPERUSER))

        resp = client.delete(_url(context.id, "c1"), headers=_headers(SUPERUSER))
        assert resp.status_code == 204

        assert (
            client.get(_url(context.id, "c1"), headers=_headers(OWNER)).status_code
            == 404
        )

    def test_deleting_a_missing_entry_is_not_an_error(self, client, store, context):
        """Without a listing there is no way to check first, so delete has to be
        idempotent — otherwise a retry after a lost response reports failure."""
        resp = client.delete(
            _url(context.id, "never-existed"), headers=_headers(SUPERUSER)
        )
        assert resp.status_code == 204

    def test_overwrite_replaces_content(self, client, store, context):
        client.put(_url(context.id, "c1"), json=_body(2), headers=_headers(SUPERUSER))
        client.put(_url(context.id, "c1"), json=_body(5), headers=_headers(SUPERUSER))

        payload = client.get(_url(context.id, "c1"), headers=_headers(OWNER)).json()
        assert payload["node_count"] == 5

    def test_missing_entry_is_404(self, client, store, context):
        resp = client.get(_url(context.id, "nope"), headers=_headers(OWNER))
        assert resp.status_code == 404
        assert resp.json()["detail"]["error"]["code"] == "PRECOMPUTED_GRAPH_NOT_FOUND"

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

    def test_the_collection_url_returns_capabilities_not_a_listing(
        self, client, store, context
    ):
        """The collection URL exists, but answers "what can this context do",
        never "what is in it"."""
        client.put(_url(context.id, "c1"), json=_body(), headers=_headers(SUPERUSER))

        resp = client.get(_url(context.id), headers=_headers(OWNER))
        assert resp.status_code == 200
        body = resp.json()
        assert set(body) == {"enabled", "can_write", "can_delete", "providers"}
        # Nothing that could grow with the number of entries.
        assert "entries" not in body and "names" not in body
        serialized = orjson.dumps(body).decode()
        assert "c1" not in serialized

    def test_no_provider_api_exposes_a_list_method(self):
        from graphlagoon.services.precomputed import PrecomputedGraphProvider

        assert not hasattr(PrecomputedGraphProvider, "list")
        assert not any(
            field.name == "list"
            for field in PrecomputedGraphProvider.__dataclass_fields__.values()
        )


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
            _url(context.id, name), json=_body(), headers=_headers(SUPERUSER)
        )
        assert resp.status_code == 400, resp.text
        assert resp.json()["detail"]["error"]["code"] == "INVALID_PRECOMPUTED_NAME"

    @pytest.mark.parametrize("name", ["with/slash", ".."])
    def test_names_that_change_the_url_shape_never_reach_storage(
        self, client, store, context, name
    ):
        """A slash or a dot-segment is resolved by the URL layer before routing,
        so these can only ever 404/405 — never land as a key."""
        resp = client.put(
            _url(context.id, name), json=_body(), headers=_headers(SUPERUSER)
        )
        assert resp.status_code in (400, 404, 405), resp.text

    @pytest.mark.parametrize("name", ["a", "fraude-2024", "v1.2_final", "A1"])
    def test_accepts_reasonable_names(self, client, store, context, name):
        resp = client.put(
            _url(context.id, name), json=_body(), headers=_headers(SUPERUSER)
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
        client.put(_url(other.id, "secret"), json=_body(), headers=_headers(SUPERUSER))

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
        client.put(
            _url(context.id, "shared-name"), json=_body(), headers=_headers(SUPERUSER)
        )

        resp = client.get(_url(other.id, "shared-name"), headers=_headers(OWNER))
        assert resp.status_code == 404

    def test_same_name_in_two_contexts_holds_different_graphs(
        self, client, store, context
    ):
        other = store.create_graph_context(
            title="other", edge_table_name="e", node_table_name="n", owner_email=OWNER
        )
        client.put(_url(context.id, "n"), json=_body(2), headers=_headers(SUPERUSER))
        client.put(_url(other.id, "n"), json=_body(4), headers=_headers(SUPERUSER))

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


class TestReadAuthorization:
    """Reading is gated only by context access — unaffected by the superuser
    write/delete rule below."""

    def test_stranger_cannot_read(self, client, store, context):
        client.put(_url(context.id, "c1"), json=_body(), headers=_headers(SUPERUSER))

        assert (
            client.get(_url(context.id, "c1"), headers=_headers(STRANGER)).status_code
            == 403
        )

    def test_shared_reader_can_read(self, client, store, context):
        client.put(_url(context.id, "c1"), json=_body(), headers=_headers(SUPERUSER))

        assert (
            client.get(_url(context.id, "c1"), headers=_headers(READER)).status_code
            == 200
        )

    def test_public_share_grants_read(self, client, store, context):
        store.share_graph_context(context.id, "*", permission="read")
        client.put(_url(context.id, "c1"), json=_body(), headers=_headers(SUPERUSER))

        assert (
            client.get(
                _url(context.id, "c1"), headers=_headers("anyone@elsewhere.com")
            ).status_code
            == 200
        )

    def test_reads_never_require_superuser(self, client, store, context):
        """The whole point of the feature: anyone with context access replays a
        cache, superuser or not."""
        client.put(_url(context.id, "c1"), json=_body(), headers=_headers(SUPERUSER))

        for email in (OWNER, WRITER, READER):
            assert (
                client.get(_url(context.id, "c1"), headers=_headers(email)).status_code
                == 200
            )


class TestSuperuserGate:
    """Creating and deleting a cache entry is superuser-only.

    Unlike a style preset — which anyone with context write access can save,
    and only its own creator can delete — a graph cache carries no notion of
    per-entry ownership and context ownership grants no special power over it:
    it is a published artifact administered by GRAPH_LAGOON_SUPERUSER_EMAILS,
    full stop.
    """

    @pytest.mark.parametrize("email", [OWNER, WRITER, READER, STRANGER])
    def test_non_superusers_cannot_write(self, client, store, context, email):
        resp = client.put(
            _url(context.id, "c1"), json=_body(), headers=_headers(email)
        )
        assert resp.status_code == 403
        assert resp.json()["detail"]["error"]["code"] == "FORBIDDEN"
        assert "superuser" in resp.json()["detail"]["error"]["message"].lower()

    def test_superuser_can_write(self, client, store, context):
        resp = client.put(
            _url(context.id, "c1"), json=_body(), headers=_headers(SUPERUSER)
        )
        assert resp.status_code == 200

    @pytest.mark.parametrize("email", [OWNER, WRITER, READER, STRANGER])
    def test_non_superusers_cannot_delete(self, client, store, context, email):
        client.put(_url(context.id, "c1"), json=_body(), headers=_headers(SUPERUSER))

        resp = client.delete(_url(context.id, "c1"), headers=_headers(email))
        assert resp.status_code == 403
        # ...and the entry survives.
        assert (
            client.get(_url(context.id, "c1"), headers=_headers(OWNER)).status_code
            == 200
        )

    def test_owning_the_context_grants_no_special_power(self, client, store, context):
        """The context owner is, deliberately, just another non-superuser here."""
        resp = client.put(
            _url(context.id, "c1"), json=_body(), headers=_headers(OWNER)
        )
        assert resp.status_code == 403

    def test_superuser_can_delete(self, client, store, context):
        client.put(_url(context.id, "c1"), json=_body(), headers=_headers(SUPERUSER))

        resp = client.delete(_url(context.id, "c1"), headers=_headers(SUPERUSER))
        assert resp.status_code == 204

    def test_a_stranger_to_the_context_gets_403_not_404(self, client, store, context):
        """FORBIDDEN, not GRAPH_CONTEXT_NOT_FOUND: the superuser check runs before
        the context lookup, so a stranger learns nothing about the context either
        way — but the error code names the actual reason."""
        resp = client.put(
            _url(uuid4(), "c1"), json=_body(), headers=_headers(STRANGER)
        )
        assert resp.status_code == 403
        assert resp.json()["detail"]["error"]["code"] == "FORBIDDEN"


class TestIncompleteGraphs:
    def test_refuses_a_graph_still_being_enriched(self, client, store, context):
        """Caching mid-enrichment would persist null properties and defeat the
        purpose — the entry would replay empty or re-query the warehouse."""
        resp = client.put(
            _url(context.id, "c1"),
            json=_body(properties_deferred=True),
            headers=_headers(SUPERUSER),
        )
        assert resp.status_code == 400
        assert resp.json()["detail"]["error"]["code"] == "PRECOMPUTED_GRAPH_INCOMPLETE"

    def test_stored_entries_record_completeness(self, client, store, context):
        client.put(_url(context.id, "c1"), json=_body(), headers=_headers(SUPERUSER))
        payload = client.get(_url(context.id, "c1"), headers=_headers(OWNER)).json()
        assert payload["properties_complete"] is True
        assert payload["graph"]["properties_deferred"] is False


class TestSizeLimit:
    def test_oversized_entry_is_rejected(self, tmp_path, store, context, monkeypatch):
        _make_superuser(monkeypatch, SUPERUSER)
        _configure(tmp_path, precomputed_graphs_max_bytes=64)
        app = FastAPI()
        app.include_router(precomputed_router.router)
        client = TestClient(app)
        try:
            resp = client.put(
                _url(context.id, "big"), json=_body(200), headers=_headers(SUPERUSER)
            )
            assert resp.status_code == 413
            assert resp.json()["detail"]["error"]["code"] == "PRECOMPUTED_GRAPH_TOO_LARGE"
        finally:
            reset_precomputed_storage()
            get_settings.cache_clear()

    def test_oversized_body_is_rejected_before_parsing(
        self, tmp_path, store, context, monkeypatch
    ):
        """Content-Length is the only signal available before Starlette reads the
        body, so the pre-check has to run there."""
        _make_superuser(monkeypatch, SUPERUSER)
        _configure(tmp_path, precomputed_graphs_max_bytes=16)
        app = FastAPI()
        app.include_router(precomputed_router.router)
        client = TestClient(app)
        try:
            resp = client.put(
                _url(context.id, "big"),
                content=orjson.dumps(_body(400)),
                headers={**_headers(SUPERUSER), "Content-Type": "application/json"},
            )
            assert resp.status_code == 413
        finally:
            reset_precomputed_storage()
            get_settings.cache_clear()


class TestCorruptEntries:
    def test_unreadable_entry_reports_502_not_a_blank_graph(
        self, client, store, context, tmp_path
    ):
        """A volume overwrite is not atomic, so a reader can catch a partial
        object. That must say so, not render an empty canvas."""
        client.put(_url(context.id, "c1"), json=_body(), headers=_headers(SUPERUSER))

        path = tmp_path / "store" / "precomputed" / str(context.id) / "c1.jsonz"
        assert path.is_file()
        path.write_bytes(b"not gzip at all")

        resp = client.get(_url(context.id, "c1"), headers=_headers(OWNER))
        assert resp.status_code == 502
        assert resp.json()["detail"]["error"]["code"] == "PRECOMPUTED_GRAPH_UNREADABLE"


class TestGzipMiddlewareInteraction:
    """The reason the codec is gzip rather than something denser.

    Starlette's GZipMiddleware forwards any body that already declares a
    Content-Encoding, so the read path can hand back the stored bytes untouched.
    If that ever stopped holding, the server would silently start double-encoding
    every cached graph — hence a test against the real middleware.
    """

    @pytest.fixture
    def gzipped_client(self, tmp_path, monkeypatch):
        from starlette.middleware.gzip import GZipMiddleware

        _make_superuser(monkeypatch, SUPERUSER)
        _configure(tmp_path)
        app = FastAPI()
        app.add_middleware(GZipMiddleware, minimum_size=1)
        app.include_router(precomputed_router.router)
        yield TestClient(app)
        reset_precomputed_storage()
        get_settings.cache_clear()

    def test_body_is_not_compressed_twice(self, gzipped_client, store, context):
        gzipped_client.put(
            _url(context.id, "c1"), json=_body(50), headers=_headers(SUPERUSER)
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
            headers={**_headers(SUPERUSER), "Accept-Encoding": "gzip"},
        )
        assert resp.status_code == 200
        assert resp.json()["name"] == "c1"


class TestStorageLayout:
    def test_files_land_where_the_spec_says(self, client, store, context, tmp_path):
        client.put(
            _url(context.id, "fraude-2024"), json=_body(), headers=_headers(SUPERUSER)
        )
        expected = tmp_path / "store" / "precomputed" / str(context.id) / "fraude-2024.jsonz"
        assert expected.is_file()

    def test_stored_file_is_gzip_json(self, client, store, context, tmp_path):
        client.put(_url(context.id, "c1"), json=_body(), headers=_headers(SUPERUSER))
        raw = (tmp_path / "store" / "precomputed" / str(context.id) / "c1.jsonz").read_bytes()
        assert raw[:2] == b"\x1f\x8b"
        assert orjson.loads(gzip.decompress(raw))["name"] == "c1"


class TestVolumeProviderSelection:
    def test_local_backend_without_a_volume_path(self, tmp_path):
        from graphlagoon.services.blob_storage import LocalBlobStore
        from graphlagoon.services.precomputed import default_store

        _configure(tmp_path)
        try:
            assert isinstance(default_store(), LocalBlobStore)
        finally:
            reset_precomputed_storage()

    def test_databricks_backend_when_a_volume_path_is_set(self, tmp_path):
        from graphlagoon.services.blob_storage import DatabricksBlobStore
        from graphlagoon.services.precomputed import default_store

        settings = Settings(
            precomputed_graphs_dir=str(tmp_path),
            precomputed_graphs_volume_path="/Volumes/main/default/vol/precomputed",
            databricks_host="adb-test.azuredatabricks.net",
            databricks_token="dapi-xxx",
        )
        reset_precomputed_storage()
        configure_precomputed_storage(settings)
        try:
            assert isinstance(default_store(), DatabricksBlobStore)
        finally:
            reset_precomputed_storage()

    def test_snapshot_volume_supplies_a_default_subdirectory(self, tmp_path):
        """An existing Databricks deployment gets a correct location without a
        second environment variable."""
        settings = Settings(
            databricks_volume_path="/Volumes/main/default/vol/explorations",
        )
        assert (
            settings.precomputed_graphs_volume_path_effective
            == "/Volumes/main/default/vol/explorations/precomputed-graphs"
        )

    def test_explicit_volume_wins(self, tmp_path):
        settings = Settings(
            databricks_volume_path="/Volumes/a/b/c",
            precomputed_graphs_volume_path="/Volumes/x/y/z",
        )
        assert settings.precomputed_graphs_volume_path_effective == "/Volumes/x/y/z"

    def test_no_volume_means_no_effective_path(self):
        assert Settings().precomputed_graphs_volume_path_effective is None

    def test_missing_host_is_a_clear_error(self, tmp_path):
        from graphlagoon.services.precomputed import default_store

        settings = Settings(
            precomputed_graphs_volume_path="/Volumes/main/default/vol/precomputed",
            databricks_token="dapi-xxx",
        )
        reset_precomputed_storage()
        configure_precomputed_storage(settings)
        try:
            with pytest.raises(ValueError, match="DATABRICKS_HOST"):
                default_store()
        finally:
            reset_precomputed_storage()

    def test_an_explicit_store_bypasses_settings_entirely(self, tmp_path):
        """A provider given a store never consults configuration — which is what
        lets one deployment serve two different volumes."""
        from graphlagoon.services.blob_storage import LocalBlobStore
        from graphlagoon.services.precomputed import uses_default_store

        reset_precomputed_storage()
        clear_precomputed_graph_registry()
        configure_precomputed_storage(Settings())
        register_precomputed_graph_provider(
            volume_provider(store=LocalBlobStore(str(tmp_path / "explicit")))
        )
        try:
            # The startup directory prep must not fire for a provider that does
            # not use the settings-built store.
            assert uses_default_store() is False
        finally:
            reset_precomputed_storage()
            clear_precomputed_graph_registry()


class TestDisabled:
    def test_every_endpoint_reports_disabled_before_any_authz_check(
        self, tmp_path, store, context
    ):
        """precomputed_graphs_enabled gates the whole feature — even for a
        caller who would otherwise be forbidden, disabled wins, so the 404 here
        says nothing about who OWNER is."""
        _configure(tmp_path, precomputed_graphs_enabled=False)
        app = FastAPI()
        app.include_router(precomputed_router.router)
        client = TestClient(app)
        try:
            for resp in (
                client.get(_url(context.id, "c1"), headers=_headers(OWNER)),
                client.put(_url(context.id, "c1"), json=_body(), headers=_headers(OWNER)),
                client.delete(_url(context.id, "c1"), headers=_headers(OWNER)),
            ):
                assert resp.status_code == 404
                assert resp.json()["detail"]["error"]["code"] == "PRECOMPUTED_GRAPHS_DISABLED"
        finally:
            reset_precomputed_storage()

    def test_enabled_flag_is_independent_of_who_may_write(self, tmp_path):
        """Three independent axes, and none of them collapses into another.

        `precomputed_graphs_enabled` is the feature toggle; superuser status is
        a per-request authorization check; and whether the resolving provider
        declares `save` is a capability. There used to be a single
        graph_cache_writable() combining enabled+dev_mode, and conflating them
        is exactly what this pins against.
        """
        from graphlagoon.services.precomputed import precomputed_graphs_enabled

        _configure(tmp_path, precomputed_graphs_enabled=True)
        assert precomputed_graphs_enabled() is True
        assert volume_provider().capabilities()["write"] is True
        assert volume_provider(writable=False).capabilities()["write"] is False

        _configure(tmp_path, precomputed_graphs_enabled=False)
        assert precomputed_graphs_enabled() is False


class TestContextDeletionCascade:
    def test_deleting_a_context_purges_its_graphs(
        self, client, store, context, tmp_path
    ):
        import asyncio

        from graphlagoon.routers.graph_contexts import _purge_precomputed_graphs

        client.put(_url(context.id, "c1"), json=_body(), headers=_headers(SUPERUSER))
        directory = tmp_path / "store" / "precomputed" / str(context.id)
        assert directory.is_dir()

        asyncio.run(_purge_precomputed_graphs(context.id))
        assert not directory.exists()

    def test_purge_never_raises_for_a_context_with_nothing_stored(self, client, store):
        import asyncio

        from graphlagoon.routers.graph_contexts import _purge_precomputed_graphs

        asyncio.run(_purge_precomputed_graphs(uuid4()))

    def test_purge_visits_every_provider_not_just_the_first(self, tmp_path):
        """A context's graphs can live in several backends, so purge fans out.

        This is the one traversal that is deliberately *not* first-match — a
        read stops at the first answer, a purge must not.
        """
        import asyncio

        from graphlagoon.routers.graph_contexts import _purge_precomputed_graphs
        from graphlagoon.services.precomputed import (
            PrecomputedGraphProvider,
        )

        visited = []

        def _recorder(tag):
            async def _delete_context(context_id):
                visited.append(tag)

            return _delete_context

        async def _never(request):
            return None

        _configure(tmp_path)
        clear_precomputed_graph_registry()
        for tag in ("first", "second", "third"):
            register_precomputed_graph_provider(
                PrecomputedGraphProvider(
                    name=tag,
                    resolve=_never,
                    delete_context=_recorder(tag),
                )
            )
        try:
            asyncio.run(_purge_precomputed_graphs(uuid4()))
            assert visited == ["first", "second", "third"]
        finally:
            reset_precomputed_storage()
            clear_precomputed_graph_registry()

    def test_one_provider_failing_to_purge_does_not_stop_the_others(self, tmp_path):
        import asyncio

        from graphlagoon.routers.graph_contexts import _purge_precomputed_graphs
        from graphlagoon.services.precomputed import PrecomputedGraphProvider

        visited = []

        async def _boom(context_id):
            raise RuntimeError("volume unreachable")

        async def _ok(context_id):
            visited.append("ok")

        async def _never(request):
            return None

        _configure(tmp_path)
        clear_precomputed_graph_registry()
        register_precomputed_graph_provider(
            PrecomputedGraphProvider(name="broken", resolve=_never, delete_context=_boom)
        )
        register_precomputed_graph_provider(
            PrecomputedGraphProvider(name="healthy", resolve=_never, delete_context=_ok)
        )
        try:
            asyncio.run(_purge_precomputed_graphs(uuid4()))
            assert visited == ["ok"]
        finally:
            reset_precomputed_storage()
            clear_precomputed_graph_registry()


class TestSourceContract:
    """`source` describes provenance, and a graph need not have any.

    A batch job that assembles a graph from Delta tables never ran a query, so
    every field must be omittable and the entry must still round-trip.
    """

    def test_a_write_may_omit_source_entirely(self, client, context):
        body = _body()
        body.pop("source", None)

        response = client.put(
            _url(context.id, "no-source"), json=body, headers=_headers(SUPERUSER)
        )
        assert response.status_code == 200

        # httpx decodes Content-Encoding transparently, so .content is plain JSON.
        stored = orjson.loads(
            client.get(_url(context.id, "no-source"), headers=_headers(SUPERUSER)).content
        )
        assert stored["source"] == {"kind": "manual", "query": None}

    def test_a_manual_kind_survives_the_round_trip(self, client, context):
        body = _body()
        body["source"] = {"kind": "manual"}

        client.put(
            _url(context.id, "manual"), json=body, headers=_headers(SUPERUSER)
        )
        # httpx decodes Content-Encoding transparently, so .content is plain JSON.
        stored = orjson.loads(
            client.get(_url(context.id, "manual"), headers=_headers(SUPERUSER)).content
        )
        assert stored["source"]["kind"] == "manual"
        assert stored["source"]["query"] is None

    def test_unknown_keys_inside_source_are_ignored_not_fatal(self, client, context):
        """Pydantic's default is to ignore unknown keys, and this pins it.

        `datasource_type`/`datasource_name` used to live in `source` and were
        removed. A future `extra="forbid"` would make every entry carrying a
        field this version has not heard of unreadable — a decision worth
        making deliberately rather than by editing a model_config.
        """
        from graphlagoon.services.precomputed import decode_payload

        payload = {
            "payload_version": 1,
            "name": "extra-keys",
            "context_id": str(context.id),
            "provider": "volume",
            "params": {},
            "created_at": "2026-01-01T00:00:00Z",
            "created_by": "someone@example.com",
            "node_count": 0,
            "edge_count": 0,
            "properties_complete": True,
            "source": {
                "kind": "cypher",
                "query": "MATCH (n) RETURN n",
                "datasource_type": "databricks",
                "datasource_name": "prod",
            },
            "graph": {"nodes": [], "edges": [], "truncated": False},
        }

        decoded = decode_payload(gzip.compress(orjson.dumps(payload)), "extra-keys")

        assert decoded.source.kind == "cypher"
        assert decoded.source.query == "MATCH (n) RETURN n"
        assert not hasattr(decoded.source, "datasource_type")


class TestProvenance:
    """`provider` and `params` say who produced a graph and with what.

    This is the difference from the old cache, where a name was the whole
    identity: a graph computed on demand from URL arguments needs to record the
    arguments, or a stored copy cannot be told apart from any other.
    """

    def test_a_write_records_the_resolving_provider(self, client, context):
        client.put(_url(context.id, "p1"), json=_body(), headers=_headers(SUPERUSER))
        stored = orjson.loads(
            client.get(_url(context.id, "p1"), headers=_headers(SUPERUSER)).content
        )
        assert stored["provider"] == "volume"
        assert stored["payload_version"] == 1

    def test_a_provider_with_no_declared_params_stores_an_empty_dict(
        self, client, context
    ):
        client.put(_url(context.id, "p2"), json=_body(), headers=_headers(SUPERUSER))
        stored = orjson.loads(
            client.get(_url(context.id, "p2"), headers=_headers(SUPERUSER)).content
        )
        assert stored["params"] == {}
