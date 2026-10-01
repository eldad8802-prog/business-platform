/**
 * Verify — GET /api/home/collection P2028 timeline (observability only).
 * Run: npm run verify:home-collection-timeline   (needs --expose-gc; see main)
 *
 * No database: `prisma.$transaction` is replaced by an in-process stand-in that
 * runs the REAL `withTenantTransaction` callback and the REAL service against a
 * fake transaction client. That is enough to defend what this change claims:
 *
 *   - a failure carries every phase it reached, T0–T5 and TERR, in order, and
 *     the derived durations agree with the marks;
 *   - the event loop's active/idle split tells a blocked loop (JavaScript could
 *     not run) from a slow `set_config` (waiting on I/O) — the question the three
 *     Production failures left open;
 *   - nothing sensitive reaches the line;
 *   - success emits nothing and returns exactly what it returned before;
 *   - the tenant context, the `set_config` call and the transaction options are
 *     what they were without instrumentation;
 *   - instrumentation failing, or an observer throwing, never breaks the request.
 */
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";

import { handleError } from "@/lib/handle-error";
import { prisma } from "@/lib/prisma";
import { withHomeCollectionDiagnostics } from "@/lib/services/home/home-collection-diagnostics";
import { loadHomeCollection } from "@/lib/services/home/home-collection.service";
import { summarizeHomeCollectionTimeline } from "@/lib/services/home/home-collection-timeline";
import { getTenantContext, runWithTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction } from "@/lib/tenant/transaction";

let checks = 0;
function eq<T>(label: string, actual: T, expected: T) {
  assert.deepEqual(actual, expected, label);
  checks += 1;
}
function ok(label: string, condition: boolean) {
  assert.ok(condition, label);
  checks += 1;
}

const BUSINESS = 4242;
const NOW = new Date("2026-10-01T09:30:00.000Z");
const SECRETS = [
  "Bearer eyJhbGciOiJIUzI1NiJ9.secret-token",
  "session=abc123cookie",
  "owner@example.com",
  "4242",
  "1250.00",
  "pt_9f8e7d",
  'SELECT "amount" FROM "PaymentTransaction"',
];

function busy(ms: number) {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    // hold the event loop
  }
}

function p2028() {
  return new Prisma.PrismaClientKnownRequestError(
    `Transaction API error: Transaction already closed: A batch query cannot be executed on an expired transaction. businessId=4242 owner@example.com 1250.00 pt_9f8e7d SELECT "amount" FROM "PaymentTransaction"`,
    { code: "P2028", clientVersion: "test", meta: { businessId: BUSINESS, amount: "1250.00", id: "pt_9f8e7d" } }
  );
}

function request() {
  return {
    url: "https://promaxgroup.co.il/api/home/collection?period=today",
    headers: new Headers({
      authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.secret-token",
      cookie: "session=abc123cookie",
      "x-vercel-id": "fra1::iad1::abcde-1700000000000-0123456789ab",
    }),
  };
}

type Scenario = {
  setConfig: "fast" | "slow-db" | "fast-then-blocked";
  reads: "ok" | "p2028";
};

type Recorded = { setConfigArgs: unknown[]; txOptions: unknown; tenantAtReads: number | undefined; order: string[] };

const rows = [
  { amount: new Prisma.Decimal("120.00"), createdAt: new Date("2026-10-01T06:10:00.000Z") },
  { amount: new Prisma.Decimal("80.50"), createdAt: new Date("2026-10-01T07:45:00.000Z") },
];

/** Replace `prisma.$transaction` with a stand-in for one scenario. */
function stubPrisma(s: Scenario, rec: Recorded) {
  const reads = async () => {
    rec.tenantAtReads = getTenantContext()?.businessId;
    rec.order.push("reads");
    if (s.reads === "p2028") throw p2028();
  };
  const tx = {
    $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
      rec.order.push("set_config");
      rec.setConfigArgs = [strings.join("?"), ...values];
      if (s.setConfig === "slow-db") return new Promise((r) => setTimeout(() => r([]), 150));
      if (s.setConfig === "fast-then-blocked") {
        // The answer is ready in 5 ms, but JavaScript is held for 150 ms just
        // before it, so the continuation runs late.
        setTimeout(() => busy(150), 1);
        return new Promise((r) => setTimeout(() => r([]), 5));
      }
      return Promise.resolve([]);
    },
    paymentTransaction: {
      findMany: async () => {
        await reads();
        return rows;
      },
      aggregate: async () => {
        await reads();
        return { _sum: { amount: new Prisma.Decimal("200.50") }, _count: { _all: 2 } };
      },
    },
  };
  (prisma as unknown as { $transaction: unknown }).$transaction = async (
    fn: (client: unknown) => Promise<unknown>,
    options: unknown
  ) => {
    rec.txOptions = options;
    return fn(tx);
  };
}

