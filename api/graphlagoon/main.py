"""Main entry point for Graph Lagoon Studio REST API.

This module provides backward compatibility with the existing entry point.
For new deployments, use `src.app:app` or import from `src.app`.
"""

import os

# Enable debugpy for VSCode debugging
if os.environ.get("DEBUGPY_ENABLE", "").lower() in ("1", "true"):
    import debugpy

    debugpy_port = int(os.environ.get("DEBUGPY_PORT", "5678"))
    debugpy.listen(("0.0.0.0", debugpy_port))
    print(f"Waiting for debugger to attach on port {debugpy_port}...")
    if os.environ.get("DEBUGPY_WAIT", "").lower() in ("1", "true"):
        debugpy.wait_for_client()
    print("Debugger attached!")

# Import app from the new location
from graphlagoon.app import app

# Re-export for backward compatibility
__all__ = ["app"]
