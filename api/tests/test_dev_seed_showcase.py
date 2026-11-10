"""The showcase seed's fixed payloads fit the models the API checks them with.

The seed itself needs the Spark warehouse (it makes a random graph and reads a
subgraph), so it runs against `make dev`; here only what it sends is checked.
"""
from graphlagoon.dev import seed_showcase as showcase
from graphlagoon.models.schemas import (
    CaseViewIsolation,
    ExplorationState,
    GraphContextCreate,
    StylePresetSettings,
)


def _context(**extra):
    return GraphContextCreate(
        title="t", edge_table_name="c.s.edges", node_table_name="c.s.nodes", **extra
    )


def test_every_title_says_demo_and_the_looks_are_presets():
    from graphlagoon.services.style_presets import validate_preset_name

    for name, (description, settings) in showcase.PRESETS.items():
        validate_preset_name(name)  # a file name: the "Demo ·" title is the description
        assert description.startswith("Demo · ")
        StylePresetSettings.model_validate(settings)
    StylePresetSettings.model_validate(showcase.DEFAULT_LOOK)
    StylePresetSettings.model_validate(showcase.IMPORTABLE_LOOK)
    assert all(p["program_name"].startswith("Demo · ") for p in showcase.CLUSTER_PROGRAMS)
    assert all(a["label"].startswith("Demo · ") for a in showcase.MENU_ACTIONS)


def test_the_context_payloads_pass_the_context_validators():
    ctx = _context(default_behaviors={**showcase.DEFAULT_BEHAVIORS, "look": showcase.DEFAULT_LOOK})
    assert ctx.default_behaviors["look"]["nodeTypeIcons"]["Person"] == "user"
    _context(cluster_programs=showcase.CLUSTER_PROGRAMS, context_menu_actions=showcase.MENU_ACTIONS)


def test_one_program_asks_for_a_value_and_one_takes_it_from_the_node():
    by_id = {p["program_id"]: p for p in showcase.CLUSTER_PROGRAMS}
    asks = by_id["demo-asks-for-a-value"]["parameters"]
    assert any(p["required"] and "default" not in p and "node_binding" not in p for p in asks)
    assert by_id["demo-same-branch"]["parameters"][0]["node_binding"] == "prop:branch"


def test_a_grouping_by_city_saves_as_communities_with_a_show_only():
    graph = {"nodes": [
        {"node_id": "a", "properties": {"city": "Lisbon"}},
        {"node_id": "b", "properties": {"city": "Berlin"}},
        {"node_id": "c", "properties": {"city": "Lisbon"}},
    ]}
    state, ids = showcase.communities_by(graph, "city")
    assert state["communityMap"] == {"a": ids["Lisbon"], "b": ids["Berlin"], "c": ids["Lisbon"]}
    assert state["communityLabels"][str(ids["Berlin"])] == "city = Berlin"
    rule = {"kind": "community", "ids": [ids["Berlin"]], "label": "city = Berlin"}
    CaseViewIsolation.model_validate(rule)
    saved = ExplorationState.model_validate({"community": state, "isolation": rule})
    assert saved.model_dump()["isolation"] == rule
