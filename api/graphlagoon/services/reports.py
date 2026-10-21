"""Report templates (06 §1): an org library doc of kind ``template`` is markdown
with ``{{placeholders}}``; rendering one over a case makes a ``document/markdown``
item, a draft a person edits, pins and prints. Org- or regulator-specific
reports (a SAR narrative, a merchant offboarding memo, a chargeback
representment) are templates, not code.

The placeholders are ``PLACEHOLDERS`` below (one source for the renderer, the
admin area's help and the AI prompts); unknown ones stay in the text and the
item's provenance lists them.
"""

from __future__ import annotations

import re
from datetime import datetime
from typing import Any, Optional
from uuid import UUID

from graphlagoon.services import case_annotations, case_items, case_types, org_library
from graphlagoon.services import cases as service

PLACEHOLDER = re.compile(r"\{\{\s*([a-z_][a-z0-9_]*(?:\.[a-z0-9_]+)*)\s*\}\}", re.IGNORECASE)
NAME_KEYS = ("name", "display_name", "full_name", "legal_name", "title", "label")

# key → what it becomes. ``fields.<id>`` stands for one field of the case type.
PLACEHOLDERS: dict[str, str] = {
    "case.title": "the case title",
    "case.number": "the short case number (#0412aa)",
    "case.id": "the case id",
    "case.type": "the case type's label",
    "case.status": "open, analysis or closed",
    "case.stage": "the case's stage, or —",
    "case.owner": "the owner's e-mail",
    "case.assignee": "the assignee's e-mail, or —",
    "case.description": "the case description",
    "case.external_ref": "the alert or ticket id that opened the case",
    "case.created_at": "when the case was opened",
    "case.occurred_at": "when the facts happened",
    "case.alert_at": "when the alert came in",
    "fields.<id>": "one field of the case type (money with two decimals)",
    "fields": "every field of the case type, a bullet list label: value",
    "today": "today's date",
    "now": "the date and time of the rendering",
    "user": "who renders the report",
    "brief": "the case brief (markdown)",
    "decisions": "every decision, a bullet list (D1 · outcome on targets — who, when)",
    "decision.outcome": "the last decision's outcome label",
    "decision.rationale": "the last decision's rationale",
    "decision.decided_by": "who recorded the last decision",
    "decision.decided_at": "when the last decision was recorded",
    "decision.targets": "the entities the last decision is about, or 'the whole case'",
    "decision.hash": "the last decision's sha256",
    "decision.review": "the last decision's review state (pending, approved, rejected), or —",
    "evidence": "the pinned versions, E1, E2… with their sha256, a bullet list",
    "hypotheses": "the confirmed hypotheses with their status, a bullet list",
    "roles": "the entities with a confirmed role (entity — role), a bullet list",
    "tasks": "the open tasks with assignee and due time, a bullet list",
}


def _fmt(value: Any, kind: str = "text") -> str:
    if value is None or value == "":
        return "—"
    if kind == "money" and isinstance(value, (int, float)):
        return f"{value:,.2f}"
    if isinstance(value, list):
        return ", ".join(str(v) for v in value) or "—"
    return str(value)


def _bullets(lines: list[str], empty: str) -> str:
    return "\n".join(f"- {line}" for line in lines) if lines else f"_{empty}_"


def _labels(graph: dict) -> dict[str, str]:
    out = {}
    for n in graph.get("nodes") or []:
        props = n.get("properties") or {}
        name = next((props[k] for k in NAME_KEYS if props.get(k)), None)
        out[n["uid"]] = f"{name} ({n['type']})" if name else f"{n['type']} {n['uid'].split('@')[0]}"
    return out


