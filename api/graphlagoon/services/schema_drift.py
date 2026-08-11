"""Pure schema-drift diffing between a stored GraphContext snapshot and live tables.

Everything except ``validate_context_tables`` at the bottom is I/O-free — every
function takes already-fetched data (live columns, discovered types) and returns
plain dataclasses/dicts. Callers (the ``schema-drift`` endpoint, and the create/
update context endpoints) own all warehouse I/O and glue this to ``WarehouseClient``.
Keeping the diff logic I/O-free is what makes every drift case unit-testable
without a warehouse. ``validate_context_tables`` lives here anyway, despite doing
I/O, because it shares ``parse_qualified_table`` and the structural-role logic
with the pure functions above it.

See docs/dev/decision-log.md for why resync reuses PUT instead of a dedicated write
endpoint, and why renames are never inferred.
"""

from dataclasses import dataclass, field, asdict
from typing import Any, Literal, Optional

from graphlagoon.services.graph_operations import merge_column_config

Severity = Literal["ok", "info", "warning", "error"]
_SEVERITY_ORDER: dict[str, int] = {"ok": 0, "info": 1, "warning": 2, "error": 3}

# role -> which table the column lives on
_ROLE_SIDE: dict[str, str] = {
    "node_id_col": "node",
    "node_type_col": "node",
    "edge_id_col": "edge",
    "src_col": "edge",
    "dst_col": "edge",
    "relationship_type_col": "edge",
}


@dataclass
class Finding:
    """One detected difference between the stored snapshot and the live table."""

    code: str
    severity: Severity
    side: Literal["node", "edge"]
    kind: Literal["table", "structure", "property", "type"]
    name: str
    message: str
    role: Optional[str] = None
    stored: Optional[dict[str, Any]] = None
    live: Optional[dict[str, Any]] = None
    auto_fixable: bool = False

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def parse_qualified_table(name: str) -> Optional[tuple[str, str, str]]:
    """Parse ``db.table`` or ``catalog.db.table`` into ``(catalog, database, table)``.

    Backend port of the frontend-only ``parseTableName`` in ContextsView.vue. A
    two-part name implies the ``spark_catalog`` default, matching the frontend rule.
    Returns ``None`` for anything else (0, 1, or 4+ parts).
    """
    if not name:
        return None
    parts = name.split(".")
    if len(parts) == 2:
        return ("spark_catalog", parts[0], parts[1])
    if len(parts) == 3:
        return (parts[0], parts[1], parts[2])
    return None


def structural_roles(context) -> dict[str, tuple[str, str]]:
    """Map each structural role to ``(side, column_name)``.

    Roles with an empty column name are skipped — an empty ``edge_id_col`` is the
    UI's legitimate "no edge id column, synthesize one" option, not a drift signal.
    """
    merged = merge_column_config(context)
    roles: dict[str, tuple[str, str]] = {}
    for role, side in _ROLE_SIDE.items():
        col = merged.get(role)
        if col:
            roles[role] = (side, col)
    return roles


# --- accessors that tolerate both dicts and objects (contexts round-trip through
# both Pydantic models and raw dicts, per the memory-store vs DB split) ---------


def _get(obj, key: str, default=None):
    if isinstance(obj, dict):
        return obj.get(key, default)
    return getattr(obj, key, default)


def _property_name(prop) -> Optional[str]:
    return _get(prop, "name")


def _property_data_type(prop) -> str:
    return _get(prop, "data_type") or "string"


def _property_display_name(prop) -> Optional[str]:
    return _get(prop, "display_name")


def _property_description(prop) -> Optional[str]:
    return _get(prop, "description")


def _property_to_dict(prop) -> dict[str, Any]:
    return {
        "name": _property_name(prop),
        "data_type": _property_data_type(prop),
        "display_name": _property_display_name(prop),
        "description": _property_description(prop),
    }


def _column_name(col) -> Optional[str]:
    return _get(col, "name")


def _column_data_type(col) -> str:
    return _get(col, "data_type") or ""


def counts_by_severity(findings: list[Finding]) -> dict[str, int]:
    counts = {"error": 0, "warning": 0, "info": 0}
    for f in findings:
        if f.severity in counts:
            counts[f.severity] += 1
    return counts


def overall_status(findings: list[Finding]) -> Severity:
    if not findings:
        return "ok"
    return max((f.severity for f in findings), key=lambda s: _SEVERITY_ORDER[s])


