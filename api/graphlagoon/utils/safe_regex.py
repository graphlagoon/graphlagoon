"""User-written regexes (identity keys' ``normalize: regex``) run on every node
id of a graph, in the API worker and in the browser. Python's ``re`` has no
timeout, so a pattern whose repetition nests (``(a+)+``, ``(a|aa)*``) can take
exponential time on one id and stall the worker. ``unsafe_reason`` rejects those
when the pattern is saved; ``search`` re-checks at run time (patterns stored
before the check) and bounds the input."""

from __future__ import annotations

import re
from functools import lru_cache
from typing import Optional

try:  # Python 3.11+
    import re._constants as _c  # type: ignore[import-not-found]
    import re._parser as _parser  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover
    import sre_constants as _c  # type: ignore[no-redef]
    import sre_parse as _parser  # type: ignore[no-redef]

# Node ids are identifiers; a longer value is not matched (None).
MAX_INPUT = 256

_REPEATS = {_c.MAX_REPEAT, _c.MIN_REPEAT, getattr(_c, "POSSESSIVE_REPEAT", _c.MAX_REPEAT)}


def _walk(tokens, in_repeat: bool) -> Optional[str]:
    for op, av in tokens:
        if op in _REPEATS:
            _lo, hi, sub = av
            many = hi > 1
            if in_repeat and many:
                return "a repetition inside a repetition"
            found = _walk(sub, in_repeat or many)
            if found:
                return found
        elif op == _c.SUBPATTERN:
            found = _walk(av[-1], in_repeat)
            if found:
                return found
        elif op == _c.BRANCH:
            if in_repeat:
                return "an alternation inside a repetition"
            for branch in av[1]:
                found = _walk(branch, in_repeat)
                if found:
                    return found
        elif op in (_c.ASSERT, _c.ASSERT_NOT):
            found = _walk(av[1], in_repeat)
            if found:
                return found
        elif op == getattr(_c, "ATOMIC_GROUP", None):
            found = _walk(av, in_repeat)
            if found:
                return found
        elif op in (_c.GROUPREF, getattr(_c, "GROUPREF_EXISTS", None)):
            return "a backreference"
    return None


@lru_cache(maxsize=256)
def unsafe_reason(pattern: str) -> Optional[str]:
    """Why ``pattern`` is refused (invalid, or may backtrack exponentially), or None."""
    try:
        re.compile(pattern)
        tokens = _parser.parse(pattern)
    except (re.error, RecursionError, OverflowError) as exc:
        return f"not a valid regex ({exc})"
    found = _walk(tokens, False)
    return f"{found} can take exponential time; write it without nesting" if found else None


@lru_cache(maxsize=256)
def _compiled(pattern: str) -> Optional[re.Pattern]:
    return None if unsafe_reason(pattern) else re.compile(pattern)


def search(pattern: str, value: str) -> Optional[re.Match]:
    """``re.search`` for a vetted pattern on a bounded value; None otherwise."""
    compiled = _compiled(pattern)
    if compiled is None or len(value) > MAX_INPUT:
        return None
    return compiled.search(value)
