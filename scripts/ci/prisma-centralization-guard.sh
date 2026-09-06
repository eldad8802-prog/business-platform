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
#   - lib/prisma.ts           the canonical tenant singleton
#   - lib/prisma-admin.ts     the SANCTIONED admin client (D2/P7-W2-GATE; its
#                             import surface is enforced by admin-boundary-guard)
#   - lib/prisma-control-plane.ts  the SANCTIONED control-plane client
#                             (D2/PRIVILEGED-WRITE-2; its import surface is
#                             enforced by privwrite-guard CI-PRIVWRITE-7/8)
#   - lib/prisma-auth.ts      the SANCTIONED auth/bootstrap client
#                             (D2/AUTH-BOUNDARY-STEP-2). Login, session
#                             validation and signup must reach User/Business
#                             through an identity that tenant traffic does not
#                             hold — that separation is what lets app_runtime
#                             lose the access. Its import surface is enforced
#                             by admin-boundary-guard CI-2a/2b/2c.
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
    | grep -vE "(^|/)lib/prisma-admin\.ts:" \
    | grep -vE "(^|/)lib/prisma-control-plane\.ts:" \
    | grep -vE "(^|/)lib/prisma-auth\.ts:" \
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
