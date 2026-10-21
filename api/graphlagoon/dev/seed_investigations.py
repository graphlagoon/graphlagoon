"""Dev seed for investigations (06-plataforma-generica): realistic cases on a *running* API.

    uv run python -m graphlagoon.dev.seed_investigations --api http://localhost:8000 \\
        [--cases 8] [--seed 42] [--reset]

Works with nothing but the API (memory mode, no warehouse). Four scenarios from
different domains, each a case of items and annotations (05 §1), then
generated cases:

1. **Mule network** (flow trace): the T5 design graph
   (``trace/flow-chain.json``) as a graph snapshot, a server trace saved and
   pinned ("Trace #1"), agent roles and a brief.
2. **Fraud ring** (shared devices): sign-ups CSV mapped to people and the
   phones, e-mails, devices, IPs, cards and addresses they use; a group and the
   agent's role suggestions.
3. **Credit review** (economic group): companies and partners CSV as a graph,
   a guarantees CSV as enrichment, a saved SQL query, a group, the agent's
   same_as suggestion and brief.
4. **Insider data access**: access log CSV (who read what, when, how much),
   hypotheses and notes.

Agent writes use an agent token (``GRAPH_LAGOON_AGENTS_ENABLED=true``;
without it the owner writes them). Seeded cases carry ``[seed:investigations]``
in the description. A rerun adds more; ``--reset`` first deletes the seeded
cases (superuser, ``?reason=`` for retained ones).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import random
import sys
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Optional

from graphlagoon.dev.seed import ADMIN_EMAIL, SEED_DOMAIN, SeedClient, SeedError, wait_for_health

MARKER = "[seed:investigations]"
FLOW_CHAIN = Path(__file__).resolve().parents[3] / "frontend/src/__tests__/fixtures/trace/flow-chain.json"
# The Brazilian example of the dev seed (06 P5): bank statements in the SIMBA layout.
BANK_STATEMENTS = Path(__file__).resolve().parents[3] / "frontend/src/__tests__/fixtures/fileMapping/bank-statements"
ANALYSTS = [
    f"{name}@{SEED_DOMAIN}"
    for name in ("ana.ribeiro", "bruno.tavares", "carla.mendes", "diego.farias", "elisa.moura", "fabio.nunes")
]
# Rotates per agent token below this, under the API's 120 requests/minute.
AGENT_TOKEN_BUDGET = 100
FIRST = ["Maria", "James", "Ana", "Chen", "Fatima", "Lukas", "Priya", "Carlos",
         "Sofia", "Kenji", "Amara", "Noah", "Elena", "Omar", "Grace", "Mateo"]
LAST = ["Silva", "Smith", "Okafor", "Muller", "Garcia", "Kowalski", "Nguyen", "Rossi",
        "Haddad", "Johansson", "Tanaka", "Dubois", "Patel", "Novak", "Moreau", "Reyes"]

# Case types of the dev org (06 §1): data an admin would write in the admin area.
CASE_TYPES: dict[str, dict] = {
    "fraud_ring": {
        "label": "Fraud ring",
        "description": "People, accounts and devices acting together: mules, synthetic identities, account takeover.",
        "vocabularies": {
            "roles": ["victim", "mule", "ring member", "organizer", "cash-out point", "real customer"],
            "tags": ["account takeover", "synthetic identity", "card testing", "needs KYC"],
            "link_attributes": ["phone", "email", "device_id", "ip", "card", "address"],
        },
        "outcomes": [
            {"id": "report_authorities", "label": "Report to the authorities", "closes_case": True, "requires_review": True},
            {"id": "close_no_action", "label": "Close with no action", "closes_case": True},
            {"id": "monitor", "label": "Keep monitoring", "closes_case": False},
        ],
        "actions": [
            {"id": "block_accounts", "label": "Block the accounts", "due_hours": 2},
            {"id": "notify_partner", "label": "Notify the partner institution", "due_hours": 24},
            {"id": "file_report", "label": "File the report", "due_hours": 720},
        ],
        "stages": ["Awaiting the customer", "Escalated"],
        "fields": [
            {"id": "alert_id", "label": "Alert", "type": "text", "in_queue": True},
            {"id": "amount_at_risk", "label": "Amount at risk", "type": "money", "in_queue": True},
            {"id": "channel", "label": "Channel", "type": "enum", "options": ["card", "transfer", "wallet", "other"]},
        ],
        "sla_hours": {"open": 240, "analysis": 480},
        "notice": "Do not tell the people under investigation that a case exists.",
        "playbook": "triage",
    },
    "credit_review": {
        "label": "Credit review",
        "description": "A limit request for a company or an economic group: who controls whom, where the guarantees are.",
        "vocabularies": {
            "roles": ["borrower", "guarantor", "controller", "related party"],
            "tags": ["economic group", "outside the group"],
            "link_attributes": ["address", "phone", "email"],
        },
        "roles_multi": True,
        "outcomes": [
            {"id": "approve", "label": "Approve", "closes_case": True, "requires_review": True},
            {"id": "approve_with_conditions", "label": "Approve with conditions", "closes_case": True},
            {"id": "reject", "label": "Reject", "closes_case": True, "requires_review": True},
            {"id": "request_documents", "label": "Ask for documents", "closes_case": False},
        ],
        "actions": [
            {"id": "request_guarantee", "label": "Request a guarantee", "due_hours": 72},
            {"id": "schedule_review", "label": "Schedule a review", "due_hours": 2160},
        ],
        "fields": [
            {"id": "requested_limit", "label": "Requested limit", "type": "money", "required": True, "in_queue": True},
            {"id": "rating", "label": "Rating", "type": "enum", "options": ["A", "B", "C", "D"], "in_queue": True},
        ],
        "sla_hours": {"open": 72, "analysis": 168},
        "playbook": "assemble_brief",
    },
    "insider_data_leak": {
        "label": "Insider data access",
        "description": "An employee or contractor reading or taking data beyond their need.",
        "vocabularies": {"roles": ["insider", "accomplice", "recipient", "affected system"], "tags": ["exfiltration", "policy breach"]},
        "outcomes": [
            {"id": "disciplinary", "label": "Disciplinary action", "closes_case": True},
            {"id": "refer_to_legal", "label": "Refer to legal", "closes_case": True, "requires_review": True},
            {"id": "unfounded", "label": "Unfounded", "closes_case": True},
            {"id": "contain", "label": "Contain while investigating", "closes_case": False},
        ],
        "actions": [
            {"id": "revoke_access", "label": "Revoke access", "due_hours": 1},
            {"id": "preserve_evidence", "label": "Preserve the evidence", "due_hours": 24},
            {"id": "notify_dpo", "label": "Notify the data protection officer", "due_hours": 72},
        ],
        "fields": [{"id": "systems", "label": "Systems", "type": "text", "in_queue": True}],
        "sla_hours": {"open": 24, "analysis": 336},
        "notice": "Need-to-know: security, HR and legal only.",
    },
    "merchant_review": {
        "label": "Merchant review",
        "description": "Acquiring: a merchant, its partners, terminals and sales agent under review.",
        "vocabularies": {
            "roles": ["suspect merchant", "front partner", "lent terminal", "colluding sales agent", "beneficiary merchant"],
            "tags": ["bust-out", "transaction laundering", "MCC mismatch", "card testing"],
            "link_attributes": ["settlement_account", "phone", "email", "partner", "serial_number", "ip", "address"],
        },
        "roles_multi": True,
        "outcomes": [
            {"id": "terminate", "label": "Terminate the merchant", "closes_case": True, "requires_review": True},
            {"id": "keep_monitoring", "label": "Keep with monitoring", "closes_case": True},
            {"id": "block_terminal", "label": "Block a terminal", "closes_case": False},
            {"id": "report_authorities", "label": "Report to the authorities", "closes_case": True, "requires_review": True},
        ],
        "actions": [
            {"id": "hold_settlements", "label": "Hold the settlements", "due_hours": 2},
            {"id": "block_capture", "label": "Block capture", "due_hours": 2},
            {"id": "internal_blocklist", "label": "Add to the internal blocklist"},
            {"id": "report_match", "label": "Report to the card network list", "due_hours": 120},
            {"id": "notify_merchant", "label": "Notify the merchant"},
        ],
        "stages": ["Awaiting documents", "Escalated to legal"],
        "fields": [
            {"id": "merchant_id", "label": "Merchant", "type": "text", "required": True, "in_queue": True},
            {"id": "mcc", "label": "MCC", "type": "enum", "options": ["4829", "5411", "5812", "5999", "7995"]},
            {"id": "tpv_90d", "label": "TPV 90 days", "type": "money", "in_queue": True},
            {"id": "amount_at_risk", "label": "Amount at risk", "type": "money", "in_queue": True},
        ],
        "sla_hours": {"open": 24, "analysis": 120},
    },
    "chargeback_dispute": {
        "label": "Chargeback dispute",
        "description": "One dispute from a card network: accept it or represent with evidence before the network's deadline.",
        "outcomes": [
            {"id": "accept", "label": "Accept", "closes_case": True},
            {"id": "represent", "label": "Represent", "closes_case": False},
            {"id": "pre_arbitration", "label": "Pre-arbitration", "closes_case": False},
            {"id": "won", "label": "Won", "closes_case": True},
            {"id": "lost", "label": "Lost", "closes_case": True},
        ],
        "actions": [
            {"id": "attach_delivery_proof", "label": "Attach the proof of delivery"},
            {"id": "ask_merchant_invoice", "label": "Ask the merchant for the invoice", "due_hours": 48},
        ],
        "fields": [
            {"id": "reason_code", "label": "Reason code", "type": "enum", "options": ["10.4", "13.1", "4837", "4853"], "required": True, "in_queue": True},
            {"id": "amount", "label": "Amount", "type": "money", "required": True, "in_queue": True},
            {"id": "network", "label": "Network", "type": "enum", "options": ["Visa", "Mastercard", "Amex", "Discover"], "in_queue": True},
            {"id": "network_deadline", "label": "Network deadline", "type": "date", "in_queue": True},
        ],
        "sla_hours": {"open": 168, "analysis": 336},
    },
    "vendor_due_diligence": {
        "label": "Vendor due diligence",
        "description": "Before or while paying a supplier: who owns it, who it is related to.",
        "vocabularies": {"roles": ["vendor", "beneficial owner", "related party", "sanctioned party"], "link_attributes": ["address", "phone", "bank_account"]},
        "outcomes": [
            {"id": "approve", "label": "Approve", "closes_case": True},
            {"id": "approve_with_conditions", "label": "Approve with conditions", "closes_case": True},
            {"id": "reject", "label": "Reject", "closes_case": True, "requires_review": True},
        ],
        "actions": [
            {"id": "request_documents", "label": "Request documents", "due_hours": 120},
            {"id": "schedule_review", "label": "Schedule a review"},
        ],
        "fields": [
            {"id": "vendor_id", "label": "Vendor", "type": "text", "in_queue": True},
            {"id": "country", "label": "Country", "type": "text"},
        ],
        "sla_hours": {"open": 360, "analysis": 360},
    },
    "security_incident": {
        "label": "Security incident",
        "description": "Phishing, a compromised host or account: contain, then resolve.",
        "vocabularies": {"roles": ["attacker infrastructure", "compromised host", "affected user"]},
        "outcomes": [
            {"id": "contained", "label": "Contained", "closes_case": False},
            {"id": "resolved", "label": "Resolved", "closes_case": True},
            {"id": "false_positive", "label": "False positive", "closes_case": True},
        ],
        "actions": [
            {"id": "isolate_host", "label": "Isolate the host", "due_hours": 1},
            {"id": "reset_credentials", "label": "Reset the credentials", "due_hours": 4},
            {"id": "notify_customers", "label": "Notify the customers", "due_hours": 72},
        ],
        "fields": [
            {"id": "severity", "label": "Severity", "type": "enum", "options": ["low", "medium", "high", "critical"], "required": True, "in_queue": True},
        ],
        "sla_hours": {"open": 4, "analysis": 168},
    },
}

# 06 P5: a Brazilian Pix scam case is data the org writes, never code. The type,
# the SIMBA statements mapping and the Siscoaf report are dev-seed examples only.
PIX_SCAM = {
    "label": "Golpe Pix (exemplo BR)",
    "description": "Exemplo de dado da org: golpe com Pix, MED e comunicação ao COAF. Nada disto existe no código.",
    "vocabularies": {
        "roles": ["vítima", "conta de passagem", "beneficiário final", "laranja"],
        "tags": ["falsa central", "MED", "engenharia social"],
        "link_attributes": ["phone", "document", "account"],
    },
    "outcomes": [
        {"id": "comunicar_coaf", "label": "Comunicar ao COAF (Siscoaf)", "closes_case": True, "requires_review": True},
        {"id": "arquivar", "label": "Arquivar com fundamentação", "closes_case": True},
        {"id": "bloqueio_cautelar", "label": "Bloqueio cautelar", "closes_case": False},
    ],
    "actions": [
        {"id": "marcar_dict", "label": "Marcar as contas no DICT", "due_hours": 24},
        {"id": "devolucao_med", "label": "Pedir a devolução pelo MED", "due_hours": 168},
    ],
    "fields": [
        {"id": "valor_golpe", "label": "Valor do golpe", "type": "money", "required": True, "in_queue": True},
        {"id": "protocolo_med", "label": "Protocolo MED", "type": "text", "in_queue": True},
    ],
    "sla_hours": {"open": 24, "analysis": 45 * 24},
    "notice": "Sigilo (Lei 9.613/98, art. 11): o titular não é avisado da comunicação.",
    "report_templates": ["siscoaf-cos"],
    "starter_queries": [
        {"title": "Pix recebidos pelas contas do caso (30 dias)", "language": "sql",
         "query": "SELECT conta, count(*) AS n, sum(valor) AS total FROM pix.recebidos WHERE conta IN (:contas) "
                  "AND dt >= current_date - 30 GROUP BY conta",
         "parameters": [{"id": "contas", "label": "Contas"}]},
    ],
    "analysis_defaults": {"trace": {"max_hops": 4, "max_dwell_hours": 48}},
}
LIBRARY = {
    "siscoaf-cos": ("Comunicação de operação suspeita (Siscoaf)", "template", """# Comunicação de operação suspeita · {{case.number}}

