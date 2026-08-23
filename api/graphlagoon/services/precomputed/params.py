"""Declared URL parameters for precomputed graph providers.

A provider declares the parameters it accepts; this module turns the raw query
string into a validated, typed dict before ``resolve`` is ever awaited. Anything
undeclared is a 400, not a silently ignored key.

The posture here is deliberately stricter than ``layoutUrlOverrides.ts``, which
collects issues and carries on. A layout typo draws the graph slightly wrong and
the user can see it. A parameter typo would return *different data* with no
visible sign that anything was ignored, so every deviation fails the request.

Parameter values reach SQL written by the developer who registered the provider.
What this module guarantees, and what it deliberately does not, is spelled out in
the security contract in ``spec.py`` — read it before writing a provider.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Iterable, Optional, Sequence

#: The types a parameter may declare. Mirrors SimilarityEndpointParam's
#: vocabulary so both read the same, but the coercion below is this module's own
#: — similarity.py declares types and validates nothing.
PARAM_TYPES = ("str", "int", "float", "bool")

#: Query keys the frontend owns and never forwards, so a provider declaring one
#: has declared a parameter that can never be filled. Rejected at registration.
#: Mirrors `isReservedKey` in frontend/src/utils/precomputedUrlParams.ts.
RESERVED_PARAM_NAMES = frozenset({"precomputed", "style", "exploration"})
RESERVED_PARAM_PREFIX = "layout"

#: Parameter names become dict keys and appear in error messages and stored
#: payloads; keep them a tame identifier.
PARAM_NAME_RE = re.compile(r"^[a-zA-Z][a-zA-Z0-9_]{0,39}$")

#: Cheap ceilings, checked before any coercion — the same "fail before you
#: materialize it" stance `enforce_body_limit` takes for request bodies.
MAX_PARAMS = 32
MAX_PARAMS_BYTES = 4096

#: Decimal only. Rejects `0x10`, `1e5`, `+1`, `NaN`, `Infinity`, and anything
#: with surrounding whitespace — the exact doctrine of `parseStrictNumber` in
#: frontend/src/utils/layoutUrlOverrides.ts, for the same reason: a number that
#: parses one way in Python and another in JavaScript is a bug generator.
_DECIMAL_RE = re.compile(r"^-?\d+(\.\d+)?$")

_TRUE_LITERALS = frozenset({"true", "1"})
_FALSE_LITERALS = frozenset({"false", "0"})


@dataclass
class ParamSpec:
    """One URL parameter a provider accepts.

    Field names follow ``SimilarityEndpointParam`` (similarity.py) so the two
    read alike, plus the bounds that make a value safe to hand to a query:
    ``choices`` for anything landing in an identifier position, ``min``/``max``
    for anything that becomes a limit, a hop count or a window.

    ``default`` is a Python value of the declared type — ``default=2`` for an
    int, not ``default="2"``. It is validated once at registration and used
    as-is at request time, so a default never pays coercion cost per request.
    """

    name: str
    type: str = "str"
    required: bool = False
    default: Any = None
    description: str = ""
    choices: Optional[Sequence[str]] = None
    min: Optional[float] = None
    max: Optional[float] = None
    max_length: int = 256

    def ui_payload(self) -> dict[str, Any]:
        """The frontend-facing description of this parameter."""
        return {
            "name": self.name,
            "type": self.type,
            "required": self.required,
            "default": self.default,
            "description": self.description,
            "choices": list(self.choices) if self.choices is not None else None,
            "min": self.min,
            "max": self.max,
        }


class ParamError(ValueError):
    """A request whose parameters do not satisfy the declared specs.

    Carries the structured pieces the router turns into an error body, so the
    message a user sees names the offending parameter rather than saying "bad
    request".
    """

    def __init__(
        self,
        code: str,
        message: str,
        *,
        param: Optional[str] = None,
        details: Optional[dict] = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.param = param
        self.details = {**(details or {})}
        if param is not None:
            self.details.setdefault("param", param)


# ---------------------------------------------------------------------------
# Registration-time validation
# ---------------------------------------------------------------------------


def validate_param_specs(specs: Sequence[ParamSpec], *, owner: str) -> None:
    """Reject malformed parameter declarations at app construction.

    Failing here means the developer sees the error on startup rather than the
    first user seeing it at query time — the same reason `validate_spec` exists
    for REST connections.
    """
    seen: set[str] = set()
    for spec in specs:
        if not isinstance(spec, ParamSpec):
            raise ValueError(
                f"{owner}: params must be ParamSpec instances, got {type(spec).__name__}"
            )
        _validate_one_spec(spec, owner=owner, seen=seen)


def _validate_one_spec(spec: ParamSpec, *, owner: str, seen: set[str]) -> None:
    where = f"{owner}: param '{spec.name}'"

    if not PARAM_NAME_RE.match(spec.name or ""):
        raise ValueError(
            f"{owner}: invalid param name {spec.name!r}; must match "
            f"{PARAM_NAME_RE.pattern}"
        )
    if spec.name in seen:
        raise ValueError(f"{owner}: param '{spec.name}' is declared twice")
    seen.add(spec.name)

    if spec.name in RESERVED_PARAM_NAMES or spec.name.startswith(RESERVED_PARAM_PREFIX):
        raise ValueError(
            f"{where} is a reserved query key. The frontend never forwards "
            f"{sorted(RESERVED_PARAM_NAMES)} or anything starting with "
            f"'{RESERVED_PARAM_PREFIX}', so this parameter could never be filled."
        )

    if spec.type not in PARAM_TYPES:
        raise ValueError(
            f"{where}: unknown type {spec.type!r}; expected one of {list(PARAM_TYPES)}"
        )

    if spec.choices is not None:
        if spec.type != "str":
            raise ValueError(
                f"{where}: choices are only meaningful for type='str', not "
                f"{spec.type!r}; use min/max to bound a number."
            )
        if not spec.choices:
            raise ValueError(f"{where}: choices is empty, so no value could pass")
        if not all(isinstance(choice, str) for choice in spec.choices):
            raise ValueError(f"{where}: every choice must be a string")

    if spec.type in ("int", "float"):
        if spec.min is not None and spec.max is not None and spec.min > spec.max:
            raise ValueError(f"{where}: min ({spec.min}) is above max ({spec.max})")
    elif spec.min is not None or spec.max is not None:
        raise ValueError(
            f"{where}: min/max only apply to numeric types, not {spec.type!r}"
        )

    if spec.type == "str" and spec.max_length <= 0:
        raise ValueError(f"{where}: max_length must be positive")

    if spec.required and spec.default is not None:
        raise ValueError(
            f"{where}: a required param cannot also carry a default — the "
            "default would be unreachable."
        )

    if spec.default is not None:
        if not _matches_declared_type(spec, spec.default):
            raise ValueError(
                f"{where}: default {spec.default!r} is not a {spec.type}"
            )
        try:
            _check_bounds(spec, spec.default)
        except ParamError as exc:
            raise ValueError(f"{where}: default fails its own spec — {exc}") from exc


def _matches_declared_type(spec: ParamSpec, value: Any) -> bool:
    # bool before int: isinstance(True, int) is True in Python, so an unguarded
    # int check would accept True as a valid int default.
    if spec.type == "bool":
        return isinstance(value, bool)
    if spec.type == "int":
        return isinstance(value, int) and not isinstance(value, bool)
    if spec.type == "float":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    return isinstance(value, str)


# ---------------------------------------------------------------------------
# Request-time coercion
# ---------------------------------------------------------------------------


def coerce_params(
    specs: Sequence[ParamSpec],
    items: Iterable[tuple[str, str]],
) -> dict[str, Any]:
    """Turn raw query-string pairs into a validated dict of declared params.

    `items` must be the *multi* items of the query string
    (``request.query_params.multi_items()``), not ``dict(request.query_params)``:
    the dict form silently keeps the last value of a repeated key, and a
    security-relevant value decided by luck is exactly the failure mode this
    layer exists to prevent.

    Raises ParamError; never returns a partially-validated dict.
    """
    pairs = list(items)

    if len(pairs) > MAX_PARAMS:
        raise ParamError(
            "TOO_MANY_PARAMS",
            f"{len(pairs)} query parameters supplied, above the {MAX_PARAMS} limit.",
        )
    size = sum(len(key) + len(value) for key, value in pairs)
    if size > MAX_PARAMS_BYTES:
        raise ParamError(
            "PARAMS_TOO_LARGE",
            f"Query parameters total {size} bytes, above the "
            f"{MAX_PARAMS_BYTES}-byte limit.",
        )

    by_name = {spec.name: spec for spec in specs}
    declared = sorted(by_name)

    raw: dict[str, str] = {}
    for key, value in pairs:
        spec = by_name.get(key)
        if spec is None:
            raise ParamError(
                "UNKNOWN_PARAM",
                f"Unknown parameter '{key}'. This graph accepts "
                + (f"{declared}." if declared else "no parameters."),
                param=key,
                details={"declared": declared},
            )
        if key in raw:
            raise ParamError(
                "DUPLICATE_PARAM",
                f"Parameter '{key}' is given more than once. Supply it exactly "
                "once — the server will not guess which value you meant.",
                param=key,
            )
        raw[key] = value

    resolved: dict[str, Any] = {}
    for spec in specs:
        if spec.name not in raw or (spec.required and raw[spec.name] == ""):
            if spec.required:
                raise ParamError(
                    "MISSING_PARAM",
                    f"Parameter '{spec.name}' is required.",
                    param=spec.name,
                )
            resolved[spec.name] = spec.default
            continue
        value = _coerce_one(spec, raw[spec.name])
        _check_bounds(spec, value)
        resolved[spec.name] = value

    return resolved


def _coerce_one(spec: ParamSpec, raw: str) -> Any:
    if spec.type == "str":
        return raw

    if spec.type == "bool":
        lowered = raw.lower()
        if lowered in _TRUE_LITERALS:
            return True
        if lowered in _FALSE_LITERALS:
            return False
        raise ParamError(
            "INVALID_PARAM",
            f"Parameter '{spec.name}' must be true or false (or 1/0), got {raw!r}.",
            param=spec.name,
            details={"expected": "true|false|1|0"},
        )

    if not _DECIMAL_RE.match(raw):
        raise ParamError(
            "INVALID_PARAM",
            f"Parameter '{spec.name}' must be a plain decimal {spec.type}, got "
            f"{raw!r}. Hex, exponent notation, a leading '+', and padding spaces "
            "are all rejected.",
            param=spec.name,
            details={"expected": spec.type},
        )
    if spec.type == "int":
        if "." in raw:
            raise ParamError(
                "INVALID_PARAM",
                f"Parameter '{spec.name}' must be a whole number, got {raw!r}.",
                param=spec.name,
                details={"expected": "int"},
            )
        return int(raw)
    return float(raw)


def _check_bounds(spec: ParamSpec, value: Any) -> None:
    """Apply choices / min / max / max_length to an already-typed value."""
    if spec.type == "str":
        if len(value) > spec.max_length:
            raise ParamError(
                "INVALID_PARAM",
                f"Parameter '{spec.name}' is {len(value)} characters, above the "
                f"{spec.max_length}-character limit.",
                param=spec.name,
            )
        if spec.choices is not None and value not in spec.choices:
            raise ParamError(
                "INVALID_PARAM",
                f"Parameter '{spec.name}' must be one of {list(spec.choices)}, "
                f"got {value!r}.",
                param=spec.name,
                details={"choices": list(spec.choices)},
            )
        return

    if spec.type == "bool":
        return

    if spec.min is not None and value < spec.min:
        raise ParamError(
            "INVALID_PARAM",
            f"Parameter '{spec.name}' is {value}, below the minimum {spec.min}.",
            param=spec.name,
            details={"min": spec.min, "max": spec.max},
        )
    if spec.max is not None and value > spec.max:
        raise ParamError(
            "INVALID_PARAM",
            f"Parameter '{spec.name}' is {value}, above the maximum {spec.max}.",
            param=spec.name,
            details={"min": spec.min, "max": spec.max},
        )


__all__ = [
    "MAX_PARAMS",
    "MAX_PARAMS_BYTES",
    "PARAM_TYPES",
    "RESERVED_PARAM_NAMES",
    "RESERVED_PARAM_PREFIX",
    "ParamError",
    "ParamSpec",
    "coerce_params",
    "validate_param_specs",
]