"""Case storage (FA.2): streamed upload with sha256, local and Databricks, no overwrite."""

import asyncio
import hashlib
import tracemalloc

import httpx
import pytest

from graphlagoon.config import Settings
from graphlagoon.services import investigation_storage as storage
from graphlagoon.services.blob_storage import DatabricksBlobStore, LocalBlobStore


def run(coro):
    return asyncio.run(coro)


async def _gen(chunk: bytes, count: int):
    for _ in range(count):
        yield chunk


def test_receive_streams_without_holding_the_upload(tmp_path):
    chunk = b"x" * storage.CHUNK_BYTES
    tracemalloc.start()
    try:
        received = run(storage.receive(_gen(chunk, 64), max_bytes=1 << 30))
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
    try:
        assert received.size_bytes == 64 * len(chunk)
        assert received.sha256 == hashlib.sha256(chunk * 64).hexdigest()
        assert peak < 8 * len(chunk)  # 64 MiB went through, a few chunks at most held
    finally:
        received.discard()


def test_receive_enforces_the_limit_and_leaves_no_temp(tmp_path, monkeypatch):
    monkeypatch.setattr(storage.tempfile, "tempdir", str(tmp_path))
    with pytest.raises(storage.TooLarge):
        run(storage.receive(_gen(b"abc", 10), max_bytes=20))
    assert list(tmp_path.iterdir()) == []


def test_local_put_moves_the_file_and_never_overwrites(tmp_path, monkeypatch):
    monkeypatch.setattr(storage, "_store", LocalBlobStore(str(tmp_path / "root")))
    key = "inv/artifacts/a/v1/report.md"
    first = run(storage.receive(_gen(b"v1", 1), 100))
    run(storage.put(key, first))
    assert run(storage.load(key)) == b"v1"

    second = run(storage.receive(_gen(b"v2", 1), 100))
    with pytest.raises(FileExistsError):
        run(storage.put(key, second))
    assert run(storage.load(key)) == b"v1"


def test_store_root_follows_the_settings(tmp_path):
    storage.configure_investigation_storage(
        Settings(exploration_snapshots_dir=str(tmp_path))
    )
    try:
        store = storage.get_store()
        assert isinstance(store, LocalBlobStore)
        assert store._base == (tmp_path / "investigations").resolve()

        storage.configure_investigation_storage(
            Settings(
                databricks_volume_path="/Volumes/c/s/v",
                databricks_host="adb.example.net",
                databricks_token="tok",
            )
        )
        store = storage.get_store()
        assert isinstance(store, DatabricksBlobStore)
        assert store._root == "/Volumes/c/s/v/investigations"
    finally:
        storage.configure_investigation_storage(None)


def test_databricks_put_streams_with_overwrite_false(monkeypatch):
    stored: dict[str, bytes] = {}
    seen = {}

    def handler(request: httpx.Request):
        if "/fs/directories/" in request.url.path:
            return httpx.Response(200)
        path = request.url.path
        seen["overwrite"] = request.url.params.get("overwrite")
        seen["length"] = request.headers.get("Content-Length")
        if path in stored:
            return httpx.Response(409)
        stored[path] = request.read()
        return httpx.Response(200)

    store = DatabricksBlobStore(
        base_url="https://adb.example.net",
        root_path="/Volumes/c/s/v/investigations",
        header_provider=lambda: "tok",
    )
    store._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    monkeypatch.setattr(storage, "_store", store)

    key = "inv/artifacts/a/v1/deck.pptx"
    run(storage.put(key, run(storage.receive(_gen(b"slide", 3), 100))))
    url = "/api/2.0/fs/files/Volumes/c/s/v/investigations/" + key
    assert stored[url] == b"slideslideslide"
    assert seen == {"overwrite": "false", "length": "15"}

    with pytest.raises(FileExistsError):
        run(storage.put(key, run(storage.receive(_gen(b"other", 1), 100))))
    assert stored[url] == b"slideslideslide"
