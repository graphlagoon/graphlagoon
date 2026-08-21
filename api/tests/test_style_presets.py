"""Tests for named style presets.

The interesting part is authorization, which has one more level than anything
else in this codebase: read needs context access, write needs context *write*
access, and delete needs to be the person who created that particular preset.
"""

import sys
from uuid import uuid4

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
from graphlagoon.routers import style_presets as presets_router  # noqa: E402
from graphlagoon.services.style_presets import (  # noqa: E402
    configure_style_preset_service,
    reset_style_preset_service,
)

OWNER = "owner@example.com"
WRITER = "writer@example.com"
READER = "reader@example.com"
STRANGER = "stranger@example.com"
SUPERUSER = "admin@example.com"


def _headers(email):
    return {"X-Forwarded-Email": email}


def _settings_payload(**overrides):
    payload = {
        "aesthetics": {"nodeSize": 6, "linkWidth": 2},
        "nodeTypeColors": {"Account": "#ff0000", "Device": "#00ff00"},
        "edgeTypeColors": {"SENT": "#0000ff"},
        "textFormat": {"rules": [], "defaults": {"nodeTemplate": "{name}"}},
        "layout_algorithm": "force",
        "layout_mode_config": {"force": {"charge": -120}},
        "force3d_settings": {"dagMode": None},
    }
    payload.update(overrides)
    return payload


def _body(**overrides):
    return {"settings": _settings_payload(), "description": "Fraud review look", **overrides}


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
    settings = Settings(
        style_presets_dir=str(tmp_path / "presets"),
        databricks_volume_path=None,
        style_presets_volume_path=None,
        **overrides,
    )
    reset_style_preset_service()
    configure_style_preset_service(settings)
    return settings


@pytest.fixture
def client(tmp_path):
    _configure(tmp_path)
    app = FastAPI()
    app.include_router(presets_router.router)
    yield TestClient(app)
    reset_style_preset_service()


def _url(context_id, name=None):
    base = f"/api/graph-contexts/{context_id}/style-presets"
    return base if name is None else f"{base}/{name}"


