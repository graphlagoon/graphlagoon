"""Dev environment seed: many users, contexts, explorations, shares, audit.

Talks to a *running* Graph Lagoon API over HTTP with a different
``X-Forwarded-Email`` per generated user, so it exercises the same auth,
sharing, ownership and audit paths a real user would — and works identically
against the in-memory store (``make dev``) and PostgreSQL (``make dev-db``).

    uv run python -m graphlagoon.dev.seed --api http://localhost:8000 \\
        --users 30 --contexts 60 --explorations 200 --graphs 5 --seed 42

Deterministic for a given ``--seed`` (same e-mails, titles and sharing
decisions every run), idempotent (a ``seed:<hash>`` tag marks what a given
parameter set already created; rerunning is a no-op), and refuses to run
unless the server reports ``dev_mode``. A rerun also rebuilds any seeded
warehouse table that went missing while its context survived — PostgreSQL and
the Spark warehouse are wiped independently, so they drift apart.

``--reset`` clears the environment
first through the admin API, which needs the caller to be a superuser
(``GRAPH_LAGOON_SUPERUSER_EMAILS`` — the shipped ``.env.example`` lists
``dev@graphlagoon.local``).
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import random
import re
import sys
import time
from dataclasses import dataclass, field
from typing import Any, Optional

import httpx

ADMIN_EMAIL = "dev@graphlagoon.local"
SEED_DOMAIN = "example.com"
DEFAULT_CATALOG = "dev_catalog"
DEFAULT_SCHEMA = "graphs"
# A seeded edge table, e.g. ``dev_catalog.graphs.edges_seed_6``. The index is
# the only thing that identifies the graph — see :func:`graph_payload`.
SEED_TABLE_RE = re.compile(
    r"^(?:(?P<catalog>[^.]+)\.)?(?P<schema>[^.]+)\.edges_seed_(?P<index>\d+)$"
)

FIRST_NAMES = [
    "alice",
    "bob",
    "carol",
    "dave",
    "erin",
    "frank",
    "grace",
    "heidi",
    "ivan",
    "judy",
    "kim",
    "leo",
    "mallory",
    "nina",
    "oscar",
    "peggy",
    "quinn",
    "rupert",
    "sybil",
    "trent",
    "uma",
    "victor",
    "wendy",
    "xavier",
    "yara",
    "zoe",
    "ana",
    "bruno",
    "clara",
    "diego",
    "elisa",
    "fabio",
    "gabi",
    "hugo",
    "iris",
    "joao",
    "karla",
    "lucas",
    "marina",
    "nico",
]
LAST_NAMES = [
    "silva",
    "santos",
    "oliveira",
    "souza",
    "lima",
    "pereira",
    "costa",
    "ramos",
    "smith",
    "johnson",
    "brown",
    "garcia",
    "miller",
    "davis",
    "wilson",
    "moore",
    "taylor",
    "anderson",
    "thomas",
    "jackson",
    "martin",
    "lee",
    "perez",
    "white",
]
TAG_VOCAB = [
    "fraud",
    "supply",
    "social",
    "qsa",
    "demo",
    "risk",
    "kyc",
    "ops",
    "poc",
    "q3",
]
TITLE_NOUNS = [
    "Supplier network",
    "Shareholder graph",
    "Customer 360",
    "Fraud ring",
    "Payment flows",
    "Org chart",
    "Vendor risk",
    "Partner map",
    "Referral graph",
    "Ownership chain",
    "Transactions",
    "Device links",
    "Account clusters",
    "Knowledge graph",
    "Support tickets",
    "Product affinity",
]
TITLE_SUFFIX = ["", " (draft)", " v2", " — QA", " / prod", " 2026", " — review"]
EXPLORATION_VERBS = [
    "Hub",
    "Ego of",
    "Community around",
    "Shortest paths from",
    "Neighbourhood of",
    "Outliers near",
    "Deep dive:",
    "Snapshot:",
    "Weekly review:",
    "Suspicious:",
]
LAYOUTS = ["force-atlas-2", "ego", "hierarchical", "hive", "circular"]
VIEW_MODES = ["2d", "3d"]

GRAPH_MODELS = ["barabasi_albert", "watts_strogatz", "erdos_renyi", "random_tree"]
NODE_TYPE_SETS = [
    (["Person", "Company"], ["OWNS", "WORKS_AT", "KNOWS"]),
    (["Account", "Device", "Merchant"], ["PAID", "USED", "LINKED"]),
    (["Supplier", "Product", "Warehouse"], ["SUPPLIES", "STORES", "SHIPS_TO"]),
    (["User", "Post", "Topic"], ["LIKES", "FOLLOWS", "ABOUT"]),
    (["Entity"], ["RELATED"]),
]
EXTRA_NODE_COLUMNS = [
    {
        "name": "city",
        "data_type": "string",
        "generator": "random_choice",
        "choices": ["São Paulo", "Lisbon", "Berlin", "Austin", "Tokyo", "Nairobi"],
    },
    {"name": "score", "data_type": "float", "generator": "random_float"},
    {"name": "created_at", "data_type": "date", "generator": "random_date"},
    {"name": "display_name", "data_type": "string", "generator": "faker_name"},
]


@dataclass
class SeedUser:
    email: str
    profile: str  # "power" | "normal" | "inactive"


@dataclass
class SeedContext:
    id: str
    title: str
    owner: str
    graph_index: int
    node_types: list[str]
    shared_with: list[str] = field(default_factory=list)


@dataclass
class SeedStats:
    users: int = 0
    graphs: int = 0
    contexts: int = 0
    explorations: int = 0
    templates: int = 0
    shares: int = 0
    deletes: int = 0
    transfers: int = 0
    repaired: int = 0
    skipped: bool = False


class SeedError(RuntimeError):
    pass


def seed_tag(
    users: int, contexts: int, explorations: int, graphs: int, seed: int
) -> str:
    digest = hashlib.sha1(
        f"{users}:{contexts}:{explorations}:{graphs}:{seed}".encode()
    ).hexdigest()[:8]
    return f"seed:{digest}"


def make_users(n: int, rng: random.Random) -> list[SeedUser]:
    """Deterministic roster: ~20 % power users, ~60 % normal, ~20 % inactive."""
    seen: set[str] = set()
    users: list[SeedUser] = []
    attempts = 0
    while len(users) < n and attempts < n * 20:
        attempts += 1
        first = rng.choice(FIRST_NAMES)
        last = rng.choice(LAST_NAMES)
        email = f"{first}.{last}@{SEED_DOMAIN}"
        if email in seen:
            email = f"{first}.{last}{len(users)}@{SEED_DOMAIN}"
        if email in seen:
            continue
        seen.add(email)
        roll = rng.random()
        profile = "power" if roll < 0.2 else ("inactive" if roll > 0.8 else "normal")
        users.append(SeedUser(email=email, profile=profile))
    if users and not any(u.profile == "inactive" for u in users):
        users[-1].profile = "inactive"
    if users and not any(u.profile == "power" for u in users):
        users[0].profile = "power"
    return users


def pick_owner(users: list[SeedUser], rng: random.Random) -> SeedUser:
    """Weighted by profile: power users own most resources, inactive none."""
    weights = {"power": 6.0, "normal": 1.0, "inactive": 0.0}
    candidates = [u for u in users if weights[u.profile] > 0]
    return rng.choices(candidates, weights=[weights[u.profile] for u in candidates])[0]


def graph_payload(
    index: int, catalog: str = DEFAULT_CATALOG, schema: str = DEFAULT_SCHEMA
) -> dict[str, Any]:
    """The ``/api/dev/random-graph`` body for graph ``seed_<index>``.

    Everything here derives from ``index`` alone, so ``edges_seed_6`` always
    means the same graph no matter which seed run created it. That is what lets
    :func:`repair_missing_graphs` rebuild a table from its name.
    """
    node_types, edge_types = NODE_TYPE_SETS[index % len(NODE_TYPE_SETS)]
    return {
        "catalog": catalog,
        "schema_name": schema,
        "table_name": f"seed_{index}",
        "model": GRAPH_MODELS[index % len(GRAPH_MODELS)],
        "num_nodes": [50, 300, 1000, 2500, 5000][index % 5],
        "avg_degree": 4.0 + (index % 3),
        "ensure_connected": True,
        "bidirectional_edges_ratio": 0.1 if index % 2 else 0.0,
        "node_types": node_types,
        "edge_types": edge_types,
        "extra_node_columns": EXTRA_NODE_COLUMNS,
    }


def _unqualified(table: str) -> str:
    """``catalog.schema.table`` → ``schema.table``.

    Local Spark resolves seeded tables two-part, and the catalog a name carries
    depends on who wrote it (the seed asks for ``dev_catalog``; ``/api/datasets``
    reports ``spark_catalog``). Comparing without it is what Spark itself does.
    """
    parts = table.split(".")
    return ".".join(parts[-2:]) if len(parts) >= 2 else table


async def repair_missing_graphs(
    client: "SeedClient", contexts: list[dict[str, Any]], log=print
) -> int:
    """Recreate seeded warehouse tables that existing contexts still point at.

    Contexts live in PostgreSQL (a Docker volume) while their tables live in the
    Spark warehouse (a local directory). Either can be wiped without the other,
    and the seed used to skip on its tag alone — so a rerun left every seeded
    context pointing at a table that no longer existed, and every query on one
    failed with ``TABLE_OR_VIEW_NOT_FOUND``. Returns how many were rebuilt.
    """
    referenced: dict[tuple[str, str], set[int]] = {}
    for ctx in contexts:
        match = SEED_TABLE_RE.match(ctx.get("edge_table_name") or "")
        if match:
            key = (match["catalog"] or DEFAULT_CATALOG, match["schema"])
            referenced.setdefault(key, set()).add(int(match["index"]))
    if not referenced:
        return 0

    datasets = (await client.request("GET", "/api/datasets", ADMIN_EMAIL)).json()
    live = {
        _unqualified(name)
        for key in ("tables", "edge_tables", "node_tables")
        for name in (datasets.get(key) or [])
    }

    rebuilt = 0
    for (catalog, schema), indexes in sorted(referenced.items()):
        for index in sorted(indexes):
            needed = {f"{schema}.edges_seed_{index}", f"{schema}.nodes_seed_{index}"}
            if needed <= live:
                continue
            log(f"repairing {schema}.*_seed_{index} (gone from the warehouse)")
            await client.request(
                "POST",
                "/api/dev/random-graph",
                ADMIN_EMAIL,
                json=graph_payload(index, catalog, schema),
            )
            rebuilt += 1
    return rebuilt


class SeedClient:
    """Thin async client; every call carries the acting user's identity."""

    def __init__(self, api: str, concurrency: int = 8, timeout: float = 120.0):
        self.api = api.rstrip("/")
        self.client = httpx.AsyncClient(base_url=self.api, timeout=timeout)
        self.semaphore = asyncio.Semaphore(concurrency)

    async def close(self) -> None:
        await self.client.aclose()

    async def request(
        self, method: str, path: str, user: str, json: Any = None, **kwargs
    ) -> httpx.Response:
        async with self.semaphore:
            response = await self.client.request(
                method, path, json=json, headers={"X-Forwarded-Email": user}, **kwargs
            )
        if response.status_code >= 400:
            raise SeedError(
                f"{method} {path} as {user} → {response.status_code}: {response.text[:300]}"
            )
        return response


