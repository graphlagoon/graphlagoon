"""Tests for services/blob_storage.py — key safety, local backend, Databricks backend."""

import asyncio

import httpx
import pytest

from graphlagoon.services.blob_storage import (
    BlobInfo,
    DatabricksBlobStore,
    InvalidBlobKey,
    LocalBlobStore,
    normalize_key,
    normalize_prefix,
)


class TestNormalizeKey:
    @pytest.mark.parametrize(
        "key",
        [
            "../secrets",
            "a/../../b",
            "cache/../../etc/passwd",
            "/etc/passwd",
            "a//b",
            "a/./b",
            "a\\b",
            "",
            "\x00",
            "trailing/",
        ],
    )
    def test_rejects_unsafe_keys(self, key):
        with pytest.raises(InvalidBlobKey):
            normalize_key(key)

    @pytest.mark.parametrize(
        "key", ["a", "a/b", "ctx/name.jsonz", "a/b/c/d.jsonz", "dot.name"]
    )
    def test_accepts_relative_keys(self, key):
        assert normalize_key(key) == key

    def test_non_string_is_rejected(self):
        with pytest.raises(InvalidBlobKey):
            normalize_key(None)

    def test_prefix_tolerates_surrounding_slashes(self):
        assert normalize_prefix("/cache/ctx/") == "cache/ctx"
        assert normalize_prefix("/") == ""
        assert normalize_prefix("") == ""

    def test_prefix_still_rejects_traversal(self):
        with pytest.raises(InvalidBlobKey):
            normalize_prefix("/cache/../../etc")


@pytest.fixture
def store(tmp_path):
    return LocalBlobStore(str(tmp_path / "root"))


def run(coro):
    return asyncio.run(coro)


class TestLocalBlobStore:
    def test_round_trip(self, store):
        run(store.save("ctx/a.jsonz", b"hello"))
        assert run(store.load("ctx/a.jsonz")) == b"hello"

    def test_creates_nested_parents(self, store, tmp_path):
        run(store.save("a/b/c/d.jsonz", b"x"))
        assert (tmp_path / "root" / "a" / "b" / "c" / "d.jsonz").is_file()

    def test_missing_key_loads_as_none(self, store):
        assert run(store.load("ctx/nope.jsonz")) is None

    def test_exists(self, store):
        assert run(store.exists("ctx/a.jsonz")) is False
        run(store.save("ctx/a.jsonz", b"x"))
        assert run(store.exists("ctx/a.jsonz")) is True

    def test_delete_is_idempotent(self, store):
        run(store.save("ctx/a.jsonz", b"x"))
        run(store.delete("ctx/a.jsonz"))
        run(store.delete("ctx/a.jsonz"))  # must not raise
        assert run(store.load("ctx/a.jsonz")) is None

    def test_overwrite_replaces_content(self, store):
        run(store.save("ctx/a.jsonz", b"first"))
        run(store.save("ctx/a.jsonz", b"second"))
        assert run(store.load("ctx/a.jsonz")) == b"second"

    def test_traversal_is_rejected_at_every_entry_point(self, store):
        for call in (
            store.save("../escape", b"x"),
            store.load("../escape"),
            store.delete("../escape"),
            store.exists("../escape"),
        ):
            with pytest.raises(InvalidBlobKey):
                run(call)

    def test_symlink_escape_is_rejected(self, store, tmp_path):
        outside = tmp_path / "outside"
        outside.mkdir()
        (tmp_path / "root" / "link").symlink_to(outside, target_is_directory=True)
        with pytest.raises(InvalidBlobKey):
            run(store.save("link/pwned.jsonz", b"x"))