/** The route's own shape: diagnostics → tenant context → service. */
async function route(emit: (line: string) => void, now: Date = NOW) {
  return withHomeCollectionDiagnostics(
    request(),
    async () => {
      const model = await runWithTenantContext({ businessId: BUSINESS }, () =>
        loadHomeCollection(BUSINESS, { period: "today", now })
      );
      return NextResponse.json(model, { status: 200 });
    },
    emit
  );
}

function fresh(): Recorded {
  return { setConfigArgs: [], txOptions: "unset", tenantAtReads: undefined, order: [] };
}

const TIMELINE_KEYS = [
  "callbackToSetConfigStartMs", "commit", "deploymentId", "eventLoopDelay", "instance", "marks", "readsMs",
  "requestMs", "routeToTxRequestMs", "setConfigMs", "setConfigResolvedToReadsSubmittedMs", "spans",
  "txRequestToCallbackMs", "txTotalMs",
];

const realConsoleError = console.error;
console.error = () => {};

/** The timeline as it arrives in the emitted JSON line. */
type WireTimeline = {
  marks: Record<string, number>;
  spans: { span: string; ms: number; loopActiveMs: number; loopIdleMs: number }[];
  setConfigMs: number;
  setConfigResolvedToReadsSubmittedMs: number;
  readsMs: number | null;
  txTotalMs: number;
  requestMs: number;
  eventLoopDelay: { maxMs: number } | null;
  instance: Record<string, number>;
};

const near = (a: number, b: number) => Math.abs(a - b) <= 1; // marks and spans are rounded separately

/**
 * The cold Jerusalem-month computation leaves tens of thousands of Intl objects
 * behind, and a later major GC can land inside any timed span. The warm
 * scenarios therefore run after a forced collection, and the cold one runs last.
 */
const gc = (globalThis as { gc?: () => void }).gc;

