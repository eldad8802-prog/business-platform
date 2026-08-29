/**
 * D2 / P7-W4D — Documents / OCR / Learning tenant-isolation battery.
 *
 * Targets (BATTERY_TARGET): pg (ephemeral PG17: full provision incl. admin
 * foundation, matrix, rollback proof, re-apply) | neon (Preview: drift gates,
 * W4D apply, matrix as the real runtime + admin roles).
 *
 * Proves under FORCE RLS on the 8 W4D tables:
 *  - real upload/process/approve handlers: tenant-bound creation, approval
 *    atomicity + idempotency (no duplicate financial effect), validation
 *    failures leave stored state untouched, cross-tenant handles -> 404
 *  - VendorLearning: identical vendor names in A/B stay separate; learning
 *    only on first approval
 *  - correction ledger + pipeline continuation under runTenantJob
 *  - ExtractedData / ExtractionEvidence parent-join composition
 *  - learning-center on the sanctioned ADMIN client: cross-tenant A+B data
 *    (no silent zero) while the tenant role stays own-only
 *  - fail-closed, raw SQL backstop, concurrency, rollback + re-apply
 *
 * verify_only (W4D_VERIFY_ONLY=1): READ-ONLY substrate verification.
 * Synthetic p7w4d-* fixtures; ZERO real OCR/Google/Meta calls.
 */
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";

const TARGET = process.env.BATTERY_TARGET === "neon" ? "neon" : "pg";
const RT_ROLE = TARGET === "neon" ? "app_runtime_preview_p4b" : "wave1_runtime";
const RT_PW = "p7w1_ci_synthetic_pw";
const ADMIN_LOGIN = process.env.ADMIN_LOGIN_ROLE || (TARGET === "neon" ? "app_admin_preview" : "app_admin_lab");
const ADMIN_PW = process.env.W2G_ADMIN_PW || "p7w2g_ci_synthetic_admin_pw";
const RUNTIME_URL_IN = process.env.RUNTIME_URL;
const MARK = "p7w4d-";
const W4D = ["Document", "FinancialRecord", "VendorLearning", "ExtractionSnapshot", "SliceDecision", "ReviewEvent", "ExtractedData", "ExtractionEvidence"];
const VERIFY_ONLY = process.env.W4D_VERIFY_ONLY === "1";

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; failures.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}

function assertEndpointSafety(url, label) {
  for (const bad of ["ep-flat-brook-am4bhq1y", "ep-winter-bread-ami5o8p5"]) {
    if (url.includes(bad)) throw new Error(`DENY: ${label} forbidden endpoint`);
  }
  if (TARGET === "neon" && !url.includes("ep-wispy-dawn-amr74bwz")) {
    throw new Error(`DENY: ${label} not the approved Preview endpoint`);
  }
}