class TestLocalListing:
    def test_lists_only_files_in_the_prefix(self, store):
        run(store.save("ctx/a.jsonz", b"aa"))
        run(store.save("ctx/b.jsonz", b"bbbb"))
        run(store.save("other/c.jsonz", b"c"))

        infos = run(store.list("ctx"))
        assert [i.key for i in infos] == ["ctx/a.jsonz", "ctx/b.jsonz"]
        assert [i.size_bytes for i in infos] == [2, 4]
        assert all(i.modified_at is not None for i in infos)

    def test_missing_prefix_lists_empty(self, store):
        assert run(store.list("never/created")) == []

    def test_subdirectories_are_not_listed_as_blobs(self, store):
        run(store.save("ctx/sub/a.jsonz", b"x"))
        assert run(store.list("ctx")) == []

    def test_temp_files_are_invisible(self, store, tmp_path):
        run(store.save("ctx/a.jsonz", b"x"))
        # Simulate a crashed write leaving its temp behind.
        (tmp_path / "root" / "ctx" / ".tmp-deadbeef").write_bytes(b"partial")
        assert [i.key for i in run(store.list("ctx"))] == ["ctx/a.jsonz"]

    def test_delete_prefix_removes_everything_under_it(self, store):
        run(store.save("ctx/a.jsonz", b"x"))
        run(store.save("ctx/b.jsonz", b"x"))
        run(store.save("other/c.jsonz", b"x"))

        run(store.delete_prefix("ctx"))
        assert run(store.list("ctx")) == []
        assert [i.key for i in run(store.list("other"))] == ["other/c.jsonz"]

    def test_delete_prefix_of_missing_prefix_is_not_an_error(self, store):
        run(store.delete_prefix("never/created"))

    def test_refuses_to_delete_the_root(self, store):
        with pytest.raises(InvalidBlobKey):
            run(store.delete_prefix(""))


class TestLocalConcurrency:
    def test_concurrent_writes_never_publish_a_corrupt_blob(self, store):
        """Regression guard for the temp-name collision in LocalSnapshotService,
        which derives its temp path from the target and so shares one temp file
        between concurrent writers of the same key.
        """
        a = b"A" * 200_000
        b = b"B" * 200_000

        async def race():
            await asyncio.gather(
                *(
                    store.save("ctx/same.jsonz", payload)
                    for payload in (a, b, a, b, a, b)
                )
            )

        run(race())
        assert run(store.load("ctx/same.jsonz")) in (a, b)

    def test_no_temp_files_survive_a_successful_write(self, store, tmp_path):
        run(store.save("ctx/a.jsonz", b"x"))
        leftovers = [
            p.name for p in (tmp_path / "root" / "ctx").iterdir() if p.name.startswith(".tmp-")
        ]
        assert leftovers == []


# ---------------------------------------------------------------------------
# Databricks backend
# ---------------------------------------------------------------------------

HOST = "https://adb-test.azuredatabricks.net"
ROOT = "/Volumes/main/default/vol/graph-cache"


def _databricks_store(handler, header_provider=None):
    store = DatabricksBlobStore(
        base_url=HOST,
        root_path=ROOT,
        header_provider=header_provider or (lambda: "tok"),
    )
    store._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return store


class TestDatabricksAuth:
    def test_bare_token_becomes_a_bearer_header(self):
        seen = {}

        def handler(request):
            seen["auth"] = request.headers.get("Authorization")
            return httpx.Response(200)

        run(_databricks_store(handler).save("ctx/a.jsonz", b"x"))
        assert seen["auth"] == "Bearer tok"

    def test_provider_that_already_prefixes_bearer_is_not_doubled(self):
        seen = {}

        def handler(request):
            seen["auth"] = request.headers.get("Authorization")
            return httpx.Response(200)

        store = _databricks_store(handler, header_provider=lambda: "Bearer tok")
        run(store.save("ctx/a.jsonz", b"x"))
        assert seen["auth"] == "Bearer tok"

    def test_async_provider_is_awaited(self):
        seen = {}

        async def provider():
            return "async-tok"

        def handler(request):
            seen["auth"] = request.headers.get("Authorization")
            return httpx.Response(200)

        run(_databricks_store(handler, header_provider=provider).save("k.jsonz", b"x"))
        assert seen["auth"] == "Bearer async-tok"

    @pytest.mark.parametrize("bad", [lambda: None, lambda: "", lambda: 42])
    def test_unusable_token_raises_runtime_error(self, bad):
        store = _databricks_store(lambda r: httpx.Response(200), header_provider=bad)
        with pytest.raises(RuntimeError, match="Failed to obtain auth token"):
            run(store.load("k.jsonz"))


