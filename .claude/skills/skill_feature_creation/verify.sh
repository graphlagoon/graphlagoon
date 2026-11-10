#!/usr/bin/env bash
# Definition-of-done check for a feature branch: runs only the checks that
# match the files changed against a base ref, prints one PASS/FAIL line per
# check and the tail of each failure.
#
#   verify.sh [--base <ref>] [--full]
#
#   --base <ref>  compare against <ref> (default: origin/main, then main)
#   --full        run the whole pytest and vitest suites, not only related tests
#
# Exit code 0 only when every check passed.
set -uo pipefail

BASE=""
FULL=0
while [ $# -gt 0 ]; do
  case "$1" in
    --base) BASE="${2:?--base needs a ref}"; shift 2 ;;
    --full) FULL=1; shift ;;
    -h|--help) sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

ROOT="$(git rev-parse --show-toplevel)" || exit 2
cd "$ROOT" || exit 2

if [ -z "$BASE" ]; then
  for ref in origin/main main; do
    if git rev-parse --verify --quiet "$ref" >/dev/null; then BASE="$ref"; break; fi
  done
fi
[ -n "$BASE" ] || { echo "no base ref found; pass --base <ref>" >&2; exit 2; }
MERGE_BASE="$(git merge-base HEAD "$BASE")" || { echo "cannot find merge base with $BASE" >&2; exit 2; }

# Committed on the branch + staged + unstaged + untracked; deleted files excluded.
CHANGED="$( { git diff --name-only --diff-filter=d "$MERGE_BASE"; \
              git ls-files --others --exclude-standard; } | sort -u )"
if [ -z "$CHANGED" ]; then echo "no changes against $BASE"; exit 0; fi

changed() { printf '%s\n' "$CHANGED" | grep -E "$1" || true; }
# Paths relative to a subproject, as one line of shell words.
rel() { changed "$1" | sed "s|^$2||" | tr '\n' ' '; }

# A failure prints its first and last lines (the cause is usually at one end)
# and keeps the whole log on disk, so the transcript stays short.
HEAD_LINES=15
TAIL_LINES=25
LOG_DIR="${TMPDIR:-/tmp}/graphlagoon-verify"
mkdir -p "$LOG_DIR"
FAILED=0

# run <label> <command>   blocking check
# warn <label> <command>  reported, never fails the run
_exec() {
  local verdict="$1" label="$2"; shift 2
  local log="$LOG_DIR/$(printf '%s' "$label" | tr -c 'A-Za-z0-9' '_').log"
  if bash -c "$*" >"$log" 2>&1; then
    echo "PASS  $label"
    return 0
  fi
  echo "$verdict  $label"
  echo "      \$ $*"
  if [ "$(wc -l <"$log")" -le $((HEAD_LINES + TAIL_LINES)) ]; then
    sed 's/^/      | /' "$log"
  else
    head -n "$HEAD_LINES" "$log" | sed 's/^/      | /'
    echo "      | ..."
    tail -n "$TAIL_LINES" "$log" | sed 's/^/      | /'
  fi
  echo "      full log: $log"
  return 1
}
run()  { _exec "FAIL" "$@" || FAILED=1; }
warn() { _exec "WARN" "$@" || true; }
skip() { echo "SKIP  $1 ($2)"; }

echo "base: $BASE ($(git rev-parse --short "$MERGE_BASE"))  changed files: $(printf '%s\n' "$CHANGED" | wc -l | tr -d ' ')"

# ── Backend ──────────────────────────────────────────────────────────────────
API_PY="$(rel '^api/graphlagoon/.*\.py$' 'api/')"
API_TESTS="$(rel '^api/tests/test_.*\.py$' 'api/')"
if [ -n "$(changed '^api/')" ] && ! (cd api && uv run python -c 'import pytest, alembic' >/dev/null 2>&1); then
  echo "FAIL  backend checks (deps missing: run 'cd api && uv sync --extra dev --extra postgres')"; FAILED=1
elif [ -n "$(changed '^api/')" ]; then
  if [ -n "$API_PY" ]; then
    # Non-blocking: the repo baseline is not ruff-clean, so a touched file may
    # carry older findings. Fix what your change introduced.
    warn "ruff check (changed files)" "cd api && uv run ruff check --output-format=concise $API_PY"
  fi
  if [ "$FULL" = 1 ]; then
    run "pytest (full suite)" "cd api && uv run pytest tests/ -q -p no:cacheprovider"
  else
    # Structural guards: registries (admin, audit, permissions, MCP) and generated API docs.
    GUARDS="tests/test_admin_registry.py tests/test_api_docs.py tests/test_app_docs.py tests/test_agent_registry.py"
    run "pytest registry and doc guards" "cd api && uv run pytest $GUARDS -q -p no:cacheprovider"
    if [ -n "$API_TESTS" ]; then
      run "pytest changed test files" "cd api && uv run pytest $API_TESTS -q -p no:cacheprovider"
    else
      skip "pytest changed test files" "no api/tests/test_*.py changed; did the backend change need a test?"
    fi
  fi
