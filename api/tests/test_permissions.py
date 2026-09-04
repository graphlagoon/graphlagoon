"""Permission evaluation core, group membership, and the SCIM resolver.

Route-level enforcement lives in test_permission_routes.py; the admin API in
test_admin_groups.py. Everything here runs against the in-memory store.
"""

import asyncio
import time
from uuid import uuid4

import httpx
import pytest

from graphlagoon.db.memory_store import InMemoryStore, get_memory_store
from graphlagoon.services.group_resolution import (
    DatabricksScimResolver,
    StubGroupResolver,
    set_group_resolver,
)
from graphlagoon.services.permissions import (
    Decision,
    check_permission,
    effective_permissions,
    evaluate,
    inspect_user,
    user_member_group_ids,
)


@pytest.fixture(autouse=True)
def fresh_store():
    InMemoryStore.reset()
    set_group_resolver(StubGroupResolver())
    yield get_memory_store()
    InMemoryStore.reset()
    set_group_resolver(StubGroupResolver())


G1 = uuid4()
G2 = uuid4()


class TestEvaluate:
    """The pure decision core, one row per rule of the documented order."""

    def test_superuser_beats_deny(self):
        decision = evaluate(
            superuser=True,
            mode="restricted",
            rules=[(G1, "deny")],
            member_group_ids={G1},
        )
        assert decision == Decision(allowed=True, reason="superuser")

    def test_deny_beats_allow_across_groups(self):
        decision = evaluate(
            superuser=False,
            mode="restricted",
            rules=[(G1, "allow"), (G2, "deny")],
            member_group_ids={G1, G2},
        )
        assert not decision.allowed
        assert decision.reason == "deny_rule"
        assert decision.group_id == G2

    def test_deny_applies_even_in_everyone_mode(self):
        decision = evaluate(
            superuser=False,
            mode="everyone",
            rules=[(G1, "deny")],
            member_group_ids={G1},
        )
        assert not decision.allowed
        assert decision.reason == "deny_rule"

    def test_restricted_with_allow_match(self):
        decision = evaluate(
            superuser=False,
            mode="restricted",
            rules=[(G1, "allow")],
            member_group_ids={G1},
        )
        assert decision.allowed
        assert decision.reason == "allow_rule"
        assert decision.group_id == G1

    def test_restricted_without_match_denies(self):
        decision = evaluate(
            superuser=False,
            mode="restricted",
            rules=[(G1, "allow")],
            member_group_ids=set(),
        )
        assert not decision.allowed
        assert decision.reason == "restricted_no_match"

    def test_default_everyone_allows(self):
        decision = evaluate(
            superuser=False, mode="everyone", rules=[], member_group_ids=set()
        )
        assert decision.allowed
        assert decision.reason == "mode_everyone"


class TestMembership:
    def test_email_member_matches_case_insensitively(self, fresh_store):
        group = fresh_store.create_group(
            "g", members=[{"kind": "email", "value": "ana@corp.com"}]
        )
        ids = asyncio.run(user_member_group_ids("Ana@Corp.COM"))
        assert ids == {group.id}

    def test_databricks_member_matches_via_resolver(self, fresh_store):
        group = fresh_store.create_group(
            "g", members=[{"kind": "databricks_group", "value": "data-analysts"}]
        )
        set_group_resolver(
            StubGroupResolver({"ana@corp.com": frozenset({"data-analysts"})})
        )
        ids = asyncio.run(user_member_group_ids("ana@corp.com"))
        assert ids == {group.id}

    def test_both_kinds_union(self, fresh_store):
        by_email = fresh_store.create_group(
            "a", members=[{"kind": "email", "value": "ana@corp.com"}]
        )
        by_databricks = fresh_store.create_group(
            "b", members=[{"kind": "databricks_group", "value": "eng"}]
        )
        set_group_resolver(StubGroupResolver({"ana@corp.com": frozenset({"eng"})}))
        ids = asyncio.run(user_member_group_ids("ana@corp.com"))
        assert ids == {by_email.id, by_databricks.id}

    def test_resolver_not_called_without_databricks_members(self, fresh_store):
        fresh_store.create_group(
            "g", members=[{"kind": "email", "value": "ana@corp.com"}]
        )
        stub = StubGroupResolver()
        set_group_resolver(stub)
        asyncio.run(user_member_group_ids("ana@corp.com"))
        assert stub.calls == []


