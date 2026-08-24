/**
 * D2 / P7 Wave 1 — adversarial tenant-isolation battery + real route-handler proof.
 *
 * One battery, two targets (BATTERY_TARGET):
 *   pg   — ephemeral postgres:17 in CI: full provision (role, policies, grants),
 *          adversarial SQL matrix, real-handler proof, ROLLBACK PROOF, re-apply.
 *   neon — Neon Preview branch DB: drift-capture, apply Wave-1 policies+grants
 *          via owner, adversarial SQL matrix + real-handler proof as the
 *          EXISTING persistent role app_runtime_preview_p4b (never created,
 *          never dropped, never password-rotated here), fixtures residue=0,
 *          pilot substrate (p4b_tenant × 5) verified intact. No rollback run —
 *          rollback SQL is proven in pg mode and shipped as an artifact.
 *
 * Env: DIRECT_URL (owner, direct) · DATABASE_URL (owner, pooled ok) ·
 *      RUNTIME_URL (least-privilege runtime role DSN) · RUNTIME_ROLE ·
 *      AUTH_TOKEN_SECRET · BATTERY_TARGET · STORAGE_PROVIDER=local (+ROOT).
 * Secrets are never printed. Synthetic fixtures only (p7w1-* markers).
 */
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";

const TARGET = process.env.BATTERY_TARGET === "neon" ? "neon" : "pg";
const ROLE = process.env.RUNTIME_ROLE || (TARGET === "neon" ? "app_runtime_preview_p4b" : "wave1_runtime");
const RUNTIME_URL = process.env.RUNTIME_URL;
const MARK = "p7w1-";

const WAVE1_TABLES = [
  "BusinessObligation", "BusinessObligationOrientation", "CrmNote", "CrmAttachment",
  "PricingProfile", "PricingCalculation", "Task", "CollaborationDeal", "Lead",
  "Deal", "BusinessService", "ServiceCostProfile", "PricingRecommendation",
];

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}
async function expectThrow(name, fn, patterns = []) {
  try { await fn(); ok(name, false, "no error thrown"); }
  catch (e) {
    const msg = [e?.message, e?.meta?.message, e?.code, String(e)].filter(Boolean).join(" | ");
    const matched = patterns.length === 0 || patterns.some((p) => msg.includes(p));
    ok(name, matched, matched ? "" : `unexpected error: ${msg.slice(0, 180)}`);
  }
}

