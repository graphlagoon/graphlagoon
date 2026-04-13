"""Tests for similarity endpoint registry and router."""

import pytest
from unittest.mock import AsyncMock, patch

from graphlagoon.similarity import (
    SimilarityEndpointSpec,
    SimilarityEndpointParam,
    register_similarity_endpoint,
    get_registered_endpoints,
    get_endpoint,
    clear_registry,
)


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------


class TestRegistry:
    """Tests for the global similarity endpoint registry."""

    def setup_method(self):
        clear_registry()

    def teardown_method(self):
        clear_registry()

    def test_register_and_get(self):
        spec = SimilarityEndpointSpec(
            name="cosine",
            description="Cosine similarity",
            endpoint="/api/sim/cosine",
        )
        register_similarity_endpoint(spec)
        assert get_endpoint("cosine") is spec

    def test_get_nonexistent_returns_none(self):
        assert get_endpoint("nope") is None

    def test_get_registered_endpoints_empty(self):
        assert get_registered_endpoints() == []

    def test_get_registered_endpoints_returns_all(self):
        spec1 = SimilarityEndpointSpec(
            name="cosine", description="a", endpoint="/a"
        )
        spec2 = SimilarityEndpointSpec(
            name="jaccard", description="b", endpoint="/b"
        )
        register_similarity_endpoint(spec1)
        register_similarity_endpoint(spec2)
        result = get_registered_endpoints()
        assert len(result) == 2
        names = {s.name for s in result}
        assert names == {"cosine", "jaccard"}

    def test_register_overwrites_same_name(self):
        spec1 = SimilarityEndpointSpec(
            name="cosine", description="v1", endpoint="/v1"
        )
        spec2 = SimilarityEndpointSpec(
            name="cosine", description="v2", endpoint="/v2"
        )
        register_similarity_endpoint(spec1)
        register_similarity_endpoint(spec2)
        assert len(get_registered_endpoints()) == 1
        assert get_endpoint("cosine").description == "v2"

    def test_clear_registry(self):
        register_similarity_endpoint(
            SimilarityEndpointSpec(name="x", description="x", endpoint="/x")
        )
        assert len(get_registered_endpoints()) == 1
        clear_registry()
        assert len(get_registered_endpoints()) == 0

    def test_spec_with_params(self):
        spec = SimilarityEndpointSpec(
            name="knn",
            description="k-NN",
            endpoint="/knn",
            params=[
                SimilarityEndpointParam(
                    name="k", type="int", default=5, required=False
                ),
                SimilarityEndpointParam(
                    name="metric",
                    type="str",
                    required=True,
                    choices=["cosine", "euclidean"],
                ),
            ],
        )
        register_similarity_endpoint(spec)
        retrieved = get_endpoint("knn")
        assert len(retrieved.params) == 2
        assert retrieved.params[0].name == "k"
        assert retrieved.params[0].default == 5
        assert retrieved.params[1].required is True
        assert retrieved.params[1].choices == ["cosine", "euclidean"]


# ---------------------------------------------------------------------------
# Router
# ---------------------------------------------------------------------------


@pytest.fixture
def test_client():
    """Create a test client with the similarity router."""
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from graphlagoon.routers.similarity import router

    app = FastAPI()
    app.include_router(router)
    clear_registry()
    yield TestClient(app)
    clear_registry()


class TestRouter:
    """Tests for GET /api/similarity/endpoints."""

    def test_no_endpoints_returns_empty_list(self, test_client):
        resp = test_client.get("/api/similarity/endpoints")
        assert resp.status_code == 200
        assert resp.json() == []

    def test_returns_registered_endpoints(self, test_client):
        register_similarity_endpoint(
            SimilarityEndpointSpec(
                name="cosine",
                description="Cosine sim",
                endpoint="/sim/cosine",
                params=[
                    SimilarityEndpointParam(
                        name="threshold",
                        type="float",
                        default=0.5,
                        description="Min score",
                    ),
                ],
            )
        )
        resp = test_client.get("/api/similarity/endpoints")
        assert resp.status_code == 200
        data = resp.json()
        assert len(data) == 1
        ep = data[0]
        assert ep["name"] == "cosine"
        assert ep["description"] == "Cosine sim"
        assert ep["endpoint"] == "/sim/cosine"
        assert len(ep["params"]) == 1
        assert ep["params"][0]["name"] == "threshold"
        assert ep["params"][0]["type"] == "float"
        assert ep["params"][0]["default"] == 0.5

    def test_multiple_endpoints(self, test_client):
        register_similarity_endpoint(
            SimilarityEndpointSpec(name="a", description="A", endpoint="/a")
        )
        register_similarity_endpoint(
            SimilarityEndpointSpec(name="b", description="B", endpoint="/b")
        )
        resp = test_client.get("/api/similarity/endpoints")
        assert resp.status_code == 200
        assert len(resp.json()) == 2

    def test_endpoint_with_choices(self, test_client):
        register_similarity_endpoint(
            SimilarityEndpointSpec(
                name="knn",
                description="k-NN",
                endpoint="/knn",
                params=[
                    SimilarityEndpointParam(
                        name="metric",
                        type="str",
                        choices=["cosine", "euclidean"],
                    ),
                ],
            )
        )
        resp = test_client.get("/api/similarity/endpoints")
        param = resp.json()[0]["params"][0]
        assert param["choices"] == ["cosine", "euclidean"]

    def test_endpoint_param_defaults(self, test_client):
        """Params with no explicit values get correct defaults."""
        register_similarity_endpoint(
            SimilarityEndpointSpec(
                name="x",
                description="x",
                endpoint="/x",
                params=[
                    SimilarityEndpointParam(name="p", type="str"),
                ],
            )
        )
        resp = test_client.get("/api/similarity/endpoints")
        param = resp.json()[0]["params"][0]
        assert param["default"] is None
        assert param["required"] is False
        assert param["description"] == ""
        assert param["choices"] is None
