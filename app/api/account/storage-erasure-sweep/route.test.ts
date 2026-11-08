/**
 * Run: npx tsx app/api/account/storage-erasure-sweep/route.test.ts   (from the repo root)
 *
 * The shared account storage erasure sweep route — pure (no database, no storage, no network):
 *   A. the answer for every authority decision; switched off by default (the sweep never runs);
 *   B. on: one pass with the 45 s budget, counts only, failures → 500 with a fixed code (never a message or id);
 *   C. concurrent calls and a retry after a failure — no state kept between calls;
 *   D. the real route handler: 503 / 401 / inert 200 with no database configured; no-store; GET and POST;
 *   E. static: authority only through decideCronAuth, no CRON_SECRET read, no caller-supplied business, the budget
 *      under maxDuration, the route listed in the cron authority registry and not in vercel.json (not scheduled).
 */
import fs from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";

import type { StorageErasureSweepSummary } from "@/lib/services/account/account-storage-erasure";
import {
  SWEEP_BUDGET_MS,
  answerStorageErasureSweep,
  sweepEnabled,
} from "@/lib/services/account/account-storage-erasure-sweep-request";

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`OK: ${name}`);
  } else {
    failures.push(name);
    console.log(`FAIL: ${name}${detail ? " — " + detail : ""}`);
  }
}

const summary = (o: Partial<StorageErasureSweepSummary> = {}): StorageErasureSweepSummary => ({ businesses: 0, open: 0, errors: 0, notReached: 0, ...o });
function fakeSweep(result: () => Promise<StorageErasureSweepSummary>) {
  const calls: { budgetMs: number }[] = [];
  return { calls, sweep: (o: { budgetMs: number }) => { calls.push(o); return result(); } };
}

