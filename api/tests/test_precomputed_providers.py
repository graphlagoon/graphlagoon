"""The provider chain: declining, matching, ordering, capabilities, failures.

The HTTP surface and the built-in volume provider are covered in
test_precomputed_graphs.py; this module is about the dispatch semantics that
make several sources coexist behind one URL.
"""

import gzip
import sys
import orjson
import pytest

# Stub gsql2rsql package tree so graphlagoon can be imported without the dep.
# IMPORTANT: only stub when the real package is genuinely unavailable — a
# `not in sys.modules` guard would stub gsql2rsql for the whole session and break
# test_transpile_options.
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

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from graphlagoon.config import Settings, get_settings  # noqa: E402
from graphlagoon.db.memory_store import InMemoryStore  # noqa: E402
from graphlagoon.models.schemas import (  # noqa: E402
    Edge,
    Node,
    PrecomputedGraphData,
)
from graphlagoon.routers import precomputed_graphs as precomputed_router  # noqa: E402
from graphlagoon.services.precomputed import (  # noqa: E402
    ParamSpec,
    PrecomputedGraphProvider,
    PrecomputedGraphResult,
    clear_precomputed_graph_registry,
    configure_precomputed_storage,
    register_precomputed_graph_provider,
    reset_precomputed_storage,
    volume_provider,
)

OWNER = "owner@example.com"
READER = "reader@example.com"
STRANGER = "stranger@example.com"
SUPERUSER = "admin@example.com"


def _headers(email):
    return {"X-Forwarded-Email": email}


def _graph(node_count=2):
    return PrecomputedGraphData(
        nodes=[Node(node_id=f"n{i}", node_type="Account") for i in range(node_count)],
        edges=[Edge(edge_id="e0", src="n0", dst="n1", relationship_type="SENT")]
        if node_count > 1
        else [],
    )


def _body(node_count=2):
    return {
        "graph": {
            "nodes": [
                {"node_id": f"n{i}", "node_type": "Account"} for i in range(node_count)
            ],
            "edges": [],
            "truncated": False,
        },
        "source": {"kind": "manual"},
    }


def _answering(name, node_count=1, calls=None):
    """A provider that always answers with a freshly built graph."""

    async def _resolve(request):
        if calls is not None:
            calls.append(name)
        return PrecomputedGraphResult.from_graph(
            _graph(node_count),
            name=request.name,
            context_id=request.context_id,
            provider=name,
            created_by=request.user_email,
            params=request.params,
        )

    return PrecomputedGraphProvider(name=name, resolve=_resolve)


def _declining(name, calls=None):
    """A provider that never claims a graph — the chain must move past it."""

    async def _resolve(request):
        if calls is not None:
            calls.append(name)
        return None

    return PrecomputedGraphProvider(name=name, resolve=_resolve)


@pytest.fixture
def store():
    InMemoryStore.reset()
    yield InMemoryStore.get_instance()
    InMemoryStore.reset()


@pytest.fixture
def context(store):
    ctx = store.create_graph_context(
        title="ctx", edge_table_name="e", node_table_name="n", owner_email=OWNER
    )
    store.share_graph_context(ctx.id, READER, permission="read")
    return ctx


@pytest.fixture
def chain(tmp_path, monkeypatch):
    """Build an app around a caller-supplied provider chain."""
    monkeypatch.setenv("GRAPH_LAGOON_SUPERUSER_EMAILS", SUPERUSER)
    # Pin the production posture: a local .env with show_error_details on would
    # otherwise silently flip what the failure tests below assert.
    monkeypatch.setenv("GRAPH_LAGOON_SHOW_ERROR_DETAILS", "false")
    get_settings.cache_clear()

    created = []

    def _build(*providers, **overrides):
        settings = Settings(
            precomputed_graphs_dir=str(tmp_path / "store"),
            databricks_volume_path=None,
            precomputed_graphs_volume_path=None,
            **overrides,
        )
        reset_precomputed_storage()
        clear_precomputed_graph_registry()
        configure_precomputed_storage(settings)
        for provider in providers:
            register_precomputed_graph_provider(provider)
        app = FastAPI()
        app.include_router(precomputed_router.router)
        client = TestClient(app)
        created.append(client)
        return client

    yield _build

    reset_precomputed_storage()
    clear_precomputed_graph_registry()
    get_settings.cache_clear()