def diff_table(
    side: Literal["node", "edge"],
    table_name: str,
    stored_props: Optional[list],
    live_columns: Optional[list],
    structural_names: set[str],
) -> list[Finding]:
    """Diff one table's PROPERTY columns against its live schema.

    Assumes the table IS reachable — callers add a single ``TABLE_NOT_FOUND``
    finding instead of calling this when it is not (a cascade of per-column
    findings on top of an unreachable table would just be noise).

    Structural columns are excluded on both sides: they are diffed separately by
    ``diff_structure`` (missing there is ``error``, not ``warning``/``info``), and a
    stored property that happens to share a name with a structural column is
    treated as neither missing nor added — see ``compute_drift``'s docstring.
    """
    findings: list[Finding] = []
    side_label = "Node" if side == "node" else "Edge"

    stored_by_name: dict[str, Any] = {}
    for prop in stored_props or []:
        name = _property_name(prop)
        if name:
            stored_by_name[name] = prop

    live_by_name: dict[str, Any] = {}
    live_order: list[str] = []
    for col in live_columns or []:
        name = _column_name(col)
        if name:
            live_by_name[name] = col
            live_order.append(name)

    for name, prop in stored_by_name.items():
        if name in structural_names:
            continue
        live_col = live_by_name.get(name)
        stored_type = _property_data_type(prop)
        if live_col is None:
            findings.append(
                Finding(
                    code="PROPERTY_COLUMN_MISSING",
                    severity="error",
                    side=side,
                    kind="property",
                    name=name,
                    stored={
                        "data_type": stored_type,
                        "display_name": _property_display_name(prop),
                        "description": _property_description(prop),
                    },
                    live=None,
                    message=(
                        f"{side_label} property column `{name}` no longer exists "
                        f"in `{table_name}`."
                    ),
                    auto_fixable=True,
                )
            )
            continue

        live_type = _column_data_type(live_col)
        if live_type and stored_type and live_type.lower() != stored_type.lower():
            findings.append(
                Finding(
                    code="PROPERTY_TYPE_CHANGED",
                    severity="warning",
                    side=side,
                    kind="property",
                    name=name,
                    stored={"data_type": stored_type},
                    live={"data_type": live_type},
                    message=(
                        f"{side_label} property column `{name}` changed type from "
                        f"{stored_type} to {live_type}."
                    ),
                    auto_fixable=True,
                )
            )

    for name in live_order:
        if name in structural_names or name in stored_by_name:
            continue
        findings.append(
            Finding(
                code="PROPERTY_COLUMN_ADDED",
                severity="info",
                side=side,
                kind="property",
                name=name,
                stored=None,
                live={"data_type": _column_data_type(live_by_name[name])},
                message=(
                    f"Column `{name}` exists in `{table_name}` but is not exposed "
                    "by this context."
                ),
                auto_fixable=True,
            )
        )

    return findings


def diff_structure(
    context,
    node_live_columns: Optional[list],
    edge_live_columns: Optional[list],
    node_reachable: bool,
    edge_reachable: bool,
) -> list[Finding]:
    """Diff structural columns (node_id_col, src_col, ...) against live schemas.

    Skipped per-side when that side's table is unreachable — ``TABLE_NOT_FOUND``
    already covers it and a structural finding on top would be redundant.

    Note: there is no ``STRUCTURAL_COLUMN_TYPE_CHANGED`` here — the stored snapshot
    never records a *type* for structural columns (``node_structure``/
    ``edge_structure`` are name-only), so there is nothing to compare against.
    """
    findings: list[Finding] = []
    roles = structural_roles(context)

    node_names = {_column_name(c) for c in (node_live_columns or [])}
    edge_names = {_column_name(c) for c in (edge_live_columns or [])}

    for role, (side, col_name) in roles.items():
        if side == "node":
            if not node_reachable or col_name in node_names:
                continue
            table_name = _get(context, "node_table_name")
        else:
            if not edge_reachable or col_name in edge_names:
                continue
            table_name = _get(context, "edge_table_name")

        findings.append(
            Finding(
                code="STRUCTURAL_COLUMN_MISSING",
                severity="error",
                side=side,
                kind="structure",
                name=col_name,
                role=role,
                stored={"column": col_name},
                live=None,
                message=(
                    f"Structural column `{col_name}` ({role}) no longer exists in "
                    f"`{table_name}`."
                ),
                auto_fixable=False,
            )
        )

    return findings