class TestCheckPermission:
    def test_default_posture_allows_without_group_io(self, fresh_store):
        """No rows ⇒ allow, and neither groups nor SCIM are consulted."""
        stub = StubGroupResolver()
        set_group_resolver(stub)
        decision = asyncio.run(check_permission("x@y.co", "context.create"))
        assert decision.allowed and decision.reason == "mode_everyone"
        assert stub.calls == []

    def test_restricted_permission(self, fresh_store):
        group = fresh_store.create_group(
            "builders", members=[{"kind": "email", "value": "ana@corp.com"}]
        )
        fresh_store.set_permission(
            "context.create", "restricted", [{"group_id": group.id, "effect": "allow"}]
        )
        assert asyncio.run(check_permission("ana@corp.com", "context.create")).allowed
        outsider = asyncio.run(check_permission("bob@corp.com", "context.create"))
        assert not outsider.allowed and outsider.reason == "restricted_no_match"

    def test_effective_permissions_reflect_rules(self, fresh_store):
        group = fresh_store.create_group(
            "banned", members=[{"kind": "email", "value": "bob@corp.com"}]
        )
        fresh_store.set_permission(
            "exploration.save", "everyone", [{"group_id": group.id, "effect": "deny"}]
        )
        assert asyncio.run(effective_permissions("ana@corp.com")) == [
            "context.create",
            "exploration.save",
        ]
        assert asyncio.run(effective_permissions("bob@corp.com")) == ["context.create"]

    def test_inspect_names_the_matched_rule(self, fresh_store):
        group = fresh_store.create_group(
            "banned", members=[{"kind": "email", "value": "bob@corp.com"}]
        )
        fresh_store.set_permission(
            "context.create", "everyone", [{"group_id": group.id, "effect": "deny"}]
        )
        report = asyncio.run(inspect_user("bob@corp.com"))
        entry = next(p for p in report["permissions"] if p["id"] == "context.create")
        assert entry["allowed"] is False
        assert entry["reason"] == "deny_rule"
        assert entry["matched"]["group_name"] == "banned"
        assert report["group_memberships"][0]["via"] == "email"


def _scim_payload(*names: str) -> dict:
    return {
        "Resources": [
            {"groups": [{"display": name, "value": "gid"} for name in names]}
        ]
    }


def _resolver_with(handler, ttl: int = 600) -> DatabricksScimResolver:
    """The real resolver (real fetch + parse) over an httpx mock transport."""
    return DatabricksScimResolver(
        base_url="https://dbx.example",
        token="pat",
        ttl_seconds=ttl,
        transport=httpx.MockTransport(handler),
    )


class TestScimResolver:
    def test_fresh_fetch_parses_display_names(self):
        def handler(request):
            assert 'userName eq "ana@corp.com"' in request.url.params["filter"]
            return httpx.Response(200, json=_scim_payload("Data-Analysts", "eng"))

        resolver = _resolver_with(handler)
        result = asyncio.run(resolver.groups_for("Ana@Corp.com"))
        assert result.names == frozenset({"data-analysts", "eng"})
        assert result.source == "fresh"
        assert result.error is None

    def test_cache_hit_within_ttl(self):
        calls = []

        def handler(request):
            calls.append(1)
            return httpx.Response(200, json=_scim_payload("eng"))

        resolver = _resolver_with(handler)
        asyncio.run(resolver.groups_for("a@b.co"))
        second = asyncio.run(resolver.groups_for("a@b.co"))
        assert len(calls) == 1
        assert second.source == "cache"

    def test_ttl_expiry_refetches(self, monkeypatch):
        calls = []

        def handler(request):
            calls.append(1)
            return httpx.Response(200, json=_scim_payload("eng"))

        resolver = _resolver_with(handler, ttl=600)
        asyncio.run(resolver.groups_for("a@b.co"))
        monkeypatch.setattr(time, "time", lambda: 10**10)
        result = asyncio.run(resolver.groups_for("a@b.co"))
        assert len(calls) == 2
        assert result.source == "fresh"

    def test_error_after_success_serves_stale(self, monkeypatch):
        state = {"fail": False}

        def handler(request):
            if state["fail"]:
                return httpx.Response(500, json={"detail": "boom"})
            return httpx.Response(200, json=_scim_payload("eng"))

        resolver = _resolver_with(handler, ttl=600)
        asyncio.run(resolver.groups_for("a@b.co"))
        state["fail"] = True
        monkeypatch.setattr(time, "time", lambda: 10**10)
        result = asyncio.run(resolver.groups_for("a@b.co"))
        assert result.names == frozenset({"eng"})
        assert result.source == "stale"
        assert result.error is not None
        assert resolver.status()["errors"][0]["email"] == "a@b.co"

    def test_error_with_cold_cache_yields_none(self):
        def handler(request):
            return httpx.Response(500, json={"detail": "boom"})

        resolver = _resolver_with(handler)
        result = asyncio.run(resolver.groups_for("a@b.co"))
        assert result.names == frozenset()
        assert result.source == "none"
        assert result.error is not None

    def test_refresh_clears_entries(self):
        calls = []

        def handler(request):
            calls.append(1)
            return httpx.Response(200, json=_scim_payload("eng"))

        resolver = _resolver_with(handler)
        asyncio.run(resolver.groups_for("a@b.co"))
        asyncio.run(resolver.refresh())
        asyncio.run(resolver.groups_for("a@b.co"))
        assert len(calls) == 2

    def test_unknown_user_resolves_to_empty(self):
        def handler(request):
            return httpx.Response(200, json={"Resources": []})

        resolver = _resolver_with(handler)
        result = asyncio.run(resolver.groups_for("ghost@b.co"))
        assert result.names == frozenset()
        assert result.source == "fresh"
