"""Dev seed for investigations: ~20 realistic cases on a *running* API.

    uv run python -m graphlagoon.dev.seed_investigations --api http://localhost:8000 \\
        [--cases 20] [--seed 42] [--reset]

Works with nothing but the API (memory mode, no warehouse): every case gets a
money graph from SIMBA files uploaded to it and turned into a graph by the
server (``POST …/files/{fid}/context``, preset ``simba_v31``). The first case
("Golpe Pix · falsa central de atendimento") carries the T5 design scenario
(``trace/golpe-pix.json`` written as SIMBA, plus the ``qsa-mini`` fixture); the
others get a generated SIMBA bundle (victims → conta laranja → 3–4 layers of
mules → saque/exchange/bet/PJ), so Follow-the-money reaches exits on all of
them. Explorations left by ``graphlagoon.dev.seed`` are attached as live
sources to a few cases when they exist.

Each case gets notes, roles, frozen evidence (graph, table, file, trace),
hypotheses, entity matches, accepted typology badges, versioned artifacts and
proposals written by an agent token (``GRAPH_LAGOON_AGENTS_ENABLED=true``;
without it the owner writes them), and ends in one of every status, decided
ones through ``POST …/decision`` with both outcomes.

Seeded cases carry ``[seed:investigations]`` in the description. A rerun adds
more; ``--reset`` first deletes the seeded cases (superuser, ``?reason=`` for
decided ones) and the file contexts they generated.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import random
import struct
import sys
import zlib
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Optional

from graphlagoon.dev.seed import (
    ADMIN_EMAIL,
    SEED_DOMAIN,
    SeedClient,
    SeedError,
    wait_for_health,
)
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
    for name in (
        "ana.ribeiro",
        "bruno.tavares",
        "carla.mendes",
        "diego.farias",
        "elisa.moura",
        "fabio.nunes",
    )
]
# Rotates per agent token below this, under the API's 120 requests/minute.
AGENT_TOKEN_BUDGET = 100

# (title, typology, origin, final status, data). The first five cover every
# status, so even --cases 5 shows them all. Data: "mini" = the golpe-pix trace
# fixture as SIMBA + the QSA fixture; "simba" = a generated bundle; "qsa" = QSA fixture + bundle;
# "live" = live explorations from the regular seed (when any) + bundle.
CASES = [
    ("Golpe Pix · falsa central de atendimento", "Golpe Pix", "notificacao_med", "analise", "mini"),
    ("Conta laranja · abertura em lote na agência 0412", "Conta laranja", "monitoramento", "selecao", "simba"),
    ("Golpe Pix · falso leilão de veículos", "Golpe Pix", "notificacao_med", "comunicar", "live"),
    ("Lojista de fachada · maquininhas em nome de laranjas", "Lojista de fachada", "monitoramento", "arquivar", "qsa"),
    ("Bets · recargas fracionadas em casa de apostas", "Bets", "monitoramento", "arquivado", "simba"),
    ("Lavagem · rede de empresas de fachada do grupo Horizonte", "Lavagem", "oficio", "analise", "live"),
    ("Golpe Pix · falso parente no WhatsApp", "Golpe Pix", "notificacao_med", "analise", "simba"),
    ("Conta laranja · universitários aliciados por anúncio", "Conta laranja", "denuncia", "comunicar", "simba"),
    ("Lojista de fachada · ótica sem estoque com recebíveis altos", "Lojista de fachada", "monitoramento", "selecao", "qsa"),
    ("Bets · conta de passagem para plataforma de apostas", "Bets", "monitoramento", "analise", "simba"),
    ("Lavagem · Ofício judicial 2026/118", "Lavagem", "oficio", "comunicar", "live"),
    ("Golpe Pix · boleto falso de financiamento", "Golpe Pix", "notificacao_med", "selecao", "simba"),
    ("Conta laranja · CPF de pessoa falecida", "Conta laranja", "monitoramento", "arquivar", "simba"),
    ("Lojista de fachada · restaurante com faturamento incompatível", "Lojista de fachada", "denuncia", "analise", "qsa"),
    ("Bets · influenciador com rifas e apostas", "Bets", "denuncia", "arquivado", "simba"),
    ("Lavagem · fracionamento de depósitos em espécie", "Lavagem", "monitoramento", "analise", "simba"),
    ("Golpe Pix · notificação MED em lote (12 vítimas)", "Golpe Pix", "notificacao_med", "comunicar", "simba"),
    ("Conta laranja · contas PJ recém-abertas no mesmo endereço", "Conta laranja", "monitoramento", "selecao", "qsa"),
    ("Lojista de fachada · eletrônicos vendidos sem nota", "Lojista de fachada", "oficio", "arquivar", "live"),
    ("Lavagem · transferências circulares entre sócios", "Lavagem", "oficio", "analise", "simba"),
]
NARRATIVE = {
    "Golpe Pix": "Vítimas relatam transferências Pix induzidas por engenharia social; os valores caem numa conta recém-aberta e saem no mesmo dia.",
    "Conta laranja": "Contas abertas com renda declarada baixa recebem e repassam volumes incompatíveis logo após a abertura.",
    "Lojista de fachada": "Estabelecimento com recebíveis de cartão muito acima do porte declarado e sócios ligados a outras empresas do caso.",
    "Bets": "Recargas fracionadas para plataformas de apostas, com saques concentrados em poucas contas de pessoas físicas.",
    "Lavagem": "Movimentação em camadas entre contas de sócios e empresas relacionadas, com retorno parcial dos valores à origem.",
}
ALT_TYPOLOGY = {
    "Golpe Pix": "Conta laranja",
    "Conta laranja": "Golpe Pix",
    "Lojista de fachada": "Lavagem",
    "Bets": "Lavagem",
    "Lavagem": "Lojista de fachada",
}
FIRST = ["MARIA", "JOSE", "ANA", "JOAO", "FRANCISCA", "ANTONIO", "ADRIANA", "CARLOS",
         "PAULO", "LUCIANA", "MARCOS", "JULIANA", "RAFAEL", "PATRICIA", "FERNANDO", "ALINE"]
LAST = ["SILVA", "SANTOS", "OLIVEIRA", "SOUZA", "RODRIGUES", "FERREIRA", "ALVES", "PEREIRA",
        "LIMA", "GOMES", "COSTA", "RIBEIRO", "MARTINS", "CARVALHO", "ARAUJO", "BARBOSA"]
NOTES = [
    "Vítima confirmou por telefone que recebeu ligação de falsa central antes da transferência.",
    "Titular declarou renda de um salário mínimo; volume do mês é 40× maior.",
    "Pedir ao banco destinatário o extrato completo dos últimos 90 dias.",
    "Mesmo IP de abertura em três contas do caso — conferir com a área de fraude.",
    "Saque em espécie no mesmo dia do crédito, em agência de outra cidade.",
    "MED aberto pela vítima; valor parcialmente bloqueado.",
]
HYPOTHESES = {
    "Golpe Pix": "A conta {conta} funciona como conta de passagem do golpe",
    "Conta laranja": "{laranja} cedeu a conta a terceiros mediante pagamento",
    "Lojista de fachada": "Os recebíveis de cartão não correspondem a vendas reais",
    "Bets": "As recargas fracionadas evitam o limite de comunicação automática",
    "Lavagem": "Os valores retornam aos sócios depois de passar por empresas do grupo",
}
REJECT_REASONS = [
    "Sem evidência suficiente no extrato; manter como está por enquanto.",
    "Já tratado pelo analista em outra frente do caso.",
    "O padrão observado não sustenta essa leitura; ver evidência E1.",
]


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


@dataclass
class InvStats:
    cases: int = 0
    statuses: Counter = field(default_factory=Counter)
    artifacts: int = 0
    versions: int = 0
    approved: int = 0
    proposals: Counter = field(default_factory=Counter)
    matches: Counter = field(default_factory=Counter)
    evidence: int = 0
    badges: int = 0
    live_sources: int = 0
    deleted: int = 0
    agent: bool = False
    flagship: Optional[str] = None
    flagship_trace: Optional[str] = None


# ---------------------------------------------------------------------------
# Data: generated SIMBA bundles and small binary artifacts
# ---------------------------------------------------------------------------


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


def png_bytes(rng: random.Random, width: int = 96, height: int = 48) -> bytes:
    """A small bar chart as a valid PNG (stdlib only)."""
    bars = [rng.randint(8, height - 4) for _ in range(8)]
    rows = []
    for y in range(height):
        row = bytearray([0])
        for x in range(width):
            bar = bars[x * len(bars) // width]
            on = height - y <= bar and x % (width // len(bars)) > 1
            row += bytes((37, 99, 235) if on else (248, 250, 252))
        rows.append(bytes(row))

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(b"".join(rows)))
        + chunk(b"IEND", b"")
    )


def pdf_bytes(lines: list[str]) -> bytes:
    """A one-page PDF with ``lines`` in Helvetica (valid xref, stdlib only)."""
    text = "BT /F1 12 Tf 56 780 Td 16 TL " + " ".join(
        "(" + s.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)") + ") '" for s in lines
    ) + " ET"
    stream = text.encode("latin-1", "replace")
    objects = [
        b"<</Type/Catalog/Pages 2 0 R>>",
        b"<</Type/Pages/Kids[3 0 R]/Count 1>>",
        b"<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Contents 4 0 R"
        b"/Resources<</Font<</F1 5 0 R>>>>>>",
        b"<</Length %d>>stream\n" % len(stream) + stream + b"\nendstream",
        b"<</Type/Font/Subtype/Type1/BaseFont/Helvetica/Encoding/WinAnsiEncoding>>",
    ]
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for i, body in enumerate(objects, 1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % i + body + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1)
    out += b"".join(b"%010d 00000 n \n" % o for o in offsets)
    out += b"trailer\n<</Size %d/Root 1 0 R>>\nstartxref\n%d\n%%%%EOF\n" % (len(objects) + 1, xref)
    return bytes(out)


def brl(value: float) -> str:
    return f"R$ {value:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")


# ---------------------------------------------------------------------------
# HTTP helpers
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
                    "POST",
                    "/api/agent-tokens",
                    self.owner,
                    json={"name": "Agente de análise (seed)", "scopes": ["read", "analyze", "write", "propose"]},
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
            raise SeedError(
                f"{method} {path} as agent of {self.owner} → {response.status_code}: {response.text[:300]}"
            )
        return response


def _fixture(*parts: str) -> Optional[bytes]:
    path = FIXTURES.joinpath(*parts)
    return path.read_bytes() if path.is_file() else None


async def upload_graph(
    client: SeedClient, url: str, owner: str, files: dict[str, bytes], preset: str, title: str
) -> dict:
    """Uploads ``files`` with the graph role and builds one file graph from them."""
    ids = []
    for name, data in files.items():
        row = await client.request(
            "POST", f"{url}/files", owner, content=data, params={"filename": name, "role": "graph"}
        )
        ids.append(row.json()["id"])
    main = next(
        (fid for fid, name in zip(ids, files) if name.endswith("_EXTRATO.TXT")), ids[0]
    )
    return (
        await client.request(
            "POST",
            f"{url}/files/{main}/context",
            owner,
            json={"mapping": PRESETS[preset], "file_ids": ids, "title": title},
        )
    ).json()


async def find_live_explorations(client: SeedClient) -> list[tuple[str, list[str]]]:
    """[(owner, [exploration per context])] for owners of explorations in 2+
    non-file contexts they own, from the regular seed; [] when there are none."""
    try:
        contexts = (await client.request("GET", "/api/graph-contexts", ADMIN_EMAIL)).json()
        explorations = (await client.request("GET", "/api/explorations", ADMIN_EMAIL)).json()
    except SeedError:
        return []
    ctx = {c["id"]: c for c in contexts if c.get("datasource_type") != "file"}
    by_owner: dict[str, dict[str, str]] = {}
    for e in sorted(explorations, key=lambda e: e["id"]):
        c = ctx.get(e["graph_context_id"])
        if c and c.get("owner_email") == e["owner_email"]:
            by_owner.setdefault(e["owner_email"], {}).setdefault(c["id"], e["id"])
    return [(o, list(per.values())[:3]) for o, per in sorted(by_owner.items()) if len(per) >= 2]


async def reset_seeded(client: SeedClient, log) -> int:
    """Deletes the cases carrying MARKER and the file contexts they generated."""
    cases = (await client.request("GET", "/api/investigations", ADMIN_EMAIL)).json()
    deleted = 0
    for case in cases:
        if MARKER not in (case.get("description") or ""):
            continue
        url = f"/api/investigations/{case['id']}"
        sources = (await client.request("GET", f"{url}/sources", ADMIN_EMAIL)).json()
        await client.request(
            "DELETE", url, ADMIN_EMAIL, params={"reason": "dev seed reset (seed_investigations --reset)"}
        )
        deleted += 1
        for s in sources:
            if s.get("kind") == "file" and s.get("context_id"):
                try:
                    await client.request("DELETE", f"/api/graph-contexts/{s['context_id']}", ADMIN_EMAIL)
                except SeedError as exc:
                    log(f"  file context {s['context_id']} not deleted ({exc})")
    return deleted


# ---------------------------------------------------------------------------
# One case
# ---------------------------------------------------------------------------


async def seed_case(
    client: SeedClient,
    index: int,
    plan: tuple,
    rng: random.Random,
    live: list[tuple[str, list[str]]],
    agents: dict[str, Agent],
    agents_enabled: bool,
    stats: InvStats,
    log,
) -> dict:
    title, typology, origin, final, data = plan
    if index >= len(CASES):
        title = f"{title} #{index // len(CASES) + 1}"
    live_pick = live[index % len(live)] if data == "live" and live else None
    owner = live_pick[0] if live_pick else ANALYSTS[index % len(ANALYSTS)]
    others = [a for a in ANALYSTS if a != owner]
    assignee = None if final == "selecao" and index % 2 else rng.choice(others)
    case = (
        await client.request(
            "POST",
            "/api/investigations",
            owner,
            json={
                "title": title,
                "typology": typology,
                "origin": origin,
                "assignee_email": assignee,
                "description": f"{NARRATIVE[typology]}\n\n{MARKER}",
            },
        )
    ).json()
    cid = case["id"]
    url = f"/api/investigations/{cid}"
    agent = agents.setdefault(owner, Agent(client, owner, agents_enabled))
    for target in rng.sample([o for o in others if o != assignee], k=rng.randint(1, 2)):
        await client.request(
            "POST", f"{url}/share", owner, json={"email": target, "permission": rng.choice(["read", "write"])}
        )

    # Sources: file graphs (always) and live explorations (when the regular seed ran).
    if live_pick:
        for exp_id in live_pick[1]:
            try:
                await client.request(
                    "POST", f"{url}/sources", owner,
                    json={"kind": "exploration", "exploration_id": exp_id, "mode": "live"},
                )
                stats.live_sources += 1
            except SeedError as exc:
                log(f"  live source skipped ({exc})")
    qsa_ctx = None
    if data in ("mini", "qsa"):
        qsa = _fixture("qsa-mini", "qsa-mini.csv")
        if qsa:
            qsa_ctx = (await upload_graph(client, url, owner, {"QSA_SOCIOS.csv": qsa}, "qsa_receita", "QSA Receita"))["context_id"]
    if data == "mini" and GOLPE_PIX.is_file():
        files, graph, late = golpe_pix_bundle(qsa_ctx)
    else:
        if data == "mini":
            log("  golpe-pix trace fixture not found; using a generated bundle")
        files, graph, late = simba_bundle(rng, f"CASO{index + 1:02d}")
    simba = await upload_graph(client, url, owner, files, "simba_v31", f"SIMBA CASO{index + 1:02d}")
    for name, code, label in late:  # saques and other 9999 counterparts: one node per transaction
        node = f"desconhecido:{code}@{simba['context_id']}"
        getattr(graph, name).append(node)
        graph.names[node] = label
    source_id = simba["source"]["id"]

    # Frozen evidence: the file graph, its transactions, the file and a trace.
    snap = (await client.request("GET", f"{url}/sources/{source_id}/snapshot", owner)).json().get("snapshot") or {}
    nodes = [{"node_id": n["id"], "node_type": n.get("type"), "properties": n.get("properties") or {}}
             for n in snap.get("nodes") or []]
    edges = [{"edge_id": e["id"], "src": e["source"], "dst": e["target"], "relationship_type": e.get("type"),
              "properties": e.get("properties") or {}} for e in snap.get("edges") or []]
    money = [e for e in edges if "valor" in e["properties"]]
    evidence: dict[str, str] = {}

    async def pin(key: str, body: dict, by_agent: bool = False) -> None:
        req = agent.request if by_agent else (lambda m, p, **kw: client.request(m, p, owner, **kw))
        evidence[key] = (await req("POST", f"{url}/evidence", json=body)).json()["id"]
        stats.evidence += 1

    await pin("graph", {
        "title": f"Grafo · {simba['source']['title_snapshot']} · {len(nodes)} nós",
        "kind": "graph_state",
        "params": {"tab": source_id, "tab_title": simba["source"]["title_snapshot"], "nodes": len(nodes), "edges": len(edges)},
        "snapshot": {"nodes": nodes, "edges": edges, "roles": {}},
    })
    await pin("table", {
        "title": f"Transações do extrato · {len(money)} lançamentos",
        "kind": "table",
        "params": {"columns": ["origem", "destino", "tipo", "valor", "data"]},
        "snapshot": [
            {"origem": e["src"], "destino": e["dst"], "tipo": e["relationship_type"],
             "valor": e["properties"].get("valor"), "data": e["properties"].get("data")}
            for e in money
        ],
    }, by_agent=index % 2 == 0)
    file_row = simba["file"]
    await pin("file", {
        "title": f"Arquivo {file_row['filename']}",
        "kind": "file",
        "params": {"file_id": file_row["id"], "filename": file_row["filename"], "sha256": file_row["sha256"]},
        "snapshot": {"filename": file_row["filename"], "sha256": file_row["sha256"], "size_bytes": file_row["size_bytes"]},
    })
    try:
        trace = (await client.request(
            "POST", f"{url}/analysis/trace", owner,
            json={"seed_node": graph.victims[0], "direction": "forward", "allocation": "fifo",
                  "max_hops": graph.hops, "max_dwell_hours": 24,
                  "stop_nodes": graph.exits},  # SIMBA node types never match the default stops
        )).json()
        victim = graph.names.get(graph.victims[0], graph.victims[0])
        if index == 0:
            stats.flagship_trace = (
                f"{victim}, FIFO/{graph.hops} camadas/Δ 24h: {brl(trace['seedTotal'])} → "
                + ", ".join(f"{graph.names.get(k, k)} {brl(v)}" for k, v in trace["exits"].items())
                + f" · cobertura {trace['coverage']:.1%}"
            )
        await pin("trace", {
            "title": f"Trace FIFO, {graph.hops} camadas · {victim}",
            "kind": "trace",
            "params": {**trace["method"], "engine": "server"},
            "snapshot": trace,
        })
    except SeedError as exc:
        log(f"  trace skipped ({exc})")

    # Roles, pins and notes.
    roles = {u: "victim" for u in graph.victims} | {u: "mule" for u in graph.mules}
    roles |= {u: "exit" for u in graph.exits} | {u: "discarded" for u in graph.discarded}
    await client.request(
        "PATCH", f"{url}/state", owner,
        json={"roles": roles, "pins": {graph.mules[0]: True, graph.victims[0]: True}},
    )
    anchors = [
        {"kind": "node", "id": graph.victims[0]},
        {"kind": "node", "id": graph.mules[0]},
        {"kind": "evidence", "id": evidence["table"]},
        {"kind": "none"},
    ]
    for anchor, body in zip(anchors[: rng.randint(2, 4)], rng.sample(NOTES, 4)):
        author = rng.choice([owner, assignee or owner])
        await client.request("POST", f"{url}/notes", author, json={"anchor": anchor, "body": body})

    # Hypotheses with evidence for and against.
    h1 = HYPOTHESES[typology].format(conta=graph.mules[0].split(":", 1)[1], laranja=graph.names.get(graph.mules[1], "o titular"))
    await client.request("POST", f"{url}/hypotheses", owner, json={
        "text": h1, "status": "sustentada" if final in ("comunicar", "analise") else "aberta",
        "evidence_for": [evidence.get("trace", evidence["graph"]), evidence["table"]],
    })
    await client.request("POST", f"{url}/hypotheses", owner, json={
        "text": "As vítimas conheciam o recebedor antes das transferências",
        "status": "refutada", "evidence_against": [evidence["table"]],
        "note": "Nenhuma transferência anterior entre as partes no período.",
    })
    if index % 2:
        await client.request("POST", f"{url}/hypotheses", owner, json={
            "text": "Há um operador comum por trás das contas de passagem",
            "evidence_for": [evidence["graph"]], "evidence_against": [evidence["file"]],
        })

    # Entity matches: the agent suggests, people decide (one left for a proposal).
    created = (await agent.request("POST", f"{url}/matches", json={"matches": [
        {"left": {"uid": a}, "right": {"uid": b}, "score": score, "reasons": [
            {"term": "name", "weight": 0.5, "value": round(min(1.0, score + 0.1), 4),
             "left": graph.names.get(a, a), "right": graph.names.get(b, b)},
            {"term": "cpf_middle6", "weight": 0.3, "value": 1, "masked": True},
            {"term": "cep5", "weight": 0.2, "value": 0},
        ]}
        for a, b, score in graph.pairs
    ]})).json()
    decisions = [("aceito", "Mesmo CPF parcial e mesmo nome; mesma pessoa."),
                 ("recusado", "Homônimos: datas de nascimento diferentes no cadastro."),
                 ("adiado", "Aguardando resposta do banco sobre o cadastro.")]
    for match, (status, reason) in zip(created, decisions):
        await client.request("PATCH", f"{url}/matches/{match['id']}", owner, json={"status": status, "reason_text": reason})
        stats.matches[status] += 1
    open_matches = created[len(decisions):]
    stats.matches["sugerido"] += len(open_matches)

    # Typology badges with hits, accepted by a person (journal event).
    try:
        badges = (await client.request("POST", f"{url}/analysis/typologies", owner, json={})).json()
        for r in [r for r in badges["typologies"] if r["hits"]][:2]:
            await client.request("POST", f"{url}/events", owner, json={"kind": "typology.accepted", "payload": {
                "typology": r["id"], "normRef": r["normRef"], "label": r["label"], "params": r["params"],
                "hits": len(r["hits"]), "nodes": [h.get("nodeId") for h in r["hits"][:50]],
            }})
            stats.badges += 1
    except SeedError as exc:
        log(f"  typology badges skipped ({exc})")

    # Artifacts by the agent, 1–4 versions; a person approves some.
    total = sum(e["properties"].get("valor") or 0 for e in money)
    specs = [
        ("relatorio-preliminar.md", "report", lambda v: (
            f"# {title}\n\n**Versão {v}** · tipologia: {typology}\n\n## Resumo\n\n{NARRATIVE[typology]}\n\n"
            f"- Vítimas: {len(graph.victims)}\n- Contas de passagem: {graph.mules[0]}\n"
            f"- Volume no extrato: {brl(total)}\n\n## Próximos passos\n\n1. Confirmar titularidade.\n"
            f"2. Solicitar bloqueio cautelar.\n" + ("\n## Revisão\n\nAjustes pedidos pelo analista incorporados.\n" if v > 1 else "")
        ), 4),
        ("transacoes-suspeitas.csv", None, lambda v: "origem,destino,tipo,valor,data\n" + "".join(
            f"{e['src']},{e['dst']},{e['relationship_type']},{e['properties'].get('valor')},{e['properties'].get('data')}\n"
            for e in money[: max(1, len(money) - 2 + v)]
        ), 3),
        ("laudo-tecnico.pdf", None, lambda v: pdf_bytes([
            f"Laudo tecnico - versao {v}", title.encode("ascii", "ignore").decode(),
            f"Volume analisado: {brl(total)}", f"Lancamentos: {len(money)}",
        ]), 2),
        ("fluxo-financeiro.png", None, lambda v: png_bytes(rng), 2),
        ("painel-interativo.html", None, lambda v: (
            f"<!doctype html><meta charset=utf-8><title>Painel</title><h1>{len(nodes)} nós · {len(edges)} arestas</h1>"
        ), 1),
    ]
    picked = specs if index == 0 else rng.sample(specs, k=rng.randint(2, len(specs)))
    for name, kind, render, max_versions in picked:
        artifact = None
        for v in range(1, rng.randint(1, max_versions) + 1):
            body = render(v)
            note = "Primeira versão gerada pelo agente" if v == 1 else f"Revisão {v}: incorpora comentários"
            path = f"{url}/artifacts" if artifact is None else f"{url}/artifacts/{artifact['id']}/versions"
            ev = [evidence["table"]]
            if isinstance(body, bytes):
                params = {"name": name, "note": note, "source_evidence_ids": ev} | ({"kind": kind} if kind else {})
                artifact = (await agent.request("POST", path, content=body, params=params)).json()
            else:
                artifact = (await agent.request("POST", path, json={
                    "name": name, "text": body, "kind": kind, "note": note, "source_evidence_ids": ev,
                })).json()
            stats.versions += 1
        stats.artifacts += 1
        roll = rng.random()
        if roll < 0.7:  # approve the latest, or v1 only (newer drafts pending review)
            version = artifact["current_version"] if roll < 0.4 else 1
            await client.request("POST", f"{url}/artifacts/{artifact['id']}/versions/{version}/approve", owner)
            stats.approved += 1

    # Proposals by the agent: accepted, pending or rejected (with a reason).
    proposals = [
        ("role", {"entity": graph.mules[-1], "role": "exit"}, "Recebe e saca no mesmo dia: perfil de saída."),
        ("typology", {"typology": ALT_TYPOLOGY[typology]}, "Padrão de contas recém-abertas com repasse imediato."),
        ("hypothesis", {"text": "A mula repassa para contas de terceiros em menos de 24 h", "evidence_for": [evidence["table"]]},
         "Tempo de permanência dos valores abaixo de um dia em todas as contas."),
        ("hypothesis_status", {"hypothesis_id": "H1", "status": "sustentada"}, "O rastreio cobre a maior parte do valor."),
        ("status", {"status": "analise"}, "Há elementos suficientes para iniciar a análise."),
    ]
    if open_matches:
        proposals.append(("match", {"match_id": open_matches[0]["id"], "status": "aceito",
                                    "reason_text": "Mesmo nome e CPF parcial compatível."}, "Mesma pessoa nas duas fontes."))
    for k, (kind, payload, rationale) in enumerate(proposals):
        p = (await agent.request("POST", f"{url}/proposals", json={"kind": kind, "payload": payload, "rationale": rationale})).json()
        outcome = ("accepted", "pending", "rejected")[(index + k) % 3]
        if kind == "status" and final == "selecao" and outcome == "accepted":
            outcome = "pending"  # keep the case in selection
        if outcome == "accepted":
            await client.request("POST", f"{url}/proposals/{p['id']}/accept", owner)
            if kind == "match":
                stats.matches["sugerido"] -= 1
                stats.matches["aceito"] += 1
        elif outcome == "rejected":
            await client.request("POST", f"{url}/proposals/{p['id']}/reject", owner,
                                 json={"reason": REJECT_REASONS[(index + k) % len(REJECT_REASONS)]})
        stats.proposals[outcome] += 1

    # Final status.
    current = (await client.request("GET", url, owner)).json()["status"]
    if final != "selecao" and current != "analise":
        await client.request("PATCH", url, owner, json={"status": "analise"})
    if final == "arquivado":
        await client.request("PATCH", url, owner, json={"status": "arquivado"})
    elif final in ("comunicar", "arquivar"):
        await client.request("POST", f"{url}/decision", owner, json={
            "outcome": final,
            "actions": ["dict", "bloqueio_cautelar"] if final == "comunicar" else [],
            "rationale": (
                "Indícios suficientes de lavagem (CC 4.001): contas de passagem, saque imediato e vítimas identificadas."
                if final == "comunicar"
                else "Movimentação explicada pela documentação apresentada; sem indícios que justifiquem comunicação."
            ),
        })
    status = (await client.request("GET", url, owner)).json()["status"]
    stats.statuses[status] += 1
    stats.cases += 1
    return case


async def run_seed_investigations(
    api: str,
    *,
    cases: int = 20,
    seed: int = 42,
    reset: bool = False,
    ui: str = "http://localhost:3000",
    log=print,
) -> InvStats:
    rng = random.Random(seed)
    stats = InvStats()
    client = SeedClient(api)
    try:
        config = (await client.request("GET", "/api/config", ADMIN_EMAIL)).json()
        if not config.get("dev_mode"):
            raise SeedError("Server is not in dev mode; refusing to seed.")
        stats.agent = bool(config.get("agents_enabled"))
        if not stats.agent:
            log("warning: agents are disabled (GRAPH_LAGOON_AGENTS_ENABLED); "
                "artifacts and proposals are written by the case owners instead.")
        if reset:
            if not config.get("is_superuser"):
                raise SeedError(f"--reset needs {ADMIN_EMAIL} in GRAPH_LAGOON_SUPERUSER_EMAILS.")
            stats.deleted = await reset_seeded(client, log)
            log(f"reset: {stats.deleted} seeded case(s) deleted")
        live = await find_live_explorations(client)
        if not live:
            log("no explorations from graphlagoon.dev.seed found; cases use file graphs only")
        agents: dict[str, Agent] = {}
        for i in range(cases):
            case = await seed_case(client, i, CASES[i % len(CASES)], rng, live, agents, stats.agent, stats, log)
            log(f"  [{i + 1}/{cases}] {case['title']}")
            if stats.flagship is None:
                stats.flagship = f"{ui.rstrip('/')}/investigations/{case['id']}"
        log("")
        log(f"cases: {stats.cases} · " + ", ".join(f"{k}: {v}" for k, v in sorted(stats.statuses.items())))
        log(f"artifacts: {stats.artifacts} ({stats.versions} versions, {stats.approved} approved) · "
            f"authored by {'agent tokens' if stats.agent else 'owners'}")
        log("proposals: " + ", ".join(f"{k}: {v}" for k, v in sorted(stats.proposals.items())))
        log("matches: " + ", ".join(f"{k}: {v}" for k, v in sorted(stats.matches.items())))
        log(f"evidence: {stats.evidence} · typology badges: {stats.badges} · live sources: {stats.live_sources}")
        log(f"SIMBA case (Follow the money): {stats.flagship}")
        log(f"  trace {stats.flagship_trace}")
        log(f"log in as {ANALYSTS[0]} (owner) or {ADMIN_EMAIL} (superuser, sees all)")
        return stats
    finally:
        await client.close()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--api", default="http://localhost:8000")
    parser.add_argument("--cases", type=int, default=20)
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
        asyncio.run(
            run_seed_investigations(base, cases=args.cases, seed=args.seed, reset=args.reset, ui=args.ui)
        )
    except SeedError as exc:
        print(f"seed failed: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
