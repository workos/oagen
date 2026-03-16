#!/usr/bin/env bash
# GOAL.md fitness function — outputs a single composite score for oagen.
# Score = weighted(line_coverage, branch_coverage, function_coverage) with gates.
# Gated on: all tests pass, typecheck clean, structural lint clean.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# ── Gates (binary pass/fail — any failure ⇒ score 0) ────────────────────────
gate_fail() { echo "GATE FAILED: $1"; echo '{"score":0,"reason":"'"$1"'"}'; exit 0; }

# 1. Typecheck
npm run typecheck --silent 2>/dev/null || gate_fail "typecheck"

# 2. Structural lint
npm run lint:structure --silent 2>/dev/null || gate_fail "lint:structure"

# 3. Tests — capture pass/fail counts
TEST_OUTPUT=$(npx vitest run 2>&1) || true
TESTS_PASSED=$(echo "$TEST_OUTPUT" | grep -oE 'Tests  [0-9]+ passed' | grep -oE '[0-9]+' || echo 0)
TESTS_FAILED=$(echo "$TEST_OUTPUT" | grep -oE '[0-9]+ failed' | head -1 | grep -oE '[0-9]+' || echo 0)
TOTAL_TESTS=$((TESTS_PASSED + TESTS_FAILED))

if [ "$TESTS_FAILED" -gt 0 ]; then
  gate_fail "tests: $TESTS_FAILED of $TOTAL_TESTS failed"
fi

# ── Coverage (the actual score) ──────────────────────────────────────────────
# Run coverage on src/ only — excludes scripts/ and smoke tools
COV_OUTPUT=$(npx vitest run --coverage --coverage.include='src/**' --coverage.reporter=json-summary 2>&1) || true

# Parse coverage-summary.json
if [ ! -f coverage/coverage-summary.json ]; then
  echo "WARNING: coverage report not generated"
  echo '{"score":0,"reason":"coverage report missing"}'
  exit 0
fi

COV_JSON=$(cat coverage/coverage-summary.json)
LINE_COV=$(echo "$COV_JSON" | node -e "process.stdout.write(String(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).total.lines.pct))")
BRANCH_COV=$(echo "$COV_JSON" | node -e "process.stdout.write(String(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).total.branches.pct))")
FUNC_COV=$(echo "$COV_JSON" | node -e "process.stdout.write(String(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).total.functions.pct))")

# Composite: 50% lines + 30% branches + 20% functions
SCORE=$(node -e "
  const line = $LINE_COV;
  const branch = $BRANCH_COV;
  const func = $FUNC_COV;
  const score = (line * 0.50) + (branch * 0.30) + (func * 0.20);
  console.log(Math.round(score * 100) / 100);
")

# ── Output ───────────────────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════"
echo "  oagen fitness score: $SCORE"
echo "═══════════════════════════════════════"
echo "  Lines:      $LINE_COV%"
echo "  Branches:   $BRANCH_COV%"
echo "  Functions:  $FUNC_COV%"
echo "  Tests:      $TESTS_PASSED passed"
echo "  Typecheck:  ✓"
echo "  Structure:  ✓"
echo "═══════════════════════════════════════"
echo ""
echo "{\"score\":$SCORE,\"lines\":$LINE_COV,\"branches\":$BRANCH_COV,\"functions\":$FUNC_COV,\"tests_passed\":$TESTS_PASSED}"
