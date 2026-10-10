"""Operations between the tables of a case (05 §3): **join** by a key column
(a new ``table/result`` item whose provenance names its parents), **compare**
two tables or two runs of one query (diff by key), **promote** tables (or the
latest run of a query) to enrichment or to the graph in one go.

A table is read from a version's bytes: JSON ``{columns, rows}`` (console
results, query runs, joins) or delimited text (uploads).
"""

from __future__ import annotations

import json
from typing import Any, Optional
from uuid import UUID

from graphlagoon.services import case_items
from graphlagoon.services import investigation_storage as storage
from graphlagoon.services.cases import InvestigationError, _session, load_case

MAX_DIFF_ROWS = 500


def _invalid(message: str) -> InvestigationError:
    return InvestigationError(422, "INVALID_TABLE_OP", message)


def parse_table(data: bytes, content_type: str) -> tuple[list[str], list[list[Any]]]:
    """``(columns, rows)`` of a version; rows are lists aligned with ``columns``."""
    if content_type.startswith("application/json"):
        payload = json.loads(data)
        if not isinstance(payload, dict):
            raise _invalid("The content is not a table")
        rows = payload.get("rows") or []
        columns = [str(c) for c in (payload.get("columns") or [])]
        if rows and isinstance(rows[0], dict):
            columns = columns or sorted({k for r in rows for k in r})
            rows = [[r.get(c) for c in columns] for r in rows]
        if not columns:
            raise _invalid("The content has no columns")
        return columns, [list(r) for r in rows]
    from graphlagoon.services import file_mapping

    text = file_mapping.decode(data, None)
    lines = file_mapping._lines(text)
    if not lines:
        raise _invalid("The file is empty")
    delimiter = max(";,\t|", key=lambda d: lines[0].count(d))
    columns = [c.strip() for c in file_mapping.parse_line(lines[0], delimiter)]
    rows = [file_mapping.parse_line(line, delimiter) for line in lines[1:]]
    return columns, [r + [None] * (len(columns) - len(r)) for r in rows]


def to_delimited(columns: list[str], rows: list[list[Any]], delimiter: str = "\t") -> str:
    """Text a file-mapping spec can read (JSON tables promoted to the graph)."""

    def cell(v: Any) -> str:
        if v is None:
            return ""
        s = str(v)
        return '"' + s.replace('"', '""') + '"' if delimiter in s or '"' in s or "\n" in s else s

    return "\n".join(delimiter.join(cell(v) for v in row) for row in [columns, *rows])


async def load_table(session, investigation_id: UUID, item: Any, version: Optional[int] = None) -> tuple[list[str], list[list[Any]]]:
    if item.kind not in ("table", "query"):
        raise _invalid(f"“{item.title}” is not a table")
    if not item.current_version:
        raise _invalid(f"“{item.title}” has no content yet" + (" (run it first)" if item.kind == "query" else ""))
    row = await case_items.version_row(session, investigation_id, item, version)
    data = await storage.load(row.blob_key)
    if data is None:
        raise InvestigationError(404, "CONTENT_MISSING", "The stored content was not found")
    return parse_table(data, row.content_type)


def _norm(value: Any) -> str:
    return "" if value is None else str(value).strip()


def common_key(tables: list[list[str]]) -> Optional[str]:
    first = tables[0] if tables else []
    for c in first:
        if all(any(o.lower() == c.lower() for o in t) for t in tables[1:]):
            return c
    return None


def _col_index(columns: list[str], name: str, title: str) -> int:
    for i, c in enumerate(columns):
        if c.lower() == name.lower():
            return i
    raise _invalid(f"“{title}” has no column {name}")