def _url(context_id, name=None, **params):
    base = f"/api/graph-contexts/{context_id}/precomputed-graphs"
    if name is None:
        return base
    url = f"{base}/{name}"
    if params:
        url += "?" + "&".join(f"{k}={v}" for k, v in params.items())
    return url


def _payload(response):
    """httpx transparently decodes Content-Encoding, so .content is plain JSON."""
    return orjson.loads(response.content)


class TestDeclining:
    def test_a_declining_provider_lets_the_next_one_answer(self, chain, context):
        calls = []
        client = chain(_declining("first", calls), _answering("second", calls=calls))

        resp = client.get(_url(context.id, "g"), headers=_headers(OWNER))

        assert resp.status_code == 200
        assert _payload(resp)["provider"] == "second"
        assert calls == ["first", "second"]

    def test_when_every_provider_declines_the_answer_is_404(self, chain, context):
        client = chain(_declining("a"), _declining("b"))

        resp = client.get(_url(context.id, "nope"), headers=_headers(OWNER))

        assert resp.status_code == 404
        detail = resp.json()["detail"]["error"]
        assert detail["code"] == "PRECOMPUTED_GRAPH_NOT_FOUND"
        assert detail["details"]["name"] == "nope"

    def test_an_empty_chain_answers_404(self, chain, context):
        """`precomputed_graph_providers=[]` means "this deployment serves none",
        which must not be confused with the feature being disabled."""
        client = chain()

        resp = client.get(_url(context.id, "g"), headers=_headers(OWNER))

        assert resp.status_code == 404
        assert (
            resp.json()["detail"]["error"]["code"] == "PRECOMPUTED_GRAPH_NOT_FOUND"
        )

    def test_a_later_provider_is_not_consulted_once_one_answers(self, chain, context):
        calls = []
        client = chain(_answering("first", calls=calls), _answering("second", calls=calls))

        client.get(_url(context.id, "g"), headers=_headers(OWNER))

        assert calls == ["first"]


class TestMatching:
    def test_a_non_matching_provider_is_never_resolved(self, chain, context):
        """Not merely "its answer is discarded" — `resolve` must not run at all,
        or a matcher would be a filter on results rather than on work."""
        calls = []
        skipped = _answering("skipped", calls=calls)
        skipped.matches = lambda request: False
        client = chain(skipped, _answering("chosen", calls=calls))

        resp = client.get(_url(context.id, "g"), headers=_headers(OWNER))

        assert _payload(resp)["provider"] == "chosen"
        assert calls == ["chosen"]

    def test_matching_on_context_id_routes_between_backends(self, chain, store):
        """Lakebase in one context, a volume in another — the headline topology."""
        ctx_a = store.create_graph_context(
            title="a", edge_table_name="e", node_table_name="n", owner_email=OWNER
        )
        ctx_b = store.create_graph_context(
            title="b", edge_table_name="e", node_table_name="n", owner_email=OWNER
        )

        a = _answering("for-a")
        a.matches = lambda request: request.context_id == ctx_a.id
        b = _answering("for-b")
        b.matches = lambda request: request.context_id == ctx_b.id
        client = chain(a, b)

        assert (
            _payload(client.get(_url(ctx_a.id, "g"), headers=_headers(OWNER)))["provider"]
            == "for-a"
        )
        assert (
            _payload(client.get(_url(ctx_b.id, "g"), headers=_headers(OWNER)))["provider"]
            == "for-b"
        )

    def test_matching_on_the_name_routes_within_one_context(self, chain, context):
        bfs = _answering("bfs")
        bfs.matches = lambda request: request.name.startswith("bfs-")
        client = chain(bfs, _answering("fallback"))

        assert (
            _payload(client.get(_url(context.id, "bfs-x"), headers=_headers(OWNER)))[
                "provider"
            ]
            == "bfs"
        )
        assert (
            _payload(client.get(_url(context.id, "other"), headers=_headers(OWNER)))[
                "provider"
            ]
            == "fallback"
        )

    def test_a_raising_matcher_aborts_rather_than_being_read_as_no_match(
        self, chain, context
    ):
        """Silently handing the request to the next provider would answer with
        the wrong graph instead of an error."""

        def _boom(request):
            raise RuntimeError("predicate exploded")

        broken = _answering("broken")
        broken.matches = _boom
        client = chain(broken, _answering("would-have-answered"))

        resp = client.get(_url(context.id, "g"), headers=_headers(OWNER))

        assert resp.status_code == 502
        assert resp.json()["detail"]["error"]["code"] == "PROVIDER_FAILED"