class TestRoundTrip:
    def test_put_then_get(self, client, store, context):
        resp = client.put(
            _url(context.id, "investigacao"), json=_body(), headers=_headers(OWNER)
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["created_by"] == OWNER

        resp = client.get(_url(context.id, "investigacao"), headers=_headers(OWNER))
        assert resp.status_code == 200
        preset = resp.json()
        assert preset["name"] == "investigacao"
        assert preset["description"] == "Fraud review look"
        assert preset["settings"]["nodeTypeColors"]["Account"] == "#ff0000"
        assert preset["settings"]["layout_algorithm"] == "force"
        assert preset["settings"]["textFormat"]["defaults"]["nodeTemplate"] == "{name}"

    def test_list_is_sorted_and_case_insensitive(self, client, store, context):
        for name in ("zulu", "Alpha", "mike"):
            client.put(_url(context.id, name), json=_body(), headers=_headers(OWNER))

        resp = client.get(_url(context.id), headers=_headers(OWNER))
        assert resp.status_code == 200
        assert [p["name"] for p in resp.json()["presets"]] == ["Alpha", "mike", "zulu"]

    def test_list_is_empty_for_a_fresh_context(self, client, store, context):
        resp = client.get(_url(context.id), headers=_headers(OWNER))
        assert resp.status_code == 200
        assert resp.json() == {"presets": []}

    def test_listing_does_not_report_owners(self, client, store, context):
        """Ownership lives inside each file; reporting it here would cost one
        request per preset. Delete checks it server-side instead."""
        client.put(_url(context.id, "p1"), json=_body(), headers=_headers(OWNER))

        entry = client.get(_url(context.id), headers=_headers(OWNER)).json()["presets"][0]
        assert set(entry) == {"name", "size_bytes", "modified_at"}

    def test_missing_preset_is_404(self, client, store, context):
        resp = client.get(_url(context.id, "nao-existe"), headers=_headers(OWNER))
        assert resp.status_code == 404
        assert resp.json()["detail"]["error"]["code"] == "STYLE_PRESET_NOT_FOUND"

    def test_delete_removes_it(self, client, store, context):
        client.put(_url(context.id, "p1"), json=_body(), headers=_headers(OWNER))

        assert (
            client.delete(_url(context.id, "p1"), headers=_headers(OWNER)).status_code
            == 204
        )
        assert client.get(_url(context.id), headers=_headers(OWNER)).json() == {
            "presets": []
        }

    def test_unknown_settings_keys_survive_a_round_trip(self, client, store, context):
        """The frontend owns these shapes. A field it adds must not need a
        backend change to be storable."""
        client.put(
            _url(context.id, "p1"),
            json={"settings": _settings_payload(someFutureKnob={"a": 1})},
            headers=_headers(OWNER),
        )

        preset = client.get(_url(context.id, "p1"), headers=_headers(OWNER)).json()
        assert preset["settings"]["someFutureKnob"] == {"a": 1}


class TestOwnership:
    def test_creator_can_delete_their_own(self, client, store, context):
        client.put(_url(context.id, "p1"), json=_body(), headers=_headers(WRITER))
        assert (
            client.delete(_url(context.id, "p1"), headers=_headers(WRITER)).status_code
            == 204
        )

    def test_another_writer_cannot_delete_it(self, client, store, context):
        client.put(_url(context.id, "p1"), json=_body(), headers=_headers(WRITER))

        resp = client.delete(_url(context.id, "p1"), headers=_headers(OWNER))
        assert resp.status_code == 403
        assert resp.json()["detail"]["error"]["details"]["created_by"] == WRITER
        # ...and it survives.
        assert (
            client.get(_url(context.id, "p1"), headers=_headers(OWNER)).status_code
            == 200
        )

    def test_context_owner_is_not_special(self, client, store, context):
        """Deliberate: ownership is per preset, so one person's saved look cannot
        be thrown away by another — not even by whoever owns the context."""
        client.put(_url(context.id, "p1"), json=_body(), headers=_headers(WRITER))
        assert (
            client.delete(_url(context.id, "p1"), headers=_headers(OWNER)).status_code
            == 403
        )

    def test_superuser_can_delete_anyones(self, client, store, context, monkeypatch):
        monkeypatch.setenv("GRAPH_LAGOON_SUPERUSER_EMAILS", SUPERUSER)
        get_settings.cache_clear()
        try:
            client.put(_url(context.id, "p1"), json=_body(), headers=_headers(WRITER))
            assert (
                client.delete(
                    _url(context.id, "p1"), headers=_headers(SUPERUSER)
                ).status_code
                == 204
            )
        finally:
            get_settings.cache_clear()

    def test_overwriting_keeps_the_original_author(self, client, store, context):
        """A preset is a named slot. If overwriting reassigned ownership, anyone
        with write access could take over someone else's preset and delete it."""
        client.put(_url(context.id, "p1"), json=_body(), headers=_headers(WRITER))
        resp = client.put(_url(context.id, "p1"), json=_body(), headers=_headers(OWNER))

        assert resp.status_code == 200
        assert resp.json()["created_by"] == WRITER
        assert resp.json()["updated_at"] is not None
        assert (
            client.delete(_url(context.id, "p1"), headers=_headers(OWNER)).status_code
            == 403
        )

    def test_deleting_a_missing_preset_succeeds(self, client, store, context):
        """Nothing to own, nothing to protect — and it keeps delete idempotent."""
        assert (
            client.delete(
                _url(context.id, "never-existed"), headers=_headers(OWNER)
            ).status_code
            == 204
        )


class TestContextAuthorization:
    def test_reader_can_read_but_not_write(self, client, store, context):
        client.put(_url(context.id, "p1"), json=_body(), headers=_headers(OWNER))

        assert (
            client.get(_url(context.id, "p1"), headers=_headers(READER)).status_code
            == 200
        )
        assert client.get(_url(context.id), headers=_headers(READER)).status_code == 200

        resp = client.put(_url(context.id, "p2"), json=_body(), headers=_headers(READER))
        assert resp.status_code == 403
        assert "write access" in resp.json()["detail"]["error"]["message"]

    def test_writer_can_write(self, client, store, context):
        assert (
            client.put(
                _url(context.id, "p1"), json=_body(), headers=_headers(WRITER)
            ).status_code
            == 200
        )

    def test_stranger_is_locked_out_entirely(self, client, store, context):
        client.put(_url(context.id, "p1"), json=_body(), headers=_headers(OWNER))

        for resp in (
            client.get(_url(context.id), headers=_headers(STRANGER)),
            client.get(_url(context.id, "p1"), headers=_headers(STRANGER)),
            client.put(_url(context.id, "p2"), json=_body(), headers=_headers(STRANGER)),
            client.delete(_url(context.id, "p1"), headers=_headers(STRANGER)),
        ):
            assert resp.status_code == 403

    def test_unknown_context_is_404(self, client, store):
        assert (
            client.get(_url(uuid4(), "p1"), headers=_headers(OWNER)).status_code == 404
        )


class TestIsolation:
    def test_presets_are_scoped_to_their_context(self, client, store, context):
        other = store.create_graph_context(
            title="other", edge_table_name="e", node_table_name="n", owner_email=OWNER
        )
        client.put(_url(context.id, "shared-name"), json=_body(), headers=_headers(OWNER))

        assert (
            client.get(_url(other.id, "shared-name"), headers=_headers(OWNER)).status_code
            == 404
        )
        assert client.get(_url(other.id), headers=_headers(OWNER)).json() == {
            "presets": []
        }


class TestNameValidation:
    @pytest.mark.parametrize(
        "name", ["_index", ".hidden", "-leading", "a" * 65, "nome%20invalido"]
    )
    def test_rejects_unsafe_names(self, client, store, context, name):
        resp = client.get(_url(context.id, name), headers=_headers(OWNER))
        assert resp.status_code == 400
        assert resp.json()["detail"]["error"]["code"] == "INVALID_PRESET_NAME"

    @pytest.mark.parametrize("name", ["a%2Fb", "..%2F..%2Fetc%2Fpasswd"])
    def test_encoded_separators_never_reach_storage(self, client, store, context, name):
        """`%2F` is decoded before routing, so the path stops matching any route.
        It 404s rather than 400s — the handler is never entered, which is the
        safe outcome either way."""
        resp = client.get(_url(context.id, name), headers=_headers(OWNER))
        assert resp.status_code in (400, 404)
        assert "passwd" not in resp.text

    @pytest.mark.parametrize("name", ["a", "investigacao-2026", "v1.2_final"])
    def test_accepts_reasonable_names(self, client, store, context, name):
        assert (
            client.put(
                _url(context.id, name), json=_body(), headers=_headers(OWNER)
            ).status_code
            == 200
        )


class TestLimits:
    def test_per_context_count_is_capped(self, tmp_path, store, context):
        """Presets stay listable by being bounded at write time. Paginating the
        read instead is what the graph cache had to refuse outright."""
        _configure(tmp_path, style_presets_max_per_context=3)
        app = FastAPI()
        app.include_router(presets_router.router)
        client = TestClient(app)
        try:
            for i in range(3):
                assert (
                    client.put(
                        _url(context.id, f"p{i}"), json=_body(), headers=_headers(OWNER)
                    ).status_code
                    == 200
                )

            resp = client.put(
                _url(context.id, "p4"), json=_body(), headers=_headers(OWNER)
            )
            assert resp.status_code == 409
            assert resp.json()["detail"]["error"]["code"] == "TOO_MANY_PRESETS"

            # Overwriting an existing one is still allowed at the cap.
            assert (
                client.put(
                    _url(context.id, "p0"), json=_body(), headers=_headers(OWNER)
                ).status_code
                == 200
            )
        finally:
            reset_style_preset_service()

    def test_oversized_preset_is_rejected(self, client, store, context, monkeypatch):
        import graphlagoon.services.style_presets as svc

        monkeypatch.setattr(svc, "MAX_PRESET_BYTES", 64)
        resp = client.put(
            _url(context.id, "big"),
            json={"settings": _settings_payload(blob={"k": "x" * 100_000})},
            headers=_headers(OWNER),
        )
        assert resp.status_code == 413
        assert resp.json()["detail"]["error"]["code"] == "PRESET_TOO_LARGE"

    def test_description_length_is_bounded(self, client, store, context):
        resp = client.put(
            _url(context.id, "p1"),
            json={"settings": _settings_payload(), "description": "x" * 400},
            headers=_headers(OWNER),
        )
        assert resp.status_code == 422


class TestStorageLayout:
    def test_files_land_under_a_style_prefix(self, client, store, context, tmp_path):
        client.put(_url(context.id, "investigacao"), json=_body(), headers=_headers(OWNER))
        expected = (
            tmp_path / "presets" / "style" / str(context.id) / "investigacao.jsonz"
        )
        assert expected.is_file()

    def test_corrupt_preset_reports_502(self, client, store, context, tmp_path):
        client.put(_url(context.id, "p1"), json=_body(), headers=_headers(OWNER))
        (tmp_path / "presets" / "style" / str(context.id) / "p1.jsonz").write_bytes(
            b"not gzip"
        )

        resp = client.get(_url(context.id, "p1"), headers=_headers(OWNER))
        assert resp.status_code == 502
        assert resp.json()["detail"]["error"]["code"] == "PRESET_UNREADABLE"

    def test_only_a_superuser_can_clear_a_corrupt_preset(
        self, client, store, context, tmp_path, monkeypatch
    ):
        """An unreadable preset has no discoverable owner. Refusing outright
        would strand it on the volume forever."""
        client.put(_url(context.id, "p1"), json=_body(), headers=_headers(OWNER))
        path = tmp_path / "presets" / "style" / str(context.id) / "p1.jsonz"
        path.write_bytes(b"not gzip")

        assert (
            client.delete(_url(context.id, "p1"), headers=_headers(OWNER)).status_code
            == 403
        )

        monkeypatch.setenv("GRAPH_LAGOON_SUPERUSER_EMAILS", SUPERUSER)
        get_settings.cache_clear()
        try:
            assert (
                client.delete(
                    _url(context.id, "p1"), headers=_headers(SUPERUSER)
                ).status_code
                == 204
            )
            assert not path.exists()
        finally:
            get_settings.cache_clear()


class TestServiceSelection:
    def test_local_backend_without_a_volume(self, tmp_path):
        from graphlagoon.services.blob_storage import LocalBlobStore
        from graphlagoon.services.style_presets import get_style_preset_service

        _configure(tmp_path)
        try:
            assert isinstance(get_style_preset_service()._store, LocalBlobStore)
        finally:
            reset_style_preset_service()

    def test_snapshot_volume_supplies_a_default_subdirectory(self):
        settings = Settings(databricks_volume_path="/Volumes/main/default/vol")
        assert (
            settings.style_presets_volume_path_effective
            == "/Volumes/main/default/vol/style-presets"
        )

    def test_presets_and_caches_do_not_share_a_directory(self):
        settings = Settings(databricks_volume_path="/Volumes/main/default/vol")
        assert (
            settings.style_presets_volume_path_effective
            != settings.graph_cache_volume_path_effective
        )

    def test_disabled_reports_disabled(self, tmp_path, store, context):
        _configure(tmp_path, style_presets_enabled=False)
        app = FastAPI()
        app.include_router(presets_router.router)
        client = TestClient(app)
        try:
            resp = client.get(_url(context.id), headers=_headers(OWNER))
            assert resp.status_code == 404
            assert resp.json()["detail"]["error"]["code"] == "STYLE_PRESETS_DISABLED"
        finally:
            reset_style_preset_service()


class TestContextDeletionCascade:
    def test_deleting_a_context_purges_its_presets(
        self, client, store, context, tmp_path
    ):
        import asyncio

        from graphlagoon.routers.graph_contexts import _purge_style_presets

        client.put(_url(context.id, "p1"), json=_body(), headers=_headers(OWNER))
        directory = tmp_path / "presets" / "style" / str(context.id)
        assert directory.is_dir()

        asyncio.run(_purge_style_presets(context.id))
        assert not directory.exists()