**Caso:** {{case.title}} · **tipo:** {{case.type}} · **valor do golpe:** {{fields.valor_golpe}} · **MED:** {{fields.protocolo_med}}

## Descrição da operação
{{case.description}}

## Envolvidos
{{roles}}

## Fundamentação
{{decision.outcome}} — {{decision.rationale}}

## Evidências (versões fixadas)
{{evidence}}

Responsável: {{user}} · {{today}}
"""),
}


async def seed_library(client: "SeedClient") -> None:
    """Org library docs the dev types use: the Siscoaf template and the SIMBA mapping."""
    for slug, (title, kind, body) in LIBRARY.items():
        await client.request("PUT", f"/api/admin/library/{slug}", ADMIN_EMAIL, json={"title": title, "kind": kind, "body": body})
    spec = json.loads((BANK_STATEMENTS / "spec.json").read_text(encoding="utf-8"))
    await client.request("PUT", "/api/admin/library/simba-bank-statements", ADMIN_EMAIL, json={
        "title": "Extratos bancários (SIMBA)", "kind": "mapping", "body": json.dumps({"as": "graph", "spec": spec}),
    })


# Generated cases after the scenarios: (title, narrative, final status, case type, fields).
EXTRA_CASES = [
    ("Chargeback spike · merchant 4471", "Disputes tripled in two weeks on one merchant's card-not-present sales.", "analysis",
     "merchant_review", {"merchant_id": "M-4471", "mcc": "5999", "tpv_90d": 1_200_000, "amount_at_risk": 84_000}),
    ("Vendor due diligence · Northwind Supplies", "New supplier shares an address and a phone with two dormant vendors.", "open",
     "vendor_due_diligence", {"vendor_id": "V-2291", "country": "Portugal"}),
    ("Phishing campaign · payroll portal", "Employees report a fake payroll login page; accounts changed bank details.", "analysis",
     "security_incident", {"severity": "high"}),
    ("Duplicate supplier invoices · Q3", "Same invoice numbers paid twice through two vendor records.", "closed:reject",
     "vendor_due_diligence", {"vendor_id": "V-1187", "country": "Mexico"}),
    ("Loan stacking · three lenders in a week", "Applicant took three loans with the same phone and device in five days.", "open",
     "credit_review", {"requested_limit": 15_000, "rating": "D"}),
    ("Referral abuse · promo codes", "A cluster of new accounts redeems the same referral codes from few devices.", "reopened:close_no_action",
     "fraud_ring", {"channel": "wallet", "amount_at_risk": 3_400}),
]


@dataclass
class InvStats:
    cases: int = 0
    statuses: Counter = field(default_factory=Counter)
    items: Counter = field(default_factory=Counter)  # by kind
    versions: int = 0
    pinned: int = 0
    annotations: Counter = field(default_factory=Counter)  # by kind
    suggested: int = 0
    deleted: int = 0
    agent: bool = False
    flagship: Optional[str] = None
    flagship_trace: Optional[str] = None
    decisions: int = 0
    case_types: bool = False  # written by the superuser; else every case is "general"


def _name(rng: random.Random) -> str:
    return f"{rng.choice(FIRST)} {rng.choice(LAST)}"


def _csv(header: list[str], rows: list[list[Any]]) -> bytes:
    lines = [";".join(header)] + [";".join("" if v is None else str(v) for v in r) for r in rows]
    return ("\n".join(lines) + "\n").encode("utf-8")


def _spec(name: str, nodes: list[dict], edges: list[dict], semantics: Optional[dict] = None) -> dict:
    spec = {
        "version": 1,
        "name": name,
        "inputs": {"t": {"match": "*.csv", "delimiter": ";", "header": True}},
        "nodes": nodes,
        "edges": edges,
    }
    if semantics:
        spec["edge_semantics"] = semantics
    return spec


# ---------------------------------------------------------------------------
# Scenario data
# ---------------------------------------------------------------------------


SIGNUP_ATTRS = {  # column → (node type, normalizer)
    "phone": ("Phone", "phone"),
    "email": ("Email", "email"),
    "device_id": ("Device", "device_id"),
    "ip": ("IP", "ip"),
    "card": ("Card", "card"),
    "address": ("Address", "address"),
}


def signups_bundle(rng: random.Random, size: int = 10, ring: int = 5,
                   shared_out: Optional[dict] = None) -> tuple[bytes, dict, list[str]]:
    """Sign-ups where a ring of identities shares phones, e-mails, devices, IPs,
    cards and addresses (05 §4b). Returns (csv, spec, ring customer node ids);
    ``shared_out`` receives the ring's shared values."""
    shared = {
        "phone": f"+1 415 555 {rng.randint(1000, 9999)}",
        "email": f"promo{rng.randint(10, 99)}@mail-temp.example",
        "device_id": f"dev-{rng.randint(10**5, 10**6 - 1)}",
        "ip": f"203.0.113.{rng.randint(1, 250)}",
        "card": f"4532 **** **** {rng.randint(1000, 9999)}",
        "address": f"{rng.randint(10, 99)} Harbor Street, Apt. 4 – Springfield",
    }
    if shared_out is not None:
        shared_out.update(shared)
    rows, members = [], []
    for i in range(size):
        customer, name = f"C{rng.randint(10**5, 10**6 - 1)}", _name(rng)
        own = {
            "phone": f"+44 20 7946 {rng.randint(1000, 9999)}",
            "email": f"{name.split()[0].lower()}.{rng.randint(1, 99)}@example.com",
            "device_id": f"dev-{rng.randint(10**5, 10**6 - 1)}",
            "ip": f"198.51.100.{rng.randint(1, 250)}",
            "card": f"5311 **** **** {rng.randint(1000, 9999)}",
            "address": f"{rng.randint(1, 900)} Oak Avenue – Riverside",
        }
        reused = set(rng.sample(list(SIGNUP_ATTRS), 4)) if i < ring else set()
        if i < ring:
            members.append(customer.lower())
        rows.append([customer, name, *(shared[k] if k in reused else own[k] for k in SIGNUP_ATTRS)])
    data = _csv(["customer_id", "name", *SIGNUP_ATTRS], rows)
    nodes = [{"key": "customer", "type": "Customer", "from": "t", "id": {"col": "t.customer_id", "normalize": "lower"},
              "props": {"name": "t.name"}}]
    edges = []
    for col, (node_type, how) in SIGNUP_ATTRS.items():
        nodes.append({"key": col, "type": node_type, "from": "t", "id": {"col": f"t.{col}", "normalize": how},
                      "props": {"value": f"t.{col}"}})
        edges.append({"from": "t", "type": f"USES_{node_type.upper()}", "endpoints": {"self": "customer", "other": col}})
    return data, _spec("Sign-ups", nodes, edges), members