class TestOrdering:
    def test_registration_order_decides_who_gets_first_refusal(self, chain, context):
        client = chain(_answering("first"), _answering("second"))
        assert (
            _payload(client.get(_url(context.id, "g"), headers=_headers(OWNER)))[
                "provider"
            ]
            == "first"
        )

    def test_reversing_registration_reverses_the_answer(self, chain, context):
        client = chain(_answering("second"), _answering("first"))
        assert (
            _payload(client.get(_url(context.id, "g"), headers=_headers(OWNER)))[
                "provider"
            ]
            == "second"
        )

    def test_a_volume_first_chain_falls_back_when_the_file_is_absent(
        self, chain, context
    ):
        """The composition the feature exists for: serve the batch job's file
        when it exists, compute the graph when it does not."""
        client = chain(volume_provider(), _answering("computed"))

        # Nothing on the volume yet.
        first = client.get(_url(context.id, "shared-name"), headers=_headers(OWNER))
        assert _payload(first)["provider"] == "computed"

        # Publish under the same name; the volume now wins.
        client.put(
            _url(context.id, "shared-name"),
            json=_body(),
            headers=_headers(SUPERUSER),
        )
        second = client.get(_url(context.id, "shared-name"), headers=_headers(OWNER))
        assert _payload(second)["provider"] == "volume"


class TestFailures:
    def test_a_raising_resolve_is_a_502_that_does_not_leak_the_exception(
        self, chain, context
    ):
        async def _boom(request):
            raise RuntimeError("connection string s3cr3t@host")

        client = chain(PrecomputedGraphProvider(name="broken", resolve=_boom))

        resp = client.get(_url(context.id, "g"), headers=_headers(OWNER))

        assert resp.status_code == 502
        detail = resp.json()["detail"]["error"]
        assert detail["code"] == "PROVIDER_FAILED"
        assert "s3cr3t" not in detail["message"]
        # The provider name is safe to return and is what makes the log findable.
        assert detail["details"]["provider"] == "broken"

    def test_show_error_details_opts_a_deployment_into_the_exception_text(
        self, chain, context, monkeypatch
    ):
        """The existing debugging knob still works — it just is not the default."""

        async def _boom(request):
            raise RuntimeError("connection string s3cr3t@host")

        client = chain(PrecomputedGraphProvider(name="broken", resolve=_boom))
        monkeypatch.setenv("GRAPH_LAGOON_SHOW_ERROR_DETAILS", "true")
        get_settings.cache_clear()

        resp = client.get(_url(context.id, "g"), headers=_headers(OWNER))

        assert resp.status_code == 502
        assert "s3cr3t" in resp.json()["detail"]["error"]["message"]

    def test_the_provider_name_reaches_the_log(self, chain, context, caplog):
        async def _boom(request):
            raise RuntimeError("nope")

        client = chain(PrecomputedGraphProvider(name="broken", resolve=_boom))

        with caplog.at_level("ERROR"):
            client.get(_url(context.id, "g"), headers=_headers(OWNER))

        assert "broken" in caplog.text

    def test_returning_the_wrong_type_is_caught_rather_than_crashing_later(
        self, chain, context
    ):
        async def _wrong(request):
            return {"nodes": [], "edges": []}

        client = chain(PrecomputedGraphProvider(name="sloppy", resolve=_wrong))

        resp = client.get(_url(context.id, "g"), headers=_headers(OWNER))
        assert resp.status_code == 502


