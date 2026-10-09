"""InMemoryStore parity for the investigation tables (F1.1)."""

import pytest

from graphlagoon.db.memory_store import INVESTIGATION_CHILDREN, InMemoryStore

OWNER = "owner@example.com"

# Minimal required fields per child table (besides investigation_id).
CHILD_FIELDS = {
    "investigation_sources": {
        "kind": "exploration",
        "title_snapshot": "t",
        "added_by": OWNER,
    },
    "investigation_files": {
        "filename": "f.csv",
        "role": "attachment",
        "sha256": "0" * 64,
        "size_bytes": 1,
        "blob_key": "k",
        "uploaded_by": OWNER,
    },
    "investigation_events": {"actor_email": OWNER, "kind": "case.created", "hash": "h"},
    "investigation_notes": {"body": "b", "author_email": OWNER},
    "investigation_evidence": {
        "title": "e",
        "kind": "graph_state",
        "blob_key": "k",
        "sha256": "0" * 64,
        "created_by": OWNER,
    },
    "entity_matches": {"left": {"node_id": "a"}, "right": {"node_id": "b"}},
    "investigation_artifacts": {"name": "a.pdf", "kind": "document"},
    "investigation_artifact_versions": {
        "artifact_id": None,
        "version": 1,
        "blob_key": "k",
        "sha256": "0" * 64,
        "size_bytes": 1,
        "content_type": "application/pdf",
    },
    "investigation_proposals": {"kind": "role"},
}


def test_child_fields_cover_every_table():
    assert set(CHILD_FIELDS) == set(INVESTIGATION_CHILDREN)


def test_investigation_crud_and_share():
    store = InMemoryStore()
    inv = store.create_investigation("Golpe Pix", OWNER, typology="golpe_pix")
    assert store.get_investigation(inv.id).status == "selecao"
    assert store.list_investigations() == [inv]

    store.update_investigation(inv.id, title="Novo", assignee_email=None)
    assert store.get_investigation(inv.id).title == "Novo"

    store.share_investigation(inv.id, "a@example.com")
    store.share_investigation(inv.id, "a@example.com", "write")  # upsert
    assert [(s.shared_with_email, s.permission) for s in inv.shares] == [
        ("a@example.com", "write")
    ]
    assert store.unshare_investigation(inv.id, "a@example.com")
    assert not store.unshare_investigation(inv.id, "a@example.com")

    assert store.delete_investigation(inv.id)
    assert store.get_investigation(inv.id) is None


@pytest.mark.parametrize("table", sorted(CHILD_FIELDS))
def test_child_crud_and_cascade(table):
    store = InMemoryStore()
    inv = store.create_investigation("c", OWNER)
    row = store.add_investigation_child(
        table, investigation_id=inv.id, **CHILD_FIELDS[table]
    )
    assert store.get_investigation_child(table, row.id) is row
    assert store.list_investigation_children(table, inv.id) == [row]

    field = next(iter(CHILD_FIELDS[table]))
    store.update_investigation_child(table, row.id, **{field: "changed"})
    assert getattr(row, field) == "changed"

    other = store.add_investigation_child(
        table, investigation_id=inv.id, **CHILD_FIELDS[table]
    )
    assert store.delete_investigation_child(table, other.id)
    store.delete_investigation(inv.id)
    assert store.get_investigation_child(table, row.id) is None


def test_deleting_an_exploration_nulls_the_source():
    store = InMemoryStore()
    ctx = store.create_graph_context("t", "e", "n", OWNER)
    exp = store.create_exploration(ctx.id, "x", OWNER, {})
    inv = store.create_investigation("c", OWNER)
    source = store.add_investigation_child(
        "investigation_sources",
        investigation_id=inv.id,
        exploration_id=exp.id,
        context_id=ctx.id,
        **CHILD_FIELDS["investigation_sources"],
    )
    store.delete_exploration(exp.id)
    assert source.exploration_id is None
    assert source.context_id == ctx.id


def test_context_has_investigation_columns():
    ctx = InMemoryStore().create_graph_context("t", "e", "n", OWNER)
    assert (ctx.identity_keys, ctx.enrichment_tables, ctx.edge_semantics) == (
        [],
        [],
        {},
    )
