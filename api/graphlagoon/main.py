"""Main entry point for Graph Lagoon Studio REST API.

This module creates a host FastAPI application that mounts Graph Lagoon
as a sub-application, dogfooding the same integration pattern that
external users would follow.

Run with:
    uvicorn graphlagoon.main:app --host 0.0.0.0 --port 8000 --reload
"""

import os
import random

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from graphlagoon.app import create_mountable_app, add_mount_redirect
from graphlagoon.middleware.auth import AuthMiddleware
from graphlagoon.similarity import SimilarityEndpointSpec, SimilarityEndpointParam

# Enable debugpy for VSCode debugging
if os.environ.get("DEBUGPY_ENABLE", "").lower() in ("1", "true"):
    import debugpy

    debugpy_port = int(os.environ.get("DEBUGPY_PORT", "5678"))
    debugpy.listen(("0.0.0.0", debugpy_port))
    print(f"Waiting for debugger to attach on port {debugpy_port}...")
    if os.environ.get("DEBUGPY_WAIT", "").lower() in ("1", "true"):
        debugpy.wait_for_client()
    print("Debugger attached!")

# Host application — mirrors what an external integrator would write
app = FastAPI(title="Graph Lagoon Host")

# CORS (dev-friendly defaults)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Auth middleware on the host so it covers all routes
app.add_middleware(AuthMiddleware)

# ---------------------------------------------------------------------------
# Dummy similarity endpoint — forms a random circle from any node ids
# ---------------------------------------------------------------------------


class DummySimilarityRequest(BaseModel):
    node_keys: list[str]
    params: dict = {}


@app.post("/dummy/similarity/circle")
async def dummy_similarity_circle(request: DummySimilarityRequest):
    """Shuffle the node keys and link them in a circle, with random scores.

    One edge per pair — d3-force link is undirected, so duplicating
    A→B and B→A would double the attractive force.
    """
    keys = list(request.node_keys)
    if len(keys) < 2:
        return {"edges": []}

    random.shuffle(keys)
    edges = []
    for i in range(len(keys)):
        edges.append({
            "source": keys[i],
            "target": keys[(i + 1) % len(keys)],
            "score": round(random.uniform(0.5, 1.0), 3),
        })
    return {"edges": edges}


@app.post("/dummy/similarity/knn")
async def dummy_similarity_knn(request: DummySimilarityRequest):
    """Random k-nearest-neighbors: each node connects to k random others.

    One edge per pair (undirected).

    Params:
        k: number of neighbors per node (default 3)
    """
    keys = list(request.node_keys)
    k = int(request.params.get("k", 3))
    if len(keys) < 2:
        return {"edges": []}

    k = min(k, len(keys) - 1)
    seen = set()
    edges = []

    for key in keys:
        others = [o for o in keys if o != key]
        neighbors = random.sample(others, k)
        for nb in neighbors:
            pair = tuple(sorted([key, nb]))
            if pair not in seen:
                seen.add(pair)
                edges.append({
                    "source": key,
                    "target": nb,
                    "score": round(random.uniform(0.3, 1.0), 3),
                })

    return {"edges": edges}


# Create and mount Graph Lagoon
graphlagoon_app = create_mountable_app(
    mount_prefix="/graphlagoon",
    similarity_endpoints=[
        SimilarityEndpointSpec(
            name="circle",
            description="Dummy: shuffle nodes into a circle with random scores",
            endpoint="/dummy/similarity/circle",
        ),
        SimilarityEndpointSpec(
            name="knn",
            description="Dummy: random k-nearest-neighbors graph",
            endpoint="/dummy/similarity/knn",
            params=[
                SimilarityEndpointParam(
                    name="k",
                    type="int",
                    default=3,
                    description="Neighbors per node",
                ),
            ],
        ),
    ],
)

add_mount_redirect(app, "/graphlagoon")
app.mount("/graphlagoon", graphlagoon_app)


@app.get("/health")
async def health_check():
    return {"status": "healthy"}


@app.get("/ping")
async def ping():
    return {"message": "pong from host app"}


__all__ = ["app"]