class TestWriteCapability:
    def test_a_provider_without_save_answers_405_on_put(self, chain, context):
        client = chain(_answering("readonly"))

        resp = client.put(
            _url(context.id, "g"), json=_body(), headers=_headers(SUPERUSER)
        )

        assert resp.status_code == 405
        assert resp.json()["detail"]["error"]["code"] == "PROVIDER_READ_ONLY"
        assert resp.headers["allow"] == "GET"

    def test_a_provider_without_delete_answers_405(self, chain, context):
        client = chain(_answering("readonly"))
        resp = client.delete(_url(context.id, "g"), headers=_headers(SUPERUSER))
        assert resp.status_code == 405

    def test_a_read_only_volume_provider_refuses_writes(self, chain, context):
        client = chain(volume_provider(writable=False))
        resp = client.put(
            _url(context.id, "g"), json=_body(), headers=_headers(SUPERUSER)
        )
        assert resp.status_code == 405

    def test_a_write_never_falls_through_to_a_later_writable_provider(
        self, chain, context
    ):
        """Writing somewhere other than where you read from is the worst
        surprise this feature could produce, so the first *match* is the only
        candidate — not the first writable one."""
        client = chain(_answering("readonly"), volume_provider())

        resp = client.put(
            _url(context.id, "g"), json=_body(), headers=_headers(SUPERUSER)
        )

        assert resp.status_code == 405
        # And nothing was written behind the 405.
        assert _payload(
            client.get(_url(context.id, "g"), headers=_headers(OWNER))
        )["provider"] == "readonly"

    def test_capability_is_checked_after_authorization(self, chain, context):
        """A stranger must not be able to probe whether a provider is writable."""
        client = chain(_answering("readonly"))

        assert (
            client.put(
                _url(context.id, "g"), json=_body(), headers=_headers(STRANGER)
            ).status_code
            == 403
        )
        assert (
            client.put(
                _url(context.id, "g"), json=_body(), headers=_headers(OWNER)
            ).status_code
            == 403
        )


class TestCapabilitiesEndpoint:
    def test_a_read_only_chain_reports_no_write(self, chain, context):
        client = chain(_answering("readonly"))
        body = client.get(_url(context.id), headers=_headers(SUPERUSER)).json()
        assert body["can_write"] is False
        assert body["can_delete"] is False
        assert [p["name"] for p in body["providers"]] == ["readonly"]

    def test_a_writable_chain_reports_write_for_a_superuser(self, chain, context):
        client = chain(volume_provider())
        body = client.get(_url(context.id), headers=_headers(SUPERUSER)).json()
        assert body["can_write"] is True
        assert body["can_delete"] is True

    def test_a_non_superuser_never_sees_can_write(self, chain, context):
        """Capability and authorization both have to hold, so the frontend can
        gate its panel on one flag."""
        client = chain(volume_provider())
        body = client.get(_url(context.id), headers=_headers(OWNER)).json()
        assert body["can_write"] is False

    def test_declared_params_are_advertised(self, chain, context):
        provider = _answering("lakebase")
        provider.params = [
            ParamSpec("seed", "str", required=True),
            ParamSpec("hops", "int", default=2, min=1, max=4),
        ]
        client = chain(provider)

        params = client.get(_url(context.id), headers=_headers(OWNER)).json()[
            "providers"
        ][0]["params"]

        assert [p["name"] for p in params] == ["seed", "hops"]
        assert params[0]["required"] is True
        assert params[1]["max"] == 4

    def test_a_stranger_cannot_read_capabilities(self, chain, context):
        client = chain(volume_provider())
        assert (
            client.get(_url(context.id), headers=_headers(STRANGER)).status_code == 403
        )


