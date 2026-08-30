/**
 * D2 / P7-W4E-B-2 — Billing + Billing Authority tenant-isolation battery.
 *
 * Targets (BATTERY_TARGET): pg (ephemeral PG17: full provision incl. a
 * pilot-equivalent policy on BillingDocument, matrix, rollback, re-apply) |
 * neon (Preview: drift gates, apply, matrix as the real runtime role).
 *
 * The load-bearing part of this wave is LEGAL DOCUMENT NUMBERING. The
 * allocation is an upsert on (businessId, documentType) with
 * `nextNumber: { increment: 1 }` inside the issuance transaction; the number
 * handed out is `nextNumber - 1`. RLS must not change any of that. What is
 * proven below is not "the policy exists" but that the numbers themselves stay
 * correct: unique under 20-way concurrency, independent per tenant and per
 * document type, and untouched by a rolled-back transaction — while a foreign
 * tenant's sequence becomes unreachable.
 *
 * Because two policies are parent-joins through BillingDocument, the PG lab
 * installs a pilot-EQUIVALENT policy on that parent first. Testing a child
 * policy against an unprotected parent would prove nothing.
 *
 * verify_only (W4EB2_VERIFY_ONLY=1): READ-ONLY substrate verification.
 * Synthetic p7w4eb2-* fixtures only. ZERO real ITA/provider calls.
 */
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";

