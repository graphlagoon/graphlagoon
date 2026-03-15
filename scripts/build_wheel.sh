#!/bin/bash
# Build script for graphlagoon wheel package
# This script builds the frontend and creates a Python wheel with all static assets
#
# Usage:
#   ./build_wheel.sh           # Build frontend + wheel (default)
#   ./build_wheel.sh --wheel-only  # Build only wheel (frontend must be pre-built)

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# Parse arguments
WHEEL_ONLY=false
if [ "$1" = "--wheel-only" ]; then
    WHEEL_ONLY=true
fi

echo "=========================================="
echo "Building Graph Lagoon Studio Wheel Package"
echo "=========================================="

# Colors
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Step 1: Build frontend (skip if --wheel-only)
if [ "$WHEEL_ONLY" = false ]; then
    echo -e "\n${CYAN}[1/3] Building frontend...${NC}"
    cd "$PROJECT_ROOT/frontend"

    # Check if node_modules exists
    if [ ! -d "node_modules" ]; then
        echo -e "${YELLOW}Installing npm dependencies...${NC}"
        npm install
    fi

    # Build frontend (outputs to ../api/graphlagoon/static/)
    npm run build

    echo -e "${GREEN}Frontend built successfully!${NC}"
else
    echo -e "\n${CYAN}[1/3] Skipping frontend build (--wheel-only mode)${NC}"
fi

# Step 2: Verify static files exist
echo -e "\n${CYAN}[2/3] Verifying static files...${NC}"
cd "$PROJECT_ROOT/api"

if [ ! -d "graphlagoon/static/assets" ]; then
    echo "Error: Static assets not found. Frontend build may have failed."
    exit 1
fi

if [ ! -f "graphlagoon/static/.vite/manifest.json" ]; then
    echo "Error: Vite manifest not found. Frontend build may have failed."
    exit 1
fi

echo -e "${GREEN}Static files verified!${NC}"
echo "  - Assets: $(ls graphlagoon/static/assets/*.js 2>/dev/null | wc -l) JS files"
echo "  - Assets: $(ls graphlagoon/static/assets/*.css 2>/dev/null | wc -l) CSS files"

# Step 3: Build Python wheel
echo -e "\n${CYAN}[3/3] Building Python wheel...${NC}"

# Clean previous builds
rm -rf dist/ build/ *.egg-info

# Build with hatch (uses hatchling)
hatch build

echo -e "\n${GREEN}=========================================="
echo "Build complete!"
echo "==========================================${NC}"
echo ""
echo "Wheel package created in: api/dist/"
ls -la dist/*.whl 2>/dev/null || echo "No wheel found"
echo ""
echo "To install:"
echo "  pip install dist/graphlagoon-*.whl"
echo ""
echo "To upload to PyPI:"
echo "  twine upload dist/*"
