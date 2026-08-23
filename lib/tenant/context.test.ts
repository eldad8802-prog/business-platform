/**
 * D2 / P5-1 — Tenant Context Primitive · unit proof (no Prisma, no DB).
 *
 * Run: npx tsx lib/tenant/context.test.ts
 */
import {
  runWithTenantContext,
  getTenantContext,
  getTenantContextOrThrow,
  TenantContextError,
} from "./context";

let failures = 0;
function check(name: string, cond: boolean, extra = ""): void {
  const status = cond ? "PASS" : "FAIL";
  if (!cond) failures++;
  console.log(`  [${status}] ${name}${extra ? " — " + extra : ""}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function threw(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch (e) {
    return e instanceof TenantContextError;
  }
}

(async () => {
  console.log("Tenant Context Primitive — P5-1 proof\n");

  // Basic: readable inside wrapper.
  check(
    "basic: businessId readable inside wrapper",
    runWithTenantContext({ businessId: 7 }, () => getTenantContextOrThrow().businessId) === 7,
  );
  check(
    "basic: getTenantContext() returns the context inside wrapper",
    runWithTenantContext({ businessId: 7 }, () => getTenantContext()?.businessId) === 7,
  );
  check(
    "returns the callback's value",
    runWithTenantContext({ businessId: 7 }, () => "result-value") === "result-value",
  );

  // Fail-closed: outside wrapper.
  check("fail-closed: getTenantContextOrThrow() throws outside wrapper", threw(() => getTenantContextOrThrow()));
  check("outside wrapper: getTenantContext() is undefined", getTenantContext() === undefined);

  // Async propagation across await chains + nested async.
  const asyncVal = await runWithTenantContext({ businessId: 42 }, async () => {
    await sleep(5);
    const inner = await (async () => {
      await sleep(5);
      return getTenantContextOrThrow().businessId; // nested async call
    })();
    return inner;
  });
  check("async: context survives await + nested async calls", asyncVal === 42);

  // Parallel isolation: interleaved awaits must not cross-contaminate.
  const worker = (id: number, delay: number) =>
    runWithTenantContext({ businessId: id }, async () => {
      await sleep(delay);
      const mid = getTenantContextOrThrow().businessId;
      await sleep(delay);
      return `${mid}/${getTenantContextOrThrow().businessId}`;
    });
  const [ra, rb, rc] = await Promise.all([worker(11, 15), worker(22, 5), worker(33, 10)]);
  check("parallel A isolated", ra === "11/11", ra);
  check("parallel B isolated", rb === "22/22", rb);
  check("parallel C isolated", rc === "33/33", rc);

  // Cleanup: no context leaks after completion.
  await runWithTenantContext({ businessId: 99 }, async () => {
    await sleep(1);
  });
  check("cleanup: no context after wrapper completes", getTenantContext() === undefined);

  // Error cleanup: throwing inside must not leak context.
  let sawError = false;
  try {
    await runWithTenantContext({ businessId: 55 }, async () => {
      await sleep(1);
      throw new Error("boom");
    });
  } catch {
    sawError = true;
  }
  check("error path: callback error propagates", sawError);
  check("error cleanup: no context leaks after a thrown callback", getTenantContext() === undefined);

  // Nested SAME tenant: allowed.
  const nestedSame = runWithTenantContext({ businessId: 5 }, () =>
    runWithTenantContext({ businessId: 5 }, () => getTenantContextOrThrow().businessId),
  );
  check("nested same tenant: allowed", nestedSame === 5);

  // Nested DIFFERENT tenant: blocked (no silent switch).
  const nestedDifferentBlocked = runWithTenantContext({ businessId: 5 }, () =>
    threw(() => runWithTenantContext({ businessId: 6 }, () => 0)),
  );
  check("nested different tenant: BLOCKED (no silent switch)", nestedDifferentBlocked);
  check("outer context intact after blocked nested switch", getTenantContext() === undefined);

  // Validation: reject invalid businessId.
  check("validation: 0 rejected", threw(() => runWithTenantContext({ businessId: 0 }, () => 0)));
  check("validation: negative rejected", threw(() => runWithTenantContext({ businessId: -1 }, () => 0)));
  check("validation: NaN rejected", threw(() => runWithTenantContext({ businessId: NaN }, () => 0)));
  check("validation: float rejected", threw(() => runWithTenantContext({ businessId: 1.5 }, () => 0)));
  check(
    "validation: non-number rejected",
    threw(() => runWithTenantContext({ businessId: "1" as unknown as number }, () => 0)),
  );

  console.log(`\n${failures === 0 ? "ALL CHECKS PASS" : failures + " CHECK(S) FAILED"}`);
  process.exit(failures === 0 ? 0 : 1);
})();