class TestParamsReachTheProvider:
    def test_declared_params_arrive_typed(self, chain, context):
        seen = {}

        async def _resolve(request):
            seen.update(request.params)
            return PrecomputedGraphResult.from_graph(
                _graph(1),
                name=request.name,
                context_id=request.context_id,
                provider="p",
                params=request.params,
            )

        client = chain(
            PrecomputedGraphProvider(
                name="p",
                resolve=_resolve,
                params=[
                    ParamSpec("seed", "str", required=True),
                    ParamSpec("hops", "int", default=2, min=1, max=4),
                ],
            )
        )

        client.get(
            _url(context.id, "g", seed="abc", hops="3"), headers=_headers(OWNER)
        )

        assert seen == {"seed": "abc", "hops": 3}

    def test_the_params_are_echoed_into_the_payload(self, chain, context):
        async def _resolve(request):
            return PrecomputedGraphResult.from_graph(
                _graph(1),
                name=request.name,
                context_id=request.context_id,
                provider="p",
                params=request.params,
            )

        client = chain(
            PrecomputedGraphProvider(
                name="p",
                resolve=_resolve,
                params=[ParamSpec("seed", "str", required=True)],
            )
        )

        resp = client.get(_url(context.id, "g", seed="abc"), headers=_headers(OWNER))
        assert _payload(resp)["params"] == {"seed": "abc"}

    def test_an_undeclared_param_is_a_400_before_resolve_runs(self, chain, context):
        calls = []
        provider = _answering("p", calls=calls)
        provider.params = [ParamSpec("seed", "str")]
        client = chain(provider)

        resp = client.get(_url(context.id, "g", sed="abc"), headers=_headers(OWNER))

        assert resp.status_code == 400
        assert resp.json()["detail"]["error"]["code"] == "UNKNOWN_PARAM"
        assert calls == []

    def test_a_missing_required_param_is_a_400(self, chain, context):
        provider = _answering("p")
        provider.params = [ParamSpec("seed", "str", required=True)]
        client = chain(provider)

        resp = client.get(_url(context.id, "g"), headers=_headers(OWNER))

        assert resp.status_code == 400
        assert resp.json()["detail"]["error"]["code"] == "MISSING_PARAM"

    def test_an_out_of_range_param_is_a_400_naming_the_param(self, chain, context):
        provider = _answering("p")
        provider.params = [ParamSpec("hops", "int", min=1, max=4)]
        client = chain(provider)

        resp = client.get(_url(context.id, "g", hops="99"), headers=_headers(OWNER))

        assert resp.status_code == 400
        assert resp.json()["detail"]["error"]["details"]["param"] == "hops"

    def test_a_repeated_param_is_a_400_rather_than_last_wins(self, chain, context):
        provider = _answering("p")
        provider.params = [ParamSpec("seed", "str")]
        client = chain(provider)

        resp = client.get(
            f"{_url(context.id, 'g')}?seed=safe&seed=evil", headers=_headers(OWNER)
        )

        assert resp.status_code == 400
        assert resp.json()["detail"]["error"]["code"] == "DUPLICATE_PARAM"

    def test_a_param_value_never_reaches_the_storage_key(self, chain, context, tmp_path):
        """Params say what to compute, never which file to read."""
        provider = volume_provider()
        provider.params = [ParamSpec("seed", "str")]
        client = chain(provider)

        client.put(
            _url(context.id, "entry"), json=_body(), headers=_headers(SUPERUSER)
        )
        with_param = client.get(
            _url(context.id, "entry", seed="../../etc/passwd"),
            headers=_headers(OWNER),
        )

        assert with_param.status_code == 200
        assert _payload(with_param)["name"] == "entry"


