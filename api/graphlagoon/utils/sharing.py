"""Sharing utility functions: exact e-mail, domain wildcard, public and group matching.

The ``shared_with_email`` column (and ``investigation_shares.email``) holds a
*principal*, not only an e-mail: ``"*"`` (public), ``"*@domain"`` and
``"group:<uuid>"`` (an admin-managed group, ``services.groups``). Group
membership is resolved once per request by ``services.share_groups`` and kept
in a ContextVar so the sync predicates below can read it; a sentinel met
before priming never matches (fail-closed).
"""

from __future__ import annotations

import logging
from contextvars import ContextVar
from typing import Optional
from uuid import UUID

logger = logging.getLogger(__name__)

PUBLIC_SHARE_EMAIL = "*"
GROUP_SHARE_PREFIX = "group:"

# {lowercased user e-mail: frozenset of "group:<uuid>" sentinels}; None = unprimed.
_group_shares: ContextVar[Optional[dict]] = ContextVar("group_shares", default=None)


def is_group_share(value: str) -> bool:
    """Check if a share target is a group sentinel (``group:<uuid>``)."""
    return bool(value) and value.startswith(GROUP_SHARE_PREFIX)


def group_share_value(group_id: UUID | str) -> str:
    """Canonical sentinel for a group id (lowercase uuid)."""
    return f"{GROUP_SHARE_PREFIX}{UUID(str(group_id))}"


def parse_group_share(value: str) -> Optional[UUID]:
    """The group id of a sentinel, or None when it is not a well-formed one."""
    if not is_group_share(value):
        return None
    try:
        return UUID(value[len(GROUP_SHARE_PREFIX) :].strip())
    except ValueError:
        return None


def set_group_shares(user_email: str, sentinels: frozenset) -> None:
    """Remember, for this request, which group sentinels grant ``user_email``."""
    current = dict(_group_shares.get() or {})
    current[(user_email or "").strip().lower()] = frozenset(sentinels)
    _group_shares.set(current)


def current_group_shares(user_email: str) -> Optional[frozenset]:
    """The primed sentinels for ``user_email`` in this request, or None."""
    current = _group_shares.get()
    if current is None:
        return None
    return current.get((user_email or "").strip().lower())


def reset_group_shares() -> None:
    _group_shares.set(None)


def _group_shares_for(user_email: str, explicit: Optional[frozenset]) -> frozenset:
    if explicit is not None:
        return explicit
    primed = current_group_shares(user_email)
    if primed is None:
        # A predicate met a group share before the request primed membership:
        # deny (never widen access) and say so, so the missing
        # ``prime_group_shares`` call is found in development, not in production.
        logger.warning(
            "group share checked before membership was resolved for %s; denying",
            user_email,
        )
        return frozenset()
    return primed


def is_public_share(email: str) -> bool:
    """Check if an email string is the public-share sentinel ("*")."""
    return email == PUBLIC_SHARE_EMAIL


def is_domain_wildcard(email: str) -> bool:
    """Check if an email string is a domain wildcard (e.g. *@stone.com.br)."""
    return email.startswith("*@") and len(email) > 2


def extract_domain(email: str) -> str:
    """Extract domain from an email or wildcard (e.g. joao@stone.com.br -> stone.com.br)."""
    if "@" not in email:
        return ""
    return email.split("@", 1)[1].lower()


def email_matches_share(
    user_email: str,
    shared_with_email: str,
    group_shares: Optional[frozenset] = None,
) -> bool:
    """Check if a user_email matches a share entry.

    Handles exact email matches, domain wildcards, the public sentinel and
    group sentinels:
    - "joao@stone.com.br" matches "joao@stone.com.br" (exact)
    - "joao@stone.com.br" matches "*@stone.com.br" (wildcard)
    - "joao@gmail.com" does NOT match "*@stone.com.br"
    - any email matches "*" (public)
    - "group:<uuid>" matches when the user belongs to that group
      (``group_shares``, or what ``services.share_groups`` primed for this request)
    """
    if is_group_share(shared_with_email):
        return shared_with_email in _group_shares_for(user_email, group_shares)
    if is_public_share(shared_with_email):
        return True
    if shared_with_email == user_email:
        return True
    if is_domain_wildcard(shared_with_email):
        return extract_domain(shared_with_email) == extract_domain(user_email)
    return False


def user_has_share_access(user_email: str, shares: list) -> bool:
    """Check if user_email matches any share in a list of share objects.

    Each share object must have a `shared_with_email` attribute.
    """
    return any(email_matches_share(user_email, s.shared_with_email) for s in shares)


def user_has_write_access(user_email: str, shares: list) -> bool:
    """Check if user_email has write permission via any matching share.

    Public shares ("*") never grant write, even if such a row exists with
    permission "write" — public access is read-only by design.
    """
    return any(
        not is_public_share(s.shared_with_email)
        and email_matches_share(user_email, s.shared_with_email)
        and s.permission == "write"
        for s in shares
    )


def validate_share_email(
    email: str, allowed_share_domains: list[str]
) -> tuple[bool, str]:
    """Validate a share email/wildcard against allowed domains.

    Returns (is_valid, error_message).
    - The public sentinel ("*") is always valid.
    - Regular emails are always valid.
    - Wildcard emails (*@domain) require the domain to be in allowed_share_domains.
    - Group sentinels (group:<uuid>) must be well-formed; whether the group
      exists is checked by ``services.share_groups.validate_group_share_target``.
    """
    if is_public_share(email):
        return True, ""
    if is_group_share(email):
        if parse_group_share(email) is None:
            return False, f"Invalid group share target: {email}"
        return True, ""
    if is_domain_wildcard(email):
        domain = extract_domain(email)
        if not allowed_share_domains:
            return (
                False,
                "Domain wildcard sharing is not enabled. No allowed domains configured.",
            )
        allowed_lower = [d.lower() for d in allowed_share_domains]
        if domain not in allowed_lower:
            return False, (
                f"Domain '{domain}' is not in the allowed share domains: "
                f"{', '.join(allowed_share_domains)}"
            )
        return True, ""
    if "@" not in email or email.startswith("@"):
        return False, f"Invalid email format: {email}"
    return True, ""


def share_match_emails(
    user_email: str, group_shares: Optional[frozenset] = None
) -> list[str]:
    """All shared_with_email values that grant this user access.

    Covers exact match, the public sentinel, the user's domain wildcard and
    the group sentinels primed for this request (or passed explicitly).
    Used to build SQL `IN` conditions mirroring `email_matches_share`.
    """
    values = [user_email, PUBLIC_SHARE_EMAIL]
    domain = extract_domain(user_email)
    if domain:
        values.append(f"*@{domain}")
    primed = group_shares if group_shares is not None else current_group_shares(user_email)
    values.extend(sorted(primed or ()))
    return values


def validate_owner_email(email: str) -> tuple[bool, str]:
    """Validate an e-mail that will become a resource *owner*.

    Stricter than ``validate_share_email``: the public sentinel and domain
    wildcards are share targets, never owners. Ownership transfer (admin area)
    uses this so a context can never end up owned by ``*``.
    """
    if not email or not email.strip():
        return False, "Owner e-mail is required"
    candidate = email.strip()
    if is_public_share(candidate) or is_domain_wildcard(candidate) or is_group_share(candidate):
        return False, "Owner must be a single user e-mail, not a wildcard or a group"
    local, sep, domain = candidate.partition("@")
    if not sep or not local or not domain or "." not in domain or " " in candidate:
        return False, f"Invalid email format: {email}"
    return True, ""
