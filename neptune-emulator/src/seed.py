"""Seed the local Neo4j with a sample graph. Dev only.

Gives `make dev-neptune` something to draw immediately, shaped so that the
interesting query paths are actually distinguishable when you click around —
above all **expand from a node**, whose behaviour depends on depth, direction
and relationship type. A blob of uniformly-connected nodes would render fine
and prove nothing; every structure below exists to make one control observable:

* **A reporting ladder** (`REPORTS_TO`, 9 levels) — expanding *outgoing* from
  the bottom reaches exactly `depth` people, so depth 1 and depth 2 (the API
  cap) are visibly different, and repeated expands walk the chain one rung at
  a time all the way to the CTO.
* **A hub** — Graph Lagoon has ~24 employees, so one expand exceeds a typical
  limit and you can see the cap take effect.
* **A `KNOWS` ring with chords** — everyone is reachable from everyone, with
  cycles, so undirected expand grows fast and revisits nodes.
* **A layered `DEPENDS_ON` DAG** over repositories — multi-hop paths of a
  *different* type, so filtering by relationship type gives a clean subgraph
  through the same nodes.
* **Sinks and sources** — deepest repositories have no outgoing edge; expanding
  out from one returns nothing while expanding in returns plenty.
* **A disconnected component** (Sandbox Co) — never reachable from the main
  graph, which is what proves expand respects its boundary.

Generation is seeded, so the graph is byte-identical on every run.

    python -m src.seed
"""

from __future__ import annotations

import os
import random

from neo4j import GraphDatabase

NEO4J_URI = os.environ.get("NEO4J_URI", "bolt://localhost:7687")
NEO4J_USER = os.environ.get("NEO4J_USER", "neo4j")
NEO4J_PASSWORD = os.environ.get("NEO4J_PASSWORD", "graphlagoon")

RNG_SEED = 20260813

# The first five keep their original names: docs, screenshots and manual
# smoke-testing all refer to Alice, and they sit at the bottom of the ladder.
NAMED = ["Alice", "Bob", "Carol", "Dave", "Erin"]
FIRST = [
    "Frank",
    "Grace",
    "Hugo",
    "Iris",
    "Jonas",
    "Keiko",
    "Luis",
    "Maya",
    "Nuno",
    "Olga",
    "Pedro",
    "Rita",
]
LAST = [
    "Almeida",
    "Barros",
    "Costa",
    "Duarte",
    "Esteves",
    "Faria",
    "Gomes",
    "Henriques",
]
CITIES = ["Lisbon", "Porto", "Madrid", "Berlin", "Amsterdam", "São Paulo"]
TITLES = [
    "engineer",
    "senior engineer",
    "tech lead",
    "engineering manager",
    "director",
    "senior director",
    "VP",
    "SVP",
    "CTO",
]

COMPANIES = [
    ("Graph Lagoon", 2024, "software"),
    ("Deep Analytics", 2019, "software"),
    ("Northwind Data", 2011, "consulting"),
    ("Meridian Labs", 2016, "research"),
    ("Cobalt Systems", 2008, "hardware"),
    ("Harbor AI", 2021, "software"),
    ("Vector Foundry", 2017, "software"),
]
SANDBOX = ("Sandbox Co", 2025, "software")

PROJECT_NAMES = [
    "Visualization",
    "Ingestion",
    "Lineage",
    "Catalog",
    "Scheduler",
    "Query Planner",
    "Streaming",
    "Observability",
    "Access Control",
    "Cost Model",
    "Notebook Sync",
    "Model Registry",
    "Alerting",
    "Sandbox Pilot",
]

MAIN_PEOPLE = 60
LADDER = 9  # people in the REPORTS_TO chain
REPO_LAYERS = [6, 6, 5, 3]  # layer 3 has no outgoing DEPENDS_ON — sinks


