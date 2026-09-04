"""The fixed catalog of app-level permissions.

Groups & permission rules (``services.permissions``) govern *who* may perform
an action; this module is the single source of truth for *which* actions are
governable. Adding a permission is deliberately a two-line change:

1. add a ``Permission`` entry here;
2. put ``Depends(require_permission("<id>"))`` on the route it protects
   (and hide the matching frontend affordance behind ``can('<id>')``).

``tests/test_admin_registry.py`` fails the build when a
``require_permission("...")`` literal in a router references an id that is
not in this catalog — a rule with no catalog entry would be dead
configuration, and a catalog entry with no gate would be security theater.

Ids follow the ``AuditAction`` shape (``<resource>.<verb>``, exactly one
dot). Permissions default to "everyone" until an admin writes a rule, so a
new catalog entry never changes behavior on upgrade.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Permission:
    id: str
    label: str  # shown in 403 messages and in the admin matrix
    description: str


PERMISSIONS: tuple[Permission, ...] = (
    Permission(
        id="context.create",
        label="Create graph contexts",
        description=(
            "Create new graph contexts from warehouse tables. Also gates "
            "browsing the warehouse catalog (the authoring surface), and "
            "widens query scope: holders may read any table in the "
            "configured catalog.schema allowlist, while everyone else is "
            "restricted to the tables of the context they have open."
        ),
    ),
    Permission(
        id="exploration.save",
        label="Save explorations",
        description=(
            "Save or update explorations. Exploring and querying stay open — "
            "this only gates persisting the result."
        ),
    ),
)

PERMISSION_IDS: frozenset[str] = frozenset(p.id for p in PERMISSIONS)

_BY_ID: dict[str, Permission] = {p.id: p for p in PERMISSIONS}


def get_permission(perm_id: str) -> Permission:
    """The catalog entry for ``perm_id``; raises ``KeyError`` for unknown ids
    so a typo in a ``require_permission(...)`` call fails at import time."""
    return _BY_ID[perm_id]