async def context(investigation_id: UUID, user_email: str) -> dict[str, str]:
    """Every placeholder's text for this case, as the caller reads it."""
    from graphlagoon.services.case_graph import case_graph

    case = await service.get_investigation(investigation_id, user_email)
    kind = await case_types.get_case_type(case["case_type"]) or {"label": case["case_type"], "fields": []}
    items = await case_items.list_items(investigation_id, user_email)
    annotations = await case_annotations.list_annotations(investigation_id, user_email)
    brief = await case_items.get_brief(investigation_id, user_email)
    try:
        labels = _labels(await case_graph(investigation_id, user_email))
    except service.InvestigationError:
        labels = {}
    name = lambda uid: labels.get(uid, uid)  # noqa: E731
    now = datetime.now()
    ctx: dict[str, str] = {
        "case.title": case["title"],
        "case.number": f"#{str(case['id']).replace('-', '')[:6]}",
        "case.id": str(case["id"]),
        "case.type": kind["label"],
        "case.status": case["status"],
        "case.stage": _fmt(case.get("stage")),
        "case.owner": case["owner_email"],
        "case.assignee": _fmt(case.get("assignee_email")),
        "case.description": _fmt(case.get("description")),
        "case.external_ref": _fmt(case.get("external_ref")),
        "case.created_at": _fmt(case.get("created_at"))[:16],
        "case.occurred_at": _fmt(case.get("occurred_at"))[:16],
        "case.alert_at": _fmt(case.get("alert_at"))[:16],
        "today": now.date().isoformat(),
        "now": now.isoformat(timespec="minutes"),
        "user": user_email,
        "brief": brief["text"].strip() or "_No brief yet._",
    }
    values = case.get("fields") or {}
    for f in kind.get("fields") or []:
        ctx[f"fields.{f['id']}"] = _fmt(values.get(f["id"]), f["type"])
    ctx["fields"] = _bullets([f"{f['label']}: {ctx[f'fields.' + f['id']]}" for f in kind.get("fields") or []], "No fields.")

    decisions = case.get("decisions") or []
    ctx["decisions"] = _bullets(
        [
            f"D{i} · {d['outcome_label']}"
            + (f" on {', '.join(name(t) for t in d['targets'])}" if d["targets"] else "")
            + f" — {d['decided_by']}, {d['decided_at'][:16]}"
            + (f" ({d['review']})" if d.get("review") else "")
            for i, d in enumerate(decisions, 1)
        ],
        "No decision yet.",
    )
    last = decisions[-1] if decisions else {}
    ctx.update({
        "decision.outcome": _fmt(last.get("outcome_label")),
        "decision.rationale": _fmt(last.get("rationale")),
        "decision.decided_by": _fmt(last.get("decided_by")),
        "decision.decided_at": _fmt(last.get("decided_at"))[:16],
        "decision.targets": ", ".join(name(t) for t in last.get("targets") or []) or "the whole case",
        "decision.hash": _fmt(last.get("hash")),
        "decision.review": _fmt(last.get("review")),
    })

    pinned = sorted(
        ((i, v) for i in items for v in i["pinned"]), key=lambda p: str(p[1].get("pinned_at") or "")
    )
    ctx["evidence"] = _bullets(
        [f"E{n} {i['title']} (v{v['version']}, sha256 {v['sha256']})" for n, (i, v) in enumerate(pinned, 1)],
        "Nothing pinned.",
    )
    confirmed = [a for a in annotations if a["status"] == "confirmed"]
    ctx["hypotheses"] = _bullets(
        [f"{a['value'].get('text')} ({a['value'].get('status', 'open')})" for a in confirmed if a["kind"] == "hypothesis"],
        "No hypotheses.",
    )
    ctx["roles"] = _bullets(
        [f"{name(a['targets'][0])} — {a['value'].get('role')}" for a in confirmed if a["kind"] == "role" and a["targets"]],
        "No roles.",
    )
    ctx["tasks"] = _bullets(
        [
            f"{a['value'].get('title')}"
            + (f" · {a['value']['assignee']}" if a["value"].get("assignee") else "")
            + (f" · due {str(a['value']['due_at'])[:16]}" if a["value"].get("due_at") else "")
            for a in confirmed
            if a["kind"] == "task" and a["value"].get("state") == "open"
        ],
        "No open tasks.",
    )
    return ctx


def render(body: str, ctx: dict[str, str]) -> tuple[str, list[str]]:
    """(text, the placeholders the case had no value for)."""
    unknown: list[str] = []

    def sub(m: re.Match) -> str:
        key = m.group(1).lower()
        if key in ctx:
            return ctx[key]
        unknown.append(key)
        return m.group(0)

    return PLACEHOLDER.sub(sub, body), sorted(set(unknown))


async def render_report(investigation_id: UUID, user_email: str, slug: str, title: Optional[str] = None) -> dict:
    """Renders template ``slug`` into a new ``document/markdown`` item. An agent's
    report arrives suggested (a person approves the draft); a closed case still
    takes one, outside its decisions' hashes, like its tasks."""
    doc = await org_library.get_doc(slug)
    if doc is None or doc["kind"] != "template":
        raise service.InvestigationError(404, "TEMPLATE_NOT_FOUND", f"No report template '{slug}' in the org library")
    ctx = await context(investigation_id, user_email)
    text, unknown = render(doc["body"], ctx)
    data = {
        "kind": "document",
        "subkind": "markdown",
        "title": (title or "").strip() or f"{doc['title']} · {ctx['case.number']}",
        "provenance": {"tool": "report", "template": slug, **({"unknown_placeholders": unknown} if unknown else {})},
    }
    status = "suggested" if service.get_current_actor() else None
    return await case_items.create_item(
        investigation_id, user_email, data, text.encode("utf-8"), "text/markdown", status=status, allow_closed=True
    )
