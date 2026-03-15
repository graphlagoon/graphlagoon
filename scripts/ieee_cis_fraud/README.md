# IEEE CIS Fraud Detection → Graph

Converts the [IEEE CIS Fraud Detection dataset](https://www.kaggle.com/c/ieee-fraud-detection)
into a graph for fraud analysis visualization in graphlagoon-studio.

## Graph Model

**Nodes:**

| Type | Source | Properties |
|------|--------|------------|
| Transaction | Each row in `train_transaction.csv` | `TransactionAmt`, `ProductCD`, `isFraud`, `TransactionDT`, C/D/M cols |
| Card | Unique `card1`-`card6` combos | `card1` through `card6` |
| Device | Unique `DeviceType`+`DeviceInfo` | `DeviceType`, `DeviceInfo` |
| Address | Unique `addr1`+`addr2` combos | `addr1`, `addr2` |

Email nodes are **disabled by default** (domains like gmail.com act as
super-hubs). Enable with `--include-email-nodes`.

**Edges:**

| Type | From → To |
|------|-----------|
| `PAID_WITH` | Transaction → Card |
| `SENT_FROM` | Transaction → Email (if enabled) |
| `RECEIVED_AT` | Transaction → Email (if enabled) |
| `USED_DEVICE` | Transaction → Device |
| `FROM_ADDRESS` | Transaction → Address |

## Sampling Strategy

The script uses **ego-graphs around fraud transactions**:

1. Pick `--num-seeds` random fraud transactions as seeds
2. Expand `--hops` hops around each seed via BFS
3. Skip hub nodes (degree > `--max-degree`) during expansion
4. Union all ego-graphs into the final subgraph

This produces small, fraud-focused subgraphs instead of
one giant connected component.

## Setup

```bash
pip install -r requirements.txt
```

## Download the Dataset

The script **downloads automatically** via Kaggle API if
the CSVs are not found in `--input-dir`.

**Prerequisites:**

1. `pip install -r requirements.txt` (includes `kaggle`)
2. Kaggle API credentials at `~/.kaggle/kaggle.json`
   ([how to get](https://www.kaggle.com/docs/api#authentication))
3. Accept the competition rules at
   https://www.kaggle.com/c/ieee-fraud-detection/rules

Or download manually:

```bash
kaggle competitions download -c ieee-fraud-detection \
  -p ./data/ieee-cis-raw/
unzip ./data/ieee-cis-raw/ieee-fraud-detection.zip \
  -d ./data/ieee-cis-raw/
```

## Usage

```bash
# Run from the project root so paths resolve correctly
cd /path/to/graphlagoon-studio

# Basic — auto-downloads, 20 fraud seeds, 2 hops
python scripts/ieee_cis_fraud/build_fraud_graph.py

# More seeds for a larger demo graph
python build_fraud_graph.py --num-seeds 50 --hops 2

# Tighter subgraphs (lower max-degree prunes more hubs)
python build_fraud_graph.py --num-seeds 20 --max-degree 200

# Custom output location and table names
python build_fraud_graph.py \
  --output-dir ./warehouse/data/parquet/ \
  --catalog demo --schema fraud --table ieee_cis
```

## Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `--input-dir` | `./data/ieee-cis-raw` | Directory with CSVs |
| `--output-dir` | `./warehouse/data/parquet` | Parquet output dir |
| `--catalog` | `demo` | Catalog name |
| `--schema` | `fraud` | Schema name |
| `--table` | `ieee_cis` | Table suffix |
| `--max-transactions` | `0` (all) | Limit transactions |
| `--num-seeds` | `20` | Fraud seeds for ego-graphs |
| `--hops` | `2` | BFS hops around each seed |
| `--max-degree` | `500` | Skip expanding hub nodes |
| `--include-email-nodes` | off | Include email domain nodes |
| `--seed` | `42` | Random seed |

## Output

Parquet directories following the warehouse convention:

```
warehouse/data/parquet/
├── nodes_demo__fraud__ieee_cis/
│   └── part-00000.parquet
└── edges_demo__fraud__ieee_cis/
    └── part-00000.parquet
```

Table names for GraphContext creation:

- Node table: `demo.fraud.nodes_ieee_cis`
- Edge table: `demo.fraud.edges_ieee_cis`

## Using with graphlagoon-studio

After running the script:

1. Start the warehouse: `make dev`
2. Create a GraphContext pointing to the output tables
3. Open the graph visualization to explore fraud patterns
