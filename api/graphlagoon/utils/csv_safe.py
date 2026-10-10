"""CSV formula-injection defense on the server: the mirror of
``frontend/src/utils/csvSafe.ts`` (security assessment M4, task G2).

Text that a spreadsheet would evaluate as a formula (first character ``=``,
``+``, ``-``, ``@``, tab or CR) gets a leading ``'``; typed numbers and plain
numeric literals (``"-5"``, ``"+1.5e3"``) stay numbers.
"""

from __future__ import annotations

import csv
import io
import re
from typing import Any, Iterable

FORMULA_TRIGGERS = frozenset("=+-@\t\r")
NUMERIC_LITERAL = re.compile(r"^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$")


def safe_cell(value: Any) -> Any:
    """``safeCell``: only non-empty strings are touched."""
    if not isinstance(value, str) or not value:
        return value
    if value[0] not in FORMULA_TRIGGERS or NUMERIC_LITERAL.match(value):
        return value
    return f"'{value}"


def safe_cell_text(value: Any) -> str:
    """``safeCellText``: None → "", numbers and booleans as JS prints them,
    anything else stringified and then neutralized."""
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    return safe_cell(str(value))


def to_csv(header: list[str], rows: Iterable[list[Any]]) -> str:
    """RFC 4180 CSV with every cell (header included) neutralized."""
    out = io.StringIO()
    writer = csv.writer(out, lineterminator="\r\n")
    writer.writerow([safe_cell_text(h) for h in header])
    for row in rows:
        writer.writerow([safe_cell_text(v) for v in row])
    return out.getvalue()