def group_bundle(rng: random.Random) -> tuple[bytes, dict, bytes, dict]:
    """Companies of a group with shared partners, and a guarantees table by registry id."""
    partners = [_name(rng) for _ in range(4)]
    companies = [(f"R-{rng.randint(10**5, 10**6 - 1)}", name) for name in
                 ("Alpha Holdings", "Alpha Logistics", "Alpha Foods", "Beta Trading", "Gamma Retail", "Alpha Energy")]
    rows = []
    for i, (reg, name) in enumerate(companies):
        for p in rng.sample(partners, 2 if i < 4 else 1):
            rows.append([reg, name, p, rng.choice(["director", "shareholder"]), rng.randint(10, 60)])
    data = _csv(["registry_id", "company", "partner", "role", "share_pct"], rows)
    spec = _spec(
        "Companies and partners",
        [
            {"key": "company", "type": "Company", "from": "t", "id": "t.registry_id",
             "props": {"name": "t.company", "registry_id": "t.registry_id"}},
            {"key": "partner", "type": "Person", "from": "t", "id": {"col": "t.partner", "normalize": "lower"},
             "props": {"name": "t.partner"}},
        ],
        [{"from": "t", "type": "PARTNER_OF", "endpoints": {"self": "partner", "other": "company"},
          "props": {"role": "t.role", "share_pct": "t.share_pct"}}],
    )
    guarantees = _csv(["registry_id", "guarantee", "value", "due"],
                      [[reg, rng.choice(["receivables", "property", "vehicle fleet"]), rng.randint(50, 900) * 1000,
                        f"2027-0{rng.randint(1, 9)}-15"] for reg, _ in companies[:4]])
    enrichment = {"name": "guarantees", "key_column": "registry_id",
                  "columns": ["guarantee", "value", "due"], "match_node_types": ["Company"],
                  "match_source": {"kind": "prop", "name": "registry_id"}}
    return data, spec, guarantees, enrichment


