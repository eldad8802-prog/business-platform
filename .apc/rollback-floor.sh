#!/usr/bin/env bash
# Release item 5 — the rollback floor, measured. <db> is a lab where 20261230090000 is applied (.apc/lab.sh <db> --with-apc).
#
#   .apc/rollback-floor.sh <db-name>
#
#   1. FLOOR: this checkout's own Prisma Client (the release that ships this schema) reads every touched table, without
#      a filter, beside rows of every new kind E / F / G write → must pass (MODE=floor).
#   2. BELOW THE FLOOR: main's client from before this package (BASE_REF, default origin/main), generated into a
#      throwaway project (never into node_modules), on the same rows → the failing reads are LISTED (MODE=report): the
#      evidence for "no code rollback below the floor once the migration is applied".
#
# env: PGHOST, PGPORT, LAB_PASSWORD (optional), BASE_REF (optional). Synthetic only. ZERO secrets.
set -euo pipefail
DB="$1"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASE_REF="${BASE_REF:-origin/main}"
CRED="${LAB_PASSWORD:+:${LAB_PASSWORD}}"
TZQ="options=-c%20TimeZone%3DAsia%2FJerusalem"
export OWNER_URL="postgresql://lab_owner${CRED}@${PGHOST}:${PGPORT}/${DB}?$TZQ"
export RUNTIME_URL="postgresql://app_runtime_prod${CRED}@${PGHOST}:${PGPORT}/${DB}?$TZQ"

echo "== 1. the floor: this package's client"
( cd "$ROOT" && CLIENT=@prisma/client MODE=floor node_modules/.bin/tsx .apc/rollback-floor.ts )

echo "== 2. below the floor: main's client before the package ($BASE_REF)"
TMP="$(mktemp -d)"
win() { if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else echo "$1"; fi; }
cleanup() {
  if [ -e "$TMP/node_modules" ] || [ -L "$TMP/node_modules" ]; then
    if command -v cmd.exe >/dev/null 2>&1; then MSYS_NO_PATHCONV=1 cmd.exe /c rmdir "$(win "$TMP/node_modules")" >/dev/null; else rm -f "$TMP/node_modules"; fi
  fi
  [ -e "$TMP/node_modules" ] || rm -rf "$TMP"
}
trap cleanup EXIT
git -C "$ROOT" show "$BASE_REF:prisma/schema.prisma" > "$TMP/schema.prisma"
if grep -q "model AppointmentSeries" "$TMP/schema.prisma"; then echo "$BASE_REF already models this package; not an old schema"; exit 1; fi
printf '{ "name": "apc-old-client", "private": true }\n' > "$TMP/package.json"
if command -v cmd.exe >/dev/null 2>&1; then
  MSYS_NO_PATHCONV=1 cmd.exe /c mklink /J "$(win "$TMP/node_modules")" "$(win "$ROOT/node_modules")" >/dev/null
else
  ln -s "$ROOT/node_modules" "$TMP/node_modules"
fi
OUT="$(win "$TMP/client" | tr '\\' '/')"
node -e '
const fs = require("fs"); const p = process.argv[1]; let s = fs.readFileSync(p, "utf8");
s = s.replace(/generator client \{/, "generator client {\n  output = \"" + process.argv[2] + "\"");
fs.writeFileSync(p, s);' "$TMP/schema.prisma" "$OUT"
( cd "$TMP" && DATABASE_URL="postgresql://x@localhost/x" DIRECT_URL="postgresql://x@localhost/x" node_modules/.bin/prisma generate --schema schema.prisma >/dev/null )
( cd "$ROOT" && CLIENT="$OUT" MODE=report node_modules/.bin/tsx .apc/rollback-floor.ts )
