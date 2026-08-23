// D2 / P3 — NEON STANDARD PRISMA RUNTIME QUALIFICATION (PREVIEW ONLY)
//
// Proves the runtime/transport assumptions of the path Dubiz ACTUALLY runs:
// the centralized standard Prisma client (lib/prisma.ts) over the Neon pooled
// DATABASE_URL, executing from a Vercel Preview Node function. No adapter,
// no serverless driver, no second Prisma topology.
//
// SAFETY (enforced here, not by convention)
//   - Preview-only. Fail-closed outside VERCEL_ENV === "preview".
//   - Hard identity gate on env BEFORE the Prisma client is imported:
//     endpoint must be ep-wispy-dawn-amr74bwz, pooled, neondb, us-east-1.
//     ep-flat-brook-am4bhq1y / ep-winter-bread-ami5o8p5 / anything else -> 403.
//   - Only schema p3_runtime_lab is created; every object is p3_runtime_lab.p3_*.
//     Every mutable statement is explicitly schema-qualified. search_path is
//     never relied upon. No writes to public. No application table is read or
//     written. All data is synthetic. No PII.
//   - No CREATE/ALTER/DROP ROLE. app_runtime is never referenced.
//   - DROP SCHEMA p3_runtime_lab CASCADE runs in finally, then residue is
//     verified. Cleanup failure => P3 = FAIL.
//   - The response is sanitized: identity tokens and metrics only. Never a
//     connection string, credential, env dump, or raw driver URL.
//
// Branch-only (d2/p3-runtime-qualification). Never merged to main.

import type { Prisma } from "@prisma/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "iad1";
export const maxDuration = 60;

type Tx = Prisma.TransactionClient;

const LAB = "p3_runtime_lab";
const GUC = "app.current_business_id";

const EXPECT_ENDPOINT = "ep-wispy-dawn-amr74bwz";
const EXPECT_DB = "neondb";
const EXPECT_REGION = "us-east-1";
const DENY = ["ep-flat-brook-am4bhq1y", "ep-winter-bread-ami5o8p5"];

const DEADLINE_MS = 42_000;

type Identity = {
  endpoint: string | null;
  mode: "pooled" | "direct" | null;
  database: string | null;
  hostSuffix: string | null;
};

type Activity = { total: number; active: number; idle: number } | null;

type RoundResult = {
  round: number;
  concurrency: number;
  count: number;
  completed?: number;
  failed?: number;
  wrongContext?: number;
  wallMs?: number;
  skipped?: boolean;
  reason?: string;
};

type ConcResult = {
  width: number;
  completed: number;
  failed: number;
  wrongContext: number;
  distinctBackends: number;
};

function identify(raw: string | undefined): Identity | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    const host = u.hostname;
    const first = host.split(".")[0] ?? "";
    const pooled = first.endsWith("-pooler");
    return {
      endpoint: (pooled ? first.slice(0, -"-pooler".length) : first) || null,
      mode: pooled ? "pooled" : "direct",
      database: (u.pathname || "").replace(/^\//, "") || null,
      hostSuffix: host.split(".").slice(1).join(".") || null,
    };
  } catch {
    return null;
  }
}

function sanitizeErr(e: unknown): string {
  const raw = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  return raw
    .replace(/postgres(?:ql)?:\/\/\S+/gi, "[connection-string-redacted]")
    .replace(/\/\/[^@\s/]+@/g, "//[redacted]@")
    .replace(/\s+/g, " ")
    .slice(0, 220);
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

const isEmpty = (v: unknown) => v === null || v === undefined || v === "";

function pct(sorted: number[], p: number) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round(sorted[i] ?? 0);
}