def build_nodes(rng: random.Random) -> dict[str, list[dict]]:
    """Every node carries a stable `key`, used only to wire edges up below."""
    people = []
    for i in range(MAIN_PEOPLE):
        name = (
            NAMED[i]
            if i < len(NAMED)
            else f"{FIRST[i % len(FIRST)]} {LAST[(i // len(FIRST)) % len(LAST)]}"
        )
        people.append(
            {
                "key": f"p{i}",
                "name": name,
                "age": 22 + (i * 7) % 38,
                "city": CITIES[i % len(CITIES)],
                "active": i % 9 != 0,
                "score": round(rng.uniform(0, 1), 3),
            }
        )
    # The disconnected component: reachable from nothing in the main graph.
    for i in range(4):
        people.append(
            {
                "key": f"s{i}",
                "name": f"Sandbox {LAST[i]}",
                "age": 25 + i * 3,
                "city": "Remote",
                "active": True,
                "score": 0.5,
            }
        )

    companies = [
        {"key": f"c{i}", "name": name, "founded": founded, "sector": sector}
        for i, (name, founded, sector) in enumerate(COMPANIES)
    ]
    companies.append(
        {"key": "cs", "name": SANDBOX[0], "founded": SANDBOX[1], "sector": SANDBOX[2]}
    )

    projects = [
        {
            "key": f"j{i}",
            "name": name,
            "status": ["active", "paused", "archived"][i % 3],
            "budget": 50_000 + i * 12_500,
        }
        for i, name in enumerate(PROJECT_NAMES)
    ]

    repos = []
    for layer, count in enumerate(REPO_LAYERS):
        for i in range(count):
            idx = len(repos)
            repos.append(
                {
                    "key": f"r{idx}",
                    "name": f"lagoon-{['core', 'lib', 'tool', 'edge'][layer]}-{i}",
                    "layer": layer,
                    "language": ["python", "typescript", "rust"][idx % 3],
                    "stars": 12 + idx * 37,
                }
            )

    return {
        "Person": people,
        "Company": companies,
        "Project": projects,
        "Repository": repos,
    }


