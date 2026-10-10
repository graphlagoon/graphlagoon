"""Dev seed for investigations (05-plano-v2): realistic cases on a *running* API.

    uv run python -m graphlagoon.dev.seed_investigations --api http://localhost:8000 \\
        [--cases 8] [--seed 42] [--reset]

Works with nothing but the API (memory mode, no warehouse). Four scenarios,
each a case of items and annotations (05 §1), then generated Pix/MED cases:

1. **Crédito de grupo econômico** (`credito`): QSA-like CSV mapped to a graph of
   companies and partners, a guarantees CSV as enrichment, a saved SQL query,
   a group, a brief written by the agent.
2. **Fuga de garantia** (`garantia`): alienations CSV mapped to a time-stamped
   graph, hypotheses, an agent's role and same_as suggestions, a decision.
3. **Golpe Pix com MED** (`pix_med`): the T5 design scenario
   (``trace/golpe-pix.json`` written as SIMBA) uploaded as table items with the
   ``simba_v31`` mapping, the QSA fixture as enrichment, a server trace saved
   and pinned ("Rastreio #1"), a suggested CC 4.001 badge, agent roles.
4. **Fraude sintética** (`fraude_sintetica`): people sharing phones, e-mails,
   devices, IPs, cards, terminals and addresses, grouped as a synthetic cluster.

Agent writes use an agent token (``GRAPH_LAGOON_AGENTS_ENABLED=true``;
without it the owner writes them). Seeded cases carry ``[seed:investigations]``
in the description. A rerun adds more; ``--reset`` first deletes the seeded
cases (superuser, ``?reason=`` for decided ones).
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
from graphlagoon.services.file_mapping_presets import PRESETS
from graphlagoon.services.investigation_exports import (
    EXTRATO_COLS,
    OD_COLS,
    TITULARES_COLS,
    _tsv,
    simba_tables,
)

MARKER = "[seed:investigations]"
FIXTURES = Path(__file__).resolve().parents[3] / "frontend/src/__tests__/fixtures/fileMapping"
GOLPE_PIX = FIXTURES.parent / "trace/golpe-pix.json"
ANALYSTS = [
    f"{name}@{SEED_DOMAIN}"
    for name in ("ana.ribeiro", "bruno.tavares", "carla.mendes", "diego.farias", "elisa.moura", "fabio.nunes")
]
# Rotates per agent token below this, under the API's 120 requests/minute.
AGENT_TOKEN_BUDGET = 100
FIRST = ["MARIA", "JOSE", "ANA", "JOAO", "FRANCISCA", "ANTONIO", "ADRIANA", "CARLOS",
         "PAULO", "LUCIANA", "MARCOS", "JULIANA", "RAFAEL", "PATRICIA", "FERNANDO", "ALINE"]
LAST = ["SILVA", "SANTOS", "OLIVEIRA", "SOUZA", "RODRIGUES", "FERREIRA", "ALVES", "PEREIRA",
        "LIMA", "GOMES", "COSTA", "RIBEIRO", "MARTINS", "CARVALHO", "ARAUJO", "BARBOSA"]

# Generated Pix/MED cases after the four scenarios: (title, final status).
EXTRA_CASES = [
    ("Conta laranja · universitários aliciados por anúncio", "decided:arquivar"),
    ("Bets · recargas fracionadas em casa de apostas", "archived"),
    ("Golpe Pix · falso leilão de veículos", "decided:comunicar"),
    ("Golpe Pix · falso parente no WhatsApp", "analysis"),
    ("Golpe Pix · boleto falso de financiamento", "open"),
    ("Golpe Pix · notificação MED em lote (12 vítimas)", "analysis"),
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


@dataclass
class CaseGraph:
    """Unified node ids (``Pessoa:<cpf>``, ``Conta:<b-a-c>``) of one file graph."""

    names: dict[str, str] = field(default_factory=dict)
    victims: list[str] = field(default_factory=list)
    mules: list[str] = field(default_factory=list)
    exits: list[str] = field(default_factory=list)
    discarded: list[str] = field(default_factory=list)
    pairs: list[tuple[str, str, float]] = field(default_factory=list)  # match candidates
    hops: int = 5  # trace layers from victims[0] to the exits



def _cpf(rng: random.Random) -> str:
    return str(rng.randint(10**10, 10**11 - 1))


def _account_uid(banco: str, agencia: str, conta: str) -> str:
    return "Conta:" + "-".join(p.lstrip("0") or "0" for p in (banco, agencia, conta))


class Bundle:
    """A money graph written as SIMBA v3.1 files by the F4.6 export
    (``simba_tables``). Every transfer has one reported account (``Conta``) end
    and one counterpart (``Pessoa`` by CPF/CNPJ, or agency 9999 =
    ``Desconhecido``), so flows alternate account → holder → account.
    shortcut: SIMBA dates have no time of day; OD codes follow the clock so the
    trace (ordered by date, then edge id) keeps the intraday order, and the time
    goes in DESCRICAO."""

    def __init__(self) -> None:
        self.nodes: dict[str, dict] = {}
        self.moves: list[tuple[datetime, str, str, float, str]] = []
        self.holders: list[tuple[str, str]] = []

    def pessoa(self, doc: str, nome: str, renda: Optional[float] = None) -> str:
        uid = f"Pessoa:{doc}"
        self.nodes[uid] = {"uid": uid, "type": "Pessoa", "entity": "Pessoa",
                           "properties": {"cpf_cnpj": doc, "nome": nome, "renda": renda}}
        return uid

    def conta(self, banco: str, agencia: str, conta: str, holder: Optional[str] = None) -> str:
        uid = _account_uid(banco, agencia, conta)
        self.nodes[uid] = {"uid": uid, "type": "Conta", "entity": "Conta",
                           "properties": {"banco": banco, "agencia": agencia, "conta": conta}}
        if holder:
            self.holders.append((holder, uid))
        return uid

    def unknown(self, observacao: str) -> str:
        """A one-transaction counterpart; its uid on the server is ``desconhecido:<OD>@<context>``."""
        key = f"?{len(self.nodes)}"
        self.nodes[key] = {"uid": key, "type": "Desconhecido", "entity": None,
                           "properties": {"observacao": observacao}}
        return key

    def move(self, when: datetime, src: str, dst: str, amount: float, kind: str = "PIX") -> None:
        self.moves.append((when, src, dst, round(amount, 2), kind))

    def files(self, prefix: str) -> tuple[dict[str, bytes], dict[str, str]]:
        """SIMBA files and the OD code of each ``unknown`` counterpart."""
        edges, codes = [], {}
        for k, (when, src, dst, amount, kind) in enumerate(sorted(self.moves, key=lambda m: m[0]), 1):
            code = f"OD{k:03d}"
            side = "ENVIADO" if self.nodes[src]["type"] == "Conta" else "RECEBIDO"
            edges.append({"id": code, "src": src, "dst": dst, "amount": amount,
                          "t": int(when.timestamp() * 1000),
                          "type": "SAQUE" if kind == "SAQUE" else "TRANSF_INTERBANCARIA",
                          "properties": {"descricao": f"{kind if kind == 'SAQUE' else f'{kind} {side}'} {when:%H:%M}"}})
            codes.update({u: code for u in (src, dst) if u.startswith("?")})
        edges += [{"id": f"T{k}", "src": h, "dst": c, "amount": None, "type": "TITULAR"}
                  for k, (h, c) in enumerate(self.holders)]
        extrato, od, titulares, _ = simba_tables({"nodes": list(self.nodes.values()), "edges": edges})
        return {
            f"{prefix}_EXTRATO.TXT": _tsv(EXTRATO_COLS, extrato),
            f"{prefix}_ORIGEM_DESTINO.TXT": _tsv(OD_COLS, od),
            f"{prefix}_TITULARES.TXT": _tsv(TITULARES_COLS, titulares),
        }, codes


# The T5 design scenario (frontend fixture trace/golpe-pix.json) as SIMBA:
# fixture node → reported account (+ holder), counterpart person/company, or 9999.
GOLPE_PIX_NODES = {
    "externo": ("unknown", "TED DE NAO-CORRENTISTA"),
    "0001-9": ("conta", ("104", "0001", "0001-9"), ("31415926535", "MARIA APARECIDA SOUZA")),
    "4471-0": ("pessoa", "27182818284", "RAFAEL COSTA LIMA"),
    "5520-3": ("conta", ("260", "0412", "5520-3"), ("16180339887", "JULIANA ALVES PEREIRA")),
    # The qsa-mini partner (masked CPF ***456789**): the entity-resolution hit.
    "8812-7": ("conta", ("077", "0001", "8812-7"), ("12345678901", "ANA SILVA")),
    "3090-1": ("conta", ("336", "0001", "3090-1"), ("14142135623", "MARCOS GOMES RIBEIRO")),
    "saque-atm": ("unknown", "SAQUE ATM"),
    "exchange-gama": ("pessoa", "12345678000190", "EXCHANGE GAMA LTDA"),
    "bet-delta": ("pessoa", "98765432000110", "BET DELTA APOSTAS LTDA"),
}


def golpe_pix_bundle(qsa_context: Optional[str]) -> tuple[dict[str, bytes], CaseGraph, list]:
    """SIMBA files of the golpe-pix trace fixture: victim → 4471-0 → three
    mule accounts → Saque ATM / Exchange Gama / Bet Delta (FIFO 91% at 3 hops).
    Returns (files, graph, [(graph list, OD code, label)])."""
    fixture = json.loads(GOLPE_PIX.read_text(encoding="utf-8"))
    b, uid, names = Bundle(), {}, {}
    for n in fixture["nodes"]:
        kind, *spec = GOLPE_PIX_NODES[n["node_id"]]
        if kind == "conta":
            (banco, agencia, conta), (doc, nome) = spec
            uid[n["node_id"]] = b.conta(banco, agencia, conta, holder=b.pessoa(doc, nome))
            names[f"Pessoa:{doc}"] = nome
        else:
            uid[n["node_id"]] = b.pessoa(*spec) if kind == "pessoa" else b.unknown(*spec)
        label = spec[-1] if kind == "pessoa" else f"Conta {n['node_id']}"
        names[uid[n["node_id"]]] = (n.get("properties") or {}).get("nome") or label
    for e in fixture["edges"]:
        p = e["properties"]
        when = datetime.fromisoformat(p["data_hora"]).replace(tzinfo=None)  # wall clock, as SIMBA has it
        b.move(when, uid[e["src"]], uid[e["dst"]], p["valor"], e["relationship_type"])
    files, codes = b.files("CASO1")
    ana, rafael, victim = "Pessoa:12345678901", uid["4471-0"], "Pessoa:31415926535"
    g = CaseGraph(
        names=names,
        victims=[uid["0001-9"], victim],
        mules=[uid["8812-7"], ana, rafael, uid["3090-1"], uid["5520-3"]],
        exits=[uid["exchange-gama"], uid["bet-delta"]],
        hops=fixture["params"]["maxHops"],
    )
    if qsa_context:
        socio = f"socio:ANA SILVA|***456789**@{qsa_context}"
        g.names[socio] = "ANA SILVA"
        g.pairs.append((ana, socio, 0.8))
    g.pairs += [(victim, rafael, 0.62), (rafael, ana, 0.66), (victim, ana, 0.58)]
    return files, g, [("exits", codes[uid["saque-atm"]], names[uid["saque-atm"]]),
                      ("discarded", codes[uid["externo"]], names[uid["externo"]])]


EXIT_KINDS = {
    "exchange": "EXCHANGE {} LTDA",
    "bet": "BET {} APOSTAS LTDA",
    "pj": "{} COMERCIO E SERVICOS LTDA",
}


def simba_bundle(rng: random.Random, prefix: str) -> tuple[dict[str, bytes], CaseGraph, list]:
    """SIMBA v3.1 files for victims → laranja account(s) → 3–4 layers of mules
    (fan-out/fan-in, minutes to hours in each) → 2–4 exits (saque, exchange,
    bet, PJ), within a day and a half so a forward trace from the first victim
    (Δ 24h) reaches them. Returns (files, graph, [(graph list, OD code, label)])."""
    b = Bundle()
    clock = datetime(2026, rng.randint(3, 8), rng.randint(1, 28), rng.randint(8, 11), rng.randint(0, 59))

    def person():
        return _cpf(rng), f"{rng.choice(FIRST)} {rng.choice(LAST)} {rng.choice(LAST)}"

    def account(holder: str) -> str:
        return b.conta(rng.choice(["077", "260", "290", "323", "380"]), f"{rng.randint(1, 9999):04d}",
                       f"{rng.randint(10**5, 10**6 - 1)}-{rng.randint(0, 9)}", holder=holder)

    victims = [b.pessoa(*person()) for _ in range(rng.randint(4, 8))]
    laranja = person()
    saida = (_cpf(rng), f"{laranja[1].split()[0]} {laranja[1].split()[-1]}")  # a near-duplicate name
    laranja_uid = b.pessoa(*laranja, renda=1412.0)
    depth = rng.choice((3, 4))
    layers = [[account(laranja_uid)] + [account(b.pessoa(*person())) for _ in range(rng.randint(0, 1))]]
    mules = [b.pessoa(*person()), b.pessoa(*saida)] + [b.pessoa(*person()) for _ in range(rng.randint(0, 2))]
    layers.append(mules)
    layers.append([account(mules[0])] + [account(b.pessoa(*person())) for _ in range(rng.randint(1, 3))])
    if depth == 4:
        layers.append([b.pessoa(*person()) for _ in range(rng.randint(2, 4))])
    # Exits: companies by CNPJ, reported accounts of them after a person layer.
    exits = []
    for kind in rng.sample(list(EXIT_KINDS), k=rng.randint(1, 3)):
        pj = b.pessoa(str(rng.randint(10**13, 10**14 - 1)), EXIT_KINDS[kind].format(rng.choice(LAST)))
        exits.append(pj if depth == 3 else account(pj))
    late = []

    def saque(when: datetime, src: str, amount: float) -> None:
        late.append(("exits", b.unknown("SAQUE EM ESPECIE"), "Saque em espécie"))
        b.move(when, src, late[-1][1], amount, "SAQUE")

    # Money: victims first (victims[0] earliest and largest, so FIFO spreads it), then
    # each node forwards ~95% of what it got, minutes to hours after its last credit.
    got: dict[str, list] = {}  # node → [cents, last arrival]
    for k, v in enumerate(victims):
        clock += timedelta(minutes=rng.randint(3, 50))
        cents = rng.randint(800, 9000) * 100 if k else rng.randint(15000, 40000) * 100  # the MED notifier
        dst = layers[0][k % len(layers[0])]
        b.move(clock, v, dst, cents / 100)
        got.setdefault(dst, [0, clock])[0] += cents
        got[dst][1] = clock
    for i, layer in enumerate(layers):
        targets = layers[i + 1] if i + 1 < len(layers) else exits
        fan = len(targets) if i == 0 else rng.randint(1, 3)  # the laranja spreads to every mule
        plan = {n: rng.sample(targets, k=min(len(targets), fan)) for n in layer if n in got}
        for t in targets:  # fan-in: every next node gets something
            if not any(t in ts for ts in plan.values()):
                plan[rng.choice(list(plan))].append(t)
        for n, ts in plan.items():
            cents, when = got[n]
            out = cents * rng.randint(93, 99) // 100
            if i == 2:  # the second account layer cashes part out
                when += timedelta(minutes=rng.randint(5, 180))
                cash = out * rng.randint(20, 40) // 100
                saque(when, n, cash / 100)
                out -= cash
            for k, t in enumerate(ts):
                when += timedelta(minutes=rng.randint(5, 240) if k == 0 else rng.randint(1, 20))
                part = out // (len(ts) - k) if k < len(ts) - 1 else out
                out -= part
                b.move(when, n, t, part / 100)
                if t in got:
                    got[t][0] += part
                    got[t][1] = max(got[t][1], when)
                else:
                    got[t] = [part, when]
    supplier = person()  # an ordinary payment at night: the "descartado" entity
    supplier_uid = b.pessoa(*supplier)
    b.move(clock.replace(hour=22, minute=rng.randint(0, 59)), supplier_uid, layers[0][0], rng.randint(50, 300))
    files, codes = b.files(prefix)
    mula, saida_uid = mules[0], f"Pessoa:{saida[0]}"
    g = CaseGraph(
        names={u: n["properties"]["nome"] for u, n in b.nodes.items() if n["type"] == "Pessoa"},
        victims=victims,
        mules=[layers[0][0], laranja_uid, *layers[0][1:], *mules, *(layers[3] if depth == 4 else []), *layers[2]],
        exits=list(exits),
        discarded=[supplier_uid],
        hops=depth + 1,
    )
    g.pairs = [
        (laranja_uid, saida_uid, 0.86),
        (victims[0], victims[1], 0.71),
        (mula, laranja_uid, 0.74),
        (saida_uid, mula, 0.68),
    ]
    return files, g, [(name, codes[key], label) for name, key, label in late]



# ---------------------------------------------------------------------------
# CSV scenarios: a generic graph mapping (03 §4) per layout
# ---------------------------------------------------------------------------


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


def credito_bundle(rng: random.Random) -> tuple[bytes, dict, bytes, dict, list[str]]:
    """Companies of a group with shared partners, and a guarantees table by CNPJ."""
    cnpjs = [f"{rng.randint(10**7, 10**8 - 1):08d}0001{rng.randint(10, 99)}" for _ in range(6)]
    partners = [(_cpf(rng), f"{rng.choice(FIRST)} {rng.choice(LAST)} {rng.choice(LAST)}") for _ in range(4)]
    names = ["ALFA PARTICIPACOES LTDA", "ALFA COMERCIO LTDA", "ALFA LOGISTICA LTDA",
             "BETA AGRO LTDA", "GAMA SERVICOS LTDA", "DELTA IMOVEIS LTDA"]
    ufs = ["SP", "SP", "SP", "MT", "SP", "RJ"]
    rows = []
    for i, cnpj in enumerate(cnpjs):
        for cpf, nome in rng.sample(partners, k=2 if i < 4 else 1):
            rows.append([cnpj, names[i], ufs[i], cpf, nome, rng.choice(["05", "22", "49"])])
    empresas = _csv(["cnpj", "razao_social", "uf", "socio_cpf", "socio_nome", "qualificacao"], rows)
    spec = _spec(
        "Grupo econômico (QSA)",
        [
            {"key": "empresa", "type": "Empresa", "from": "t", "id": {"col": "t.cnpj", "normalize": "cpf_cnpj"},
             "props": {"razao_social": "t.razao_social", "uf": "t.uf", "cnpj": "t.cnpj"}},
            {"key": "socio", "type": "Pessoa", "from": "t", "id": {"col": "t.socio_cpf", "normalize": "cpf_cnpj"},
             "props": {"nome": "t.socio_nome", "cpf": "t.socio_cpf"}},
        ],
        [{"from": "t", "type": "SOCIO_DE", "direction": "in", "endpoints": {"self": "empresa", "other": "socio"},
          "props": {"qualificacao": "t.qualificacao"}}],
    )
    garantias = _csv(
        ["cnpj", "garantia", "valor", "vencimento"],
        [[c, rng.choice(["imóvel", "recebíveis", "aval", "alienação fiduciária"]), rng.randint(50, 900) * 1000,
          f"2026-{rng.randint(1, 12):02d}-{rng.randint(1, 28):02d}"] for c in cnpjs],
    )
    enrichment = {"name": "Garantias", "input": {"delimiter": ";"}, "key_column": "cnpj",
                  "columns": ["garantia", "valor", "vencimento"], "match_node_types": ["Empresa"],
                  "match_source": {"kind": "prop", "name": "cnpj"}}
    return empresas, spec, garantias, enrichment, [f"Empresa:{c}" for c in cnpjs]


def garantia_bundle(rng: random.Random) -> tuple[bytes, dict, dict[str, list[str]]]:
    """A debtor alienating assets to acquirers after the contract date."""
    devedor = (_cpf(rng), f"{rng.choice(FIRST)} {rng.choice(LAST)} {rng.choice(LAST)}")
    acquirers = [(_cpf(rng), f"{rng.choice(FIRST)} {rng.choice(LAST)} {rng.choice(LAST)}") for _ in range(4)]
    bens = [("ABC1D23", "Veículo Hilux 2022"), ("MAT-44871", "Imóvel rural 120 ha"),
            ("XYZ9F87", "Caminhão Volvo FH"), ("MAT-10233", "Galpão industrial")]
    start = datetime(2026, 2, 1, 9, 0)
    rows = []
    for i, (bem_id, bem) in enumerate(bens):
        cpf, nome = acquirers[i]
        when = start + timedelta(days=rng.randint(5, 80), hours=rng.randint(0, 9))
        rows.append([devedor[0], devedor[1], bem_id, bem, cpf, nome, when.isoformat(timespec="minutes"),
                     f"{rng.randint(80, 900) * 1000}"])
    # A second-hand transfer between acquirers, to give paths length 2.
    rows.append([acquirers[0][0], acquirers[0][1], bens[0][0], bens[0][1], acquirers[3][0], acquirers[3][1],
                 (start + timedelta(days=95)).isoformat(timespec="minutes"), "150000"])
    data = _csv(["devedor_cpf", "devedor", "bem_id", "bem", "adquirente_cpf", "adquirente", "data", "valor"], rows)
    spec = _spec(
        "Alienações",
        [
            {"key": "devedor", "type": "Pessoa", "from": "t", "id": {"col": "t.devedor_cpf", "normalize": "cpf_cnpj"},
             "props": {"nome": "t.devedor", "cpf": "t.devedor_cpf"}},
            {"key": "adquirente", "type": "Pessoa", "from": "t", "id": {"col": "t.adquirente_cpf", "normalize": "cpf_cnpj"},
             "props": {"nome": "t.adquirente", "cpf": "t.adquirente_cpf"}},
            {"key": "bem", "type": "Bem", "from": "t", "id": "t.bem_id", "props": {"descricao": "t.bem"}},
        ],
        [
            {"from": "t", "type": "ALIENOU", "endpoints": {"self": "devedor", "other": "adquirente"},
             "props": {"valor": {"col": "t.valor", "convert": "decimal_br"}, "data": "t.data", "bem": "t.bem"}},
            {"from": "t", "type": "POSSUIA", "endpoints": {"self": "devedor", "other": "bem"}},
        ],
        {"amount_prop": "valor", "time_prop": "data"},
    )
    return data, spec, {"devedor": [f"Pessoa:{devedor[0]}"], "adquirentes": [f"Pessoa:{c}" for c, _ in acquirers]}


SYNTH_ATTRS = ("telefone", "email", "device_id", "ip", "cartao", "terminal", "endereco")


def sintetica_bundle(rng: random.Random) -> tuple[bytes, dict, list[str]]:
    """Registrations where a cluster of identities shares phones, e-mails,
    devices, IPs, cards, terminals and addresses (05 §4b)."""
    shared = {
        "telefone": f"+55 11 9{rng.randint(10**7, 10**8 - 1)}",
        "email": f"contato{rng.randint(10, 99)}@mail-temp.com",
        "device_id": f"dev-{rng.randint(10**5, 10**6 - 1)}",
        "ip": f"177.{rng.randint(10, 250)}.{rng.randint(1, 250)}.{rng.randint(1, 250)}",
        "cartao": f"5311 **** **** {rng.randint(1000, 9999)}",
        "terminal": f"T-{rng.randint(1000, 9999)}",
        "endereco": "Rua das Acácias, 120 ap 31 - São Paulo",
    }
    rows, cluster = [], []
    for i in range(10):
        cpf, nome = _cpf(rng), f"{rng.choice(FIRST)} {rng.choice(LAST)} {rng.choice(LAST)}"
        synthetic = i < 5
        if synthetic:
            cluster.append(f"Pessoa:{cpf}")
        row = {k: (shared[k] if synthetic and k in rng.sample(SYNTH_ATTRS, 4) else None) for k in SYNTH_ATTRS}
        own = {
            "telefone": f"+55 21 9{rng.randint(10**7, 10**8 - 1)}",
            "email": f"{nome.split()[0].lower()}.{rng.randint(1, 99)}@example.com",
            "device_id": f"dev-{rng.randint(10**5, 10**6 - 1)}",
            "ip": f"201.{rng.randint(10, 250)}.{rng.randint(1, 250)}.{rng.randint(1, 250)}",
            "cartao": f"4532 **** **** {rng.randint(1000, 9999)}",
            "terminal": f"T-{rng.randint(1000, 9999)}",
            "endereco": f"Av. Brasil, {rng.randint(10, 9000)} - Rio de Janeiro",
        }
        rows.append([cpf, nome, *(row[k] or own[k] for k in SYNTH_ATTRS)])
    data = _csv(["cpf", "nome", *SYNTH_ATTRS], rows)
    types = {"telefone": ("Telefone", "phone"), "email": ("Email", "email"), "device_id": ("Dispositivo", "lower"),
             "ip": ("IP", "none"), "cartao": ("Cartao", "none"), "terminal": ("Terminal", "none"), "endereco": ("Endereco", "lower")}
    nodes = [{"key": "pessoa", "type": "Pessoa", "from": "t", "id": {"col": "t.cpf", "normalize": "cpf_cnpj"},
              "props": {"nome": "t.nome", "cpf": "t.cpf"}}]
    edges = []
    for col, (node_type, norm) in types.items():
        nodes.append({"key": col, "type": node_type, "from": "t", "id": {"col": f"t.{col}", "normalize": norm},
                      "props": {"valor": f"t.{col}"}})
        edges.append({"from": "t", "type": f"USA_{node_type.upper()}", "endpoints": {"self": "pessoa", "other": col}})
    return data, _spec("Cadastros", nodes, edges), cluster


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
                    "POST", "/api/agent-tokens", self.owner, json={"name": "Agente de análise (seed)"}
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


def _fixture(*parts: str) -> Optional[bytes]:
    path = FIXTURES.joinpath(*parts)
    return path.read_bytes() if path.is_file() else None


async def upload(client: SeedClient, url: str, owner: str, name: str, data: bytes, title: Optional[str] = None,
                 kind: str = "table", subkind: str = "csv") -> dict:
    row = await client.request(
        "POST", f"{url}/items", owner, content=data,
        params={"filename": name, "kind": kind, "subkind": subkind, "title": title or name},
    )
    return row.json()


async def upload_graph(client: SeedClient, url: str, owner: str, files: dict[str, bytes], spec: dict, title: str) -> dict:
    """Uploads ``files`` as table items; the first one carries the graph mapping
    (the others are its extra inputs) and becomes the canvas source."""
    rows = [await upload(client, url, owner, name, data) for name, data in files.items()]
    main = next((r for r, name in zip(rows, files) if name.endswith("_EXTRATO.TXT")), rows[0])
    extra = [r["id"] for r in rows if r["id"] != main["id"]]
    patched = await client.request(
        "PATCH", f"{url}/items/{main['id']}", owner,
        json={"title": title, "mapping": {"as": "graph", "spec": spec, "extra_item_ids": extra}},
    )
    return patched.json()


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


async def finish(client: SeedClient, url: str, owner: str, final: str, stats: InvStats, rationale: str) -> None:
    """Moves the case to ``final`` ("open", "analysis", "archived", "decided:<outcome>")."""
    status, _, outcome = final.partition(":")
    if status in ("analysis", "archived", "decided"):
        await client.request("PATCH", url, owner, json={"status": "analysis"})
    if status == "decided":
        actions = ["dict", "spa"] if outcome == "comunicar" else []
        await client.request("POST", f"{url}/decision", owner,
                             json={"outcome": outcome, "actions": actions, "rationale": rationale})
    elif status == "archived":
        await client.request("PATCH", url, owner, json={"status": "archived"})
    stats.statuses[status] += 1


async def reset_seeded(client: SeedClient, log) -> int:
    """Deletes the cases carrying MARKER."""
    cases = (await client.request("GET", "/api/investigations", ADMIN_EMAIL)).json()
    deleted = 0
    for case in cases:
        if MARKER not in (case.get("description") or ""):
            continue
        await client.request("DELETE", f"/api/investigations/{case['id']}", ADMIN_EMAIL,
                             params={"reason": "dev seed reset (seed_investigations --reset)"})
        deleted += 1
    return deleted


# ---------------------------------------------------------------------------
# Scenarios
# ---------------------------------------------------------------------------


async def new_case(client: SeedClient, owner: str, rng: random.Random, title: str, preset: str, narrative: str,
                   stats: InvStats, **extra) -> tuple[dict, str]:
    others = [a for a in ANALYSTS if a != owner]
    case = (await client.request(
        "POST", "/api/investigations", owner,
        json={"title": title, "kind_preset": preset, "assignee_email": rng.choice(others),
              "description": f"{narrative}\n\n{MARKER}", **extra},
    )).json()
    url = f"/api/investigations/{case['id']}"
    await client.request("POST", f"{url}/share", owner, json={"email": rng.choice(others), "role": "reader"})
    stats.cases += 1
    return case, url


async def seed_credito(client, owner, agent, rng, stats, log) -> dict:
    case, url = await new_case(
        client, owner, rng, "Crédito · grupo econômico Alfa", "credito",
        "Pedido de limite consolidado para seis empresas com sócios em comum; conferir exposição e garantias.", stats,
        tags=["crédito", "grupo econômico"],
    )
    empresas, spec, garantias, enrichment, companies = credito_bundle(rng)
    rows = [await upload(client, url, owner, "empresas.csv", empresas, "QSA do grupo")]
    await client.request("PATCH", f"{url}/items/{rows[0]['id']}", owner, json={"mapping": {"as": "graph", "spec": spec}})
    gar = await upload(client, url, owner, "garantias.csv", garantias, "Garantias por CNPJ")
    await client.request("PATCH", f"{url}/items/{gar['id']}", owner, json={"mapping": {"as": "enrichment", "spec": enrichment}})
    stats.items["table"] += 2
    stats.versions += 2
    await add_item(
        owner_client(client, owner), url, stats, kind="query", subkind="sql", title="Faturamento por CNPJ (12 meses)",
        description="Roda no Databricks quando o context de faturamento estiver ligado ao caso.",
        query={"text": "SELECT cnpj, sum(valor) AS faturamento FROM fin.faturamento WHERE cnpj IN (:cnpjs) AND dt >= :de GROUP BY cnpj",
               "language": "sql", "output": "table",
               "parameters": [{"id": "cnpjs", "label": "CNPJs", "required": True}, {"id": "de", "label": "Desde", "default": "2025-01-01"}]},
    )
    await annotate(owner_client(client, owner), url, stats, "group", companies[:3], {"name": "Grupo Alfa", "color": 2})
    await annotate(owner_client(client, owner), url, stats, "tag", companies[3:4], {"tag": "fora do grupo"})
    await add_item(owner_client(client, owner), url, stats, kind="note", subkind="free", title="Pendências",
                   content="Pedir balanço auditado da Alfa Participações; conferir se a garantia rural está registrada.")
    await agent.request("PUT", f"{url}/brief", json={"text": (
        "# Exposição consolidada\n\nSeis empresas, três sócios em comum (QSA). Garantias cobrem ~60% do limite pedido; "
        "a Alfa Logística repete o sócio-administrador da holding.\n\n_Rascunho do agente; revisar antes de decidir._")})
    stats.items["document"] += 1
    stats.versions += 1
    await finish(client, url, owner, "analysis", stats, "")
    return case


def owner_client(client: SeedClient, owner: str):
    class _Owner:
        async def request(self, method, path, json=None, **kwargs):
            return await client.request(method, path, owner, json=json, **kwargs)

    return _Owner()


async def seed_garantia(client, owner, agent, rng, stats, log) -> dict:
    case, url = await new_case(
        client, owner, rng, "Fuga de garantia · contrato 2026/0042", "garantia",
        "Devedor alienou bens dados em garantia depois do vencimento; identificar cessionários e caminhos.", stats,
        occurred_at=datetime(2026, 2, 1).isoformat(), tags=["garantia", "alienação"],
    )
    data, spec, who = garantia_bundle(rng)
    row = await upload(client, url, owner, "alienacoes.csv", data, "Alienações do devedor (90 dias)")
    await client.request("PATCH", f"{url}/items/{row['id']}", owner, json={"mapping": {"as": "graph", "spec": spec}})
    stats.items["table"] += 1
    stats.versions += 1
    me = owner_client(client, owner)
    hyp = await annotate(me, url, stats, "hypothesis", [], {"text": "Os bens foram transferidos a interpostas pessoas após o vencimento"})
    await annotate(me, url, stats, "hypothesis_status", [hyp["id"]], {"status": "supported"}, "datas das alienações")
    await annotate(me, url, stats, "role", who["devedor"], {"role": "devedor"})
    for uid in who["adquirentes"]:
        await annotate(agent, url, stats, "role", [uid], {"role": "cessionário"}, "adquiriu bem do devedor após o vencimento")
    await annotate(agent, url, stats, "same_as", who["adquirentes"][:2], {"score": 0.72}, "mesmo endereço no cadastro")
    paths = (await client.request("POST", f"{url}/analysis/paths", owner,
                                  json={"source": who["devedor"][0], "target": who["adquirentes"][3], "mode": "k-shortest", "k": 3})).json()
    path_item = await add_item(me, url, stats, kind="table", subkind="result", title="Caminhos devedor → adquirente",
                               content_json=paths, provenance={"tool": "paths", "params": paths["method"]})
    await add_item(me, url, stats, kind="note", subkind="anchored", title="Nota no caminho",
                   content="O caminho de dois saltos passa pelo primeiro adquirente: pedir contrato de compra e venda.",
                   anchor={"entity_ids": who["adquirentes"][:1], "item_id": path_item["id"]})
    await pin(me, url, stats, path_item["id"], "Caminhos no prazo")
    await finish(client, url, owner, "decided:comunicar", stats,
                 "Alienações sucessivas após o vencimento, sem contrapartida financeira; medida cautelar e comunicação.")
    return case


async def seed_pix_med(client, owner, agent, rng, stats, log) -> dict:
    case, url = await new_case(
        client, owner, rng, "Golpe Pix · falsa central de atendimento", "pix_med",
        "Vítima transferiu R$ 4.870 após ligação de falsa central; MED aberto; rastrear até as saídas.", stats,
        alert_at=(datetime.now() - timedelta(days=14)).isoformat(), tags=["golpe pix", "MED"],
    )
    files, graph, late = golpe_pix_bundle(None)
    source = await upload_graph(client, url, owner, files, PRESETS["simba_v31"], "Extrato SIMBA · CASO1")
    for name, code, label in late:  # saques and other 9999 counterparts: one node per transaction
        node = f"desconhecido:{code}@{source['id']}"
        getattr(graph, name).append(node)
        graph.names[node] = label
    stats.items["table"] += len(files)
    stats.versions += len(files)
    qsa = _fixture("qsa-mini", "qsa-mini.csv")
    if qsa:
        row = await upload(client, url, owner, "qsa-mini.csv", qsa, "QSA Receita (mini)")
        await client.request("PATCH", f"{url}/items/{row['id']}", owner, json={"mapping": {"as": "enrichment", "spec": {
            "name": "QSA", "input": {"delimiter": ";", "header": False, "encoding": "latin-1",
                                      "columns": ["CNPJ_BASICO", "IDENTIFICADOR_SOCIO", "NOME_SOCIO", "CNPJ_CPF_SOCIO", "QUALIFICACAO_SOCIO",
                                                  "DATA_ENTRADA_SOCIEDADE", "PAIS", "REPRESENTANTE_LEGAL", "NOME_REPRESENTANTE",
                                                  "QUALIFICACAO_REPRESENTANTE", "FAIXA_ETARIA"]},
            "key_column": "CNPJ_BASICO", "columns": ["NOME_SOCIO", "CNPJ_CPF_SOCIO", "QUALIFICACAO_SOCIO"],
            "match_node_types": ["Pessoa"], "match_source": {"kind": "prop", "name": "cpf_cnpj"}, "key_digits": 8}}})
        stats.items["table"] += 1
        stats.versions += 1
    me = owner_client(client, owner)
    # Follow the money on the server (FIFO, the T5 numbers) and keep the run as evidence.
    trace = (await client.request(
        "POST", f"{url}/analysis/trace", owner,
        json={"seed_node": graph.victims[0], "direction": "forward", "allocation": "fifo",
              "max_hops": graph.hops, "max_dwell_hours": 24,
              "stop_nodes": graph.exits},  # SIMBA node types never match the default stops
    )).json()
    trace_item = await add_item(me, url, stats, kind="table", subkind="result", title="Rastreio #1 · FIFO",
                                content_json=trace, provenance={"tool": "trace", "params": trace["method"]})
    await pin(me, url, stats, trace_item["id"], "Rastreio FIFO")
    stats.flagship_trace = f"{trace_item['id']} coverage {trace['coverage']}"
    typ = (await client.request("POST", f"{url}/analysis/typologies", owner, json={"typologies": ["passagem"]})).json()
    [passagem] = typ["typologies"]
    if passagem["hits"]:
        await annotate(agent, url, stats, "typology", [h["nodeId"] for h in passagem["hits"]],
                       {"typology": "passagem", "norm_ref": passagem["normRef"], "label": passagem["label"]},
                       "recebe e repassa em minutos")
    for uid in graph.victims:
        await annotate(me, url, stats, "role", [uid], {"role": "vítima"})
    for uid in graph.mules[:3]:
        await annotate(agent, url, stats, "role", [uid], {"role": "mula"}, "repassa o valor recebido no mesmo dia")
    for uid in graph.exits:
        await annotate(me, url, stats, "role", [uid], {"role": "saída"})
    await add_item(agent, url, stats, kind="document", subkind="markdown", title="KYC das contas de passagem",
                   content="# KYC\n\nTitular 4471-0: renda declarada 1 salário mínimo; abertura há 40 dias.\n")
    await agent.request("PUT", f"{url}/brief", json={"text": (
        f"# Golpe Pix · falsa central\n\nO rastreio FIFO ({trace['coverage']:.0%} de cobertura) chega a saque em espécie, "
        "exchange e casa de apostas em 3 camadas. Conta 4471-0 é de passagem (CC 4.001 IV-k, sugerido).")})
    stats.items["document"] += 1
    stats.versions += 1
    await add_item(me, url, stats, kind="note", subkind="free", title="MED",
                   content="MED aberto pela vítima em D+1; valor parcialmente bloqueado na conta 4471-0.")
    await finish(client, url, owner, "analysis", stats, "")
    return case


async def seed_sintetica(client, owner, agent, rng, stats, log) -> dict:
    case, url = await new_case(
        client, owner, rng, "Fraude sintética · cadastros com dispositivo e telefone em comum", "fraude_sintetica",
        "Cinco identidades compartilham telefone, e-mail, dispositivo, IP, cartão, terminal ou endereço.", stats,
        tags=["fraude sintética"],
    )
    data, spec, cluster = sintetica_bundle(rng)
    row = await upload(client, url, owner, "cadastros.csv", data, "Cadastros (KYC)")
    await client.request("PATCH", f"{url}/items/{row['id']}", owner, json={"mapping": {"as": "graph", "spec": spec}})
    stats.items["table"] += 1
    stats.versions += 1
    me = owner_client(client, owner)
    await annotate(me, url, stats, "group", cluster, {"name": "Cluster sintético", "color": 5})
    for uid in cluster[:2]:
        await annotate(agent, url, stats, "role", [uid], {"role": "identidade sintética"}, "compartilha 3+ atributos com o cluster")
    await annotate(me, url, stats, "role", cluster[2:3], {"role": "identidade real"})
    await annotate(me, url, stats, "tag", cluster, {"tag": "vínculo por atributo"})
    await add_item(me, url, stats, kind="note", subkind="free", title="Próximos passos",
                   content="Rodar Vínculos por telefone + dispositivo quando a F4 chegar; conferir o terminal compartilhado.")
    await finish(client, url, owner, "open", stats, "")
    return case


async def seed_extra(client, owner, agent, rng, stats, log, index: int) -> dict:
    title, final = EXTRA_CASES[index % len(EXTRA_CASES)]
    if index >= len(EXTRA_CASES):
        title = f"{title} #{index // len(EXTRA_CASES) + 1}"
    case, url = await new_case(
        client, owner, rng, title, "pix_med",
        "Vítimas relatam transferências Pix induzidas por engenharia social; os valores caem numa conta recém-aberta e saem no mesmo dia.",
        stats, alert_at=(datetime.now() - timedelta(days=rng.randint(1, 60))).isoformat(), tags=["golpe pix"],
    )
    files, graph, late = simba_bundle(rng, f"CASO{index + 2}")
    source = await upload_graph(client, url, owner, files, PRESETS["simba_v31"], f"Extrato SIMBA · CASO{index + 2}")
    for name, code, label in late:
        getattr(graph, name).append(f"desconhecido:{code}@{source['id']}")
    stats.items["table"] += len(files)
    stats.versions += len(files)
    me = owner_client(client, owner)
    for uid in graph.victims[:2]:
        await annotate(me, url, stats, "role", [uid], {"role": "vítima"})
    for uid in graph.mules[:2]:
        await annotate(agent, url, stats, "role", [uid], {"role": "mula"}, "recebe e repassa")
    hyp = await annotate(me, url, stats, "hypothesis", [], {"text": f"A conta {graph.mules[0].split(':')[-1]} funciona como conta de passagem"})
    await annotate(agent, url, stats, "hypothesis_status", [hyp["id"]], {"status": "supported"}, "rastreio")
    await add_item(me, url, stats, kind="note", subkind="free", title="Nota",
                   content=rng.choice(["Pedir ao banco destinatário o extrato dos últimos 90 dias.",
                                       "Mesmo IP de abertura em três contas do caso.",
                                       "Saque em espécie no mesmo dia do crédito, em agência de outra cidade."]))
    await finish(client, url, owner, final, stats, "Conta de passagem identificada no rastreio; comunicar." if "comunicar" in final else "Sem indícios suficientes.")
    return case


SCENARIOS = (seed_credito, seed_garantia, seed_pix_med, seed_sintetica)


async def run_seed_investigations(api: str, *, cases: int = 8, seed: int = 42, reset: bool = False,
                                  ui: str = "http://localhost:3000", log=print) -> InvStats:
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
        agents: dict[str, Agent] = {}
        for i in range(cases):
            owner = ANALYSTS[i % len(ANALYSTS)]
            agent = agents.setdefault(owner, Agent(client, owner, stats.agent))
            if i < len(SCENARIOS):
                case = await SCENARIOS[i](client, owner, agent, rng, stats, log)
            else:
                case = await seed_extra(client, owner, agent, rng, stats, log, i - len(SCENARIOS))
            log(f"  [{i + 1}/{cases}] {case['title']}")
            if case["kind_preset"] == "pix_med" and stats.flagship is None:
                stats.flagship = f"{ui.rstrip('/')}/investigations/{case['id']}"
        log("")
        log(f"cases: {stats.cases} · " + ", ".join(f"{k}: {v}" for k, v in sorted(stats.statuses.items())))
        log("items: " + ", ".join(f"{k}: {v}" for k, v in sorted(stats.items.items())) + f" · {stats.versions} versions, {stats.pinned} pinned")
        log("annotations: " + ", ".join(f"{k}: {v}" for k, v in sorted(stats.annotations.items())) + f" · {stats.suggested} suggested")
        log(f"authored by {'agent tokens' if stats.agent else 'owners'}")
        if stats.flagship:
            log(f"Pix/MED case (Follow the money): {stats.flagship}")
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
    parser.add_argument("--ui", default="http://localhost:3000", help="frontend base for the printed links")
    parser.add_argument("--wait", type=float, default=60.0, help="seconds to wait for the API")
    return parser


def main(argv: Optional[list[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    logging.getLogger("httpx").setLevel(logging.WARNING)  # one line per request otherwise
    try:
        base = asyncio.run(wait_for_health(args.api, args.wait))
        asyncio.run(run_seed_investigations(base, cases=args.cases, seed=args.seed, reset=args.reset, ui=args.ui))
    except SeedError as exc:
        print(f"seed failed: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
