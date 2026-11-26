#!/usr/bin/env bash
# Owner requirement R10 — the previous application on the new schema. Generates the Prisma Client of the BASE schema
# (main before this package; BASE_REF, default origin/main) into a throwaway project directory — never into the shared
# node_modules — and runs .apc/old-code.ts with it against <db>, a lab where this migration is applied
# (.apc/lab.sh <db> --with-apc).
#
#   .apc/old-code.sh <db-name>
#
# The throwaway project has its own package.json and a LINK to this checkout's node_modules, so `prisma generate` finds
# the installed prisma (no auto-install) and writes only to the explicit output directory. The link is removed as a
# link (rmdir on a junction / rm on a symlink), never followed.
#
# env: PGHOST, PGPORT, LAB_PASSWORD (optional), BASE_REF (optional). Synthetic only. ZERO secrets.
set -euo pipefail
DB="$1"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASE_REF="${BASE_REF:-origin/main}"
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
( cd "$TMP" && PRISMA_GENERATE_SKIP_AUTOINSTALL=1 DATABASE_URL="postgresql://x@localhost/x" DIRECT_URL="postgresql://x@localhost/x" \
  node_modules/.bin/prisma generate --schema schema.prisma >/dev/null )
[ -f "$TMP/client/index.js" ] || { echo "old client was not generated" >&2; exit 1; }
CRED="${LAB_PASSWORD:+:${LAB_PASSWORD}}"
TZQ="options=-c%20TimeZone%3DAsia%2FJerusalem"
set +e
( cd "$ROOT" && OLD_CLIENT="$OUT" \
  OWNER_URL="postgresql://lab_owner${CRED}@${PGHOST}:${PGPORT}/${DB}?$TZQ" \
  RUNTIME_URL="postgresql://app_runtime_prod${CRED}@${PGHOST}:${PGPORT}/${DB}?$TZQ" \
  node_modules/.bin/tsx .apc/old-code.ts )
rc=$?
set -e
exit $rc