def access_bundle(rng: random.Random) -> tuple[bytes, dict, str]:
    """An employee reading a finance share far above peers, at night."""
    systems = ["finance-share", "hr-portal", "crm", "payroll-db", "source-repo"]
    people = [_name(rng) for _ in range(6)]
    insider = people[0]
    start = datetime(2026, 9, 1, 8, 0)
    rows = []
    for day in range(10):
        for p in people:
            for _ in range(rng.randint(1, 3)):
                when = start + timedelta(days=day, hours=rng.randint(0, 9), minutes=rng.randint(0, 59))
                rows.append([p, rng.choice(systems[1:]), when.isoformat(timespec="minutes"), rng.randint(1, 40)])
        if day >= 6:  # the last days: the insider pulls the finance share at night
            for h in (22, 23):
                when = start + timedelta(days=day, hours=h, minutes=rng.randint(0, 59))
                rows.append([insider, "finance-share", when.isoformat(timespec="minutes"), rng.randint(800, 2400)])
    data = _csv(["employee", "system", "at", "megabytes"], rows)
    spec = _spec(
        "Access log",
        [
            {"key": "who", "type": "Employee", "from": "t", "id": {"col": "t.employee", "normalize": "lower"},
             "props": {"name": "t.employee"}},
            {"key": "what", "type": "System", "from": "t", "id": "t.system", "props": {"name": "t.system"}},
        ],
        [{"from": "t", "type": "ACCESSED", "endpoints": {"self": "who", "other": "what"},
          "props": {"at": "t.at", "megabytes": "t.megabytes"}}],
        {"amount_prop": "megabytes", "time_prop": "at"},
    )
    return data, spec, insider.lower()


# ---------------------------------------------------------------------------
# API helpers
# ---------------------------------------------------------------------------


class Agent:
    """Requests as the owner's agent token (Bearer glt_…); the owner itself when
    agents are disabled on the server or the token cannot be minted."""

    def __init__(self, client: SeedClient, owner: str, enabled: bool):
        self.client, self.owner, self.enabled = client, owner, enabled
        self.token: Optional[str] = None
        self.used = 0

    async def request(self, method: str, path: str, json: Any = None, **kwargs):
        if self.enabled and (self.token is None or self.used >= AGENT_TOKEN_BUDGET):
            try:
                created = await self.client.request(
                    "POST", "/api/agent-tokens", self.owner, json={"name": "Analysis agent (seed)"}
                )
                self.token, self.used = created.json()["token"], 0
            except SeedError:
                self.enabled = False
        if not self.enabled:
            return await self.client.request(method, path, self.owner, json=json, **kwargs)
        self.used += 1
        async with self.client.semaphore:
            response = await self.client.client.request(
                method, path, json=json, headers={"Authorization": f"Bearer {self.token}"}, **kwargs
            )
        if response.status_code >= 400:
            raise SeedError(f"{method} {path} as agent of {self.owner} → {response.status_code}: {response.text[:300]}")
        return response