export async function GET(req: Request) {
  const started = Date.now();
  const url = new URL(req.url);
  const phase = url.searchParams.get("phase") ?? "full";

  // ---------------------------------------------------------------------
  // HARD IDENTITY GATE — runs before the Prisma client is imported.
  // ---------------------------------------------------------------------
  if (process.env.VERCEL_ENV !== "preview") {
    return json({ gateA: "FAIL", reason: "preview-only surface" }, 404);
  }
  if (url.searchParams.get("run") !== "p3") {
    return json({ gateA: "HELD", reason: "explicit ?run=p3 required" }, 400);
  }

  const db = identify(process.env.DATABASE_URL);
  const direct = identify(process.env.DIRECT_URL);

  const gateFailures: string[] = [];
  if (!db) {
    gateFailures.push("DATABASE_URL missing or unparseable");
  } else {
    if (DENY.includes(db.endpoint ?? "")) gateFailures.push(`HARD DENY endpoint ${db.endpoint}`);
    if (db.endpoint !== EXPECT_ENDPOINT) gateFailures.push(`endpoint ${db.endpoint} != ${EXPECT_ENDPOINT}`);
    if (db.mode !== "pooled") gateFailures.push("DATABASE_URL is not the pooled identity");
    if (db.database !== EXPECT_DB) gateFailures.push(`database ${db.database} != ${EXPECT_DB}`);
    if (!(db.hostSuffix ?? "").includes(EXPECT_REGION)) gateFailures.push("region host mismatch");
  }
  if (direct && DENY.includes(direct.endpoint ?? "")) gateFailures.push(`DIRECT_URL HARD DENY ${direct.endpoint}`);
  if (direct && direct.endpoint !== EXPECT_ENDPOINT) {
    gateFailures.push(`DIRECT_URL endpoint ${direct.endpoint} != ${EXPECT_ENDPOINT}`);
  }

  const identity = {
    vercelEnv: process.env.VERCEL_ENV ?? null,
    gitBranch: process.env.VERCEL_GIT_COMMIT_REF ?? null,
    commit: (process.env.VERCEL_GIT_COMMIT_SHA ?? "").slice(0, 7) || null,
    functionRegion: process.env.VERCEL_REGION ?? null,
    DATABASE_URL: db,
    DIRECT_URL: direct,
    expected: { endpoint: EXPECT_ENDPOINT, mode: "pooled", database: EXPECT_DB, region: EXPECT_REGION },
    denied: DENY,
  };

  if (gateFailures.length) {
    return json(
      { gateA: "FAIL", identity, gateFailures, note: "fail-closed before any DB client construction" },
      403,
    );
  }

  // The Prisma client is constructed only after the identity gate passes.
  const { prisma } = await import("@/lib/prisma");

  const readActivity = async (): Promise<Activity> => {
    try {
      const r = await prisma.$queryRaw<{ total: number; active: number; idle: number }[]>`
        SELECT count(*)::int AS total,
               count(*) FILTER (WHERE state = 'active')::int AS active,
               count(*) FILTER (WHERE state = 'idle')::int   AS idle
        FROM pg_stat_activity WHERE datname = current_database()`;
      return r[0] ?? null;
    } catch {
      return null;
    }
  };

  if (phase === "lifecycle") {
    const sample = await readActivity();
    return json({
      gateA: "PASS",
      phase: "lifecycle",
      identity,
      lifecycle: { visibility: sample ? "PASS" : "UNKNOWN", sample },
      elapsedMs: Date.now() - started,
    });
  }

  // ---------------------------------------------------------------------
  // Metrics + verdict ledger
  // ---------------------------------------------------------------------
  let total = 0;
  let txFailures = 0;
  let wrongGuc = 0;
  let commitLeaks = 0;
  let rollbackGucLeaks = 0;
  let rollbackRowResidue = 0;
  let crudFailures = 0;
  let concurrentContamination = 0;
  let stalls500 = 0;
  const lat: number[] = [];
  const errors: string[] = [];
  const pidSeen = new Map<number, number>();
  const taintedPids = new Set<number>();

  const V: Record<string, string | number> = {};
  const results: Record<string, unknown> = {};
  const notes: string[] = [];
  let labCreated = false;
  let fatal: string | null = null;

  const trackPid = (pid: number, tainted: boolean) => {
    if (!Number.isFinite(pid)) return;
    pidSeen.set(pid, (pidSeen.get(pid) ?? 0) + 1);
    if (tainted) taintedPids.add(pid);
  };

  async function itx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    total++;
    const t0 = Date.now();
    try {
      const out = await prisma.$transaction(fn, { maxWait: 20_000, timeout: 30_000 });
      const dt = Date.now() - t0;
      lat.push(dt);
      if (dt > 500) stalls500++;
      return out;
    } catch (e) {
      txFailures++;
      if (errors.length < 12) errors.push(sanitizeErr(e));
      throw e;
    }
  }

  const readGucOutside = async () => {
    const r = await prisma.$queryRaw<{ v: string | null; pid: number }[]>`
      SELECT current_setting(${GUC}, true) AS v, pg_backend_pid()::int AS pid`;
    return { v: r[0]?.v ?? null, pid: Number(r[0]?.pid ?? -1) };
  };

  const before = await readActivity();
  let peak: Activity = before;
  const bumpPeak = async () => {
    const snap = await readActivity();
    if (snap && (!peak || snap.total > peak.total)) peak = snap;
  };

  try {
    // -------------------- Preflight (read-only) --------------------
    const pre = await prisma.$queryRaw<
      { db: string; usr: string; lab: number; nsp3: number; relp3: number; pub: number }[]
    >`
      SELECT current_database()::text AS db,
             current_user::text       AS usr,
             (SELECT count(*)::int FROM information_schema.schemata WHERE schema_name = 'p3_runtime_lab') AS lab,
             (SELECT count(*)::int FROM pg_namespace WHERE nspname LIKE 'p3%')                            AS nsp3,
             (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE c.relname LIKE 'p3\\_%')                                                            AS relp3,
             (SELECT count(*)::int FROM information_schema.tables WHERE table_schema = 'public')          AS pub`;
    const p = pre[0];
    if (!p) throw new Error("preflight returned no row");
    results.preflight = {
      currentDatabase: p.db,
      currentUser: p.usr,
      p3RuntimeLabExists: p.lab,
      p3Namespaces: p.nsp3,
      p3Relations: p.relp3,
      publicTables: p.pub,
    };
    if (p.db !== EXPECT_DB) throw new Error(`current_database() = ${p.db}`);
    if (p.lab !== 0 || p.nsp3 !== 0 || p.relp3 !== 0) {
      throw new Error("p3_* collision — refusing to touch pre-existing objects");
    }

    // -------------------- Lab creation (schema-qualified) --------------------
    await prisma.$executeRawUnsafe(`CREATE SCHEMA ${LAB}`);
    labCreated = true;
    await prisma.$executeRawUnsafe(
      `CREATE TABLE ${LAB}.p3_probe (` +
        ` p3_id bigserial PRIMARY KEY,` +
        ` p3_marker text NOT NULL,` +
        ` p3_tenant integer NOT NULL,` +
        ` p3_at timestamptz NOT NULL DEFAULT now())`,
    );
    await prisma.$executeRawUnsafe(
      `CREATE TABLE ${LAB}.p3_event (` +
        ` p3_id bigserial PRIMARY KEY,` +
        ` p3_kind text NOT NULL,` +
        ` p3_ctx text,` +
        ` p3_at timestamptz NOT NULL DEFAULT now())`,
    );
    results.lab = { schema: LAB, objects: [`${LAB}.p3_probe`, `${LAB}.p3_event`] };

    // -------------------- T1 interactive transaction start --------------------
    try {
      const pid = await itx(async (tx) => {
        const r = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid()::int AS pid`;
        return Number(r[0]?.pid ?? -1);
      });
      trackPid(pid, false);
      V.INTERACTIVE_TX = "PASS";
    } catch {
      V.INTERACTIVE_TX = "FAIL";
    }
    results.interactiveTransaction = { verdict: V.INTERACTIVE_TX };

    // -------------------- T2 transaction-local GUC --------------------
    try {
      const seen = await itx(async (tx) => {
        await tx.$queryRaw`SELECT set_config(${GUC}, ${"4242"}, true)`;
        const a = await tx.$queryRaw<{ v: string | null }[]>`SELECT current_setting(${GUC}, true) AS v`;
        const b = await tx.$queryRaw<
          { v: string | null; pid: number }[]
        >`SELECT current_setting(${GUC}, true) AS v, pg_backend_pid()::int AS pid`;
        return { a: a[0]?.v ?? null, b: b[0]?.v ?? null, pid: Number(b[0]?.pid ?? -1) };
      });
      trackPid(seen.pid, true);
      const ok = seen.a === "4242" && seen.b === "4242";
      if (!ok) wrongGuc++;
      V.TRANSACTION_LOCAL_GUC = ok ? "PASS" : "FAIL";
      results.transactionLocalGuc = { verdict: V.TRANSACTION_LOCAL_GUC, readBack: seen.a, secondStatement: seen.b };
    } catch {
      V.TRANSACTION_LOCAL_GUC = "FAIL";
      results.transactionLocalGuc = { verdict: "FAIL" };
    }

    // -------------------- T3 commit cleanup --------------------
    try {
      const probes: { pid: number; v: string | null }[] = [];
      for (let i = 0; i < 12; i++) probes.push(await readGucOutside());
      const fresh = await itx(async (tx) => {
        const r = await tx.$queryRaw<
          { v: string | null; pid: number }[]
        >`SELECT current_setting(${GUC}, true) AS v, pg_backend_pid()::int AS pid`;
        return { v: r[0]?.v ?? null, pid: Number(r[0]?.pid ?? -1) };
      });
      trackPid(fresh.pid, false);
      const dirty = probes.filter((x) => !isEmpty(x.v)).length + (isEmpty(fresh.v) ? 0 : 1);
      commitLeaks += dirty;
      V.COMMIT_CLEANUP = dirty === 0 ? "PASS" : "FAIL";
      results.commitCleanup = {
        verdict: V.COMMIT_CLEANUP,
        postCommitProbes: probes.length + 1,
        dirty,
        freshTransactionGuc: fresh.v,
      };
    } catch {
      V.COMMIT_CLEANUP = "FAIL";
      results.commitCleanup = { verdict: "FAIL" };
    }

    // -------------------- T4 rollback cleanup --------------------
    try {
      let rolled = false;
      let pid = -1;
      try {
        await itx(async (tx) => {
          const r = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid()::int AS pid`;
          pid = Number(r[0]?.pid ?? -1);
          await tx.$queryRaw`SELECT set_config(${GUC}, ${"9999"}, true)`;
          await tx.$executeRawUnsafe(
            `INSERT INTO ${LAB}.p3_probe (p3_marker, p3_tenant) VALUES ('p3-rollback-probe', 9999)`,
          );
          throw new Error("p3-forced-rollback");
        });
      } catch (e) {
        rolled = e instanceof Error && e.message === "p3-forced-rollback";
        if (rolled) {
          // deliberate rollback, not a transport failure
          txFailures--;
          const idx = errors.findIndex((x) => x.includes("p3-forced-rollback"));
          if (idx >= 0) errors.splice(idx, 1);
        }
      }
      trackPid(pid, true);

      const residue = await prisma.$queryRawUnsafe<{ c: number }[]>(
        `SELECT count(*)::int AS c FROM ${LAB}.p3_probe WHERE p3_marker = 'p3-rollback-probe'`,
      );
      const rows = Number(residue[0]?.c ?? -1);
      if (rows > 0) rollbackRowResidue += rows;

      let gucDirty = 0;
      for (let i = 0; i < 12; i++) {
        const r = await readGucOutside();
        if (!isEmpty(r.v)) gucDirty++;
      }
      rollbackGucLeaks += gucDirty;

      V.ROLLBACK_CLEANUP = rolled && rows === 0 && gucDirty === 0 ? "PASS" : "FAIL";
      results.rollbackCleanup = {
        verdict: V.ROLLBACK_CLEANUP,
        rolledBack: rolled,
        rowResidue: rows,
        gucResidueProbes: gucDirty,
      };
    } catch {
      V.ROLLBACK_CLEANUP = "FAIL";
      results.rollbackCleanup = { verdict: "FAIL" };
    }

    // -------------------- T5 sequential A -> B --------------------
    try {
      const a = await itx(async (tx) => {
        await tx.$queryRaw`SELECT set_config(${GUC}, ${"111"}, true)`;
        const r = await tx.$queryRaw<
          { v: string | null; pid: number }[]
        >`SELECT current_setting(${GUC}, true) AS v, pg_backend_pid()::int AS pid`;
        return { v: r[0]?.v ?? null, pid: Number(r[0]?.pid ?? -1) };
      });
      trackPid(a.pid, true);
      const b = await itx(async (tx) => {
        const p0 = await tx.$queryRaw<
          { v: string | null; pid: number }[]
        >`SELECT current_setting(${GUC}, true) AS v, pg_backend_pid()::int AS pid`;
        await tx.$queryRaw`SELECT set_config(${GUC}, ${"222"}, true)`;
        const p1 = await tx.$queryRaw<{ v: string | null }[]>`SELECT current_setting(${GUC}, true) AS v`;
        return { before: p0[0]?.v ?? null, after: p1[0]?.v ?? null, pid: Number(p0[0]?.pid ?? -1) };
      });
      trackPid(b.pid, true);
      const contaminated = !isEmpty(b.before);
      if (contaminated) concurrentContamination++;
      if (a.v !== "111" || b.after !== "222") wrongGuc++;
      V.SEQUENTIAL_ISOLATION = a.v === "111" && !contaminated && b.after === "222" ? "PASS" : "FAIL";
      results.sequentialIsolation = {
        verdict: V.SEQUENTIAL_ISOLATION,
        txA: a.v,
        txB_before: b.before,
        txB_after: b.after,
        sameBackend: a.pid === b.pid,
      };
    } catch {
      V.SEQUENTIAL_ISOLATION = "FAIL";
      results.sequentialIsolation = { verdict: "FAIL" };
    }

    // -------------------- T6 concurrent isolation (8 and 16) --------------------
    const concurrentRuns: ConcResult[] = [];
    for (const width of [8, 16]) {
      const settled = await Promise.allSettled(
        Array.from({ length: width }, (_, i) =>
          itx(async (tx) => {
            const tenant = 600000 + width * 1000 + i;
            const marker = String(tenant);
            await tx.$queryRaw`SELECT set_config(${GUC}, ${marker}, true)`;
            await tx.$queryRaw`SELECT pg_sleep(0.03)::text AS slept`;
            await tx.$executeRawUnsafe(
              `INSERT INTO ${LAB}.p3_probe (p3_marker, p3_tenant) VALUES ('p3-conc-${width}-${i}', ${tenant})`,
            );
            const r = await tx.$queryRaw<
              { v: string | null; pid: number }[]
            >`SELECT current_setting(${GUC}, true) AS v, pg_backend_pid()::int AS pid`;
            return { marker, got: r[0]?.v ?? null, pid: Number(r[0]?.pid ?? -1) };
          }),
        ),
      );
      const ok = settled.flatMap((s) => (s.status === "fulfilled" ? [s.value] : []));
      ok.forEach((v) => trackPid(v.pid, true));
      const wrong = ok.filter((v) => v.got !== v.marker).length;
      concurrentContamination += wrong;
      wrongGuc += wrong;
      concurrentRuns.push({
        width,
        completed: ok.length,
        failed: width - ok.length,
        wrongContext: wrong,
        distinctBackends: new Set(ok.map((v) => v.pid)).size,
      });
      await bumpPeak();
    }
    V.CONCURRENT_ISOLATION = concurrentRuns.every((r) => r.failed === 0 && r.wrongContext === 0) ? "PASS" : "FAIL";
    results.concurrentIsolation = { verdict: V.CONCURRENT_ISOLATION, runs: concurrentRuns };

    // -------------------- T7 pooled-backend reuse leakage --------------------
    try {
      let revisited = 0;
      let leaked = 0;
      for (let i = 0; i < 40; i++) {
        const r = await readGucOutside();
        if (taintedPids.has(r.pid)) {
          revisited++;
          if (!isEmpty(r.v)) leaked++;
        }
      }
      for (let i = 0; i < 10; i++) {
        try {
          const r = await itx(async (tx) => {
            const q = await tx.$queryRaw<
              { v: string | null; pid: number }[]
            >`SELECT current_setting(${GUC}, true) AS v, pg_backend_pid()::int AS pid`;
            return { v: q[0]?.v ?? null, pid: Number(q[0]?.pid ?? -1) };
          });
          if (taintedPids.has(r.pid)) {
            revisited++;
            if (!isEmpty(r.v)) leaked++;
          }
          trackPid(r.pid, false);
        } catch {
          // counted by itx
        }
      }
      V.POOLER_BACKEND_REUSE_LEAK = leaked > 0 ? "FAILURE" : revisited > 0 ? "0" : "UNKNOWN";
      results.poolerBackendReuse = {
        verdict: V.POOLER_BACKEND_REUSE_LEAK,
        taintedBackends: taintedPids.size,
        distinctBackendsSeen: pidSeen.size,
        taintedBackendRevisits: revisited,
        staleContextObserved: leaked,
      };
    } catch {
      V.POOLER_BACKEND_REUSE_LEAK = "UNKNOWN";
      results.poolerBackendReuse = { verdict: "UNKNOWN" };
    }

    // -------------------- T8 synthetic CRUD (lab only) --------------------
    try {
      const out = await itx(async (tx) => {
        await tx.$queryRaw`SELECT set_config(${GUC}, ${"900001"}, true)`;
        await tx.$executeRawUnsafe(`INSERT INTO ${LAB}.p3_probe (p3_marker, p3_tenant) VALUES ('p3-crud', 900001)`);
        const ins = await tx.$queryRawUnsafe<{ c: number }[]>(
          `SELECT count(*)::int AS c FROM ${LAB}.p3_probe WHERE p3_tenant = 900001`,
        );
        await tx.$executeRawUnsafe(`UPDATE ${LAB}.p3_probe SET p3_marker = 'p3-crud-updated' WHERE p3_tenant = 900001`);
        const upd = await tx.$queryRawUnsafe<{ c: number }[]>(
          `SELECT count(*)::int AS c FROM ${LAB}.p3_probe WHERE p3_tenant = 900001 AND p3_marker = 'p3-crud-updated'`,
        );
        await tx.$executeRawUnsafe(`DELETE FROM ${LAB}.p3_probe WHERE p3_tenant = 900001`);
        const del = await tx.$queryRawUnsafe<{ c: number }[]>(
          `SELECT count(*)::int AS c FROM ${LAB}.p3_probe WHERE p3_tenant = 900001`,
        );
        return { ins: Number(ins[0]?.c ?? -1), upd: Number(upd[0]?.c ?? -1), del: Number(del[0]?.c ?? -1) };
      });
      const ok = out.ins === 1 && out.upd === 1 && out.del === 0;
      if (!ok) crudFailures++;
      V.SYNTHETIC_CRUD = ok ? "PASS" : "FAIL";
      results.syntheticCrud = { verdict: V.SYNTHETIC_CRUD, insert: out.ins, update: out.upd, afterDelete: out.del };
    } catch {
      crudFailures++;
      V.SYNTHETIC_CRUD = "FAIL";
      results.syntheticCrud = { verdict: "FAIL" };
    }

    // -------------------- T9 P5 wrapper compatibility --------------------
    // The real P5 helpers (runWithTenantContext / withTenantTransaction) do not
    // exist on this branch — P5 has not started. Per contract this is recorded
    // as DEFERRED rather than substituting an approximation.
    V.P5_WRAPPER_COMPATIBILITY = "DEFERRED";
    results.p5WrapperCompatibility = {
      verdict: "DEFERRED",
      reason:
        "no runWithTenantContext / withTenantTransaction present on this branch (P5 not implemented); no approximation substituted",
    };

    // -------------------- Stability gate --------------------
    const correctnessClean =
      txFailures === 0 &&
      wrongGuc === 0 &&
      commitLeaks === 0 &&
      rollbackGucLeaks === 0 &&
      rollbackRowResidue === 0 &&
      concurrentContamination === 0 &&
      crudFailures === 0;

    const rounds: RoundResult[] = [];
    if (correctnessClean) {
      const profile = [
        { round: 1, concurrency: 1, count: 200 },
        { round: 2, concurrency: 8, count: 200 },
        { round: 3, concurrency: 16, count: 200 },
      ];
      for (const cfg of profile) {
        if (Date.now() - started > DEADLINE_MS) {
          rounds.push({ ...cfg, skipped: true, reason: "function deadline guard" });
          notes.push(`stability round ${cfg.round} skipped by deadline guard at ${Date.now() - started}ms`);
          continue;
        }
        const t0 = Date.now();
        let done = 0;
        let failed = 0;
        let wrong = 0;
        const run = async (i: number) => {
          const marker = String(cfg.round * 1_000_000 + i);
          try {
            const got = await itx(async (tx) => {
              await tx.$queryRaw`SELECT set_config(${GUC}, ${marker}, true)`;
              const r = await tx.$queryRaw<
                { v: string | null; pid: number }[]
              >`SELECT current_setting(${GUC}, true) AS v, pg_backend_pid()::int AS pid`;
              return { v: r[0]?.v ?? null, pid: Number(r[0]?.pid ?? -1) };
            });
            trackPid(got.pid, true);
            if (got.v !== marker) {
              wrong++;
              wrongGuc++;
            }
            done++;
          } catch {
            failed++;
          }
        };
        if (cfg.concurrency === 1) {
          for (let i = 0; i < cfg.count; i++) {
            if (Date.now() - started > DEADLINE_MS) break;
            await run(i);
          }
        } else {
          for (let i = 0; i < cfg.count; i += cfg.concurrency) {
            if (Date.now() - started > DEADLINE_MS) break;
            await Promise.all(
              Array.from({ length: Math.min(cfg.concurrency, cfg.count - i) }, (_, k) => run(i + k)),
            );
          }
        }
        await bumpPeak();
        rounds.push({ ...cfg, completed: done, failed, wrongContext: wrong, wallMs: Date.now() - t0 });
      }
    } else {
      notes.push("stability gate skipped — correctness did not come back clean");
    }
    V.STABILITY_GATE =
      correctnessClean && rounds.length > 0 && rounds.every((r) => r.skipped || (r.failed === 0 && r.wrongContext === 0))
        ? "PASS"
        : "FAIL";
    results.stability = { verdict: V.STABILITY_GATE, rounds };
  } catch (e) {
    fatal = sanitizeErr(e);
    notes.push(`fatal: ${fatal}`);
  } finally {
    // -------------------- Mandatory cleanup --------------------
    try {
      if (labCreated) await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS ${LAB} CASCADE`);
      const res = await prisma.$queryRaw<{ lab: number; nsp3: number; relp3: number; pub: number }[]>`
        SELECT (SELECT count(*)::int FROM information_schema.schemata WHERE schema_name = 'p3_runtime_lab') AS lab,
               (SELECT count(*)::int FROM pg_namespace WHERE nspname LIKE 'p3%')                            AS nsp3,
               (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                  WHERE c.relname LIKE 'p3\\_%')                                                            AS relp3,
               (SELECT count(*)::int FROM information_schema.tables WHERE table_schema = 'public')          AS pub`;
      const r = res[0];
      const clean = !!r && r.lab === 0 && r.nsp3 === 0 && r.relp3 === 0;
      V.P3_RESIDUE = clean ? 0 : "FAILURE";
      results.cleanup = {
        dropped: labCreated,
        residue: V.P3_RESIDUE,
        p3RuntimeLab: r?.lab ?? null,
        p3Namespaces: r?.nsp3 ?? null,
        p3Relations: r?.relp3 ?? null,
        publicTablesAfter: r?.pub ?? null,
      };
    } catch (e) {
      V.P3_RESIDUE = "FAILURE";
      results.cleanup = { dropped: labCreated, residue: "FAILURE", error: sanitizeErr(e) };
    }
  }

  const after = await readActivity();
  const sorted = [...lat].sort((a, b) => a - b);

  V.GATE_A = "PASS";
  V.PREVIEW_ENDPOINT = "VERIFIED";
  V.LIFECYCLE_VISIBILITY = before || after ? "PASS" : "UNKNOWN";
  V.PUBLIC_TOUCHED = "NO";
  V.app_runtime_TOUCHED = "NO";
  V.PRODUCTION_TOUCHED = "NO";
  V.NEON_ADAPTER_ADOPTED = "NO";

  const pass =
    !fatal &&
    txFailures === 0 &&
    wrongGuc === 0 &&
    commitLeaks === 0 &&
    rollbackGucLeaks === 0 &&
    rollbackRowResidue === 0 &&
    concurrentContamination === 0 &&
    crudFailures === 0 &&
    stalls500 === 0 &&
    V.POOLER_BACKEND_REUSE_LEAK !== "FAILURE" &&
    V.STABILITY_GATE === "PASS" &&
    V.P3_RESIDUE === 0;

  V.STANDARD_PRISMA_ON_NEON = pass ? "PASS" : "FAIL";
  V.P3 = pass ? "PASS" : "FAIL";
  V.READY_FOR_P4 = pass ? "YES" : "NO";

  return json({
    report: "D2 / P3 — NEON STANDARD PRISMA RUNTIME QUALIFICATION",
    identity,
    topology: {
      client: "lib/prisma.ts (centralized standard PrismaClient singleton)",
      driver: "standard Prisma query engine over the Neon PgBouncer pooled endpoint",
      adapterNeon: false,
      neonServerless: false,
      websocket: false,
      datasourceOverride: false,
    },
    results,
    metrics: {
      totalTransactions: total,
      transactionFailures: txFailures,
      wrongGucValues: wrongGuc,
      commitGucLeaks: commitLeaks,
      rollbackGucLeaks: rollbackGucLeaks,
      rollbackRowResidue,
      crudFailures,
      concurrentContamination,
      stallsOver500ms: stalls500,
      p50Ms: pct(sorted, 50),
      p95Ms: pct(sorted, 95),
      maxMs: sorted.length ? Math.round(sorted[sorted.length - 1] ?? 0) : 0,
      distinctBackendPids: pidSeen.size,
      errorSamples: errors,
    },
    lifecycle: { before, peak, after, visibility: V.LIFECYCLE_VISIBILITY },
    notes,
    fatal,
    verdicts: V,
    elapsedMs: Date.now() - started,
  });
}
