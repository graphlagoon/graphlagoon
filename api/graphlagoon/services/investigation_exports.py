"""Case exports (05 §7): ``GET …/export?format=``.

- ``json``: the package (case, decision, frozen hash and whether it still
  verifies, items with their pinned versions = the evidence, annotations,
  journal);
- ``csv``: the same record flattened, one row per item, through the M4-safe
  writer (``utils.csv_safe``);
- ``simba``: a zip with the case's transactions in the SIMBA v3.1 layout,
  which the ``simba_v31`` file-mapping preset reads back, plus ``MANIFEST.json``;
- ``siscoaf``: a structured summary to paste into Siscoaf (README Q6: no API).

The laudo (PDF) is the print of the dossier screen, not a server format.
Every format verifies ``frozen_hash``; the route audits each export with its
sha256. Exports are reads: nothing is journaled and nothing is stored.
"""

from __future__ import annotations

import hashlib
import io
import json
import re
import zipfile
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Optional
from uuid import UUID

from graphlagoon.services import case_annotations, case_items
from graphlagoon.services import cases as service
from graphlagoon.services.case_graph import case_graph
from graphlagoon.services.file_mapping_presets import SIMBA_V31
from graphlagoon.utils.csv_safe import to_csv

FORMATS = ("json", "csv", "simba", "siscoaf")


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
                    "id", "title", "description", "owner_email", "assignee_email", "status", "kind_preset",
                    "tags", "occurred_at", "alert_at", "created_at", "decision", "frozen_at",
                )
            },
            "frozen_hash": case["frozen_hash"],
            "frozen_hash_valid": await service.verify_frozen_hash(investigation_id, user_email),
            "roles": roles,
            "hypotheses": [a for a in annotations if a["kind"] == "hypothesis"],
            "annotations": annotations,
            "items": items,
            "evidence": evidence,
            "trace_methods": trace_methods,
            "events": events,
        }
    )


def _canon(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, default=str)


def package_csv(p: dict) -> str:
    """One row per item of the package: section, id, title, kind, sha256,
    detail (parameters, payload, text), actor, at."""
    c, d = p["case"], p["case"]["decision"]
    rows = [["case", c["id"], c["title"], c["status"], p["frozen_hash"], c["description"], c["owner_email"], c["created_at"]]]
    if d:
        rows.append(["decision", "", d["outcome"], ",".join(d["actions"]), p["frozen_hash"], d["rationale"], d["decided_by"], d["decided_at"]])
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
        ["annotation", a["id"], "", a["kind"], "", _canon({"targets": a["targets"], "value": a["value"], "status": a["status"]}),
         a["author_email"], a["created_at"]]
        for a in p["annotations"]
    ]
    rows += [
        ["event", e["id"], "", e["kind"], "", _canon(e["payload"]), e["actor_email"], e["at"]]
        for e in p["events"]
    ]
    return to_csv(["section", "id", "title", "kind", "sha256", "detail", "actor", "at"], rows)


# ---------------------------------------------------------------------------
# SIMBA v3.1 (01-pesquisa-brasil; the F2.4 preset is the reader)
# ---------------------------------------------------------------------------

EXTRATO_COLS = ["CODIGO_CHAVE_EXTRATO", "NUMERO_BANCO", "NUMERO_AGENCIA", "NUMERO_CONTA",
                "DATA_LANCAMENTO", "DESCRICAO", "TIPO_LANCAMENTO", "VALOR", "NATUREZA"]
OD_COLS = ["CODIGO_CHAVE_OD", "CODIGO_CHAVE_EXTRATO", "VALOR_TRANSACAO", "NUMERO_BANCO_OD",
           "NUMERO_AGENCIA_OD", "NUMERO_CONTA_OD", "TIPO_PESSOA_OD", "CPF_CNPJ_OD",
           "NOME_PESSOA_OD", "OBSERVACAO"]
TITULARES_COLS = ["NUMERO_BANCO", "NUMERO_AGENCIA", "NUMERO_CONTA", "TIPO_TITULAR",
                  "CPF_CNPJ_TITULAR", "NOME_TITULAR", "VALOR_RENDA"]
# Edge type → TIPO_LANCAMENTO: the first code the preset maps to it; an
# unknown type is written as is (the preset keeps unmapped values).
_TIPO = {
    v: k for k, v in reversed(list(SIMBA_V31["tables"]["simba_tipo_lancamento"].items()))
}
NAO_CORRENTISTA = "9999"


def _cell(value: Any) -> str:
    return "" if value is None else re.sub(r"[\t\r\n]+", " ", str(value)).strip()


def _tail(node: dict) -> str:
    """The node's own id: ``entity:value`` → value, ``id@context`` → id."""
    uid = node["uid"]
    return uid.split(":", 1)[1] if node.get("entity") else uid.rsplit("@", 1)[0]


