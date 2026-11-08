/**
 * The optional isolationLevel of withTenantTransaction / tenantTx (business documents, owner-approved 2026-11-06)
 * leaves every existing caller exactly as it was. Pure: the Prisma singleton's $transaction is replaced by a
 * recorder, so this proves what the helpers HAND to Prisma — the database-level proof (READ COMMITTED by default,
 * REPEATABLE READ only when asked) is in .business-documents/service.battery.mts.
 *   npx tsx lib/tenant/tenant-tx-options.test.ts
 */
import { prisma } from "../prisma";
import { runWithTenantContext } from "./context";
import { tenantTx } from "./tenant-tx";
import { withTenantTransaction } from "./transaction";

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`  [PASS] ${name}`);
  } else {
    failures.push(name);
    console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`);
  }
}

type Call = { argCount: number; options: unknown; firstStatement: string };
const calls: Call[] = [];
const fakeTx = {
  statements: [] as string[],
  $queryRaw(strings: TemplateStringsArray) {
    this.statements.push(strings.join("?"));
    return Promise.resolve([]);
  },
};
// The recorder: what would have gone to Prisma, and the first statement inside the transaction.
(prisma as unknown as { $transaction: unknown }).$transaction = async (fn: (tx: unknown) => Promise<unknown>, ...rest: unknown[]) => {
  fakeTx.statements = [];
  const r = await fn(fakeTx);
  calls.push({ argCount: 1 + rest.length, options: rest[0], firstStatement: fakeTx.statements[0] ?? "" });
  return r;
};
const last = () => calls[calls.length - 1];
const isSetConfig = (s: string) => /set_config\('app\.current_business_id'/.test(s);

async function main() {
  console.log("--- existing callers (no isolationLevel) ---");
  await tenantTx(7, async () => "x");
  ok("tenantTx(id, fn): Prisma receives NO options argument value (undefined), exactly as before", last().options === undefined);
  ok("…and the tenant GUC is still the first statement", isSetConfig(last().firstStatement), last().firstStatement);
  await tenantTx(7, async () => "x", { timeoutMs: 15000 });
  ok("tenantTx(id, fn, { timeoutMs }): Prisma receives { timeout } only, exactly as before", JSON.stringify(last().options) === JSON.stringify({ timeout: 15000 }));
  await runWithTenantContext({ businessId: 9 }, () => withTenantTransaction(async () => "x"));
  ok("withTenantTransaction(fn): Prisma receives undefined options, exactly as before", last().options === undefined);
  await runWithTenantContext({ businessId: 9 }, () => withTenantTransaction(async () => "x", { timeoutMs: 5000, onPhase: () => undefined }));
  ok("withTenantTransaction(fn, { timeoutMs, onPhase }): { timeout } only — onPhase never reaches Prisma", JSON.stringify(last().options) === JSON.stringify({ timeout: 5000 }));

  console.log("--- the new option, only when asked ---");
  await tenantTx(7, async () => "x", { isolationLevel: "RepeatableRead" });
  ok("tenantTx(…, { isolationLevel }): { isolationLevel } only", JSON.stringify(last().options) === JSON.stringify({ isolationLevel: "RepeatableRead" }));
  await tenantTx(7, async () => "x", { isolationLevel: "RepeatableRead", timeoutMs: 1000 });
  ok("both options together are both passed", JSON.stringify(last().options) === JSON.stringify({ timeout: 1000, isolationLevel: "RepeatableRead" }));
  ok("the GUC is the first statement with an isolation level too", isSetConfig(last().firstStatement));

  console.log("--- the fail-closed rules are untouched ---");
  let threw = false;
  try {
    await tenantTx(0, async () => "x");
  } catch {
    threw = true;
  }
  ok("tenantTx without a positive business still throws before any transaction", threw && calls.length === 6);
  threw = false;
  try {
    await withTenantTransaction(async () => "x");
  } catch {
    threw = true;
  }
  ok("withTenantTransaction without a tenant context still throws before any transaction", threw && calls.length === 6);

  console.log(`\n${pass} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
