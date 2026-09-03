#!/usr/bin/env bash
#
# Vercel "Ignored Build Step" wrapper for the release guard.
#
# ┌──────────────────────────────────────────────────────────────────────────┐
# │ VERCEL'S EXIT CODES ARE INVERTED FROM SHELL CONVENTION.                   │
# │                                                                          │
# │   exit 0  ->  build is ABORTED, deployment state becomes CANCELED        │
# │   exit 1  ->  build CONTINUES as normal                                  │
# │                                                                          │
# │ So a script that crashes — command not found, `set -e` on a failed        │
# │ command, an unset variable — exits NON-ZERO and therefore DEPLOYS. The    │
# │ naive failure mode of this file is fail-OPEN, which is exactly the        │
# │ outage it exists to prevent.                                             │
# │                                                                          │
# │ Therefore: `exit 1` is reachable from exactly TWO places, both below,     │
# │ and every other path — including every error — must reach `exit 0`.      │
# │ Deliberately NO `set -e`: it would turn an incidental non-zero command    │
# │ into a deploy.                                                           │
# └──────────────────────────────────────────────────────────────────────────┘

block() {
  echo "release-guard: ${1}${2:+: $2}" >&2
  exit 0
}

# Any unhandled error anywhere becomes a block, never a deploy.
trap 'block "BLOCKED — RELEASE GUARD CANNOT VERIFY PRODUCTION" "guard wrapper crashed"' ERR
trap 'block "BLOCKED — RELEASE GUARD CANNOT VERIFY PRODUCTION" "guard wrapper interrupted"' INT TERM

# ─────────────────────────────────────────────── 1 of 2: non-production ──────
# Preview and Development build normally. They never read the attestation, never
# use the production token, and never touch the production database. This is the
# first statement on purpose: no other code runs for a preview.
if [ "${VERCEL_ENV:-}" != "production" ]; then
  echo "release-guard: VERCEL_ENV=${VERCEL_ENV:-unset} — not production, building normally"
  exit 1
fi

command -v node >/dev/null 2>&1 || \
  block "BLOCKED — RELEASE GUARD CANNOT VERIFY PRODUCTION" "node not available"

GUARD="$(dirname "$0")/release-guard.mjs"
[ -f "$GUARD" ] || \
  block "BLOCKED — RELEASE GUARD CANNOT VERIFY PRODUCTION" "guard script missing"

# The guard uses normal Node conventions: 0 = safe, non-zero = block. The
# inversion happens here and nowhere else.
if node "$GUARD"; then
  # ───────────────────────────────── 2 of 2: production, proven safe ────────
  echo "release-guard: proven safe — continuing build"
  exit 1
fi

# Guard already printed its specific reason (NOT APPLIED / ANOMALY / CANNOT
# VERIFY). Do not overwrite it with a generic one.
echo "release-guard: deployment blocked — see reason above" >&2
exit 0