def join_rows(tables: list[tuple[str, list[str], list[list[Any]]]], key: str) -> tuple[list[str], list[list[Any]]]:
    """Full outer join of ``(title, columns, rows)`` tables on ``key`` (trimmed
    text match); the first table's order first, then keys only the others have.
    Non-key columns shared by two tables are suffixed with the table's title."""
    counts: dict[str, int] = {}
    for _, cols, _ in tables:
        for c in cols:
            if c.lower() != key.lower():
                counts[c.lower()] = counts.get(c.lower(), 0) + 1
    out_cols = [key]
    indexed: list[tuple[int, list[int], dict[str, list[Any]]]] = []
    order: list[str] = []
    seen: set[str] = set()
    for title, cols, rows in tables:
        ki = _col_index(cols, key, title)
        keep = [i for i, c in enumerate(cols) if i != ki]
        out_cols += [c if counts[c.lower()] == 1 else f"{c} ({title})" for c in (cols[i] for i in keep)]
        by_key: dict[str, list[Any]] = {}
        for r in rows:
            k = _norm(r[ki] if ki < len(r) else None)
            by_key.setdefault(k, r)
            if k not in seen:
                seen.add(k)
                order.append(k)
        indexed.append((ki, keep, by_key))
    out_rows = []
    for k in order:
        row: list[Any] = [k]
        for _, keep, by_key in indexed:
            r = by_key.get(k)
            row += [(r[i] if r is not None and i < len(r) else None) for i in keep]
        out_rows.append(row)
    return out_cols, out_rows


async def join_tables(
    investigation_id: UUID, user_email: str, item_ids: list[UUID], key_column: Optional[str], title: Optional[str]
) -> dict:
    if len(item_ids) < 2:
        raise _invalid("Pick at least two tables to join")
    async with _session() as session:
        await load_case(session, investigation_id, user_email, "write")
        tables = []
        for item_id in item_ids:
            item = await case_items.item_row(session, investigation_id, item_id)
            cols, rows = await load_table(session, investigation_id, item)
            tables.append((item.title, cols, rows))
    key = key_column or common_key([t[1] for t in tables])
    if not key:
        raise _invalid("The tables share no column; give the key column")
    columns, rows = join_rows(tables, key)
    content = {"columns": columns, "rows": rows, "row_count": len(rows)}
    data, content_type = case_items.encode_content(None, content)
    return await case_items.create_item(
        investigation_id,
        user_email,
        {
            "kind": "table",
            "subkind": "result",
            "title": title or f"{' + '.join(t[0] for t in tables)} por {key}",
            "provenance": {"tool": "join", "parent_item_ids": [str(i) for i in item_ids], "key_column": key},
        },
        data,
        content_type,
    )


def diff_rows(
    left: tuple[list[str], list[list[Any]]], right: tuple[list[str], list[list[Any]]], key: str
) -> dict:
    lcols, lrows = left
    rcols, rrows = right
    li, ri = _col_index(lcols, key, "left"), _col_index(rcols, key, "right")
    shared = [c for c in lcols if c.lower() != key.lower() and any(o.lower() == c.lower() for o in rcols)]
    lpos = {c: _col_index(lcols, c, "left") for c in shared}
    rpos = {c: _col_index(rcols, c, "right") for c in shared}
    lmap = {_norm(r[li] if li < len(r) else None): r for r in lrows}
    rmap = {_norm(r[ri] if ri < len(r) else None): r for r in rrows}
    only_left = [lmap[k] for k in lmap if k not in rmap]
    only_right = [rmap[k] for k in rmap if k not in lmap]
    changed, same = [], 0
    for k in lmap:
        if k not in rmap:
            continue
        l, r = lmap[k], rmap[k]
        fields = {
            c: {"left": l[lpos[c]] if lpos[c] < len(l) else None, "right": r[rpos[c]] if rpos[c] < len(r) else None}
            for c in shared
            if _norm(l[lpos[c]] if lpos[c] < len(l) else None) != _norm(r[rpos[c]] if rpos[c] < len(r) else None)
        }
        if fields:
            changed.append({"key": k, "fields": fields})
        else:
            same += 1
    return {
        "key_column": key,
        "columns": {"left": lcols, "right": rcols, "shared": shared},
        "counts": {
            "left": len(lrows), "right": len(rrows), "only_left": len(only_left),
            "only_right": len(only_right), "changed": len(changed), "same": same,
        },
        "only_left": only_left[:MAX_DIFF_ROWS],
        "only_right": only_right[:MAX_DIFF_ROWS],
        "changed": changed[:MAX_DIFF_ROWS],
        "truncated": max(len(only_left), len(only_right), len(changed)) > MAX_DIFF_ROWS,
    }