class TestDatabricksUrls:
    def test_save_targets_the_files_api_with_overwrite(self):
        seen = []

        def handler(request):
            seen.append((request.method, str(request.url)))
            return httpx.Response(200)

        run(_databricks_store(handler).save("ctx-1/name.jsonz", b"payload"))

        methods = [m for m, _ in seen]
        urls = [u for _, u in seen]
        # Directory is created before the file is written.
        assert methods == ["PUT", "PUT"]
        assert urls[0] == f"{HOST}/api/2.0/fs/directories{ROOT}/ctx-1"
        assert urls[1] == (
            f"{HOST}/api/2.0/fs/files{ROOT}/ctx-1/name.jsonz?overwrite=true"
        )

    def test_directory_is_created_only_once_per_process(self):
        seen = []

        def handler(request):
            seen.append(str(request.url))
            return httpx.Response(200)

        store = _databricks_store(handler)
        run(store.save("ctx-1/a.jsonz", b"x"))
        run(store.save("ctx-1/b.jsonz", b"x"))
        assert sum("fs/directories" in u for u in seen) == 1

    def test_existing_directory_conflict_is_treated_as_success(self):
        def handler(request):
            if "fs/directories" in str(request.url):
                return httpx.Response(409, text="already exists")
            return httpx.Response(200)

        run(_databricks_store(handler).save("ctx/a.jsonz", b"x"))

    def test_save_never_deletes_first(self):
        """A delete-then-write would open a guaranteed 404 window for readers."""
        methods = []

        def handler(request):
            methods.append(request.method)
            return httpx.Response(200)

        run(_databricks_store(handler).save("ctx/a.jsonz", b"x"))
        assert "DELETE" not in methods


class TestDatabricksErrorTaxonomy:
    @pytest.mark.parametrize(
        "status,body,expected",
        [
            (401, "", PermissionError),
            (400, "INVALID_TOKEN", PermissionError),
            (403, "", PermissionError),
            (500, "boom", OSError),
            (502, "gateway", OSError),
        ],
    )
    def test_status_maps_to_exception(self, status, body, expected):
        store = _databricks_store(lambda r: httpx.Response(status, text=body))
        with pytest.raises(expected):
            run(store.load("ctx/a.jsonz"))

    def test_missing_file_loads_as_none(self):
        store = _databricks_store(lambda r: httpx.Response(404))
        assert run(store.load("ctx/a.jsonz")) is None

    def test_timeout_becomes_timeout_error(self):
        def handler(request):
            raise httpx.TimeoutException("slow", request=request)

        with pytest.raises(TimeoutError):
            run(_databricks_store(handler).load("ctx/a.jsonz"))

    def test_network_error_becomes_connection_error(self):
        def handler(request):
            raise httpx.ConnectError("down", request=request)

        with pytest.raises(ConnectionError):
            run(_databricks_store(handler).load("ctx/a.jsonz"))

    def test_delete_treats_missing_as_success(self):
        store = _databricks_store(lambda r: httpx.Response(404))
        run(store.delete("ctx/a.jsonz"))


class TestDatabricksListing:
    @staticmethod
    def _listing(entries, next_token=None):
        body = {"contents": entries}
        if next_token:
            body["next_page_token"] = next_token
        return body

    def test_parses_a_standard_listing(self):
        def handler(request):
            return httpx.Response(
                200,
                json=self._listing(
                    [
                        {
                            "path": f"{ROOT}/ctx/a.jsonz",
                            "name": "a.jsonz",
                            "is_directory": False,
                            "file_size": 1234,
                            "last_modified": 1700000000000,
                        }
                    ]
                ),
            )

        infos = run(_databricks_store(handler).list("ctx"))
        assert infos[0].key == "ctx/a.jsonz"
        assert infos[0].size_bytes == 1234
        assert infos[0].modified_at is not None

    def test_missing_directory_lists_empty(self):
        store = _databricks_store(lambda r: httpx.Response(404))
        assert run(store.list("ctx")) == []

    def test_directories_are_skipped(self):
        def handler(request):
            return httpx.Response(
                200,
                json=self._listing(
                    [
                        {"name": "sub", "is_directory": True, "file_size": 0},
                        {"name": "a.jsonz", "is_directory": False, "file_size": 1},
                    ]
                ),
            )

        assert [i.key for i in run(_databricks_store(handler).list("ctx"))] == [
            "ctx/a.jsonz"
        ]

    def test_follows_pagination(self):
        pages = {
            None: self._listing(
                [{"name": "a.jsonz", "file_size": 1}], next_token="page-2"
            ),
            "page-2": self._listing([{"name": "b.jsonz", "file_size": 2}]),
        }

        def handler(request):
            token = request.url.params.get("page_token")
            return httpx.Response(200, json=pages[token])

        infos = run(_databricks_store(handler).list("ctx"))
        assert [i.key for i in infos] == ["ctx/a.jsonz", "ctx/b.jsonz"]

    def test_tolerates_unexpected_field_names(self):
        """A field-name mismatch must degrade to missing metadata, not a 500."""

        def handler(request):
            return httpx.Response(
                200,
                json={
                    "files": [
                        {"path": f"{ROOT}/ctx/a.jsonz", "size": 7},
                        {"path": f"{ROOT}/ctx/b.jsonz"},
                    ]
                },
            )

        infos = run(_databricks_store(handler).list("ctx"))
        assert [(i.key, i.size_bytes) for i in infos] == [
            ("ctx/a.jsonz", 7),
            ("ctx/b.jsonz", 0),
        ]

    def test_exhausting_the_page_cap_raises_instead_of_truncating(self):
        """A short list that looks complete is worse than an error: the only
        caller is delete_prefix, where missing entries mean files orphaned on the
        volume forever."""

        def handler(request):
            # Always another page — the cap is the only thing that stops this.
            return httpx.Response(
                200,
                json={
                    "contents": [{"name": "a.jsonz", "file_size": 1}],
                    "next_page_token": "more",
                },
            )

        with pytest.raises(OSError, match="Refusing to return a truncated listing"):
            run(_databricks_store(handler).list("ctx"))

    def test_non_json_listing_raises_oserror(self):
        store = _databricks_store(lambda r: httpx.Response(200, text="<html>"))
        with pytest.raises(OSError):
            run(store.list("ctx"))


