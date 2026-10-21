"""Case exports (05 §7): ``GET …/export?format=``.

- ``json``: the package (case, decisions, ``integrity`` = each decision's hash
  recomputed and whether it still verifies, items with their pinned versions =
  the evidence, the tables and query runs flagged for the dossier, annotations,
  journal);
- ``csv``: the same record flattened, one row per item, through the M4-safe
  writer (``utils.csv_safe``).

The printed report is the print of the dossier screen, not a server format;
regulator- or org-specific formats are report templates (06 §1), not code.
Every format verifies the decisions' hashes; the route audits each export with its
sha256. Exports are reads: nothing is journaled and nothing is stored.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import datetime
from typing import Any
from uuid import UUID

from graphlagoon.services import case_annotations, case_items
from graphlagoon.services import cases as service
from graphlagoon.utils.csv_safe import to_csv

FORMATS = ("json", "csv")
DOSSIER_TAG = "dossier"  # the frontend's "use in the dossier" flag on an item


@dataclass
class Export:
    data: bytes
    filename: str
    media_type: str

    @property
    def sha256(self) -> str:
        return hashlib.sha256(self.data).hexdigest()


def _plain(value: Any) -> Any:
    """UUIDs and datetimes as strings, like the API responses."""
    return json.loads(json.dumps(value, default=str))


def _dumps(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, indent=2, default=str).encode("utf-8")


async def package(investigation_id: UUID, user_email: str) -> dict:
    case = await service.get_investigation(investigation_id, user_email)
    items = await case_items.list_items(investigation_id, user_email)
    annotations = await case_annotations.list_annotations(investigation_id, user_email)
    events = await service.list_events(investigation_id, user_email, limit=10**9)
    evidence = [
        {"item_id": i["id"], "title": i["title"], "kind": i["kind"], "subkind": i["subkind"], **v}
        for i in items
        for v in i["pinned"]
    ]
    # "Use in the dossier": the latest run/version of the tables flagged for the report.
    dossier = [
        {"item_id": i["id"], "title": i["title"], "kind": i["kind"], "subkind": i["subkind"], **i["latest"]}
        for i in items
        if DOSSIER_TAG in i["tags"] and i["latest"]
    ]
    checks = await service.verify_decisions(investigation_id, user_email)
    trace_methods = [
        {"item_id": i["id"], "title": i["title"], "method": (i["provenance"] or {}).get("params")}
        for i in items
        if (i["provenance"] or {}).get("tool") == "trace"
    ] + [{"event_id": e["id"], "at": e["at"], "method": e["payload"]} for e in events if e["kind"] == "trace.run"]
    roles = {a["targets"][0]: a["value"]["role"] for a in annotations if a["kind"] == "role" and a["status"] == "confirmed"}
    return _plain(
        {
            "format": "graphlagoon.investigation",
            "version": 2,
            "exported_at": datetime.now().isoformat(),
            "exported_by": user_email,
            "case": {
                k: case[k]
                for k in (
                    "id", "title", "description", "owner_email", "assignee_email", "status", "stage", "case_type", "fields",
                    "external_ref", "tags", "occurred_at", "alert_at", "created_at", "frozen_hash", "frozen_at",
                )
            },
            "decisions": case["decisions"],
            # Each decision's hash recomputed from the journal and its evidence; None without decisions.
            "integrity": {"decisions": checks, "verified": all(c["verified"] for c in checks) if checks else None},
            "roles": roles,
            "hypotheses": [a for a in annotations if a["kind"] == "hypothesis"],
            "annotations": annotations,
            "items": items,
            "evidence": evidence,
            "dossier": dossier,
            "trace_methods": trace_methods,
            "events": events,
        }
    )


def _canon(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, default=str)


def package_csv(p: dict) -> str:
    """One row per item of the package: section, id, title, kind, sha256,
    detail (parameters, payload, text), actor, at."""
    c = p["case"]
    rows = [["case", c["id"], c["title"], c["status"], c["frozen_hash"], c["description"], c["owner_email"], c["created_at"]]]
    rows += [
        ["decision", d["id"], d["outcome_label"], "closes the case" if d["closes_case"] else "", d["hash"],
         _canon({k: d.get(k) for k in ("rationale", "targets", "evidence", "task_ids", "review")}), d["decided_by"], d["decided_at"]]
        for d in p["decisions"]
    ]
    rows += [
        ["item", i["id"], i["title"], f"{i['kind']}/{i['subkind']}", (i["latest"] or {}).get("sha256"),
         _canon({k: i[k] for k in ("status", "provenance", "query", "mapping") if i.get(k)}), i["author_email"], i["created_at"]]
        for i in p["items"]
    ]
    rows += [
        ["evidence", e["item_id"], e["title"], f"v{e['version']}", e["sha256"], e.get("pin_label") or "", e.get("pinned_by"), e.get("pinned_at")]
        for e in p["evidence"]
    ]
    rows += [
        ["dossier", d["item_id"], d["title"], f"v{d['version']}", d["sha256"], _canon(d.get("run") or {}), d.get("created_by"), d.get("created_at")]
        for d in p["dossier"]
    ]
    rows += [
        ["annotation", a["id"], "", a["kind"], "", _canon({"targets": a["targets"], "value": a["value"], "status": a["status"]}),
         a["author_email"], a["created_at"]]
        for a in p["annotations"]
    ]
    rows += [
        ["event", e["id"], "", e["kind"], "", _canon(e["payload"]), e["actor_email"], e["at"]]
        for e in p["events"]
    ]
    return to_csv(["section", "id", "title", "kind", "sha256", "detail", "actor", "at"], rows)


async def export(investigation_id: UUID, user_email: str, fmt: str) -> Export:
    p = await package(investigation_id, user_email)
    base = f"investigation-{str(investigation_id)[:8]}"
    if fmt == "csv":
        return Export(package_csv(p).encode("utf-8-sig"), f"{base}.csv", "text/csv")
    return Export(_dumps(p), f"{base}.json", "application/json")
