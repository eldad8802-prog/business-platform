/**
 * D2 / P7-W4A — runTenantJob unit proofs (tsx-runnable, no DB).
 *
 *   npx tsx lib/tenant/job.test.ts
 */
import { runTenantJob, TenantJobError } from "./job";
import {
  getTenantContext,
  runWithTenantContext,
  TenantContextError,
} from "./context";

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    pass++;
    console.log(`  [PASS] ${name}`);
  } else {
    fail++;
    console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`);
  }
}

async function expectThrow(
  name: string,
  fn: () => Promise<unknown>,
  errName: string
): Promise<void> {
  try {
    await fn();
    ok(name, false, "no error thrown");
  } catch (e) {
    ok(name, (e as Error)?.name === errName, `got ${(e as Error)?.name}`);
  }
}

async function main(): Promise<void> {
  // A → A, B → B.
  const a = await runTenantJob({ businessId: 11 }, async () => {
    return getTenantContext()?.businessId;
  });
  ok("explicit job A runs under tenant A", a === 11, `got ${a}`);
  const b = await runTenantJob({ businessId: 22 }, async () => {
    return getTenantContext()?.businessId;
  });
  ok("explicit job B runs under tenant B", b === 22, `got ${b}`);

  // Missing / invalid → throw.
  await expectThrow(
    "missing businessId throws TenantJobError",
    () =>
      runTenantJob(undefined as unknown as { businessId: number }, async () => 1),
    "TenantJobError"
  );
  for (const bad of [0, -3, 1.5, NaN, "7" as unknown as number, null as unknown as number]) {
    await expectThrow(
      `invalid businessId (${String(bad)}) throws TenantJobError`,
      () => runTenantJob({ businessId: bad }, async () => 1),
      "TenantJobError"
    );
  }

  // No inherited-ALS dependency: job establishes its own context from a bare
  // scope (no outer request context at all).
  ok(
    "no ambient context before job",
    getTenantContext() === undefined,
    JSON.stringify(getTenantContext())
  );
  const bare = await runTenantJob({ businessId: 33 }, async () => {
    // Cross an async boundary (macrotask) — context must survive it.
    await new Promise((r) => setTimeout(r, 5));
    return getTenantContext()?.businessId;
  });
  ok("context survives async boundary inside job", bare === 33, `got ${bare}`);
  ok("job context does not leak after completion", getTenantContext() === undefined);

  // Outer tenant-A context cannot silently turn an explicit tenant-B job
  // into tenant A — the mismatch throws loudly (no silent switch either way).
  await expectThrow(
    "explicit B job inside established A context throws (no silent switch)",
    () =>
      runWithTenantContext({ businessId: 11 }, () =>
        runTenantJob({ businessId: 22 }, async () => getTenantContext()?.businessId)
      ),
    "TenantContextError"
  );
  // Same-tenant nesting is allowed and stays on the same tenant.
  const same = await runWithTenantContext({ businessId: 11 }, () =>
    runTenantJob({ businessId: 11 }, async () => getTenantContext()?.businessId)
  );
  ok("same-tenant nesting keeps tenant A", same === 11, `got ${same}`);

  // Simulated after()-style deferred execution: the closure carries the
  // explicit identity; the original "request" context is long gone.
  const deferred: Array<() => Promise<number | undefined>> = [];
  runWithTenantContext({ businessId: 44 }, () => {
    const trustedBusinessId = 44; // server-derived inside the request
    deferred.push(() =>
      runTenantJob({ businessId: trustedBusinessId }, async () => {
        await new Promise((r) => setTimeout(r, 5));
        return getTenantContext()?.businessId;
      })
    );
    return undefined;
  });
  ok("request context ended before deferred run", getTenantContext() === undefined);
  const deferredResult = await deferred[0]();
  ok(
    "deferred job reconstructs explicit tenant (no request-ALS dependency)",
    deferredResult === 44,
    `got ${deferredResult}`
  );

  // Errors inside the job propagate and do not leak context.
  await expectThrow(
    "job body errors propagate",
    () =>
      runTenantJob({ businessId: 55 }, async () => {
        throw new TenantJobError("boom");
      }),
    "TenantJobError"
  );
  ok("no context leak after failed job", getTenantContext() === undefined);

  console.log(`\n[job.test] PASS=${pass} FAIL=${fail}`);
  if (fail > 0) process.exit(1);
  console.log("ALL CHECKS PASS");
}

void main();
