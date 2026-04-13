"""Main entry point for Graph Lagoon Studio REST API.

This module creates a host FastAPI application that mounts Graph Lagoon
as a sub-application, dogfooding the same integration pattern that
external users would follow.

Run with:
    uvicorn graphlagoon.main:app --host 0.0.0.0 --port 8000 --reload
"""

import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from graphlagoon.app import create_mountable_app, add_mount_redirect
from graphlagoon.middleware.auth import AuthMiddleware

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

# Create and mount Graph Lagoon
graphlagoon_app = create_mountable_app(mount_prefix="/graphlagoon")

add_mount_redirect(app, "/graphlagoon")
app.mount("/graphlagoon", graphlagoon_app)


@app.get("/health")
async def health_check():
    return {"status": "healthy"}


@app.get("/ping")
async def ping():
    return {"message": "pong from host app"}


__all__ = ["app"]