async def compare_tables(
    investigation_id: UUID, user_email: str, left: dict, right: dict, key_column: Optional[str]
) -> dict:
    """``left``/``right`` = ``{item_id, version?}``: two tables, or two runs of one query."""
    async with _session() as session:
        await load_case(session, investigation_id, user_email)
        sides = []
        for side in (left, right):
            item = await case_items.item_row(session, investigation_id, UUID(str(side["item_id"])))
            sides.append((item, await load_table(session, investigation_id, item, side.get("version"))))
    key = key_column or common_key([t[0] for _, t in sides]) or sides[0][1][0][0]
    out = diff_rows(sides[0][1], sides[1][1], key)
    out["left"] = {"item_id": str(sides[0][0].id), "title": sides[0][0].title, "version": left.get("version") or sides[0][0].current_version}
    out["right"] = {"item_id": str(sides[1][0].id), "title": sides[1][0].title, "version": right.get("version") or sides[1][0].current_version}
    return out


def enrichment_mapping(title: str, columns: list[str], options: dict) -> dict:
    key = options.get("key_column") or columns[0]
    return {
        "as": "enrichment",
        "spec": {
            "name": options.get("name") or title,
            "input": {"delimiter": "\t", "header": True},
            "key_column": key,
            "columns": [c for c in columns if c.lower() != key.lower()] or [key],
            "match_node_types": options.get("match_node_types") or ["*"],
            "match_source": options.get("match_source") or "node_id",
            **({"key_digits": options["key_digits"]} if options.get("key_digits") else {}),
        },
    }


def graph_mapping(title: str, columns: list[str], options: dict) -> dict:
    """A two-endpoint file-mapping spec over the table's columns (05 §3: each
    table its own source with a ring)."""
    src = options.get("source_column") or columns[0]
    dst = options.get("target_column") or (columns[1] if len(columns) > 1 else columns[0])
    normalize = options.get("normalize")
    ident = lambda col: {"col": f"t.{col}", **({"normalize": normalize} if normalize else {})}  # noqa: E731
    props = {c: f"t.{c}" for c in columns if c not in (src, dst)}
    spec = {
        "version": 1,
        "name": title,
        "inputs": {"t": {"match": "*", "delimiter": "\t", "header": True}},
        "nodes": [
            {"key": "src", "type": options.get("source_type") or "Entidade", "from": "t", "id": ident(src)},
            {"key": "dst", "type": options.get("target_type") or options.get("source_type") or "Entidade", "from": "t", "id": ident(dst)},
        ],
        "edges": [
            {"from": "t", "type": options.get("edge_type") or "relacionado", "endpoints": {"self": "src", "other": "dst"}, "props": props}
        ],
    }
    semantics = {k: options[k] for k in ("amount_prop", "time_prop") if options.get(k)}
    if semantics:
        spec["edge_semantics"] = semantics
    return {"as": "graph", "spec": spec}


async def promote(investigation_id: UUID, user_email: str, item_ids: list[UUID], as_: str, options: dict) -> list[dict]:
    """Sets ``mapping`` on each table; a query item is first materialized as a
    ``table/result`` from its latest run (provenance keeps the query and run)."""
    if as_ not in ("graph", "enrichment"):
        raise _invalid('as must be "graph" or "enrichment"')
    out = []
    for item_id in item_ids:
        async with _session() as session:
            await load_case(session, investigation_id, user_email, "write")
            item = await case_items.item_row(session, investigation_id, item_id)
            columns, rows = await load_table(session, investigation_id, item)
            run_version = await case_items.version_row(session, investigation_id, item, None) if item.kind == "query" else None
        target_id = item.id
        if item.kind == "query":
            data, content_type = case_items.encode_content(None, {"columns": columns, "rows": rows, "row_count": len(rows)})
            created = await case_items.create_item(
                investigation_id,
                user_email,
                {
                    "kind": "table",
                    "subkind": "result",
                    "title": f"{item.title} · run {run_version.version}",
                    "provenance": {"query_item_id": str(item.id), "run_id": str(run_version.id), "tool": "promote"},
                },
                data,
                content_type,
            )
            target_id = created["id"]
        mapping = (graph_mapping if as_ == "graph" else enrichment_mapping)(item.title, columns, options)
        out.append(await case_items.update_item(investigation_id, user_email, target_id, {"mapping": mapping}))
    return out
