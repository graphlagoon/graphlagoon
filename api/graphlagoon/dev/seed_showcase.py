"""Dev showcase: a few hand-made contexts, explorations, styles and behaviors
named after the feature each one is there to try.

The bulk seed (``graphlagoon.dev.seed``) makes many random contexts to stress
lists and permissions; nothing in it tells you where to click to see a given
feature. This one makes a small, fixed set — every title starts with
``Demo ·`` and says what it shows:

- a context with a **default look** (colors, icons, labels) and **default
  behaviors**, three **style presets**, and explorations that own a style, show
  only part of the graph, or carry a style/behaviors meant to be imported into
  a context;
- a context with **cluster programs** (one in the right-click menu, one asking
  for a value when run) and **right-click actions** of the *Show only nodes
  with…* kind;
- a context whose edges and nodes are enriched from Databricks tables after every query;
- a context with no default look, to compare with;
- a case whose graphs fall back to the context's default look and offer that
  context's programs in the Clusters panel.

    uv run python -m graphlagoon.dev.seed_showcase --api http://localhost:8000

Idempotent: the contexts carry the ``demo-showcase`` tag, and a rerun that
finds them does nothing (``--reset`` in the bulk seed clears everything).
Refuses to run unless the server reports ``dev_mode``.
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from typing import Any, Optional

from graphlagoon.dev.seed import (
    ADMIN_EMAIL,
    DEFAULT_CATALOG,
    DEFAULT_SCHEMA,
    SeedClient,
    SeedError,
    _snapshot_around,
    wait_for_health,
)

TAG = "demo-showcase"
STOCK_TITLE = "Demo · Stock look (no default, to compare)"
OWNER = ADMIN_EMAIL
GRAPH_TABLE = "demo_showcase"

NODE_TYPES = ["Person", "Company", "Account"]
EDGE_TYPES = ["KNOWS", "WORKS_AT", "OWNS"]
CITIES = ["Lisbon", "Berlin", "São Paulo", "Tokyo"]
BRANCHES = ["B-01", "B-02", "B-03", "B-04", "B-05"]
RISK = ["low", "medium", "high"]

GRAPH = {
    "catalog": DEFAULT_CATALOG,
    "schema_name": DEFAULT_SCHEMA,
    "table_name": GRAPH_TABLE,
    "model": "barabasi_albert",
    "num_nodes": 160,
    "avg_degree": 3.0,
    "ensure_connected": True,
    "node_types": NODE_TYPES,
    "edge_types": EDGE_TYPES,
    "extra_node_columns": [
        {"name": "display_name", "data_type": "string", "generator": "faker_name"},
        {"name": "city", "data_type": "string", "generator": "random_choice", "choices": CITIES},
        {"name": "branch", "data_type": "string", "generator": "random_choice", "choices": BRANCHES},
        {"name": "risk_tier", "data_type": "string", "generator": "random_choice", "choices": RISK},
        {"name": "score", "data_type": "float", "generator": "random_float"},
    ],
}
NODE_PROPERTIES = [
    {"name": c["name"], "data_type": c["data_type"]} for c in GRAPH["extra_node_columns"]
]

# ---------------------------------------------------------------------------
# Looks (style preset blocks)
# ---------------------------------------------------------------------------


def look(
    colors: dict[str, str],
    *,
    icons: Optional[dict[str, str]] = None,
    label: str = "{prop:display_name}",
    tooltip: str = "{prop:display_name}{br}{node_type} · {prop:city} · branch {prop:branch}",
    layout: str = "force",
    node_size: Optional[int] = None,
    edge_colors: Optional[dict[str, str]] = None,
) -> dict[str, Any]:
    return {
        "aesthetics": {"nodeSize": node_size} if node_size else {},
        "nodeTypeColors": colors,
        "edgeTypeColors": edge_colors or {},
        "nodeTypeIcons": icons or {},
        "textFormat": {
            "rules": [],
            "defaults": {
                "nodeTemplate": label,
                "edgeTemplate": "{relationship_type}",
                "nodeTooltipTemplate": tooltip,
                "edgeTooltipTemplate": "",
            },
        },
        "layout_algorithm": layout,
        "layout_mode_config": {"ego": {}, "hive": {}, "hierarchical": {}},
        "force3d_settings": {},
    }


# The context's default: what you see opening it without an exploration, and
# what a case graph with no look of its own wears.
DEFAULT_LOOK = look(
    {"Person": "#2f80ed", "Company": "#f2994a", "Account": "#27ae60"},
    icons={"Person": "user", "Company": "building", "Account": "landmark"},
)
DEFAULT_BEHAVIORS = {"viewMode": "2d", "searchMode": "hide", "showSelfEdges": False, "autoLoadOnOpen": True}

# Preset names are file names (letters, digits, _ - .), so the "Demo ·" title
# lives in the description.
PRESETS = {
    "demo.risk-palette": (
        "Demo · Risk palette (red-amber-green) — apply it, then ★ to make it the context default.",
        look({"Person": "#e5484d", "Company": "#f5a524", "Account": "#30a46c"},
             icons={"Person": "user-x", "Company": "factory", "Account": "landmark"}),
    ),
    "demo.presentation": (
        "Demo · Presentation — large nodes, labels with the name only.",
        look({"Person": "#3e63dd", "Company": "#8e4ec6", "Account": "#12a594"},
             label="{prop:display_name}", tooltip="{prop:display_name}", node_size=12),
    ),
    "demo.hive-by-type": (
        "Demo · Hive by type — one axis per type; changes the layout too.",
        look({"Person": "#0091ff", "Company": "#ffb224", "Account": "#46a758"}, layout="hive"),
    ),
}

# An exploration whose style and behaviors differ from the context default on
# purpose: import it from the context form ("Default Look → Import from…" and
# "Import behaviors") and the change is easy to see.
IMPORTABLE_LOOK = look(
    {"Person": "#6e56cf", "Company": "#e93d82", "Account": "#ffc53d"},
    icons={"Person": "user-check", "Company": "store", "Account": "wallet"},
    label="{prop:display_name} ({prop:risk_tier})",
    edge_colors={"OWNS": "#e93d82", "WORKS_AT": "#6e56cf", "KNOWS": "#b4b4b4"},
)
IMPORTABLE_BEHAVIORS = {"viewMode": "3d", "edgeLensMode": "dim", "focusDepth": 2, "searchMode": "highlight"}

# ---------------------------------------------------------------------------
# Cluster programs and right-click actions
# ---------------------------------------------------------------------------

_GROUP_BY_PROP = """// Group the nodes by the value of one property.
const prop = params.property || 'risk_tier';
const groups = new Map();
nodes.forEach(node => {
  const v = node.properties?.[prop];
  if (v === undefined || v === null || v === '') return;
  const key = String(v);
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(node.node_id);
});
const colors = ['#e5484d', '#f5a524', '#30a46c', '#0091ff', '#8e4ec6', '#12a594'];
const min = Number(params.min_size ?? 1);
return [...groups.entries()]
  .filter(([, ids]) => ids.length >= min)
  .map(([value, ids], i) => ({
    cluster_name: `${prop} = ${value}`,
    cluster_class: prop,
    figure: 'circle',
    state: 'closed',
    node_ids: ids,
    color: colors[i % colors.length],
    description: `${ids.length} nodes with ${prop} = ${value}`,
  }));"""

_SAME_BRANCH = """// The nodes of the clicked node's branch, and everyone else.
const branch = params.branch;
const same = nodes.filter(n => n.properties?.branch === branch).map(n => n.node_id);
return [{
  cluster_name: `Branch ${branch}`,
  cluster_class: 'branch',
  figure: 'hexagon',
  state: 'closed',
  node_ids: same,
  color: '#0091ff',
  description: `${same.length} nodes of branch ${branch}`,
}];"""

NOW = "2026-11-10T00:00:00Z"
CLUSTER_PROGRAMS = [
    {
        "program_id": "demo-group-by-risk",
        "program_name": "Demo · Group by risk tier",
        "description": "Three groups: low / medium / high. Run it from Clusters → Group by.",
        "code": _GROUP_BY_PROP,
        "parameters": [
            {"id": "property", "type": "select", "label": "Property", "default": "risk_tier",
             "options": ["risk_tier", "city", "branch"], "required": True},
        ],
        "show_in_context_menu": False,
        "scope": "context",
        "created_at": NOW,
        "updated_at": NOW,
    },
    {
        "program_id": "demo-same-branch",
        "program_name": "Demo · Same branch as this node (right-click)",
        "description": "In the right-click menu: the branch comes from the clicked node.",
        "code": _SAME_BRANCH,
        "parameters": [
            {"id": "branch", "type": "text", "label": "Branch", "required": True, "node_binding": "prop:branch"},
        ],
        "show_in_context_menu": True,
        "scope": "context",
        "created_at": NOW,
        "updated_at": NOW,
    },
    {
        "program_id": "demo-asks-for-a-value",
        "program_name": "Demo · Groups of at least N (asks when run from the menu)",
        "description": "A required parameter with no default and no node binding: the right-click run opens the run dialog.",
        "code": _GROUP_BY_PROP,
        "parameters": [
            {"id": "property", "type": "select", "label": "Property", "default": "city",
             "options": ["city", "branch", "risk_tier"], "required": True},
            {"id": "min_size", "type": "number", "label": "Minimum group size", "required": True},
        ],
        "show_in_context_menu": True,
        "scope": "context",
        "created_at": NOW,
        "updated_at": NOW,
    },
]

MENU_ACTIONS = [
    {"id": "demo-same-branch", "kind": "show-same-value", "label": "Demo · Show only this branch",
     "icon": "🏦", "enabled": True, "match": {"target": "node"}, "field": "branch", "mode": "same"},
    {"id": "demo-same-city", "kind": "show-same-value", "label": "Demo · Show only this city",
     "icon": "📍", "enabled": True, "match": {"target": "node"}, "field": "city", "mode": "same"},
    {"id": "demo-same-type", "kind": "show-same-value", "label": "Demo · Show only this type",
     "enabled": True, "match": {"target": "node"}, "field": "node_type", "mode": "same"},
    {"id": "demo-has-risk", "kind": "show-same-value", "label": "Demo · Show only nodes with a risk tier",
     "enabled": True, "match": {"target": "node"}, "field": "risk_tier", "mode": "has"},
]

# ---------------------------------------------------------------------------


async def ensure_graph(client: SeedClient, log) -> tuple[str, str]:
    datasets = (await client.request("GET", "/api/datasets", ADMIN_EMAIL)).json()
    live = {name.split(".", 1)[-1] if name.count(".") == 2 else name
            for key in ("tables", "edge_tables", "node_tables") for name in (datasets.get(key) or [])}
    edge, node = f"{DEFAULT_SCHEMA}.edges_{GRAPH_TABLE}", f"{DEFAULT_SCHEMA}.nodes_{GRAPH_TABLE}"
    if {edge, node} <= live:
        return f"{DEFAULT_CATALOG}.{edge}", f"{DEFAULT_CATALOG}.{node}"
    result = (await client.request("POST", "/api/dev/random-graph", ADMIN_EMAIL, json=GRAPH)).json()
    log(f"graph: {result['num_nodes']} nodes, {result['num_edges']} edges → {result['edge_table']}")
    return result["edge_table"], result["node_table"]


async def new_context(client: SeedClient, edge: str, node: str, title: str, description: str,
                      **extra) -> dict:
    return (await client.request("POST", "/api/graph-contexts", OWNER, json={
        "title": title,
        "description": description,
        "tags": [TAG, "demo"],
        "edge_table_name": edge,
        "node_table_name": node,
        "node_types": NODE_TYPES,
        "relationship_types": EDGE_TYPES,
        "node_properties": NODE_PROPERTIES,
        **extra,
    })).json()


async def subgraph(client: SeedClient, ctx_id: str) -> dict[str, list[dict]]:
    body = (await client.request("POST", f"/api/graph-contexts/{ctx_id}/subgraph", OWNER,
                                 json={"edge_limit": 400})).json()
    return {"nodes": body.get("nodes", []), "edges": body.get("edges", [])}


async def new_exploration(client: SeedClient, ctx_id: str, title: str, graph: dict, state: dict,
                          description: str = "") -> dict:
    nodes = graph["nodes"]
    full = {
        "nodes": [{"node_id": n["node_id"]} for n in nodes],
        "edges": [],
        "filters": {"node_types": [], "edge_types": []},
        **state,
    }
    return (await client.request("POST", f"/api/graph-contexts/{ctx_id}/explorations", OWNER, json={
        "title": title,
        "state": full,
        "snapshot": _snapshot_around(graph, nodes),
    })).json()


def communities_by(graph: dict, prop: str) -> tuple[dict, dict[str, int]]:
    """A saved community state that groups the nodes by one property (what a
    cluster program run as a community algorithm would leave), and the ids."""
    values = sorted({str((n.get("properties") or {}).get(prop)) for n in graph["nodes"]})
    index = {v: i for i, v in enumerate(values)}
    mapping = {n["node_id"]: index[str((n.get("properties") or {}).get(prop))] for n in graph["nodes"]}
    state = {
        "communityMap": mapping,
        "communityCount": len(values),
        "modularity": None,
        "algorithm": "cluster-program:demo-group-by-risk",
        "colorEnabled": True,
        "radialLayoutEnabled": False,
        "collapseEnabled": False,
        "tableColumnEnabled": True,
        "resolution": 1.0,
        "edgeTypeFilter": [],
        "programParams": {"demo-group-by-risk": {"property": prop}},
        "communityLabels": {str(i): f"{prop} = {v}" for v, i in index.items()},
    }
    return state, index


async def run_showcase(api: str, log=print) -> dict[str, Any]:
    client = SeedClient(api, concurrency=4)
    made: dict[str, Any] = {"contexts": [], "explorations": [], "presets": 0, "case": None}
    try:
        config = (await client.request("GET", "/api/config", ADMIN_EMAIL)).json()
        if not config.get("dev_mode"):
            raise SeedError("Server is not in dev mode; refusing to seed.")
        existing = (await client.request("GET", "/api/graph-contexts", ADMIN_EMAIL)).json()
        ours = [c for c in existing if TAG in (c.get("tags") or [])]
        if any(c["title"] == STOCK_TITLE for c in ours):  # the last one made: the run finished
            log("showcase: already seeded (contexts tagged demo-showcase)")
            made["skipped"] = True
            return made
        for c in ours:  # a run that stopped halfway: start over
            await client.request("DELETE", f"/api/graph-contexts/{c['id']}", OWNER)

        edge, node = await ensure_graph(client, log)

        # 1. Default look & behaviors --------------------------------------------
        look_ctx = await new_context(
            client, edge, node, "Demo · Default look & behaviors",
            "Open it with no exploration: blue/orange/green with icons and names is the context's DEFAULT LOOK, "
            "2D and search-hides are its DEFAULT BEHAVIORS. Edit the context to see the Default Look section; "
            "Look → Presets has three presets (★ makes one the default).",
            default_behaviors={**DEFAULT_BEHAVIORS, "look": {**DEFAULT_LOOK, "source": "seed: Demo · Default look"}},
        )
        made["contexts"].append(look_ctx["title"])
        for name, (description, settings) in PRESETS.items():
            await client.request("PUT", f"/api/graph-contexts/{look_ctx['id']}/style-presets/{name}", OWNER,
                                 json={"settings": settings, "description": description})
            made["presets"] += 1
        graph = await subgraph(client, look_ctx["id"])
        by_city, city_ids = communities_by(graph, "city")
        explorations = [
            ("Demo · Own style: risk palette (wins over the context default)",
             {**PRESETS["demo.risk-palette"][1], "behaviors": {"viewMode": "2d"}},
             "An exploration's own style always wins over the context default."),
            ("Demo · Show only Lisbon (saved 'show only' by value)",
             {**DEFAULT_LOOK, "isolation": {"kind": "value", "field": "city", "value": "Lisbon", "mode": "same",
                                             "label": "city = Lisbon"}},
             "Opens with only the Lisbon nodes; the status bar says 'Showing only: city = Lisbon' — ✕ shows all."),
            ("Demo · Groups by city, Berlin shown alone (Clusters panel)",
             {**DEFAULT_LOOK, "community": by_city,
              "isolation": {"kind": "community", "ids": [city_ids["Berlin"]], "label": "city = Berlin"}},
             "Clusters → Groups lists one group per city; click another, Shift+click to add, the eye to hide."),
            ("Demo · Import me into the context (purple style + 3D behaviors)",
             {**IMPORTABLE_LOOK, "behaviors": IMPORTABLE_BEHAVIORS},
             "Edit the context → Default Look → Import from… → this exploration; then Import behaviors."),
            ("Demo · No style of its own (a case shows the context default)",
             {},
             "Saved without a style: on the case canvas it wears the context's default look."),
        ]
        plain_id = None
        for title, state, description in explorations:
            created = await new_exploration(client, look_ctx["id"], title, graph, state, description)
            made["explorations"].append(title)
            if title.startswith("Demo · No style"):
                plain_id = created["id"]

        # 2. Cluster programs & right-click actions --------------------------------
        programs_ctx = await new_context(
            client, edge, node, "Demo · Cluster programs & right-click actions",
            "Clusters → Group by lists the 'Demo ·' programs; Programs… holds the library (Import/Export JSON). "
            "Right-click a node: 'Demo · Show only this branch/city/type', 'Show only nodes with a risk tier', "
            "'Demo · Same branch as this node' (program, value from the node) and 'Demo · Groups of at least N' "
            "(asks for the missing value).",
            cluster_programs=CLUSTER_PROGRAMS,
            context_menu_actions=MENU_ACTIONS,
        )
        made["contexts"].append(programs_ctx["title"])
        programs_graph = await subgraph(client, programs_ctx["id"])
        playground = await new_exploration(
            client, programs_ctx["id"], "Demo · Programs playground (run, collapse, show only)", programs_graph,
            {**DEFAULT_LOOK},
            "Clusters → Group by 'Demo · Group by risk tier' → Output Color or Collapse → Run.",
        )
        made["explorations"].append(playground["title"])

        # 3. Edge enrichment from Databricks tables --------------------------------
        enrich_ctx = await new_context(
            client, edge, node, "Demo · Edge enrichment from Databricks tables",
            "After every query two queries (Edit → Enrichment Tables) run on Databricks: 'Demo · Cities on both "
            "ends' adds src_city, dst_city and same_city to each edge, 'Demo · Outgoing edges per node' adds "
            "edges_out_in_table to each node. Click one to see them marked 'from …'. "
            "Your data → From Databricks tables runs it by hand.",
            enrichment_tables=[{
                "name": "node_cities",
                "label": "Demo · Cities on both ends",
                "table": node,
                "query": {
                    "sql": (
                        "SELECT e.edge_id, s.city AS src_city, d.city AS dst_city, "
                        "s.city = d.city AS same_city\n"
                        f"FROM graph_edges e\nJOIN {node} s ON s.node_id = e.src\n"
                        f"JOIN {node} d ON d.node_id = e.dst"
                    ),
                    "run": "auto",
                },
            }, {
                "name": "node_out_degree",
                "label": "Demo · Outgoing edges per node",
                "table": edge,
                "query": {
                    "sql": (
                        "SELECT n.node_id, count(x.src) AS edges_out_in_table\n"
                        f"FROM graph_nodes n\nLEFT JOIN {edge} x ON x.src = n.node_id\n"
                        "GROUP BY n.node_id"
                    ),
                    "target": "nodes",
                    "run": "auto",
                },
            }],
        )
        made["contexts"].append(enrich_ctx["title"])

        # 4. Stock look, to compare ---------------------------------------------------
        stock_ctx = await new_context(
            client, edge, node, STOCK_TITLE,
            "The same graph with no default look or behaviors: what any context looks like before you set one.",
        )
        made["contexts"].append(stock_ctx["title"])

        # 5. A case on those graphs ---------------------------------------------------
        try:
            case = (await client.request("POST", "/api/investigations", OWNER, json={
                "title": "Demo · Case canvas: context default look & Clusters",
                "case_type": "general",
                "description": "Pick 'Demo · No style of its own': it wears the context default look. "
                               "Pick the programs playground: the Clusters button lists that context's programs; "
                               "right-click shows its 'Show only' actions. A saved view keeps a 'show only'.",
            })).json()
            url = f"/api/investigations/{case['id']}"
            for exp_id in (plain_id, playground["id"]):
                if exp_id:
                    await client.request("POST", f"{url}/items", OWNER, json={
                        "kind": "graph", "subkind": "exploration_ref", "exploration_id": exp_id,
                    })
            made["case"] = case["title"]
        except SeedError as exc:  # investigations disabled on this server
            log(f"showcase case skipped: {exc}")
        return made
    finally:
        await client.close()


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--api", default="http://localhost:8000")
    return p


def main(argv: Optional[list[str]] = None) -> int:
    args = build_parser().parse_args(argv)

    async def go() -> dict:
        base = await wait_for_health(args.api)
        return await run_showcase(base)

    try:
        made = asyncio.run(go())
    except SeedError as exc:
        print(f"showcase seed failed: {exc}", file=sys.stderr)
        return 1
    if not made.get("skipped"):
        print(f"showcase: {len(made['contexts'])} contexts, {len(made['explorations'])} explorations, "
              f"{made['presets']} presets, case: {made['case'] or '—'}")
        for title in made["contexts"]:
            print(f"  · {title}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
