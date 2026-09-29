/**
 * Knowledge-derive authority — the battery. The REAL /api/knowledge/derive handler, called in-process, as a
 * MEASURED NOSUPERUSER + NOBYPASSRLS role, with the model provider replaced by a local counting server
 * (OPENAI_BASE_URL) so "zero provider calls" is measured, not assumed. No paid call is made.
 *
 *   A1  dedicated authority + ACTIVE + ENROLLED business → derivation runs, one run row, one SUCCESS event
 *   A2  missing / wrong / general-CRON_SECRET authority → refused; ZERO mutations; ZERO provider calls
 *   A3  a dedicated secret equal to CRON_SECRET → not configured (fail closed)
 *   A4  arbitrary / not-enrolled / invalid business id → refused; ZERO mutations
 *   A5  deletion quarantine and purged business → refused; ZERO mutations, recommendations, provider calls
 *   A6  tenant A's run never writes tenant B
 *   A7  retry inside the cooldown → refused (429), nothing written
 *   A8  concurrent same-business runs → exactly one proceeds (409 for the other)
 *   A9  the Brain inside its own cooldown → the derivation runs, the provider is NOT called again
 *   A10 audit: every attempt is one SecurityEvent (codes/counts only); the run ledger is append-only
 *   A11 privacy: no secret or business value in responses, events or logs
 *
 * Synthetic lab data only; nothing here touches Production.
 */
import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import crypto from "node:crypto";

const ADMIN_URL = process.env.M0_ADMIN_URL ?? process.env.DATABASE_URL;
if (!ADMIN_URL) throw new Error("M0_ADMIN_URL (or DATABASE_URL) must point at a throwaway lab cluster");
for (const host of ["ep-flat-brook-am4bhq1y", "ep-winter-bread-ami5o8p5"]) {
  if (ADMIN_URL.includes(host)) throw new Error(`DENY: ${host} is not a laboratory`);
}
const NONCE = crypto.randomBytes(4).toString("hex");
const RT_ROLE = `kd_rt_${NONCE}`;
const RT_PW = crypto.randomBytes(18).toString("hex");
const GROUP = "app_runtime";
const DERIVE_SECRET = `derive-${crypto.randomBytes(24).toString("hex")}`;
const CRON = `cron-${crypto.randomBytes(24).toString("hex")}`;
const KD_MIGRATION = "prisma/migrations/20260930090000_knowledge_derive_authority/migration.sql";
const SECF = "prisma/migrations/20260926140000_sec_f_append_only_audit_fiscal_immutability_security_events/migration.sql";

let passed = 0;
let failed = 0;
const fails: string[] = [];
function check(label: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; console.log(`  [PASS] ${label}`); }
  else { failed++; fails.push(label); console.log(`  [FAIL] ${label}${detail ? ` — ${detail}` : ""}`); }
}
function section(t: string): void { console.log(`\n== ${t} ==`); }
const owner = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });

function sqlStatements(file: string, keep: RegExp, drop?: RegExp): string[] {
  const sql = readFileSync(join(process.cwd(), file), "utf8").replace(/\r\n/g, "\n").split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");
  const out: string[] = [];
  let cur = "";
  let tag: string | null = null;
  for (let i = 0; i < sql.length; i++) {
    const m = /^\$\w*\$/.exec(sql.slice(i, i + 40));
    if (m) { tag = tag === null ? m[0] : tag === m[0] ? null : tag; cur += m[0]; i += m[0].length - 1; continue; }
    if (sql[i] === ";" && tag === null) { out.push(cur.trim()); cur = ""; continue; }
    cur += sql[i];
  }
  if (cur.trim()) out.push(cur.trim());
  return out.filter((s) => s && keep.test(s) && !(drop && drop.test(s)));
}

// Every table a derivation could conceivably write, counted exactly.
const WRITE_TABLES = ["KnowledgeMeasure", "KnowledgeMeasureEvidenceLink", "TemporalKnowledge", "BusinessInsight", "EntityLinkProposal",
  "PartyResolutionClaim", "Party", "LearningEvent", "OutcomeRecommendation", "OutcomeDecision", "OutcomeActionEvent", "OutcomeObservation",
  "OutcomeAssessment", "KnowledgeDerivationRun"];
