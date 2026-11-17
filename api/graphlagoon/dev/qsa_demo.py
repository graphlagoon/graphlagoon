"""The "Demo · QSA" partner register: a graph with two hubs that have hundreds of
direct neighbours, the case the hub helpers were built for (docs/guide/
exploring-the-graph.md — automatic adjustments, hubs with many leaves, ego
with a crowded ring, selective expand, a node's neighbours).

Three uses, one definition:

* ``qsa_graph()`` — the graph itself, pure and deterministic, in GraphResponse
  shape. Tests build it directly (see tests/test_qsa_demo.py); the frontend
  reads the same graph from ``frontend/src/__tests__/fixtures/qsa-demo.json``,
  which a test keeps identical to this function's output.
* ``table_statements()`` — the SQL that puts it in the dev warehouse.
* ``python -m graphlagoon.dev.qsa_demo`` (``make dev-seed-qsa``) — creates the
  tables, the context and one exploration per setting worth seeing.

Shape (defaults): Banco Aurora SA with 380 partners and Boreal Participacoes SA
with 100; every 20th partner also holds one of three holdings (24 of them — the
ones an investigation is usually about); 5 of Aurora's partners are partners of
Boreal too. So Aurora has 356 leaves and Boreal 95.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path
from typing import Any, Optional

import httpx

from graphlagoon.dev.seed import ADMIN_EMAIL, SeedClient, SeedError, wait_for_health

TITLE = "Demo · QSA (hubs with many partners)"
# The dev warehouse refuses DROP (warehouse/src/routers/statements.py validate_sql),
# so tables are created only when missing: bump the version when qsa_graph() changes.
TABLE_VERSION = 3
EDGE_TABLE = f"dev_catalog.graphs.edges_demo_qsa_v{TABLE_VERSION}"
NODE_TABLE = f"dev_catalog.graphs.nodes_demo_qsa_v{TABLE_VERSION}"
FIXTURE = Path(__file__).resolve().parents[3] / "frontend/src/__tests__/fixtures/qsa-demo.json"

# A partner's role cycles every 10: mostly partners and shareholders, like a real register.
ROLES = ["Socio", "Diretor", "Acionista", "Socio", "Conselheiro", "Acionista", "Socio", "Procurador", "Acionista", "Socio"]
MANAGING = {"Diretor", "Conselheiro"}
UFS = ["SP", "RJ", "MG", "PR"]
HOLDINGS = ["h3", "h5", "h1"]


def qsa_graph(aurora_partners: int = 380, boreal_partners: int = 100) -> dict[str, list[dict[str, Any]]]:
    """Nodes and edges of the register, in GraphResponse shape (``node_id``/``node_type``/
    ``properties``, ``edge_id``/``src``/``dst``/``relationship_type``/``properties``)."""
    nodes: list[dict[str, Any]] = [
        {"node_id": "aurora", "node_type": "Company", "properties": {"display_name": "Banco Aurora SA", "uf": "SP"}},
        {"node_id": "boreal", "node_type": "Company", "properties": {"display_name": "Boreal Participacoes SA", "uf": "RJ"}},
        *(
            {"node_id": h, "node_type": "Company", "properties": {"display_name": f"Holding {h[1:]}", "uf": "MG"}}
            for h in sorted(HOLDINGS)
        ),
    ]
    edges: list[dict[str, Any]] = []
    total = aurora_partners + boreal_partners
    for i in range(total):
        role = ROLES[i % 10]
        company = i % 9 == 0
        hub = "aurora" if i < aurora_partners else "boreal"
        size = aurora_partners if hub == "aurora" else boreal_partners
        nodes.append({
            "node_id": f"p{i}",
            "node_type": "Company" if company else "Person",
            "properties": {
                "display_name": f"Participacoes {i} Ltda" if company else f"Socio {i}",
                "uf": UFS[i % 4],
                "qualificacao": role,
            },
        })
        edges.append({
            "edge_id": f"e{i}",
            "src": f"p{i}",
            "dst": hub,
            "relationship_type": "ADMINISTRA" if role in MANAGING else "SOCIO_DE",
            "properties": {"qualificacao": role, "percentual": round(100 / size, 3)},
        })
        # Every 20th partner also holds a holding: the investigative signal.
        if i % 20 == 3:
            edges.append({
                "edge_id": f"x{i}",
                "src": f"p{i}",
                "dst": HOLDINGS[(i // 20) % 3],
                "relationship_type": "SOCIO_DE",
                "properties": {"qualificacao": "Socio", "percentual": 10.0},
            })
    # The last five partners of Aurora are partners of Boreal too.
    for i in range(max(0, aurora_partners - 5), aurora_partners):
        edges.append({
            "edge_id": f"s{i}",
            "src": f"p{i}",
            "dst": "boreal",
            "relationship_type": "SOCIO_DE",
            "properties": {"qualificacao": "Socio", "percentual": 1.0},
        })
    return {"nodes": nodes, "edges": edges}


def _sql(value: Any) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, (int, float)):
        return repr(value)
    return "'" + str(value).replace("'", "''") + "'"


def table_statements(graph: Optional[dict] = None) -> list[str]:
    """Spark SQL that creates the two warehouse tables from ``graph`` when they are missing."""
    graph = graph or qsa_graph()
    node_rows = ", ".join(
        "(" + ", ".join(_sql(v) for v in (
            n["node_id"], n["node_type"], n["properties"].get("display_name"),
            n["properties"].get("uf"), n["properties"].get("qualificacao"),
        )) + ")"
        for n in graph["nodes"]
    )
    edge_rows = ", ".join(
        "(" + ", ".join(_sql(v) for v in (
            e["edge_id"], e["src"], e["dst"], e["relationship_type"],
            e["properties"].get("qualificacao"), float(e["properties"].get("percentual", 0)),
        )) + ")"
        for e in graph["edges"]
    )
    return [
        f"CREATE TABLE IF NOT EXISTS {NODE_TABLE} USING PARQUET AS SELECT * FROM VALUES {node_rows} "
        "AS t(node_id, node_type, display_name, uf, qualificacao)",
        f"CREATE TABLE IF NOT EXISTS {EDGE_TABLE} USING PARQUET AS SELECT * FROM VALUES {edge_rows} "
        "AS t(edge_id, src, dst, relationship_type, qualificacao, percentual)",
    ]


# ── Explorations: one per setting worth seeing ──────────────────────────────


def _look() -> dict:
    from graphlagoon.dev.seed_showcase import look

    return look(
        {"Company": "#f2994a", "Person": "#2f80ed"},
        icons={"Company": "building", "Person": "user"},
        label="{prop:display_name}",
        tooltip="{prop:display_name}{br}{node_type} · {prop:uf}",
    )


def _force(behaviors: Optional[dict] = None) -> dict:
    return {
        **_look(),
        "behaviors": {"viewMode": "2d-proj", **(behaviors or {})},
        "layout_algorithm": "force",
        "layout_mode_config": {"ego": {}, "hive": {}, "hierarchical": {}},
    }


def _ego(focus: str, behaviors: Optional[dict] = None, clusters: Optional[dict] = None, **cfg) -> dict:
    state = {
        **_look(),
        "behaviors": {"viewMode": "2d-proj", **(behaviors or {})},
        "layout_algorithm": "ego",
        "layout_mode_config": {"ego": {"focusNodeId": focus, "maxHops": 2, **cfg}, "hive": {}, "hierarchical": {}},
    }
    if clusters:
        state["clusters"] = clusters
    return state


def explorations(graph: Optional[dict] = None) -> list[tuple[str, dict, str]]:
    """(title, state, which graph): "full" is the whole register, "hubs" only the two companies."""
    graph = graph or qsa_graph()
    linked = {e["src"] for e in graph["edges"] if not e["edge_id"].startswith("e")}
    boreal_leaves = [e["src"] for e in graph["edges"] if e["dst"] == "boreal" and e["edge_id"].startswith("e") and e["src"] not in linked]
    clusters = {"programs": [], "executions": [], "clusters": [{
        "cluster_id": "demo-boreal-partners", "cluster_name": "Partners only of Boreal",
        "cluster_class": "collection", "figure": "box", "state": "closed",
        "node_ids": boreal_leaves, "color": "#2f80ed",
        "description": "Partners of Boreal Participacoes with no other link",
    }]}
    petals = {"hubLeaves": "petals", "hubLeavesKey": "node:qualificacao"}
    by_role = {"ringOrdering": "property", "ringOrderingKey": "qualificacao"}
    return [
        # Automatic adjustments (the defaults: nothing set)
        ("Demo · QSA · A1 Automatic (default): hubs arranged by themselves", _force(), "full"),
        ("Demo · QSA · A2 Automatic adjustments off (master switch)", _force({"autoAdjust": False}), "full"),
        ("Demo · QSA · A3 Ego, automatic sectors on the crowded ring", _ego("aurora"), "full"),
        ("Demo · QSA · A4 Ego, automatic off: fewest crossings", _ego("aurora", {"autoAdjust": False}), "full"),
        # Fixed settings, force layout
        ("Demo · QSA · 1 Free (as before)", _force({"hubLeaves": "free"}), "full"),
        ("Demo · QSA · 2 Crown", _force({"hubLeaves": "crown"}), "full"),
        ("Demo · QSA · 3 Petals by role (qualificacao)", _force(petals), "full"),
        ("Demo · QSA · 4 Petals by node type", _force({"hubLeaves": "petals", "hubLeavesKey": ""}), "full"),
        ("Demo · QSA · 5 Petals by relationship type", _force({"hubLeaves": "petals", "hubLeavesKey": "rel"}), "full"),
        ("Demo · QSA · 6 Petals by UF (node property)", _force({"hubLeaves": "petals", "hubLeavesKey": "node:uf"}), "full"),
        ("Demo · QSA · 7 Petals, hub edges drawn", _force({**petals, "hubLeavesImplicitEdges": False}), "full"),
        ("Demo · QSA · 8 Petals, only hubs with 100+ leaves (Aurora yes, Boreal no)", _force({**petals, "hubLeavesMinLeaves": 100}), "full"),
        ("Demo · QSA · 9 3D", _force({**petals, "viewMode": "3d"}), "full"),
        ("Demo · QSA · 10 Petals, reveal leaves on zoom always (zoom out)", _force({**petals, "hubLeavesRevealByZoom": "on"}), "full"),
        ("Demo · QSA · 11 Just the two companies (right-click → Expand neighbors)", _force(), "hubs"),
        # Fixed settings, ego layout
        ("Demo · QSA · Ego 1 Bands, fewest crossings", _ego("aurora", ringOrdering="barycenter"), "full"),
        ("Demo · QSA · Ego 2 Bands + sectors by role", _ego("aurora", **by_role), "full"),
        ("Demo · QSA · Ego 3 Bands + sectors by node type", _ego("aurora", ringOrdering="node-type"), "full"),
        ("Demo · QSA · Ego 4 No bands (as before, to compare)", _ego("aurora", ringOrdering="barycenter", ringWrap=False), "full"),
        ("Demo · QSA · Ego 5 Spokes drawn", _ego("aurora", {"hubLeavesImplicitEdges": False}, **by_role), "full"),
        ("Demo · QSA · Ego 6 Three hops, Boreal's partners as one cluster", _ego("aurora", clusters=clusters, **{**by_role, "maxHops": 3}), "full"),
        ("Demo · QSA · Ego 7 Focus on Boreal", _ego("boreal", **by_role), "full"),
    ]


# ── Seed runner ─────────────────────────────────────────────────────────────


async def create_tables(warehouse: str, statements: list[str], timeout: float = 180.0) -> None:
    """Run the DDL on the dev warehouse (Databricks-compatible statements API)."""
    async with httpx.AsyncClient(base_url=warehouse.rstrip("/"), timeout=timeout) as http:
        for statement in statements:
            response = await http.post(
                "/api/2.0/sql/statements",
                json={"warehouse_id": "dev", "statement": statement, "wait_timeout": "50s"},
            )
            response.raise_for_status()
            status = response.json().get("status", {})
            if status.get("state") != "SUCCEEDED":
                message = (status.get("error") or {}).get("message", status.get("state"))
                raise SeedError(f"warehouse refused {statement[:60]!r}…: {message}")


async def run_qsa(api: str, warehouse: str, log=print) -> dict[str, Any]:
    from graphlagoon.dev.seed_showcase import new_exploration

    graph = qsa_graph()
    await create_tables(warehouse, table_statements(graph))
    log(f"tables: {len(graph['nodes'])} nodes, {len(graph['edges'])} edges → {EDGE_TABLE}")

    client = SeedClient(api)
    try:
        for ctx in (await client.request("GET", "/api/graph-contexts", ADMIN_EMAIL)).json():
            if ctx["title"] == TITLE:
                await client.request("DELETE", f"/api/graph-contexts/{ctx['id']}", ADMIN_EMAIL)
        ctx = (await client.request("POST", "/api/graph-contexts", ADMIN_EMAIL, json={
            "title": TITLE,
            "description": (
                "Two companies with 380 and 105 partners; 24 partners also hold another company. "
                "Opened as is, the automatic adjustments arrange both hubs; the Demo · QSA "
                "explorations show each setting on its own."
            ),
            "tags": ["demo-showcase", "demo", "qsa"],
            "edge_table_name": EDGE_TABLE,
            "node_table_name": NODE_TABLE,
            "node_types": ["Company", "Person"],
            "relationship_types": ["SOCIO_DE", "ADMINISTRA"],
            "node_properties": [
                {"name": "display_name", "data_type": "string"},
                {"name": "uf", "data_type": "string"},
                {"name": "qualificacao", "data_type": "string"},
            ],
            "edge_properties": [
                {"name": "qualificacao", "data_type": "string"},
                {"name": "percentual", "data_type": "double"},
            ],
            "default_behaviors": {
                "autoLoadOnOpen": True,
                "viewMode": "2d-proj",
                "look": {**_look(), "source": "seed: Demo · QSA"},
            },
        })).json()
        # What the context returns (node properties, no edge properties): what a user gets on open.
        body = (await client.request(
            "POST", f"/api/graph-contexts/{ctx['id']}/subgraph", ADMIN_EMAIL, json={"edge_limit": 1000}
        )).json()
        graphs = {
            "full": {"nodes": body["nodes"], "edges": body["edges"]},
            "hubs": {"nodes": [n for n in body["nodes"] if n["node_id"] in {"aurora", "boreal"}], "edges": []},
        }
        titles = []
        for title, state, which in explorations(graph):
            await new_exploration(client, ctx["id"], title, graphs[which], state)
            titles.append(title)
        return {"context": ctx["id"], "explorations": titles}
    finally:
        await client.close()


def write_fixture(path: Path = FIXTURE) -> None:
    path.write_text(json.dumps(qsa_graph(), ensure_ascii=False, separators=(",", ":")) + "\n")


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--api", default="http://localhost:8000")
    p.add_argument("--warehouse", default="http://localhost:8001", help="dev warehouse (statements API)")
    p.add_argument("--write-fixture", action="store_true", help=f"only rewrite {FIXTURE.name} for the frontend tests")
    return p


def main(argv: Optional[list[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    if args.write_fixture:
        write_fixture()
        print(f"wrote {FIXTURE}")
        return 0

    async def go() -> dict:
        return await run_qsa(await wait_for_health(args.api), args.warehouse)

    try:
        made = asyncio.run(go())
    except (SeedError, httpx.HTTPError) as exc:
        print(f"QSA demo seed failed: {exc}", file=sys.stderr)
        return 1
    print(f"QSA demo: context {made['context']}, {len(made['explorations'])} explorations")
    return 0


if __name__ == "__main__":
    sys.exit(main())