class TestDatabricksDeletePrefix:
    def test_deletes_each_file_then_the_directory(self):
        calls = []

        def handler(request):
            calls.append((request.method, str(request.url)))
            if request.method == "GET":
                return httpx.Response(
                    200,
                    json={"contents": [{"name": "a.jsonz", "file_size": 1}]},
                )
            return httpx.Response(200)

        run(_databricks_store(handler).delete_prefix("ctx"))

        assert (
            "DELETE",
            f"{HOST}/api/2.0/fs/files{ROOT}/ctx/a.jsonz",
        ) in calls
        assert ("DELETE", f"{HOST}/api/2.0/fs/directories{ROOT}/ctx") in calls

    def test_directory_delete_failure_is_swallowed(self):
        """A non-empty or unsupported directory delete must not fail the caller —
        an orphaned empty directory is harmless."""

        def handler(request):
            if request.method == "GET":
                return httpx.Response(200, json={"contents": []})
            if "fs/directories" in str(request.url):
                return httpx.Response(500, text="not supported")
            return httpx.Response(200)

        run(_databricks_store(handler).delete_prefix("ctx"))

    def test_refuses_to_delete_the_root(self):
        store = _databricks_store(lambda r: httpx.Response(200))
        with pytest.raises(InvalidBlobKey):
            run(store.delete_prefix("/"))

    def test_deletes_concurrently(self):
        """The Files API has no bulk delete, so a purge is one request per blob.
        Sequentially, a context with a thousand entries would hold the caller for
        most of a minute."""
        entries = [{"name": f"c{i}.jsonz", "file_size": 1} for i in range(64)]
        in_flight = 0
        peak = 0

        async def handler(request):
            nonlocal in_flight, peak
            if request.method == "GET":
                return httpx.Response(200, json={"contents": entries})
            in_flight += 1
            peak = max(peak, in_flight)
            await asyncio.sleep(0.01)
            in_flight -= 1
            return httpx.Response(200)

        store = DatabricksBlobStore(
            base_url=HOST, root_path=ROOT, header_provider=lambda: "tok"
        )
        store._client = httpx.AsyncClient(
            transport=httpx.MockTransport(handler)
        )

        run(store.delete_prefix("ctx"))

        assert peak > 1, "deletes ran one at a time"
        assert peak <= store._DELETE_CONCURRENCY, "concurrency is unbounded"

    def test_deletes_every_blob_it_listed(self):
        deleted = []

        def handler(request):
            if request.method == "GET":
                return httpx.Response(
                    200,
                    json={
                        "contents": [
                            {"name": f"c{i}.jsonz", "file_size": 1} for i in range(30)
                        ]
                    },
                )
            if request.method == "DELETE" and "fs/files" in str(request.url):
                deleted.append(str(request.url).rsplit("/", 1)[-1])
            return httpx.Response(200)

        run(_databricks_store(handler).delete_prefix("ctx"))

        assert sorted(deleted) == sorted(f"c{i}.jsonz" for i in range(30))


class TestBlobInfo:
    def test_is_hashable_and_immutable(self):
        info = BlobInfo(key="a", size_bytes=1)
        assert hash(info)
        with pytest.raises(Exception):
            info.key = "b"