async function writeCounts(biz?: number): Promise<string> {
  const parts: string[] = [];
  for (const t of WRITE_TABLES) {
    const where = biz == null ? "" : ` WHERE "businessId" = ${biz}`;
    parts.push(`${t}=${(await owner.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM "${t}"${where}`))[0].n}`);
  }
  return parts.join(",");
}
const events = async (reason: string | null = null) => Number((await owner.$queryRawUnsafe<{ n: number }[]>(
  `SELECT count(*)::int AS n FROM "SecurityEvent" WHERE "eventType" = 'KNOWLEDGE_DERIVE'${reason ? ` AND "reasonClass" = '${reason}'` : ""}`))[0].n);

async function main(): Promise<void> {
  section("Provision — restricted role, shipped policies, SecurityEvent, the derive-authority migration, fake provider");
  for (const r of [GROUP, "app_admin", "app_ctlplane", "app_auth"]) {
    await owner.$executeRawUnsafe(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN CREATE ROLE ${r} NOLOGIN; END IF; END $$`);
  }
  await owner.$executeRawUnsafe(`CREATE ROLE ${RT_ROLE} LOGIN PASSWORD '${RT_PW}' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION IN ROLE ${GROUP}`);
  for (const f of [
    "prisma/migrations/20260825150000_d2_p7_wave2_tenant_rls/migration.sql",
    "prisma/migrations/20260825200000_d2_p7_wave3_tenant_rls/migration.sql",
    "prisma/migrations/20260827090000_d2_p7_w4d_documents_tenant_rls/migration.sql",
    "prisma/migrations/20260917090100_payables_phase_1a_tenant_rls/migration.sql",
    "prisma/migrations/20260923100000_m2_knowledge_measure/migration.sql",
    "prisma/migrations/20260923110000_m3_business_insight/migration.sql",
    "prisma/migrations/20260924090100_m4_m5_knowledge_expansion/migration.sql",
    "prisma/migrations/20260926090000_m6_temporal_knowledge/migration.sql",
    "prisma/migrations/20260901090000_d2_pw2_business_feature_access_rls/migration.sql",
  ]) for (const s of sqlStatements(f, /ROW LEVEL SECURITY|CREATE POLICY|DROP POLICY/, /^DO /)) await owner.$executeRawUnsafe(s);
  for (const f of ["prisma/migrations/20260924090100_m4_m5_knowledge_expansion/migration.sql",
    "prisma/migrations/20260925090000_m55_sensor_fabric/migration.sql", "prisma/migrations/20260926090000_m6_temporal_knowledge/migration.sql"]) {
    for (const s of sqlStatements(f, /^INSERT INTO "DerivationPolicy/)) await owner.$executeRawUnsafe(s);
  }
  // SecurityEvent is SQL-only (no Prisma model): the shipped DDL, guards and policies.
  for (const s of sqlStatements(SECF, /FUNCTION public\.secf_(append_only|truncate)_guard|"SecurityEvent"/, /^DO /)) await owner.$executeRawUnsafe(s);
  // The derive-authority migration: feature rows, CHECKs, the one-running index, the guard, RLS, policies.
  for (const s of sqlStatements(KD_MIGRATION,
    /^INSERT INTO "PlatformFeature|_chk"|one_running_key|FUNCTION public\.kdr_run_guard|^REVOKE ALL ON FUNCTION|^CREATE TRIGGER|ROW LEVEL SECURITY|^CREATE POLICY/)) {
    await owner.$executeRawUnsafe(s);
  }
  await owner.$executeRawUnsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${GROUP}`);
  await owner.$executeRawUnsafe(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${GROUP}`);
  // …then the shipped grant blocks, which take back what the blanket grant gave.
  for (const s of sqlStatements(KD_MIGRATION, /^DO \$do\$/)) await owner.$executeRawUnsafe(s);
  await owner.$executeRawUnsafe(`REVOKE SELECT, UPDATE, DELETE, TRUNCATE ON "SecurityEvent" FROM ${GROUP}`);
  await owner.$executeRawUnsafe(`GRANT INSERT ON "SecurityEvent" TO ${GROUP}`);

  // The fake provider: counts calls, answers a valid empty result for whatever context it was given.
  let providerCalls = 0;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      providerCalls += 1;
      const fp = /contextFingerprint: (\w+)/.exec(body)?.[1] ?? "x";
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id: "x", object: "chat.completion", created: 0, model: "fake", usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify({ contextFingerprint: fp, outcome: "NO_ACTIONABLE_INSIGHT", findings: [] }) } }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;

  const rtUrl = (() => { const u = new URL(ADMIN_URL!); u.username = RT_ROLE; u.password = RT_PW; return u.toString(); })();
  Object.assign(process.env, {
    DATABASE_URL: rtUrl, DIRECT_URL: rtUrl, KNOWLEDGE_DERIVE_SECRET: DERIVE_SECRET, CRON_SECRET: CRON,
    OPENAI_API_KEY: "sk-lab-not-a-real-key-0000000000", OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1`,
    KNOWLEDGE_DERIVE_COOLDOWN_SECONDS: "600", KNOWLEDGE_DERIVE_BRAIN_COOLDOWN_SECONDS: "21600", KNOWLEDGE_DERIVE_LEASE_SECONDS: "300",
  });
  delete process.env.BRAIN_MODE;
  delete process.env.OUTCOMES_MODE;
  const rt = new PrismaClient({ datasources: { db: { url: rtUrl } } });
  const posture = await owner.$queryRawUnsafe<{ s: boolean; b: boolean }[]>(`SELECT rolsuper AS s, rolbypassrls AS b FROM pg_roles WHERE rolname='${RT_ROLE}'`);
  check("the runtime role is NOSUPERUSER + NOBYPASSRLS", posture[0]?.s === false && posture[0]?.b === false);
  check("the application code is connected as the restricted role", (await rt.$queryRawUnsafe<{ u: string }[]>(`SELECT current_user AS u`))[0]?.u === RT_ROLE);

  // Capture everything the handler logs, to prove it never prints a secret or a business value.
  const logged: string[] = [];
  for (const k of ["log", "info", "warn", "error"] as const) {
    const orig = console[k].bind(console);
    console[k] = (...a: unknown[]) => { logged.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")); if (!String(a[0] ?? "").startsWith("  [")) return; orig(...a); };
  }
  const say = (s: string) => process.stdout.write(`${s}\n`);
  const { POST } = await import("@/app/api/knowledge/derive/route");
  const { NextRequest } = await import("next/server");
  const call = async (q: string, auth: string | null, callerRun: string | null = "12345") => {
    const headers: Record<string, string> = {};
    if (auth != null) headers.authorization = auth;
    if (callerRun != null) headers["x-derive-caller-run"] = callerRun;
    const res = await POST(new NextRequest(`http://lab.local/api/knowledge/derive?${q}`, { method: "POST", headers }));
    return { status: res.status, body: (await res.json()) as Record<string, unknown>, text: "" };
  };
  const bearer = (s: string) => `Bearer ${s}`;

  say("\n== Seed — two look-alike businesses with real filing history; A and B enrolled, C not ==");
  const seed = async (label: string) => {
    const b = await owner.business.create({ data: { name: `KD ${label} Secret Vendor ${NONCE}` } });
    for (let i = 0; i < 6; i++) {
      const d = await owner.document.create({ data: { businessId: b.id, fileUrl: `s3://kd/${NONCE}-${label}-${i}`, source: "upload", mimeType: "application/pdf", status: "approved" } as never });
      await owner.financialRecord.create({ data: { documentId: d.id, businessId: b.id, amount: 7777 + i, date: new Date(Date.now() - (20 + i * 15) * 86_400_000),
        vendorName: "Secret Vendor Ltd", direction: "expense", category: "lab", approvedAt: new Date(Date.now() - (17 + i * 15) * 86_400_000) } as never });
    }
    return b.id;
  };
  const A = await seed("A");
  const B = await seed("B");
  const C = await seed("C");
  const Q = await seed("Q");
  const P = await seed("P");
  for (const biz of [A, B, Q, P]) {
    await owner.businessFeatureAccess.create({ data: { businessId: biz, featureKey: "knowledge_derivation", state: "ENABLED" } as never });
  }

  section("A2/A3 — authority");
  let before = await writeCounts();
  let calls0 = providerCalls;
  const noAuth = await call(`businessId=${A}&brain=shadow`, null);
  const wrong = await call(`businessId=${A}&brain=shadow`, bearer("x".repeat(48)));
  const cron = await call(`businessId=${A}&brain=shadow`, bearer(CRON));
  check("missing authority → 401", noAuth.status === 401);
  check("wrong authority → 401", wrong.status === 401);
  check("the general CRON_SECRET → 401 (it can no longer trigger derive)", cron.status === 401);
  check("… zero mutations, zero provider calls", (await writeCounts()) === before && providerCalls === calls0);
  check("… each refusal is one DENIED security event (unauthorized)", (await events("unauthorized")) === 3);
  process.env.KNOWLEDGE_DERIVE_SECRET = CRON;
  const same = await call(`businessId=${A}`, bearer(CRON));
  process.env.KNOWLEDGE_DERIVE_SECRET = DERIVE_SECRET;
  check("a dedicated secret EQUAL to CRON_SECRET is not configured → 503", same.status === 503 && (await writeCounts()) === before);

  section("A4 — the request's businessId never grants authority");
  const notEnrolled = await call(`businessId=${C}&brain=shadow`, bearer(DERIVE_SECRET));
  const unknown = await call(`businessId=999999999&brain=shadow`, bearer(DERIVE_SECRET));
  const invalid = await call(`businessId=abc`, bearer(DERIVE_SECRET));
  check("a real but NOT enrolled business → 403 not_enrolled", notEnrolled.status === 403 && notEnrolled.body.error === "not_enrolled");
  check("a non-existent business → 403 not_active (lifecycle UNKNOWN)", unknown.status === 403 && unknown.body.error === "not_active");
  check("an invalid id → 400", invalid.status === 400);
  check("… zero mutations, zero provider calls", (await writeCounts()) === before && providerCalls === calls0);

  section("A5 — lifecycle: deletion quarantine and purged");
  await owner.business.update({ where: { id: Q }, data: { deletionRequestedAt: new Date() } as never });
  await owner.business.update({ where: { id: P }, data: { deletionRequestedAt: new Date(), deletedAt: new Date() } as never });
  const quarantined = await call(`businessId=${Q}&brain=shadow`, bearer(DERIVE_SECRET));
  const purged = await call(`businessId=${P}&brain=shadow`, bearer(DERIVE_SECRET));
  check("an enrolled business in DELETION QUARANTINE → 403 not_active", quarantined.status === 403 && quarantined.body.error === "not_active");
  check("an enrolled PURGED business → 403 not_active", purged.status === 403 && purged.body.error === "not_active");
  check("… zero mutations (no run, no knowledge, no recommendation) and zero provider calls",
    (await writeCounts()) === before && providerCalls === calls0 &&
    (await owner.outcomeRecommendation.count({ where: { businessId: { in: [Q, P] } } })) === 0);

  section("A1/A6 — dedicated authority + ACTIVE + enrolled: one tenant, one run");
  const bBefore = await writeCounts(B);
  calls0 = providerCalls;
  const ok1 = await call(`businessId=${A}&brain=shadow`, bearer(DERIVE_SECRET));
  check("derivation runs (200, proof level FULL)", ok1.status === 200 && ok1.body.ok === true && ok1.body.proofLevel === "FULL", JSON.stringify(ok1.body).slice(0, 300));
  const run = ok1.body.run as { runId: string; brain: { invoked: boolean } };
  check("the Brain was invoked exactly once (the counting provider saw one call)", run?.brain.invoked === true && providerCalls === calls0 + 1, `calls=${providerCalls - calls0}`);
  const runs = await owner.knowledgeDerivationRun.findMany({ where: { businessId: A } });
  check("exactly one run row: SUCCEEDED, caller class and CI run id recorded, counts and versions only",
    runs.length === 1 && runs[0].status === "SUCCEEDED" && runs[0].callerClass === "derive_workflow" && runs[0].callerRef === "12345" && runs[0].brainInvoked);
  check("tenant A's run wrote nothing for tenant B", (await writeCounts(B)) === bBefore);
  check("… and one SUCCESS security event, attributed to A", Number((await owner.$queryRawUnsafe<{ n: number }[]>(
    `SELECT count(*)::int AS n FROM "SecurityEvent" WHERE "eventType"='KNOWLEDGE_DERIVE' AND outcome='SUCCESS' AND "businessId"=${A}`))[0].n) === 1);

  section("A7 — retry inside the cooldown");
  before = await writeCounts();
  calls0 = providerCalls;
  const retry = await call(`businessId=${A}&brain=shadow`, bearer(DERIVE_SECRET));
  check("a retry inside the cooldown → 429 rate_limited, nothing written, no provider call",
    retry.status === 429 && (await writeCounts()) === before && providerCalls === calls0);

  section("A8 — concurrent runs for the same business");
  calls0 = providerCalls;
  const [c1, c2] = await Promise.all([call(`businessId=${B}`, bearer(DERIVE_SECRET)), call(`businessId=${B}`, bearer(DERIVE_SECRET))]);
  const statuses = [c1.status, c2.status].sort();
  check("exactly one proceeds; the other is refused (409 concurrent or 429)", statuses[0] === 200 && (statuses[1] === 409 || statuses[1] === 429), JSON.stringify(statuses));
  check("… and there is exactly one run row for B", (await owner.knowledgeDerivationRun.count({ where: { businessId: B } })) === 1);

  section("A9 — the Brain's own cooldown");
  process.env.KNOWLEDGE_DERIVE_COOLDOWN_SECONDS = "0";
  calls0 = providerCalls;
  const again = await call(`businessId=${A}&brain=shadow`, bearer(DERIVE_SECRET));
  const againRun = again.body.run as { brain: { invoked: boolean; skipped: string | null } };
  check("past the run cooldown the derivation runs, but the Brain is skipped (cooldown) and the provider is NOT called",
    again.status === 200 && againRun?.brain.invoked === false && againRun.brain.skipped === "cooldown" && providerCalls === calls0);
  process.env.KNOWLEDGE_DERIVE_COOLDOWN_SECONDS = "600";

  section("A10 — the run ledger is append-only; audit shape");
  const r0 = await owner.knowledgeDerivationRun.findFirst({ where: { businessId: A, status: "SUCCEEDED" } });
  check("a finished run cannot be changed, even by the table owner",
    await owner.knowledgeDerivationRun.update({ where: { id: r0!.id }, data: { status: "FAILED" } }).then(() => false, (e) => /KDR_IMMUTABLE/.test(String(e))));
  check("the runtime cannot DELETE a run",
    await rt.$executeRawUnsafe(`DELETE FROM "KnowledgeDerivationRun"`).then(() => false, () => true));
  check("the runtime cannot READ the security store (INSERT-only)",
    await rt.$queryRawUnsafe(`SELECT 1 FROM "SecurityEvent" LIMIT 1`).then(() => false, () => true));
  const evs = await owner.$queryRawUnsafe<{ outcome: string; reasonClass: string | null; businessId: number | null; metadata: unknown }[]>(
    `SELECT outcome, "reasonClass", "businessId", metadata FROM "SecurityEvent" WHERE "eventType"='KNOWLEDGE_DERIVE'`);
  check("every attempt is represented (refusals and runs)", evs.length >= 13, `n=${evs.length}`);
  check("refusals name no tenant row (businessId null); runs name their tenant", evs.filter((e) => e.outcome === "DENIED").every((e) => e.businessId === null) &&
    evs.filter((e) => e.outcome === "SUCCESS").every((e) => e.businessId === A || e.businessId === B));

  section("A11 — privacy");
  const everything = [JSON.stringify(evs), JSON.stringify([noAuth, wrong, cron, notEnrolled, quarantined, ok1, retry, c1, c2, again].map((r) => r.body)), logged.join("\n")].join("\n");
  check("no secret value anywhere (responses, security events, logs)", !everything.includes(DERIVE_SECRET) && !everything.includes(CRON));
  check("no business value anywhere (names, vendors, amounts)", !/Secret Vendor|7777|7778/.test(everything));

  server.close();
  await rt.$disconnect();
  say(`\nDerive authority battery: ${passed} passed, ${failed} failed`);
  if (failed > 0) { say(fails.map((f) => ` - ${f}`).join("\n")); process.exitCode = 1; }
}

main().catch((e) => { process.stdout.write(`battery crashed: ${e instanceof Error ? e.message : String(e)}\n`); process.exitCode = 1; })
  .finally(() => owner.$disconnect());
