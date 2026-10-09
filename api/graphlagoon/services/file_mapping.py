"""File mapping spec interpreter (03-arquitetura §4), the authoritative one.

``frontend/src/utils/fileMapping.ts`` is the preview twin: the same spec over
the same files must give the same graph and report. Both read the golden
fixtures in ``frontend/src/__tests__/fixtures/fileMapping/``; change one
interpreter, change the other and the fixtures together.

Semantics (shared with the TS twin):
- inputs pick the first file (by name) whose name matches the glob; cells are
  trimmed; ``header: false`` names the columns with ``columns``;
- a row is ``{"alias.COL": value}``; joins are left joins between inputs;
- each scope (an input or a join) is walked row by row: nodes, then edges.
  A conversion error discards the whole row, with the reason in the report;
- values: a string is a column ref; objects have one of ``col``/``concat``/
  ``template``, then ``convert`` → ``map`` → ``normalize``; a missing part
  makes the value null; null props are omitted; a null or empty id skips the
  node;
- nodes merge by id (first type wins, first non-null prop wins); duplicate
  edge ids keep the first.
"""

from __future__ import annotations

import re
from typing import Any, Optional

from graphlagoon.mcp.server import _normalize

CONVERTERS = ("cents", "decimal_br", "trim", "upper", "digits")
NORMALIZERS = ("cpf_cnpj", "account", "phone", "email", "lower", "none")
WHEN_OPS = ("eq", "ne", "in", "empty", "not_empty")
MAX_DISCARDED = 20

_REF = re.compile(r"^[A-Za-z_]\w*\.[^.\s{}]+$")
_PLACEHOLDER = re.compile(r"\{([^}]+)\}")
_CENTS = re.compile(r"^-?\d+$")
_DECIMAL_BR = re.compile(r"^-?(\d{1,3}(\.\d{3})*|\d+)(,\d+)?$")


class MappingError(ValueError):
    """The spec is invalid (unknown operator, dangling reference, …)."""


class _RowError(Exception):
    pass


# ---------------------------------------------------------------------------
# Validation: unknown keys and operators are errors, never ignored.
# ---------------------------------------------------------------------------


def _keys(obj: Any, where: str, allowed: set, required: tuple = ()) -> dict:
    if not isinstance(obj, dict):
        raise MappingError(f"{where}: expected an object")
    extra = sorted(set(obj) - allowed)
    if extra:
        raise MappingError(f"{where}: unknown key '{extra[0]}'")
    for k in required:
        if k not in obj:
            raise MappingError(f"{where}: missing '{k}'")
    return obj


def _ref(value: Any, where: str, refs: set) -> None:
    if not isinstance(value, str) or not _REF.match(value):
        raise MappingError(f"{where}: expected a column reference 'alias.COLUMN'")
    refs.add(value)


def _expr(expr: Any, where: str, spec: dict, refs: set) -> None:
    if isinstance(expr, str):
        _ref(expr, where, refs)
        return
    _keys(
        expr, where, {"col", "concat", "template", "sep", "convert", "map", "normalize"}
    )
    bases = [k for k in ("col", "concat", "template") if k in expr]
    if len(bases) != 1:
        raise MappingError(f"{where}: give exactly one of col, concat, template")
    if "col" in expr:
        _ref(expr["col"], where, refs)
    if "concat" in expr:
        if not isinstance(expr["concat"], list) or not expr["concat"]:
            raise MappingError(f"{where}: concat needs a list of columns")
        for r in expr["concat"]:
            _ref(r, where, refs)
    elif "sep" in expr:
        raise MappingError(f"{where}: sep only goes with concat")
    if "template" in expr:
        if not isinstance(expr["template"], str):
            raise MappingError(f"{where}: template must be a string")
        for r in _PLACEHOLDER.findall(expr["template"]):
            _ref(r, where, refs)
    converts = expr.get("convert", [])
    for c in [converts] if isinstance(converts, str) else converts:
        if c not in CONVERTERS and not (isinstance(c, str) and c.startswith("date:")):
            raise MappingError(f"{where}: unknown convert '{c}'")
        if c.startswith("date:") and not all(t in c for t in ("dd", "mm", "yyyy")):
            raise MappingError(f"{where}: date format needs dd, mm and yyyy")
    if "map" in expr and expr["map"] not in (spec.get("tables") or {}):
        raise MappingError(f"{where}: unknown table '{expr['map']}'")
    if "normalize" in expr and expr["normalize"] not in NORMALIZERS:
        raise MappingError(f"{where}: unknown normalize '{expr['normalize']}'")


