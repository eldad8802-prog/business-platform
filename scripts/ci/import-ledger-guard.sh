#!/usr/bin/env bash
# Import & Export Center / I-6 — the bulk-import execution ledger ratchet.
#
# The ledger is the only thing standing between a retried request and a second
# copy of every record it created. Nothing about that is enforced by a type, so
# it is enforced here: if the migration loses its tenant isolation, if the row
# marker becomes rewritable, if the run identity stops being scoped to a
# business, or if the executor stops writing the marker inside the transaction
# that writes the record, CI fails.
#
#   bash scripts/ci/import-ledger-guard.sh .            # check a tree
#   bash scripts/ci/import-ledger-guard.sh --self-test  # negative proofs
#
# NOTE ON PIPES: `grep -q` / `head -1` downstream of a pipe SIGPIPE the producer,
# which under `set -o pipefail` inverts results. Every check reads to EOF instead.

set -uo pipefail

MODE="check"
ROOT="${1:-.}"
if [ "${1:-}" = "--self-test" ]; then MODE="selftest"; ROOT="${2:-.}"; fi

PASS=0
FAIL=0
ok() {
  if [ "$2" = "1" ]; then PASS=$((PASS + 1)); echo "  [PASS] $1";
  else FAIL=$((FAIL + 1)); echo "  [FAIL] $1${3:+ — $3}"; fi
}

MIGDIR_REL="prisma/migrations/20260903090000_import_run_execution_ledger"
MIG="$ROOT/$MIGDIR_REL/migration.sql"
STORE_REL="lib/data-transfer/import/execute/import-run-store.ts"
EXEC_REL="lib/data-transfer/import/execute/import-executor.ts"
DUP_REL="lib/data-transfer/import/duplicates/duplicate-detect.ts"
STORE="$ROOT/$STORE_REL"
EXECUTOR="$ROOT/$EXEC_REL"
DUP="$ROOT/$DUP_REL"

# SQL with comments stripped, flattened to one line so multi-line policies match.
sqlcode() { grep -v '^[[:space:]]*--' "$1" 2>/dev/null | tr '\n' ' '; }
# TS with line comments stripped — these files document the constructs they forbid.
tscode() { sed 's://.*::' "$1" 2>/dev/null | tr '\n' ' '; }

run_checks() {
echo "== CI-IL: import execution ledger =="

for f in "$MIG:$MIGDIR_REL/migration.sql" "$STORE:$STORE_REL" "$EXECUTOR:$EXEC_REL"; do
  path="${f%%:*}"; rel="${f#*:}"
  if [ ! -f "$path" ]; then
    ok "CI-IL-0  $rel exists" 0 "missing"
    echo ""; echo "[CI-IL] PASS=$PASS FAIL=$FAIL"; exit 1
  fi
done
ok "CI-IL-0  ledger migration, store and executor all exist" 1

SQL="$(sqlcode "$MIG")"
STORE_TS="$(tscode "$STORE")"
EXEC_TS="$(tscode "$EXECUTOR")"

# --- 1..2. both ledger tables carry ENABLE + FORCE RLS ---------------------
i=1
for t in ImportRun ImportRunRow; do
  en=$(printf '%s' "$SQL" | grep -c "ALTER TABLE \"$t\" ENABLE ROW LEVEL SECURITY" || true)
  fo=$(printf '%s' "$SQL" | grep -c "ALTER TABLE \"$t\" FORCE ROW LEVEL SECURITY" || true)
  good=0
  [ "$en" -ge 1 ] && [ "$fo" -ge 1 ] && good=1
  ok "CI-IL-${i}  $t: ENABLE + FORCE row level security" "$good" "enable=$en force=$fo"
  i=$((i + 1))
done

# --- 3. ImportRun carries the exact canonical tenant predicate -------------
# Four clauses on ImportRun: SELECT USING, INSERT WITH CHECK, UPDATE USING,
# UPDATE WITH CHECK, DELETE USING = five. Asserted as a floor per policy below.
PRED='"businessId" = NULLIF(current_setting('"'"'app.current_business_id'"'"', true), '"''"')::int'
n=$(printf '%s' "$SQL" | grep -o "$PRED" | wc -l | tr -d ' ')
ok "CI-IL-3  the canonical tenant predicate is used, never a looser one" \
   "$([ "$n" -ge 5 ] && echo 1 || echo 0)" "found=$n expected>=5"

for p in read insert update delete; do
  case "$p" in
    read)   clause='FOR SELECT' ;;
    insert) clause='FOR INSERT' ;;
    update) clause='FOR UPDATE' ;;
    delete) clause='FOR DELETE' ;;
  esac
  n=$(printf '%s' "$SQL" | grep -c "CREATE POLICY p7imp_tenant_${p} ON \"ImportRun\" $clause" || true)
  ok "CI-IL-3${p}  ImportRun has a p7imp_tenant_${p} policy" \
     "$([ "$n" -ge 1 ] && echo 1 || echo 0)" "found=$n"