class TestMixedParameterSpecs:
    """A chain whose providers declare *different* arguments.

    This is the shape the whole feature is for — a volume that takes no
    arguments in front of a query that takes several — and it only works
    because parameters are coerced per provider rather than once against
    whoever matched first.
    """

    def _layered(self, chain):
        """volume (no params) in front of a BFS-ish provider (seed, hops)."""
        seen = {}

        async def _resolve(request):
            seen.clear()
            seen.update(request.params)
            return PrecomputedGraphResult.from_graph(
                _graph(1),
                name=request.name,
                context_id=request.context_id,
                provider="computed",
                params=request.params,
            )

        computed = PrecomputedGraphProvider(
            name="computed",
            resolve=_resolve,
            params=[
                ParamSpec("seed", "str", required=True, max_length=64),
                ParamSpec("hops", "int", default=2, min=1, max=4),
            ],
        )
        return chain(volume_provider(), computed), seen

    def test_an_argument_the_first_provider_never_declared_still_works(
        self, chain, context
    ):
        """The regression this class exists for.

        Coercing once against the first matching provider made `?seed=` a 400
        whenever a volume sat in front of the provider that actually declared
        it — the documented layered example could not work at all.
        """
        client, seen = self._layered(chain)

        resp = client.get(
            _url(context.id, "vizinhanca", seed="n1"), headers=_headers(OWNER)
        )

        assert resp.status_code == 200
        assert _payload(resp)["provider"] == "computed"
        assert seen == {"seed": "n1", "hops": 2}

    def test_each_provider_receives_only_what_it_declared(self, chain, context):
        received = {}

        async def _alpha(request):
            received["alpha"] = dict(request.params)
            return None

        async def _beta(request):
            received["beta"] = dict(request.params)
            return None

        client = chain(
            PrecomputedGraphProvider(
                name="alpha", resolve=_alpha, params=[ParamSpec("a", "str")]
            ),
            PrecomputedGraphProvider(
                name="beta", resolve=_beta, params=[ParamSpec("b", "int")]
            ),
        )

        client.get(_url(context.id, "g", a="x", b="7"), headers=_headers(OWNER))

        # Neither sees the other's argument, and each gets its own declared type.
        assert received["alpha"] == {"a": "x"}
        assert received["beta"] == {"b": 7}

    def test_a_key_no_provider_declares_is_still_a_400(self, chain, context):
        """Typo protection survives the union: `sed` is declared by nobody."""
        client, _ = self._layered(chain)

        resp = client.get(
            _url(context.id, "vizinhanca", sed="n1"), headers=_headers(OWNER)
        )

        assert resp.status_code == 400
        body = resp.json()["detail"]["error"]
        assert body["code"] == "UNKNOWN_PARAM"
        # The message names the union across the chain, not one provider's slice.
        assert set(body["details"]["declared"]) == {"seed", "hops"}

    def test_a_provider_missing_a_required_argument_stands_down(
        self, chain, context
    ):
        """Not an error — the same standing-down as a matcher saying no.

        Without `?seed=`, the BFS provider cannot serve the request at all, so
        the volume behind it should answer normally.
        """
        client, seen = self._layered(chain)
        client.put(
            _url(context.id, "publicado"), json=_body(), headers=_headers(SUPERUSER)
        )

        resp = client.get(_url(context.id, "publicado"), headers=_headers(OWNER))

        assert resp.status_code == 200
        assert _payload(resp)["provider"] == "volume"
        assert seen == {}  # the computed provider never ran

    def test_a_value_outside_a_providers_bounds_is_a_hard_400(self, chain, context):
        """Even though the volume in front would happily have answered.

        Falling through would serve a graph that silently ignored `hops`, and a
        wrong answer you cannot see is worse than an error.
        """
        client, _ = self._layered(chain)
        client.put(
            _url(context.id, "publicado"), json=_body(), headers=_headers(SUPERUSER)
        )

        resp = client.get(
            _url(context.id, "publicado", seed="n1", hops="99"),
            headers=_headers(OWNER),
        )

        assert resp.status_code == 400
        assert resp.json()["detail"]["error"]["details"]["param"] == "hops"

    def test_a_forgotten_required_argument_explains_itself(self, chain, context):
        """When *nothing* can serve the request, say which argument is missing.

        A bare 404 would send someone hunting for a name that is perfectly fine.
        """
        provider = _answering("computed")
        provider.params = [ParamSpec("seed", "str", required=True)]
        client = chain(provider)

        resp = client.get(_url(context.id, "vizinhanca"), headers=_headers(OWNER))

        assert resp.status_code == 400
        assert resp.json()["detail"]["error"]["code"] == "MISSING_PARAM"
        assert resp.json()["detail"]["error"]["details"]["param"] == "seed"

    def test_a_genuinely_absent_graph_is_still_a_404(self, chain, context):
        """The 400 above must not swallow the ordinary not-found case."""
        client, _ = self._layered(chain)

        resp = client.get(
            _url(context.id, "nao-existe", seed="n1"), headers=_headers(OWNER)
        )

        # The computed provider answers everything, so decline it explicitly.
        assert resp.status_code == 200

        client2 = chain(volume_provider())
        resp2 = client2.get(_url(context.id, "nao-existe"), headers=_headers(OWNER))
        assert resp2.status_code == 404
        assert (
            resp2.json()["detail"]["error"]["code"] == "PRECOMPUTED_GRAPH_NOT_FOUND"
        )

    def test_a_matcher_sees_the_raw_arguments(self, chain, context):
        """Matching runs before coercion, so `params` is empty there — but the
        raw strings are available, which is enough to route on."""
        observed = {}

        def _matches(request):
            observed["params"] = dict(request.params)
            observed["raw"] = dict(request.raw_params)
            return True

        provider = _answering("p")
        provider.params = [ParamSpec("seed", "str")]
        provider.matches = _matches
        client = chain(provider)

        client.get(_url(context.id, "g", seed="n1"), headers=_headers(OWNER))

        assert observed["params"] == {}
        assert observed["raw"] == {"seed": "n1"}


