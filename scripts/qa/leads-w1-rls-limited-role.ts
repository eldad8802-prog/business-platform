/**
 * Leads W1 — DB-level RLS enforcement proof under a LEAST-PRIVILEGE role.
 *
 * Production runtime still connects as `neondb_owner` (BYPASSRLS), so RLS is
 * INERT in Production today and must never be reported as production-enforced.
 * This script proves the other half: that the policies shipped by the three
 * pending migrations DO enforce once a non-bypass role is used — which is the
 * posture D2 is heading toward.
 *
 * Run against a THROWAWAY clone only, with DATABASE_URL pointing at the clone
 * as the limited role:
 *
 *   DATABASE_URL="postgresql://gate_runtime:...@<clone-host>/neondb?sslmode=require" \
 *     npx tsx scripts/qa/leads-w1-rls-limited-role.ts
 *
 * The GUC is transaction-local (`set_config(..., true)`), exactly as
 * `withTenantTransaction` sets it.
 */
import { prisma } from "@/lib/prisma";

let passed = 0;
const failures: string[] = [];

function ok(label: string) {
  passed += 1;
  console.log(`  ok  ${label}`);
}
function bad(label: string, detail: string) {
  failures.push(`${label} — ${detail}`);
  console.log(`  FAIL  ${label} — ${detail}`);
}
function check(cond: boolean, label: string, detail = "assertion failed") {
  if (cond) ok(label);
  else bad(label, detail);
}

/** Count rows of `table` as the connected role, with an optional tenant GUC. */
async function countAs(table: string, businessId: number | null): Promise<number | string> {
  try {
    return await prisma.$transaction(async (tx) => {
      if (businessId !== null) {
        await tx.$queryRaw`SELECT set_config('app.current_business_id', ${String(businessId)}, true)`;
      }
      const rows = await tx.$queryRawUnsafe<Array<{ n: bigint }>>(
        `SELECT count(*)::bigint AS n FROM "${table}"`
      );
      return Number(rows[0].n);
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/permission denied/i.test(msg)) return "PERMISSION_DENIED";
    return `ERROR:${msg.slice(0, 80)}`;
  }
}

async function main() {
  const who = await prisma.$queryRaw<Array<{ u: string; bypass: boolean }>>`
    SELECT current_user AS u, (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass`;
  console.log(`connected as: ${who[0].u} (bypassrls=${who[0].bypass})\n`);
  check(who[0].bypass === false, "role is NOBYPASSRLS (a real enforcement test)", `bypass=${who[0].bypass}`);

  /* ---------------------------------------------- W4D — Document (RLS) ---- */
  const docNoGuc = await countAs("Document", null);
  check(docNoGuc === 0, "W4D Document: NO tenant GUC → 0 rows (fail-closed)", `got ${docNoGuc}`);

  const docB3 = await countAs("Document", 3);
  check(docB3 === 82, "W4D Document: GUC=3 → exactly that tenant's 82 documents", `got ${docB3}`);

  const docB1 = await countAs("Document", 1);
  check(docB1 === 79, "W4D Document: GUC=1 → exactly that tenant's 79 documents", `got ${docB1}`);

  const docB9 = await countAs("Document", 9);
  check(docB9 === 2, "W4D Document: GUC=9 → exactly that tenant's 2 documents", `got ${docB9}`);

  /* ------------------------------------- W4EA — PaymentTransaction (RLS) -- */
  const payNoGuc = await countAs("PaymentTransaction", null);
  check(payNoGuc === 0, "W4EA PaymentTransaction: NO tenant GUC → 0 rows", `got ${payNoGuc}`);

  const payAll = await countAs("PaymentTransaction", 9);
  check(
    typeof payAll === "number",
    "W4EA PaymentTransaction: readable with a GUC in scope",
    `got ${payAll}`
  );

  /* ------------------------------------------- cross-tenant write refusal - */
  let crossTenantRefused = false;
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.current_business_id', '3', true)`;
      // Tenant 3 is in scope; try to write a Document belonging to tenant 1.
      await tx.$executeRawUnsafe(
        `INSERT INTO "Document" ("businessId","fileUrl","source","mimeType","status","createdAt")
         VALUES (1,'gate/proof.pdf','gate-proof','application/pdf','uploaded',now())`
      );
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/row-level security|violates row-level/i.test(msg)) crossTenantRefused = true;
    else crossTenantRefused = /permission denied/i.test(msg) ? false : crossTenantRefused;
    if (!crossTenantRefused) bad("W4D cross-tenant INSERT refused", msg.slice(0, 140));
  }
  if (crossTenantRefused) ok("W4D cross-tenant INSERT is refused by the WITH CHECK predicate");

  /* --------------------------------------------------- Lead (Leads W1) ---- */
  const leadRead = await countAs("Lead", 9);
  if (leadRead === "PERMISSION_DENIED") {
    bad(
      "LEADS Lead is readable by the runtime role",
      "PERMISSION DENIED — Lead is RLS-forced but was never added to a grants artifact"
    );
  } else {
    check(typeof leadRead === "number", "LEADS Lead is readable by the runtime role", `got ${leadRead}`);
    const leadNoGuc = await countAs("Lead", null);
    check(leadNoGuc === 0, "LEADS Lead: NO tenant GUC → 0 rows (fail-closed)", `got ${leadNoGuc}`);
  }

  console.log("");
  if (failures.length) {
    console.log(`LIMITED-ROLE RLS PROOF — ${passed} passed, ${failures.length} failed`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log(`LIMITED-ROLE RLS PROOF PASS — ${passed} checks green.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => {});
  });
