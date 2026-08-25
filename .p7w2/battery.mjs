/**
 * D2 / P7 Wave 2 — adversarial battery: bot-children / content / learning /
 * party / RIA / memory cluster + Wave-2 admin interaction.
 *
 * Targets (BATTERY_TARGET): pg (ephemeral PG17, full provision + ROLLBACK
 * PROOF + re-apply) | neon (Preview branch: drift gates, additive catch-up of
 * the pending BusinessProfile migration (#264), apply, same matrix on the
 * real substrate; persists on PASS).
 *
 * Proves: direct/indirect/depth-2 tenant isolation on the 24 Wave-2 tables,
 * fail-closed GUC, raw-SQL backstop, tx semantics + concurrency, runtime
 * least-privilege (ungranted Party loud-denied, DDL, _prisma_migrations),
 * admin reads ContentRun A+B while denied writes and denied ungranted reads,
 * REAL tenant routes (bot builder, audit, social-post-link) and the REAL
 * migrated platform-admin/overview route on the sanctioned admin client.
 * Synthetic p7w2-* fixtures only; secrets never printed.
 */
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";

const TARGET = process.env.BATTERY_TARGET === "neon" ? "neon" : "pg";
const RT_ROLE = TARGET === "neon" ? "app_runtime_preview_p4b" : "wave1_runtime";
const ADMIN_LOGIN = process.env.ADMIN_LOGIN_ROLE || (TARGET === "neon" ? "app_admin_preview" : "app_admin_lab");
const ADMIN_PW = process.env.W2G_ADMIN_PW || "p7w2g_ci_synthetic_admin_pw";
const RUNTIME_URL = process.env.RUNTIME_URL;
const MARK = "p7w2-";