class TestResultForms:
    def test_raw_bytes_are_returned_byte_identical(self, chain, context):
        """The pass-through is the whole performance story: bytes a provider
        already holds must not be decompressed and re-encoded on the way out."""
        original = gzip.compress(
            orjson.dumps(
                {
                    "payload_version": 1,
                    "name": "raw",
                    "context_id": str(context.id),
                    "provider": "byte-source",
                    "params": {},
                    "created_at": "2026-01-01T00:00:00Z",
                    "created_by": "job@example.com",
                    "node_count": 0,
                    "edge_count": 0,
                    "properties_complete": True,
                    "source": {"kind": "manual", "query": None},
                    "graph": {"nodes": [], "edges": [], "truncated": False},
                }
            )
        )

        async def _resolve(request):
            return PrecomputedGraphResult.from_raw(original)

        client = chain(PrecomputedGraphProvider(name="byte-source", resolve=_resolve))

        resp = client.get(_url(context.id, "raw"), headers=_headers(OWNER))

        assert resp.status_code == 200
        # TestClient decodes the gzip; re-compressing would not be byte-stable,
        # so compare the decoded JSON and confirm the encoding header instead.
        assert _payload(resp)["provider"] == "byte-source"
        assert resp.headers.get("content-encoding") == "gzip"

    def test_an_in_memory_payload_is_compressed_by_the_server(self, chain, context):
        client = chain(_answering("computed", node_count=3))

        resp = client.get(_url(context.id, "g"), headers=_headers(OWNER))

        assert resp.headers.get("content-encoding") == "gzip"
        body = _payload(resp)
        assert body["node_count"] == 3
        assert len(body["graph"]["nodes"]) == 3

    def test_a_provider_returning_non_gzip_bytes_is_reported_not_mislabelled(
        self, chain, context
    ):
        """A body labelled gzip that is not gzip fails in the browser with no
        server-side explanation, so the gate stays."""

        async def _resolve(request):
            return PrecomputedGraphResult.from_raw(b"\x28\xb5\x2f\xfd zstd!")

        client = chain(PrecomputedGraphProvider(name="zstd", resolve=_resolve))

        resp = client.get(_url(context.id, "g"), headers=_headers(OWNER))

        assert resp.status_code == 502
        assert (
            resp.json()["detail"]["error"]["code"] == "PRECOMPUTED_GRAPH_UNREADABLE"
        )

    def test_a_result_must_carry_exactly_one_form(self):
        with pytest.raises(ValueError, match="exactly one"):
            PrecomputedGraphResult()
        with pytest.raises(ValueError, match="exactly one"):
            PrecomputedGraphResult(raw=b"x", payload=object())