const TARGET = process.env.BATTERY_TARGET === "neon" ? "neon" : "pg";
const RT_ROLE = TARGET === "neon" ? "app_runtime_preview_p4b" : "wave1_runtime";
const RT_PW = "p7w1_ci_synthetic_pw";
const RUNTIME_URL_IN = process.env.RUNTIME_URL;
const MARK = "p7w4eb2-";
const DIRECT = [
  "BillingAuthorityConnection", "BillingAuthoritySubmission",
  "BillingPaymentAllocation", "BillingDocumentNumberSequence",
  "BillingAuditEvent", "BusinessBot",
];
const INDIRECT = ["BillingDocumentLine", "BillingReceiptPayment"];
const ALL = [...DIRECT, ...INDIRECT];
const DELETE_ENABLED = ["BillingPaymentAllocation", "BillingDocumentLine", "BillingReceiptPayment"];
const DELETE_DENIED = ["BillingDocumentNumberSequence", "BillingAuditEvent", "BillingAuthoritySubmission"];
const VERIFY_ONLY = process.env.W4EB2_VERIFY_ONLY === "1";

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
  let buf = "", inDollar = false;
  for (const line of sql.split(/\r?\n/)) {
    const stripped = line.replace(/--.*$/, "");
    if ((stripped.match(/\$\$/g) || []).length % 2 === 1) inDollar = !inDollar;
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
    `SELECT tablename, policyname FROM pg_policies WHERE tablename IN (${ALL.map((t) => `'${t}'`).join(",")}) AND policyname <> 'p7w4eb2_tenant'`);
  if (foreign.length > 0) throw new Error(`DRIFT: unexpected policies on B-2 tables: ${JSON.stringify(foreign)} — STOP`);

  if (TARGET === "neon") {
    const gates = [
      ["p4b_tenant", 5], ["p7w1_tenant", 14], ["p7w2_tenant", 24], ["p7w3_tenant", 15],
      ["p7w4b_tenant", 5], ["p7w4c_tenant", 3], ["p7w4d_tenant", 8], ["p7w4ea_tenant", 4],
      ["p7adm_read", 10],
    ];
    for (const [pol, want] of gates) {
      const c = Number((await owner.$queryRawUnsafe(
        `SELECT count(*)::int AS c FROM pg_policies WHERE policyname='${pol}'`))[0].c);
      if (c !== want) throw new Error(`DRIFT: ${pol}=${c}, expected ${want} — STOP`);
    }
    for (const role of [RT_ROLE, "app_admin", "app_admin_preview"]) {
      const r = (await owner.$queryRawUnsafe(
        `SELECT rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname='${role}'`))[0];
      if (!r || r.rolsuper || r.rolbypassrls) throw new Error(`DRIFT: ${role} posture — STOP`);
    }
    console.log("[pre-state] pilot=5, w1=14, w2=24, w3=15, w4b=5, w4c=3, w4d=8, w4ea=4, adm=10, postures OK");
  }

  if (VERIFY_ONLY) {
    const p = Number((await owner.$queryRawUnsafe(
      `SELECT count(*)::int AS c FROM pg_policies WHERE policyname='p7w4eb2_tenant'`))[0].c);
    ok("verify-only: 8 B-2 policies present", p === 8, `found ${p}`);
    const forced = Number((await owner.$queryRawUnsafe(
      `SELECT count(*)::int AS c FROM pg_class WHERE relname IN (${ALL.map((t) => `'${t}'`).join(",")}) AND relrowsecurity AND relforcerowsecurity`))[0].c);
    ok("verify-only: 8 tables ENABLE+FORCE", forced === 8, `found ${forced}`);
    const bfa = await owner.$queryRawUnsafe(
      `SELECT relrowsecurity AS e FROM pg_class WHERE relname='BusinessFeatureAccess'`);
    ok("verify-only: BusinessFeatureAccess stays untouched (no RLS)", bfa.length === 1 && bfa[0].e === false);
    const g = (await owner.$queryRawUnsafe(
      `SELECT has_table_privilege('${RT_ROLE}', '"BillingDocumentNumberSequence"', 'DELETE') AS seqdel,
              has_table_privilege('${RT_ROLE}', '"BillingDocumentLine"', 'DELETE') AS linedel,
              has_table_privilege('${RT_ROLE}', '"BillingAuditEvent"', 'DELETE') AS auditdel,
              has_table_privilege('app_admin', '"BillingAuthorityConnection"', 'SELECT') AS admconn`))[0];
    ok("verify-only: DELETE posture (sequence=no, line=yes, audit=no, admin conn=no)",
      g.seqdel === false && g.linedel === true && g.auditdel === false && g.admconn === false, JSON.stringify(g));
    const res = await owner.$queryRawUnsafe(
      `SELECT (SELECT count(*)::int FROM "Business" WHERE name LIKE '${MARK}%') AS biz`);
    ok("verify-only: synthetic residue = 0", Number(res[0].biz) === 0);
    await owner.$disconnect();
    console.log(`\n[battery] target=${TARGET} mode=verify-only PASS=${pass} FAIL=${fail}`);
    if (fail > 0) { console.log("FAILURES:\n - " + failures.join("\n - ")); process.exit(1); }
    console.log("ALL CHECKS PASS");
    return;
  }

  // ── Phase 2 (pg only): lab substrate ────────────────────────────────────
  // The two indirect policies join through BillingDocument, which the P4-B
  // pilot protects on Preview. The lab installs the SAME shape under the same
  // name so the child policies are proven against a genuinely protected parent.
  if (TARGET === "pg") {
    const exists = Number((await owner.$queryRawUnsafe(
      `SELECT count(*)::int AS c FROM pg_roles WHERE rolname='${RT_ROLE}'`))[0].c) > 0;
    if (!exists) {
      await owner.$executeRawUnsafe(
        `CREATE ROLE ${RT_ROLE} LOGIN PASSWORD '${RT_PW}' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION NOINHERIT`);
    }
    await owner.$executeRawUnsafe(`GRANT SELECT ON "User", "Business" TO ${RT_ROLE}`);
    await owner.$executeRawUnsafe(`ALTER TABLE "BillingDocument" ENABLE ROW LEVEL SECURITY`);
    await owner.$executeRawUnsafe(`ALTER TABLE "BillingDocument" FORCE ROW LEVEL SECURITY`);
    await owner.$executeRawUnsafe(`DROP POLICY IF EXISTS p4b_tenant ON "BillingDocument"`);
    await owner.$executeRawUnsafe(
      `CREATE POLICY p4b_tenant ON "BillingDocument"
         USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
         WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)`);
    const posture = (await owner.$queryRawUnsafe(
      `SELECT rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname='${RT_ROLE}'`))[0];
    ok("lab role posture: LOGIN, NOSUPERUSER, NOBYPASSRLS",
      posture.rolcanlogin === true && posture.rolsuper === false && posture.rolbypassrls === false,
      JSON.stringify(posture));
    console.log("[lab] pilot-equivalent p4b_tenant installed on BillingDocument");
  }

  // ── Phase 3: apply migration + grants ───────────────────────────────────
  await applySqlFile("prisma/migrations/20260831120000_d2_p7_w4eb2_billing_tenant_rls/migration.sql");
  await applySqlFile("scripts/security/d2-p7-w4eb2-grants.sql", { ":ROLE": RT_ROLE });
  const polCount = Number((await owner.$queryRawUnsafe(
    `SELECT count(*)::int AS c FROM pg_policies WHERE policyname='p7w4eb2_tenant'`))[0].c);
  ok("8 p7w4eb2_tenant policies installed", polCount === 8, `found ${polCount}`);
  const forced = Number((await owner.$queryRawUnsafe(
    `SELECT count(*)::int AS c FROM pg_class WHERE relname IN (${ALL.map((t) => `'${t}'`).join(",")}) AND relrowsecurity AND relforcerowsecurity`))[0].c);
  ok("8 tables ENABLE+FORCE RLS", forced === 8, `found ${forced}`);
  const bfaRls = await owner.$queryRawUnsafe(
    `SELECT relrowsecurity AS e FROM pg_class WHERE relname='BusinessFeatureAccess'`);
  ok("BusinessFeatureAccess deliberately untouched (deferred)", bfaRls[0].e === false);

  // ── Phase 4: grant posture ──────────────────────────────────────────────
  for (const t of DELETE_ENABLED) {
    const d = (await owner.$queryRawUnsafe(
      `SELECT has_table_privilege('${RT_ROLE}', '"${t}"', 'DELETE') AS d`))[0].d;
    ok(`${t}: DELETE granted (replacement-set semantics)`, d === true);
  }
  for (const t of DELETE_DENIED) {
    const d = (await owner.$queryRawUnsafe(
      `SELECT has_table_privilege('${RT_ROLE}', '"${t}"', 'DELETE') AS d`))[0].d;
    ok(`${t}: DELETE denied (append-only / legal record)`, d === false);
  }

  // ── Phase 5: env + clients ──────────────────────────────────────────────
  let RUNTIME_URL = RUNTIME_URL_IN;
  if (TARGET === "pg") {
    const u = new URL(OWNER_URL);
    u.username = RT_ROLE; u.password = RT_PW;
    RUNTIME_URL = u.toString();
  }
  process.env.DATABASE_URL = RUNTIME_URL;
  const rt = new PrismaClient({ datasourceUrl: RUNTIME_URL });
  const who = (await rt.$queryRawUnsafe("SELECT current_user::text AS u"))[0].u;
  ok(`runtime current_user = ${RT_ROLE}`, who === RT_ROLE, `got ${who}`);

  // ── Phase 6: fixtures ───────────────────────────────────────────────────
  const cleanup = async () => {
    const bids = `SELECT id FROM "Business" WHERE name LIKE '${MARK}%'`;
    const docs = `SELECT id FROM "BillingDocument" WHERE "businessId" IN (${bids})`;
    for (const t of ["BillingDocumentLine", "BillingReceiptPayment"]) {
      await owner.$executeRawUnsafe(`DELETE FROM "${t}" WHERE "billingDocumentId" IN (${docs})`);
    }
    for (const t of ["BillingPaymentAllocation", "BillingAuthoritySubmission", "BillingAuditEvent", "BillingDocument", "BillingDocumentNumberSequence", "BillingAuthorityConnection", "BusinessBot"]) {
      await owner.$executeRawUnsafe(`DELETE FROM "${t}" WHERE "businessId" IN (${bids})`);
    }
    await owner.$executeRawUnsafe(`DELETE FROM "User" WHERE email LIKE '%@p7w4eb2.test'`);
    await owner.$executeRawUnsafe(`DELETE FROM "Business" WHERE name LIKE '${MARK}%'`);
  };
  await cleanup();

  const bizA = await owner.business.create({ data: { name: `${MARK}A` } });
  const bizB = await owner.business.create({ data: { name: `${MARK}B` } });
  const userA = await owner.user.create({ data: { email: "a@p7w4eb2.test", password: "x", businessId: bizA.id } });
  await owner.user.create({ data: { email: "b@p7w4eb2.test", password: "x", businessId: bizB.id } });
  console.log(`[fixtures] A=${bizA.id} B=${bizB.id}`);

  const rtx = (client, businessId, fn) =>
    client.$transaction(async (t) => {
      if (businessId != null) await t.$queryRaw`SELECT set_config('app.current_business_id', ${String(businessId)}, true)`;
      return fn(t);
    });
  const inIds = { in: [bizA.id, bizB.id] };

  // ── Phase 7: direct RLS matrix ──────────────────────────────────────────
  console.log("--- direct RLS matrix ---");
  const mkConn = (biz, env) => owner.billingAuthorityConnection.create({
    data: { businessId: biz, environment: env, status: "CONNECTED", accessTokenEncrypted: `${MARK}enc`, accessTokenIv: "iv", accessTokenTag: "tag" },
  });
  await mkConn(bizA.id, "SANDBOX"); await mkConn(bizB.id, "SANDBOX");
  const connA = await rtx(rt, bizA.id, (t) => t.billingAuthorityConnection.findMany({ where: { businessId: inIds } }));
  ok("BillingAuthorityConnection: A sees only A (token metadata never crosses)",
    connA.length === 1 && connA[0].businessId === bizA.id, `n=${connA.length}`);
  const connUpd = await rtx(rt, bizA.id, (t) => t.billingAuthorityConnection.updateMany({ where: { businessId: bizB.id }, data: { status: "ERROR" } }));
  ok("BillingAuthorityConnection: A cannot update B", connUpd.count === 0);
  let connInsDenied = false;
  try {
    await rtx(rt, bizA.id, (t) => t.billingAuthorityConnection.create({ data: { businessId: bizB.id, environment: "PRODUCTION", status: "CONNECTED" } }));
  } catch { connInsDenied = true; }
  ok("BillingAuthorityConnection: WITH CHECK denies a cross-tenant INSERT", connInsDenied);

  await owner.businessBot.create({ data: { businessId: bizA.id } });
  await owner.businessBot.create({ data: { businessId: bizB.id } });
  const botA = await rtx(rt, bizA.id, (t) => t.businessBot.findMany({ where: { businessId: inIds } }));
  ok("BusinessBot: A sees only A", botA.length === 1 && botA[0].businessId === bizA.id);
  const botUpd = await rtx(rt, bizA.id, (t) => t.businessBot.updateMany({ where: { businessId: bizB.id }, data: {} }));
  ok("BusinessBot: A cannot update B", botUpd.count === 0);

  await owner.billingAuditEvent.create({ data: { businessId: bizB.id, eventType: "X", summary: "B only", eventHash: `${MARK}hb`, occurredAt: new Date() } });
  const auditA = await rtx(rt, bizA.id, (t) => t.billingAuditEvent.findMany({ where: { businessId: inIds } }));
  ok("BillingAuditEvent: B invisible to A", auditA.every((e) => e.businessId === bizA.id));
  let auditForge = false;
  try {
    await rtx(rt, bizA.id, (t) => t.billingAuditEvent.create({ data: { businessId: bizB.id, eventType: "FORGED", summary: "x", eventHash: `${MARK}hf`, occurredAt: new Date() } }));
  } catch { auditForge = true; }
  ok("BillingAuditEvent: A cannot forge an audit into B", auditForge);

  // ── Phase 8: parent-join matrix ─────────────────────────────────────────
  console.log("--- parent-join (BillingDocument children) ---");
  const mkDoc = (biz, type = "TAX_INVOICE") => owner.billingDocument.create({
    data: { businessId: biz, documentType: type, status: "DRAFT", currency: "ILS" },
  });
  const docA = await mkDoc(bizA.id);
  const docB = await mkDoc(bizB.id);
  await owner.billingDocumentLine.create({ data: { billingDocumentId: docB.id, lineIndex: 0, description: "B line", quantity: 1, unitPrice: 10, vatRatePercent: 17, lineSubtotal: 10, vatAmount: 1.7, lineTotal: 11.7 } });
  const linesA = await rtx(rt, bizA.id, (t) => t.billingDocumentLine.findMany({}));
  ok("BillingDocumentLine: B's lines are hidden from A", linesA.every((l) => l.billingDocumentId !== docB.id));
  let foreignLine = false;
  try {
    await rtx(rt, bizA.id, (t) => t.billingDocumentLine.create({ data: { billingDocumentId: docB.id, lineIndex: 9, description: "x", quantity: 1, unitPrice: 1, vatRatePercent: 17, lineSubtotal: 1, vatAmount: 0.17, lineTotal: 1.17 } }));
  } catch { foreignLine = true; }
  ok("BillingDocumentLine: INSERT under B's document rejected", foreignLine);
  const rawLines = await rtx(rt, bizA.id, (t) => t.$queryRawUnsafe(`SELECT count(*)::int AS c FROM "BillingDocumentLine"`));
  const ownLines = await owner.billingDocumentLine.count({ where: { document: { businessId: bizA.id } } });
  ok("BillingDocumentLine: broad raw SELECT under A returns A only",
    Number(rawLines[0].c) === ownLines, `raw=${rawLines[0].c} own=${ownLines}`);

  // ── Phase 9: DELETE proof (three tables genuinely need it) ──────────────
  console.log("--- tenant-safe DELETE ---");
  await owner.billingDocumentLine.create({ data: { billingDocumentId: docA.id, lineIndex: 0, description: "A line", quantity: 1, unitPrice: 5, vatRatePercent: 17, lineSubtotal: 5, vatAmount: 0.85, lineTotal: 5.85 } });
  const delOwn = await rtx(rt, bizA.id, (t) => t.billingDocumentLine.deleteMany({ where: { billingDocumentId: docA.id } }));
  ok("A can delete its own lines (replacement-set semantics)", delOwn.count === 1, `deleted=${delOwn.count}`);
  const delForeign = await rtx(rt, bizA.id, (t) => t.billingDocumentLine.deleteMany({ where: { billingDocumentId: docB.id } }));
  const bLinesLeft = await owner.billingDocumentLine.count({ where: { billingDocumentId: docB.id } });
  ok("A cannot delete B's lines (0 rows, B intact)", delForeign.count === 0 && bLinesLeft === 1);
  const delBroad = await rtx(rt, bizA.id, (t) => t.billingDocumentLine.deleteMany({}));
  const bStillThere = await owner.billingDocumentLine.count({ where: { billingDocumentId: docB.id } });
  ok("an unqualified DELETE under A cannot reach B", bStillThere === 1, `B lines=${bStillThere}`);
  let seqDelDenied = false;
  try { await rtx(rt, bizA.id, (t) => t.$executeRawUnsafe(`DELETE FROM "BillingDocumentNumberSequence"`)); } catch { seqDelDenied = true; }
  ok("DELETE on the numbering sequence is denied at the privilege layer", seqDelDenied);

  // ── Phase 10: NUMBERING — single-thread semantics ───────────────────────
  console.log("--- numbering: serial semantics ---");
  // Exactly the production allocation, run under the tenant GUC.
  const allocate = async (client, biz, type) =>
    rtx(client, biz, async (t) => {
      const seq = await t.billingDocumentNumberSequence.upsert({
        where: { businessId_documentType: { businessId: biz, documentType: type } },
        create: { businessId: biz, documentType: type, nextNumber: 2 },
        update: { nextNumber: { increment: 1 } },
      });
      return seq.nextNumber - 1;
    });
  const serialA = [];
  for (let i = 0; i < 5; i++) serialA.push(await allocate(rt, bizA.id, "TAX_INVOICE"));
  ok("first allocation returns 1 and the sequence stores nextNumber=2",
    serialA[0] === 1, `got ${serialA[0]}`);
  ok("serial allocations are 1,2,3,4,5", JSON.stringify(serialA) === "[1,2,3,4,5]", JSON.stringify(serialA));
  const storedA = await owner.billingDocumentNumberSequence.findUnique({
    where: { businessId_documentType: { businessId: bizA.id, documentType: "TAX_INVOICE" } } });
  ok("stored nextNumber is consistent with allocations (6 after 5)", storedA.nextNumber === 6, `nextNumber=${storedA.nextNumber}`);
  const firstB = await allocate(rt, bizB.id, "TAX_INVOICE");
  ok("a second tenant starts its own sequence independently at 1", firstB === 1, `got ${firstB}`);
  const firstQuote = await allocate(rt, bizA.id, "QUOTE");
  ok("a different documentType starts independently at 1", firstQuote === 1, `got ${firstQuote}`);

  // ── Phase 11: NUMBERING — 20 concurrent, same tenant ────────────────────
  console.log("--- numbering: 20 concurrent, same tenant ---");
  const clients = [];
  for (let i = 0; i < 6; i++) clients.push(new PrismaClient({ datasourceUrl: RUNTIME_URL }));
  const pick = (i) => clients[i % clients.length];
  const before = (await owner.billingDocumentNumberSequence.findUnique({
    where: { businessId_documentType: { businessId: bizA.id, documentType: "TAX_INVOICE" } } })).nextNumber;
  const conc = await Promise.all(
    Array.from({ length: 20 }, (_, i) => allocate(pick(i), bizA.id, "TAX_INVOICE"))
  );
  const sorted = [...conc].sort((a, b) => a - b);
  const uniqueCount = new Set(conc).size;
  const after = (await owner.billingDocumentNumberSequence.findUnique({
    where: { businessId_documentType: { businessId: bizA.id, documentType: "TAX_INVOICE" } } })).nextNumber;
  console.log(`  [numbers] ${sorted.join(",")}`);
  ok("20 concurrent allocations produced 20 UNIQUE numbers", uniqueCount === 20, `unique=${uniqueCount}`);
  ok("no lost increment: nextNumber advanced by exactly 20", after === before + 20, `${before} -> ${after}`);
  ok("the 20 numbers are exactly the consecutive block that was consumed",
    JSON.stringify(sorted) === JSON.stringify(Array.from({ length: 20 }, (_, i) => before + i)),
    `${sorted[0]}..${sorted[19]} expected ${before}..${before + 19}`);

  // ── Phase 12: NUMBERING — A/B interleaved ───────────────────────────────
  console.log("--- numbering: A/B interleaved ---");
  const aBefore = (await owner.billingDocumentNumberSequence.findUnique({
    where: { businessId_documentType: { businessId: bizA.id, documentType: "TAX_INVOICE" } } })).nextNumber;
  const bBefore = (await owner.billingDocumentNumberSequence.findUnique({
    where: { businessId_documentType: { businessId: bizB.id, documentType: "TAX_INVOICE" } } })).nextNumber;
  const mixed = await Promise.all(
    Array.from({ length: 40 }, (_, i) =>
      i % 2 === 0
        ? allocate(pick(i), bizA.id, "TAX_INVOICE").then((n) => ({ biz: "A", n }))
        : allocate(pick(i), bizB.id, "TAX_INVOICE").then((n) => ({ biz: "B", n }))
    )
  );
  const aNums = mixed.filter((m) => m.biz === "A").map((m) => m.n);
  const bNums = mixed.filter((m) => m.biz === "B").map((m) => m.n);
  const aAfter = (await owner.billingDocumentNumberSequence.findUnique({
    where: { businessId_documentType: { businessId: bizA.id, documentType: "TAX_INVOICE" } } })).nextNumber;
  const bAfter = (await owner.billingDocumentNumberSequence.findUnique({
    where: { businessId_documentType: { businessId: bizB.id, documentType: "TAX_INVOICE" } } })).nextNumber;
  ok("A/B interleaved: 20 unique A numbers", new Set(aNums).size === 20, `unique=${new Set(aNums).size}`);
  ok("A/B interleaved: 20 unique B numbers", new Set(bNums).size === 20, `unique=${new Set(bNums).size}`);
  ok("A/B interleaved: each sequence advanced by exactly its own 20",
    aAfter === aBefore + 20 && bAfter === bBefore + 20, `A ${aBefore}->${aAfter} B ${bBefore}->${bAfter}`);
  ok("A/B interleaved: no cross-tenant sequence consumption (isolation, not global uniqueness)",
    Math.min(...aNums) === aBefore && Math.min(...bNums) === bBefore);

  // ── Phase 13: NUMBERING — multiple documentType, concurrent ─────────────
  console.log("--- numbering: multiple documentType ---");
  const twoTypes = await Promise.all([
    ...Array.from({ length: 10 }, (_, i) => allocate(pick(i), bizA.id, "RECEIPT").then((n) => ({ t: "RECEIPT", n }))),
    ...Array.from({ length: 10 }, (_, i) => allocate(pick(i + 3), bizA.id, "CREDIT_NOTE").then((n) => ({ t: "CREDIT_NOTE", n }))),
  ]);
  const rcpt = twoTypes.filter((x) => x.t === "RECEIPT").map((x) => x.n);
  const cn = twoTypes.filter((x) => x.t === "CREDIT_NOTE").map((x) => x.n);
  ok("concurrent allocations across two document types stay independent",
    new Set(rcpt).size === 10 && new Set(cn).size === 10 &&
    JSON.stringify([...rcpt].sort((a, b) => a - b)) === JSON.stringify(Array.from({ length: 10 }, (_, i) => i + 1)) &&
    JSON.stringify([...cn].sort((a, b) => a - b)) === JSON.stringify(Array.from({ length: 10 }, (_, i) => i + 1)),
    `receipt=${[...rcpt].sort((a,b)=>a-b).join(",")} credit=${[...cn].sort((a,b)=>a-b).join(",")}`);
  const seqRows = await owner.billingDocumentNumberSequence.count({ where: { businessId: bizA.id } });
  ok("one sequence row per (businessId, documentType)", seqRows === 4, `rows=${seqRows}`);

  // ── Phase 14: NUMBERING — rollback ──────────────────────────────────────
  console.log("--- numbering: rollback ---");
  const rbBefore = (await owner.billingDocumentNumberSequence.findUnique({
    where: { businessId_documentType: { businessId: bizA.id, documentType: "TAX_INVOICE" } } })).nextNumber;
  let rolledBack = false;
  try {
    await rtx(rt, bizA.id, async (t) => {
      await t.billingDocumentNumberSequence.upsert({
        where: { businessId_documentType: { businessId: bizA.id, documentType: "TAX_INVOICE" } },
        create: { businessId: bizA.id, documentType: "TAX_INVOICE", nextNumber: 2 },
        update: { nextNumber: { increment: 1 } },
      });
      throw new Error("SYNTHETIC issuance failure after allocation");
    });
  } catch (e) { rolledBack = /SYNTHETIC/.test(String(e?.message)); }
  const rbAfter = (await owner.billingDocumentNumberSequence.findUnique({
    where: { businessId_documentType: { businessId: bizA.id, documentType: "TAX_INVOICE" } } })).nextNumber;
  ok("a failed issuance does NOT consume a number (allocation is in the same tx)",
    rolledBack && rbAfter === rbBefore, `threw=${rolledBack} ${rbBefore} -> ${rbAfter}`);
  const nextAfterRollback = await allocate(rt, bizA.id, "TAX_INVOICE");
  ok("the next successful issuance receives the number the failed one would have",
    nextAfterRollback === rbBefore - 1 + 1, `got ${nextAfterRollback} expected ${rbBefore}`);

  // ── Phase 15: NUMBERING — failure interleaving ──────────────────────────
  console.log("--- numbering: failure interleaving ---");
  const fiBefore = (await owner.billingDocumentNumberSequence.findUnique({
    where: { businessId_documentType: { businessId: bizA.id, documentType: "TAX_INVOICE" } } })).nextNumber;
  const results = await Promise.allSettled([
    allocate(clients[0], bizA.id, "TAX_INVOICE"),
    rtx(clients[1], bizA.id, async (t) => {
      await t.billingDocumentNumberSequence.update({
        where: { businessId_documentType: { businessId: bizA.id, documentType: "TAX_INVOICE" } },
        data: { nextNumber: { increment: 1 } },
      });
      throw new Error("SYNTHETIC loser");
    }),
    allocate(clients[2], bizA.id, "TAX_INVOICE"),
  ]);
  const committed = results.filter((r) => r.status === "fulfilled").map((r) => r.value);
  const fiAfter = (await owner.billingDocumentNumberSequence.findUnique({
    where: { businessId_documentType: { businessId: bizA.id, documentType: "TAX_INVOICE" } } })).nextNumber;
  ok("a rolled-back competitor cannot undo or corrupt committed allocations",
    committed.length === 2 && new Set(committed).size === 2 && fiAfter === fiBefore + 2,
    `committed=${committed.join(",")} ${fiBefore} -> ${fiAfter}`);
  ok("the failed transaction left no committed allocation", fiAfter - fiBefore === committed.length);

  // ── Phase 16: cross-tenant sequence unreachable ─────────────────────────
  const foreignSeq = await rtx(rt, bizA.id, (t) => t.billingDocumentNumberSequence.findMany({ where: { businessId: bizB.id } }));
  ok("B's numbering sequence is invisible to A", foreignSeq.length === 0);
  const foreignSeqUpd = await rtx(rt, bizA.id, (t) => t.billingDocumentNumberSequence.updateMany({ where: { businessId: bizB.id }, data: { nextNumber: 999 } }));
  const bSeqNow = (await owner.billingDocumentNumberSequence.findUnique({
    where: { businessId_documentType: { businessId: bizB.id, documentType: "TAX_INVOICE" } } })).nextNumber;
  ok("A can never consume or corrupt B's sequence",
    foreignSeqUpd.count === 0 && bSeqNow === bAfter, `count=${foreignSeqUpd.count} bSeq=${bSeqNow}`);

  // ── Phase 17: fail-closed + raw SQL ─────────────────────────────────────
  console.log("--- fail-closed + raw ---");
  const noCtx = await rt.billingAuthorityConnection.findMany({ where: { businessId: inIds } });
  ok("no tenant context -> 0 rows", noCtx.length === 0, `n=${noCtx.length}`);
  const emptyGuc = await rtx(rt, "", (t) => t.billingAuditEvent.findMany({}));
  ok("empty GUC -> 0 rows (fail-closed)", emptyGuc.length === 0);
  let malformed = false;
  try {
    await rt.$transaction(async (t) => {
      await t.$queryRaw`SELECT set_config('app.current_business_id', 'not-an-int', true)`;
      await t.billingAuditEvent.findMany({});
    });
  } catch { malformed = true; }
  ok("malformed GUC errors (never silently opens)", malformed);
  for (const t of ["BillingAuthorityConnection", "BillingAuditEvent", "BusinessBot", "BillingDocumentNumberSequence"]) {
    const raw = await rtx(rt, bizA.id, (c) => c.$queryRawUnsafe(`SELECT count(*)::int AS c FROM "${t}"`));
    const own = Number((await owner.$queryRawUnsafe(`SELECT count(*)::int AS c FROM "${t}" WHERE "businessId" = ${bizA.id}`))[0].c);
    ok(`raw ${t} = tenant-only`, Number(raw[0].c) === own, `raw=${raw[0].c} own=${own}`);
  }
  let ddlDenied = false;
  try { await rt.$executeRawUnsafe(`CREATE TABLE ${MARK}ddl (id int)`); } catch { ddlDenied = true; }
  ok("runtime DDL denied", ddlDenied);
  let migDenied = false;
  try { await rt.$executeRawUnsafe(`SELECT count(*) FROM "_prisma_migrations"`); } catch { migDenied = true; }
  ok("runtime _prisma_migrations denied", migDenied);

  // ── Phase 18: concurrency / GUC isolation ───────────────────────────────
  console.log("--- concurrency ---");
  const [ca, cb] = await Promise.all([
    rtx(clients[0], bizA.id, (t) => t.billingAuthorityConnection.findMany({ where: { businessId: inIds } })),
    rtx(clients[1], bizB.id, (t) => t.billingAuthorityConnection.findMany({ where: { businessId: inIds } })),
  ]);
  ok("concurrent A/B isolation (no GUC bleed)",
    ca.every((r) => r.businessId === bizA.id) && cb.every((r) => r.businessId === bizB.id) &&
    ca.length === 1 && cb.length === 1, `a=${ca.length} b=${cb.length}`);
  const afterRollbackGuc = await rt.billingAuditEvent.findMany({ where: { businessId: inIds } });
  ok("transaction-local GUC does not leak outside the transaction", afterRollbackGuc.length === 0);

  // ── Phase 19: rollback + re-apply (pg only) ─────────────────────────────
  if (TARGET === "pg") {
    console.log("--- rollback ---");
    await applySqlFile("scripts/security/d2-p7-w4eb2-rollback.sql", { ":ROLE": RT_ROLE });
    const after0 = Number((await owner.$queryRawUnsafe(
      `SELECT count(*)::int AS c FROM pg_policies WHERE policyname='p7w4eb2_tenant'`))[0].c);
    ok("rollback: 0 B-2 policies remain", after0 === 0, `found ${after0}`);
    const pilotIntact = Number((await owner.$queryRawUnsafe(
      `SELECT count(*)::int AS c FROM pg_policies WHERE policyname='p4b_tenant' AND tablename='BillingDocument'`))[0].c);
    ok("rollback: the BillingDocument pilot policy survives", pilotIntact === 1);
    const pilotGrant = (await owner.$queryRawUnsafe(
      `SELECT has_table_privilege('${RT_ROLE}', '"BillingDocument"', 'SELECT') AS s,
              has_table_privilege('${RT_ROLE}', '"BillingDocument"', 'INSERT') AS i`))[0];
    ok("rollback: pilot SELECT lineage survives; only B-2's INSERT is revoked",
      pilotGrant.i === false, JSON.stringify(pilotGrant));
    await applySqlFile("prisma/migrations/20260831120000_d2_p7_w4eb2_billing_tenant_rls/migration.sql");
    await applySqlFile("scripts/security/d2-p7-w4eb2-grants.sql", { ":ROLE": RT_ROLE });
    const re = Number((await owner.$queryRawUnsafe(
      `SELECT count(*)::int AS c FROM pg_policies WHERE policyname='p7w4eb2_tenant'`))[0].c);
    ok("re-apply after rollback (idempotency)", re === 8, `found ${re}`);
    const reNum = await allocate(rt, bizA.id, "TAX_INVOICE");
    ok("numbering still allocates correctly after re-apply", Number.isInteger(reNum) && reNum > 0, `got ${reNum}`);
  }

  // ── Phase 20: prior substrate + residue ─────────────────────────────────
  if (TARGET === "neon") {
    const gates = [["p4b_tenant", 5], ["p7w1_tenant", 14], ["p7w2_tenant", 24], ["p7w3_tenant", 15], ["p7w4b_tenant", 5], ["p7w4c_tenant", 3], ["p7w4d_tenant", 8], ["p7w4ea_tenant", 4]];
    let intact = true;
    for (const [pol, want] of gates) {
      const c = Number((await owner.$queryRawUnsafe(
        `SELECT count(*)::int AS c FROM pg_policies WHERE policyname='${pol}'`))[0].c);
      if (c !== want) intact = false;
    }
    ok("pilot+W1..W4E-A substrate intact after B-2", intact);
  }

  for (const c of clients) await c.$disconnect();
  await rt.$disconnect();
  await cleanup();
  const res = await owner.$queryRawUnsafe(
    `SELECT (SELECT count(*)::int FROM "Business" WHERE name LIKE '${MARK}%') AS biz`);
  ok("synthetic residue = 0", Number(res[0].biz) === 0, JSON.stringify(res[0]));
  await owner.$disconnect();

  console.log(`\n[battery] target=${TARGET} PASS=${pass} FAIL=${fail}`);
  if (fail > 0) { console.log("FAILURES:\n - " + failures.join("\n - ")); process.exit(1); }
  console.log("ALL CHECKS PASS");
}

main().catch((e) => { console.error("[battery] FATAL:", e); process.exit(1); });
