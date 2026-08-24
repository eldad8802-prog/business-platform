#!/usr/bin/env bash
#
# D2 / P7-W2-GATE — platform-admin boundary guard (CI-2 / CI-3 / CI-4).
#
# CI-2  admin-client isolation: `@/lib/prisma-admin` (or a relative path to it)
#       may be imported ONLY under the approved admin modules:
#         app/api/platform-admin/**  app/api/dev/**
#         lib/services/platform-admin/**  lib/services/learning-center/**
#       (+ lib/prisma-admin.ts itself, tests, mocks). Tenant feature code must
#       never see the admin credential.
#
# CI-3  canonical admin guard: every route.ts under app/api/platform-admin/**
#       and app/api/dev/** must call requirePlatformAdmin[OrResponse]. No
#       allowlist — an admin route without the canonical guard is a failure.
#
# CI-4  no tenant Prisma in admin services: files under
#       lib/services/platform-admin/** must not import `@/lib/prisma` — global
#       admin reads must use the sanctioned admin client (otherwise tenant RLS
#       silently zeroes them). A LEGACY list names the not-yet-migrated
#       services; it may only SHRINK. New admin services must start on the
#       admin client.
#
# Usage: scripts/ci/admin-boundary-guard.sh [ROOT]
# Exit 0 = clean; exit 1 = violation (with offender list).
set -euo pipefail

ROOT="${1:-.}"
fail=0

# ---------- CI-2: admin-client import isolation ----------
ci2="$(
  grep -rnE "from ['\"](@/lib/prisma-admin|[./]+lib/prisma-admin|[./]+prisma-admin)['\"]" \
    "$ROOT/app" "$ROOT/lib" \
    --include="*.ts" --include="*.tsx" 2>/dev/null \
    | grep -vE "(^|/)app/api/platform-admin/" \
    | grep -vE "(^|/)app/api/dev/" \
    | grep -vE "(^|/)lib/services/platform-admin/" \
    | grep -vE "(^|/)lib/services/learning-center/" \
    | grep -vE "(^|/)lib/prisma-admin\.ts:" \
    | grep -vE "\.test\.ts:|/__mocks__/" \
    || true
)"
if [ -n "$ci2" ]; then
  echo "CI-2 VIOLATION — prisma-admin imported outside approved admin modules:"
  echo "$ci2"
  fail=1
fi

# ---------- CI-3: canonical guard on every admin route ----------
while IFS= read -r route; do
  if ! grep -qE "requirePlatformAdmin(OrResponse)?" "$route"; then
    echo "CI-3 VIOLATION — admin route without canonical requirePlatformAdmin guard: $route"
    fail=1
  fi
done < <(find "$ROOT/app/api/platform-admin" "$ROOT/app/api/dev" -name "route.ts" 2>/dev/null)

# ---------- CI-4: no tenant Prisma inside admin services (ratchet) ----------
# Legacy = admin services still on the tenant singleton, pending migration.
# This list may only shrink; removing an entry after migrating it is mandatory.
CI4_LEGACY_REGEX="platform-(overview|attention|businesses|business-detail|usage-overview|audit)\.service\.ts"
ci4="$(
  grep -rnE "from ['\"]@/lib/prisma['\"]" \
    "$ROOT/lib/services/platform-admin" \
    --include="*.ts" 2>/dev/null \
    | grep -vE "$CI4_LEGACY_REGEX" \
    | grep -vE "\.test\.ts:" \
    || true
)"
if [ -n "$ci4" ]; then
  echo "CI-4 VIOLATION — tenant prisma imported by a non-legacy admin service:"
  echo "$ci4"
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  echo ""
  echo "Fix: admin DB access goes through lib/prisma-admin.ts inside approved admin modules only;"
  echo "     every admin route calls requirePlatformAdmin; new admin services never import @/lib/prisma."
  exit 1
fi

echo "ADMIN-BOUNDARY OK — CI-2 isolation, CI-3 guards, CI-4 ratchet all clean."