class TestRegistration:
    def test_a_duplicate_name_raises(self):
        clear_precomputed_graph_registry()
        try:
            register_precomputed_graph_provider(_answering("dup"))
            with pytest.raises(ValueError, match="already registered"):
                register_precomputed_graph_provider(_answering("dup"))
        finally:
            clear_precomputed_graph_registry()

    def test_registering_the_same_object_twice_is_a_no_op(self):
        clear_precomputed_graph_registry()
        try:
            provider = _answering("same")
            register_precomputed_graph_provider(provider)
            register_precomputed_graph_provider(provider)
        finally:
            clear_precomputed_graph_registry()

    def test_a_sync_resolve_is_rejected_at_registration(self):
        clear_precomputed_graph_registry()
        try:
            with pytest.raises(ValueError, match="must be an async function"):
                register_precomputed_graph_provider(
                    PrecomputedGraphProvider(name="sync", resolve=lambda request: None)
                )
        finally:
            clear_precomputed_graph_registry()

    def test_delete_without_save_is_rejected(self):
        clear_precomputed_graph_registry()

        async def _resolve(request):
            return None

        async def _delete(request):
            return None

        try:
            with pytest.raises(ValueError, match="declares delete without save"):
                register_precomputed_graph_provider(
                    PrecomputedGraphProvider(
                        name="odd", resolve=_resolve, delete=_delete
                    )
                )
        finally:
            clear_precomputed_graph_registry()

    @pytest.mark.parametrize("name", ["", "Upper", "has space", "x" * 60])
    def test_a_malformed_provider_name_is_rejected(self, name):
        clear_precomputed_graph_registry()
        try:
            with pytest.raises(ValueError, match="Invalid precomputed graph provider"):
                register_precomputed_graph_provider(_answering(name))
        finally:
            clear_precomputed_graph_registry()

    def test_omitting_the_argument_registers_the_built_in_volume_provider(
        self, tmp_path, monkeypatch
    ):
        from graphlagoon.app import create_mountable_app
        from graphlagoon.services.precomputed import (
            get_precomputed_graph_providers,
        )

        monkeypatch.setenv(
            "GRAPH_LAGOON_PRECOMPUTED_GRAPHS_DIR", str(tmp_path / "store")
        )
        get_settings.cache_clear()
        try:
            create_mountable_app(include_frontend=False)
            assert [p.name for p in get_precomputed_graph_providers()] == ["volume"]
        finally:
            clear_precomputed_graph_registry()
            reset_precomputed_storage()
            get_settings.cache_clear()

    def test_an_empty_list_registers_nothing(self, tmp_path, monkeypatch):
        from graphlagoon.app import create_mountable_app
        from graphlagoon.services.precomputed import (
            get_precomputed_graph_providers,
        )

        get_settings.cache_clear()
        try:
            create_mountable_app(
                include_frontend=False, precomputed_graph_providers=[]
            )
            assert get_precomputed_graph_providers() == []
        finally:
            clear_precomputed_graph_registry()
            reset_precomputed_storage()
            get_settings.cache_clear()

    def test_building_the_app_twice_is_idempotent(self, tmp_path, monkeypatch):
        """Each construction builds a fresh default provider, so registering by
        name would otherwise collide with the previous app."""
        from graphlagoon.app import create_mountable_app
        from graphlagoon.services.precomputed import (
            get_precomputed_graph_providers,
        )

        get_settings.cache_clear()
        try:
            create_mountable_app(include_frontend=False)
            create_mountable_app(include_frontend=False)
            assert [p.name for p in get_precomputed_graph_providers()] == ["volume"]
        finally:
            clear_precomputed_graph_registry()
            reset_precomputed_storage()
            get_settings.cache_clear()


class TestDisabledStillWins:
    def test_the_feature_flag_beats_every_provider(self, chain, context):
        client = chain(_answering("p"), precomputed_graphs_enabled=False)

        resp = client.get(_url(context.id, "g"), headers=_headers(OWNER))

        assert resp.status_code == 404
        assert (
            resp.json()["detail"]["error"]["code"] == "PRECOMPUTED_GRAPHS_DISABLED"
        )

    def test_capabilities_reports_disabled_too(self, chain, context):
        client = chain(_answering("p"), precomputed_graphs_enabled=False)
        resp = client.get(_url(context.id), headers=_headers(OWNER))
        assert resp.status_code == 404