def build_edges(
    rng: random.Random, nodes: dict[str, list[dict]]
) -> dict[str, list[dict]]:
    main = [p["key"] for p in nodes["Person"] if p["key"].startswith("p")]
    sandbox = [p["key"] for p in nodes["Person"] if p["key"].startswith("s")]
    companies = [c["key"] for c in nodes["Company"] if c["key"] != "cs"]
    projects = [j["key"] for j in nodes["Project"]]
    repos = nodes["Repository"]

    knows, reports, works, contributes, owns, depends, mentors = (
        [],
        [],
        [],
        [],
        [],
        [],
        [],
    )

    # Ring + chords: connected, cyclic, and dense enough that undirected expand
    # at depth 2 pulls a visibly larger neighbourhood than depth 1.
    for i, src in enumerate(main):
        knows.append(
            {
                "src": src,
                "dst": main[(i + 1) % len(main)],
                "props": {
                    "since": 2010 + i % 15,
                    "strength": round(rng.uniform(0.1, 1.0), 2),
                },
            }
        )
    for _ in range(30):
        a, b = rng.sample(main, 2)
        knows.append(
            {
                "src": a,
                "dst": b,
                "props": {
                    "since": rng.randint(2010, 2025),
                    "strength": round(rng.uniform(0.1, 1.0), 2),
                },
            }
        )

    # The ladder — Alice reports to Bob reports to Carol ... up to the CTO.
    # A pure chain, so out-expand at depth k reaches exactly k people.
    for i in range(LADDER - 1):
        reports.append(
            {"src": main[i], "dst": main[i + 1], "props": {"since": 2020 + i % 5}}
        )

    # Graph Lagoon takes the first 24 — a hub big enough to hit any sane limit.
    for i, person in enumerate(main):
        company = companies[0] if i < 24 else companies[1 + (i % (len(companies) - 1))]
        works.append(
            {
                "src": person,
                "dst": company,
                "props": {
                    "role": TITLES[min(i, LADDER - 1)]
                    if i < LADDER
                    else rng.choice(TITLES[:4]),
                    "since": 2015 + i % 10,
                },
            }
        )

    for i, person in enumerate(main):
        for project in rng.sample(projects[:-1], rng.randint(1, 3)):
            contributes.append(
                {
                    "src": person,
                    "dst": project,
                    "props": {"commits": 10 + (i * 53) % 900},
                }
            )

    for i, project in enumerate(projects[:-1]):
        owns.append({"src": companies[i % len(companies)], "dst": project, "props": {}})

    # Layered DAG: projects → layer 0 → layer 1 → layer 2 → layer 3 (sinks).
    by_layer: dict[int, list[str]] = {}
    for repo in repos:
        by_layer.setdefault(repo["layer"], []).append(repo["key"])
    for i, project in enumerate(projects[:-1]):
        depends.append(
            {
                "src": project,
                "dst": by_layer[0][i % len(by_layer[0])],
                "props": {"pinned": True},
            }
        )
    for layer in range(len(REPO_LAYERS) - 1):
        for src in by_layer[layer]:
            for dst in rng.sample(
                by_layer[layer + 1], min(2, len(by_layer[layer + 1]))
            ):
                depends.append(
                    {"src": src, "dst": dst, "props": {"pinned": rng.random() > 0.5}}
                )

    # Deliberately rare: a type filter on MENTORS should return almost nothing.
    for i in range(6):
        mentors.append(
            {"src": main[i * 5], "dst": main[i * 5 + 3], "props": {"hours": 4 + i}}
        )

    # The island: internally connected, no edge in or out of the main graph.
    for i, person in enumerate(sandbox):
        works.append(
            {"src": person, "dst": "cs", "props": {"role": "founder", "since": 2025}}
        )
        knows.append(
            {
                "src": person,
                "dst": sandbox[(i + 1) % len(sandbox)],
                "props": {"since": 2025, "strength": 0.8},
            }
        )
        contributes.append(
            {"src": person, "dst": projects[-1], "props": {"commits": 5 + i}}
        )
    owns.append({"src": "cs", "dst": projects[-1], "props": {}})

    return {
        "KNOWS": knows,
        "REPORTS_TO": reports,
        "WORKS_AT": works,
        "CONTRIBUTES_TO": contributes,
        "OWNS": owns,
        "DEPENDS_ON": depends,
        "MENTORS": mentors,
    }


def main() -> None:
    rng = random.Random(RNG_SEED)
    nodes = build_nodes(rng)
    edges = build_edges(rng, nodes)

    driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))
    with driver.session() as session:
        session.run("MATCH (n) DETACH DELETE n")

        # Labels and relationship types cannot be parameterized, so one
        # statement per label/type — the rows themselves go in as parameters.
        for label, rows in nodes.items():
            session.run(
                f"UNWIND $rows AS row CREATE (n:{label}) SET n = row",
                rows=rows,
            )
        for rel_type, rows in edges.items():
            session.run(
                f"""
                UNWIND $rows AS row
                MATCH (a {{key: row.src}}), (b {{key: row.dst}})
                CREATE (a)-[r:{rel_type}]->(b)
                SET r += row.props
                """,
                rows=rows,
            )

        node_count = session.run("MATCH (n) RETURN count(n) AS c").single()["c"]
        edge_count = session.run("MATCH ()-[r]->() RETURN count(r) AS c").single()["c"]
    driver.close()

    print(f"Seeded {node_count} nodes and {edge_count} relationships into {NEO4J_URI}")
    print(
        "  labels:        "
        + ", ".join(f"{label} ({len(rows)})" for label, rows in nodes.items())
    )
    print(
        "  relationships: "
        + ", ".join(f"{rel} ({len(rows)})" for rel, rows in edges.items())
    )
    print(
        "  try: expand from Alice filtered to REPORTS_TO — depth 1 vs 2, then repeat up the chain"
    )


if __name__ == "__main__":
    main()