def _when(when: Any, where: str, refs: set) -> None:
    _keys(when, where, set(WHEN_OPS))
    if len(when) != 1:
        raise MappingError(f"{where}: give exactly one operator")
    op, arg = next(iter(when.items()))
    if op in ("empty", "not_empty"):
        _ref(arg, where, refs)
        return
    if not isinstance(arg, list) or len(arg) != 2:
        raise MappingError(f"{where}: {op} takes [column, value]")
    _ref(arg[0], where, refs)
    ok = isinstance(arg[1], list) if op == "in" else isinstance(arg[1], str)
    if not ok or (op == "in" and not all(isinstance(v, str) for v in arg[1])):
        raise MappingError(f"{where}: {op} compares with string values")


def _props(props: Any, where: str, spec: dict, refs: set) -> None:
    if not isinstance(props, dict):
        raise MappingError(f"{where}: expected an object")
    for name, expr in props.items():
        _expr(expr, f"{where}.{name}", spec, refs)


def validate(spec: Any) -> set:
    """Raises ``MappingError``; returns the column refs the spec reads."""
    refs: set = set()
    _keys(
        spec,
        "spec",
        {
            "version",
            "name",
            "inputs",
            "joins",
            "nodes",
            "edges",
            "edge_semantics",
            "tables",
        },
        ("version", "inputs", "nodes"),
    )
    if spec["version"] != 1:
        raise MappingError("spec: version must be 1")
    inputs = spec["inputs"]
    if not isinstance(inputs, dict) or not inputs:
        raise MappingError("inputs: declare at least one input")
    for alias, inp in inputs.items():
        where = f"inputs.{alias}"
        _keys(
            inp,
            where,
            {"match", "delimiter", "encoding", "header", "columns"},
            ("match",),
        )
        if inp.get("header", True) is False and not inp.get("columns"):
            raise MappingError(f"{where}: header false needs columns")
    tables = spec.get("tables") or {}
    if not isinstance(tables, dict) or not all(
        isinstance(t, dict) for t in tables.values()
    ):
        raise MappingError("tables: expected {name: {value: label}}")
    scopes = set(inputs)
    for i, join in enumerate(spec.get("joins") or []):
        where = f"joins[{i}]"
        _keys(join, where, {"left", "right", "as"}, ("left", "right", "as"))
        _ref(join["left"], where, refs)
        _ref(join["right"], where, refs)
        for side in ("left", "right"):
            if join[side].split(".", 1)[0] not in inputs:
                raise MappingError(f"{where}: {side} must name an input")
        scopes.add(join["as"])
    node_keys = set()
    for i, node in enumerate(spec["nodes"]):
        where = f"nodes[{i}]"
        _keys(
            node,
            where,
            {"key", "type", "from", "id", "when", "props"},
            ("key", "type", "from", "id"),
        )
        if not isinstance(node["type"], str):
            raise MappingError(f"{where}: type must be a string")
        if node["from"] not in scopes:
            raise MappingError(f"{where}: unknown from '{node['from']}'")
        _expr(node["id"], f"{where}.id", spec, refs)
        if "when" in node:
            _when(node["when"], f"{where}.when", refs)
        _props(node.get("props", {}), f"{where}.props", spec, refs)
        node_keys.add(node["key"])
    for i, edge in enumerate(spec.get("edges") or []):
        where = f"edges[{i}]"
        _keys(
            edge,
            where,
            {"from", "id", "type", "direction", "endpoints", "when", "props"},
            ("from", "type", "endpoints"),
        )
        if edge["from"] not in scopes:
            raise MappingError(f"{where}: unknown from '{edge['from']}'")
        if "id" in edge:
            _expr(edge["id"], f"{where}.id", spec, refs)
        if not isinstance(edge["type"], str):
            _expr(edge["type"], f"{where}.type", spec, refs)
        direction = edge.get("direction", "out")
        if isinstance(direction, dict):
            _ref(direction.get("col"), f"{where}.direction", refs)
            if not all(v in ("in", "out") for k, v in direction.items() if k != "col"):
                raise MappingError(f"{where}.direction: values must be in or out")
        elif direction not in ("in", "out"):
            raise MappingError(f"{where}.direction: must be in, out or {{col, …}}")
        ends = _keys(
            edge["endpoints"],
            f"{where}.endpoints",
            {"self", "other"},
            ("self", "other"),
        )
        others = ends["other"] if isinstance(ends["other"], list) else [ends["other"]]
        for k in [ends["self"], *others]:
            if k not in node_keys:
                raise MappingError(f"{where}.endpoints: unknown node key '{k}'")
        if "when" in edge:
            _when(edge["when"], f"{where}.when", refs)
        _props(edge.get("props", {}), f"{where}.props", spec, refs)
    if "edge_semantics" in spec:
        _keys(
            spec["edge_semantics"],
            "edge_semantics",
            {"amount_prop", "amount_unit", "time_prop", "currency"},
        )
    for ref in refs:
        if ref.split(".", 1)[0] not in inputs:
            raise MappingError(f"'{ref}': unknown input alias")
    return refs


