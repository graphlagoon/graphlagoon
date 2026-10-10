"""Masking of personal data for agents (05 §6): CPF/CNPJ anywhere in a string,
account-like fields, and a case's identity values (``secrets``). Applied in
the MCP tools and, through ``agent_view``, in the REST handlers an agent may
read. Unmasked only when the org allows it AND the token is marked."""

from __future__ import annotations

import json
import re
from typing import Any

from graphlagoon.middleware.auth import get_current_actor

# File types an agent may read as (masked) text; anything else stays binary.
TEXT_EXTENSIONS = frozenset({"md", "txt", "csv", "json", "html", "svg"})

_CNPJ = re.compile(
    r"(?<![0-9A-Za-z])(\d{2})\.?(\d{3})\.?(\d{3})/?(\d{4})-?(\d{2})(?![0-9A-Za-z])"
)
_CPF = re.compile(r"(?<![0-9A-Za-z])(\d{3})\.?(\d{3})\.?(\d{3})-?(\d{2})(?![0-9A-Za-z])")
_ACCOUNT_KEY = re.compile(r"conta|account|acct|ag[eê]ncia|agency|iban", re.I)


def _mask_digits(value: str) -> str:
    """Every digit but the last two becomes ``*``."""
    return re.sub(r"\d(?=(?:\D*\d){2})", "*", value)


def mask_text(text: str, secrets: frozenset = frozenset()) -> str:
    for secret in secrets:
        text = text.replace(secret, _mask_digits(secret))
    text = _CNPJ.sub(lambda m: f"**.{m[2]}.{m[3]}/****-**", text)
    return _CPF.sub(lambda m: f"***.{m[2]}.{m[3]}-**", text)


def mask(value: Any, secrets: frozenset = frozenset()) -> Any:
    if isinstance(value, str):
        return mask_text(value, secrets)
    if isinstance(value, list):
        return [mask(v, secrets) for v in value]
    if isinstance(value, dict):
        return {
            mask_text(k, secrets): (
                _mask_digits(str(v))
                if _ACCOUNT_KEY.search(k) and isinstance(v, (str, int))
                else mask(v, secrets)
            )
            for k, v in value.items()
        }
    return value


def _masking() -> bool:
    """Whether the current agent sees data masked. ``actor["unmasked"]`` is
    already ANDed with ``settings.agents_allow_unmasked_data`` by the
    middleware; a person (no actor) is never masked here."""
    actor = get_current_actor()
    return bool(actor) and not actor.get("unmasked")


def agent_view(payload: Any, secrets: frozenset = frozenset()) -> Any:
    """``payload`` as the current actor may see it: unchanged for a person or
    an unmasked token, masked (JSON-serialisable copy) for an agent.
    shortcut: REST callers pass no case secrets, so identity values that are
    not CPF/CNPJ/account-shaped pass through; add them when F2 moves reads to
    services/cases.py."""
    if not _masking():
        return payload
    return mask(json.loads(json.dumps(payload, default=str)), secrets)