async function main() {
  // A. authority + the switch
  {
    const f = fakeSweep(async () => summary());
    const a = await answerStorageErasureSweep("NOT_CONFIGURED", "true", f.sweep);
    ok("A1 NOT_CONFIGURED → 503, the sweep never runs", a.status === 503 && f.calls.length === 0 && JSON.stringify(a.body) === '{"error":"sweep_not_configured"}');
    const b = await answerStorageErasureSweep("UNAUTHORIZED", "true", f.sweep);
    ok("A2 UNAUTHORIZED → 401, the sweep never runs", b.status === 401 && f.calls.length === 0 && JSON.stringify(b.body) === '{"error":"unauthorized"}');
    for (const v of [undefined, "", "false", "TRUE", "1", "yes", "true1", "on"]) {
      const c = await answerStorageErasureSweep("AUTHORIZED", v, f.sweep);
      ok(`A3 switch ${JSON.stringify(v)} → off: 200 enabled:false, the sweep never runs`, c.status === 200 && c.body.enabled === false && f.calls.length === 0);
    }
    ok("A4 only exactly \"true\" (trimmed) switches it on", sweepEnabled("true") && sweepEnabled(" true\n") && !sweepEnabled("True") && !sweepEnabled(undefined));
  }

  // B. one pass
  {
    const f = fakeSweep(async () => summary({ businesses: 3, open: 2, notReached: 1 }));
    const a = await answerStorageErasureSweep("AUTHORIZED", "true", f.sweep);
    ok("B1 on → exactly one pass with the 45 s budget", f.calls.length === 1 && f.calls[0].budgetMs === 45_000 && SWEEP_BUDGET_MS === 45_000);
    ok("B2 open jobs that are not finished yet are not a failure (200)", a.status === 200 && a.body.ok === true);
    ok("B3 the answer is counts only", JSON.stringify(a.body) === JSON.stringify({ ok: true, enabled: true, counts: { businesses: 3, open: 2, errors: 0, notReached: 1 } }));
    const leaky = fakeSweep(async () => ({ ...summary({ businesses: 1 }), businessIds: [42], key: "biz/42/service/x" }) as StorageErasureSweepSummary);
    const l = await answerStorageErasureSweep("AUTHORIZED", "true", leaky.sweep);
    ok("B4 nothing beyond the four counts leaves, even if the summary carried more", !/42|biz\//.test(JSON.stringify(l.body)));
    const e = await answerStorageErasureSweep("AUTHORIZED", "true", fakeSweep(async () => summary({ businesses: 2, open: 1, errors: 1 })).sweep);
    ok("B5 a module error → 500 with the counts", e.status === 500 && e.body.ok === false && (e.body.counts as StorageErasureSweepSummary).errors === 1);
    const orig = console.error;
    const logged: unknown[][] = [];
    console.error = (...a: unknown[]) => { logged.push(a); };
    const t = await answerStorageErasureSweep("AUTHORIZED", "true", fakeSweep(async () => { throw new TypeError("connect ECONNREFUSED db.internal:5432 user=app_runtime_prod biz 42"); }).sweep);
    console.error = orig;
    ok("B6 a pass that throws → 500 sweep_failed", t.status === 500 && JSON.stringify(t.body) === '{"ok":false,"enabled":true,"error":"sweep_failed"}');
    ok("B7 the log line carries the error class only — never its message", logged.length === 1 && !/ECONNREFUSED|db\.internal|42|app_runtime/.test(JSON.stringify(logged)) && /TypeError/.test(JSON.stringify(logged)));
  }

  // C. concurrency and retry
  {
    let inFlight = 0;
    let maxInFlight = 0;
    const f = fakeSweep(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      return summary({ businesses: 1 });
    });
    const both = await Promise.all([1, 2, 3].map(() => answerStorageErasureSweep("AUTHORIZED", "true", f.sweep)));
    ok("C1 three overlapping calls each run their own pass and all answer 200 (resume is concurrency-safe)", both.every((a) => a.status === 200) && f.calls.length === 3 && maxInFlight === 3);
    let n = 0;
    const flaky = fakeSweep(async () => { n++; if (n === 1) throw new Error("transient"); return summary({ businesses: 1 }); });
    const orig = console.error;
    console.error = () => {};
    const first = await answerStorageErasureSweep("AUTHORIZED", "true", flaky.sweep);
    console.error = orig;
    const second = await answerStorageErasureSweep("AUTHORIZED", "true", flaky.sweep);
    ok("C2 a failed pass leaves nothing behind: the next call runs a fresh pass and succeeds", first.status === 500 && second.status === 200 && flaky.calls.length === 2);
  }

  // D. the real handler (no database, no network: everything it may reach here must be refused or inert)
  {
    const route = await import("./route");
    const url = "https://example.test/api/account/storage-erasure-sweep";
    const SECRET = "c".repeat(48);
    const saved = { db: process.env.DATABASE_URL, direct: process.env.DIRECT_URL, sw: process.env.ACCOUNT_STORAGE_ERASURE_SWEEP_ENABLED, fetch: globalThis.fetch };
    delete process.env.DATABASE_URL;
    delete process.env.DIRECT_URL;
    delete process.env.ACCOUNT_STORAGE_ERASURE_SWEEP_ENABLED;
    let fetches = 0;
    globalThis.fetch = (async () => { fetches++; throw new Error("network blocked in test"); }) as typeof fetch;
    try {
      delete process.env.CRON_SECRET;
      const r1 = await route.GET(new NextRequest(url, { headers: { authorization: `Bearer ${SECRET}` } }));
      ok("D1 no CRON_SECRET → 503, fails closed", r1.status === 503);
      process.env.CRON_SECRET = SECRET;
      const r2 = await route.GET(new NextRequest(url));
      ok("D2 no header → 401", r2.status === 401);
      const r3 = await route.POST(new NextRequest(url, { method: "POST", headers: { authorization: "Bearer wrong-wrong-wrong-wrong-wrong-wrong" } }));
      ok("D3 wrong secret (POST) → 401", r3.status === 401);
      const r4 = await route.GET(new NextRequest(url, { headers: { authorization: `Bearer ${SECRET}` } }));
      const b4 = await r4.json();
      ok("D4 authorized, switch absent (the default) → 200 enabled:false without a database", r4.status === 200 && JSON.stringify(b4) === '{"ok":true,"enabled":false}');
      ok("D5 every answer is no-store", [r1, r2, r3, r4].every((r) => r.headers.get("cache-control") === "no-store"));
      const r5 = await route.GET(new NextRequest(`${url}?businessId=9`, { headers: { authorization: `Bearer ${SECRET}` } }));
      ok("D6 a caller-supplied businessId changes nothing (still inert)", r5.status === 200 && JSON.stringify(await r5.json()) === '{"ok":true,"enabled":false}');
      process.env.ACCOUNT_STORAGE_ERASURE_SWEEP_ENABLED = "true";
      const orig = console.error;
      console.error = () => {};
      const r6 = await route.POST(new NextRequest(url, { method: "POST", headers: { authorization: `Bearer ${SECRET}` } }));
      console.error = orig;
      const b6 = await r6.json();
      ok("D7 on, database unreachable → 500 sweep_failed, nothing else said", r6.status === 500 && JSON.stringify(b6) === '{"ok":false,"enabled":true,"error":"sweep_failed"}');
      ok("D8 no network call was made", fetches === 0, String(fetches));
    } finally {
      globalThis.fetch = saved.fetch;
      for (const [k, v] of [["DATABASE_URL", saved.db], ["DIRECT_URL", saved.direct], ["ACCOUNT_STORAGE_ERASURE_SWEEP_ENABLED", saved.sw]] as const) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
      delete process.env.CRON_SECRET;
    }
  }

  // E. static
  {
    const root = process.cwd();
    const code = (f: string) => fs.readFileSync(path.join(root, f), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    const r = code("app/api/account/storage-erasure-sweep/route.ts");
    const lib = code("lib/services/account/account-storage-erasure-sweep-request.ts");
    ok("E1 the route authenticates through decideCronAuth only", /decideCronAuth\(req\.headers\.get\("authorization"\)\)/.test(r) && !/CRON_SECRET|decideRecoveryAuth|getSession|cookies\(/.test(r + lib));
    ok("E2 the route reads no business from the request (no searchParams, no body)", !/searchParams|req\.json|req\.formData|businessId/.test(r));
    const maxDuration = Number(/export const maxDuration = (\d+)/.exec(r)?.[1]);
    ok("E3 the budget ends before maxDuration", maxDuration === 60 && SWEEP_BUDGET_MS < maxDuration * 1000);
    ok("E4 the switch is read in exactly one place, by name", (r.match(/ACCOUNT_STORAGE_ERASURE_SWEEP_ENABLED/g) ?? []).length === 1 && !/process\.env/.test(lib));
    const auth = fs.readFileSync(path.join(root, "lib/services/billing/settlement/settlement-recovery-auth.test.ts"), "utf8");
    ok("E5 the route is registered in the cron authority registry (CRON_ROUTES and DECISION_CALLERS)", (auth.match(/"app\/api\/account\/storage-erasure-sweep\/route\.ts"/g) ?? []).length === 2);
    const vercel = JSON.parse(fs.readFileSync(path.join(root, "vercel.json"), "utf8")) as { crons?: { path: string }[] };
    ok("E6 NOT scheduled: vercel.json has no cron for this route (scheduling is a separate owner decision)", !(vercel.crons ?? []).some((c) => c.path.startsWith("/api/account/storage-erasure-sweep")));
  }

  console.log(`\naccount storage-erasure-sweep route: ${pass} passed, ${failures.length} failed`);
  if (failures.length > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
