"""Enrichment lookups (investigations F2.1, 03 §2.1).

A context declares side tables (``enrichment_tables``) keyed by a node value.
A lookup reads only the declared columns for a batch of keys: identifiers come
from the validated context configuration and are quoted, key values travel as
named parameters, and both the key count and the row count are capped.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any, Optional

from graphlagoon.config import get_settings
from graphlagoon.services.sql_identifiers import (
    qualified_from_dotted,
    quote_identifier,
    validate_identifier_part,
)
from graphlagoon.services.sql_scope import check_scope

MAX_KEY_LENGTH = 200


class EnrichmentError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


def find_table(context, name: str) -> dict:
    for spec in getattr(context, "enrichment_tables", None) or []:
        if spec.get("name") == name:
            return spec
    raise EnrichmentError(
        404, "ENRICHMENT_TABLE_NOT_FOUND", f"No enrichment table '{name}' in this context"
    )


def changed_tables(new: list[dict], old: Optional[list[dict]]) -> list[dict]:
    """Entries that are new or differ from the stored ones (removals need nothing)."""
    from graphlagoon.models.schemas import EnrichmentTable

    stored = []
    for t in old or []:
        try:
            stored.append(EnrichmentTable(**t).model_dump())
        except ValueError:
            pass  # an invalid stored entry vouches for nothing
    return [t for t in new if t not in stored]


def scope_problem(tables: list[dict], context) -> Optional[str]:
    """Why an author may not attach these tables, or None. Same rule as an
    author's query (``check_scope``): the catalog.schema allowlist plus the
    schemas of the context's own edge/node tables."""
    settings = get_settings()
    # Without the enrichment tables: a stored one must not vouch for itself.
    base = SimpleNamespace(
        edge_table_name=getattr(context, "edge_table_name", None),
        node_table_name=getattr(context, "node_table_name", None),
    )
    for spec in tables:
        problem = check_scope(
            f"SELECT 1 FROM {spec['table']}",
            base,
            is_author=True,
            allowed_pairs=settings.catalog_schema_pairs,
            default_catalog=settings.default_catalog,
            default_schema=settings.default_schema,
        )
        if problem:
            return problem
    return None


def build_query(spec: dict, keys: list[str], row_limit: int) -> tuple[str, list[dict]]:
    """``SELECT <key>, <columns> FROM <table> WHERE <key> IN (:k0, …) LIMIT n``."""
    key = quote_identifier(validate_identifier_part(spec["key_column"]))
    columns = [c for c in spec["columns"] if c != spec["key_column"]]
    selected = ", ".join(
        [key, *(quote_identifier(validate_identifier_part(c)) for c in columns)]
    )
    placeholders = ", ".join(f":k{i}" for i in range(len(keys)))
    sql = (
        f"SELECT {selected} FROM {qualified_from_dotted(spec['table'])} "
        f"WHERE {key} IN ({placeholders}) LIMIT {int(row_limit)}"
    )
    params = [{"name": f"k{i}", "value": k, "type": "STRING"} for i, k in enumerate(keys)]
    return sql, params


def clean_keys(keys: list[Any]) -> list[str]:
    settings = get_settings()
    cleaned: list[str] = []
    for k in keys:
        if not isinstance(k, (str, int)) or isinstance(k, bool):
            raise EnrichmentError(400, "INVALID_KEY", "Keys must be strings or integers")
        value = str(k).strip()
        if not value or len(value) > MAX_KEY_LENGTH:
            raise EnrichmentError(
                400, "INVALID_KEY", f"Keys must be 1 to {MAX_KEY_LENGTH} characters"
            )
        if value not in cleaned:
            cleaned.append(value)
    if not cleaned:
        raise EnrichmentError(400, "INVALID_KEY", "Give at least one key")
    if len(cleaned) > settings.enrichment_max_keys:
        raise EnrichmentError(
            400,
            "TOO_MANY_KEYS",
            f"At most {settings.enrichment_max_keys} keys per lookup",
        )
    return cleaned


async def lookup(warehouse, context, name: str, keys: list[Any]) -> dict:
    """``{name, key_column, columns, cardinality, rows: {key: [row]}, truncated}``;
    each row holds only the declared ``columns``."""
    spec = find_table(context, name)
    cleaned = clean_keys(keys)
    max_rows = get_settings().enrichment_max_rows
    sql, params = build_query(spec, cleaned, max_rows + 1)
    response = await warehouse.execute_statement(sql, parameters=params)
    if response.status.state != "SUCCEEDED":
        message = response.status.error.message if response.status.error else None
        raise EnrichmentError(
            502, "ENRICHMENT_QUERY_FAILED", message or "The enrichment query failed"
        )
    names = [c.name for c in response.manifest.schema.columns] if response.manifest else []
    data = (response.result.data_array if response.result else None) or []
    truncated = len(data) > max_rows
    rows: dict[str, list[dict]] = {}
    for raw in data[:max_rows]:
        record = dict(zip(names, raw))
        key = record.get(spec["key_column"])
        row = {c: record.get(c) for c in spec["columns"]}
        rows.setdefault(str(key), []).append(row)
    return {
        "name": spec["name"],
        "label": spec.get("label"),
        "key_column": spec["key_column"],
        "columns": spec["columns"],
        "cardinality": spec.get("cardinality", "one"),
        "rows": rows,
        "truncated": truncated,
    }