async def run_seed(
    api: str,
    *,
    users: int,
    contexts: int,
    explorations: int,
    graphs: int,
    seed: int,
    reset: bool = False,
    no_graphs: bool = False,
    concurrency: int = 8,
    warehouse_wait: float = 180.0,
    log=print,
) -> SeedStats:
    rng = random.Random(seed)
    stats = SeedStats()
    tag = seed_tag(users, contexts, explorations, graphs, seed)
    client = SeedClient(api, concurrency=concurrency)
    try:
        config = (await client.request("GET", "/api/config", ADMIN_EMAIL)).json()
        if not config.get("dev_mode"):
            raise SeedError("Server is not in dev mode; refusing to seed.")
        if not config.get("is_superuser"):
            log(
                f"warning: {ADMIN_EMAIL} is not a superuser on this server — "
                "transfers/--reset will fail. Add it to GRAPH_LAGOON_SUPERUSER_EMAILS."
            )
        allowed_domains = [d.lower() for d in config.get("allowed_share_domains") or []]
        domain_shares = SEED_DOMAIN in allowed_domains
        if not domain_shares:
            log(
                f"warning: *@{SEED_DOMAIN} wildcard shares are not allowed on this "
                "server (GRAPH_LAGOON_ALLOWED_SHARE_DOMAINS) — seeding public and "
                "per-user shares only."
            )

        if not no_graphs:
            # /api/datasets lists warehouse tables, so it only answers once the
            # warehouse itself is up — `make dev` starts Spark seconds before us.
            deadline = time.monotonic() + warehouse_wait
            while True:
                try:
                    await client.request("GET", "/api/datasets", ADMIN_EMAIL)
                    break
                except SeedError as exc:
                    if time.monotonic() > deadline:
                        raise SeedError(
                            f"warehouse not reachable within {warehouse_wait:.0f}s: {exc}"
                        ) from exc
                    log("waiting for the warehouse…")
                    await asyncio.sleep(3.0)

        if reset:
            await client.request(
                "POST",
                "/api/admin/environment/clear",
                ADMIN_EMAIL,
                json={"confirm": "CLEAR ALL"},
            )
            log("environment cleared")

        existing = (
            await client.request("GET", "/api/graph-contexts", ADMIN_EMAIL)
        ).json()
        # Before anything else, heal an environment where the contexts outlived
        # their tables — PostgreSQL and the Spark warehouse are wiped separately.
        if not no_graphs:
            stats.repaired = await repair_missing_graphs(client, existing, log)
            if stats.repaired:
                log(f"rebuilt {stats.repaired} missing warehouse graph(s)")
        if any(tag in (c.get("tags") or []) for c in existing):
            log(f"already seeded ({tag}); use --reset or different parameters")
            stats.skipped = True
            return stats

        roster = make_users(users, rng)
        stats.users = len(roster) + 1  # + admin
        # Registering a user is one authenticated request (touch_user).
        await asyncio.gather(
            *(client.request("GET", "/api/graph-contexts", u.email) for u in roster)
        )
        log(f"users: {len(roster)} registered")

        # Graphs -------------------------------------------------------------
        graph_tables: list[tuple[str, str, list[str], list[str]]] = []
        if not no_graphs:
            for i in range(graphs):
                payload = graph_payload(i)
                node_types = payload["node_types"]
                edge_types = payload["edge_types"]
                result = (
                    await client.request(
                        "POST", "/api/dev/random-graph", ADMIN_EMAIL, json=payload
                    )
                ).json()
                graph_tables.append(
                    (result["edge_table"], result["node_table"], node_types, edge_types)
                )
                stats.graphs += 1
                log(
                    f"graph {i}: {payload['model']} {payload['num_nodes']} nodes "
                    f"→ {result['edge_table']}"
                )
        else:
            for i in range(max(1, graphs)):
                node_types, edge_types = NODE_TYPE_SETS[i % len(NODE_TYPE_SETS)]
                graph_tables.append(
                    (
                        f"{DEFAULT_CATALOG}.{DEFAULT_SCHEMA}.seed_{i}_edges",
                        f"{DEFAULT_CATALOG}.{DEFAULT_SCHEMA}.seed_{i}_nodes",
                        node_types,
                        edge_types,
                    )
                )

        # Contexts -----------------------------------------------------------
        seeded: list[SeedContext] = []
        for i in range(contexts):
            owner = pick_owner(roster, rng)
            gi = rng.randrange(len(graph_tables))
            edge_table, node_table, node_types, edge_types = graph_tables[gi]
            title = f"{rng.choice(TITLE_NOUNS)}{rng.choice(TITLE_SUFFIX)} #{i + 1}"
            tags = sorted(set(rng.sample(TAG_VOCAB, rng.randint(0, 3)))) + [tag]
            payload = {
                "title": title,
                "description": f"Seeded context #{i + 1} owned by {owner.email}",
                "tags": tags,
                "edge_table_name": edge_table,
                "node_table_name": node_table,
                "node_types": node_types,
                "relationship_types": edge_types,
                "node_properties": [
                    {"name": c["name"], "data_type": c["data_type"]}
                    for c in EXTRA_NODE_COLUMNS
                ],
                "default_behaviors": {"viewMode": rng.choice(VIEW_MODES)},
            }
            created = (
                await client.request(
                    "POST", "/api/graph-contexts", owner.email, json=payload
                )
            ).json()
            ctx = SeedContext(
                id=created["id"],
                title=title,
                owner=owner.email,
                graph_index=gi,
                node_types=node_types,
            )
            seeded.append(ctx)
            stats.contexts += 1

            # Shares: ~30 % of contexts, power users share more.
            share_roll = rng.random()
            if share_roll < (0.5 if owner.profile == "power" else 0.25):
                kind = rng.random()
                if kind < 0.25:
                    target, perm = "*", "read"
                elif kind < 0.5 and domain_shares:
                    target, perm = f"*@{SEED_DOMAIN}", rng.choice(["read", "write"])
                else:
                    other = rng.choice([u for u in roster if u.email != owner.email])
                    target, perm = other.email, rng.choice(["read", "write"])
                await client.request(
                    "POST",
                    f"/api/graph-contexts/{ctx.id}/share",
                    owner.email,
                    json={"email": target, "permission": perm},
                )
                ctx.shared_with.append(target)
                stats.shares += 1

            # Query templates: ~25 % of contexts get 1–3.
            if rng.random() < 0.25:
                for t in range(rng.randint(1, 3)):
                    label = node_types[t % len(node_types)]
                    await client.request(
                        "POST",
                        f"/api/graph-contexts/{ctx.id}/query-templates",
                        owner.email,
                        json={
                            "name": f"{label} neighbourhood {t + 1}",
                            "description": "Seeded template",
                            "query_type": "cypher",
                            "query": f"MATCH (a:{label})--(b) RETURN a, b LIMIT $limit",
                            "parameters": [
                                {
                                    "id": "limit",
                                    "type": "input",
                                    "label": "Limit",
                                    "default": "50",
                                }
                            ],
                            "visibility": rng.choice(["shared", "shared", "private"]),
                        },
                    )
                    stats.templates += 1
        log(
            f"contexts: {stats.contexts} (shares: {stats.shares}, templates: {stats.templates})"
        )

        # Explorations ---------------------------------------------------------
        # Poisson-ish: a few contexts get many, most get a couple.
        weights = [rng.expovariate(1.0) + 0.2 for _ in seeded]
        exploration_ids: list[tuple[str, str]] = []  # (id, owner)
        node_cache: dict[str, list[dict[str, Any]]] = {}

        async def fetch_nodes(ctx: SeedContext) -> list[dict[str, Any]]:
            if ctx.id in node_cache:
                return node_cache[ctx.id]
            nodes: list[dict[str, Any]] = []
            if not no_graphs:
                try:
                    response = await client.request(
                        "POST",
                        f"/api/graph-contexts/{ctx.id}/subgraph",
                        ctx.owner,
                        json={"edge_limit": 60},
                    )
                    nodes = response.json().get("nodes", [])
                except SeedError as exc:
                    log(f"  subgraph for {ctx.title} failed, saving empty state: {exc}")
            node_cache[ctx.id] = nodes
            return nodes

        for i in range(explorations):
            ctx = rng.choices(seeded, weights=weights)[0]
            nodes = await fetch_nodes(ctx)
            picked = (
                rng.sample(nodes, min(len(nodes), rng.randint(5, 40))) if nodes else []
            )
            focus = picked[0]["node_id"] if picked else None
            layout = rng.choice(LAYOUTS)
            state: dict[str, Any] = {
                "nodes": [{"node_id": n["node_id"]} for n in picked],
                "edges": [],
                "filters": {"node_types": [], "edge_types": []},
                "viewport": {
                    "zoom": round(rng.uniform(0.6, 1.8), 2),
                    "center_x": 0,
                    "center_y": 0,
                },
                "layout_algorithm": layout,
                "behaviors": {"viewMode": rng.choice(VIEW_MODES)},
            }
            if layout == "ego" and focus:
                state["layout_mode_config"] = {
                    "ego": {"focusNodeId": focus, "maxDepth": 2}
                }
            title = f"{rng.choice(EXPLORATION_VERBS)} {focus or ctx.node_types[0]} ({i + 1})"
            created = (
                await client.request(
                    "POST",
                    f"/api/graph-contexts/{ctx.id}/explorations",
                    ctx.owner,
                    json={"title": title, "state": state},
                )
            ).json()
            exploration_ids.append((created["id"], ctx.owner))
            stats.explorations += 1
            if rng.random() < 0.3:
                other = rng.choice([u for u in roster if u.email != ctx.owner])
                choices = [other.email, "*"] + (
                    [f"*@{SEED_DOMAIN}"] if domain_shares else []
                )
                target = rng.choice(choices)
                await client.request(
                    "POST",
                    f"/api/explorations/{created['id']}/share",
                    ctx.owner,
                    json={"email": target, "permission": "read"},
                )
                stats.shares += 1
        log(f"explorations: {stats.explorations}")

        # Activity for the audit trail --------------------------------------------
        for exp_id, owner in rng.sample(
            exploration_ids, k=min(len(exploration_ids), max(1, explorations // 20))
        ):
            await client.request("DELETE", f"/api/explorations/{exp_id}", owner)
            stats.deletes += 1
        inactive = [u for u in roster if u.profile == "inactive"]
        transfer_targets = rng.sample(seeded, k=min(len(seeded), 3))
        for ctx in transfer_targets:
            if not inactive:
                break
            target = rng.choice(inactive)
            try:
                await client.request(
                    "POST",
                    f"/api/admin/contexts/{ctx.id}/transfer",
                    ADMIN_EMAIL,
                    json={"new_owner_email": target.email},
                )
                stats.transfers += 1
            except SeedError as exc:
                log(f"  transfer skipped ({exc})")
                break
        log(f"audit activity: {stats.deletes} deletes, {stats.transfers} transfers")

        power = next((u.email for u in roster if u.profile == "power"), None)
        idle = next((u.email for u in roster if u.profile == "inactive"), None)
        log("")
        log("Log in as:")
        log(f"  {ADMIN_EMAIL:40s} superuser → Admin area")
        if power:
            log(f"  {power:40s} power user (many contexts / explorations)")
        if idle:
            log(f"  {idle:40s} inactive user (transfer candidate)")
        return stats
    finally:
        await client.close()


# The standalone server (graphlagoon.main) mounts the app under /graphlagoon;
# an embedded host may use any prefix. Probe the likely bases in order.
MOUNT_CANDIDATES = ("", "/graphlagoon")


async def wait_for_health(api: str, timeout: float = 60.0) -> str:
    """Wait for the server and return the API base (origin + mount prefix)."""
    origin = api.rstrip("/")
    deadline = time.monotonic() + timeout
    async with httpx.AsyncClient(timeout=3.0) as client:
        while time.monotonic() < deadline:
            for prefix in MOUNT_CANDIDATES:
                base = (
                    origin if origin.endswith(prefix) or not prefix else origin + prefix
                )
                try:
                    r = await client.get(f"{base}/api/config")
                    if r.status_code == 200:
                        return base
                except httpx.HTTPError:
                    pass
            await asyncio.sleep(1.0)
    raise SeedError(
        f"API at {api} did not answer /api/config within {timeout:.0f}s "
        "(tried mount prefixes: root, /graphlagoon). Pass --api with the right base."
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--api", default="http://localhost:8000")
    parser.add_argument("--users", type=int, default=30)
    parser.add_argument("--contexts", type=int, default=60)
    parser.add_argument("--explorations", type=int, default=200)
    parser.add_argument("--graphs", type=int, default=5)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument(
        "--reset", action="store_true", help="clear the environment first (superuser)"
    )
    parser.add_argument(
        "--no-graphs", action="store_true", help="skip warehouse tables (metadata only)"
    )
    parser.add_argument("--concurrency", type=int, default=8)
    parser.add_argument(
        "--wait", type=float, default=60.0, help="seconds to wait for /health"
    )
    parser.add_argument(
        "--warehouse-wait",
        type=float,
        default=180.0,
        help="seconds to wait for the warehouse (Spark) before creating graphs",
    )
    return parser


def main(argv: Optional[list[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        base = asyncio.run(wait_for_health(args.api, args.wait))
        stats = asyncio.run(
            run_seed(
                base,
                users=args.users,
                contexts=args.contexts,
                explorations=args.explorations,
                graphs=args.graphs,
                seed=args.seed,
                reset=args.reset,
                no_graphs=args.no_graphs,
                concurrency=args.concurrency,
                warehouse_wait=args.warehouse_wait,
            )
        )
    except SeedError as exc:
        print(f"seed failed: {exc}", file=sys.stderr)
        return 1
    if stats.repaired:
        print(f"repaired: {stats.repaired} warehouse graph(s) rebuilt")
    if not stats.skipped:
        print(
            f"seeded: {stats.users} users, {stats.graphs} graphs, {stats.contexts} contexts, "
            f"{stats.explorations} explorations, {stats.templates} templates, {stats.shares} shares"
        )
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
