"""Declared URL parameters: registration-time validation and request coercion.

These values reach SQL written by whoever registered the provider, so the point
of every test here is the same: nothing undeclared, untyped or unbounded gets
through, and nothing is decided by luck.
"""

import pytest

from graphlagoon.services.precomputed.params import (
    MAX_PARAMS,
    MAX_PARAMS_BYTES,
    ParamError,
    ParamSpec,
    coerce_params,
    validate_param_specs,
)

OWNER = "owner@example.com"


def _coerce(specs, **kwargs):
    return coerce_params(specs, list(kwargs.items()))


class TestStrings:
    def test_a_string_passes_through_unchanged(self):
        spec = [ParamSpec("seed", "str")]
        assert _coerce(spec, seed="  odd/value&here ") == {
            "seed": "  odd/value&here "
        }

    def test_max_length_is_enforced(self):
        spec = [ParamSpec("seed", "str", max_length=4)]
        assert _coerce(spec, seed="abcd") == {"seed": "abcd"}
        with pytest.raises(ParamError) as exc:
            _coerce(spec, seed="abcde")
        assert exc.value.code == "INVALID_PARAM"
        assert exc.value.param == "seed"

    def test_choices_are_an_allowlist(self):
        spec = [ParamSpec("edge_type", "str", choices=["transfer", "device"])]
        assert _coerce(spec, edge_type="device") == {"edge_type": "device"}
        with pytest.raises(ParamError, match="must be one of"):
            _coerce(spec, edge_type="DEVICE")

    def test_choices_reject_an_injection_attempt_verbatim(self):
        """The reason `choices` exists: a value in identifier position."""
        spec = [ParamSpec("table", "str", choices=["edges"])]
        with pytest.raises(ParamError):
            _coerce(spec, table="edges; DROP TABLE users--")


class TestIntegers:
    @pytest.mark.parametrize("raw", ["0", "7", "-3", "1000000"])
    def test_accepts_plain_decimals(self, raw):
        assert _coerce([ParamSpec("hops", "int")], hops=raw) == {"hops": int(raw)}

    @pytest.mark.parametrize(
        "raw",
        ["1e5", "0x10", "+1", " 1", "1 ", "1.0", "NaN", "Infinity", "", "one", "1_000"],
    )
    def test_rejects_anything_that_is_not_a_plain_decimal(self, raw):
        """Strictness mirrors parseStrictNumber in the frontend: a number that
        parses differently in Python and JavaScript is a bug generator."""
        with pytest.raises(ParamError) as exc:
            _coerce([ParamSpec("hops", "int")], hops=raw)
        assert exc.value.code == "INVALID_PARAM"

    def test_bounds_are_enforced_in_both_directions(self):
        spec = [ParamSpec("hops", "int", min=1, max=4)]
        assert _coerce(spec, hops="4") == {"hops": 4}
        with pytest.raises(ParamError, match="below the minimum"):
            _coerce(spec, hops="0")
        with pytest.raises(ParamError, match="above the maximum"):
            _coerce(spec, hops="5")

    def test_a_bare_int_is_unbounded_and_that_is_the_authors_problem(self):
        """No implicit ceiling: min/max are opt-in, and the security contract
        says so out loud rather than inventing a limit that would surprise."""
        assert _coerce([ParamSpec("n", "int")], n="999999999") == {"n": 999999999}


class TestFloats:
    def test_accepts_decimals(self):
        assert _coerce([ParamSpec("t", "float")], t="1.5") == {"t": 1.5}
        assert _coerce([ParamSpec("t", "float")], t="-2") == {"t": -2.0}

    @pytest.mark.parametrize("raw", ["NaN", "Infinity", "-Infinity", "1e3", ".5"])
    def test_rejects_the_special_values(self, raw):
        with pytest.raises(ParamError):
            _coerce([ParamSpec("t", "float")], t=raw)


class TestBooleans:
    @pytest.mark.parametrize(
        "raw,expected",
        [("true", True), ("TRUE", True), ("1", True), ("false", False), ("0", False)],
    )
    def test_accepts_exactly_four_literals_case_insensitively(self, raw, expected):
        assert _coerce([ParamSpec("f", "bool")], f=raw) == {"f": expected}

    @pytest.mark.parametrize("raw", ["yes", "no", "2", "on", "", "True "])
    def test_rejects_everything_else(self, raw):
        with pytest.raises(ParamError, match="true or false"):
            _coerce([ParamSpec("f", "bool")], f=raw)


class TestRequiredAndDefaults:
    def test_a_missing_required_param_is_an_error(self):
        with pytest.raises(ParamError) as exc:
            _coerce([ParamSpec("seed", "str", required=True)])
        assert exc.value.code == "MISSING_PARAM"

    def test_an_empty_required_param_counts_as_missing(self):
        with pytest.raises(ParamError) as exc:
            _coerce([ParamSpec("seed", "str", required=True)], seed="")
        assert exc.value.code == "MISSING_PARAM"

    def test_an_empty_optional_string_is_a_legitimate_value(self):
        assert _coerce([ParamSpec("q", "str")], q="") == {"q": ""}

    def test_a_default_fills_in_only_when_absent(self):
        spec = [ParamSpec("hops", "int", default=2)]
        assert _coerce(spec) == {"hops": 2}
        assert _coerce(spec, hops="3") == {"hops": 3}

    def test_an_optional_param_with_no_default_resolves_to_none(self):
        assert _coerce([ParamSpec("q", "str")]) == {"q": None}

    def test_every_declared_name_is_always_present_in_the_result(self):
        """`resolve` can index params directly; it never has to use .get()."""
        specs = [
            ParamSpec("a", "str"),
            ParamSpec("b", "int", default=1),
            ParamSpec("c", "bool"),
        ]
        assert set(_coerce(specs, a="x")) == {"a", "b", "c"}