def owner_client(client: SeedClient, owner: str):
    class _Owner:
        async def request(self, method, path, json=None, **kwargs):
            return await client.request(method, path, owner, json=json, **kwargs)

    return _Owner()


async def upload(client: SeedClient, url: str, owner: str, name: str, data: bytes, stats: InvStats,
                 title: Optional[str] = None, mapping: Optional[dict] = None) -> dict:
    row = (await client.request(
        "POST", f"{url}/items", owner, content=data,
        params={"filename": name, "kind": "table", "subkind": "csv", "title": title or name},
    )).json()
    stats.items["table"] += 1
    stats.versions += 1
    if mapping:
        row = (await client.request("PATCH", f"{url}/items/{row['id']}", owner, json={"mapping": mapping})).json()
    return row


async def annotate(who, url: str, stats: InvStats, kind: str, targets: list, value: dict, reason: Optional[str] = None) -> dict:
    row = (await who.request("POST", f"{url}/annotations", json={"kind": kind, "targets": targets, "value": value, "reason": reason})).json()
    stats.annotations[kind] += 1
    stats.suggested += row["status"] == "suggested"
    return row


async def add_item(who, url: str, stats: InvStats, **body) -> dict:
    row = (await who.request("POST", f"{url}/items", json=body)).json()
    stats.items[row["kind"]] += 1
    stats.versions += row["current_version"]
    return row


async def pin(who, url: str, stats: InvStats, item_id: str, label: str) -> dict:
    row = (await who.request("POST", f"{url}/items/{item_id}/pin", json={"label": label})).json()
    stats.pinned += 1
    return row


async def brief(who, url: str, stats: InvStats, text: str) -> None:
    await who.request("PUT", f"{url}/brief", json={"text": text})
    stats.items["document"] += 1
    stats.versions += 1


async def decide(client: SeedClient, url: str, owner: str, stats: InvStats, outcome: str, rationale: str,
                 **extra) -> dict:
    """Records a decision as ``owner``; with four eyes another analyst approves
    it when ``approve`` is given (the case then closes if the outcome does)."""
    approver = extra.pop("approve", None)
    case = (await client.request("POST", f"{url}/decisions", owner,
                                 json={"outcome": outcome, "rationale": rationale, **extra})).json()
    stats.decisions += 1
    last = case["decisions"][-1]
    stats.annotations["task"] += len(last["task_ids"])
    if approver and last["review"] == "pending":
        # Four eyes needs a second person who can edit the case: share it with them first.
        await client.request("POST", f"{url}/share", owner, json={"email": approver, "role": "editor"})
        case = (await client.request("POST", f"{url}/decisions/{last['id']}/review", approver,
                                     json={"approve": True, "note": "Checked the evidence."})).json()
    return case


async def finish(client: SeedClient, url: str, owner: str, final: str, stats: InvStats) -> None:
    """Moves the case to ``final``: "open", "analysis", "closed:<outcome>" (a
    decision that closes it) or "reopened:<outcome>" (closed, then reopened)."""
    status, _, outcome = final.partition(":")
    if status != "open":
        await client.request("PATCH", url, owner, json={"status": "analysis"})
    if outcome and stats.case_types:
        reviewer = next(a for a in ANALYSTS if a != owner)
        await decide(client, url, owner, stats, outcome, "The evidence pinned in the case supports it.", approve=reviewer)
        if status == "reopened":
            await client.request("POST", f"{url}/reopen", owner)
    landed = "analysis" if status == "reopened" or (outcome and not stats.case_types) else status
    stats.statuses[landed] += 1


async def seed_case_types(client: SeedClient) -> int:
    """Writes the dev org's library docs and case types as the superuser (idempotent: PUT)."""
    await seed_library(client)
    for slug, spec in {**CASE_TYPES, "pix_scam": PIX_SCAM}.items():
        await client.request("PUT", f"/api/admin/case-types/{slug}", ADMIN_EMAIL, json=spec)
    return len(CASE_TYPES) + 1


async def all_cases(client: SeedClient, email: str) -> list[dict]:
    """Every case ``email`` reads, page by page."""
    out, offset = [], 0
    while True:
        page = (await client.request("GET", "/api/investigations", email, params={"limit": 500, "offset": offset})).json()
        out += page["items"]
        offset += len(page["items"])
        if not page["items"] or offset >= page["total"]:
            return out


async def reset_seeded(client: SeedClient, log) -> int:
    """Deletes the cases carrying MARKER."""
    cases = await all_cases(client, ADMIN_EMAIL)
    deleted = 0
    for case in cases:
        if MARKER not in (case.get("description") or ""):
            continue
        await client.request("DELETE", f"/api/investigations/{case['id']}", ADMIN_EMAIL,
                             params={"reason": "dev seed reset (seed_investigations --reset)"})
        deleted += 1
    return deleted


async def new_case(client: SeedClient, owner: str, rng: random.Random, title: str, narrative: str,
                   stats: InvStats, case_type: str = "general", **extra) -> tuple[dict, str]:
    others = [a for a in ANALYSTS if a != owner]
    if not stats.case_types:
        case_type, extra = "general", {k: v for k, v in extra.items() if k != "fields"}
    case = (await client.request(
        "POST", "/api/investigations", owner,
        json={"title": title, "case_type": case_type, "assignee_email": rng.choice(others),
              "description": f"{narrative}\n\n{MARKER}", **extra},
    )).json()
    url = f"/api/investigations/{case['id']}"
    await client.request("POST", f"{url}/share", owner, json={"email": rng.choice(others), "role": "reader"})
    stats.cases += 1
    return case, url


async def graph_nodes(client: SeedClient, url: str, owner: str) -> dict[str, dict]:
    """The case's unified nodes by uid."""
    graph = (await client.request("GET", f"{url}/graph", owner)).json()
    return {n["uid"]: n for n in graph["nodes"]}


def uids_of(nodes: dict[str, dict], node_ids: list[str]) -> list[str]:
    """The unified ids of nodes whose source id is in ``node_ids`` (``id@source`` without identity keys)."""
    return [u for u in nodes if u.split("@")[0] in node_ids]


# ---------------------------------------------------------------------------
# Scenarios
# ---------------------------------------------------------------------------