else
  skip "backend" "no changes under api/"
fi

# ── Frontend ─────────────────────────────────────────────────────────────────
# Test files for the change: changed tests themselves, plus the sibling
# __tests__/<Name>*.test.ts of each changed source file. (`vitest related`
# is not used: in this repo it dies with a parse error on anything that
# imports a .vue file.)
FE_TESTS="$(
  for f in $(changed '^frontend/src/.*\.(ts|vue)$'); do
    case "$f" in
      *.test.ts) echo "${f#frontend/}" ;;
      *)
        name="$(basename "${f%.*}")"
        for t in "$(dirname "$f")/__tests__/$name".test.ts "$(dirname "$f")/__tests__/$name".*.test.ts; do
          [ -f "$t" ] && echo "${t#frontend/}"
        done ;;
    esac
  done | sort -u | tr '\n' ' '
)"
E2E_SPECS="$(rel '^frontend/e2e/tests/.*\.spec\.ts$' 'frontend/e2e/')"
if [ -n "$(changed '^frontend/(src|e2e)/')" ]; then
  if [ ! -d frontend/node_modules ]; then
    echo "FAIL  frontend checks (frontend/node_modules missing: run 'make install')"; FAILED=1
  else
    run "vue-tsc" "cd frontend && npx vue-tsc --noEmit"
    if [ "$FULL" = 1 ]; then
      run "vitest (full suite)" "cd frontend && npx vitest run --reporter=dot"
    elif [ -n "$FE_TESTS" ]; then
      run "vitest tests of changed files" "cd frontend && npx vitest run $FE_TESTS --reporter=dot"
    elif [ -n "$(changed '^frontend/src/')" ]; then
      skip "vitest" "no test file matches the changed sources; did the frontend change need a test?"
    fi
    if [ -n "$E2E_SPECS" ]; then
      run "playwright changed specs" \
        "cd frontend && npx playwright test -c e2e/playwright.config.ts $E2E_SPECS --reporter=line --trace off"
    elif [ -n "$(changed '^frontend/src/(components|views)/.*\.vue$')" ]; then
      skip "playwright" "components or views changed but no e2e spec did; does a user workflow need one?"
    fi
  fi
else
  skip "frontend" "no changes under frontend/src or frontend/e2e"
fi

# ── Public docs ──────────────────────────────────────────────────────────────
if [ -n "$(changed '^docs/(guide|\.vitepress|public)/|^docs/[^/]*\.md$')" ]; then
  if [ -d docs/node_modules ] && [ -x api/.venv/bin/python ]; then
    run "docs build" "make docs-build"
  else
    echo "FAIL  docs build (needs docs/node_modules and api/.venv: 'cd docs && npm install', 'cd api && uv sync --extra dev')"
    FAILED=1
  fi
else
  skip "docs build" "no public docs changed; the decision log must say so if the feature is user-visible"
fi

# ── Decision log gate ────────────────────────────────────────────────────────
if [ -n "$(changed '^(api/graphlagoon|frontend/src)/')" ]; then
  if [ -z "$(changed '^docs/dev/decision_log\.md$')" ]; then
    echo "FAIL  decision log (code changed but docs/dev/decision_log.md has no new entry)"; FAILED=1
  else
    ADDED="$(git diff "$MERGE_BASE" -- docs/dev/decision_log.md | grep '^+' || true)"
    MISSING=""
    printf '%s' "$ADDED" | grep -qi 'public docs' || MISSING="$MISSING 'Public docs'"
    printf '%s' "$ADDED" | grep -qi 'admin-area'  || MISSING="$MISSING 'Admin-area impact'"
    if [ -n "$MISSING" ]; then
      echo "FAIL  decision log (new entry is missing the statement(s):$MISSING)"; FAILED=1
    else
      echo "PASS  decision log (entry states public-docs and admin-area impact)"
    fi
  fi
fi

if [ "$FAILED" = 0 ]; then echo "ALL CHECKS PASSED"; else echo "CHECKS FAILED"; fi
exit "$FAILED"