def _diff_type_list(
    side: Literal["node", "edge"], kind_label: str, stored: list[str], live: list[str]
) -> list[Finding]:
    stored_set, live_set = set(stored), set(live)
    findings: list[Finding] = []

    for name in sorted(stored_set - live_set):
        findings.append(
            Finding(
                code="TYPE_VALUE_REMOVED",
                severity="warning",
                side=side,
                kind="type",
                name=name,
                stored={"value": name},
                live=None,
                message=f"{kind_label} `{name}` is no longer present in the data.",
                auto_fixable=True,
            )
        )
    for name in sorted(live_set - stored_set):
        findings.append(
            Finding(
                code="TYPE_VALUE_ADDED",
                severity="info",
                side=side,
                kind="type",
                name=name,
                stored=None,
                live={"value": name},
                message=(
                    f"New {kind_label.lower()} `{name}` found in the data but not "
                    "configured."
                ),
                auto_fixable=True,
            )
        )
    return findings


def diff_types(
    stored_node_types: Optional[list[str]],
    stored_relationship_types: Optional[list[str]],
    discovered_node_types: Optional[list[str]],
    discovered_relationship_types: Optional[list[str]],
) -> list[Finding]:
    """Diff node_types / relationship_types against freshly discovered values.

    Returns ``[]`` for a side whose discovered value is ``None`` — that is how the
    caller signals "types were not checked" (``check_types=false``, the default;
    discovery is a full-table ``SELECT DISTINCT`` scan).
    """
    findings: list[Finding] = []
    if discovered_node_types is not None:
        findings.extend(
            _diff_type_list(
                "node", "Node type", stored_node_types or [], discovered_node_types
            )
        )
    if discovered_relationship_types is not None:
        findings.extend(
            _diff_type_list(
                "edge",
                "Relationship type",
                stored_relationship_types or [],
                discovered_relationship_types,
            )
        )
    return findings


def merge_properties(
    stored_props: Optional[list],
    live_columns: Optional[list],
    structural_names: set[str],
) -> list[dict[str, Any]]:
    """Compute the resync payload for one side's property list.

    This IS the resync semantics:
      1. Candidates = live columns minus ``structural_names``.
      2. A candidate whose name matches a stored property keeps that property's
         ``display_name``/``description``; ``data_type`` is taken from the live
         column (the whole point is picking up a type change).
      3. A stored property absent from live columns is DROPPED — that is what
         un-breaks the explicit ``SELECT`` projection ``resolve_node_columns``
         builds from this list.
      4. Ordering: survivors in their original stored order, then new columns in
         live order. Order is load-bearing — it becomes the SQL projection order.

    A stored property whose name collides with a structural column is silently
    dropped (never survives, never reported) — that is nonsensical input that
    diff_table treats the same way.
    """
    stored_by_name: dict[str, Any] = {}
    for prop in stored_props or []:
        name = _property_name(prop)
        if name:
            stored_by_name[name] = prop

    live_by_name: dict[str, Any] = {}
    live_order: list[str] = []
    for col in live_columns or []:
        name = _column_name(col)
        if name and name not in structural_names:
            live_by_name[name] = col
            live_order.append(name)

    result: list[dict[str, Any]] = []
    seen: set[str] = set()

    for name, prop in stored_by_name.items():
        live_col = live_by_name.get(name)
        if live_col is None:
            continue
        result.append(
            {
                "name": name,
                "data_type": _column_data_type(live_col) or _property_data_type(prop),
                "display_name": _property_display_name(prop),
                "description": _property_description(prop),
            }
        )
        seen.add(name)

    for name in live_order:
        if name in seen:
            continue
        result.append(
            {
                "name": name,
                "data_type": _column_data_type(live_by_name[name]),
                "display_name": None,
                "description": None,
            }
        )
        seen.add(name)

    return result