done

# --- 4. ImportRunRow reaches its tenant THROUGH its parent -----------------
# The table has no businessId of its own, so its policies must join ImportRun.
# A policy that forgot to would be permissive across every tenant.
for p in read insert delete; do
  n=$(printf '%s' "$SQL" | grep -c "CREATE POLICY p7imp_row_tenant_${p} ON \"ImportRunRow\"" || true)
  ok "CI-IL-4${p}  ImportRunRow has a p7imp_row_tenant_${p} policy" \
     "$([ "$n" -ge 1 ] && echo 1 || echo 0)" "found=$n"
done
n=$(printf '%s' "$SQL" | grep -o 'r."businessId" = NULLIF(current_setting' | wc -l | tr -d ' ')
ok "CI-IL-5  every ImportRunRow policy binds the tenant through its parent run" \
   "$([ "$n" -ge 3 ] && echo 1 || echo 0)" "parent joins=$n expected>=3"

# --- 6. THE marker is immutable -------------------------------------------
# No UPDATE policy and no UPDATE grant. Either one would make a recorded outcome
# rewritable, and the whole retry story depends on a marker meaning exactly one
# thing forever.
n=$(printf '%s' "$SQL" | grep -c 'ON "ImportRunRow" FOR UPDATE' || true)
ok "CI-IL-6  no UPDATE policy on ImportRunRow (a marker records finished work)" \
   "$([ "$n" -eq 0 ] && echo 1 || echo 0)" "found=$n"
n=$(printf '%s' "$SQL" | grep -o 'GRANT[^;]*ON "ImportRunRow" TO app_runtime' | grep -c 'UPDATE' || true)
ok "CI-IL-7  no UPDATE grant on ImportRunRow" \
   "$([ "$n" -eq 0 ] && echo 1 || echo 0)" "found=$n"

# --- 7b. and the privilege is actively REMOVED -----------------------------
# Not granting is not the same as not having. These databases carry ALTER
# DEFAULT PRIVILEGES giving app_runtime a,r,w,d on every NEW table, so the
# marker table arrives holding an UPDATE nobody asked for. Measured on a real
# branch; the migration must revoke it.
n=$(printf '%s' "$SQL" | grep -c 'REVOKE UPDATE ON "ImportRunRow" FROM app_runtime' || true)
ok "CI-IL-7b the default-privilege UPDATE on ImportRunRow is explicitly revoked" \
   "$([ "$n" -ge 1 ] && echo 1 || echo 0)" "found=$n"

# --- 8. FOR ALL silently includes UPDATE and DELETE ------------------------
n=$(printf '%s' "$SQL" | grep -c 'CREATE POLICY [a-z0-9_]* ON "Import[A-Za-z]*" FOR ALL' || true)
ok "CI-IL-8  zero FOR ALL policy (FOR ALL smuggles in UPDATE and DELETE)" \
   "$([ "$n" -eq 0 ] && echo 1 || echo 0)" "found=$n"

# --- 9. the run identity is TENANT-scoped ---------------------------------
# Without businessId in this index, one business's file could resolve to another
# business's run — and the executor would then skip rows it never wrote.
n=$(printf '%s' "$SQL" | grep -c 'ON "ImportRun"("businessId", "contentHash", "mappingHash", "decisionsHash")' || true)
ok "CI-IL-9  the run identity index is scoped by businessId" \
   "$([ "$n" -ge 1 ] && echo 1 || echo 0)" "found=$n"
n=$(printf '%s' "$SQL" | grep -c 'CREATE UNIQUE INDEX "ImportRun_businessId_contentHash_mappingHash_decisionsHash_key"' || true)
ok "CI-IL-10 the run identity is UNIQUE, which is what makes replay a lookup" \
   "$([ "$n" -ge 1 ] && echo 1 || echo 0)" "found=$n"

# --- 11. the marker is written INSIDE the caller's transaction ------------
# `markRow` taking a `tx` is the entire atomicity guarantee: record and marker
# commit together or not at all. A version that opened its own transaction would
# break it silently, so the signature is pinned.
n=$(printf '%s' "$STORE_TS" | grep -c 'export async function markRow(tx: TenantTx' || true)
ok "CI-IL-11 markRow takes the caller's transaction (record + marker are atomic)" \
   "$([ "$n" -ge 1 ] && echo 1 || echo 0)" "found=$n"