# ---------------------------------------------------------------------------
# Reading files
# ---------------------------------------------------------------------------


def parse_line(line: str, delimiter: str) -> list[str]:
    """One delimited line; double quotes with "" escapes; cells trimmed."""
    cells, i, n = [], 0, len(line)
    while True:
        if i < n and line[i] == '"':
            i += 1
            buf = []
            while i < n:
                if line[i] == '"':
                    if i + 1 < n and line[i + 1] == '"':
                        buf.append('"')
                        i += 2
                        continue
                    i += 1
                    break
                buf.append(line[i])
                i += 1
            end = line.find(delimiter, i)
            end = n if end < 0 else end
            cells.append("".join(buf).strip())
        else:
            end = line.find(delimiter, i)
            end = n if end < 0 else end
            cells.append(line[i:end].strip())
        if end >= n:
            return cells
        i = end + len(delimiter)


def _lines(text: str) -> list[str]:
    return [line for line in re.split(r"\r?\n", text.lstrip("\ufeff")) if line != ""]


def _glob(pattern: str, name: str) -> bool:
    """Case-insensitive; only * and ? are special."""
    regex = "".join(
        ".*" if c == "*" else "." if c == "?" else re.escape(c) for c in pattern
    )
    return re.fullmatch(regex, name, re.IGNORECASE | re.DOTALL) is not None


def _match_file(inp: dict, names: list[str]) -> Optional[str]:
    return next((n for n in sorted(names) if _glob(inp["match"], n)), None)


def _columns(inp: dict, lines: list[str]) -> tuple[list[str], list[str]]:
    delimiter = inp.get("delimiter", ",")
    if inp.get("header", True) is False:
        return list(inp["columns"]), lines
    if not lines:
        return [], []
    return parse_line(lines[0], delimiter), lines[1:]


def decode(data: bytes, encoding: Optional[str]) -> str:
    return data.decode(encoding or "utf-8", errors="replace")


# ---------------------------------------------------------------------------
# Interpretation
# ---------------------------------------------------------------------------


def _convert(value: Any, conv: str) -> Any:
    if value is None:
        return None
    s = str(value)
    if conv == "trim":
        return s.strip()
    if conv == "upper":
        return s.upper()
    if conv == "digits":
        return re.sub(r"\D", "", s)
    if s == "":
        return None
    if conv == "cents":
        if not _CENTS.match(s):
            raise _RowError(f'invalid cents: "{s}"')
        return int(s) / 100
    if conv == "decimal_br":
        if not _DECIMAL_BR.match(s):
            raise _RowError(f'invalid decimal_br: "{s}"')
        return float(s.replace(".", "").replace(",", "."))
    fmt = conv[len("date:") :]
    if len(s) != len(fmt):
        raise _RowError(f'invalid {conv}: "{s}"')
    parts = {}
    for token in ("dd", "mm", "yyyy"):
        at = fmt.index(token)
        parts[token] = s[at : at + len(token)]
    literal = fmt
    for token in ("yyyy", "dd", "mm"):
        literal = literal.replace(token, "\0" * len(token), 1)
    ok = all(c == "\0" or c == s[i] for i, c in enumerate(literal)) and all(
        p.isdigit() and p.isascii() for p in parts.values()
    )
    if not ok or not (1 <= int(parts["mm"]) <= 12 and 1 <= int(parts["dd"]) <= 31):
        raise _RowError(f'invalid {conv}: "{s}"')
    return f"{parts['yyyy']}-{parts['mm']}-{parts['dd']}"


