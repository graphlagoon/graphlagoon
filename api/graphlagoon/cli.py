"""CLI entry point for Graph Lagoon Studio."""

import argparse
import os


def main():
    """Run Graph Lagoon Studio server."""
    parser = argparse.ArgumentParser(
        description="Graph Lagoon Studio - Graph visualization and exploration tool"
    )
    parser.add_argument(
        "--host", default="0.0.0.0", help="Host to bind to (default: 0.0.0.0)"
    )
    parser.add_argument(
        "--port",
        type=int,
        default=int(os.getenv("GRAPH_LAGOON_PORT", "8000")),
        help="Port to bind to (default: 8000 or GRAPH_LAGOON_PORT env var)",
    )
    parser.add_argument(
        "--reload", action="store_true", help="Enable auto-reload for development"
    )
    parser.add_argument(
        "--no-frontend", action="store_true", help="Disable frontend serving (API only)"
    )

    args = parser.parse_args()

    # Set environment variable to control frontend inclusion
    if args.no_frontend:
        os.environ["GRAPH_LAGOON_NO_FRONTEND"] = "true"

    import uvicorn

    uvicorn.run(
        "src.app:app",
        host=args.host,
        port=args.port,
        reload=args.reload,
    )


if __name__ == "__main__":
    main()