# --- 12. the executor never writes a record without marking it ------------
# Both call sites must mark first and write second, in one transaction.
n=$(printf '%s' "$EXEC_TS" | grep -o 'await markRow(tx,' | wc -l | tr -d ' ')
ok "CI-IL-12 every executor write path marks the row inside the transaction" \
   "$([ "$n" -ge 2 ] && echo 1 || echo 0)" "markRow(tx) call sites=$n expected>=2"
n=$(printf '%s' "$EXEC_TS" | grep -o 'writerFor(input.domainId)(' | wc -l | tr -d ' ')
ok "CI-IL-13 the domain writers are reached only from those same paths" \
   "$([ "$n" -eq 2 ] && echo 1 || echo 0)" "writer call sites=$n expected=2"

# --- 14. the ledger is only ever touched through the store ----------------
# Verifier files are excluded because they QUOTE these names in assertions —
# "the read-only lookup never creates" checks for the literal "importRun.create"
# — and a check that reads a name is not a module that reaches a table. The
# exclusion is narrow: it covers only *.verify.test.ts, which never ship (they
# are excluded from tsconfig too), and the self-proof below plants a violation
# in ordinary runtime code to confirm the check still bites.
n=$(grep -rl 'importRunRow\.\|importRun\.' --include=*.ts --include=*.tsx \
      "$ROOT/lib" "$ROOT/app" 2>/dev/null \
      | grep -v "$STORE_REL" | grep -v '\.verify\.test\.ts$' | wc -l | tr -d ' ')
ok "CI-IL-14 no module reaches the ledger tables outside the store" \
   "$([ "$n" -eq 0 ] && echo 1 || echo 0)" "other files=$n"

# --- 15. the duplicate lookup stays tenant-bound --------------------------
# Execute re-runs this lookup. If it stopped filtering by businessId it would
# match another tenant's records and silently skip rows as "already there".
# Counted against the number of lookups rather than a fixed floor, so a NEW
# lookup that forgets its tenant filter fails too. Whitespace-tolerant: these
# clauses are formatted both inline and multi-line.
DUP_TS="$(tscode "$DUP")"
lookups=$(printf '%s' "$DUP_TS" | grep -oE '\.[a-zA-Z]+\.findMany\(' | wc -l | tr -d ' ')
scoped=$(printf '%s' "$DUP_TS" | grep -oE 'where:[[:space:]]*\{[[:space:]]*businessId' | wc -l | tr -d ' ')
ok "CI-IL-15 every existing-record lookup filters by businessId" \
   "$([ "$lookups" -ge 4 ] && [ "$scoped" -eq "$lookups" ] && echo 1 || echo 0)" \
   "lookups=$lookups tenant-scoped=$scoped"
n=$(printf '%s' "$(tscode "$DUP")" | grep -c 'withTenantTransaction' || true)
ok "CI-IL-16 the lookup runs inside the tenant transaction substrate" \
   "$([ "$n" -ge 1 ] && echo 1 || echo 0)" "found=$n"

echo ""
echo "[CI-IL] PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
}