def _eval(expr: Any, row: dict, tables: dict) -> Any:
    if isinstance(expr, str):
        return row.get(expr)
    if "col" in expr:
        value = row.get(expr["col"])
    elif "concat" in expr:
        values = [row.get(r) for r in expr["concat"]]
        value = None if None in values else expr.get("sep", "-").join(values)
    else:
        missing = []

        def sub(m):
            v = row.get(m.group(1))
            if v is None:
                missing.append(m.group(1))
                return ""
            return v

        value = _PLACEHOLDER.sub(sub, expr["template"])
        value = None if missing else value
    converts = expr.get("convert", [])
    for c in [converts] if isinstance(converts, str) else converts:
        value = _convert(value, c)
    if "map" in expr and value is not None:
        value = tables[expr["map"]].get(str(value), value)
    if "normalize" in expr and value is not None:
        value = _normalize(value, expr["normalize"])
    return value


def _passes(when: Optional[dict], row: dict) -> bool:
    if not when:
        return True
    op, arg = next(iter(when.items()))
    if op == "empty":
        return row.get(arg) in (None, "")
    if op == "not_empty":
        return row.get(arg) not in (None, "")
    value = row.get(arg[0])
    if op == "eq":
        return value is not None and value == arg[1]
    if op == "ne":
        return value is None or value != arg[1]
    return value is not None and value in arg[1]


def _eval_props(props: dict, row: dict, tables: dict) -> dict:
    out = {}
    for name, expr in props.items():
        value = _eval(expr, row, tables)
        if value is not None:
            out[name] = value
    return out


