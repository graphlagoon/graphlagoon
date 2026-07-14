"""Authorization predicates combining ownership, shares, and superuser status.

Superusers are configured via GRAPH_LAGOON_SUPERUSER_EMAILS (comma-separated,
case-insensitive) and bypass ownership/share checks everywhere. They do NOT
bypass share-target validation (allowed_share_domains).
"""

from graphlagoon.config import get_settings
from graphlagoon.utils.sharing import user_has_share_access, user_has_write_access


def is_superuser(user_email: str) -> bool:
    """Check if user_email is in the configured superuser list (case-insensitive)."""
    if not user_email:
        return False
    return user_email.strip().lower() in get_settings().superuser_email_list


def can_manage(owner_email: str, user_email: str) -> bool:
    """Owner-level power: delete, share, unshare. Owner or superuser."""
    return owner_email == user_email or is_superuser(user_email)


def can_write(owner_email: str, shares: list, user_email: str) -> bool:
    """Write power: owner, write-share, or superuser."""
    return (
        owner_email == user_email
        or user_has_write_access(user_email, shares)
        or is_superuser(user_email)
    )


def can_read(owner_email: str, shares: list, user_email: str) -> bool:
    """Read power: owner, any share, or superuser."""
    return (
        owner_email == user_email
        or user_has_share_access(user_email, shares)
        or is_superuser(user_email)
    )
