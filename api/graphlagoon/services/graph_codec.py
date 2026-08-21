"""Compression codec for stored graph payloads.

gzip, deliberately — not because it compresses best, but because it is the only
format the read path can hand back **untouched**.

Starlette's GZipMiddleware forwards any response body that already carries a
`Content-Encoding` header (`IdentityResponder.send_with_compression`), so a
cache read can return the bytes exactly as they sit on the volume, with
`Content-Encoding: gzip`, and let the browser decompress. The server never
decompresses, never re-serializes, and never allocates a second copy of a
possibly-large graph. `Content-Encoding: zstd` is not safely assumable across
proxies and clients, so a denser codec would cost a full server-side
decompress + re-serialize on every load — a bad trade on the hot path.

The stored extension is `.jsonz` on purpose: it names "compressed JSON" without
naming the algorithm. `decompress` dispatches on magic bytes, so a future codec
change needs neither a file migration nor a two-key lookup ladder.
"""

from __future__ import annotations

import gzip

import orjson

GZIP_MAGIC = b"\x1f\x8b"
ZSTD_MAGIC = b"\x28\xb5\x2f\xfd"

#: Codec-agnostic extension for every blob written through this module.
EXTENSION = ".jsonz"

_GZIP_LEVEL = 6


def compress(obj: dict) -> bytes:
    """Serialize and gzip-compress a payload."""
    return gzip.compress(orjson.dumps(obj), compresslevel=_GZIP_LEVEL)


def decompress(data: bytes) -> dict:
    """Decompress and deserialize a payload, dispatching on magic bytes."""
    encoding = sniff_encoding(data)

    if encoding == "gzip":
        return orjson.loads(gzip.decompress(data))

    if encoding == "zstd":
        raise ValueError(
            "Payload is zstd-compressed but this build has no zstd support. "
            "Install the 'compression' extra, or rewrite the payload as gzip."
        )

    raise ValueError(
        "Unrecognized payload encoding: expected gzip "
        f"(magic {GZIP_MAGIC.hex()}), got {data[:4].hex() or '<empty>'}"
    )


def sniff_encoding(data: bytes) -> str | None:
    """Name the compression of a stored payload, or None if unrecognized.

    The router uses this to pick the `Content-Encoding` response header, so it
    never has to assume what the writer used.
    """
    if data.startswith(GZIP_MAGIC):
        return "gzip"
    if data.startswith(ZSTD_MAGIC):
        return "zstd"
    return None
