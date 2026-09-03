#!/usr/bin/env bash
#
# PHASE 6 probe — a single, deliberately harmless observation.
#
# PURPOSE
#
# The release guard needs to know WHICH COMMIT it is being asked to deploy. The
# design assumes `VERCEL_GIT_COMMIT_SHA` is present inside the Ignored Build
# Step. That is an assumption, not a verified fact: Vercel documents the variable
# for the build environment, but the Ignored Build Step runs earlier than the
# build — before dependencies are installed — and the docs do not enumerate what
# is exported at that point.
#
# Rather than guess, or quietly fall back to reading the working tree (which
# would weaken the SHA binding the whole guard rests on), this probe asks Vercel
# directly and reports what it finds.
#
# SAFETY
#
# This script CANNOT block a deployment. It reads no attestation, contacts no
# database, needs no token, and ends with `exit 1` on every path — which in
# Vercel's inverted convention means "build normally". Its only effect is text in
# the build log.
#
# It is inert until someone sets it as a project's Ignored Build Step, and it is
# intended for `business-platform-btrl` only.
#
# WHAT TO DO WITH THE RESULT
#
#   present -> the guard uses VERCEL_GIT_COMMIT_SHA as the target SHA.
#   absent  -> STOP. Do not invent a fallback. The guard's promise is about a
#              specific commit; without the commit id that promise weakens, and
#              that is a decision for the owner, not for the implementation.

echo "──────────────────────────────────────────────────────────────"
echo "release-guard SHA probe — observation only, never blocks"
echo "──────────────────────────────────────────────────────────────"

echo "VERCEL_ENV                 = ${VERCEL_ENV:-<unset>}"
echo "VERCEL_TARGET_ENV          = ${VERCEL_TARGET_ENV:-<unset>}"

if [ -n "${VERCEL_GIT_COMMIT_SHA:-}" ]; then
  echo "VERCEL_GIT_COMMIT_SHA      = PRESENT (${VERCEL_GIT_COMMIT_SHA})"
  echo "PROBE RESULT               = SHA_AVAILABLE"
else
  echo "VERCEL_GIT_COMMIT_SHA      = ABSENT"
  echo "PROBE RESULT               = SHA_MISSING  <-- STOP, report before proceeding"
fi

# Supporting context: if the commit sha is missing, these tell us whether ANY
# git identity is exported, which changes what options exist.
echo "VERCEL_GIT_COMMIT_REF      = ${VERCEL_GIT_COMMIT_REF:-<unset>}"
echo "VERCEL_GIT_REPO_SLUG       = ${VERCEL_GIT_REPO_SLUG:-<unset>}"
echo "VERCEL_GIT_PROVIDER        = ${VERCEL_GIT_PROVIDER:-<unset>}"
echo "VERCEL_GIT_PULL_REQUEST_ID = ${VERCEL_GIT_PULL_REQUEST_ID:-<unset>}"

# Does the guard's other input — the migrations directory — exist this early?
if [ -d "prisma/migrations" ]; then
  echo "prisma/migrations          = present ($(find prisma/migrations -name migration.sql 2>/dev/null | wc -l | tr -d ' ') migration files)"
else
  echo "prisma/migrations          = ABSENT at ignore-step time"
fi

# Is a JavaScript runtime available before the install command runs?
if command -v node >/dev/null 2>&1; then
  echo "node                       = $(node --version 2>/dev/null)"
else
  echo "node                       = NOT AVAILABLE"
fi

echo "──────────────────────────────────────────────────────────────"

# ALWAYS build. This probe must never be the reason a deployment did not happen.
exit 1