def compute_drift(
    context,
    node_table_reachable: bool,
    node_live_columns: Optional[list],
    edge_table_reachable: bool,
    edge_live_columns: Optional[list],
    discovered_node_types: Optional[list[str]] = None,
    discovered_relationship_types: Optional[list[str]] = None,
) -> dict[str, Any]:
    """Orchestrate the full drift report for a context. Pure — callers own all I/O.

    Args mirror what a caller gets back from two ``WarehouseClient.get_table_schema``
    calls (each caught independently, so one bad table still yields a useful diff)
    and an optional ``discover_schema`` call.
    """
    roles = structural_roles(context)
    node_structural_names = {
        col for role, (side, col) in roles.items() if side == "node"
    }
    edge_structural_names = {
        col for role, (side, col) in roles.items() if side == "edge"
    }

    findings: list[Finding] = []

    node_table_name = _get(context, "node_table_name")
    edge_table_name = _get(context, "edge_table_name")

    if not node_table_reachable:
        findings.append(
            Finding(
                code="TABLE_NOT_FOUND",
                severity="error",
                side="node",
                kind="table",
                name=node_table_name,
                stored=None,
                live=None,
                message=f"Node table `{node_table_name}` could not be found or described.",
                auto_fixable=False,
            )
        )
    else:
        findings.extend(
            diff_table(
                "node",
                node_table_name,
                _get(context, "node_properties"),
                node_live_columns,
                node_structural_names,
            )
        )

    if not edge_table_reachable:
        findings.append(
            Finding(
                code="TABLE_NOT_FOUND",
                severity="error",
                side="edge",
                kind="table",
                name=edge_table_name,
                stored=None,
                live=None,
                message=f"Edge table `{edge_table_name}` could not be found or described.",
                auto_fixable=False,
            )
        )
    else:
        findings.extend(
            diff_table(
                "edge",
                edge_table_name,
                _get(context, "edge_properties"),
                edge_live_columns,
                edge_structural_names,
            )
        )

    findings.extend(
        diff_structure(
            context,
            node_live_columns,
            edge_live_columns,
            node_table_reachable,
            edge_table_reachable,
        )
    )

    findings.extend(
        diff_types(
            _get(context, "node_types"),
            _get(context, "relationship_types"),
            discovered_node_types,
            discovered_relationship_types,
        )
    )

    proposed_node_properties = (
        merge_properties(
            _get(context, "node_properties"), node_live_columns, node_structural_names
        )
        if node_table_reachable
        else [_property_to_dict(p) for p in (_get(context, "node_properties") or [])]
    )
    proposed_edge_properties = (
        merge_properties(
            _get(context, "edge_properties"), edge_live_columns, edge_structural_names
        )
        if edge_table_reachable
        else [_property_to_dict(p) for p in (_get(context, "edge_properties") or [])]
    )

    return {
        "status": overall_status(findings),
        "counts": counts_by_severity(findings),
        "findings": findings,
        "proposed_node_properties": proposed_node_properties,
        "proposed_edge_properties": proposed_edge_properties,
        "proposed_node_types": discovered_node_types,
        "proposed_relationship_types": discovered_relationship_types,
    }


class ContextValidationError(Exception):
    """Raised by ``validate_context_tables`` — a malformed table name or a
    structural column absent from the live table. Callers catch this and turn
    it into a 400 with ``code``/``details`` in the response envelope.
    """

    def __init__(self, code: str, message: str, details: Optional[dict] = None):
        self.code = code
        self.message = message
        self.details = details or {}
        super().__init__(message)


async def validate_context_tables(
    warehouse,
    node_table_name: str,
    edge_table_name: str,
    node_structure: Optional[dict] = None,
    edge_structure: Optional[dict] = None,
) -> None:
    """Validate a context's table names and structural columns before create/update
    accepts them.

    Table-name shape is always checked (cheap, no I/O). Structural columns are
    checked against the live table ONLY when that table can be described — an
    unreachable warehouse (down, dev mode without it running) means validation
    is skipped, not failed: a context edit must never be blocked by warehouse
    unavailability. Raises ``ContextValidationError``; callers map it to a 400.
    """
    for table_name in (node_table_name, edge_table_name):
        if parse_qualified_table(table_name) is None:
            raise ContextValidationError(
                "CONTEXT_TABLE_INVALID",
                f"'{table_name}' is not a valid table name (expected "
                "'database.table' or 'catalog.database.table').",
                {"table": table_name},
            )

    structures = {"node": node_structure or {}, "edge": edge_structure or {}}
    table_names = {"node": node_table_name, "edge": edge_table_name}
    missing: list[dict[str, str]] = []

    for side, structure in structures.items():
        if not structure:
            continue
        catalog, database, table = parse_qualified_table(table_names[side])
        try:
            table_schema = await warehouse.get_table_schema(table, database, catalog)
        except Exception:
            continue  # unreachable — best-effort, never blocks the edit
        if not table_schema.columns:
            continue  # unreachable (DESCRIBE failed silently) — same as above
        live_names = {c.name for c in table_schema.columns}
        for role, col in structure.items():
            if col and col not in live_names:
                missing.append({"side": side, "role": role, "column": col})

    if missing:
        raise ContextValidationError(
            "CONTEXT_STRUCTURE_INVALID",
            "One or more structural columns do not exist in the live table.",
            {"missing_columns": missing},
        )
