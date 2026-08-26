const fs = require("fs");
const g = "scripts/ci/w4-context-guard.sh";
let s = fs.readFileSync(g, "utf8");
const nl = s.includes("\r\n") ? "\r\n" : "\n";
const anchor = '  if [ "$fail" -ne 0 ]; then';
if (!s.includes(anchor)) { console.error("MISS anchor"); process.exit(1); }
const block = [
  '  # ── CI-W4D-1: the approval route must stay a tenant transaction ──────────',
  '  APPROVE="app/api/documents/[id]/approve/route.ts"',
  '  if [ -f "$APPROVE" ] && ! grep -q "withTenantTransaction" "$APPROVE"; then',
  '    echo "CI-W4D-1 FAIL: approve route lost its tenant transaction"; fail=1',
  '  fi',
  '',
  '  # ── CI-W4D-2: learning-center global reads must use the admin client ─────',
  '  LC="lib/services/learning-center/learning-center-data.ts"',
  '  if [ -f "$LC" ]; then',
  '    grep -q "getPrismaAdmin" "$LC" || {',
  '      echo "CI-W4D-2 FAIL: learning-center left the admin client"; fail=1; }',
  '    if grep -qE \'from "@/lib/prisma"\' "$LC"; then',
  '      echo "CI-W4D-2 FAIL: learning-center imports the tenant client"; fail=1',
  '    fi',
  '  fi',
  '',
  '  # ── CI-W4D-3: dead vendor-learning service stays deleted ─────────────────',
  '  if [ -f "lib/services/documents/vendor-learning.service.ts" ]; then',
  '    echo "CI-W4D-3 FAIL: dead vendor-learning.service.ts resurrected"; fail=1',
  '  fi',
  '',
  '  # ── CI-W4D-4: indirect parent-join shapes present in the W4D migration ───',
  '  W4D_MIG="prisma/migrations/20260827090000_d2_p7_w4d_documents_tenant_rls/migration.sql"',
  '  if [ -f "$W4D_MIG" ]; then',
  '    grep -q \'"ExtractedData"."documentId"\' "$W4D_MIG" || {',
  '      echo "CI-W4D-4 FAIL: ExtractedData lost its parent-join policy"; fail=1; }',
  '    grep -q \'"ExtractionEvidence"."extractionSnapshotId"\' "$W4D_MIG" || {',
  '      echo "CI-W4D-4 FAIL: ExtractionEvidence lost its parent-join policy"; fail=1; }',
  '  fi',
  '',
  '  # ── CI-W4D-5: no global-Prisma W4D writes in the wired paths ─────────────',
  '  W4D_WRITE_RX="prisma\\.(document|extractedData|financialRecord|vendorLearning|extractionSnapshot|sliceDecision|extractionEvidence|reviewEvent)\\.(create|update|upsert|delete|createMany|updateMany)"',
  '  W4D_FILES="app/api/documents/[id]/approve/route.ts app/api/documents/[id]/process/route.ts app/api/documents/upload/route.ts lib/services/documents/create-document-from-ocr.service.ts lib/services/documents/ledger/correction-ledger.service.ts lib/services/documents/process-document-pipeline.service.ts app/api/integrations/gmail/import/route.ts"',
  '  for wf in $W4D_FILES; do',
  '    if [ -f "$wf" ] && grep -nE "$W4D_WRITE_RX" "$wf" >/dev/null; then',
  '      echo "CI-W4D-5 FAIL: $wf writes a W4D table on the global client"; fail=1',
  '    fi',
  '  done',
  '',
  '',
].join(nl);
s = s.replace(anchor, block + anchor);
s = s.replace('echo "W4-CONTEXT-GUARD OK — CI-W4-1..5 + CI-W4B-1..3 + CI-W4C-1..3 clean."',
  'echo "W4-CONTEXT-GUARD OK — CI-W4-1..5 + CI-W4B-1..3 + CI-W4C-1..3 + CI-W4D-1..5 clean."');

// Self-test: extend clean tree + 4 negatives.
const cleanAnchor = "    printf 'const businessId = verifiedState.state.businessId;\\n' >> \"$T/app/api/integrations/gmail/callback/route.ts\"";
if (!s.includes(cleanAnchor)) { console.error("MISS clean anchor"); process.exit(1); }
s = s.replace(cleanAnchor, [
  cleanAnchor,
  '    mkdir -p "$T/app/api/documents/[id]/approve" "$T/lib/services/learning-center" "$T/prisma/migrations/20260827090000_d2_p7_w4d_documents_tenant_rls"',
  '    printf \'withTenantTransaction\\n\' > "$T/app/api/documents/[id]/approve/route.ts"',
  '    printf \'import { getPrismaAdmin } from "x";\\n\' > "$T/lib/services/learning-center/learning-center-data.ts"',
  '    printf \'%s\\n%s\\n\' \'x "ExtractedData"."documentId" x\' \'x "ExtractionEvidence"."extractionSnapshotId" x\' > "$T/prisma/migrations/20260827090000_d2_p7_w4d_documents_tenant_rls/migration.sql"',
].join(nl));

const endAnchor = '  echo "self-test: ok=$ok bad=$bad"';
if (!s.includes(endAnchor)) { console.error("MISS end"); process.exit(1); }
s = s.replace(endAnchor, [
  '  local T13="$BASE/v13"; make_clean_tree "$T13"',
  '  printf \'no tx here\\n\' > "$T13/app/api/documents/[id]/approve/route.ts"',
  '  check "CI-W4D-1 catches approve without tenant tx" FAIL "$T13"',
  '',
  '  local T14="$BASE/v14"; make_clean_tree "$T14"',
  '  printf \'import { prisma } from "@/lib/prisma";\\n\' > "$T14/lib/services/learning-center/learning-center-data.ts"',
  '  check "CI-W4D-2 catches learning-center on tenant client" FAIL "$T14"',
  '',
  '  local T15="$BASE/v15"; make_clean_tree "$T15"',
  '  printf \'dead\\n\' > "$T15/lib/services/documents/vendor-learning.service.ts" 2>/dev/null || mkdir -p "$T15/lib/services/documents" && printf \'dead\\n\' > "$T15/lib/services/documents/vendor-learning.service.ts"',
  '  check "CI-W4D-3 catches resurrected dead code" FAIL "$T15"',
  '',
  '  local T16="$BASE/v16"; make_clean_tree "$T16"',
  '  printf \'%s\\n\' \'-- empty\' > "$T16/prisma/migrations/20260827090000_d2_p7_w4d_documents_tenant_rls/migration.sql"',
  '  check "CI-W4D-4 catches lost parent-join shapes" FAIL "$T16"',
  '',
  '  local T17="$BASE/v17"; make_clean_tree "$T17"',
  '  printf \'await prisma.financialRecord.create({});\\nwithTenantTransaction\\n\' > "$T17/app/api/documents/[id]/approve/route.ts"',
  '  check "CI-W4D-5 catches global-client W4D write" FAIL "$T17"',
  '',
  endAnchor,
].join(nl));
fs.writeFileSync(g, s);
console.log("guard extended");