async def seed_mule_network(client, owner, agent, rng, stats, log) -> dict:
    fixture = json.loads(FLOW_CHAIN.read_text(encoding="utf-8"))
    case, url = await new_case(
        client, owner, rng, "Mule network · phishing proceeds",
        "A customer lost 4,870 to a fake bank call; follow the funds through the receiving accounts.", stats,
        case_type="fraud_ring", fields={"alert_id": "ALRT-2026-0412", "amount_at_risk": 4870, "channel": "transfer"},
        occurred_at=datetime(2026, 9, 9, 14, 2).isoformat(), tags=["flow trace"],
    )
    me = owner_client(client, owner)
    snapshot = await add_item(
        me, url, stats, kind="graph", subkind="snapshot", title="Transfers around the victim account",
        description="Exported from the transaction monitoring system.",
        content_json={"nodes": fixture["nodes"], "edges": fixture["edges"], "edge_semantics": fixture["edge_semantics"]},
    )
    source = snapshot["id"]
    uid = lambda node_id: f"{node_id}@{source}"  # noqa: E731 - no identity keys: per-source ids
    # Follow the funds on the server (FIFO, the T5 numbers) and keep the run as evidence.
    trace = (await client.request(
        "POST", f"{url}/analysis/trace", owner,
        json={"seed_edge_ids": [f"{source}:{e}" for e in fixture["seed"]["edgeIds"]], "direction": "forward",
              "allocation": "fifo", "max_hops": fixture["params"]["maxHops"], "max_dwell_hours": 24,
              "min_amount": fixture["params"]["minAmount"], "stop_types": fixture["params"]["stopTypes"]},
    )).json()
    trace_item = await add_item(me, url, stats, kind="table", subkind="result", title="Trace #1 · FIFO",
                                content_json=trace, provenance={"tool": "trace", "params": trace["method"]})
    await pin(me, url, stats, trace_item["id"], "FIFO trace")
    stats.flagship_trace = f"{trace_item['id']} coverage {trace['coverage']}"
    await annotate(me, url, stats, "role", [uid("0001-9")], {"role": "victim"})
    for node in ("4471-0", "8812-7"):
        await annotate(agent, url, stats, "role", [uid(node)], {"role": "mule"}, "receives and forwards within minutes")
    hyp = await annotate(me, url, stats, "hypothesis", [], {"text": "4471-0 is a pass-through account"})
    await annotate(agent, url, stats, "hypothesis_status", [hyp["id"]], {"status": "supported"}, "the FIFO trace")
    await brief(agent, url, stats,
                f"# Mule network\n\nThe FIFO trace ({trace['coverage']:.0%} coverage) reaches a cash withdrawal, an "
                "exchange and a betting site in three layers, minutes apart. 4471-0 receives the victim's transfer "
                "and splits it at once.\n\nOpen: who controls 8812-7, which also had an opening balance.")
    await add_item(me, url, stats, kind="note", subkind="free", title="Next step",
                   content="Ask the receiving bank for 90 days of statements on 4471-0 and 8812-7.")
    # Drawn by hand (BYOD-2): the number the victim was called from, tied to the first mule.
    mule_type = next(n["node_type"] for n in fixture["nodes"] if str(n["node_id"]) == "4471-0")
    await add_item(
        me, url, stats, kind="graph", subkind="sketch", title="Manual additions",
        description="From the victim's statement: the call came from this number.",
        content_json={
            "unified": True,
            "nodes": [
                {"id": uid("4471-0"), "type": mule_type, "properties": {}},
                {"id": "sketch:caller", "type": "Phone", "properties": {"label": "+1 415 555 0142", "reported_by": "victim"}},
            ],
            "edges": [{"id": "sketch:called", "source": "sketch:caller", "target": uid("4471-0"), "type": "CALLED_FROM", "properties": {}}],
        },
    )
    await finish(client, url, owner, "analysis", stats)
    if stats.case_types:  # a decision on two accounts that does not close the case
        await decide(client, url, owner, stats, "monitor", "Keep the two receiving accounts under watch while the bank answers.",
                     targets=[uid("4471-0"), uid("8812-7")],
                     tasks=[{"action": "notify_partner"},
                            {"title": "Trace the next layer when the bank answers", "assignee_kind": "agent",
                             "agent_name": "Analysis agent (seed)"}])
        # The agent proposes a follow-up of its own; a person confirms it in the case.
        await annotate(agent, url, stats, "task", [uid("8812-7")],
                       {"title": "Ask who opened 8812-7", "assignee": owner}, "8812-7 had an opening balance")
    stats.flagship = case["id"]
    return case


async def seed_fraud_ring(client, owner, agent, rng, stats, log) -> dict:
    case, url = await new_case(
        client, owner, rng, "Fraud ring · shared devices at sign-up",
        "New accounts opened in one week reuse phones, devices and cards; find the ring and the real customers.", stats,
        case_type="fraud_ring", fields={"alert_id": "ALRT-2026-0388", "amount_at_risk": 18_200, "channel": "card"},
        tags=["sign-up"],
    )
    shared: dict = {}
    data, spec, ring = signups_bundle(rng, shared_out=shared)
    await upload(client, url, owner, "signups.csv", data, stats, "Sign-ups of the week", {"as": "graph", "spec": spec})
    me = owner_client(client, owner)
    members = uids_of(await graph_nodes(client, url, owner), ring)
    await annotate(me, url, stats, "group", members, {"name": "Device ring", "color": 3})
    for member in members[:3]:
        await annotate(agent, url, stats, "role", [member], {"role": "ring member"}, "shares 3+ attributes with the ring")
    await annotate(me, url, stats, "tag", members[3:4], {"tag": "needs KYC"})
    await annotate(me, url, stats, "hypothesis", [], {"text": "One operator controls the ring's five accounts"})
    await add_item(me, url, stats, kind="note", subkind="free", title="Pending",
                   content="Check whether the shared card was reported stolen.")
    await finish(client, url, owner, "open", stats)
    await seed_ring_follow_up(client, owner, rng, stats, shared)
    return case