const DIRECT = [
  "ContentRun", "ContentEvent", "LearningEvent", "LearningSignal", "Usage",
  "FinancialDocument", "Party", "PartyResolutionClaim", "RiaCanonicalReferent",
  "RiaPolicyLineage", "DerivedClaimProjection", "DerivedClaimEvidenceLink",
  "Recommendation", "RecommendationOutcome",
];
const INDIRECT = [
  "BusinessBotProfile", "BotGoalSelection", "BusinessBotSetupDraft",
  "BusinessBotKnowledge", "BusinessBotRecommendation", "BusinessBotMemoryPolicy",
  "BusinessBotLearningSuggestion", "ContentVariant", "ContentRender",
  "DerivedClaimCandidate",
];
const WAVE2 = [...DIRECT, ...INDIRECT];

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; failures.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}
async function expectThrow(name, fn, patterns = []) {
  try { await fn(); ok(name, false, "no error thrown"); }
  catch (e) {
    const msg = [e?.message, e?.meta?.message, e?.code, String(e)].filter(Boolean).join(" | ");
    const matched = patterns.length === 0 || patterns.some((p) => msg.includes(p));
    ok(name, matched, matched ? "" : `unexpected error: ${msg.slice(0, 180)}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function assertEndpointSafety(url, label) {
  for (const bad of ["ep-flat-brook-am4bhq1y", "ep-winter-bread-ami5o8p5"]) {
    if (url.includes(bad)) throw new Error(`DENY: ${label} forbidden endpoint`);
  }
  if (TARGET === "neon" && !url.includes("ep-wispy-dawn-amr74bwz")) {
    throw new Error(`DENY: ${label} is not the approved Preview endpoint`);
  }
}

function splitSql(sql) {
  const out = [];
  let buf = "";
  let inDollar = false;
  for (const line of sql.split("\n")) {
    const stripped = line.replace(/--.*$/, "");
    const dollarCount = (stripped.match(/\$\$/g) || []).length;
    if (dollarCount % 2 === 1) inDollar = !inDollar;
    buf += line + "\n";
    if (!inDollar && /;\s*$/.test(stripped)) {
      const stmt = buf.replace(/^\s*--.*$/gm, "").trim();
      if (stmt) out.push(stmt.replace(/;\s*$/, ""));
      buf = "";
    }
  }
  const tail = buf.replace(/^\s*--.*$/gm, "").trim();
  if (tail) out.push(tail);
  return out;
}

const VERIFY_ONLY = process.env.W2_VERIFY_ONLY === "1";

async function main() {
  if (!process.env.DIRECT_URL) throw new Error("DIRECT_URL missing");
  if (!RUNTIME_URL && !VERIFY_ONLY) throw new Error("RUNTIME_URL missing");
  assertEndpointSafety(process.env.DIRECT_URL, "DIRECT_URL");
  if (RUNTIME_URL) assertEndpointSafety(RUNTIME_URL, "RUNTIME_URL");

  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });
  await owner.$queryRaw`SELECT 1`;
  console.log(`[battery] target=${TARGET} runtime=${RT_ROLE} admin=${ADMIN_LOGIN}`);

  const applySqlFile = async (path, roleReplacements = {}) => {
    let sql = readFileSync(path, "utf8");
    for (const [k, v] of Object.entries(roleReplacements)) sql = sql.replaceAll(k, v);
    const statements = splitSql(sql);
    for (const stmt of statements) await owner.$executeRawUnsafe(stmt);
    return statements.length;
  };

  // ---------- Phase 1: pre-state + drift gates ----------
  const prePol = await owner.$queryRawUnsafe(
    `SELECT tablename, policyname FROM pg_policies WHERE tablename IN (${WAVE2.map((t) => `'${t}'`).join(",")})`
  );
  const foreign = prePol.filter((r) => !["p7w2_tenant", "p7adm_read"].includes(r.policyname));
  if (foreign.length > 0) throw new Error(`DRIFT: unexpected policies on Wave-2 tables: ${JSON.stringify(foreign)} — STOP`);
  if (TARGET === "neon") {
    const pilot = Number((await owner.$queryRawUnsafe(`SELECT count(*)::int AS c FROM pg_policies WHERE policyname='p4b_tenant'`))[0].c);
    if (pilot !== 5) throw new Error(`DRIFT: pilot=${pilot}, expected 5 — STOP`);
    const w1 = Number((await owner.$queryRawUnsafe(`SELECT count(*)::int AS c FROM pg_policies WHERE policyname='p7w1_tenant'`))[0].c);
    if (w1 < 13 || w1 > 14) throw new Error(`DRIFT: wave1=${w1}, expected 13-14 — STOP`);
    const adm2 = Number((await owner.$queryRawUnsafe(`SELECT count(*)::int AS c FROM pg_policies WHERE policyname='p7adm_read' AND tablename IN ('Conversation','BillingDocument')`))[0].c);
    if (adm2 !== 2) throw new Error(`DRIFT: W2-GATE p7adm_read=${adm2}, expected 2 — STOP`);
    const rt0 = (await owner.$queryRawUnsafe(`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname='${RT_ROLE}'`))[0];
    if (!rt0 || rt0.rolsuper || rt0.rolbypassrls) throw new Error("DRIFT: runtime role posture — STOP");

    // Step-1 additive catch-up: pending BusinessProfile Wave-1 migration (#264).
    const bpApplied = w1 === 14;
    if (!bpApplied) {
      await applySqlFile("prisma/migrations/20260825120000_d2_p7_wave1_businessprofile_rls/migration.sql");
      await owner.$executeRawUnsafe(`GRANT SELECT ON "BusinessProfile" TO ${RT_ROLE}`);
      console.log("[catch-up] applied pending Wave-1 BusinessProfile RLS migration + runtime SELECT grant");
    } else {
      console.log("[catch-up] BusinessProfile Wave-1 policy already present");
    }
    console.log(`[pre-state] pilot=5, wave1(before)=${w1}, w2gate-admin=2, runtime posture OK`);
  }

  // READ-ONLY substrate verification (merge-closure checks). Counts only.
  if (VERIFY_ONLY) {
    const w2 = Number((await owner.$queryRawUnsafe(`SELECT count(*)::int AS c FROM pg_policies WHERE policyname='p7w2_tenant'`))[0].c);
    ok("verify-only: 24 Wave-2 policies present", w2 === 24, `found ${w2}`);
    const forcedV = Number((await owner.$queryRawUnsafe(
      `SELECT count(*)::int AS c FROM pg_class WHERE relname IN (${WAVE2.map((t) => `'${t}'`).join(",")}) AND relrowsecurity AND relforcerowsecurity`
    ))[0].c);
    ok("verify-only: 24 tables ENABLE+FORCE", forcedV === 24, `found ${forcedV}`);
    const admV = Number((await owner.$queryRawUnsafe(`SELECT count(*)::int AS c FROM pg_policies WHERE policyname='p7adm_read'`))[0].c);
    ok("verify-only: 3 admin read policies (2 gate + ContentRun)", admV === 3, `found ${admV}`);
    const resV = await owner.$queryRawUnsafe(
      `SELECT (SELECT count(*)::int FROM "Business" WHERE name LIKE '${MARK}%') AS biz,
              (SELECT count(*)::int FROM "User" WHERE email LIKE '%@p7w2.test') AS usr`
    );
    ok("verify-only: synthetic residue = 0", Number(resV[0].biz) === 0 && Number(resV[0].usr) === 0, JSON.stringify(resV[0]));
    const g = (await owner.$queryRawUnsafe(`SELECT has_table_privilege('${RT_ROLE}', '"ContentRun"', 'SELECT') AS a, has_table_privilege('${RT_ROLE}', '"Party"', 'SELECT') AS b, has_table_privilege('app_admin', '"ContentRun"', 'SELECT') AS c`))[0];
    ok("verify-only: grant posture (runtime ContentRun=yes, Party=no, admin ContentRun=yes)", g.a === true && g.b === false && g.c === true, JSON.stringify(g));
    await owner.$disconnect();
    console.log(`\n[battery] target=${TARGET} mode=verify-only PASS=${pass} FAIL=${fail}`);
    if (fail > 0) { console.log("FAILURES:\n - " + failures.join("\n - ")); process.exit(1); }
    console.log("ALL CHECKS PASS");
    return;
  }

  // ---------- Phase 2 (pg only): lab substrate ----------
  if (TARGET === "pg") {
    const rtExists = Number((await owner.$queryRawUnsafe(`SELECT count(*)::int AS c FROM pg_roles WHERE rolname='${RT_ROLE}'`))[0].c) > 0;
    if (!rtExists) {
      await owner.$executeRawUnsafe(`CREATE ROLE ${RT_ROLE} LOGIN PASSWORD 'p7w1_ci_synthetic_pw' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION NOINHERIT`);
    }
    await owner.$executeRawUnsafe(`GRANT SELECT ON "User", "Business" TO ${RT_ROLE}`);
    // Admin group + login (W2-GATE canonical migration + starter grants).
    const admExists = Number((await owner.$queryRawUnsafe(`SELECT count(*)::int AS c FROM pg_roles WHERE rolname='${ADMIN_LOGIN}'`))[0].c) > 0;
    if (!admExists) {
      await owner.$executeRawUnsafe(`CREATE ROLE ${ADMIN_LOGIN} LOGIN PASSWORD '${ADMIN_PW}' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION INHERIT`);
    }
    await applySqlFile("prisma/migrations/20260825090000_d2_p7_w2gate_admin_read/migration.sql");
    await applySqlFile("scripts/security/d2-p7-w2gate-admin-grants.sql", { ":LOGIN_ROLE": ADMIN_LOGIN });
    // Wave-1 runtime baseline (the real Preview already carries it — e.g. the
    // LearningEvent S,I grant that Wave-2 routes rely on).
    await applySqlFile("scripts/security/d2-p7-wave1-grants.sql", { ":ROLE": RT_ROLE });
    // Conversation tenant policy (pilot-equivalent) so overview's Conversation
    // reads behave like Preview.
    for (const t of ["Conversation"]) {
      await owner.$executeRawUnsafe(`ALTER TABLE "${t}" ENABLE ROW LEVEL SECURITY`);
      await owner.$executeRawUnsafe(`ALTER TABLE "${t}" FORCE ROW LEVEL SECURITY`);
      await owner.$executeRawUnsafe(`DROP POLICY IF EXISTS p4b_tenant ON "${t}"`);
      await owner.$executeRawUnsafe(
        `CREATE POLICY p4b_tenant ON "${t}" USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int) WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)`
      );
    }
  }

  // ---------- Phase 3: apply Wave-2 migration + grants ----------
  const nMig = await applySqlFile("prisma/migrations/20260825150000_d2_p7_wave2_tenant_rls/migration.sql");
  const nGr = await applySqlFile("scripts/security/d2-p7-wave2-grants.sql", { ":ROLE": RT_ROLE });
  console.log(`[apply] wave2 migration statements=${nMig} grant statements=${nGr}`);

  const w2pol = Number((await owner.$queryRawUnsafe(`SELECT count(*)::int AS c FROM pg_policies WHERE policyname='p7w2_tenant'`))[0].c);
  ok("24 p7w2_tenant policies installed", w2pol === 24, `found ${w2pol}`);
  const forced = Number((await owner.$queryRawUnsafe(
    `SELECT count(*)::int AS c FROM pg_class WHERE relname IN (${WAVE2.map((t) => `'${t}'`).join(",")}) AND relrowsecurity AND relforcerowsecurity`
  ))[0].c);
  ok("24 tables ENABLE+FORCE RLS", forced === 24, `found ${forced}`);
  const admCr = Number((await owner.$queryRawUnsafe(`SELECT count(*)::int AS c FROM pg_policies WHERE policyname='p7adm_read' AND tablename='ContentRun'`))[0].c);
  ok("additive p7adm_read on ContentRun", admCr === 1);

  // ---------- Phase 4: fixtures ----------
  const cleanup = async () => {
    const bids = `SELECT id FROM "Business" WHERE name LIKE '${MARK}%'`;
    await owner.$executeRawUnsafe(`DELETE FROM "PlatformAuditEvent" WHERE "actorUserId" IN (SELECT id FROM "User" WHERE email LIKE '%@p7w2.test')`);
    await owner.$executeRawUnsafe(`DELETE FROM "ContentRender" WHERE "contentVariantId" IN (SELECT id FROM "ContentVariant" WHERE "contentRunId" IN (SELECT id FROM "ContentRun" WHERE "businessId" IN (${bids})))`);
    await owner.$executeRawUnsafe(`DELETE FROM "ContentVariant" WHERE "contentRunId" IN (SELECT id FROM "ContentRun" WHERE "businessId" IN (${bids}))`);
    for (const t of ["ContentEvent", "ContentRun", "LearningEvent", "LearningSignal", "Usage", "Party", "Recommendation", "Conversation"]) {
      await owner.$executeRawUnsafe(`DELETE FROM "${t}" WHERE "businessId" IN (${bids})`);
    }
    await owner.$executeRawUnsafe(`DELETE FROM "BotGoalSelection" WHERE "botId" IN (SELECT id FROM "BusinessBot" WHERE "businessId" IN (${bids}))`);
    await owner.$executeRawUnsafe(`DELETE FROM "BusinessBotLearningSuggestion" WHERE "botId" IN (SELECT id FROM "BusinessBot" WHERE "businessId" IN (${bids}))`);
    await owner.$executeRawUnsafe(`DELETE FROM "BusinessBotRecommendation" WHERE "botId" IN (SELECT id FROM "BusinessBot" WHERE "businessId" IN (${bids}))`);
    await owner.$executeRawUnsafe(`DELETE FROM "BusinessBotMemoryPolicy" WHERE "botId" IN (SELECT id FROM "BusinessBot" WHERE "businessId" IN (${bids}))`);
    await owner.$executeRawUnsafe(`DELETE FROM "BusinessBotSetupDraft" WHERE "botId" IN (SELECT id FROM "BusinessBot" WHERE "businessId" IN (${bids}))`);
    await owner.$executeRawUnsafe(`DELETE FROM "BusinessBotProfile" WHERE "botId" IN (SELECT id FROM "BusinessBot" WHERE "businessId" IN (${bids}))`);
    await owner.$executeRawUnsafe(`DELETE FROM "BusinessBot" WHERE "businessId" IN (${bids})`);
    await owner.$executeRawUnsafe(`DELETE FROM "User" WHERE email LIKE '%@p7w2.test'`);
    await owner.$executeRawUnsafe(`DELETE FROM "Business" WHERE name LIKE '${MARK}%'`);
  };
  await cleanup();

  const bizA = await owner.business.create({ data: { name: `${MARK}A` } });
  const bizB = await owner.business.create({ data: { name: `${MARK}B` } });
  const userA = await owner.user.create({ data: { email: "a@p7w2.test", password: "x", businessId: bizA.id } });
  const userB = await owner.user.create({ data: { email: "b@p7w2.test", password: "x", businessId: bizB.id } });
  const adminUser = await owner.user.create({ data: { email: "admin@p7w2.test", password: "x", businessId: bizA.id, role: "PLATFORM_ADMIN" } });
  const botA = await owner.businessBot.create({ data: { businessId: bizA.id } });
  const botB = await owner.businessBot.create({ data: { businessId: bizB.id } });
  await owner.botGoalSelection.create({ data: { botId: botA.id, goalKey: `${MARK}goal-A`, goalVersion: 1 } });
  await owner.botGoalSelection.create({ data: { botId: botB.id, goalKey: `${MARK}goal-B`, goalVersion: 1 } });
  const sugA = await owner.businessBotLearningSuggestion.create({ data: { botId: botA.id, type: `${MARK}t`, title: "A" } });
  const sugB = await owner.businessBotLearningSuggestion.create({ data: { botId: botB.id, type: `${MARK}t`, title: "B" } });
  const recA = await owner.businessBotRecommendation.create({ data: { botId: botA.id, type: `${MARK}r`, reason: "A" } });
  const recB = await owner.businessBotRecommendation.create({ data: { botId: botB.id, type: `${MARK}r`, reason: "B" } });
  const runA = await owner.contentRun.create({ data: { businessId: bizA.id, status: "FAILED", inputSnapshot: {} } });
  const runB = await owner.contentRun.create({ data: { businessId: bizB.id, status: "FAILED", inputSnapshot: {} } });
  const varA = await owner.contentVariant.create({ data: { contentRunId: runA.id, variantKey: "v1", creativeDna: {}, creativeBlueprint: {}, renderBlueprint: {}, creativeScore: {}, growthSemantics: {} } });
  const varB = await owner.contentVariant.create({ data: { contentRunId: runB.id, variantKey: "v1", creativeDna: {}, creativeBlueprint: {}, renderBlueprint: {}, creativeScore: {}, growthSemantics: {} } });
  await owner.contentRender.create({ data: { contentVariantId: varA.id, provider: "CREATOMATE" } });
  await owner.contentRender.create({ data: { contentVariantId: varB.id, provider: "CREATOMATE" } });
  const levA = await owner.learningEvent.create({ data: { businessId: bizA.id, eventType: `${MARK}ev`, entityType: "T" } });
  const levB = await owner.learningEvent.create({ data: { businessId: bizB.id, eventType: `${MARK}ev`, entityType: "T" } });
  const usgB = await owner.usage.create({ data: { businessId: bizB.id, type: "video_generation", count: 5, weekKey: `${MARK}wk` } });
  await owner.party.create({ data: { businessId: bizA.id } });
  await owner.conversation.create({ data: { businessId: bizA.id, channel: "WHATSAPP" } });
  await owner.conversation.create({ data: { businessId: bizB.id, channel: "WHATSAPP" } });
  console.log(`[fixtures] A=${bizA.id} B=${bizB.id}`);

  // ---------- Phase 5: connections ----------
  const adminUrlObj = new URL(RUNTIME_URL);
  adminUrlObj.username = ADMIN_LOGIN;
  adminUrlObj.password = ADMIN_PW;
  const ADMIN_URL = adminUrlObj.toString();

  const rt = new PrismaClient({ datasourceUrl: RUNTIME_URL });
  const rt2 = new PrismaClient({ datasourceUrl: RUNTIME_URL });
  for (let i = 0; i < 6; i++) { try { await rt.$queryRaw`SELECT 1`; break; } catch (e) { if (i === 5) throw e; await sleep(2000); } }
  const adm = new PrismaClient({ datasourceUrl: ADMIN_URL });
  for (let i = 0; i < 6; i++) { try { await adm.$queryRaw`SELECT 1`; break; } catch (e) { if (i === 5) throw e; await sleep(2000); } }
  const rtWho = (await rt.$queryRawUnsafe(`SELECT current_user::text AS u`))[0].u;
  ok(`tenant runtime current_user = ${RT_ROLE}`, rtWho === RT_ROLE, `got ${rtWho}`);
  const admWho = (await adm.$queryRawUnsafe(`SELECT current_user::text AS u`))[0].u;
  ok(`admin current_user = ${ADMIN_LOGIN}`, admWho === ADMIN_LOGIN, `got ${admWho}`);

  const rtx = (client, businessId, fn) =>
    client.$transaction(async (t) => {
      if (businessId != null) {
        await t.$queryRaw`SELECT set_config('app.current_business_id', ${String(businessId)}, true)`;
      }
      return fn(t);
    });
  const inIds = { in: [bizA.id, bizB.id] };

  // ---------- Phase 6: direct ----------
  console.log("--- direct tenancy ---");
  const dLev = await rtx(rt, bizA.id, (t) => t.learningEvent.findMany({ where: { businessId: inIds } }));
  ok("A sees only A LearningEvents", dLev.length === 1 && dLev[0].id === levA.id, `got ${dLev.length}`);
  const dRun = await rtx(rt, bizA.id, (t) => t.contentRun.findMany({ where: { businessId: inIds }, select: { id: true, businessId: true } }));
  ok("broad ContentRun read = A only", dRun.length === 1 && dRun[0].businessId === bizA.id);
  await expectThrow("wrong-tenant LearningEvent INSERT rejected", () =>
    rtx(rt, bizA.id, (t) => t.learningEvent.create({ data: { businessId: bizB.id, eventType: `${MARK}evil`, entityType: "T" } })),
    ["row-level security", "violates"]);
  const updX = await rtx(rt, bizA.id, (t) => t.usage.updateMany({ where: { id: usgB.id }, data: { count: 999 } }));
  ok("wrong-tenant Usage UPDATE = 0 rows", updX.count === 0);
  const usgBAfter = await owner.usage.findUnique({ where: { id: usgB.id } });
  ok("B's Usage untouched (owner verify)", usgBAfter?.count === 5);

  // ---------- Phase 7: indirect + depth-2 ----------
  console.log("--- indirect (parent-join) ---");
  const gSel = await rtx(rt, bizA.id, (t) => t.botGoalSelection.findMany({ where: { goalKey: { startsWith: MARK } } }));
  ok("A sees only own bot's goal selections", gSel.length === 1 && gSel[0].botId === botA.id, `got ${gSel.length}`);
  await expectThrow("wrong-parent BotGoalSelection INSERT rejected", () =>
    rtx(rt, bizA.id, (t) => t.botGoalSelection.create({ data: { botId: botB.id, goalKey: `${MARK}evil`, goalVersion: 1 } })),
    ["row-level security", "violates"]);
  console.log("--- depth-2 (ContentRender -> ContentVariant -> ContentRun) ---");
  const dr = await rtx(rt, bizA.id, (t) => t.$queryRawUnsafe(`SELECT count(*)::int AS c FROM "ContentRender"`));
  ok("depth-2: A sees only own render chain", Number(dr[0].c) === 1, `got ${dr[0].c}`);
  const drB = await rtx(rt, bizB.id, (t) => t.$queryRawUnsafe(`SELECT count(*)::int AS c FROM "ContentRender"`));
  ok("depth-2: B sees only own render chain", Number(drB[0].c) === 1);
  await expectThrow("depth-2 wrong-chain INSERT rejected", () =>
    rtx(rt, bizA.id, (t) => t.$executeRawUnsafe(`INSERT INTO "ContentRender" ("contentVariantId","provider","updatedAt") VALUES (${varB.id},'CREATOMATE',now())`)),
    ["row-level security", "violates"]);

  // ---------- Phase 8: fail-closed + raw ----------
  console.log("--- fail-closed + raw SQL ---");
  const noCtx = await rt.contentRun.findMany({ where: { businessId: inIds }, select: { id: true } });
  ok("no context -> 0 rows", noCtx.length === 0);
  const emptyCtx = await rt.$transaction(async (t) => {
    await t.$queryRaw`SELECT set_config('app.current_business_id', '', true)`;
    return t.learningEvent.findMany({ where: { businessId: inIds } });
  });
  ok("empty context -> 0 rows", emptyCtx.length === 0);
  await expectThrow("malformed context errors (fail-closed)", () =>
    rt.$transaction(async (t) => {
      await t.$queryRaw`SELECT set_config('app.current_business_id', 'evil', true)`;
      return t.learningEvent.findMany({});
    }), ["invalid input syntax", "22P02"]);
  const rawD = await rtx(rt, bizA.id, (t) => t.$queryRawUnsafe(`SELECT count(*)::int AS c FROM "LearningEvent" WHERE "businessId" IN (${bizA.id},${bizB.id})`));
  ok("raw direct = tenant-only", Number(rawD[0].c) === 1);
  const rawI = await rtx(rt, bizA.id, (t) => t.$queryRawUnsafe(`SELECT count(*)::int AS c FROM "BotGoalSelection" WHERE "goalKey" LIKE '${MARK}%'`));
  ok("raw indirect = tenant-only", Number(rawI[0].c) === 1);

  // ---------- Phase 9: tx semantics + concurrency ----------
  console.log("--- transactions + concurrency ---");
  await expectThrow("rollback discards tenant write", () =>
    rtx(rt, bizA.id, async (t) => {
      await t.learningEvent.create({ data: { businessId: bizA.id, eventType: `${MARK}rb`, entityType: "T" } });
      throw new Error("forced rollback");
    }), ["forced rollback"]);
  ok("rolled-back row absent", (await owner.learningEvent.count({ where: { eventType: `${MARK}rb` } })) === 0);
  const committed = await rtx(rt, bizA.id, (t) => t.learningEvent.create({ data: { businessId: bizA.id, eventType: `${MARK}commit`, entityType: "T" } }));
  ok("committed row present", (await owner.learningEvent.count({ where: { id: committed.id } })) === 1);
  const leak = await rt.$queryRawUnsafe(`SELECT count(*)::int AS c FROM "LearningEvent" WHERE "businessId" IN (${bizA.id},${bizB.id})`);
  ok("GUC did not leak past tx", Number(leak[0].c) === 0);
  const sA = await rtx(rt, bizA.id, (t) => t.contentRun.findMany({ where: { businessId: inIds }, select: { businessId: true } }));
  const sB = await rtx(rt, bizB.id, (t) => t.contentRun.findMany({ where: { businessId: inIds }, select: { businessId: true } }));
  ok("sequential A->B no bleed", sA.every((r) => r.businessId === bizA.id) && sB.every((r) => r.businessId === bizB.id) && sA.length === 1 && sB.length === 1);
  const [cA, cB] = await Promise.all([
    rtx(rt, bizA.id, async (t) => { await t.$executeRawUnsafe("SELECT pg_sleep(0.05)"); return t.learningEvent.findMany({ where: { businessId: inIds } }); }),
    rtx(rt2, bizB.id, async (t) => { await t.$executeRawUnsafe("SELECT pg_sleep(0.02)"); return t.learningEvent.findMany({ where: { businessId: inIds } }); }),
  ]);
  ok("concurrent A isolated", cA.every((r) => r.businessId === bizA.id) && cA.length === 2);
  ok("concurrent B isolated", cB.every((r) => r.businessId === bizB.id) && cB.length === 1);

  // ---------- Phase 10: runtime least-privilege ----------
  console.log("--- runtime least-privilege ---");
  await expectThrow("ungranted Wave-2 table (Party) denied loudly", () =>
    rtx(rt, bizA.id, (t) => t.party.findMany({})), ["permission denied", "42501"]);
  await expectThrow("runtime DDL denied", () => rt.$executeRawUnsafe(`CREATE TABLE p7w2_evil (id int)`), ["permission denied", "42501"]);
  await expectThrow("runtime _prisma_migrations denied", () => rt.$queryRawUnsafe(`SELECT count(*) FROM _prisma_migrations`), ["permission denied", "does not exist", "42501", "42P01"]);

  // ---------- Phase 11: admin interaction ----------
  console.log("--- admin interaction ---");
  const aRuns = await adm.contentRun.findMany({ where: { businessId: inIds }, select: { id: true, businessId: true } });
  ok("admin reads ContentRun A+B", aRuns.length === 2, `got ${aRuns.length}`);
  await expectThrow("admin ContentRun UPDATE denied", () =>
    adm.contentRun.updateMany({ where: { businessId: bizA.id }, data: { status: "COMPLETED" } }), ["permission denied", "42501"]);
  await expectThrow("admin read of ungranted W2 tenant table (LearningEvent) denied loudly", () =>
    adm.learningEvent.findMany({}), ["permission denied", "42501"]);
  const [ctA, ctAdm] = await Promise.all([
    rtx(rt, bizA.id, (t) => t.contentRun.findMany({ where: { businessId: inIds }, select: { businessId: true } })),
    adm.contentRun.findMany({ where: { businessId: inIds }, select: { id: true } }),
  ]);
  ok("concurrent tenant/admin: tenant A-only", ctA.length === 1 && ctA[0].businessId === bizA.id);
  ok("concurrent tenant/admin: admin A+B", ctAdm.length === 2);

  // ---------- Phase 12: REAL tenant routes ----------
  console.log("--- real tenant routes ---");
  process.env.DATABASE_URL = RUNTIME_URL;
  process.env.ADMIN_DATABASE_URL = ADMIN_URL;
  globalThis.prismaAdmin = undefined;
  const { NextRequest } = await import("next/server");
  const { signAuthToken } = await import("@/lib/auth-token");
  const tokA = signAuthToken(userA.id);
  const tokB = signAuthToken(userB.id);
  const jreq = (url, method, tok, body) =>
    new NextRequest(`http://p7w2.local${url}`, { method, headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const P = (obj) => ({ params: Promise.resolve(obj) });

  const goalsRoute = await import("@/app/api/business/bot/goals/route");
  let res = await goalsRoute.GET(jreq("/api/business/bot/goals", "GET", tokA));
  let body = await res.json();
  ok("bot goals GET: own selection only", res.status === 200 && body.selected.length === 1 && body.selected[0].goalKey === `${MARK}goal-A`, `status=${res.status} got=${body?.selected?.length}`);

  const memRoute = await import("@/app/api/business/bot/memory-policy/route");
  res = await memRoute.PUT(jreq("/api/business/bot/memory-policy", "PUT", tokA, { preferences: true }));
  ok("memory-policy PUT own = 200", res.status === 200, `status=${res.status}`);
  const polRowA = await owner.businessBotMemoryPolicy.findUnique({ where: { botId: botA.id } });
  ok("memory-policy persisted under A's bot (server-derived tenant)", polRowA?.preferences === true);
  const polRowB = await owner.businessBotMemoryPolicy.findUnique({ where: { botId: botB.id } });
  ok("B's bot memory-policy untouched", polRowB === null);

  const setupRoute = await import("@/app/api/business/bot/setup/route");
  res = await setupRoute.PATCH(jreq("/api/business/bot/setup", "PATCH", tokA, { currentStep: 2 }));
  ok("setup PATCH own = 200", res.status === 200, `status=${res.status}`);

  const sugsRoute = await import("@/app/api/business/bot/learning-suggestions/route");
  res = await sugsRoute.GET(jreq("/api/business/bot/learning-suggestions", "GET", tokA));
  body = await res.json();
  ok("learning-suggestions GET: own only", res.status === 200 && body.count === 1 && body.suggestions[0].id === sugA.id, `count=${body?.count}`);
  const adoptRoute = await import("@/app/api/business/bot/learning-suggestions/[id]/adopt/route");
  res = await adoptRoute.POST(jreq(`/api/business/bot/learning-suggestions/${sugB.id}/adopt`, "POST", tokA), P({ id: String(sugB.id) }));
  ok("adopt cross-tenant suggestion -> 404", res.status === 404, `status=${res.status}`);

  const recsRoute = await import("@/app/api/business/bot/recommendations/route");
  res = await recsRoute.GET(jreq("/api/business/bot/recommendations", "GET", tokB));
  body = await res.json();
  ok("recommendations GET (B): own only", res.status === 200 && body.count === 1 && body.recommendations[0].id === recB.id, `count=${body?.count}`);
  const recDismissRoute = await import("@/app/api/business/bot/recommendations/[id]/dismiss/route");
  res = await recDismissRoute.POST(jreq(`/api/business/bot/recommendations/${recA.id}/dismiss`, "POST", tokB), P({ id: String(recA.id) }));
  ok("dismiss cross-tenant recommendation -> 404", res.status === 404, `status=${res.status}`);

  const auditRoute = await import("@/app/api/audit/route");
  res = await auditRoute.GET(jreq("/api/audit?limit=50", "GET", tokA));
  body = await res.json();
  ok("audit GET: tenant LearningEvents only", res.status === 200 && body.events.every((e) => e.businessId === bizA.id) && body.events.length >= 2, `count=${body?.events?.length}`);

  const splRoute = await import("@/app/api/content/social-post-link/route");
  res = await splRoute.POST(jreq("/api/content/social-post-link", "POST", tokA, {
    renderId: "r1", renderedVideoUrl: "https://x.test/v.mp4", selectedVariantId: "v1", platform: "instagram", postUrl: "https://x.test/p",
  }));
  ok("social-post-link POST = 200", res.status === 200, `status=${res.status}`);
  const linked = await owner.learningEvent.findFirst({ where: { eventType: "CONTENT_POST_LINKED", businessId: bizA.id } });
  ok("social-post-link persisted under server-derived tenant", linked !== null);

  // ---------- Phase 13: REAL admin route (migrated overview) ----------
  console.log("--- real admin route: platform-admin/overview ---");
  const { getPrismaAdmin } = await import("@/lib/prisma-admin");
  const sWho = (await getPrismaAdmin().$queryRawUnsafe(`SELECT current_user::text AS u`))[0].u;
  ok(`sanctioned admin client current_user = ${ADMIN_LOGIN}`, sWho === ADMIN_LOGIN);
  const overviewRoute = await import("@/app/api/platform-admin/overview/route");
  const callOverview = (tok) => overviewRoute.GET(new NextRequest("http://p7w2.local/api/platform-admin/overview", { headers: tok ? { authorization: `Bearer ${tok}` } : {} }));
  process.env.PLATFORM_ADMIN_EMAILS = "admin@p7w2.test";
  res = await callOverview(signAuthToken(adminUser.id));
  body = res.status === 200 ? await res.json() : null;
  ok("overview: allowlisted admin -> 200", res.status === 200, `status=${res.status}`);
  ok("overview: businesses count includes both tenants (no silent zero)", (body?.totals?.businesses ?? 0) >= 2, `businesses=${body?.totals?.businesses}`);
  ok("overview: failed ContentRuns across tenants >= 2", (body?.content?.runsFailed ?? 0) >= 2, `runsFailed=${body?.content?.runsFailed}`);
  ok("overview: conversations across tenants >= 2", (body?.conversations?.total ?? 0) >= 2, `total=${body?.conversations?.total}`);
  res = await callOverview(signAuthToken(userA.id));
  ok("overview: ordinary user -> 403", res.status === 403, `status=${res.status}`);
  process.env.PLATFORM_ADMIN_EMAILS = "";
  res = await callOverview(signAuthToken(adminUser.id));
  ok("overview: empty allowlist -> 403 (fail closed)", res.status === 403, `status=${res.status}`);
  process.env.PLATFORM_ADMIN_EMAILS = "admin@p7w2.test";

  await rt.$disconnect(); await rt2.$disconnect(); await adm.$disconnect();

  // ---------- Phase 14 (pg only): rollback proof + re-apply ----------
  if (TARGET === "pg") {
    console.log("--- rollback proof ---");
    await applySqlFile("scripts/security/d2-p7-wave2-rollback.sql", { ":ROLE": RT_ROLE });
    const polAfter = Number((await owner.$queryRawUnsafe(`SELECT count(*)::int AS c FROM pg_policies WHERE policyname='p7w2_tenant'`))[0].c);
    ok("rollback: 0 p7w2 policies remain", polAfter === 0, `found ${polAfter}`);
    const admAfter = Number((await owner.$queryRawUnsafe(`SELECT count(*)::int AS c FROM pg_policies WHERE policyname='p7adm_read' AND tablename='ContentRun'`))[0].c);
    ok("rollback: Wave-2 admin policy removed", admAfter === 0);
    const w2gAfter = Number((await owner.$queryRawUnsafe(`SELECT count(*)::int AS c FROM pg_policies WHERE policyname='p7adm_read'`))[0].c);
    ok("rollback: W2-GATE admin policies intact", w2gAfter === 2, `found ${w2gAfter}`);
    const canSel = (await owner.$queryRawUnsafe(`SELECT has_table_privilege('${RT_ROLE}', '"ContentRun"', 'SELECT') AS p`))[0].p;
    ok("rollback: runtime grants revoked", canSel === false);
    await applySqlFile("prisma/migrations/20260825150000_d2_p7_wave2_tenant_rls/migration.sql");
    await applySqlFile("scripts/security/d2-p7-wave2-grants.sql", { ":ROLE": RT_ROLE });
    const polRe = Number((await owner.$queryRawUnsafe(`SELECT count(*)::int AS c FROM pg_policies WHERE policyname='p7w2_tenant'`))[0].c);
    ok("re-apply after rollback (idempotency)", polRe === 24, `found ${polRe}`);
  }

  // ---------- Phase 15: cleanup + integrity ----------
  await cleanup();
  const residue = await owner.$queryRawUnsafe(
    `SELECT (SELECT count(*)::int FROM "Business" WHERE name LIKE '${MARK}%') AS biz,
            (SELECT count(*)::int FROM "User" WHERE email LIKE '%@p7w2.test') AS usr`
  );
  ok("synthetic residue = 0", Number(residue[0].biz) === 0 && Number(residue[0].usr) === 0, JSON.stringify(residue[0]));
  if (TARGET === "neon") {
    const pilotA = Number((await owner.$queryRawUnsafe(`SELECT count(*)::int AS c FROM pg_policies WHERE policyname='p4b_tenant'`))[0].c);
    const w1A = Number((await owner.$queryRawUnsafe(`SELECT count(*)::int AS c FROM pg_policies WHERE policyname='p7w1_tenant'`))[0].c);
    const admA = Number((await owner.$queryRawUnsafe(`SELECT count(*)::int AS c FROM pg_policies WHERE policyname='p7adm_read'`))[0].c);
    ok("pilot(5) + wave1(14) + admin(3) substrate after Wave 2", pilotA === 5 && w1A === 14 && admA === 3, `pilot=${pilotA} w1=${w1A} adm=${admA}`);
  }

  await owner.$disconnect();
  console.log(`\n[battery] target=${TARGET} PASS=${pass} FAIL=${fail}`);
  if (fail > 0) { console.log("FAILURES:\n - " + failures.join("\n - ")); process.exit(1); }
  console.log("ALL CHECKS PASS");
}

main().catch(async (e) => {
  const { inspect } = await import("node:util");
  console.error("[battery] FATAL:", inspect(e, { depth: 4 }).slice(0, 2000));
  process.exit(1);
});
