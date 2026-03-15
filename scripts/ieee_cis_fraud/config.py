"""
Default configuration for IEEE CIS Fraud Detection graph building.

Defines which columns to extract from the raw dataset and how to map
them into graph nodes and edges.
"""

# --- Transaction node properties (from train_transaction.csv) ---
# These columns become properties on Transaction nodes.
TRANSACTION_PROPS = [
    "TransactionAmt",
    "ProductCD",
    "isFraud",
    "TransactionDT",
    # Card info kept on transaction for quick access
    "card4",  # visa, mastercard, etc.
    "card6",  # debit, credit, etc.
    # Count features (most informative per EDA literature)
    "C1",
    "C2",
    "C13",
    "C14",
    # Timedelta features
    "D1",
    "D15",
    # Match features
    "M4",
    "M5",
    "M6",
]

# --- Columns used to build Card nodes ---
# A unique card is identified by the combination of these columns.
CARD_ID_COLS = ["card1", "card2", "card3", "card4", "card5", "card6"]

# --- Columns used to build Address nodes ---
ADDRESS_ID_COLS = ["addr1", "addr2"]

# --- Email columns ---
# P_emaildomain = purchaser email domain
# R_emaildomain = recipient email domain
EMAIL_PURCHASER_COL = "P_emaildomain"
EMAIL_RECIPIENT_COL = "R_emaildomain"

# --- Identity columns (from train_identity.csv) ---
DEVICE_ID_COLS = ["DeviceType", "DeviceInfo"]

# --- All columns to load from train_transaction.csv ---
TRANSACTION_LOAD_COLS = (
    ["TransactionID"]
    + TRANSACTION_PROPS
    + CARD_ID_COLS
    + ADDRESS_ID_COLS
    + [EMAIL_PURCHASER_COL, EMAIL_RECIPIENT_COL]
)

# --- All columns to load from train_identity.csv ---
IDENTITY_LOAD_COLS = ["TransactionID"] + DEVICE_ID_COLS

# --- Node type constants ---
NODE_TYPE_TRANSACTION = "Transaction"
NODE_TYPE_CARD = "Card"
NODE_TYPE_EMAIL = "Email"
NODE_TYPE_DEVICE = "Device"
NODE_TYPE_ADDRESS = "Address"

# --- Edge type constants ---
EDGE_PAID_WITH = "PAID_WITH"
EDGE_SENT_FROM = "SENT_FROM"
EDGE_RECEIVED_AT = "RECEIVED_AT"
EDGE_USED_DEVICE = "USED_DEVICE"
EDGE_FROM_ADDRESS = "FROM_ADDRESS"

# --- Default CLI parameters ---
DEFAULT_INPUT_DIR = "./data/ieee-cis-raw"
DEFAULT_OUTPUT_DIR = "./warehouse/data/parquet"
DEFAULT_CATALOG = "demo"
DEFAULT_SCHEMA = "fraud"
DEFAULT_TABLE = "ieee_cis"
DEFAULT_SEED = 42
