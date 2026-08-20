#!/usr/bin/env bash
#
# CI-1 — Prisma Client Centralization guard (D2 / P5-3).
#
# Invariant: production tenant-scoped runtime code must use the canonical Prisma
# client (lib/prisma.ts) and must NOT instantiate ad-hoc `new PrismaClient(...)`.
#
# Scans the production runtime surface (app/ + lib/) only. Deliberately does NOT
# scan node_modules, generated code, build outputs, or scripts/ (isolated tooling).
#
# Explicit, minimal allowlist (NOT a broad app/** or lib/** exception):
#   - lib/prisma.ts           the canonical singleton (the one permitted instantiation)
#   - *.test.ts / *.deps.ts   test / dependency-injection seam files
#   - **/__mocks__/**         test mocks
#
# Usage:
#   scripts/ci/prisma-centralization-guard.sh [ROOT]   (ROOT defaults to repo root)
# Exit 0 = clean; exit 1 = violation (with offender list).
set -euo pipefail

ROOT="${1:-.}"

matches="$(
  grep -rnE "new[[:space:]]+PrismaClient[[:space:]]*\(" \
    "$ROOT/app" "$ROOT/lib" \
    --include="*.ts" --include="*.tsx" 2>/dev/null \
    | grep -vE "(^|/)lib/prisma\.ts:" \
    | grep -vE "\.test\.ts:|\.deps\.ts:|/__mocks__/" \
    || true
)"

if [ -n "$matches" ]; then
  echo "CI-1 VIOLATION — ad-hoc PrismaClient outside the canonical lib/prisma.ts:"
  echo "$matches"
  echo ""
  echo "Fix: import { prisma } from \"@/lib/prisma\" instead of new PrismaClient()."
  exit 1
fi

echo "CI-1 OK — no ad-hoc PrismaClient in app/ or lib/ (canonical: lib/prisma.ts)."