function assertEndpointSafety(url, label) {
  for (const bad of ["ep-flat-brook-am4bhq1y", "ep-winter-bread-ami5o8p5"]) {
    if (url.includes(bad)) throw new Error(`DENY: ${label} points at forbidden endpoint`);
  }
  if (TARGET === "neon" && !url.includes("ep-wispy-dawn-amr74bwz")) {
    throw new Error(`DENY: ${label} is not the approved Preview endpoint`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const VERIFY_ONLY = process.env.W1_VERIFY_ONLY === "1";

async function main() {
  if (!process.env.DIRECT_URL) throw new Error("DIRECT_URL missing");
  if (!RUNTIME_URL && !VERIFY_ONLY) throw new Error("RUNTIME_URL missing");
  assertEndpointSafety(process.env.DIRECT_URL, "DIRECT_URL");
  if (RUNTIME_URL) assertEndpointSafety(RUNTIME_URL, "RUNTIME_URL");

  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });
  await owner.$queryRaw`SELECT 1`;
  console.log(`[battery] target=${TARGET} role=${ROLE}`);

  // ---------- Phase 1: pre-state capture + drift gate ----------
  const preOwn = await owner.$queryRawUnsafe(
    `SELECT tablename, policyname FROM pg_policies WHERE tablename = ANY($1)`.replace("$1", `ARRAY[${WAVE1_TABLES.map((t) => `'${t}'`).join(",")}]`)
  );
  const foreign = preOwn.filter((r) => r.policyname !== "p7w1_tenant");
  if (foreign.length > 0) {
    throw new Error(`DRIFT: unexpected policies on Wave-1 tables: ${JSON.stringify(foreign)} — STOP, reconcile first`);
  }
  console.log(`[pre-state] wave1 policies existing=${preOwn.length} (all p7w1_tenant or none) — no drift`);
  if (TARGET === "neon") {
    const pilot = Number((await owner.$queryRawUnsafe(`SELECT count(*)::int AS c FROM pg_policies WHERE policyname='p4b_tenant'`))[0].c);
    if (pilot !== 5) throw new Error(`DRIFT: expected 5 pilot p4b_tenant policies, found ${pilot} — STOP`);
    const posture = (await owner.$queryRawUnsafe(
      `SELECT rolcanlogin, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname='${ROLE}'`
    ))[0];
    if (!posture || posture.rolsuper || posture.rolbypassrls || posture.rolcreaterole || posture.rolcreatedb || !posture.rolcanlogin) {
      throw new Error(`DRIFT: runtime role posture unexpected: ${JSON.stringify(posture)} — STOP`);
    }
    console.log("[pre-state] pilot substrate intact (5 policies), role posture verified NOBYPASSRLS");

    // Schema catch-up: the Preview branch DB predates main's additive
    // account-deletion migration (20260823120000). The current Prisma client
    // writes Business.deletionRequestedAt on create, so ANY current-main
    // runtime against this DB fails P2022 (pre-existing env drift; Wave 1
    // merely exposes it). Apply the canonical migration idempotently.
    const colCount = Number((await owner.$queryRawUnsafe(
      `SELECT count(*)::int AS c FROM information_schema.columns WHERE table_name='Business' AND column_name='deletionRequestedAt'`
    ))[0].c);
    if (colCount === 0 && VERIFY_ONLY) {
      throw new Error("verify-only: schema catch-up pending — run the full apply mode first");
    }
    if (colCount === 0) {
      await owner.$executeRawUnsafe(`ALTER TABLE "Business" ADD COLUMN IF NOT EXISTS "deletionRequestedAt" TIMESTAMP(3)`);
      await owner.$executeRawUnsafe(`ALTER TABLE "Business" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3)`);
      console.log("[catch-up] applied pending canonical migration add_business_deletion_lifecycle (additive, nullable)");
    } else {
      console.log("[catch-up] Business deletion-lifecycle columns already present");
    }
  }

  // READ-ONLY substrate verification (post-merge closure checks): pre-state
  // above already proved drift-free policies, pilot intactness and role
  // posture. Here we only COUNT — no apply, no fixtures, no runtime session.
  if (VERIFY_ONLY) {
    const w1 = Number((await owner.$queryRawUnsafe(`SELECT count(*)::int AS c FROM pg_policies WHERE policyname='p7w1_tenant'`))[0].c);
    ok("verify-only: 13 Wave-1 policies present", w1 === 13, `found ${w1}`);
    const forcedV = Number((await owner.$queryRawUnsafe(
      `SELECT count(*)::int AS c FROM pg_class WHERE relname = ANY(ARRAY[${WAVE1_TABLES.map((t) => `'${t}'`).join(",")}]) AND relrowsecurity AND relforcerowsecurity`
    ))[0].c);
    ok("verify-only: 13 tables ENABLE+FORCE", forcedV === 13, `found ${forcedV}`);
    const resV = await owner.$queryRawUnsafe(
      `SELECT (SELECT count(*)::int FROM "Business" WHERE name LIKE '${MARK}%') AS biz,
              (SELECT count(*)::int FROM "User" WHERE email LIKE '%@p7w1.test') AS usr`
    );
    ok("verify-only: synthetic residue = 0", Number(resV[0].biz) === 0 && Number(resV[0].usr) === 0, JSON.stringify(resV[0]));
    const grantSel = (await owner.$queryRawUnsafe(`SELECT has_table_privilege('${ROLE}', '"BusinessObligation"', 'SELECT') AS a, has_table_privilege('${ROLE}', '"Task"', 'SELECT') AS b`))[0];
    ok("verify-only: grants posture (obligation=yes, Task=no)", grantSel.a === true && grantSel.b === false, JSON.stringify(grantSel));
    await owner.$disconnect();
    console.log(`\n[battery] target=${TARGET} mode=verify-only PASS=${pass} FAIL=${fail}`);
    if (fail > 0) { console.log("FAILURES:\n - " + failures.join("\n - ")); process.exit(1); }
    console.log("ALL CHECKS PASS");
    return;
  }

  // ---------- Phase 2 (pg only): create lab runtime role ----------
  if (TARGET === "pg") {
    const exists = Number((await owner.$queryRawUnsafe(`SELECT count(*)::int AS c FROM pg_roles WHERE rolname='${ROLE}'`))[0].c) > 0;
    if (!exists) {
      await owner.$executeRawUnsafe(
        `CREATE ROLE ${ROLE} LOGIN PASSWORD 'p7w1_ci_synthetic_pw' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION NOINHERIT`
      );
    }
    // Baseline the role already has on Neon (P4-B): auth bootstrap + pilot Customer.
    await owner.$executeRawUnsafe(`GRANT SELECT ON "User", "Business" TO ${ROLE}`);
    await owner.$executeRawUnsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON "Customer" TO ${ROLE}`);
    await owner.$executeRawUnsafe(`GRANT USAGE, SELECT ON SEQUENCE "Customer_id_seq" TO ${ROLE}`);
  }

  // ---------- Phase 3: apply canonical policy migration + grants ----------
  const applySqlFile = async (path, replaceRole = false) => {
    let sql = readFileSync(path, "utf8");
    if (replaceRole) sql = sql.replaceAll(":ROLE", ROLE);
    const statements = sql
      .split(/;\s*\n/)
      .map((s) => s.replace(/^\s*--.*$/gm, "").trim())
      .filter((s) => s.length > 0);
    for (const stmt of statements) await owner.$executeRawUnsafe(stmt);
    return statements.length;
  };
  const nPol = await applySqlFile("prisma/migrations/20260824210000_d2_p7_wave1_tenant_rls/migration.sql");
  const nGrant = await applySqlFile("scripts/security/d2-p7-wave1-grants.sql", true);
  console.log(`[apply] policy statements=${nPol} grant statements=${nGrant}`);

  const polCount = Number((await owner.$queryRawUnsafe(`SELECT count(*)::int AS c FROM pg_policies WHERE policyname='p7w1_tenant'`))[0].c);
  ok("13 p7w1_tenant policies installed", polCount === 13, `found ${polCount}`);
  const forced = Number((await owner.$queryRawUnsafe(
    `SELECT count(*)::int AS c FROM pg_class WHERE relname = ANY(ARRAY[${WAVE1_TABLES.map((t) => `'${t}'`).join(",")}]) AND relrowsecurity AND relforcerowsecurity`
  ))[0].c);
  ok("13 tables ENABLE+FORCE RLS", forced === 13, `found ${forced}`);

  // ---------- Phase 4: fixtures (owner) ----------
  const cleanup = async () => {
    const bids = `SELECT id FROM "Business" WHERE name LIKE '${MARK}%'`;
    for (const t of ["LearningEvent", "CrmAttachment", "CrmNote", "PricingCalculation", "PricingProfile",
      "CollaborationDeal", "BusinessObligation", "BusinessObligationOrientation", "Task", "Deal", "Lead", "Customer", "Supplier"]) {
      await owner.$executeRawUnsafe(`DELETE FROM "${t}" WHERE "businessId" IN (${bids})`);
    }
    await owner.$executeRawUnsafe(`DELETE FROM "ServiceCostProfile" WHERE "businessServiceId" IN (SELECT id FROM "BusinessService" WHERE "businessId" IN (${bids}))`);
    await owner.$executeRawUnsafe(`DELETE FROM "PricingRecommendation" WHERE "businessServiceId" IN (SELECT id FROM "BusinessService" WHERE "businessId" IN (${bids}))`);
    await owner.$executeRawUnsafe(`DELETE FROM "BusinessService" WHERE "businessId" IN (${bids})`);
    await owner.$executeRawUnsafe(`DELETE FROM "User" WHERE email LIKE '%@p7w1.test'`);
    await owner.$executeRawUnsafe(`DELETE FROM "Business" WHERE name LIKE '${MARK}%'`);
  };
  await cleanup(); // clean slate (marker-scoped only)

  const bizA = await owner.business.create({ data: { name: `${MARK}A` } });
  const bizB = await owner.business.create({ data: { name: `${MARK}B` } });
  const userA = await owner.user.create({ data: { email: "a@p7w1.test", password: "x", businessId: bizA.id } });
  const userB = await owner.user.create({ data: { email: "b@p7w1.test", password: "x", businessId: bizB.id } });
  const custA = await owner.customer.create({ data: { businessId: bizA.id, name: `${MARK}cust-A` } });
  const custB = await owner.customer.create({ data: { businessId: bizB.id, name: `${MARK}cust-B` } });
  const svcA = await owner.businessService.create({ data: { businessId: bizA.id, name: `${MARK}svc-A`, type: "SERVICE" } });
  const svcB = await owner.businessService.create({ data: { businessId: bizB.id, name: `${MARK}svc-B`, type: "SERVICE" } });
  const scpA = await owner.serviceCostProfile.create({ data: { businessServiceId: svcA.id, materialCost: 10 } });
  await owner.serviceCostProfile.create({ data: { businessServiceId: svcB.id, materialCost: 20 } });
  await owner.pricingRecommendation.create({ data: { businessServiceId: svcA.id, recommendedPrice: 100 } });
  await owner.pricingRecommendation.create({ data: { businessServiceId: svcB.id, recommendedPrice: 200 } });
  const oblA = await owner.businessObligation.create({ data: { businessId: bizA.id, obligeeName: `${MARK}oblig-A`, amount: "100.00", dueAt: new Date() } });
  const oblB = await owner.businessObligation.create({ data: { businessId: bizB.id, obligeeName: `${MARK}oblig-B`, amount: "200.00", dueAt: new Date() } });
  await owner.businessObligationOrientation.create({ data: { businessId: bizB.id, oriented: true, orientedAt: new Date() } });
  const noteA = await owner.crmNote.create({ data: { businessId: bizA.id, subjectType: "CUSTOMER", subjectId: custA.id, body: `${MARK}note-A`, createdByUserId: userA.id } });
  const noteB = await owner.crmNote.create({ data: { businessId: bizB.id, subjectType: "CUSTOMER", subjectId: custB.id, body: `${MARK}note-B`, createdByUserId: userB.id } });
  const dealA = await owner.collaborationDeal.create({ data: { businessId: bizA.id, title: `${MARK}deal-A`, description: "d", partnerType: "p", actionType: "REFERRAL", estimatedValue: 100 } });
  const dealB = await owner.collaborationDeal.create({ data: { businessId: bizB.id, title: `${MARK}deal-B`, description: "d", partnerType: "p", actionType: "REFERRAL", estimatedValue: 100 } });
  await owner.task.create({ data: { businessId: bizA.id, title: `${MARK}task-A` } });
  await owner.deal.create({ data: { businessId: bizA.id, quotedPrice: 1 } });
  await owner.lead.create({ data: { businessId: bizA.id, customerName: `${MARK}lead-A` } });
  console.log(`[fixtures] A=${bizA.id} B=${bizB.id}`);

  // ---------- Phase 5: runtime clients + adversarial SQL matrix ----------
  const rt1 = new PrismaClient({ datasourceUrl: RUNTIME_URL });
  const rt2 = new PrismaClient({ datasourceUrl: RUNTIME_URL });
  for (let i = 0; i < 6; i++) { try { await rt1.$queryRaw`SELECT 1`; break; } catch (e) { if (i === 5) throw e; await sleep(2000); } }
  const who = (await rt1.$queryRawUnsafe(`SELECT current_user::text AS u`))[0].u;
  ok(`runtime connects as ${ROLE}`, who === ROLE, `current_user=${who}`);

  const rtx = (client, businessId, fn) =>
    client.$transaction(async (t) => {
      if (businessId !== undefined && businessId !== null) {
        await t.$queryRaw`SELECT set_config('app.current_business_id', ${String(businessId)}, true)`;
      }
      return fn(t);
    });

  console.log("--- direct tenancy ---");
  const seenA = await rtx(rt1, bizA.id, (t) => t.businessObligation.findMany({}));
  ok("A broad read = A rows only", seenA.length === 1 && seenA[0].id === oblA.id, `got ${seenA.length}`);
  const crossRead = await rtx(rt1, bizA.id, (t) => t.businessObligation.findFirst({ where: { id: oblB.id } }));
  ok("A cannot read B's obligation", crossRead === null);
  await expectThrow("wrong-tenant INSERT rejected (WITH CHECK)", () =>
    rtx(rt1, bizA.id, (t) => t.businessObligation.create({ data: { businessId: bizB.id, obligeeName: `${MARK}evil`, amount: "1.00", dueAt: new Date() } })),
    ["row-level security", "violates"]);
  const updCross = await rtx(rt1, bizA.id, (t) => t.businessObligation.updateMany({ where: { id: oblB.id }, data: { note: "evil" } }));
  ok("wrong-tenant UPDATE = 0 rows", updCross.count === 0);
  const delCross = await rtx(rt1, bizA.id, (t) => t.crmNote.deleteMany({ where: { id: noteB.id } }));
  ok("wrong-tenant DELETE = 0 rows", delCross.count === 0);
  const bStillThere = await owner.crmNote.findUnique({ where: { id: noteB.id } });
  ok("B's note untouched (owner verify)", bStillThere !== null);

  console.log("--- BusinessObligationOrientation (businessId PK) ---");
  const oriB = await rtx(rt1, bizA.id, (t) => t.businessObligationOrientation.findMany({}));
  ok("A sees no orientation of B", oriB.length === 0);
  const oriUp = await rtx(rt1, bizA.id, (t) => t.businessObligationOrientation.upsert({
    where: { businessId: bizA.id }, create: { businessId: bizA.id, oriented: true, orientedAt: new Date() }, update: { oriented: true } }));
  ok("A upserts own orientation", oriUp.businessId === bizA.id);
  await expectThrow("orientation INSERT for B under GUC=A rejected", () =>
    rtx(rt1, bizA.id, (t) => t.businessObligationOrientation.create({ data: { businessId: bizB.id + 1000, oriented: true } })),
    ["row-level security", "violates"]);

  console.log("--- indirect tenancy (parent-join via BusinessService) ---");
  const scpSeen = await rtx(rt1, bizA.id, (t) => t.serviceCostProfile.findMany({}));
  ok("A sees only children of A's service", scpSeen.length === 1 && scpSeen[0].id === scpA.id, `got ${scpSeen.length}`);
  const recSeen = await rtx(rt1, bizA.id, (t) => t.pricingRecommendation.findMany({}));
  ok("A sees only own PricingRecommendation", recSeen.length === 1);
  await expectThrow("child INSERT under wrong parent rejected", () =>
    rtx(rt1, bizA.id, (t) => t.serviceCostProfile.create({ data: { businessServiceId: svcB.id, materialCost: 666 } })),
    ["row-level security", "violates"]);
  const okChild = await rtx(rt1, bizA.id, (t) => t.pricingRecommendation.create({ data: { businessServiceId: svcA.id, recommendedPrice: 55 } }));
  ok("child INSERT under own parent accepted", okChild.businessServiceId === svcA.id);

  console.log("--- fail-closed ---");
  const noCtx = await rtx(rt1, null, (t) => t.collaborationDeal.findMany({}));
  ok("no context -> 0 rows", noCtx.length === 0);
  const emptyCtx = await rt1.$transaction(async (t) => {
    await t.$queryRaw`SELECT set_config('app.current_business_id', '', true)`;
    return t.collaborationDeal.findMany({});
  });
  ok("empty context -> 0 rows", emptyCtx.length === 0);
  await expectThrow("malformed context -> query errors (fail-closed)", () =>
    rt1.$transaction(async (t) => {
      await t.$queryRaw`SELECT set_config('app.current_business_id', 'not-a-number', true)`;
      return t.collaborationDeal.findMany({});
    }), ["invalid input syntax", "22P02"]);

  console.log("--- raw SQL backstop ---");
  const rawDirect = await rtx(rt1, bizA.id, (t) => t.$queryRawUnsafe(`SELECT count(*)::int AS c FROM "BusinessObligation"`));
  ok("raw direct-table count = tenant-only", Number(rawDirect[0].c) === 1);
  const rawIndirect = await rtx(rt1, bizA.id, (t) => t.$queryRawUnsafe(`SELECT count(*)::int AS c FROM "ServiceCostProfile"`));
  ok("raw indirect-table count = tenant-only", Number(rawIndirect[0].c) === 1);
  const rawNoCtx = await rt1.$queryRawUnsafe(`SELECT count(*)::int AS c FROM "CollaborationDeal"`);
  ok("raw without context -> 0", Number(rawNoCtx[0].c) === 0);

  console.log("--- transaction semantics ---");
  await expectThrow("rollback discards tenant write", () =>
    rtx(rt1, bizA.id, async (t) => {
      await t.businessObligation.create({ data: { businessId: bizA.id, obligeeName: `${MARK}rollback`, amount: "1.00", dueAt: new Date() } });
      throw new Error("forced rollback");
    }), ["forced rollback"]);
  const afterRb = await owner.businessObligation.count({ where: { obligeeName: `${MARK}rollback` } });
  ok("rolled-back row absent (owner verify)", afterRb === 0);
  const committed = await rtx(rt1, bizA.id, (t) => t.businessObligation.create({ data: { businessId: bizA.id, obligeeName: `${MARK}commit`, amount: "1.00", dueAt: new Date() } }));
  const afterCommit = await owner.businessObligation.count({ where: { id: committed.id } });
  ok("committed row present (owner verify)", afterCommit === 1);
  const gucAfter = await rt1.$queryRawUnsafe(`SELECT count(*)::int AS c FROM "BusinessObligation"`);
  ok("GUC did not leak past transaction", Number(gucAfter[0].c) === 0);
  const seqA = await rtx(rt1, bizA.id, (t) => t.collaborationDeal.findMany({}));
  const seqB = await rtx(rt1, bizB.id, (t) => t.collaborationDeal.findMany({}));
  ok("sequential A->B: A saw only A", seqA.length === 1 && seqA[0].id === dealA.id);
  ok("sequential A->B: B saw only B", seqB.length === 1 && seqB[0].id === dealB.id);
  const [concA, concB] = await Promise.all([
    rtx(rt1, bizA.id, async (t) => { await t.$executeRawUnsafe("SELECT pg_sleep(0.05)"); return t.collaborationDeal.findMany({}); }),
    rtx(rt2, bizB.id, async (t) => { await t.$executeRawUnsafe("SELECT pg_sleep(0.02)"); return t.collaborationDeal.findMany({}); }),
  ]);
  ok("concurrent A/B isolated (A)", concA.length === 1 && concA[0].businessId === bizA.id);
  ok("concurrent A/B isolated (B)", concB.length === 1 && concB[0].businessId === bizB.id);

  console.log("--- least privilege ---");
  await expectThrow("DDL denied", () => rt1.$executeRawUnsafe(`CREATE TABLE p7w1_evil (id int)`), ["permission denied"]);
  // On the ephemeral lab the schema comes from `db push`, so the table may not
  // exist at all — absence and permission-denied are both a denial.
  await expectThrow("_prisma_migrations denied", () => rt1.$queryRawUnsafe(`SELECT count(*) FROM _prisma_migrations`), ["permission denied", "does not exist", "42501", "42P01"]);
  await expectThrow("Task ungranted (SELECT denied)", () => rtx(rt1, bizA.id, (t) => t.task.findMany({})), ["permission denied"]);
  await expectThrow("Deal ungranted (SELECT denied)", () => rtx(rt1, bizA.id, (t) => t.deal.findMany({})), ["permission denied"]);
  await expectThrow("Lead ungranted (SELECT denied)", () => rtx(rt1, bizA.id, (t) => t.lead.findMany({})), ["permission denied"]);

  // ---------- Phase 6: REAL route-handler proof (runtime role) ----------
  console.log("--- real route handlers (runtime role, Bearer auth) ---");
  process.env.DATABASE_URL = RUNTIME_URL; // canonical singleton binds to the runtime role
  const { NextRequest } = await import("next/server");
  const { signAuthToken } = await import("@/lib/auth-token");
  const tokA = signAuthToken(userA.id);
  const tokB = signAuthToken(userB.id);
  const H = (tok, extra = {}) => ({ headers: { authorization: `Bearer ${tok}`, "content-type": "application/json", ...extra } });
  const jreq = (url, method, tok, body) =>
    new NextRequest(`http://p7w1.local${url}`, { method, headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const P = (obj) => ({ params: Promise.resolve(obj) });

  // Obligations cluster
  const obligationsRoute = await import("@/app/api/obligations/route");
  const obligationsIdRoute = await import("@/app/api/obligations/[id]/route");
  const obligationsCompleteRoute = await import("@/app/api/obligations/[id]/complete/route");
  let res = await obligationsRoute.POST(jreq("/api/obligations", "POST", tokA, {
    obligeeName: `${MARK}h-oblig`, amount: "77.50", dueAt: new Date().toISOString(), businessId: bizB.id, // malicious hint
  }));
  ok("obligations POST 201", res.status === 201, `status=${res.status}`);
  const createdObl = await res.json();
  // The API serializer does not expose businessId — verify the persisted tenant
  // through the owner connection (authoritative).
  const createdOblRow = await owner.businessObligation.findUnique({ where: { id: createdObl.id } });
  ok("malicious tenant hint ignored (server-derived)", createdOblRow?.businessId === bizA.id, `persisted businessId=${createdOblRow?.businessId}`);
  res = await obligationsRoute.GET(jreq("/api/obligations?includeClosed=1", "GET", tokA));
  const oblList = await res.json();
  const oblIds = oblList.obligations.map((o) => o.id);
  ok("obligations GET: own visible, cross absent", oblIds.includes(createdObl.id) && !oblIds.includes(oblB.id));
  res = await obligationsIdRoute.PATCH(jreq(`/api/obligations/${oblB.id}`, "PATCH", tokA, { note: "evil" }), P({ id: String(oblB.id) }));
  ok("obligations PATCH cross-tenant blocked", res.status >= 400, `status=${res.status}`);
  res = await obligationsCompleteRoute.POST(jreq(`/api/obligations/${createdObl.id}/complete`, "POST", tokA), P({ id: String(createdObl.id) }));
  ok("obligations complete own = 200", res.status === 200, `status=${res.status}`);

  // CRM notes cluster
  const notesRoute = await import("@/app/api/crm/subjects/[subjectType]/[subjectId]/notes/route");
  const noteIdRoute = await import("@/app/api/crm/notes/[noteId]/route");
  res = await notesRoute.POST(jreq(`/api/crm/subjects/CUSTOMER/${custA.id}/notes`, "POST", tokA, { body: `${MARK}h-note` }), P({ subjectType: "CUSTOMER", subjectId: String(custA.id) }));
  ok("crm note POST 201", res.status === 201, `status=${res.status}`);
  const hNote = (await res.json()).note;
  res = await notesRoute.GET(jreq(`/api/crm/subjects/CUSTOMER/${custA.id}/notes`, "GET", tokA), P({ subjectType: "CUSTOMER", subjectId: String(custA.id) }));
  const notesList = (await res.json()).notes;
  ok("crm notes GET own list", res.status === 200 && notesList.some((n) => n.id === hNote.id));
  res = await notesRoute.GET(jreq(`/api/crm/subjects/CUSTOMER/${custA.id}/notes`, "GET", tokB), P({ subjectType: "CUSTOMER", subjectId: String(custA.id) }));
  ok("crm notes: B reading A's subject -> 404", res.status === 404, `status=${res.status}`);
  res = await noteIdRoute.PATCH(jreq(`/api/crm/notes/${noteA.id}`, "PATCH", tokB, { body: "evil" }), P({ noteId: String(noteA.id) }));
  ok("crm note PATCH cross-tenant -> 404", res.status === 404, `status=${res.status}`);
  res = await noteIdRoute.DELETE(jreq(`/api/crm/notes/${hNote.id}`, "DELETE", tokA), P({ noteId: String(hNote.id) }));
  ok("crm note DELETE own = 200", res.status === 200, `status=${res.status}`);

  // CRM attachments cluster (local storage)
  const attachListRoute = await import("@/app/api/crm/subjects/[subjectType]/[subjectId]/attachments/route");
  const attachIdRoute = await import("@/app/api/crm/attachments/[attachmentId]/route");
  const attachFileRoute = await import("@/app/api/crm/attachments/[attachmentId]/file/route");
  const fd = new FormData();
  fd.append("file", new File([Buffer.from("89504e470d0a1a0a", "hex")], "p7w1.png", { type: "image/png" }));
  res = await attachListRoute.POST(new NextRequest(`http://p7w1.local/api/crm/subjects/CUSTOMER/${custA.id}/attachments`, { method: "POST", headers: { authorization: `Bearer ${tokA}` }, body: fd }), P({ subjectType: "CUSTOMER", subjectId: String(custA.id) }));
  ok("crm attachment upload 201", res.status === 201, `status=${res.status} ${res.status !== 201 ? JSON.stringify(await res.json()).slice(0, 120) : ""}`);
  const hAtt = res.status === 201 ? (await res.json()).attachment : null;
  if (hAtt) {
    res = await attachListRoute.GET(jreq(`/api/crm/subjects/CUSTOMER/${custA.id}/attachments`, "GET", tokA), P({ subjectType: "CUSTOMER", subjectId: String(custA.id) }));
    ok("crm attachments GET own list", res.status === 200 && (await res.json()).attachments.some((a) => a.id === hAtt.id));
    res = await attachFileRoute.GET(jreq(`/api/crm/attachments/${hAtt.id}/file`, "GET", tokB), P({ attachmentId: String(hAtt.id) }));
    ok("crm attachment download cross-tenant -> 404", res.status === 404, `status=${res.status}`);
    res = await attachFileRoute.GET(jreq(`/api/crm/attachments/${hAtt.id}/file`, "GET", tokA), P({ attachmentId: String(hAtt.id) }));
    ok("crm attachment download own = 200", res.status === 200, `status=${res.status}`);
    res = await attachIdRoute.DELETE(jreq(`/api/crm/attachments/${hAtt.id}`, "DELETE", tokA), P({ attachmentId: String(hAtt.id) }));
    ok("crm attachment DELETE own = 200", res.status === 200, `status=${res.status}`);
  }

  // Pricing cluster
  const profilesRoute = await import("@/app/api/pricing/profiles/route");
  const profileIdRoute = await import("@/app/api/pricing/profiles/[id]/route");
  const calcRoute = await import("@/app/api/pricing/calculate/route");
  const calcsRoute = await import("@/app/api/pricing/calculations/route");
  res = await profilesRoute.POST(jreq("/api/pricing/profiles", "POST", tokA, { name: `${MARK}h-profile`, type: "SERVICE" }));
  ok("pricing profile POST 201", res.status === 201, `status=${res.status}`);
  const hProf = (await res.json()).profile;
  ok("pricing profile tenant is server-derived", hProf.businessId === bizA.id);
  res = await profileIdRoute.PATCH(jreq(`/api/pricing/profiles/${hProf.id}`, "PATCH", tokB, { name: "evil" }), P({ id: String(hProf.id) }));
  ok("pricing profile PATCH cross-tenant -> 404", res.status === 404, `status=${res.status}`);
  res = await calcRoute.POST(jreq("/api/pricing/calculate", "POST", tokB, { pricingProfileId: hProf.id, materialCost: 5 }));
  ok("pricing calculate with foreign profile -> 404", res.status === 404, `status=${res.status}`);
  res = await calcRoute.POST(jreq("/api/pricing/calculate", "POST", tokA, { pricingProfileId: hProf.id, materialCost: 5, laborMinutes: 30, hourlyRate: 60 }));
  ok("pricing calculate own = 200", res.status === 200, `status=${res.status}`);
  res = await calcsRoute.GET(jreq("/api/pricing/calculations", "GET", tokB));
  const bCalcs = await res.json();
  ok("pricing calculations B sees none of A", bCalcs.calculations.every((c) => c.businessId === bizB.id) && bCalcs.count === 0, `count=${bCalcs.count}`);

  // Deals cluster
  const dealsRoute = await import("@/app/api/deals/route");
  const dealsIdRoute = await import("@/app/api/deals/[id]/route");
  const dealsGenRoute = await import("@/app/api/deals/generate/route");
  res = await dealsGenRoute.POST(jreq("/api/deals/generate", "POST", tokA, { category: "Fitness" }));
  ok("deals generate = 200", res.status === 200, `status=${res.status}`);
  res = await dealsRoute.GET(jreq("/api/deals", "GET", tokA));
  const aDeals = await res.json();
  ok("deals GET own only", res.status === 200 && aDeals.every((d) => d.businessId === bizA.id) && aDeals.length >= 1);
  res = await dealsIdRoute.PATCH(new NextRequest(`http://p7w1.local/api/deals/${dealB.id}`, { method: "PATCH", headers: { authorization: `Bearer ${tokA}`, "content-type": "application/json" }, body: JSON.stringify({ action: "ACCEPT" }) }));
  ok("deals PATCH cross-tenant -> 404", res.status === 404, `status=${res.status}`);
  res = await dealsIdRoute.PATCH(new NextRequest(`http://p7w1.local/api/deals/${dealA.id}`, { method: "PATCH", headers: { authorization: `Bearer ${tokA}`, "content-type": "application/json" }, body: JSON.stringify({ action: "ACCEPT" }) }));
  const patchedDeal = res.status === 200 ? await res.json() : null;
  ok("deals PATCH own = ACCEPTED", res.status === 200 && patchedDeal?.status === "ACCEPTED", `status=${res.status}`);

  // BusinessService children cluster (bot/knowledge bridge count)
  const knowledgeRoute = await import("@/app/api/business/bot/knowledge/route");
  res = await knowledgeRoute.GET(jreq("/api/business/bot/knowledge", "GET", tokA));
  const kA = await res.json();
  ok("bot/knowledge servicesCount = own services only", res.status === 200 && kA.bridges.servicesCount === 1, `count=${kA?.bridges?.servicesCount}`);

  await rt1.$disconnect(); await rt2.$disconnect();

  // ---------- Phase 7 (pg only): rollback proof + re-apply ----------
  if (TARGET === "pg") {
    console.log("--- rollback proof ---");
    await applySqlFile("scripts/security/d2-p7-wave1-rollback.sql", true);
    const polAfterRb = Number((await owner.$queryRawUnsafe(`SELECT count(*)::int AS c FROM pg_policies WHERE policyname='p7w1_tenant'`))[0].c);
    ok("rollback: 0 p7w1 policies remain", polAfterRb === 0, `found ${polAfterRb}`);
    const rlsAfterRb = Number((await owner.$queryRawUnsafe(
      `SELECT count(*)::int AS c FROM pg_class WHERE relname = ANY(ARRAY[${WAVE1_TABLES.map((t) => `'${t}'`).join(",")}]) AND relrowsecurity`
    ))[0].c);
    ok("rollback: RLS disabled on all 13", rlsAfterRb === 0, `still-enabled=${rlsAfterRb}`);
    const canSelect = (await owner.$queryRawUnsafe(`SELECT has_table_privilege('${ROLE}', '"BusinessObligation"', 'SELECT') AS p`))[0].p;
    ok("rollback: grants revoked", canSelect === false);
    await applySqlFile("prisma/migrations/20260824210000_d2_p7_wave1_tenant_rls/migration.sql");
    await applySqlFile("scripts/security/d2-p7-wave1-grants.sql", true);
    const polReapplied = Number((await owner.$queryRawUnsafe(`SELECT count(*)::int AS c FROM pg_policies WHERE policyname='p7w1_tenant'`))[0].c);
    ok("re-apply after rollback (idempotency)", polReapplied === 13, `found ${polReapplied}`);
  }

  // ---------- Phase 8: cleanup + residue ----------
  await cleanup();
  const residue = await owner.$queryRawUnsafe(
    `SELECT (SELECT count(*)::int FROM "Business" WHERE name LIKE '${MARK}%') AS biz,
            (SELECT count(*)::int FROM "User" WHERE email LIKE '%@p7w1.test') AS usr`
  );
  ok("synthetic residue = 0", Number(residue[0].biz) === 0 && Number(residue[0].usr) === 0, JSON.stringify(residue[0]));

  if (TARGET === "neon") {
    const pilotAfter = Number((await owner.$queryRawUnsafe(`SELECT count(*)::int AS c FROM pg_policies WHERE policyname='p4b_tenant'`))[0].c);
    ok("pilot substrate intact after Wave-1", pilotAfter === 5, `found ${pilotAfter}`);
  }

  await owner.$disconnect();
  console.log(`\n[battery] target=${TARGET} PASS=${pass} FAIL=${fail}`);
  if (fail > 0) { console.log("FAILURES:\n - " + failures.join("\n - ")); process.exit(1); }
  console.log("ALL CHECKS PASS");
}

main().catch(async (e) => {
  const { inspect } = await import("node:util");
  console.error("[battery] FATAL:", inspect(e, { depth: 4 }).slice(0, 2000));
  if (e?.stack) console.error(String(e.stack).split("\n").slice(0, 8).join("\n"));
  process.exit(1);
});