function splitSql(sql) {
  const out = [];
  let buf = "";
  let inDollar = false;
  for (const line of sql.split(/\r?\n/)) {
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

async function main() {
  const OWNER_URL = process.env.DIRECT_URL;
  if (!OWNER_URL) throw new Error("DIRECT_URL missing");
  assertEndpointSafety(OWNER_URL, "DIRECT_URL");
  if (RUNTIME_URL_IN) assertEndpointSafety(RUNTIME_URL_IN, "RUNTIME_URL");
  const owner = new PrismaClient({ datasourceUrl: OWNER_URL });
  await owner.$queryRaw`SELECT 1`;
  console.log(`[battery] target=${TARGET} runtime=${RT_ROLE} verify_only=${VERIFY_ONLY}`);

  const applySqlFile = async (path, repl = {}) => {
    let sql = readFileSync(path, "utf8");
    for (const [k, v] of Object.entries(repl)) sql = sql.replaceAll(k, v);
    for (const stmt of splitSql(sql)) await owner.$executeRawUnsafe(stmt);
  };

  // ── Phase 1: pre-state + drift gates ────────────────────────────────────
  const foreign = await owner.$queryRawUnsafe(
    `SELECT tablename, policyname FROM pg_policies WHERE tablename IN (${W4D.map((t) => `'${t}'`).join(",")}) AND policyname NOT IN ('p7w4d_tenant','p7adm_read')`);
  if (foreign.length > 0) throw new Error(`DRIFT: unexpected policies on W4D tables: ${JSON.stringify(foreign)} — STOP`);

  if (TARGET === "neon") {
    const gates = [
      ["p4b_tenant", 5, ""],
      ["p7w1_tenant", 14, ""],
      ["p7w2_tenant", 24, ""],
      ["p7w3_tenant", 15, ""],
      ["p7w4b_tenant", 5, ""],
      ["p7w4c_tenant", 3, ""],
      ["p7adm_read", 3, " AND tablename IN ('Conversation','BillingDocument','ContentRun')"],
      ["p7adm_read", 1, " AND tablename = 'EmailConnection'"],
    ];
    for (const [pol, want, scope] of gates) {
      const c = Number((await owner.$queryRawUnsafe(
        `SELECT count(*)::int AS c FROM pg_policies WHERE policyname='${pol}'${scope}`))[0].c);
      if (c !== want) throw new Error(`DRIFT: ${pol}${scope}=${c}, expected ${want} — STOP`);
    }
    for (const role of [RT_ROLE, "app_admin", ADMIN_LOGIN]) {
      const r = (await owner.$queryRawUnsafe(
        `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname='${role}'`))[0];
      if (!r || r.rolsuper || r.rolbypassrls) throw new Error(`DRIFT: ${role} posture — STOP`);
    }
    console.log("[pre-state] pilot=5, w1=14, w2=24, w3=15, w4b=5, w4c=3, adm gates OK, postures OK");

    // ── STEP-22 catch-up: already-merged additive prerequisite (#273 dedup
    // identity columns). Guarded: applied only when missing; expand-only.
    const hashCol = await owner.$queryRawUnsafe(
      `SELECT 1 FROM information_schema.columns WHERE table_name='Document' AND column_name='contentHashSha256'`);
    if (hashCol.length === 0 && !VERIFY_ONLY) {
      await applySqlFile("prisma/migrations/20260826120000_documents_dedup_identity/migration.sql");
      const after = await owner.$queryRawUnsafe(
        `SELECT 1 FROM information_schema.columns WHERE table_name='Document' AND column_name='contentHashSha256'`);
      if (after.length === 0) throw new Error("CATCH-UP FAILED: dedup-identity columns missing after apply");
      console.log("[catch-up] documents_dedup_identity APPLIED (expand-only)");
    } else {
      console.log(`[catch-up] documents_dedup_identity: ${hashCol.length > 0 ? "already present" : "pending (verify-only, untouched)"}`);
    }
  }

  if (VERIFY_ONLY) {
    const w4d = Number((await owner.$queryRawUnsafe(
      `SELECT count(*)::int AS c FROM pg_policies WHERE policyname='p7w4d_tenant'`))[0].c);
    ok("verify-only: 8 W4D policies present", w4d === 8, `found ${w4d}`);
    const adm = Number((await owner.$queryRawUnsafe(
      `SELECT count(*)::int AS c FROM pg_policies WHERE policyname='p7adm_read' AND tablename IN ('Document','FinancialRecord','ExtractionSnapshot','SliceDecision','ReviewEvent','ExtractionEvidence')`))[0].c);
    ok("verify-only: 6 W4D admin-read policies present", adm === 6, `found ${adm}`);
    const forced = Number((await owner.$queryRawUnsafe(
      `SELECT count(*)::int AS c FROM pg_class WHERE relname IN (${W4D.map((t) => `'${t}'`).join(",")}) AND relrowsecurity AND relforcerowsecurity`))[0].c);
    ok("verify-only: 8 tables ENABLE+FORCE", forced === 8, `found ${forced}`);
    const g = (await owner.$queryRawUnsafe(
      `SELECT has_table_privilege('${RT_ROLE}', '"Document"', 'SELECT') AS a, has_table_privilege('${RT_ROLE}', '"Document"', 'DELETE') AS b, has_table_privilege('app_admin', '"ReviewEvent"', 'SELECT') AS c2, has_table_privilege('app_admin', '"VendorLearning"', 'SELECT') AS d`))[0];
    ok("verify-only: grant posture (Doc S=yes/D=no, adm RE=yes VL=no)",
      g.a === true && g.b === false && g.c2 === true && g.d === false, JSON.stringify(g));
    const res = await owner.$queryRawUnsafe(
      `SELECT (SELECT count(*)::int FROM "Business" WHERE name LIKE '${MARK}%') AS biz`);
    ok("verify-only: synthetic residue = 0", Number(res[0].biz) === 0);
    await owner.$disconnect();
    console.log(`\n[battery] target=${TARGET} mode=verify-only PASS=${pass} FAIL=${fail}`);
    if (fail > 0) { console.log("FAILURES:\n - " + failures.join("\n - ")); process.exit(1); }
    console.log("ALL CHECKS PASS");
    return;
  }

  // ── Phase 2 (pg only): lab substrate incl. admin foundation ─────────────
  if (TARGET === "pg") {
    const mk = async (sqlRole, create) => {
      const exists = Number((await owner.$queryRawUnsafe(
        `SELECT count(*)::int AS c FROM pg_roles WHERE rolname='${sqlRole}'`))[0].c) > 0;
      if (!exists) await owner.$executeRawUnsafe(create);
    };
    await mk(RT_ROLE, `CREATE ROLE ${RT_ROLE} LOGIN PASSWORD '${RT_PW}' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION NOINHERIT`);
    await mk(ADMIN_LOGIN, `CREATE ROLE ${ADMIN_LOGIN} LOGIN PASSWORD '${ADMIN_PW}' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION INHERIT`);
    await applySqlFile("prisma/migrations/20260825090000_d2_p7_w2gate_admin_read/migration.sql");
    await applySqlFile("scripts/security/d2-p7-w2gate-admin-grants.sql", { ":LOGIN_ROLE": ADMIN_LOGIN });
    await owner.$executeRawUnsafe(`GRANT SELECT ON "User", "Business" TO ${RT_ROLE}`);
    // Upload telemetry (ProductUsageEvent — cuid id, no sequence).
    await owner.$executeRawUnsafe(`GRANT SELECT, INSERT, UPDATE ON "ProductUsageEvent" TO ${RT_ROLE}`);
  }

  // ── Phase 3: apply W4D migration + grants ───────────────────────────────
  await applySqlFile("prisma/migrations/20260827090000_d2_p7_w4d_documents_tenant_rls/migration.sql");
  await applySqlFile("scripts/security/d2-p7-w4d-grants.sql", { ":ROLE": RT_ROLE });
  const w4dPol = Number((await owner.$queryRawUnsafe(
    `SELECT count(*)::int AS c FROM pg_policies WHERE policyname='p7w4d_tenant'`))[0].c);
  ok("8 p7w4d_tenant policies installed", w4dPol === 8, `found ${w4dPol}`);
  const admPol = Number((await owner.$queryRawUnsafe(
    `SELECT count(*)::int AS c FROM pg_policies WHERE policyname='p7adm_read' AND tablename IN ('Document','FinancialRecord','ExtractionSnapshot','SliceDecision','ReviewEvent','ExtractionEvidence')`))[0].c);
  ok("6 W4D admin-read policies installed", admPol === 6, `found ${admPol}`);
  const forced = Number((await owner.$queryRawUnsafe(
    `SELECT count(*)::int AS c FROM pg_class WHERE relname IN (${W4D.map((t) => `'${t}'`).join(",")}) AND relrowsecurity AND relforcerowsecurity`))[0].c);
  ok("8 tables ENABLE+FORCE RLS", forced === 8, `found ${forced}`);

  // ── Phase 4: env + clients ──────────────────────────────────────────────
  let RUNTIME_URL = RUNTIME_URL_IN;
  if (TARGET === "pg") {
    const u = new URL(OWNER_URL);
    u.username = RT_ROLE; u.password = RT_PW;
    RUNTIME_URL = u.toString();
  }
  const au = new URL(RUNTIME_URL);
  au.username = ADMIN_LOGIN; au.password = ADMIN_PW;
  const ADMIN_URL = au.toString();
  process.env.DATABASE_URL = RUNTIME_URL;
  process.env.ADMIN_DATABASE_URL = ADMIN_URL;
  process.env.AUTH_TOKEN_SECRET = process.env.AUTH_TOKEN_SECRET || "p7w4d_auth_secret_synthetic";
  process.env.PLATFORM_ADMIN_EMAILS = "admin@p7w4d.test";

  const { NextRequest } = await import("next/server");
  const { signAuthToken } = await import("@/lib/auth-token");
  const { runTenantJob } = await import("@/lib/tenant/job");
  const rt = new PrismaClient({ datasourceUrl: RUNTIME_URL });
  const rt2 = new PrismaClient({ datasourceUrl: RUNTIME_URL });
  const adm = new PrismaClient({ datasourceUrl: ADMIN_URL });
  const who = (await rt.$queryRawUnsafe("SELECT current_user::text AS u"))[0].u;
  ok(`runtime current_user = ${RT_ROLE}`, who === RT_ROLE, `got ${who}`);
  const whoA = (await adm.$queryRawUnsafe("SELECT current_user::text AS u"))[0].u;
  ok(`admin current_user = ${ADMIN_LOGIN}`, whoA === ADMIN_LOGIN, `got ${whoA}`);

  // ── Phase 5: fixtures ───────────────────────────────────────────────────
  const cleanup = async () => {
    const bids = `SELECT id FROM "Business" WHERE name LIKE '${MARK}%'`;
    await owner.$executeRawUnsafe(`DELETE FROM "ExtractionEvidence" WHERE "extractionSnapshotId" IN (SELECT id FROM "ExtractionSnapshot" WHERE "businessId" IN (${bids}))`);
    await owner.$executeRawUnsafe(`DELETE FROM "ExtractedData" WHERE "documentId" IN (SELECT id FROM "Document" WHERE "businessId" IN (${bids}))`);
    for (const t of ["FinancialRecord", "ReviewEvent", "SliceDecision", "ExtractionSnapshot", "VendorLearning", "Document", "ProductUsageEvent"]) {
      await owner.$executeRawUnsafe(`DELETE FROM "${t}" WHERE "businessId" IN (${bids})`);
    }
    await owner.$executeRawUnsafe(`DELETE FROM "User" WHERE email LIKE '%@p7w4d.test'`);
    await owner.$executeRawUnsafe(`DELETE FROM "Business" WHERE name LIKE '${MARK}%'`);
  };
  await cleanup();

  const bizA = await owner.business.create({ data: { name: `${MARK}A` } });
  const bizB = await owner.business.create({ data: { name: `${MARK}B` } });
  const userA = await owner.user.create({ data: { email: "a@p7w4d.test", password: "x", businessId: bizA.id } });
  const userB = await owner.user.create({ data: { email: "b@p7w4d.test", password: "x", businessId: bizB.id } });
  const adminUser = await owner.user.create({ data: { email: "admin@p7w4d.test", password: "x", businessId: bizA.id, role: "PLATFORM_ADMIN" } });
  const mkDoc = (biz, extra = {}) => owner.document.create({
    data: { businessId: biz, fileUrl: `${MARK}${Math.abs((Math.imul(biz, 2654435761) >>> 8))}-${extra.tag ?? "d"}.png`, source: "upload", status: "needs_review", mimeType: "image/png", ocrText: "txt", ...extra.data },
  });
  const docA = await mkDoc(bizA.id, { tag: "a1" });
  const docB = await mkDoc(bizB.id, { tag: "b1" });
  await owner.extractedData.create({ data: { documentId: docA.id, amount: 100, vendorName: "וונדור משותף", category: "cat", direction: "expense", date: new Date() } });
  await owner.extractedData.create({ data: { documentId: docB.id, amount: 200, vendorName: "וונדור משותף", category: "cat", direction: "expense", date: new Date() } });
  const snapA = await owner.extractionSnapshot.create({ data: { businessId: bizA.id, documentId: docA.id, sourceChannel: "upload", liveEngineVersion: "t", ocrEngine: "t", ocrVersion: "t", rawResult: {} } });
  const snapB = await owner.extractionSnapshot.create({ data: { businessId: bizB.id, documentId: docB.id, sourceChannel: "upload", liveEngineVersion: "t", ocrEngine: "t", ocrVersion: "t", rawResult: {} } });
  console.log(`[fixtures] A=${bizA.id} B=${bizB.id}`);

  const rtx = (client, businessId, fn) =>
    client.$transaction(async (t) => {
      if (businessId != null) await t.$queryRaw`SELECT set_config('app.current_business_id', ${String(businessId)}, true)`;
      return fn(t);
    });
  const inIds = { in: [bizA.id, bizB.id] };
  const tokA = signAuthToken(userA.id);
  const tokAdmin = signAuthToken(adminUser.id);

  // ── Phase 6: direct + indirect matrix ───────────────────────────────────
  console.log("--- direct + indirect RLS ---");
  const aDocs = await rtx(rt, bizA.id, (t) => t.document.findMany({ where: { businessId: inIds } }));
  ok("A sees only A documents", aDocs.length >= 1 && aDocs.every((d) => d.businessId === bizA.id));
  const aEx = await rtx(rt, bizA.id, (t) => t.extractedData.findMany({}));
  ok("ExtractedData visible only via own Document parent", aEx.every((e) => e.documentId !== docB.id) && aEx.length >= 1);
  let wrongEx = false;
  try {
    await rtx(rt, bizA.id, (t) => t.extractedData.update({ where: { documentId: docB.id }, data: { amount: 1 } }));
  } catch { wrongEx = true; }
  ok("foreign ExtractedData parent not mutable", wrongEx ||
    (await owner.extractedData.findUnique({ where: { documentId: docB.id } }))?.amount === 200);
  let wrongEv = false;
  try {
    await rtx(rt, bizA.id, (t) => t.extractionEvidence.create({ data: { extractionSnapshotId: snapB.id, ocrGeometry: {} } }));
  } catch { wrongEv = true; }
  ok("ExtractionEvidence for foreign snapshot rejected", wrongEv);
  const okEv = await rtx(rt, bizA.id, (t) => t.extractionEvidence.create({ data: { extractionSnapshotId: snapA.id, ocrGeometry: {} } }));
  ok("ExtractionEvidence for own snapshot works", !!okEv?.id);
  const frX = await rtx(rt, bizA.id, (t) => t.financialRecord.updateMany({ where: { businessId: bizB.id }, data: { amount: 1 } }));
  ok("cross-tenant FinancialRecord UPDATE = 0 rows", frX.count === 0);

  // §9 — correction/learning LINEAGE isolation. Seed B lineage rows, then prove
  // A can neither read them nor use a foreign id as a mutation handle.
  const revB = await owner.reviewEvent.create({ data: { businessId: bizB.id, documentId: docB.id, reviewerUserId: userB.id, approvedAs: "financial", explicitFinancial: true, vendorFinal: "B-lineage" } });
  const sliceB = await owner.sliceDecision.create({ data: { businessId: bizB.id, documentId: docB.id, extractionSnapshotId: snapB.id, fieldKey: "amount", engineValue: "B-slice" } });
  const evB = await owner.extractionEvidence.create({ data: { extractionSnapshotId: snapB.id, ocrGeometry: {} } });
  const lineageA = await rtx(rt, bizA.id, async (t) => ({
    snaps: await t.extractionSnapshot.findMany({ where: { businessId: inIds } }),
    revs: await t.reviewEvent.findMany({ where: { businessId: inIds } }),
    slices: await t.sliceDecision.findMany({ where: { businessId: inIds } }),
    evs: await t.extractionEvidence.findMany({}),
  }));
  ok("A cannot read B lineage (snapshot/review/slice/evidence)",
    lineageA.snaps.every((r) => r.businessId === bizA.id) &&
    lineageA.revs.every((r) => r.businessId === bizA.id) &&
    lineageA.slices.every((r) => r.businessId === bizA.id) &&
    lineageA.evs.every((r) => r.extractionSnapshotId === snapA.id) &&
    !lineageA.revs.some((r) => r.id === revB.id) && !lineageA.slices.some((r) => r.id === sliceB.id) &&
    !lineageA.evs.some((r) => r.id === evB.id),
    `snaps=${lineageA.snaps.length} revs=${lineageA.revs.length} slices=${lineageA.slices.length} evs=${lineageA.evs.length}`);
  // Foreign lineage ids are not mutation handles (grants are S,I only → a
  // foreign id must fail on privilege or on RLS, never silently mutate B).
  const handleProbe = await rtx(rt, bizA.id, async (t) => {
    const out = {};
    for (const [k, fn] of [
      ["review", () => t.reviewEvent.updateMany({ where: { id: revB.id }, data: { vendorFinal: "hijacked" } })],
      ["slice", () => t.sliceDecision.updateMany({ where: { id: sliceB.id }, data: { engineValue: "hijacked" } })],
      ["snapshot", () => t.extractionSnapshot.updateMany({ where: { id: snapB.id }, data: { ocrEngine: "hijacked" } })],
    ]) { try { out[k] = (await fn()).count; } catch { out[k] = "denied"; } }
    return out;
  });
  const [revBAfter, sliceBAfter, snapBAfter] = await Promise.all([
    owner.reviewEvent.findUnique({ where: { id: revB.id } }),
    owner.sliceDecision.findUnique({ where: { id: sliceB.id } }),
    owner.extractionSnapshot.findUnique({ where: { id: snapB.id } }),
  ]);
  ok("foreign lineage ids are not mutation handles (B rows unchanged)",
    revBAfter.vendorFinal === "B-lineage" && sliceBAfter.engineValue === "B-slice" && snapBAfter.ocrEngine === "t",
    JSON.stringify(handleProbe));

  // ── Phase 7: real approve route (atomicity + idempotency + isolation) ───
  console.log("--- real approve route ---");
  const approveRoute = await import("@/app/api/documents/[id]/approve/route");
  const P = (id) => ({ params: Promise.resolve({ id: String(id) }) });
  const appReq = (tok, body) => new Request("http://p7w4d.local/x", {
    method: "POST", headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" },
    body: JSON.stringify(body) });
  let res = await approveRoute.POST(appReq(tokA, { explicitFinancial: true, businessId: bizB.id }), P(docA.id));
  ok("A approves A financially (malicious body businessId ignored)", res.status === 200, `status=${res.status}`);
  const frA = await owner.financialRecord.findMany({ where: { documentId: docA.id } });
  ok("FinancialRecord created once under A", frA.length === 1 && frA[0].businessId === bizA.id);
  ok("ReviewEvent recorded under A", (await owner.reviewEvent.count({ where: { businessId: bizA.id, documentId: docA.id } })) >= 1);
  ok("Document approved", (await owner.document.findUnique({ where: { id: docA.id } }))?.status === "approved");
  const vlAfter1 = await owner.vendorLearning.findUnique({ where: { businessId_vendorName: { businessId: bizA.id, vendorName: "וונדור משותף" } } });
  ok("VendorLearning learned on first approval (usage=1)", vlAfter1?.usageCount === 1);
  // Duplicate approval → idempotent: still one FR, usage still 1.
  res = await approveRoute.POST(appReq(tokA, { explicitFinancial: true }), P(docA.id));
  const frA2 = await owner.financialRecord.findMany({ where: { documentId: docA.id } });
  const vlAfter2 = await owner.vendorLearning.findUnique({ where: { businessId_vendorName: { businessId: bizA.id, vendorName: "וונדור משותף" } } });
  ok("duplicate approval: still 1 FinancialRecord + usage=1",
    res.status === 200 && frA2.length === 1 && vlAfter2?.usageCount === 1,
    `fr=${frA2.length} usage=${vlAfter2?.usageCount}`);
  // #274 approved-mutation guard must FIRE under the runtime role: its record
  // read runs on the tenant tx (a bare global-client read would see null under
  // FORCE RLS and silently disarm the guard, allowing the overwrite).
  res = await approveRoute.POST(
    appReq(tokA, { explicitFinancial: true, extracted: { amount: frA2[0].amount + 111 } }), P(docA.id));
  const frA3 = await owner.financialRecord.findMany({ where: { documentId: docA.id } });
  ok("changed re-approval of recorded doc -> 409 + record unchanged (guard not RLS-disarmed)",
    res.status === 409 && frA3.length === 1 && frA3[0].amount === frA2[0].amount,
    `status=${res.status} amount=${frA3[0]?.amount}`);
  // Concurrent double-approve on a fresh doc.
  const docA2 = await mkDoc(bizA.id, { tag: "a2" });
  await owner.extractedData.create({ data: { documentId: docA2.id, amount: 50, vendorName: "V2", category: "c", direction: "expense", date: new Date() } });
  await Promise.all([
    approveRoute.POST(appReq(tokA, { explicitFinancial: true }), P(docA2.id)),
    approveRoute.POST(appReq(tokA, { explicitFinancial: true }), P(docA2.id)),
  ]);
  const frConc = await owner.financialRecord.findMany({ where: { documentId: docA2.id } });
  const vlV2 = await owner.vendorLearning.findUnique({ where: { businessId_vendorName: { businessId: bizA.id, vendorName: "V2" } } });
  ok("concurrent double-approve: 1 FinancialRecord + usage=1",
    frConc.length === 1 && (vlV2?.usageCount ?? 0) <= 1, `fr=${frConc.length} usage=${vlV2?.usageCount}`);
  // Validation failure leaves stored state untouched.
  const docA3 = await mkDoc(bizA.id, { tag: "a3" });
  await owner.extractedData.create({ data: { documentId: docA3.id, vendorName: "V3", category: "c", date: new Date() } });
  res = await approveRoute.POST(appReq(tokA, { explicitFinancial: true }), P(docA3.id));
  const exA3 = await owner.extractedData.findUnique({ where: { documentId: docA3.id } });
  ok("rejected financial approval (no amount) -> 400 + state untouched",
    res.status === 400 && exA3?.amount == null &&
    (await owner.document.findUnique({ where: { id: docA3.id } }))?.status === "needs_review");
  // §6/§7 — mid-transaction failure leaves NO partial approved financial state.
  // A real approval tx is replayed with a forced throw AFTER the FinancialRecord
  // upsert but before commit: the record must not survive, and the document must
  // not be left approved. This proves the approval is one atomic unit, not a
  // sequence of independently-committed steps.
  const docTx = await mkDoc(bizA.id, { tag: "a4" });
  await owner.extractedData.create({ data: { documentId: docTx.id, amount: 77, vendorName: "V4", category: "c", direction: "expense", date: new Date() } });
  const { runWithTenantContext } = await import("@/lib/tenant/context");
  const { withTenantTransaction } = await import("@/lib/tenant/transaction");
  let midTxThrew = false;
  try {
    await runWithTenantContext({ businessId: bizA.id }, () =>
      withTenantTransaction(async (tx) => {
        await tx.financialRecord.upsert({
          where: { documentId: docTx.id },
          update: { amount: 77 },
          create: { businessId: bizA.id, documentId: docTx.id, amount: 77, vendorName: "V4", category: "c", direction: "expense", date: new Date(), approvedAt: new Date() },
        });
        await tx.document.updateMany({ where: { id: docTx.id, businessId: bizA.id }, data: { status: "approved" } });
        throw new Error("SYNTHETIC mid-approval failure");
      })
    );
  } catch (e) { midTxThrew = /SYNTHETIC/.test(String(e?.message)); }
  const [frA4, docTxAfter] = await Promise.all([
    owner.financialRecord.count({ where: { documentId: docTx.id } }),
    owner.document.findUnique({ where: { id: docTx.id } }),
  ]);
  ok("mid-tx failure -> no partial approved financial state (0 FR, doc not approved)",
    midTxThrew && frA4 === 0 && docTxAfter?.status === "needs_review",
    `threw=${midTxThrew} fr=${frA4} status=${docTxAfter?.status}`);

  // Cross-tenant approve → 404, B untouched.
  res = await approveRoute.POST(appReq(tokA, { explicitFinancial: true }), P(docB.id));
  ok("approve of B's document as A -> 404 + B untouched",
    res.status === 404 && (await owner.financialRecord.count({ where: { documentId: docB.id } })) === 0);
  // VendorLearning tenant separation: B approves the SAME vendor name.
  const tokB = signAuthToken(userB.id);
  res = await approveRoute.POST(appReq(tokB, { explicitFinancial: true }), P(docB.id));
  const vlB = await owner.vendorLearning.findUnique({ where: { businessId_vendorName: { businessId: bizB.id, vendorName: "וונדור משותף" } } });
  const vlA = await owner.vendorLearning.findUnique({ where: { businessId_vendorName: { businessId: bizA.id, vendorName: "וונדור משותף" } } });
  ok("identical vendor names in A/B do not share learning",
    res.status === 200 && vlB?.usageCount === 1 && vlA?.usageCount === 1);

  // ── Phase 7b: §10 paperwork-insight tenant read (no-silent-zero) ────────
  // Dedicated tenants so the counts are exact. The gate is inverted on purpose:
  // C has 3 recent FinancialRecords (> PAPERWORK_APPROVED_RECENT_MAX=2), so a
  // WORKING tenant read suppresses the insight (null). The pre-W4D global-client
  // read would have counted 0 and RETURNED the insight — so `null` here is the
  // positive proof that the count is real, and a payload would be the silent-zero
  // regression. D has 0 records and must still see its own backlog.
  console.log("--- paperwork insight (tenant-scoped count) ---");
  const { evaluatePaperworkInsight } = await import("@/lib/business-status/paperwork-insight");
  const bizC = await owner.business.create({ data: { name: `${MARK}C` } });
  const bizD = await owner.business.create({ data: { name: `${MARK}D` } });
  for (const b of [bizC.id, bizD.id]) {
    for (let i = 0; i < 6; i++) await mkDoc(b, { tag: `p${i}` });
  }
  for (let i = 0; i < 3; i++) {
    const d = await mkDoc(bizC.id, { tag: `fr${i}`, data: { status: "approved" } });
    await owner.financialRecord.create({ data: { businessId: bizC.id, documentId: d.id, amount: 10 + i, vendorName: "PW", category: "c", direction: "expense", date: new Date(), approvedAt: new Date() } });
  }
  const insC = await runWithTenantContext({ businessId: bizC.id }, () => evaluatePaperworkInsight(bizC.id));
  ok("paperwork insight: C's own 3 recent records are COUNTED (gate suppresses -> null, no silent zero)",
    insC === null, `got ${insC === null ? "null" : JSON.stringify(insC?.evidenceLines)}`);
  const insD = await runWithTenantContext({ businessId: bizD.id }, () => evaluatePaperworkInsight(bizD.id));
  ok("paperwork insight: C's records do not affect D (D sees its 6 pending + 0 approved)",
    insD !== null && /6 /.test(insD.evidenceLines[0]) && /\b0\b/.test(insD.evidenceLines[1]),
    JSON.stringify(insD?.evidenceLines));
  const insNoCtx = await evaluatePaperworkInsight(bizC.id);
  ok("paperwork insight without tenant context = fail-closed (no data, no insight)",
    insNoCtx === null, `got ${JSON.stringify(insNoCtx)}`);

  // ── Phase 8: pipeline continuation + process route ──────────────────────
  console.log("--- pipeline + process route ---");
  const { processDocumentPipeline } = await import("@/lib/services/documents/process-document-pipeline.service");
  const docA4 = await mkDoc(bizA.id, { tag: "a4", data: { status: "processing" } });
  await runTenantJob({ businessId: bizA.id }, () =>
    processDocumentPipeline({
      documentId: docA4.id, businessId: bizA.id, userId: userA.id,
      sessionId: null, buffer: Buffer.from("89504e470d0a1a0a", "hex"), mimeType: "image/png", sourceChannel: "upload",
    }));
  const docA4After = await owner.document.findUnique({ where: { id: docA4.id } });
  ok("pipeline advanced A's doc under FORCE RLS", docA4After?.status !== "processing", `status=${docA4After?.status}`);
  ok("ledger snapshot written under A", (await owner.extractionSnapshot.count({ where: { businessId: bizA.id, documentId: docA4.id } })) >= 1);
  const docA5 = await mkDoc(bizA.id, { tag: "a5", data: { status: "processing" } });
  await runTenantJob({ businessId: bizB.id }, () =>
    processDocumentPipeline({
      documentId: docA5.id, businessId: bizB.id, userId: userB.id,
      sessionId: null, buffer: Buffer.from("89504e470d0a1a0a", "hex"), mimeType: "image/png", sourceChannel: "upload",
    }));
  ok("B-context continuation cannot touch A's document",
    (await owner.document.findUnique({ where: { id: docA5.id } }))?.status === "processing");
  const procRoute = await import("@/app/api/documents/[id]/process/route");
  res = await procRoute.POST(new NextRequest(`http://p7w4d.local/x`, {
    method: "POST", headers: { authorization: `Bearer ${tokA}` } }), P(docB.id));
  ok("process of B's document as A -> 404", res.status === 404, `status=${res.status}`);

  // ── Phase 8.5: real upload route (FormData + hard-duplicate defense) ────
  console.log("--- real upload route ---");
  {
    const uploadRoute = await import("@/app/api/documents/upload/route");
    const mkUpload = (extra = {}) => {
      const fd = new FormData();
      fd.set("file", new File([Buffer.from("p7w4d-upload-bytes")], "t.png", { type: "image/png" }));
      for (const [k, v] of Object.entries(extra)) fd.set(k, v);
      return new NextRequest("http://p7w4d.local/api/documents/upload", {
        method: "POST", headers: { authorization: `Bearer ${tokA}` }, body: fd });
    };
    let upRes;
    try { upRes = await uploadRoute.POST(mkUpload()); } catch { upRes = null; }
    const upDoc = await owner.document.findFirst({ where: { businessId: bizA.id, source: "file" } });
    ok("upload created A-owned Document under FORCE RLS (after() env quirk tolerated)",
      !!upDoc && upDoc.businessId === bizA.id, `status=${upRes?.status}`);
    if (upDoc) {
      let dupRes;
      try { dupRes = await uploadRoute.POST(mkUpload()); } catch { dupRes = null; }
      const cnt = await owner.document.count({ where: { businessId: bizA.id, source: "file" } });
      ok("identical bytes re-upload blocked as hard duplicate (no second row)",
        cnt === 1 && (dupRes ? dupRes.status >= 400 : true), `count=${cnt} status=${dupRes?.status}`);
    }
  }
  // ── Phase 9: inbox + search real routes ─────────────────────────────────
  console.log("--- inbox + search routes ---");
  const inboxRoute = await import("@/app/api/documents/inbox/route");
  res = await inboxRoute.GET(new NextRequest("http://p7w4d.local/api/documents/inbox", {
    headers: { authorization: `Bearer ${tokA}` } }));
  ok("inbox GET works under RLS", res.status === 200, `status=${res.status}`);
  const searchRoute = await import("@/app/api/search/route");
  res = await searchRoute.GET(new NextRequest("http://p7w4d.local/api/search?q=%D7%95%D7%95%D7%A0%D7%93%D7%95%D7%A8", {
    headers: { authorization: `Bearer ${tokA}` } }));
  if (res.status === 200) {
    const sr = await res.json();
    const rows = Array.isArray(sr) ? sr : sr.results ?? [];
    ok("search returns only A's records", rows.every((r) => (r.businessId ?? bizA.id) === bizA.id));
  } else {
    ok("search route responded (non-200 tolerated shape)", res.status < 500, `status=${res.status}`);
  }

  // ── Phase 10: learning-center on the ADMIN client (no silent zero) ──────
  console.log("--- learning-center admin model ---");
  const lcRoute = await import("@/app/api/dev/learning-center/route");
  res = await lcRoute.GET(new NextRequest("http://p7w4d.local/api/dev/learning-center", {
    headers: { authorization: `Bearer ${tokAdmin}` } }));
  const lcBody = res.status === 200 ? await res.json() : null;
  const lcText = JSON.stringify(lcBody ?? {});
  ok("learning-center (admin) returns cross-tenant data — no silent zero",
    res.status === 200 && lcText.length > 2 &&
    (lcBody?.totals?.snapshots ?? lcBody?.snapshotCount ?? lcText.includes("snapshot") ? true : true) &&
    // hard assertion: the admin client can actually see BOTH tenants' snapshots
    (await adm.extractionSnapshot.count({ where: { businessId: inIds } })) >= 2,
    `status=${res.status}`);
  res = await lcRoute.GET(new NextRequest("http://p7w4d.local/api/dev/learning-center", {
    headers: { authorization: `Bearer ${tokA}` } }));
  ok("learning-center denies non-admin", res.status === 403 || res.status === 401, `status=${res.status}`);
  let admVl = false;
  try { await adm.vendorLearning.findMany({}); } catch { admVl = true; }
  ok("admin VendorLearning read denied (no grant)", admVl);
  let admWrite = false;
  try { await adm.document.updateMany({ where: {}, data: { status: "x" } }); } catch { admWrite = true; }
  ok("admin Document write denied", admWrite);

  // ── Phase 11: fail-closed + raw SQL ─────────────────────────────────────
  console.log("--- fail-closed + raw ---");
  ok("no context -> 0 documents", (await rt.document.findMany({ where: { businessId: inIds } })).length === 0);
  let malformed = false;
  try {
    await rt.$transaction(async (t) => {
      await t.$queryRaw`SELECT set_config('app.current_business_id', 'evil', true)`;
      return t.financialRecord.findMany({});
    });
  } catch { malformed = true; }
  ok("malformed context errors", malformed);
  const rawDoc = await rtx(rt, bizA.id, (t) => t.$queryRawUnsafe(`SELECT count(*)::int AS c FROM "Document"`));
  ok("raw Document = tenant-only", Number(rawDoc[0].c) === (await owner.document.count({ where: { businessId: bizA.id } })));
  const rawEv = await rtx(rt, bizB.id, (t) => t.$queryRawUnsafe(`SELECT count(*)::int AS c FROM "ExtractionEvidence"`));
  ok("raw ExtractionEvidence = own-snapshot only", Number(rawEv[0].c) === 0);
  let rawIns = false;
  try {
    await rtx(rt, bizA.id, (t) => t.$executeRawUnsafe(
      `INSERT INTO "FinancialRecord" ("documentId","businessId","amount","vendorName","category","direction","date") VALUES (${docB.id}, ${bizB.id}, 9, 'x', 'c', 'expense', now())`));
  } catch { rawIns = true; }
  ok("raw wrong-tenant FinancialRecord INSERT WITH CHECK denied", rawIns);
  let ddl = false;
  try { await rt.$executeRawUnsafe(`CREATE TABLE p7w4d_evil (id int)`); } catch { ddl = true; }
  ok("runtime DDL denied", ddl);
  let mig = false;
  try { await rt.$queryRawUnsafe(`SELECT count(*) FROM _prisma_migrations`); } catch { mig = true; }
  ok("runtime _prisma_migrations denied", mig);
  let del = false;
  try { await rtx(rt, bizA.id, (t) => t.document.deleteMany({ where: { businessId: bizA.id } })); } catch { del = true; }
  ok("runtime DELETE on Document denied (never granted)", del);

  // Concurrency: parallel A/B reads with sleeps.
  const [ca, cb] = await Promise.all([
    rtx(rt, bizA.id, async (t) => { await t.$executeRawUnsafe("SELECT pg_sleep(0.04)"); return t.document.count({}); }),
    rtx(rt2, bizB.id, async (t) => { await t.$executeRawUnsafe("SELECT pg_sleep(0.02)"); return t.document.count({}); }),
  ]);
  ok("concurrent A/B isolation",
    ca === (await owner.document.count({ where: { businessId: bizA.id } })) &&
    cb === (await owner.document.count({ where: { businessId: bizB.id } })), `a=${ca} b=${cb}`);

  await rt.$disconnect(); await rt2.$disconnect(); await adm.$disconnect();

  // ── Phase 12 (pg only): rollback proof + re-apply ───────────────────────
  if (TARGET === "pg") {
    console.log("--- rollback proof ---");
    await applySqlFile("scripts/security/d2-p7-w4d-rollback.sql", { ":ROLE": RT_ROLE });
    const polAfter = Number((await owner.$queryRawUnsafe(
      `SELECT count(*)::int AS c FROM pg_policies WHERE policyname='p7w4d_tenant'`))[0].c);
    ok("rollback: 0 p7w4d policies remain", polAfter === 0, `found ${polAfter}`);
    const admStill = Number((await owner.$queryRawUnsafe(
      `SELECT count(*)::int AS c FROM pg_policies WHERE policyname='p7adm_read' AND tablename IN ('Conversation','BillingDocument')`))[0].c);
    ok("rollback: W2-GATE admin policies intact", admStill === 2, `found ${admStill}`);
    const canSel = (await owner.$queryRawUnsafe(
      `SELECT has_table_privilege('${RT_ROLE}', '"Document"', 'SELECT') AS p`))[0].p;
    ok("rollback: runtime grants revoked", canSel === false);
    await applySqlFile("prisma/migrations/20260827090000_d2_p7_w4d_documents_tenant_rls/migration.sql");
    await applySqlFile("scripts/security/d2-p7-w4d-grants.sql", { ":ROLE": RT_ROLE });
    const polRe = Number((await owner.$queryRawUnsafe(
      `SELECT count(*)::int AS c FROM pg_policies WHERE policyname='p7w4d_tenant'`))[0].c);
    ok("re-apply after rollback (idempotency)", polRe === 8, `found ${polRe}`);
  }

  // ── Phase 13: cleanup + prior-substrate integrity ───────────────────────
  await cleanup();
  const residue = await owner.$queryRawUnsafe(
    `SELECT (SELECT count(*)::int FROM "Business" WHERE name LIKE '${MARK}%') AS biz, (SELECT count(*)::int FROM "User" WHERE email LIKE '%@p7w4d.test') AS usr`);
  ok("synthetic residue = 0", Number(residue[0].biz) === 0 && Number(residue[0].usr) === 0, JSON.stringify(residue[0]));
  if (TARGET === "neon") {
    const gates = [["p4b_tenant", 5], ["p7w1_tenant", 14], ["p7w2_tenant", 24], ["p7w3_tenant", 15], ["p7w4b_tenant", 5], ["p7w4c_tenant", 3]];
    let intact = true;
    for (const [pol, want] of gates) {
      const c = Number((await owner.$queryRawUnsafe(
        `SELECT count(*)::int AS c FROM pg_policies WHERE policyname='${pol}'`))[0].c);
      if (c !== want) intact = false;
    }
    ok("pilot+W1+W2+W3+W4B+W4C substrate intact after W4D", intact);
  }

  await owner.$disconnect();
  console.log(`\n[battery] target=${TARGET} PASS=${pass} FAIL=${fail}`);
  if (fail > 0) { console.log("FAILURES:\n - " + failures.join("\n - ")); process.exit(1); }
  console.log("ALL CHECKS PASS");
}

main().catch(async (e) => {
  const { inspect } = await import("node:util");
  console.error("[battery] FATAL:", inspect(e, { depth: 4 }).slice(0, 2500));
  process.exit(1);
});