async function main() {
  if (!gc) {
    throw new Error("run with --expose-gc (npm run verify:home-collection-timeline)");
  }
  // A server's event loop is already running when a request arrives; before it
  // starts, ELU reports nothing (pinned in H).
  await new Promise((resolve) => setTimeout(resolve, 20));
  // Warm the month bounds the warm scenarios use, then clear the garbage.
  stubPrisma({ setConfig: "fast", reads: "ok" }, fresh());
  await route(() => {});
  gc();
  gc();

  // A. Event loop blocked between set_config answering and JS resuming.
  let blocked: WireTimeline;
  {
    const rec = fresh();
    stubPrisma({ setConfig: "fast-then-blocked", reads: "p2028" }, rec);
    const lines: string[] = [];
    const res = await route((l) => lines.push(l));
    eq("A: 500 as before", res.status, 500);
    eq("A: one line", lines.length, 1);
    const event = JSON.parse(lines[0]);
    eq("A: still the P2028 line", [event.event, event.errorCode], ["home_collection_failed", "P2028"]);
    blocked = event.timeline;
    ok("A: timeline present", blocked !== null && typeof blocked === "object");
    eq("A: phases reached", Object.keys(blocked.marks), ["T0", "T1", "T2", "T3", "T4", "T5", "TERR"]);
    const m = blocked.marks;
    ok("A: marks ascend", m.T0 <= m.T1 && m.T1 <= m.T2 && m.T2 <= m.T3 && m.T3 <= m.T4 && m.T4 <= m.T5 && m.T5 <= m.TERR);
    ok("A: setConfigMs = T4 - T3", near(blocked.setConfigMs, m.T4 - m.T3));
    ok("A: resolved→submitted = T5 - T4", near(blocked.setConfigResolvedToReadsSubmittedMs, m.T5 - m.T4));
    ok("A: requestMs = TERR - T0", near(blocked.requestMs, m.TERR - m.T0));
    eq("A: reads never resolved", blocked.readsMs, null);
    ok("A: tx total within request", blocked.txTotalMs <= blocked.requestMs);
    const spanSum = blocked.spans.reduce((s: number, x: { ms: number }) => s + x.ms, 0);
    ok("A: spans add up to the request (±rounding)", Math.abs(spanSum - blocked.requestMs) <= blocked.spans.length);
    const sc = blocked.spans.find((x) => x.span === "T3-T4")!;
    ok("A: the stall lands in the set_config wait", sc.ms >= 120);
    ok("A: and the loop was mostly ACTIVE for it (JS could not run)", sc.loopActiveMs >= sc.ms * 0.6);
    ok("A: longest loop delay records the block", blocked.eventLoopDelay === null || blocked.eventLoopDelay.maxMs >= 100);
    eq("A: timeline keys allowlisted", Object.keys(blocked).sort(), TIMELINE_KEYS);
    eq("A: instance keys", Object.keys(blocked.instance).sort(), ["inFlightAtStart", "moduleAgeMs", "processUptimeMs", "requestsSeen"]);
    for (const secret of SECRETS) ok(`A: no ${JSON.stringify(secret)}`, !lines[0].includes(secret));
    eq("A: tenant context at the reads unchanged", rec.tenantAtReads, BUSINESS);
    eq("A: set_config unchanged (same SQL, tenant as a parameter)", rec.setConfigArgs, [
      "SELECT set_config('app.current_business_id', ?, true)",
      String(BUSINESS),
    ]);
    eq("A: set_config runs before the reads", rec.order[0], "set_config");
    eq("A: transaction options unchanged (no timeout passed)", rec.txOptions, undefined);
  }

  // B. A slow set_config: the same wall time, but the loop sat IDLE.
  {
    const rec = fresh();
    stubPrisma({ setConfig: "slow-db", reads: "p2028" }, rec);
    const lines: string[] = [];
    await route((l) => lines.push(l));
    const t = JSON.parse(lines[0]).timeline;
    const sc = t.spans.find((x: { span: string }) => x.span === "T3-T4");
    ok("B: set_config wait recorded", sc.ms >= 120);
    ok("B: loop mostly IDLE during it (waiting on I/O)", sc.loopIdleMs >= sc.ms * 0.6 && sc.loopIdleMs > sc.loopActiveMs);
    const blockedSc = blocked.spans.find((x) => x.span === "T3-T4")!;
    ok("A vs B: the payload distinguishes the two causes", blockedSc.loopActiveMs / blockedSc.ms > sc.loopActiveMs / sc.ms);
  }

  // C. Success: no line, and the same answer as without any timeline in scope.
  {
    const rec = fresh();
    stubPrisma({ setConfig: "fast", reads: "ok" }, rec);
    const lines: string[] = [];
    const res = await route((l) => lines.push(l));
    eq("C: 200", res.status, 200);
    eq("C: success logs nothing", lines.length, 0);
    const body = await res.json();
    const bare = await runWithTenantContext({ businessId: BUSINESS }, () =>
      loadHomeCollection(BUSINESS, { period: "today", now: NOW })
    );
    eq("C: same read model as uninstrumented", body, JSON.parse(JSON.stringify(bare)));
    eq("C: tenant context outside the request", getTenantContext(), undefined);
  }

  // D. No leak: the next request sees nothing in flight.
  {
    const rec = fresh();
    stubPrisma({ setConfig: "fast", reads: "p2028" }, rec);
    const lines: string[] = [];
    await route((l) => lines.push(l));
    const t = JSON.parse(lines[0]).timeline;
    eq("D: nothing left in flight from earlier requests", t.instance.inFlightAtStart, 0);
    ok("D: requests counted", t.instance.requestsSeen >= 4);
  }

  // E. Instrumentation failing never changes the answer.
  {
    const realElu = performance.eventLoopUtilization;
    const realNow = performance.now;
    (performance as unknown as { eventLoopUtilization: unknown }).eventLoopUtilization = () => {
      throw new Error("elu down");
    };
    try {
      const rec = fresh();
      stubPrisma({ setConfig: "fast", reads: "ok" }, rec);
      const ok200 = await route(() => {});
      eq("E: success unaffected by a failing ELU", ok200.status, 200);
      stubPrisma({ setConfig: "fast", reads: "p2028" }, fresh());
      const lines: string[] = [];
      const failed = await route((l) => lines.push(l));
      const direct = handleError(p2028());
      eq("E: failure answer unchanged", [failed.status, await failed.json()], [direct.status, await direct.json()]);
      eq("E: the line is still written", lines.length, 1);

      (performance as unknown as { now: unknown }).now = () => {
        throw new Error("clock down");
      };
      stubPrisma({ setConfig: "fast", reads: "ok" }, fresh());
      eq("E: success unaffected by a failing clock", (await route(() => {})).status, 200);
    } finally {
      (performance as unknown as { eventLoopUtilization: unknown }).eventLoopUtilization = realElu;
      (performance as unknown as { now: unknown }).now = realNow;
    }
  }

  // H. Unmeasured is reported as unmeasured: zero active AND zero idle across real
  // elapsed time (ELU before the loop starts) becomes null, never a false "0".
  {
    const zero = { idle: 0, active: 0, utilization: 0 };
    const s = summarizeHomeCollectionTimeline({
      at: { T0: 100, T1: 101, T4: 101, T5: 4600 },
      elu: { T0: zero, T1: zero, T4: zero, T5: zero },
      delay: null,
      inFlightAtStart: 0,
      requestsSeen: 1,
      processUptimeMs: 500,
      moduleAgeMs: 40,
    });
    const span = s.spans.find((x) => x.span === "T4-T5")!;
    eq("H: span still timed", span.ms, 4499);
    eq("H: loop share unmeasured, not zero", [span.loopActiveMs, span.loopIdleMs], [null, null]);
    eq("H: no histogram, no claim", s.eventLoopDelay, null);
  }

  // F. The tenant transaction's observer: order, isolation, and timeout passthrough.
  {
    const rec = fresh();
    stubPrisma({ setConfig: "fast", reads: "ok" }, rec);
    const seen: string[] = [];
    const out = await runWithTenantContext({ businessId: BUSINESS }, () =>
      withTenantTransaction(async () => {
        seen.push("fn");
        return "done";
      }, { onPhase: (p) => seen.push(p) })
    );
    eq("F: result unchanged", out, "done");
    eq("F: phases in order, set_config before the work", seen, ["callback", "set-config-start", "set-config-resolved", "fn"]);

    const thrown = await runWithTenantContext({ businessId: BUSINESS }, () =>
      withTenantTransaction(async () => "still done", {
        onPhase: () => {
          throw new Error("observer down");
        },
      })
    );
    eq("F: a throwing observer never breaks the transaction", thrown, "still done");

    const timed = fresh();
    stubPrisma({ setConfig: "fast", reads: "ok" }, timed);
    await runWithTenantContext({ businessId: BUSINESS }, () =>
      withTenantTransaction(async () => null, { timeoutMs: 20000, onPhase: () => {} })
    );
    eq("F: an explicit timeout still passes through unchanged", timed.txOptions, { timeout: 20000 });

    let failClosed = false;
    try {
      await withTenantTransaction(async () => null, { onPhase: () => {} });
    } catch {
      failClosed = true;
    }
    ok("F: still fail-closed with no tenant context", failClosed);
  }

  // G (last: it leaves the garbage). The service's own work between set_config
  // resolving and the reads being submitted — the interval Production could not
  // see into. For a month this process has not computed yet, the Jerusalem month
  // bounds are built from scratch inside it; the timeline must show that as a
  // long T4→T5 span with the loop ACTIVE, and set_config itself as quick.
  {
    stubPrisma({ setConfig: "fast", reads: "p2028" }, fresh());
    const lines: string[] = [];
    await route((l) => lines.push(l), new Date("2027-03-15T09:30:00.000Z"));
    const t = JSON.parse(lines[0]).timeline;
    const span = t.spans.find((x: { span: string }) => x.span === "T4-T5");
    ok("G: resolved→submitted is the long interval for an uncomputed month", t.setConfigResolvedToReadsSubmittedMs >= 500);
    ok("G: and the loop was busy for it", span.loopActiveMs >= span.ms * 0.8);
    ok("G: set_config itself was quick", t.setConfigMs < 100);
  }

  console.error = realConsoleError;
  console.log(`home-collection-timeline.verify.test.ts: ok (${checks} checks)`);
}

main().catch((error) => {
  console.error = realConsoleError;
  console.error(error);
  process.exit(1);
});
