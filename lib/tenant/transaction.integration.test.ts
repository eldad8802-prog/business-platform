/**
 * D2 / P5-2 — Tenant Transaction Wrapper · DB integration proof (CI PG17).
 *
 * Runs the canonical Prisma client as a NON-BYPASS runtime role against
 * RLS-enabled fixtures, driving isolation via ALS -> withTenantTransaction ->
 * transaction-local GUC -> RLS. Fixtures + role + RLS are provisioned by the
 * workflow (as owner) before this runs. Requires env: DATABASE_URL (runtime
 * role), P2_A_ID, P2_B_ID.
 *
 * Run (CI): npx tsx lib/tenant/transaction.integration.test.ts
 */
import { prisma } from "../prisma";
import { runWithTenantContext } from "./context";
import { withTenantTransaction } from "./transaction";

const A = Number(process.env.P2_A_ID);
const B = Number(process.env.P2_B_ID);

let failures = 0;
function check(name: string, cond: boolean, extra = ""): void {
  const status = cond ? "PASS" : "FAIL";
  if (!cond) failures++;
  console.log(`  [${status}] ${name}${extra ? " — " + extra : ""}`);
}
async function gucOutside(): Promise<unknown> {
  const r = (await prisma.$queryRaw`SELECT current_setting('app.current_business_id', true) AS v`) as Array<{ v: unknown }>;
  return r[0].v;
}

(async () => {
  console.log(`Tenant Transaction Wrapper — P5-2 DB proof (A=${A} B=${B})\n`);

  // A. context=A -> sees only A
  const aCount = await runWithTenantContext({ businessId: A }, () => withTenantTransaction((tx) => tx.customer.count()));
  check("A. context=A sees only own (1)", aCount === 1, `count=${aCount}`);

  // B. context=B -> sees only B
  const bCount = await runWithTenantContext({ businessId: B }, () => withTenantTransaction((tx) => tx.customer.count()));
  check("B. context=B sees only own (1)", bCount === 1, `count=${bCount}`);

  // cross-tenant: A explicitly querying B -> 0
  const aSeesB = await runWithTenantContext({ businessId: A }, () => withTenantTransaction((tx) => tx.customer.count({ where: { businessId: B } })));
  check("cross: context=A cannot see B (0)", aSeesB === 0, `count=${aSeesB}`);

  // C. no ALS -> fail-closed (throws before any query)
  let noAls = false;
  try {
    await withTenantTransaction((tx) => tx.customer.count());
  } catch {
    noAls = true;
  }
  check("C. no-ALS fail-closed (throws before query)", noAls);

  // D. GUC transaction-local: unset outside a tenant tx; equals A inside
  const before = await gucOutside();
  check("D. GUC unset outside tenant tx", before === null || before === "", `v=${JSON.stringify(before)}`);
  const insideVal = await runWithTenantContext({ businessId: A }, () =>
    withTenantTransaction(async (tx) => {
      const r = (await tx.$queryRaw`SELECT current_setting('app.current_business_id', true) AS v`) as Array<{ v: unknown }>;
      return r[0].v;
    }),
  );
  check("D. GUC = A inside tenant tx", String(insideVal) === String(A), `v=${insideVal}`);

  // E. rollback: callback throws -> write rolled back + GUC not leaked
  let threwRb = false;
  try {
    await runWithTenantContext({ businessId: A }, () =>
      withTenantTransaction(async (tx) => {
        await tx.customer.create({ data: { businessId: A, name: "p2-a-rbtest" } });
        throw new Error("boom");
      }),
    );
  } catch {
    threwRb = true;
  }
  check("E. rollback: callback error propagates", threwRb);
  const rbLeft = await runWithTenantContext({ businessId: A }, () => withTenantTransaction((tx) => tx.customer.count({ where: { name: "p2-a-rbtest" } })));
  check("E. rollback: no row persisted", rbLeft === 0, `count=${rbLeft}`);
  const afterRb = await gucOutside();
  check("E. rollback: GUC not leaked on connection", afterRb === null || afterRb === "", `v=${JSON.stringify(afterRb)}`);

  // F. sequential A -> B on the same pool: no contamination
  const seqA = await runWithTenantContext({ businessId: A }, () => withTenantTransaction((tx) => tx.customer.count()));
  const seqB = await runWithTenantContext({ businessId: B }, () => withTenantTransaction((tx) => tx.customer.count()));
  check("F. sequential A/B no contamination", seqA === 1 && seqB === 1, `A=${seqA} B=${seqB}`);

  // G. concurrent A/B: each transaction sees only its own tenant
  const [cA, cB] = await Promise.all([
    runWithTenantContext({ businessId: A }, () => withTenantTransaction(async (tx) => tx.customer.count())),
    runWithTenantContext({ businessId: B }, () => withTenantTransaction(async (tx) => tx.customer.count())),
  ]);
  check("G. concurrent A/B isolated", cA === 1 && cB === 1, `A=${cA} B=${cB}`);

  await prisma.$disconnect();
  console.log(`\n${failures === 0 ? "ALL CHECKS PASS" : failures + " CHECK(S) FAILED"}`);
  process.exit(failures === 0 ? 0 : 1);
})();
