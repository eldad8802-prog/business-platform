/**
 * Database availability probe — the pure half (no database, no network). Run: npx tsx lib/ops/db-health.test.ts
 *
 *   A  Who: only a Bearer equal to HEALTH_MONITOR_SECRET; missing / short / equal-to-CRON_SECRET secret → not configured.
 *   B  What: one SELECT 1 ping per connection, in parallel; both ok → ok; either failing → down, the other still reported.
 *   C  Failures map to fixed codes (unreachable / rejected / timeout / not_configured / error) — never the error text.
 *   D  Bounded: a hung check stops at its timeout; the whole probe stops at its deadline.
 *   E  Recovery: the same connections answering again → ok on the next probe (no state is kept between probes).
 *   F  No secret leaves: an error carrying a connection string, a password or a host never reaches the report.
 *   G  The route: auth before any database work; no-store on every answer; dynamic; fixed codes; logs class+code only.
 *
 * The database half (real Postgres: up, unreachable, refused role, black-holed, recovered) is scripts/ops/db-health-lab.ts.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  CHECK_TIMEOUT_MS,
  classifyFailure,
  decideMonitorAuth,
  MIN_MONITOR_SECRET_LENGTH,
  NO_STORE_HEADERS,
  PROBE_DEADLINE_MS,
  probeDatabases,
  runCheck,
  type Ping,
} from "./db-health";

let passed = 0;
async function ok(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const SECRET = "m".repeat(MIN_MONITOR_SECRET_LENGTH + 8);
const CRON = "c".repeat(48);
let PINGS = 0;
const up: Ping = async () => {
  PINGS += 1;
  return [{ "?column?": 1 }];
};
const failing = (err: unknown): Ping => async () => {
  throw err;
};
const hanging: Ping = () => new Promise(() => {});
function prismaError(name: string, errorCode: string, message: string) {
  const e = new Error(message) as Error & { errorCode?: string; code?: string };
  e.name = name;
  if (name === "PrismaClientKnownRequestError") e.code = errorCode;
  else e.errorCode = errorCode;
  return e;
}
const LEAKY = "Can't reach database server at `ep-secret-host-123456.c-2.us-east-1.aws.neon.tech:5432` postgresql://app_runtime_prod:SuperSecretPw@ep-secret-host-123456";

async function main() {
  console.log("A  who may call");
  await ok("no secret configured → NOT_CONFIGURED", () => assert.equal(decideMonitorAuth(`Bearer ${SECRET}`, {}), "NOT_CONFIGURED"));
  await ok("a secret shorter than the minimum → NOT_CONFIGURED", () =>
    assert.equal(decideMonitorAuth("Bearer short", { HEALTH_MONITOR_SECRET: "short" }), "NOT_CONFIGURED"));
  await ok("the secret equal to CRON_SECRET → NOT_CONFIGURED (a dedicated credential only)", () =>
    assert.equal(decideMonitorAuth(`Bearer ${CRON}`, { HEALTH_MONITOR_SECRET: CRON, CRON_SECRET: CRON }), "NOT_CONFIGURED"));
  const env = { HEALTH_MONITOR_SECRET: SECRET, CRON_SECRET: CRON };
  await ok("the right Bearer → AUTHORIZED (case-insensitive scheme, surrounding space tolerated)", () => {
    assert.equal(decideMonitorAuth(`Bearer ${SECRET}`, env), "AUTHORIZED");
    assert.equal(decideMonitorAuth(`  bearer ${SECRET}  `, env), "AUTHORIZED");
  });
  await ok("missing, wrong, prefix, CRON_SECRET, basic auth, query-style → UNAUTHORIZED", () => {
    for (const h of [null, undefined, "", "Bearer", `Bearer ${SECRET.slice(0, -1)}`, `Bearer ${SECRET}x`, `Bearer ${CRON}`, `Basic ${SECRET}`, SECRET, `token=${SECRET}`]) {
      assert.equal(decideMonitorAuth(h, env), "UNAUTHORIZED", String(h));
    }
  });

  console.log("B  what it checks");
  await ok("both answer → ok, one ping on each", async () => {
    PINGS = 0;
    const { report, failures } = await probeDatabases({ runtime: up, auth: up });
    assert.equal(report.status, "ok");
    assert.deepEqual(report.checks, { runtime: "ok", auth: "ok" });
    assert.equal(failures.length, 0);
    assert.equal(PINGS, 2);
    assert.ok(!Number.isNaN(Date.parse(report.checkedAt)));
  });
  await ok("runtime down, auth up → down; auth still reported ok", async () => {
    const { report } = await probeDatabases({ runtime: failing(prismaError("PrismaClientInitializationError", "P1001", LEAKY)), auth: up });
    assert.equal(report.status, "down");
    assert.deepEqual(report.checks, { runtime: "unreachable", auth: "ok" });
  });
  await ok("auth down (credential refused), runtime up → down with auth: rejected", async () => {
    const { report } = await probeDatabases({ runtime: up, auth: failing(prismaError("PrismaClientInitializationError", "P1000", "Authentication failed against database server")) });
    assert.equal(report.status, "down");
    assert.deepEqual(report.checks, { runtime: "ok", auth: "rejected" });
  });
  await ok("auth client cannot even be built (AUTH_DATABASE_URL missing in active mode) → auth: not_configured", async () => {
    const { report } = await probeDatabases({
      runtime: up,
      auth: () => {
        throw new Error("AUTH_DATABASE_URL is not configured");
      },
    });
    assert.deepEqual(report.checks, { runtime: "ok", auth: "not_configured" });
  });

  console.log("C  fixed codes");
  await ok("Prisma / driver codes and Prisma 6 wording → fixed codes; unknown → error", () => {
    assert.equal(classifyFailure(prismaError("PrismaClientInitializationError", "P1001", "x")), "unreachable");
    assert.equal(classifyFailure(prismaError("PrismaClientKnownRequestError", "P1001", "x")), "unreachable");
    assert.equal(classifyFailure(prismaError("PrismaClientKnownRequestError", "P1017", "x")), "unreachable");
    assert.equal(classifyFailure(prismaError("PrismaClientInitializationError", "P1000", "x")), "rejected");
    assert.equal(classifyFailure(prismaError("PrismaClientInitializationError", "P1003", "x")), "rejected");
    assert.equal(classifyFailure(Object.assign(new Error("x"), { code: "ECONNREFUSED" })), "unreachable");
    // Prisma 6: an initialization error without errorCode — the wording decides (and is never echoed).
    const init = (m: string) => Object.assign(new Error(m), { name: "PrismaClientInitializationError" });
    assert.equal(classifyFailure(init("User was denied access on the database `x`")), "rejected");
    assert.equal(classifyFailure(init("Authentication failed against database server at `h`")), "rejected");
    assert.equal(classifyFailure(init(LEAKY)), "unreachable");
    assert.equal(classifyFailure(init("Your account or project has exceeded the quota")), "unreachable");
    assert.equal(classifyFailure(init("something new")), "unreachable");
    assert.equal(classifyFailure(new TypeError("boom")), "error");
    assert.equal(classifyFailure("not an error"), "error");
  });

  console.log("D  bounded in time");
  await ok(`defaults: check ${CHECK_TIMEOUT_MS} ms, probe ${PROBE_DEADLINE_MS} ms`, () => {
    assert.ok(CHECK_TIMEOUT_MS <= 3000 && PROBE_DEADLINE_MS <= 5000 && PROBE_DEADLINE_MS > CHECK_TIMEOUT_MS);
  });
  await ok("a hung check stops at its own timeout → timeout", async () => {
    const t0 = Date.now();
    const r = await runCheck(hanging, 150);
    const took = Date.now() - t0;
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.code, "timeout");
    assert.ok(took >= 140 && took < 600, `took ${took}`);
  });
  await ok("both hung → the probe still answers by its deadline, both timeout", async () => {
    const t0 = Date.now();
    const { report } = await probeDatabases({ runtime: hanging, auth: hanging }, { checkTimeoutMs: 10_000, deadlineMs: 200 });
    const took = Date.now() - t0;
    assert.deepEqual(report.checks, { runtime: "timeout", auth: "timeout" });
    assert.ok(took < 800, `took ${took}`);
  });
  await ok("one hung, one up → down within the check timeout, the healthy one ok", async () => {
    const { report } = await probeDatabases({ runtime: up, auth: hanging }, { checkTimeoutMs: 120, deadlineMs: 1000 });
    assert.deepEqual(report.checks, { runtime: "ok", auth: "timeout" });
  });

  console.log("E  recovery");
  await ok("down, then the same connections answer → ok on the next probe (nothing remembered)", async () => {
    let alive = false;
    const flaky: Ping = async () => {
      if (!alive) throw prismaError("PrismaClientInitializationError", "P1001", LEAKY);
      return [1];
    };
    assert.equal((await probeDatabases({ runtime: flaky, auth: flaky })).report.status, "down");
    alive = true;
    assert.equal((await probeDatabases({ runtime: flaky, auth: flaky })).report.status, "ok");
  });

  console.log("F  no secret leaves");
  await ok("the report never carries the error's message, host, role or password", async () => {
    const { report } = await probeDatabases({
      runtime: failing(prismaError("PrismaClientInitializationError", "P1001", LEAKY)),
      auth: failing(Object.assign(new Error(LEAKY), { code: "ECONNREFUSED" })),
    });
    const body = JSON.stringify(report);
    for (const s of ["neon.tech", "ep-secret", "SuperSecretPw", "app_runtime_prod", "postgresql://", "reach database"]) {
      assert.ok(!body.includes(s), `report leaks ${s}`);
    }
    assert.deepEqual(Object.keys(report).sort(), ["checkedAt", "checks", "ms", "status"]);
  });

  console.log("G  the route");
  const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const code = strip(fs.readFileSync(path.join(process.cwd(), "app/api/health/db/route.ts"), "utf8"));
  const core = strip(fs.readFileSync(path.join(process.cwd(), "lib/ops/db-health.ts"), "utf8"));
  await ok("auth is decided before any probe; both refusals return before probeDatabases", () => {
    const auth = code.indexOf("decideMonitorAuth(");
    const probe = code.indexOf("probeDatabases(");
    assert.ok(auth > 0 && probe > auth);
    const between = code.slice(auth, probe);
    assert.equal((between.match(/return NextResponse\.json/g) ?? []).length, 2);
    assert.ok(!/prisma\.|authDb\(\)/.test(between));
  });
  await ok("every answer carries the no-store headers; the route is dynamic, nodejs, bounded", () => {
    assert.equal((code.match(/NextResponse\.json\(/g) ?? []).length, (code.match(/headers: NO_STORE_HEADERS/g) ?? []).length);
    assert.match(code, /export const dynamic = "force-dynamic"/);
    assert.match(code, /export const runtime = "nodejs"/);
    const max = Number(/export const maxDuration = (\d+)/.exec(code)?.[1]);
    assert.ok(max * 1000 > PROBE_DEADLINE_MS);
    assert.match(NO_STORE_HEADERS["Cache-Control"], /no-store/);
    assert.equal(NO_STORE_HEADERS["CDN-Cache-Control"], "no-store");
    assert.equal(NO_STORE_HEADERS["Vercel-CDN-Cache-Control"], "no-store");
  });
  await ok("GET only — no write method is exported", () => {
    assert.match(code, /export async function GET\(/);
    assert.ok(!/export (async )?function (POST|PUT|PATCH|DELETE)\b/.test(code));
  });
  await ok("the log carries the check, the fixed code and safeErrorSummary — never the raw error", () => {
    assert.match(code, /console\.error\("\[health-db\] check failed", \{ check: f\.check, code: report\.checks\[f\.check\], \.\.\.safeErrorSummary\(f\.cause\) \}\)/);
    assert.equal((code.match(/console\./g) ?? []).length, 1);
  });
  await ok("exactly two queries, both SELECT 1 (runtime + login client); no table, no write anywhere", () => {
    assert.deepEqual(code.match(/\$queryRaw`[^`]*`/g), ["$queryRaw`SELECT 1`", "$queryRaw`SELECT 1`"]);
    assert.match(code, /runtime: \(\) => prisma\.\$queryRaw`SELECT 1`/);
    assert.match(code, /auth: \(\) => authDb\(\)\.\$queryRaw`SELECT 1`/);
    for (const src of [code, core]) {
      assert.ok(!/\$executeRaw|\$queryRawUnsafe|\$transaction|\b[A-Za-z_]\w*\.(create|update|upsert|delete)(Many)?\(/.test(src));
    }
    assert.ok(!/@\/lib\/prisma/.test(core), "the probe module holds no client");
  });

  console.log(`\n${passed} passed, 0 failed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