class TestUnknownAndDuplicate:
    def test_an_undeclared_param_is_rejected_and_the_message_lists_the_real_ones(self):
        with pytest.raises(ParamError) as exc:
            _coerce([ParamSpec("seed", "str"), ParamSpec("hops", "int")], sed="1")
        assert exc.value.code == "UNKNOWN_PARAM"
        assert exc.value.details["declared"] == ["hops", "seed"]

    def test_a_provider_with_no_params_rejects_every_param(self):
        with pytest.raises(ParamError, match="no parameters"):
            _coerce([], anything="1")

    def test_a_repeated_param_is_rejected_rather_than_last_wins(self):
        """dict(request.query_params) would silently pick the last value. A
        security-relevant value decided by luck is the failure mode this
        prevents."""
        with pytest.raises(ParamError) as exc:
            coerce_params(
                [ParamSpec("seed", "str")], [("seed", "safe"), ("seed", "evil")]
            )
        assert exc.value.code == "DUPLICATE_PARAM"


class TestCheapCeilings:
    def test_too_many_params_fails_before_any_coercion(self):
        specs = [ParamSpec(f"p{i}", "str") for i in range(MAX_PARAMS + 5)]
        items = [(f"p{i}", "x") for i in range(MAX_PARAMS + 1)]
        with pytest.raises(ParamError) as exc:
            coerce_params(specs, items)
        assert exc.value.code == "TOO_MANY_PARAMS"

    def test_an_oversized_query_string_fails_before_any_coercion(self):
        with pytest.raises(ParamError) as exc:
            coerce_params(
                [ParamSpec("blob", "str")], [("blob", "x" * (MAX_PARAMS_BYTES + 1))]
            )
        assert exc.value.code == "PARAMS_TOO_LARGE"


class TestRegistrationValidation:
    """Failing at app construction, not at 3am on a user's request."""

    def test_duplicate_names_are_rejected(self):
        with pytest.raises(ValueError, match="declared twice"):
            validate_param_specs(
                [ParamSpec("seed", "str"), ParamSpec("seed", "int")], owner="p"
            )

    def test_an_unknown_type_is_rejected(self):
        with pytest.raises(ValueError, match="unknown type"):
            validate_param_specs([ParamSpec("seed", "uuid")], owner="p")

    def test_choices_on_a_number_are_rejected(self):
        with pytest.raises(ValueError, match="only meaningful for type='str'"):
            validate_param_specs(
                [ParamSpec("hops", "int", choices=["1", "2"])], owner="p"
            )

    def test_empty_choices_are_rejected(self):
        with pytest.raises(ValueError, match="no value could pass"):
            validate_param_specs([ParamSpec("k", "str", choices=[])], owner="p")

    def test_min_above_max_is_rejected(self):
        with pytest.raises(ValueError, match="is above max"):
            validate_param_specs([ParamSpec("h", "int", min=5, max=2)], owner="p")

    def test_bounds_on_a_string_are_rejected(self):
        with pytest.raises(ValueError, match="only apply to numeric types"):
            validate_param_specs([ParamSpec("s", "str", min=1)], owner="p")

    def test_a_default_that_fails_its_own_spec_is_rejected(self):
        with pytest.raises(ValueError, match="fails its own spec"):
            validate_param_specs(
                [ParamSpec("h", "int", default=9, min=1, max=4)], owner="p"
            )

    def test_a_default_of_the_wrong_type_is_rejected(self):
        with pytest.raises(ValueError, match="is not a int"):
            validate_param_specs([ParamSpec("h", "int", default="2")], owner="p")

    def test_a_bool_default_is_not_accepted_as_an_int(self):
        """isinstance(True, int) is True in Python; an unguarded check would let
        default=True pass as an int."""
        with pytest.raises(ValueError, match="is not a int"):
            validate_param_specs([ParamSpec("h", "int", default=True)], owner="p")

    def test_a_required_param_cannot_also_carry_a_default(self):
        with pytest.raises(ValueError, match="cannot also carry a default"):
            validate_param_specs(
                [ParamSpec("s", "str", required=True, default="x")], owner="p"
            )

    @pytest.mark.parametrize(
        "name", ["precomputed", "style", "exploration", "layout", "layoutMode"]
    )
    def test_reserved_names_are_rejected(self, name):
        """The frontend never forwards these, so such a param could never be
        filled. Better to say so at startup than to debug an always-None value."""
        with pytest.raises(ValueError, match="reserved query key"):
            validate_param_specs([ParamSpec(name, "str")], owner="p")

    @pytest.mark.parametrize("name", ["", "1seed", "se ed", "se-ed", "__proto__"])
    def test_malformed_names_are_rejected(self, name):
        with pytest.raises(ValueError, match="invalid param name"):
            validate_param_specs([ParamSpec(name, "str")], owner="p")

    def test_a_non_paramspec_is_rejected(self):
        with pytest.raises(ValueError, match="must be ParamSpec instances"):
            validate_param_specs([{"name": "seed"}], owner="p")


class TestTypesReachingResolve:
    def test_the_dict_holds_real_python_types_not_strings(self):
        specs = [
            ParamSpec("seed", "str"),
            ParamSpec("hops", "int"),
            ParamSpec("ratio", "float"),
            ParamSpec("deep", "bool"),
        ]
        params = _coerce(specs, seed="a", hops="3", ratio="0.5", deep="true")
        assert isinstance(params["seed"], str)
        assert isinstance(params["hops"], int) and not isinstance(params["hops"], bool)
        assert isinstance(params["ratio"], float)
        assert isinstance(params["deep"], bool)