def _account(node: dict, fallback: bool = False) -> Optional[tuple[str, str, str]]:
    """(banco, agência, conta) from the node's properties, or with ``fallback``
    its id as the account number (the preset's account normalizer keeps it)."""
    p = node["properties"]
    if p.get("conta") not in (None, ""):
        return (_cell(p.get("banco")), _cell(p.get("agencia")), _cell(p["conta"]))
    if fallback and re.search(r"\d", _tail(node)):
        return ("", "", _cell(_tail(node)))
    return None


def _document(node: dict) -> Optional[str]:
    p = node["properties"]
    for key in ("cpf_cnpj", "cpf", "cnpj", "documento", "document"):
        if p.get(key):
            return _cell(p[key])
    tail = _tail(node)
    return tail if node.get("entity") and re.fullmatch(r"\d{11}|\d{14}", tail) else None


def _name(node: dict) -> Optional[str]:
    p = node["properties"]
    return next((_cell(p[k]) for k in ("nome", "name", "razao_social", "label", "title") if p.get(k)), None)


def _date(t: Optional[int]) -> str:
    # Local time, as the trace reads a bare date (services.trace.parse_time).
    return datetime.fromtimestamp(t / 1000).strftime("%d%m%Y") if t is not None else ""


def _cents(value: Any) -> str:
    return str(round(value * 100)) if isinstance(value, (int, float)) else ""


def simba_tables(graph: dict) -> tuple[list[list[str]], list[list[str]], list[list[str]], int]:
    """EXTRATO, ORIGEM_DESTINO and TITULARES rows of the unified case graph,
    and how many money edges could not be written (no account on either end).

    A money edge (with an amount) is one lançamento of the endpoint that has
    an account (``banco``/``agencia``/``conta`` properties; else the source,
    else the target, by its id): debit (D) when money leaves it. The other end
    is the counterpart: its document and name, or agency 9999
    (NAO-CORRENTISTA) when it has no document. ``TITULAR`` edges become the
    holders file. shortcut: an account-to-account edge whose counterpart has
    no document reads back as an unknown counterpart."""
    nodes = {n["uid"]: n for n in graph["nodes"]}
    extrato, od, titulares, seen, skipped = [], [], [], set(), 0
    edges = sorted(graph["edges"], key=lambda e: (e.get("t") or 0, e["id"]))
    for e in edges:
        src, dst = nodes[e["src"]], nodes[e["dst"]]
        if e.get("amount") is None:
            if str(e.get("type")).upper() == "TITULAR":
                holder, acc = (src, _account(dst)) if _account(dst) else (dst, _account(src))
                if acc and _document(holder):
                    titulares.append([*acc, "T", _document(holder), _name(holder) or "",
                                      _cents(holder["properties"].get("renda"))])
            continue
        if _account(src):
            me, other, nature = src, dst, "D"
        elif _account(dst):
            me, other, nature = dst, src, "C"
        elif _account(src, fallback=True):
            me, other, nature = src, dst, "D"
        elif _account(dst, fallback=True):
            me, other, nature = dst, src, "C"
        else:
            skipped += 1
            continue
        code = e["id"].split(":", 1)[-1]
        code = e["id"] if code in seen else code
        seen.add(code)
        key = f"E{len(extrato) + 1}"
        props = e.get("properties") or {}
        extrato.append([
            key, *_account(me, fallback=True), _date(e.get("t")),
            _cell(props.get("descricao") or props.get("description") or e.get("type")),
            _TIPO.get(e.get("type"), _cell(e.get("type"))), _cents(e["amount"]), nature,
        ])
        doc = _document(other)
        if doc is None or other.get("type") == "Desconhecido":
            label = other["properties"].get("observacao") or f"SEM DOCUMENTO: {_name(other) or _tail(other)}"
            od.append([code, key, _cents(e["amount"]), "", NAO_CORRENTISTA, "", "", "", "", _cell(label)])
        else:
            digits = re.sub(r"\D", "", doc)
            kind = {11: "F", 14: "J"}.get(len(digits), "")
            acc = _account(other) or ("", "", "")
            od.append([code, key, _cents(e["amount"]), *acc, kind, doc, _name(other) or "", ""])
    return extrato, od, titulares, skipped


def _tsv(header: list[str], rows: list[list[str]]) -> bytes:
    lines = ["\t".join(header), *("\t".join(_cell(c) for c in r) for r in rows)]
    return ("\n".join(lines) + "\n").encode("latin-1", errors="replace")