selftest() {
  local src="$ROOT" sp=0 sf=0
  probe() { # probe <label> <expected-failing-check> <mutator>
    local label="$1" expect="$2" mut="$3" tmp
    tmp="$(mktemp -d)"
    mkdir -p "$tmp/$MIGDIR_REL" "$tmp/lib/data-transfer/import/execute" \
             "$tmp/lib/data-transfer/import/duplicates" "$tmp/app"
    cp "$src/$MIGDIR_REL/migration.sql" "$tmp/$MIGDIR_REL/migration.sql"
    cp "$src/$STORE_REL" "$tmp/$STORE_REL"
    cp "$src/$EXEC_REL" "$tmp/$EXEC_REL"
    cp "$src/$DUP_REL" "$tmp/$DUP_REL"
    "$mut" "$tmp"
    local out; out="$(bash "$src/scripts/ci/import-ledger-guard.sh" "$tmp" 2>&1)"
    local caught=0
    case "$out" in *"[FAIL] $expect"*) caught=1 ;; esac
    if [ "$caught" = "1" ]; then sp=$((sp+1)); echo "  [PASS] negative: $label -> $expect fails as designed";
    else sf=$((sf+1)); echo "  [FAIL] negative: $label -> $expect did NOT fail (guard is decorative)"; fi
    rm -rf "$tmp"
  }

  M() { echo "$1/$MIGDIR_REL/migration.sql"; }

  # RLS quietly removed from a ledger table.
  m_drop_force() { perl -0pi -e 's/ALTER TABLE "ImportRunRow" FORCE ROW LEVEL SECURITY;//' "$(M "$1")"; }
  m_drop_enable() { perl -0pi -e 's/ALTER TABLE "ImportRun" ENABLE ROW LEVEL SECURITY;//' "$(M "$1")"; }
  # The parent join dropped from a row policy: every tenant would see every marker.
  m_orphan_row_policy() {
    perl -0pi -e 's/r\."businessId" = NULLIF\(current_setting/1 = 1 OR r."x" = NULLIF(current_setting/' "$(M "$1")";
  }
  # The marker becomes rewritable — history could then be edited.
  m_row_update_policy() { printf '\nCREATE POLICY p7imp_row_upd ON "ImportRunRow" FOR UPDATE USING (true);\n' >> "$(M "$1")"; }
  m_row_update_grant() { perl -0pi -e 's/GRANT SELECT, INSERT, DELETE ON "ImportRunRow"/GRANT SELECT, INSERT, UPDATE, DELETE ON "ImportRunRow"/' "$(M "$1")"; }
  m_for_all() { perl -0pi -e 's/CREATE POLICY p7imp_tenant_read ON "ImportRun" FOR SELECT/CREATE POLICY p7imp_tenant_read ON "ImportRun" FOR ALL/' "$(M "$1")"; }
  # Removing the revoke leaves the marker UPDATE-able by default privileges.
  m_drop_revoke() { perl -pi -e 's/REVOKE UPDATE ON "ImportRunRow" FROM app_runtime;//' "$(M "$1")"; }
  # The run identity stops being tenant-scoped — the defect the owner named.
  m_unscoped_identity() {
    perl -0pi -e 's/ON "ImportRun"\("businessId", "contentHash", "mappingHash", "decisionsHash"\)/ON "ImportRun"("contentHash", "mappingHash", "decisionsHash")/' "$(M "$1")"
  }
  # The idempotency index downgraded to a plain index.
  m_nonunique_identity() {
    perl -0pi -e 's/CREATE UNIQUE INDEX "ImportRun_businessId_contentHash_mappingHash_decisionsHash_key"/CREATE INDEX "ImportRun_businessId_contentHash_mappingHash_decisionsHash_key"/' "$(M "$1")"
  }
  # The marker stops sharing the caller's transaction: a record could commit
  # without its marker, and a retry would create it a second time.
  m_marker_own_tx() {
    perl -0pi -e 's/export async function markRow\(tx: TenantTx/export async function markRow(tx2: TenantTx/' "$1/$STORE_REL"
  }
  # A write path that marks nothing.
  # Line-ending agnostic on purpose: this repo checks out CRLF on Windows and LF
  # in CI, and a multi-line pattern that silently stopped matching would leave
  # the guard looking proven while proving nothing.
  m_unmarked_write() {
    perl -pi -e 's/await markRow\(tx,/await skipTheMarker(tx,/' "$1/$EXEC_REL";
  }
  # The tenant filter dropped from the duplicate lookup: rows would be matched
  # against another business's records.
  m_untenanted_lookup() {
    perl -0pi -e 's/where: \{ businessId/where: { xbusinessId/g' "$1/$DUP_REL"
  }
  # Some other module writing the ledger directly, bypassing the store.
  m_bypass_store() {
    mkdir -p "$1/lib/rogue"
    printf 'export const x = async (tx: any) => tx.importRunRow.create({ data: {} });\n' > "$1/lib/rogue/rogue.ts"
  }

  echo ""
  echo "== CI-IL negative self-proofs =="
  probe "FORCE RLS removed from ImportRunRow"            "CI-IL-2"      m_drop_force
  probe "RLS disabled on ImportRun"                      "CI-IL-1"      m_drop_enable
  probe "a row policy stops joining its parent run"      "CI-IL-5"      m_orphan_row_policy
  probe "the row marker becomes UPDATE-able"             "CI-IL-6"      m_row_update_policy
  probe "an UPDATE grant on the row marker"              "CI-IL-7"      m_row_update_grant
  probe "the default-privilege UPDATE revoke is dropped" "CI-IL-7b"     m_drop_revoke
  probe "a policy is widened to FOR ALL"                 "CI-IL-8"      m_for_all
  probe "the run identity loses businessId"              "CI-IL-9"      m_unscoped_identity
  probe "the run identity stops being unique"            "CI-IL-10"     m_nonunique_identity
  probe "markRow stops taking the caller's transaction"  "CI-IL-11"     m_marker_own_tx
  probe "a write path that marks nothing"                "CI-IL-12"     m_unmarked_write
  probe "the duplicate lookup drops its tenant filter"   "CI-IL-15"     m_untenanted_lookup
  probe "a module writes the ledger outside the store"   "CI-IL-14"     m_bypass_store

  echo ""
  echo "[CI-IL self-test] PASS=$sp FAIL=$sf"
  [ "$sf" -eq 0 ] || exit 1
}

if [ "$MODE" = "selftest" ]; then selftest; else run_checks; fi
