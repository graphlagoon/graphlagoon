"""Tests for LocalSnapshotService (services/snapshot.py).

Technical debt #25: the temp file used for atomic writes was derived from the
target path (``{eid}.json.gz`` → ``{eid}.json.tmp``), so two concurrent saves
of the same exploration shared one temp file — their writes interleaved and
the rename published a corrupt blob. The fix gives every write a unique
``.tmp-{hex}`` name (mirroring LocalBlobStore). These tests pin integrity
under concurrency and cleanup of temp files.
"""

import asyncio
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

from graphlagoon.services.snapshot import LocalSnapshotService  # noqa: E402


@pytest.fixture
def service(tmp_path):
    return LocalSnapshotService(str(tmp_path))


def test_save_load_roundtrip(service, tmp_path):
    eid = uuid4()
    payload = b"snapshot-bytes"

    asyncio.run(service.save(eid, payload))

    assert asyncio.run(service.load(eid)) == payload
    assert asyncio.run(service.exists(eid)) is True


def test_concurrent_saves_of_same_exploration_never_corrupt(service):
    """Each save publishes a complete payload; the winner is one of them.

    With the old shared temp file ({eid}.json.tmp), interleaved writes could
    publish a blob that matches no writer's payload.
    """
    eid = uuid4()
    payloads = [bytes([i]) * 4096 for i in range(20)]

    async def run():
        await asyncio.gather(
            *(service.save(eid, p) for p in payloads)
        )

    asyncio.run(run())

    final = asyncio.run(service.load(eid))
    assert final in payloads


def test_no_temp_files_left_behind(service, tmp_path):
    eid = uuid4()

    async def run():
        await asyncio.gather(*(service.save(eid, b"x" * 100) for _ in range(10)))

    asyncio.run(run())

    leftovers = [p.name for p in tmp_path.iterdir() if p.name != f"{eid}.json.gz"]
    assert leftovers == []


def test_failed_write_cleans_up_temp_file(service, tmp_path, monkeypatch):
    from pathlib import Path

    def boom(self, data):
        raise OSError("disk full")

    monkeypatch.setattr(Path, "write_bytes", boom)

    with pytest.raises(OSError):
        asyncio.run(service.save(uuid4(), b"data"))

    assert list(tmp_path.iterdir()) == []