def interpret(spec: dict, files: dict[str, str]) -> dict:
    """``files``: decoded text by file name. Returns ``{graph, report}`` with
    the graph in ``GraphResponse`` shape. Raises ``MappingError``."""
    refs = validate(spec)
    tables = spec.get("tables") or {}
    report = {
        "rows_read": 0,
        "rows_discarded": 0,
        "discarded": [],
        "unknown_nodes": 0,
        "edge_rows": 0,
        "without_counterpart": 0,
        "missing_inputs": [],
        "missing_columns": [],
    }

    rows_of: dict[str, list[dict]] = {}
    for alias, inp in spec["inputs"].items():
        name = _match_file(inp, list(files))
        if name is None:
            report["missing_inputs"].append(alias)
            rows_of[alias] = []
            continue
        columns, data = _columns(inp, _lines(files[name]))
        delimiter = inp.get("delimiter", ",")
        rows = []
        for line in data:
            cells = parse_line(line, delimiter)
            rows.append(
                {
                    f"{alias}.{c}": cells[i] if i < len(cells) else ""
                    for i, c in enumerate(columns)
                }
            )
        rows_of[alias] = rows
        have = {f"{alias}.{c}" for c in columns}
        report["missing_columns"] += [
            r for r in refs if r.split(".", 1)[0] == alias and r not in have
        ]
    report["missing_columns"].sort()

    for join in spec.get("joins") or []:
        right_alias = join["right"].split(".", 1)[0]
        index: dict[str, list[dict]] = {}
        for r in rows_of[right_alias]:
            v = r.get(join["right"])
            if v is not None:
                index.setdefault(v, []).append(r)
        joined = []
        for left in rows_of[join["left"].split(".", 1)[0]]:
            matches = (
                index.get(left.get(join["left"]))
                if left.get(join["left"]) is not None
                else None
            )
            joined += [{**left, **r} for r in matches] if matches else [dict(left)]
        rows_of[join["as"]] = joined

    nodes: dict[str, dict] = {}
    edges: dict[str, dict] = {}
    scopes: list[str] = []
    for d in [*spec["nodes"], *(spec.get("edges") or [])]:
        if d["from"] not in scopes:
            scopes.append(d["from"])
    edge_defs = list(enumerate(spec.get("edges") or []))

    for scope in scopes:
        node_defs = [n for n in spec["nodes"] if n["from"] == scope]
        scope_edges = [(i, e) for i, e in edge_defs if e["from"] == scope]
        for row_number, row in enumerate(rows_of[scope], 1):
            report["rows_read"] += 1
            try:
                row_nodes = {}
                for nd in node_defs:
                    if not _passes(nd.get("when"), row):
                        continue
                    node_id = _eval(nd["id"], row, tables)
                    if node_id is None or node_id == "":
                        continue
                    row_nodes[nd["key"]] = {
                        "node_id": str(node_id),
                        "node_type": nd["type"],
                        "properties": _eval_props(nd.get("props", {}), row, tables),
                    }
                row_edges, edge_rows, orphans = [], 0, 0
                for i, ed in scope_edges:
                    if not _passes(ed.get("when"), row):
                        continue
                    ends = ed["endpoints"]
                    me = row_nodes.get(ends["self"])
                    if me is None:
                        continue
                    edge_rows += 1
                    others = (
                        ends["other"]
                        if isinstance(ends["other"], list)
                        else [ends["other"]]
                    )
                    other = next((row_nodes[k] for k in others if k in row_nodes), None)
                    if other is None:
                        orphans += 1
                        continue
                    direction = ed.get("direction", "out")
                    if isinstance(direction, dict):
                        value = row.get(direction["col"])
                        if value is None or value == "col" or value not in direction:
                            raise _RowError(f'unexpected direction: "{value}"')
                        direction = direction[value]
                    edge_type = (
                        ed["type"]
                        if isinstance(ed["type"], str)
                        else _eval(ed["type"], row, tables)
                    )
                    edge_id = _eval(ed["id"], row, tables) if "id" in ed else None
                    src, dst = (me, other) if direction == "out" else (other, me)
                    row_edges.append(
                        {
                            "edge_id": str(edge_id)
                            if edge_id not in (None, "")
                            else f"{i}:{scope}:{row_number}",
                            "src": src["node_id"],
                            "dst": dst["node_id"],
                            "relationship_type": str(edge_type)
                            if edge_type is not None
                            else "",
                            "properties": _eval_props(ed.get("props", {}), row, tables),
                        }
                    )
            except _RowError as exc:
                report["rows_discarded"] += 1
                if len(report["discarded"]) < MAX_DISCARDED:
                    report["discarded"].append(
                        {"from": scope, "row": row_number, "reason": str(exc)}
                    )
                continue
            for node in row_nodes.values():
                found = nodes.get(node["node_id"])
                if found is None:
                    nodes[node["node_id"]] = node
                    continue
                for k, v in node["properties"].items():
                    found["properties"].setdefault(k, v)
            for edge in row_edges:
                edges.setdefault(edge["edge_id"], edge)
            report["edge_rows"] += edge_rows
            report["without_counterpart"] += orphans

    report["unknown_nodes"] = sum(
        1 for n in nodes.values() if n["node_type"] == "Desconhecido"
    )
    return {
        "graph": {
            "nodes": list(nodes.values()),
            "edges": list(edges.values()),
            "truncated": False,
        },
        "report": report,
    }


def suggest_presets(files: dict[str, str], presets: dict[str, dict]) -> list[str]:
    """Names of the presets whose every input matches a file by name and by
    header (the columns it reads), or by column count without a header."""
    out = []
    for name, spec in presets.items():
        refs = validate(spec)
        ok = True
        for alias, inp in spec["inputs"].items():
            file = _match_file(inp, list(files))
            lines = _lines(files[file]) if file else []
            if not lines:
                ok = False
                break
            first = parse_line(lines[0], inp.get("delimiter", ","))
            if inp.get("header", True) is False:
                ok = len(first) == len(inp["columns"])
            else:
                need = {r.split(".", 1)[1] for r in refs if r.split(".", 1)[0] == alias}
                ok = need <= set(first)
            if not ok:
                break
        if ok:
            out.append(name)
    return out