async def seed_ring_follow_up(client, owner, rng, stats, shared: dict) -> dict:
    """06 P7: a second fraud_ring case whose refund requests reuse the ring's phone,
    device and card: selecting them shows "Seen in 1 other case"."""
    case, url = await new_case(
        client, owner, rng, "Fraud ring · refund requests",
        "Refund requests from three new accounts; the phone and the device look familiar.", stats,
        case_type="fraud_ring", fields={"alert_id": "ALRT-2026-0431", "amount_at_risk": 2_150, "channel": "card"},
        tags=["refunds"],
    )
    cols = ["phone", "device_id", "card"]
    rows = [[f"C{rng.randint(10**5, 10**6 - 1)}", _name(rng), *(shared[c] for c in cols)] for _ in range(3)]
    nodes = [{"key": "customer", "type": "Customer", "from": "t", "id": {"col": "t.customer_id", "normalize": "lower"},
              "props": {"name": "t.name"}}]
    edges = []
    for col in cols:
        node_type, how = SIGNUP_ATTRS[col]
        nodes.append({"key": col, "type": node_type, "from": "t", "id": {"col": f"t.{col}", "normalize": how},
                      "props": {"value": f"t.{col}"}})
        edges.append({"from": "t", "type": f"USES_{node_type.upper()}", "endpoints": {"self": "customer", "other": col}})
    await upload(client, url, owner, "refunds.csv", _csv(["customer_id", "name", *cols], rows), stats,
                 "Refund requests", {"as": "graph", "spec": _spec("Refund requests", nodes, edges)})
    await finish(client, url, owner, "open", stats)
    return case


async def seed_credit_review(client, owner, agent, rng, stats, log) -> dict:
    case, url = await new_case(
        client, owner, rng, "Credit review · Alpha group",
        "Consolidated limit request for six companies with partners in common; check the exposure and the guarantees.",
        stats, case_type="credit_review", fields={"requested_limit": 2_500_000, "rating": "B"}, tags=["economic group"],
    )
    data, spec, guarantees, enrichment = group_bundle(rng)
    await upload(client, url, owner, "companies.csv", data, stats, "Companies and partners", {"as": "graph", "spec": spec})
    await upload(client, url, owner, "guarantees.csv", guarantees, stats, "Guarantees by company",
                 {"as": "enrichment", "spec": enrichment})
    me = owner_client(client, owner)
    await add_item(
        me, url, stats, kind="query", subkind="sql", title="Revenue by company (12 months)",
        description="Runs on the warehouse once the revenue context is linked to the case.",
        query={"text": "SELECT registry_id, sum(amount) AS revenue FROM fin.revenue WHERE registry_id IN (:ids) AND dt >= :since GROUP BY registry_id",
               "language": "sql", "output": "table",
               "parameters": [{"id": "ids", "label": "Registry ids", "required": True}, {"id": "since", "label": "Since", "default": "2025-01-01"}]},
    )
    nodes = await graph_nodes(client, url, owner)
    group = [u for u, n in nodes.items() if n["type"] == "Company" and "Alpha" in (n["properties"].get("name") or "")]
    await annotate(me, url, stats, "group", group, {"name": "Alpha group", "color": 2})
    others = [u for u, n in nodes.items() if n["type"] == "Company" and u not in group]
    await annotate(me, url, stats, "tag", others[:1], {"tag": "outside the group"})
    people = [u for u, n in nodes.items() if n["type"] == "Person"]
    if len(people) >= 2:
        await annotate(agent, url, stats, "same_as", people[:2], {"score": 0.86}, "same director name in two filings")
    await brief(agent, url, stats,
                "# Alpha group\n\nFour of the six companies share two directors; Beta Trading and Gamma Retail have "
                "one partner each in common with the group. Guarantees cover four companies.\n\nOpen: audited "
                "statements for Alpha Holdings; whether the property guarantee is registered.")
    await finish(client, url, owner, "analysis", stats)
    if stats.case_types:  # documents first; the approval then waits for a second person
        await decide(client, url, owner, stats, "request_documents", "Audited statements of Alpha Holdings are missing.")
        await decide(client, url, owner, stats, "approve", "Exposure within limits once the guarantees are registered.",
                     targets=group[:2])
    return case


async def seed_insider(client, owner, agent, rng, stats, log) -> dict:
    case, url = await new_case(
        client, owner, rng, "Insider data access · finance share",
        "An employee read gigabytes from the finance share at night in the days before resigning.", stats,
        case_type="insider_data_leak", fields={"systems": "finance-share"}, tags=["data access"],
    )
    data, spec, insider = access_bundle(rng)
    await upload(client, url, owner, "access_log.csv", data, stats, "Access log · September",
                 {"as": "graph", "spec": spec})
    me = owner_client(client, owner)
    who = uids_of(await graph_nodes(client, url, owner), [insider])
    if who:
        await annotate(agent, url, stats, "role", who[:1], {"role": "insider"}, "night reads far above peers")
    await annotate(me, url, stats, "hypothesis", [], {"text": "The reads were copied to a personal device"})
    await annotate(me, url, stats, "hypothesis", [], {"text": "The reads were a sanctioned year-end export"})
    await add_item(me, url, stats, kind="note", subkind="free", title="Ask IT",
                   content="USB and cloud-upload logs for the same nights.")
    if stats.case_types:  # contain while investigating (does not close the case) …
        await decide(client, url, owner, stats, "contain", "Access suspended while the logs are reviewed.", targets=who[:1],
                     tasks=[{"action": "revoke_access"}, {"action": "preserve_evidence"}])
    await finish(client, url, owner, "closed:disciplinary", stats)  # … then a decision that closes it
    return case


async def seed_pix_scam(client, owner, agent, rng, stats, log) -> dict:
    """06 P5, scenario 1: the SIMBA statements come in through the org's mapping
    template and the Siscoaf report is a template rendered over the case."""
    if not stats.case_types:
        return await seed_extra(client, owner, agent, rng, stats, log, 0)
    case, url = await new_case(
        client, owner, rng, "Golpe Pix · falsa central (exemplo BR)",
        "Cliente transferiu 4.870 via Pix após ligação falsa do banco; extratos SIMBA da conta recebedora.", stats,
        case_type="pix_scam", fields={"valor_golpe": 4870, "protocolo_med": "MED-2026-0912"},
        occurred_at=datetime(2026, 9, 12, 10, 30).isoformat(),
    )
    files = sorted(p for p in BANK_STATEMENTS.iterdir() if p.suffix.upper() == ".TXT")
    rows = [await upload(client, url, owner, p.name, p.read_bytes(), stats, p.name) for p in files]
    mapping = json.loads((await client.request("GET", "/api/org/library/simba-bank-statements", owner)).json()["body"])
    await client.request("PATCH", f"{url}/items/{rows[0]['id']}", owner,
                         json={"mapping": {**mapping, "extra_item_ids": [r["id"] for r in rows[1:]]}})
    me = owner_client(client, owner)
    await pin(me, url, stats, rows[0]["id"], "Extratos SIMBA")
    nodes = await graph_nodes(client, url, owner)
    accounts = [u for u, n in nodes.items() if n["type"] == "Account"][:2]
    for uid_ in accounts[:1]:
        await annotate(me, url, stats, "role", [uid_], {"role": "conta de passagem"})
    await client.request("PATCH", url, owner, json={"status": "analysis"})
    report = (await client.request("POST", f"{url}/reports", owner, json={"template": "siscoaf-cos"})).json()
    stats.items["document"] += 1
    stats.versions += 1
    await pin(me, url, stats, report["id"], "Rascunho COS")
    return case


