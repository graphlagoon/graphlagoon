#!/usr/bin/env python3
"""
Build a fraud analysis graph from the IEEE CIS Fraud Detection dataset.

Transforms the tabular transaction/identity CSVs into a graph with:
  - Node types: Transaction, Card, Email, Device, Address
  - Edge types: PAID_WITH, SENT_FROM, RECEIVED_AT, USED_DEVICE, FROM_ADDRESS

Extracts the largest connected components to produce a meaningful
demo subgraph, then saves as parquet files for the warehouse.

Usage:
    python build_fraud_graph.py --input-dir ./data/ieee-cis-raw/ --top-components 5
"""

import argparse
import hashlib
import logging
import os
import sys
import uuid

import networkx as nx
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq

from config import (
    ADDRESS_ID_COLS,
    CARD_ID_COLS,
    DEFAULT_CATALOG,
    DEFAULT_INPUT_DIR,
    DEFAULT_OUTPUT_DIR,
    DEFAULT_SCHEMA,
    DEFAULT_SEED,
    DEFAULT_TABLE,
    DEVICE_ID_COLS,
    EDGE_FROM_ADDRESS,
    EDGE_PAID_WITH,
    EDGE_RECEIVED_AT,
    EDGE_SENT_FROM,
    EDGE_USED_DEVICE,
    EMAIL_PURCHASER_COL,
    EMAIL_RECIPIENT_COL,
    IDENTITY_LOAD_COLS,
    NODE_TYPE_ADDRESS,
    NODE_TYPE_CARD,
    NODE_TYPE_DEVICE,
    NODE_TYPE_EMAIL,
    NODE_TYPE_TRANSACTION,
    TRANSACTION_LOAD_COLS,
    TRANSACTION_PROPS,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def stable_hash(*parts: object) -> str:
    """Create a deterministic short hash from parts (for node IDs)."""
    raw = "|".join(str(p) for p in parts)
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


def make_edge_id() -> str:
    return uuid.uuid4().hex[:16]


# ---------------------------------------------------------------------------
# Loading
# ---------------------------------------------------------------------------


def download_dataset(input_dir: str) -> None:
    """Download IEEE CIS Fraud Detection dataset via Kaggle API.

    Requires:
      - ``kaggle`` package installed
      - Kaggle API credentials configured (~/.kaggle/kaggle.json)
    """
    os.makedirs(input_dir, exist_ok=True)
    log.info("Downloading IEEE CIS dataset to %s via Kaggle API...", input_dir)
    try:
        from kaggle.api.kaggle_api_extended import KaggleApi

        api = KaggleApi()
        api.authenticate()
        api.competition_download_files(
            "ieee-fraud-detection", path=input_dir, quiet=False
        )
    except Exception as e:
        sys.exit(
            f"Kaggle download failed: {e}\n"
            "Make sure you have:\n"
            "  1. pip install kaggle\n"
            "  2. Kaggle credentials at ~/.kaggle/kaggle.json\n"
            "  3. Accepted the competition rules at "
            "https://www.kaggle.com/c/ieee-fraud-detection/rules"
        )

    # Unzip if downloaded as a zip
    zip_path = os.path.join(input_dir, "ieee-fraud-detection.zip")
    if os.path.isfile(zip_path):
        import zipfile

        log.info("Extracting %s ...", zip_path)
        with zipfile.ZipFile(zip_path, "r") as zf:
            zf.extractall(input_dir)
        os.remove(zip_path)
        log.info("Extraction complete.")


def load_data(input_dir: str, max_transactions: int = 0) -> pd.DataFrame:
    """Load and join transaction + identity CSVs. Downloads if missing."""
    tx_path = os.path.join(input_dir, "train_transaction.csv")
    id_path = os.path.join(input_dir, "train_identity.csv")

    if not os.path.isfile(tx_path):
        log.info("CSVs not found in %s — attempting Kaggle download...", input_dir)
        download_dataset(input_dir)

    if not os.path.isfile(tx_path):
        sys.exit(f"File not found after download: {tx_path}")

    log.info("Loading transactions from %s ...", tx_path)
    tx = pd.read_csv(tx_path, usecols=TRANSACTION_LOAD_COLS)
    log.info("  %d transactions loaded (%d columns)", len(tx), len(tx.columns))

    if max_transactions > 0 and len(tx) > max_transactions:
        log.info("  Sampling %d transactions (seed-based)...", max_transactions)
        tx = tx.sample(n=max_transactions, random_state=DEFAULT_SEED)

    if os.path.isfile(id_path):
        log.info("Loading identity from %s ...", id_path)
        identity = pd.read_csv(id_path, usecols=IDENTITY_LOAD_COLS)
        log.info("  %d identity rows loaded", len(identity))
        tx = tx.merge(identity, on="TransactionID", how="left")
        log.info("  After join: %d rows", len(tx))
    else:
        log.warning("Identity file not found: %s (skipping device nodes)", id_path)
        for col in DEVICE_ID_COLS:
            tx[col] = pd.NA

    return tx


# ---------------------------------------------------------------------------
# Node extraction
# ---------------------------------------------------------------------------


def build_transaction_nodes(df: pd.DataFrame) -> pd.DataFrame:
    """Build Transaction nodes from the dataset."""
    props = [c for c in TRANSACTION_PROPS if c in df.columns]
    nodes = df[["TransactionID"] + props].copy()
    nodes["node_id"] = nodes["TransactionID"].astype(str)
    nodes["node_type"] = NODE_TYPE_TRANSACTION
    nodes = nodes.drop(columns=["TransactionID"])
    return nodes


def build_card_nodes(df: pd.DataFrame) -> pd.DataFrame:
    """Build Card nodes from unique card column combinations."""
    cols = [c for c in CARD_ID_COLS if c in df.columns]
    cards = df[cols].drop_duplicates().dropna(subset=[cols[0]])
    cards["node_id"] = cards.apply(
        lambda r: stable_hash(NODE_TYPE_CARD, *[r[c] for c in cols]), axis=1
    )
    cards["node_type"] = NODE_TYPE_CARD
    return cards


def build_email_nodes(df: pd.DataFrame) -> pd.DataFrame:
    """Build Email nodes from unique email domains."""
    domains = set()
    for col in [EMAIL_PURCHASER_COL, EMAIL_RECIPIENT_COL]:
        if col in df.columns:
            domains.update(df[col].dropna().unique())

    if not domains:
        return pd.DataFrame(columns=["node_id", "node_type", "domain"])

    records = []
    for domain in sorted(domains):
        records.append(
            {
                "node_id": stable_hash(NODE_TYPE_EMAIL, domain),
                "node_type": NODE_TYPE_EMAIL,
                "domain": str(domain),
            }
        )
    return pd.DataFrame(records)


def build_device_nodes(df: pd.DataFrame) -> pd.DataFrame:
    """Build Device nodes from unique DeviceType+DeviceInfo combinations."""
    cols = [c for c in DEVICE_ID_COLS if c in df.columns]
    devices = df[cols].drop_duplicates().dropna(subset=cols, how="all")
    if devices.empty:
        return pd.DataFrame(columns=["node_id", "node_type"] + cols)

    devices["node_id"] = devices.apply(
        lambda r: stable_hash(NODE_TYPE_DEVICE, *[r[c] for c in cols]), axis=1
    )
    devices["node_type"] = NODE_TYPE_DEVICE
    return devices


def build_address_nodes(df: pd.DataFrame) -> pd.DataFrame:
    """Build Address nodes from unique addr1+addr2 combinations."""
    cols = [c for c in ADDRESS_ID_COLS if c in df.columns]
    addrs = df[cols].drop_duplicates().dropna(subset=[cols[0]])
    if addrs.empty:
        return pd.DataFrame(columns=["node_id", "node_type"] + cols)

    addrs["node_id"] = addrs.apply(
        lambda r: stable_hash(NODE_TYPE_ADDRESS, *[r[c] for c in cols]), axis=1
    )
    addrs["node_type"] = NODE_TYPE_ADDRESS
    return addrs


# ---------------------------------------------------------------------------
# Edge extraction
# ---------------------------------------------------------------------------


def build_edges(
    df: pd.DataFrame,
    card_nodes: pd.DataFrame,
    email_nodes: pd.DataFrame,
    device_nodes: pd.DataFrame,
    address_nodes: pd.DataFrame,
) -> pd.DataFrame:
    """Build all edges linking transactions to entity nodes."""
    edges: list[dict] = []

    # Pre-build lookup dicts for fast node_id resolution
    card_cols = [c for c in CARD_ID_COLS if c in df.columns]
    card_lookup = {}
    for _, row in card_nodes.iterrows():
        key = tuple(row[c] for c in card_cols)
        card_lookup[key] = row["node_id"]

    email_lookup = {}
    for _, row in email_nodes.iterrows():
        email_lookup[row["domain"]] = row["node_id"]

    device_cols = [c for c in DEVICE_ID_COLS if c in df.columns]
    device_lookup = {}
    for _, row in device_nodes.iterrows():
        key = tuple(row[c] for c in device_cols)
        device_lookup[key] = row["node_id"]

    addr_cols = [c for c in ADDRESS_ID_COLS if c in df.columns]
    addr_lookup = {}
    for _, row in address_nodes.iterrows():
        key = tuple(row[c] for c in addr_cols)
        addr_lookup[key] = row["node_id"]

    log.info("Building edges for %d transactions...", len(df))

    for _, row in df.iterrows():
        tx_id = str(row["TransactionID"])

        # PAID_WITH → Card
        card_key = tuple(row[c] for c in card_cols)
        if not any(pd.isna(v) for v in card_key):
            card_nid = card_lookup.get(card_key)
            if card_nid:
                edges.append(
                    {
                        "edge_id": make_edge_id(),
                        "src": tx_id,
                        "dst": card_nid,
                        "relationship_type": EDGE_PAID_WITH,
                    }
                )

        # SENT_FROM → Email (purchaser)
        p_email = row.get(EMAIL_PURCHASER_COL)
        if pd.notna(p_email):
            email_nid = email_lookup.get(str(p_email))
            if email_nid:
                edges.append(
                    {
                        "edge_id": make_edge_id(),
                        "src": tx_id,
                        "dst": email_nid,
                        "relationship_type": EDGE_SENT_FROM,
                    }
                )

        # RECEIVED_AT → Email (recipient)
        r_email = row.get(EMAIL_RECIPIENT_COL)
        if pd.notna(r_email):
            email_nid = email_lookup.get(str(r_email))
            if email_nid:
                edges.append(
                    {
                        "edge_id": make_edge_id(),
                        "src": tx_id,
                        "dst": email_nid,
                        "relationship_type": EDGE_RECEIVED_AT,
                    }
                )

        # USED_DEVICE → Device
        device_key = tuple(row[c] for c in device_cols)
        if not any(pd.isna(v) for v in device_key):
            device_nid = device_lookup.get(device_key)
            if device_nid:
                edges.append(
                    {
                        "edge_id": make_edge_id(),
                        "src": tx_id,
                        "dst": device_nid,
                        "relationship_type": EDGE_USED_DEVICE,
                    }
                )

        # FROM_ADDRESS → Address
        addr_key = tuple(row[c] for c in addr_cols)
        if not any(pd.isna(v) for v in addr_key):
            addr_nid = addr_lookup.get(addr_key)
            if addr_nid:
                edges.append(
                    {
                        "edge_id": make_edge_id(),
                        "src": tx_id,
                        "dst": addr_nid,
                        "relationship_type": EDGE_FROM_ADDRESS,
                    }
                )

    log.info("  %d edges built", len(edges))
    return pd.DataFrame(edges)


# ---------------------------------------------------------------------------
# Subgraph extraction
# ---------------------------------------------------------------------------


def _bfs_limited(
    G: nx.Graph, source: str, hops: int, max_degree: int,
) -> set[str]:
    """BFS from source up to ``hops`` hops, skipping hub nodes.

    Nodes with degree > ``max_degree`` are included but NOT expanded
    further.  This prevents Address/Device super-hubs from pulling in
    the entire graph.
    """
    visited: set[str] = {source}
    frontier: set[str] = {source}

    for _ in range(hops):
        next_frontier: set[str] = set()
        for node in frontier:
            # Skip expanding hubs — they connect too many nodes
            if G.degree(node) > max_degree:
                continue
            for neighbor in G.neighbors(node):
                if neighbor not in visited:
                    visited.add(neighbor)
                    next_frontier.add(neighbor)
        frontier = next_frontier

    return visited


def extract_fraud_ego_graphs(
    nodes_df: pd.DataFrame,
    edges_df: pd.DataFrame,
    num_seeds: int,
    hops: int,
    max_degree: int,
    seed: int,
) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Extract ego-graphs around fraud transactions.

    Picks ``num_seeds`` random fraud transactions as seeds, then expands
    ``hops`` hops in the graph around each seed, skipping hub nodes
    (degree > ``max_degree``) during expansion.

    This produces small, fraud-focused subgraphs instead of one giant
    connected component.
    """
    import random as _rng

    _rng.seed(seed)

    log.info("Building NetworkX graph...")
    G = nx.Graph()
    G.add_nodes_from(nodes_df["node_id"].values)
    G.add_edges_from(zip(edges_df["src"].values, edges_df["dst"].values))
    log.info("  Full graph: %d nodes, %d edges", G.number_of_nodes(), G.number_of_edges())

    # Identify fraud transaction node_ids
    fraud_tx_ids = list(
        nodes_df.loc[nodes_df.get("isFraud", pd.Series()) == 1, "node_id"].values
    )
    if not fraud_tx_ids:
        log.warning("  No fraud transactions found — returning full graph")
        return nodes_df, edges_df

    log.info("  %d fraud transactions available", len(fraud_tx_ids))

    # Sample seeds
    actual_seeds = min(num_seeds, len(fraud_tx_ids))
    seeds = _rng.sample(fraud_tx_ids, actual_seeds)
    log.info(
        "  Selected %d fraud seeds, expanding %d hops each (max_degree=%d)",
        actual_seeds, hops, max_degree,
    )

    # Expand ego-graphs with hub pruning
    selected_nodes: set[str] = set()
    for i, seed_node in enumerate(seeds):
        ego_nodes = _bfs_limited(G, seed_node, hops, max_degree)
        selected_nodes.update(ego_nodes)
        if i < 10 or i == actual_seeds - 1:
            log.info("    Seed %d (%s): %d nodes in ego-graph", i, seed_node, len(ego_nodes))

    log.info("  Total unique nodes across all ego-graphs: %d", len(selected_nodes))

    # Filter DataFrames
    nodes_out = nodes_df[nodes_df["node_id"].isin(selected_nodes)].copy()
    edges_out = edges_df[
        edges_df["src"].isin(selected_nodes) & edges_df["dst"].isin(selected_nodes)
    ].copy()

    log.info("  After filtering: %d nodes, %d edges", len(nodes_out), len(edges_out))
    return nodes_out, edges_out


# ---------------------------------------------------------------------------
# Parquet output
# ---------------------------------------------------------------------------


def save_parquet(
    nodes_df: pd.DataFrame,
    edges_df: pd.DataFrame,
    output_dir: str,
    catalog: str,
    schema: str,
    table: str,
) -> tuple[str, str]:
    """Save node and edge DataFrames as parquet directories.

    Follows the warehouse naming convention:
        nodes_{catalog}__{schema}__{table}/
        edges_{catalog}__{schema}__{table}/
    """
    node_dir_name = f"nodes_{catalog}__{schema}__{table}"
    edge_dir_name = f"edges_{catalog}__{schema}__{table}"

    node_path = os.path.join(output_dir, node_dir_name)
    edge_path = os.path.join(output_dir, edge_dir_name)

    os.makedirs(node_path, exist_ok=True)
    os.makedirs(edge_path, exist_ok=True)

    # Convert all columns to string-friendly types for parquet compatibility
    nodes_out = nodes_df.copy()
    edges_out = edges_df.copy()

    # Ensure node_id and node_type are strings
    nodes_out["node_id"] = nodes_out["node_id"].astype(str)
    nodes_out["node_type"] = nodes_out["node_type"].astype(str)

    # Ensure edge structural columns are strings
    for col in ["edge_id", "src", "dst", "relationship_type"]:
        edges_out[col] = edges_out[col].astype(str)

    node_file = os.path.join(node_path, "part-00000.parquet")
    edge_file = os.path.join(edge_path, "part-00000.parquet")

    node_table = pa.Table.from_pandas(nodes_out, preserve_index=False)
    edge_table = pa.Table.from_pandas(edges_out, preserve_index=False)

    pq.write_table(node_table, node_file)
    pq.write_table(edge_table, edge_file)

    log.info("Saved nodes to %s", node_path)
    log.info("Saved edges to %s", edge_path)

    # Return full table names for context creation
    node_table_name = f"{catalog}.{schema}.nodes_{table}"
    edge_table_name = f"{catalog}.{schema}.edges_{table}"
    return node_table_name, edge_table_name


# ---------------------------------------------------------------------------
# Main pipeline
# ---------------------------------------------------------------------------


def build_fraud_graph(
    input_dir: str,
    output_dir: str,
    catalog: str,
    schema: str,
    table: str,
    max_transactions: int,
    num_seeds: int,
    hops: int,
    max_degree: int,
    include_email_nodes: bool,
    seed: int,
) -> None:
    """Full pipeline: load → transform → extract → save."""
    import random
    import numpy as np

    random.seed(seed)
    np.random.seed(seed)

    # 1. Load raw data
    df = load_data(input_dir, max_transactions)

    # 2. Build entity nodes
    log.info("Building nodes...")
    tx_nodes = build_transaction_nodes(df)
    card_nodes = build_card_nodes(df)
    device_nodes = build_device_nodes(df)
    addr_nodes = build_address_nodes(df)

    # Email nodes disabled by default — domains like gmail.com act as
    # super-hubs that collapse the entire graph into one giant component.
    if include_email_nodes:
        email_nodes = build_email_nodes(df)
        log.info(
            "  Nodes: %d Transaction, %d Card, %d Email, %d Device, %d Address",
            len(tx_nodes), len(card_nodes), len(email_nodes),
            len(device_nodes), len(addr_nodes),
        )
    else:
        email_nodes = pd.DataFrame(columns=["node_id", "node_type", "domain"])
        log.info(
            "  Nodes: %d Transaction, %d Card, %d Device, %d Address (email nodes skipped)",
            len(tx_nodes), len(card_nodes), len(device_nodes), len(addr_nodes),
        )

    # 3. Combine all nodes into a single DataFrame
    # Each node type may have different property columns, so we concat with
    # outer join — missing properties become NaN (which parquet handles fine).
    node_dfs = [tx_nodes, card_nodes, device_nodes, addr_nodes]
    if include_email_nodes:
        node_dfs.append(email_nodes)
    all_nodes = pd.concat(node_dfs, ignore_index=True, sort=False)
    log.info("  Total nodes: %d", len(all_nodes))

    # 4. Build edges
    edges = build_edges(df, card_nodes, email_nodes, device_nodes, addr_nodes)

    # 5. Extract ego-graphs around fraud transactions
    all_nodes, edges = extract_fraud_ego_graphs(
        all_nodes, edges,
        num_seeds=num_seeds,
        hops=hops,
        max_degree=max_degree,
        seed=seed,
    )

    # 6. Stats
    fraud_count = 0
    if "isFraud" in all_nodes.columns:
        fraud_count = int(all_nodes["isFraud"].sum())

    log.info("--- Final Graph Stats ---")
    log.info("  Nodes: %d", len(all_nodes))
    log.info("  Edges: %d", len(edges))
    node_types = [NODE_TYPE_TRANSACTION, NODE_TYPE_CARD, NODE_TYPE_DEVICE, NODE_TYPE_ADDRESS]
    if include_email_nodes:
        node_types.append(NODE_TYPE_EMAIL)
    for nt in node_types:
        count = len(all_nodes[all_nodes["node_type"] == nt])
        log.info("    %s: %d", nt, count)
    log.info("  Fraud transactions: %d", fraud_count)
    log.info(
        "  Edge types: %s",
        dict(edges["relationship_type"].value_counts()),
    )

    # 7. Save parquets
    node_table_name, edge_table_name = save_parquet(
        all_nodes, edges, output_dir, catalog, schema, table
    )

    log.info("--- Done ---")
    log.info("Node table: %s", node_table_name)
    log.info("Edge table: %s", edge_table_name)
    log.info(
        "To use in graphlagoon-studio, create a GraphContext with these table names."
    )


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build a fraud analysis graph from IEEE CIS Fraud Detection dataset.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument(
        "--input-dir",
        default=DEFAULT_INPUT_DIR,
        help="Path to directory containing train_transaction.csv and train_identity.csv",
    )
    parser.add_argument(
        "--output-dir",
        default=DEFAULT_OUTPUT_DIR,
        help="Where to write parquet output directories",
    )
    parser.add_argument("--catalog", default=DEFAULT_CATALOG, help="Catalog name")
    parser.add_argument("--schema", default=DEFAULT_SCHEMA, help="Schema name")
    parser.add_argument("--table", default=DEFAULT_TABLE, help="Table suffix")
    parser.add_argument(
        "--max-transactions",
        type=int,
        default=0,
        help="Max transactions to process (0 = all)",
    )
    parser.add_argument(
        "--num-seeds",
        type=int,
        default=20,
        help="Number of fraud transactions to use as ego-graph seeds",
    )
    parser.add_argument(
        "--hops",
        type=int,
        default=2,
        help="Hops to expand around each fraud seed (1-3)",
    )
    parser.add_argument(
        "--max-degree",
        type=int,
        default=500,
        help="Skip expanding nodes with degree above this "
        "(prevents hub explosion)",
    )
    parser.add_argument(
        "--include-email-nodes",
        action="store_true",
        help="Include Email domain nodes (disabled by default — they act as "
        "super-hubs that merge everything into one giant component)",
    )
    parser.add_argument(
        "--seed", type=int, default=DEFAULT_SEED, help="Random seed"
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    build_fraud_graph(
        input_dir=args.input_dir,
        output_dir=args.output_dir,
        catalog=args.catalog,
        schema=args.schema,
        table=args.table,
        max_transactions=args.max_transactions,
        num_seeds=args.num_seeds,
        hops=args.hops,
        max_degree=args.max_degree,
        include_email_nodes=args.include_email_nodes,
        seed=args.seed,
    )


if __name__ == "__main__":
    main()
