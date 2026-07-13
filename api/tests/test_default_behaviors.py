"""Tests for server-provided frontend behavior defaults (Settings.default_behaviors)."""

import sys

# Stub gsql2rsql package tree so graphlagoon can be imported without the dep.
# gsql2rsql is optional (only needed for Cypher transpilation).
# IMPORTANT: only stub when the real package is genuinely unavailable — this file is
# collected before test_transpile_options alphabetically, so a `not in sys.modules`
# guard would stub gsql2rsql for the whole session and break that test.
try:
    import gsql2rsql  # noqa: F401
except ImportError:
    from unittest.mock import MagicMock as _MagicMock

    for _name in (
        "gsql2rsql",
        "gsql2rsql.parser",
        "gsql2rsql.parser.opencypher_parser",
        "gsql2rsql.planner",
        "gsql2rsql.planner.logical_plan",
        "gsql2rsql.planner.subquery_flattening",
        "gsql2rsql.planner.pass_manager",
        "gsql2rsql.renderer",
        "gsql2rsql.renderer.sql_renderer",
        "gsql2rsql.renderer.schema_provider",
        "gsql2rsql.common",
        "gsql2rsql.common.schema",
    ):
        sys.modules[_name] = _MagicMock()

from graphlagoon.config import Settings  # noqa: E402


class TestDefaultBehaviorsDict:
    def test_unset_returns_empty_dict(self):
        """Without the env var, no defaults are injected and the frontend uses its own."""
        settings = Settings()
        assert settings.default_behaviors_dict == {}

    def test_parses_a_json_object(self):
        settings = Settings(default_behaviors='{"mapStylePan": false}')
        assert settings.default_behaviors_dict == {"mapStylePan": False}

    def test_preserves_value_types(self):
        """bool/str/number must survive as JSON types — the frontend type-checks each key."""
        settings = Settings(
            default_behaviors=(
                '{"mapStylePan": false, "viewMode": "3d", "labelDensity": 2.5}'
            )
        )
        assert settings.default_behaviors_dict == {
            "mapStylePan": False,
            "viewMode": "3d",
            "labelDensity": 2.5,
        }

    def test_passes_unknown_keys_through_opaquely(self):
        """The backend must not gatekeep the shape — the frontend owns validation.

        This is what lets a new frontend behavior ship without a backend change.
        """
        settings = Settings(default_behaviors='{"someFutureBehavior": true}')
        assert settings.default_behaviors_dict == {"someFutureBehavior": True}

    def test_empty_string_returns_empty_dict(self):
        settings = Settings(default_behaviors="")
        assert settings.default_behaviors_dict == {}

    def test_malformed_json_is_ignored_not_fatal(self):
        """A typo in the operator's env var must not take the app down."""
        settings = Settings(default_behaviors="{not valid json")
        assert settings.default_behaviors_dict == {}

    def test_non_object_json_is_ignored(self):
        """Valid JSON that isn't an object (list, scalar) is rejected, not returned."""
        assert Settings(default_behaviors="[1, 2, 3]").default_behaviors_dict == {}
        assert Settings(default_behaviors='"a string"').default_behaviors_dict == {}
        assert Settings(default_behaviors="42").default_behaviors_dict == {}

    def test_json_null_is_ignored(self):
        settings = Settings(default_behaviors="null")
        assert settings.default_behaviors_dict == {}


class TestConfigInjection:
    """The two config producers must agree, or the feature works in prod but not dev."""

    def test_api_config_route_includes_default_behaviors(self):
        """GET /api/config is what `npm run dev` reads (no Jinja template there)."""
        import inspect

        from graphlagoon.routers import config as config_router

        source = inspect.getsource(config_router.get_config)
        assert "default_behaviors" in source

    def test_spa_template_config_includes_default_behaviors(self):
        """render_spa builds the window.__GRAPH_LAGOON_CONFIG__ dict for the built app."""
        import inspect

        from graphlagoon import app as app_module

        source = inspect.getsource(app_module.create_frontend_router)
        assert "default_behaviors" in source
