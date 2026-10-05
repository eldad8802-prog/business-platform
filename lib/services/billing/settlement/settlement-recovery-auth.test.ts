/**
 * Run: npx tsx lib/services/billing/settlement/settlement-recovery-auth.test.ts   (from the repo root)
 *
 * The recovery endpoint may be triggered only by a scheduler holding
 * CRON_SECRET, and fails closed when it is not configured. Also drives the real
 * route handler for the refusal paths (they never reach the database).
 *
 * Zero-gap rotation: CRON_SECRET_NEXT is accepted alongside CRON_SECRET by the
 * three cron routes — never instead of it, never by any other route, and never
 * when it is short or equal to the derive credential.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { decideCronAuth, decideRecoveryAuth } from "./settlement-recovery-auth";

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

const SECRET = "s".repeat(48);

ok("no secret configured → NOT_CONFIGURED", decideRecoveryAuth(`Bearer ${SECRET}`, undefined) === "NOT_CONFIGURED");
ok("empty secret → NOT_CONFIGURED", decideRecoveryAuth(`Bearer x`, "   ") === "NOT_CONFIGURED");
ok("short placeholder secret → NOT_CONFIGURED", decideRecoveryAuth(`Bearer changeme`, "changeme") === "NOT_CONFIGURED");
ok("missing header → UNAUTHORIZED", decideRecoveryAuth(null, SECRET) === "UNAUTHORIZED");
ok("wrong scheme → UNAUTHORIZED", decideRecoveryAuth(`Basic ${SECRET}`, SECRET) === "UNAUTHORIZED");
ok("wrong secret → UNAUTHORIZED", decideRecoveryAuth(`Bearer ${"t".repeat(48)}`, SECRET) === "UNAUTHORIZED");
ok("prefix of the secret → UNAUTHORIZED", decideRecoveryAuth(`Bearer ${SECRET.slice(0, 40)}`, SECRET) === "UNAUTHORIZED");
ok("secret plus suffix → UNAUTHORIZED", decideRecoveryAuth(`Bearer ${SECRET}x`, SECRET) === "UNAUTHORIZED");
ok("exact bearer → AUTHORIZED", decideRecoveryAuth(`Bearer ${SECRET}`, SECRET) === "AUTHORIZED");
ok("scheme is case-insensitive", decideRecoveryAuth(`bearer ${SECRET}`, SECRET) === "AUTHORIZED");

// ── Zero-gap rotation: CRON_SECRET_NEXT alongside CRON_SECRET, never instead of it ──────────
const OLD = "o".repeat(48);
const NEXT = "n".repeat(48);
const DERIVE = "d".repeat(48);
const WRONG = "w".repeat(48);
const bearer = (s: string) => `Bearer ${s}`;
const withNext = { CRON_SECRET: OLD, CRON_SECRET_NEXT: NEXT, KNOWLEDGE_DERIVE_SECRET: DERIVE };

// 1. the current secret stays valid, with and without NEXT
ok("cron: CRON_SECRET accepted (NEXT absent)", decideCronAuth(bearer(OLD), { CRON_SECRET: OLD }) === "AUTHORIZED");
ok("cron: CRON_SECRET still accepted while NEXT is configured", decideCronAuth(bearer(OLD), withNext) === "AUTHORIZED");
// 2. NEXT accepted when configured
ok("cron: CRON_SECRET_NEXT accepted when configured", decideCronAuth(bearer(NEXT), withNext) === "AUTHORIZED");
ok("cron: NEXT scheme is case-insensitive too", decideCronAuth(`bearer ${NEXT}`, withNext) === "AUTHORIZED");
ok("cron: NEXT equal to CRON_SECRET (post-swap state) accepted", decideCronAuth(bearer(NEXT), { CRON_SECRET: NEXT, CRON_SECRET_NEXT: NEXT }) === "AUTHORIZED");
// 3. anything else refused
ok("cron: wrong secret refused while NEXT is configured", decideCronAuth(bearer(WRONG), withNext) === "UNAUTHORIZED");
ok("cron: prefix of NEXT refused", decideCronAuth(bearer(NEXT.slice(0, 40)), withNext) === "UNAUTHORIZED");
ok("cron: NEXT plus suffix refused", decideCronAuth(bearer(`${NEXT}x`), withNext) === "UNAUTHORIZED");
ok("cron: old and next concatenated refused", decideCronAuth(bearer(OLD + NEXT), withNext) === "UNAUTHORIZED");
ok("cron: NEXT without the Bearer scheme refused", decideCronAuth(`Basic ${NEXT}`, withNext) === "UNAUTHORIZED");
ok("cron: no header refused", decideCronAuth(null, withNext) === "UNAUTHORIZED");
ok("cron: the derive credential never opens a cron endpoint", decideCronAuth(bearer(DERIVE), withNext) === "UNAUTHORIZED");
// 4. NEXT absent (or blank) ≡ the single-secret decision, over a table of cases
{
  const currents = [undefined, "", "   ", "changeme", "x".repeat(31), OLD, `  ${OLD}  `];
  const headers = [null, "", "Bearer", bearer(OLD), `bearer ${OLD}`, bearer(` ${OLD} `), `Basic ${OLD}`, bearer(WRONG), bearer(OLD.slice(0, 40)), bearer("changeme")];
  let same = 0;
  let total = 0;
  for (const c of currents)
    for (const h of headers)
      for (const next of [undefined, "", "   "]) {
        total++;
        if (decideCronAuth(h, { CRON_SECRET: c, CRON_SECRET_NEXT: next }) === decideRecoveryAuth(h, c)) same++;
      }
  ok(`cron: NEXT unset/blank ≡ decideRecoveryAuth(header, CRON_SECRET) (${same}/${total})`, same === total && total === 210);
}
// 5. a malformed NEXT can neither weaken authentication nor lock out the current secret
ok("cron: NEXT alone (no CRON_SECRET) → NOT_CONFIGURED, fail closed", decideCronAuth(bearer(NEXT), { CRON_SECRET_NEXT: NEXT }) === "NOT_CONFIGURED");
ok("cron: NEXT with a short CRON_SECRET → NOT_CONFIGURED", decideCronAuth(bearer(NEXT), { CRON_SECRET: "short", CRON_SECRET_NEXT: NEXT }) === "NOT_CONFIGURED");
ok("cron: a short NEXT is never accepted", decideCronAuth(bearer("changeme"), { CRON_SECRET: OLD, CRON_SECRET_NEXT: "changeme" }) === "UNAUTHORIZED");
ok("cron: a 31-char NEXT is never accepted", decideCronAuth(bearer("z".repeat(31)), { CRON_SECRET: OLD, CRON_SECRET_NEXT: "z".repeat(31) }) === "UNAUTHORIZED");
ok("cron: a short NEXT leaves CRON_SECRET working", decideCronAuth(bearer(OLD), { CRON_SECRET: OLD, CRON_SECRET_NEXT: "changeme" }) === "AUTHORIZED");
ok("cron: NEXT equal to KNOWLEDGE_DERIVE_SECRET is ignored (never accepted)",
  decideCronAuth(bearer(DERIVE), { CRON_SECRET: OLD, CRON_SECRET_NEXT: DERIVE, KNOWLEDGE_DERIVE_SECRET: DERIVE }) === "UNAUTHORIZED");
ok("cron: …and CRON_SECRET keeps working meanwhile",
  decideCronAuth(bearer(OLD), { CRON_SECRET: OLD, CRON_SECRET_NEXT: DERIVE, KNOWLEDGE_DERIVE_SECRET: DERIVE }) === "AUTHORIZED");
ok("cron: NEXT is trimmed like CRON_SECRET", decideCronAuth(bearer(NEXT), { CRON_SECRET: OLD, CRON_SECRET_NEXT: `  ${NEXT}\n` }) === "AUTHORIZED");

// 7. authority scope, statically: exactly the three cron routes use the dual-accept decision, none of
// them compares CRON_SECRET itself, nothing else reads CRON_SECRET_NEXT, and derive has no cron authority.
const CRON_ROUTES = [
  "app/api/intake/sweep/route.ts",
  "app/api/payments/reconciliation/route.ts",
  "app/api/payments/settlement-recovery/route.ts",
];
{
  const root = process.cwd();
  assert.ok(fs.existsSync(path.join(root, CRON_ROUTES[0])), "run from the repository root");
  const files: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(path.join(root, d), { withFileTypes: true })) {
      const rel = path.posix.join(d, e.name);
      if (e.isDirectory()) walk(rel);
      else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) files.push(rel);
    }
  };
  walk("app");
  walk("lib");
  const code = (f: string) => fs.readFileSync(path.join(root, f), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  // The intake sweep route delegates its authority to lib/intake/sweep-auth.ts (QStash signature, else
  // this same dual-accept decision) — so the decision's callers are the two payment routes + that module,
  // and that module is used by the sweep route and nothing else.
  const DECISION_CALLERS = ["app/api/payments/reconciliation/route.ts", "app/api/payments/settlement-recovery/route.ts", "lib/intake/sweep-auth.ts"];
  const cronCallers = files.filter((f) => /decideCronAuth\(/.test(code(f)) && !f.endsWith("settlement-recovery-auth.ts")).sort();
  ok("scope: decideCronAuth is called by exactly the two payment routes and the sweep authority", JSON.stringify(cronCallers) === JSON.stringify(DECISION_CALLERS), JSON.stringify(cronCallers));
  const sweepAuthUsers = files.filter((f) => /from "@\/lib\/intake\/sweep-auth"/.test(code(f))).sort();
  ok("scope: the sweep authority is used by the sweep route only, which uses it",
    JSON.stringify(sweepAuthUsers) === JSON.stringify(["app/api/intake/sweep/route.ts"]) && /authorizeSweep\(/.test(code("app/api/intake/sweep/route.ts")), JSON.stringify(sweepAuthUsers));
  ok("scope: no cron route compares CRON_SECRET itself (all go through the dual-accept)",
    CRON_ROUTES.every((f) => !/process\.env\.CRON_SECRET/.test(code(f)) && !/decideRecoveryAuth\(/.test(code(f))));
  const nextReaders = files.filter((f) => /CRON_SECRET_NEXT/.test(code(f))).sort();
  const NEXT_READERS = ["lib/services/billing/settlement/settlement-recovery-auth.ts", "lib/services/knowledge-derive/derive-gate.ts"];
  ok("scope: only the cron decision and the derive gate read CRON_SECRET_NEXT", JSON.stringify(nextReaders) === JSON.stringify(NEXT_READERS), JSON.stringify(nextReaders));
  ok("scope: the derive route has no cron authority", !/decideCronAuth|CRON_SECRET/.test(code("app/api/knowledge/derive/route.ts")));
}

async function routeChecks() {
  const route = await import("../../../../app/api/payments/settlement-recovery/route");
  const url = "https://example.test/api/payments/settlement-recovery";

  delete process.env.CRON_SECRET;
  const r1 = await route.POST(new NextRequest(url, { method: "POST", headers: { authorization: `Bearer ${SECRET}` } }));
  ok("route: no CRON_SECRET → 503, fails closed", r1.status === 503, String(r1.status));

  process.env.CRON_SECRET = SECRET;
  const r2 = await route.POST(new NextRequest(url, { method: "POST" }));
  ok("route: no header → 401", r2.status === 401, String(r2.status));
  const r3 = await route.GET(new NextRequest(url, { headers: { authorization: "Bearer wrong-wrong-wrong-wrong-wrong-wrong" } }));
  ok("route: wrong secret on GET (Vercel cron verb) → 401", r3.status === 401, String(r3.status));
  const body = await r3.json();
  ok("route: refusal says nothing beyond 'unauthorized'", JSON.stringify(body) === JSON.stringify({ error: "unauthorized" }));
  delete process.env.CRON_SECRET;

  // All three cron routes, driven for real. An ACCEPTED credential gets past authentication into the
  // handler; with no database URL and the network blocked, the handler then fails harmlessly (500), so
  // "authorized" is observable as "neither 401 nor 503" without any side effect.
  const saved = { db: process.env.DATABASE_URL, direct: process.env.DIRECT_URL, fetch: globalThis.fetch };
  delete process.env.DATABASE_URL;
  delete process.env.DIRECT_URL;
  let fetches = 0;
  globalThis.fetch = (async () => {
    fetches++;
    throw new Error("network blocked in test");
  }) as typeof fetch;
  const origError = console.error;
  const origInfo = console.info;
  console.error = () => {};
  console.info = () => {};
  try {
    for (const rel of CRON_ROUTES) {
      const mod = await import(`../../../../${rel.replace(/\.ts$/, "")}`);
      const u = `https://example.test/${rel}`;
      const call = async (auth?: string) =>
        (await mod.POST(new NextRequest(u, { method: "POST", headers: auth ? { authorization: auth } : {} }))).status;
      const name = rel.split("/").slice(-2, -1)[0];

      process.env.CRON_SECRET = OLD;
      delete process.env.CRON_SECRET_NEXT;
      const oldNoNext = await call(bearer(OLD));
      const nextNoNext = await call(bearer(NEXT));
      process.env.CRON_SECRET_NEXT = NEXT;
      const oldWithNext = await call(bearer(OLD));
      const nextWithNext = await call(bearer(NEXT));
      const wrongWithNext = await call(bearer(WRONG));
      process.env.CRON_SECRET_NEXT = "changeme";
      const shortNext = await call(bearer("changeme"));
      delete process.env.CRON_SECRET;
      process.env.CRON_SECRET_NEXT = NEXT;
      const nextAlone = await call(bearer(NEXT));
      delete process.env.CRON_SECRET_NEXT;

      const passed = (s: number) => s !== 401 && s !== 503;
      ok(`route ${name}: CRON_SECRET accepted (NEXT absent)`, passed(oldNoNext), String(oldNoNext));
      ok(`route ${name}: an unconfigured NEXT value is refused (401)`, nextNoNext === 401, String(nextNoNext));
      ok(`route ${name}: CRON_SECRET accepted while NEXT is configured`, passed(oldWithNext), String(oldWithNext));
      ok(`route ${name}: CRON_SECRET_NEXT accepted when configured`, passed(nextWithNext), String(nextWithNext));
      ok(`route ${name}: wrong secret refused (401)`, wrongWithNext === 401, String(wrongWithNext));
      ok(`route ${name}: short NEXT never accepted (401)`, shortNext === 401, String(shortNext));
      ok(`route ${name}: NEXT alone → 503, fails closed`, nextAlone === 503, String(nextAlone));
    }
    ok("routes: no network call was made", fetches === 0, String(fetches));
  } finally {
    console.error = origError;
    console.info = origInfo;
    globalThis.fetch = saved.fetch;
    if (saved.db === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = saved.db;
    if (saved.direct === undefined) delete process.env.DIRECT_URL; else process.env.DIRECT_URL = saved.direct;
    delete process.env.CRON_SECRET;
    delete process.env.CRON_SECRET_NEXT;
  }
}

routeChecks()
  .then(() => {
    console.log(`\nsettlement-recovery-auth: ${pass} passed, ${failures.length} failed`);
    if (failures.length > 0) {
      console.log("FAILURES:\n - " + failures.join("\n - "));
      process.exit(1);
    }
    assert.equal(failures.length, 0);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
