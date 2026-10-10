"""Text of an item version for search and for agents (05 §6): md/txt/csv/json
natively; PDF and DOCX through the optional ``pypdf`` / ``python-docx``; None
when the format has no text (binary, scanned PDF, missing extra)."""

from __future__ import annotations

import io
from typing import Optional

TEXT_TYPES = ("text/", "application/json", "application/x-ndjson", "application/xml", "image/svg+xml")
TEXT_EXTENSIONS = frozenset({"md", "txt", "csv", "tsv", "json", "html", "svg", "xml", "sql", "cypher", "log"})
MAX_TEXT_BYTES = 4 * 1024 * 1024


def decode(data: bytes) -> str:
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return data.decode("latin-1")  # SIMBA layouts are Latin-1


def is_text(name: str, content_type: Optional[str]) -> bool:
    ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    return ext in TEXT_EXTENSIONS or bool(content_type and content_type.startswith(TEXT_TYPES))


def _pdf(data: bytes) -> Optional[str]:
    try:
        from pypdf import PdfReader
    except ImportError:
        return None
    try:
        pages = [p.extract_text() or "" for p in PdfReader(io.BytesIO(data)).pages]
    except Exception:
        return None
    text = "\n".join(pages).strip()
    return text or None  # a scanned PDF has pages but no text (no OCR here)


def _docx(data: bytes) -> Optional[str]:
    try:
        import docx
    except ImportError:
        return None
    try:
        document = docx.Document(io.BytesIO(data))
    except Exception:
        return None
    text = "\n".join(p.text for p in document.paragraphs).strip()
    return text or None


def extract(data: bytes, name: str, content_type: Optional[str]) -> Optional[str]:
    """The text of ``data`` or None. Text formats are capped at MAX_TEXT_BYTES."""
    ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    if ext == "pdf" or content_type == "application/pdf":
        return _pdf(data)
    if ext == "docx" or (content_type or "").endswith("wordprocessingml.document"):
        return _docx(data)
    if is_text(name, content_type):
        return decode(data[:MAX_TEXT_BYTES])
    return None