async def seed_extra(client, owner, agent, rng, stats, log, i: int) -> dict:
    title, narrative, final, case_type, fields = EXTRA_CASES[i % len(EXTRA_CASES)]
    if i >= len(EXTRA_CASES):
        title = f"{title} #{i // len(EXTRA_CASES) + 1}"
    case, url = await new_case(client, owner, rng, title, narrative, stats, case_type=case_type, fields=fields,
                               tags=["generated"])
    data, spec, ring = signups_bundle(rng, size=6, ring=3)
    await upload(client, url, owner, "records.csv", data, stats, "Records", {"as": "graph", "spec": spec})
    members = uids_of(await graph_nodes(client, url, owner), ring)
    await annotate(agent, url, stats, "role", members[:1], {"role": "suspect"}, "shares attributes with two others")
    await annotate(owner_client(client, owner), url, stats, "hypothesis", [], {"text": "The three records belong to one person"})
    await finish(client, url, owner, final, stats)
    return case


async def seed_chargebacks(client: SeedClient, rng: random.Random, stats: InvStats, count: int) -> None:
    """Small disputes in volume (06 §2b AQ8): one create each, opened over the
    last three weeks so the queue has urgent and overdue ones."""
    networks = CASE_TYPES["chargeback_dispute"]["fields"][2]["options"]
    codes = CASE_TYPES["chargeback_dispute"]["fields"][0]["options"]
    for k in range(count):
        ref = f"CB-{rng.randint(10**6, 10**7 - 1)}"
        opened = datetime.now() - timedelta(hours=rng.randint(1, 21 * 24))
        await client.request("POST", "/api/investigations", ANALYSTS[k % len(ANALYSTS)], json={
            "title": f"Chargeback {ref}", "case_type": "chargeback_dispute", "external_ref": ref,
            "description": f"Dispute received from the network.\n\n{MARKER}", "alert_at": opened.isoformat(),
            "fields": {"reason_code": rng.choice(codes), "amount": round(rng.uniform(15, 2400), 2),
                       "network": rng.choice(networks), "network_deadline": (opened + timedelta(days=30)).date().isoformat()},
        })
        stats.cases += 1
        stats.statuses["open"] += 1


SCENARIOS = (seed_mule_network, seed_fraud_ring, seed_credit_review, seed_insider, seed_pix_scam)


async def run_seed_investigations(api: str, *, cases: int = 8, seed: int = 42, reset: bool = False,
                                  chargebacks: int = 0, ui: str = "http://localhost:3000", log=print) -> InvStats:
    rng = random.Random(seed)
    stats = InvStats()
    client = SeedClient(api)
    try:
        config = (await client.request("GET", "/api/config", ADMIN_EMAIL)).json()
        if not config.get("dev_mode"):
            raise SeedError("Server is not in dev mode; refusing to seed.")
        stats.agent = bool(config.get("agents_enabled"))
        if not stats.agent:
            log("warning: agents are disabled (GRAPH_LAGOON_AGENTS_ENABLED); agent writes are made by the case owners.")
        if reset:
            if not config.get("is_superuser"):
                raise SeedError(f"--reset needs {ADMIN_EMAIL} in GRAPH_LAGOON_SUPERUSER_EMAILS.")
            stats.deleted = await reset_seeded(client, log)
            log(f"reset: {stats.deleted} seeded case(s) deleted")
        if config.get("is_superuser"):
            log(f"case types: {await seed_case_types(client)} written")
            stats.case_types = True
        else:
            log(f"warning: {ADMIN_EMAIL} is not a superuser; the case types are not written and cases use 'general'.")
        agents: dict[str, Agent] = {}
        for i in range(cases):
            owner = ANALYSTS[i % len(ANALYSTS)]
            agent = agents.setdefault(owner, Agent(client, owner, stats.agent))
            if i < len(SCENARIOS):
                case = await SCENARIOS[i](client, owner, agent, rng, stats, log)
            else:
                case = await seed_extra(client, owner, agent, rng, stats, log, i - len(SCENARIOS))
            log(f"  [{i + 1}/{cases}] {case['title']}")
        if chargebacks and stats.case_types:
            await seed_chargebacks(client, rng, stats, chargebacks)
            log(f"  + {chargebacks} chargeback disputes")
        log("")
        log(f"cases: {stats.cases} · " + ", ".join(f"{k}: {v}" for k, v in sorted(stats.statuses.items())))
        log("items: " + ", ".join(f"{k}: {v}" for k, v in sorted(stats.items.items())) + f" · {stats.versions} versions, {stats.pinned} pinned")
        log("annotations: " + ", ".join(f"{k}: {v}" for k, v in sorted(stats.annotations.items())) + f" · {stats.suggested} suggested")
        log(f"decisions: {stats.decisions}")
        log(f"authored by {'agent tokens' if stats.agent else 'owners'}")
        if stats.flagship:
            log(f"Mule network (flow trace): {ui.rstrip('/')}/investigations/{stats.flagship}")
            log(f"  trace {stats.flagship_trace}")
        log(f"log in as {ANALYSTS[0]} (owner) or {ADMIN_EMAIL} (superuser, sees all)")
        return stats
    finally:
        await client.close()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--api", default="http://localhost:8000")
    parser.add_argument("--cases", type=int, default=8)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--reset", action="store_true", help="delete previously seeded cases first (superuser)")
    parser.add_argument("--chargebacks", type=int, default=300, help="small chargeback disputes for the paged queue")
    parser.add_argument("--ui", default="http://localhost:3000", help="frontend base for the printed links")
    parser.add_argument("--wait", type=float, default=60.0, help="seconds to wait for the API")
    return parser


def main(argv: Optional[list[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    logging.getLogger("httpx").setLevel(logging.WARNING)  # one line per request otherwise
    try:
        base = asyncio.run(wait_for_health(args.api, args.wait))
        asyncio.run(run_seed_investigations(base, cases=args.cases, seed=args.seed, reset=args.reset,
                                            chargebacks=args.chargebacks, ui=args.ui))
    except SeedError as exc:
        print(f"seed failed: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
