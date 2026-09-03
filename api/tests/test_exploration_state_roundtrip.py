"""ExplorationState must round-trip frontend fields through model_dump().

The explorations router validates incoming state with ExplorationState and
stores `model_dump()`. Before extra="allow" was added, any field the model
did not declare was silently dropped on save — cte_fallback_enabled and
cte_fallback_silent were being lost exactly that way. These tests pin both
the declared new fields and the survival of unknown future ones.
"""

from graphlagoon.models.schemas import ExplorationState


def test_declared_display_fields_round_trip():
    state = ExplorationState(
        visual_mapping={"nodeSize": {"metricId": "pagerank"}},
        property_visibility={"nodeProperties": ["name"], "edgeProperties": None},
        cte_fallback_enabled=False,
        cte_fallback_silent=False,
    )

    dumped = state.model_dump()

    assert dumped["visual_mapping"] == {"nodeSize": {"metricId": "pagerank"}}
    assert dumped["property_visibility"] == {
        "nodeProperties": ["name"],
        "edgeProperties": None,
    }
    assert dumped["cte_fallback_enabled"] is False
    assert dumped["cte_fallback_silent"] is False


def test_unknown_future_fields_survive_the_round_trip():
    state = ExplorationState(**{"some_future_field": {"x": 1}})
    assert state.model_dump()["some_future_field"] == {"x": 1}


def test_behaviors_still_round_trip():
    state = ExplorationState(behaviors={"focusDepth": 3})
    assert state.model_dump()["behaviors"] == {"focusDepth": 3}


def test_tooltip_templates_round_trip():
    """Tooltip templates live inside the *typed* TextFormatDefaults model.

    Unlike style presets (whose textFormat is a bare dict), an exploration's
    textFormat is validated field by field, so a template the model does not
    declare would be dropped on save.
    """
    state = ExplorationState(
        textFormat={
            "rules": [],
            "defaults": {
                "nodeTemplate": "{node_id}",
                "edgeTemplate": "{relationship_type}",
                "nodeTooltipTemplate": "{prop:name}{br}{prop:email}",
                "edgeTooltipTemplate": "{src} -> {dst}",
            },
            "syntaxVersion": 2,
        }
    )

    defaults = state.model_dump()["textFormat"]["defaults"]

    assert defaults["nodeTooltipTemplate"] == "{prop:name}{br}{prop:email}"
    assert defaults["edgeTooltipTemplate"] == "{src} -> {dst}"


def test_tooltip_templates_default_to_empty_for_pre_feature_state():
    """State saved before the feature has no tooltip keys; "" is the stock look."""
    state = ExplorationState(
        textFormat={
            "rules": [],
            "defaults": {"nodeTemplate": "{node_id}", "edgeTemplate": "{relationship_type}"},
        }
    )

    defaults = state.model_dump()["textFormat"]["defaults"]

    assert defaults["nodeTooltipTemplate"] == ""
    assert defaults["edgeTooltipTemplate"] == ""


def test_rule_surface_round_trips():
    """A rule's surface (label/tooltip/both) survives the save round-trip."""
    state = ExplorationState(
        textFormat={
            "rules": [
                {
                    "id": "r1",
                    "name": "Person tooltips",
                    "target": "node",
                    "types": ["Person"],
                    "template": "{prop:name}",
                    "priority": 10,
                    "enabled": True,
                    "scope": "exploration",
                    "surface": "tooltip",
                },
                # A rule saved before surfaces existed.
                {
                    "id": "r2",
                    "name": "Old rule",
                    "target": "node",
                    "types": [],
                    "template": "{node_id}",
                    "priority": 5,
                    "enabled": True,
                    "scope": "exploration",
                },
            ],
            "defaults": {"nodeTemplate": "{node_id}", "edgeTemplate": "{relationship_type}"},
        }
    )

    rules = state.model_dump()["textFormat"]["rules"]

    assert rules[0]["surface"] == "tooltip"
    assert rules[1]["surface"] == "label"