async def simba_zip(investigation_id: UUID, user_email: str, p: dict) -> bytes:
    graph = await case_graph(investigation_id, user_email)
    extrato, od, titulares, skipped = simba_tables(graph)
    prefix = f"CASO_{str(investigation_id)[:8].upper()}"
    files = {
        f"{prefix}_EXTRATO.TXT": _tsv(EXTRATO_COLS, extrato),
        f"{prefix}_ORIGEM_DESTINO.TXT": _tsv(OD_COLS, od),
        f"{prefix}_TITULARES.TXT": _tsv(TITULARES_COLS, titulares),
    }
    manifest = {
        "layout": "SIMBA v3.1 (MI001-SPPEA): TAB, Latin-1, ddmmyyyy, cents",
        "read_back_with": "file mapping preset simba_v31",
        "case": {"id": p["case"]["id"], "title": p["case"]["title"]},
        "exported_at": p["exported_at"],
        "exported_by": p["exported_by"],
        "frozen_hash": p["frozen_hash"],
        "transactions": len(extrato),
        "skipped_without_account": skipped,
        "restricted_sources": graph["restricted_sources"],
        "sha256": {name: hashlib.sha256(data).hexdigest() for name, data in files.items()},
        "evidence": [{k: e[k] for k in ("title", "version", "sha256")} for e in p["evidence"]],
        "trace_methods": p["trace_methods"],
    }
    files["MANIFEST.json"] = _dumps(manifest)
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in files.items():
            z.writestr(zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0)), data)
    return out.getvalue()


# ---------------------------------------------------------------------------
# Siscoaf summary (README Q6: structured summary only, pasted by a person)
# ---------------------------------------------------------------------------


async def siscoaf_summary(investigation_id: UUID, user_email: str, p: dict) -> dict:
    graph = await case_graph(investigation_id, user_email)
    nodes = {n["uid"]: n for n in graph["nodes"]}
    involved = []
    for uid, role in sorted(p["roles"].items()):
        if role == "discarded":
            continue
        n = nodes.get(uid)
        acc = _account(n) if n else None
        involved.append({
            "entity": uid,
            "role": role,
            "type": n["type"] if n else None,
            "name": _name(n) if n else None,
            "document": _document(n) if n else None,
            "account": "/".join(a for a in acc if a) if acc else None,
        })
    ids = {i["entity"] for i in involved}
    money = [e for e in graph["edges"] if e.get("amount") is not None and (e["src"] in ids or e["dst"] in ids)]
    times = sorted(e["t"] for e in money if e.get("t") is not None)
    day = lambda t: datetime.fromtimestamp(t / 1000).date().isoformat()  # noqa: E731
    badges = {}
    for a in p["annotations"]:
        if a["kind"] == "typology" and a["status"] == "confirmed":
            v = a["value"]
            badges[v.get("typology")] = {"norm_ref": v.get("norm_ref"), "label": v.get("label"), "entities": len(a["targets"])}
    decision = p["case"]["decision"]
    return {
        "format": "siscoaf-summary",
        "version": 1,
        "note": "Structured summary for a person to paste into Siscoaf; this app does not send communications.",
        "case": {k: p["case"][k] for k in ("id", "title", "kind_preset", "tags", "created_at")},
        "ready_to_communicate": bool(decision and decision["outcome"] == "comunicar"),
        "decision": decision,
        "involved": involved,
        "transactions": {
            "count": len(money),
            "total": round(sum(e["amount"] for e in money), 2),
            "first_date": day(times[0]) if times else None,
            "last_date": day(times[-1]) if times else None,
        },
        "typologies": list(badges.values()),
        "narrative": "\n\n".join(x for x in (p["case"]["description"], decision and decision["rationale"]) if x),
        "evidence": [
            {"label": f"E{i}", "title": e["title"], "kind": e["kind"], "version": e["version"], "sha256": e["sha256"]}
            for i, e in enumerate(p["evidence"], 1)
        ],
        "trace_methods": p["trace_methods"],
        "frozen_hash": p["frozen_hash"],
        "frozen_hash_valid": p["frozen_hash_valid"],
        "restricted_sources": graph["restricted_sources"],
        "exported_at": p["exported_at"],
        "exported_by": p["exported_by"],
    }


async def export(investigation_id: UUID, user_email: str, fmt: str) -> Export:
    p = await package(investigation_id, user_email)
    base = f"investigation-{str(investigation_id)[:8]}"
    if fmt == "csv":
        return Export(package_csv(p).encode("utf-8-sig"), f"{base}.csv", "text/csv")
    if fmt == "simba":
        return Export(await simba_zip(investigation_id, user_email, p), f"{base}-simba.zip", "application/zip")
    if fmt == "siscoaf":
        summary = await siscoaf_summary(investigation_id, user_email, p)
        return Export(_dumps(summary), f"{base}-siscoaf.json", "application/json")
    return Export(_dumps(p), f"{base}.json", "application/json")
