/**
 * Approval safety — DB-backed tenant-isolation battery (ephemeral PostgreSQL only).
 *
 *   DIRECT_URL=postgresql://<owner>@localhost:5432/dubiz_apsafe npx tsx .authority-approval-tenant/battery.mts
 *
 * Proves, against REAL Postgres FORCE RLS and the application's REAL runtime
 * grants (prisma/migrations/20260831120000_d2_p7_w4eb2_billing_tenant_rls +
 * scripts/security/d2-p7-w4eb2-grants.sql), using the REAL app code
 * (billingTenantTx → transition service → executeAuthorityApproval):
 *   - FORCE RLS effective for the runtime role (NOBYPASSRLS);
 *   - business A cannot reserve / mark uncertain / approve business B's submission;
 *   - a cross-tenant execution performs ZERO Approval POSTs;
 *   - compare-and-set ownership holds on real Postgres concurrency, tenant-scoped;
 *   - audit evidence cannot be written or read across the tenant boundary, and
 *     the runtime role cannot UPDATE/DELETE audit rows.
 * The Approval HTTP call is a counting fake: ZERO network, ZERO ITA, ZERO secrets.
 *
 * Safety guard: refuses any DIRECT_URL that is not localhost:5432/dubiz_apsafe,
 * so it can never run against the OAuth lab or Production.
 *
 * APSAFE_NEGATIVE=bypassrls grants BYPASSRLS to the runtime role: the battery
 * MUST then fail (CI negative proof that these checks really depend on RLS).
 */
import { readFileSync } from "node:fs";
import {
  BillingAuthorityEnvironment,
  BillingAuthoritySubmissionStatus,
  BillingDocumentStatus,
  BillingDocumentType,
  PrismaClient,
} from "@prisma/client";

const RT_ROLE = "apsafe_runtime";
const RT_PW = "apsafe_ci_synthetic_pw";
const MARK = "apsafe-";
const NEGATIVE = process.env.APSAFE_NEGATIVE ?? "";

let pass = 0;
let fail = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail: unknown = ""): void {
  if (cond) { pass += 1; console.log(`  [PASS] ${name}`); }
  else { fail += 1; failures.push(name); console.log(`  [FAIL] ${name} — ${typeof detail === "string" ? detail : JSON.stringify(detail)}`); }
}
async function rejects(fn: () => Promise<unknown>): Promise<{ threw: boolean; name: string; message: string }> {
  try { await fn(); return { threw: false, name: "", message: "" }; }
  catch (e) {
    // Full text is kept for matching; Prisma prefixes a long invocation preamble.
    const full = String((e as Error)?.message ?? e);
    const reason = full.match(/(row-level security[^\n]*|permission denied[^\n]*|not found[^\n]*|forbidden[^\n]*)/i)?.[0] ?? full.slice(-160);
    return { threw: true, name: (e as Error)?.name ?? "", message: `${reason} | ${full.length > 4000 ? full.slice(0, 4000) : full}`.replace(/\s+/g, " ") };
  }
}

function splitSql(sql: string): string[] {
  const out: string[] = [];
  let buf = "";
  let inDollar = false;
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

function snapshot(docId: number, businessId: number) {
  return {
    schemaVersion: 1, issuedAt: "2026-06-15T10:00:00.000Z",
    document: { id: docId, type: "TAX_INVOICE", status: "ISSUED", number: docId, numberFormatted: String(docId).padStart(6, "0"), currency: "ILS", allocationNumber: null, referenceDocumentId: null },
    issuer: { id: businessId, name: "Issuer", legalName: "Issuer", taxId: "515000123", vatRegistration: "515000123", address: null, phone: null, email: null, logoUrl: null, bankDetails: null },
    customer: { id: 7, name: "Customer", legalName: null, taxId: "514000000", phone: null, email: null, city: "Tel Aviv", address: null },
    lines: [{ lineIndex: 0, description: "service", quantity: "1.0000", unitPrice: "10000.0000", vatRatePercent: "18.00", lineSubtotal: "10000.00", vatAmount: "1800.00", lineTotal: "11800.00" }],
    totals: { subtotal: "10000.00", vat: "1800.00", total: "11800.00" },
    tax: { currency: "ILS", defaultVatRate: null, vatMode: "EXCLUSIVE" },
    metadata: { locale: "he-IL", timezone: "Asia/Jerusalem", actorUserId: 1, source: "manual" },
    pdfTemplateStyle: "CLASSIC", extensions: {},
  };
}

async function main(): Promise<void> {
  // ── Guard: ephemeral PostgreSQL only ──────────────────────────────────────
  const OWNER_URL = process.env.DIRECT_URL ?? "";
  const ou = new URL(OWNER_URL);
  if (!["localhost", "127.0.0.1"].includes(ou.hostname) || ou.port !== "5432" || ou.pathname !== "/dubiz_apsafe") {
    throw new Error("DENY: DIRECT_URL must be the ephemeral localhost:5432/dubiz_apsafe database");
  }
  const owner = new PrismaClient({ datasourceUrl: OWNER_URL });
  const applySqlFile = async (path: string, repl: Record<string, string> = {}) => {
    let sql = readFileSync(path, "utf8");
    for (const [k, v] of Object.entries(repl)) sql = sql.replaceAll(k, v);
    for (const stmt of splitSql(sql)) await owner.$executeRawUnsafe(stmt);
  };

  // ── Substrate: runtime role + the application's real RLS migration/grants ─
  const exists = Number((await owner.$queryRawUnsafe<{ c: number }[]>(`SELECT count(*)::int AS c FROM pg_roles WHERE rolname='${RT_ROLE}'`))[0].c) > 0;
  if (!exists) {
    await owner.$executeRawUnsafe(`CREATE ROLE ${RT_ROLE} LOGIN PASSWORD '${RT_PW}' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION NOINHERIT`);
  }
  if (NEGATIVE === "bypassrls") {
    await owner.$executeRawUnsafe(`ALTER ROLE ${RT_ROLE} BYPASSRLS`);
    console.log("[negative] runtime role granted BYPASSRLS — this run MUST fail");
  }
  await owner.$executeRawUnsafe(`GRANT SELECT ON "User", "Business" TO ${RT_ROLE}`);
  // Pilot-equivalent parent policy on BillingDocument (same shape as the
  // billing RLS battery), so document reads are tenant-scoped too.
  await owner.$executeRawUnsafe(`ALTER TABLE "BillingDocument" ENABLE ROW LEVEL SECURITY`);
  await owner.$executeRawUnsafe(`ALTER TABLE "BillingDocument" FORCE ROW LEVEL SECURITY`);
  await owner.$executeRawUnsafe(`DROP POLICY IF EXISTS p4b_tenant ON "BillingDocument"`);
  await owner.$executeRawUnsafe(
    `CREATE POLICY p4b_tenant ON "BillingDocument"
       USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
       WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)`);
  await applySqlFile("prisma/migrations/20260831120000_d2_p7_w4eb2_billing_tenant_rls/migration.sql");
  await applySqlFile("scripts/security/d2-p7-w4eb2-grants.sql", { ":ROLE": RT_ROLE });

  console.log("--- RLS / grant posture ---");
  const posture = (await owner.$queryRawUnsafe<{ rolsuper: boolean; rolbypassrls: boolean }[]>(`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname='${RT_ROLE}'`))[0];
  ok("runtime role NOSUPERUSER + NOBYPASSRLS", posture.rolsuper === false && posture.rolbypassrls === false, posture);
  for (const t of ["BillingAuthoritySubmission", "BillingAuditEvent", "BillingDocument"]) {
    const r = (await owner.$queryRawUnsafe<{ e: boolean; f: boolean }[]>(`SELECT relrowsecurity AS e, relforcerowsecurity AS f FROM pg_class WHERE relname='${t}'`))[0];
    ok(`${t}: ENABLE + FORCE RLS`, r.e === true && r.f === true, r);
  }
  for (const [t, priv, want] of [["BillingAuditEvent", "UPDATE", false], ["BillingAuditEvent", "DELETE", false], ["BillingAuthoritySubmission", "DELETE", false], ["BillingAuthoritySubmission", "UPDATE", true]] as const) {
    const has = (await owner.$queryRawUnsafe<{ h: boolean }[]>(`SELECT has_table_privilege('${RT_ROLE}', '"${t}"', '${priv}') AS h`))[0].h;
    ok(`${t}: runtime ${priv} ${want ? "granted" : "denied"}`, has === want);
  }

  // ── Fixtures (owner) ──────────────────────────────────────────────────────
  const bizA = await owner.business.create({ data: { name: `${MARK}A` } });
  const bizB = await owner.business.create({ data: { name: `${MARK}B` } });
  const userA = await owner.user.create({ data: { email: "a@apsafe.test", password: "x", businessId: bizA.id } });
  const userB = await owner.user.create({ data: { email: "b@apsafe.test", password: "x", businessId: bizB.id } });
  const mkDoc = async (businessId: number) => {
    const d = await owner.billingDocument.create({
      data: { businessId, documentType: BillingDocumentType.TAX_INVOICE, status: BillingDocumentStatus.ISSUED, lockedAt: new Date(), legalSnapshotHash: "legal-hash", issuedAt: new Date() },
    });
    await owner.billingDocument.update({ where: { id: d.id }, data: { issuedSnapshot: snapshot(d.id, businessId) } });
    const s = await owner.billingAuthoritySubmission.create({ data: { businessId, billingDocumentId: d.id, status: BillingAuthoritySubmissionStatus.READY, legalSnapshotHash: "legal-hash" } });
    return { doc: d, sub: s };
  };
  const A1 = await mkDoc(bizA.id); // positive control
  const A2 = await mkDoc(bizA.id); // concurrency
  const A3 = await mkDoc(bizA.id); // approved + persist failure
  const B1 = await mkDoc(bizB.id); // cross-tenant target
  console.log(`[fixtures] A=${bizA.id} B=${bizB.id} docs A1=${A1.doc.id} A2=${A2.doc.id} A3=${A3.doc.id} B1=${B1.doc.id}`);
  const subOf = (id: number) => owner.billingAuthoritySubmission.findUniqueOrThrow({ where: { id } });
  const auditCount = (businessId: number) => owner.billingAuditEvent.count({ where: { businessId } });

  // ── Runtime: the app runs as the RLS-bound role ───────────────────────────
  const RUNTIME = new URL(OWNER_URL);
  RUNTIME.username = RT_ROLE;
  RUNTIME.password = RT_PW;
  process.env.DATABASE_URL = RUNTIME.toString();
  const { billingTenantTx } = await import("../lib/services/billing/billing-tenant-tx");
  const transitions = await import("../lib/services/billing/authority/billing-authority-transition.service");
  const exec = await import("../lib/services/billing/authority/billing-authority-submission-execution.service");
  const { prisma } = await import("../lib/prisma");
  const who = (await prisma.$queryRawUnsafe<{ u: string }[]>("SELECT current_user::text AS u"))[0].u;
  ok(`app prisma connects as ${RT_ROLE}`, who === RT_ROLE, who);

  const noCtx = await prisma.$transaction((t) => t.billingAuthoritySubmission.findMany({ where: { businessId: { in: [bizA.id, bizB.id] } } }));
  ok("no tenant context → runtime sees 0 submissions (FORCE RLS)", noCtx.length === 0, `n=${noCtx.length}`);
  const ctxA = await billingTenantTx(bizA.id, (t) => t.billingAuthoritySubmission.findMany({ where: { businessId: { in: [bizA.id, bizB.id] } } }));
  ok("context A → sees only A's 3 submissions", ctxA.length === 3 && ctxA.every((s) => s.businessId === bizA.id), `n=${ctxA.length}`);

  // Counting Approval transport (never the network).
  type Domain = Awaited<ReturnType<typeof exec.defaultSubmissionExecutionDeps.requestApproval>>;
  const counter = { posts: 0 };
  const APPROVED: Domain = { outcome: "approved", confirmationNumber: "20240718181618323199093572" };
  const UNCERTAIN: Domain = { outcome: "infrastructure_failure", classification: "TIMEOUT", message: "t", sendCertainty: "POSSIBLY_SENT", failureKind: "TRANSPORT", providerHttpStatus: null, providerErrorId: null, transportCode: null };
  const depsWith = (result: Domain, overrides: Partial<typeof exec.defaultSubmissionExecutionDeps> = {}, delayMs = 0) => ({
    ...exec.defaultSubmissionExecutionDeps,
    resolveEnvironment: () => BillingAuthorityEnvironment.SANDBOX,
    resolveRuntimeContext: async () => ({ ok: true as const, context: { accessToken: "SYNTHETIC", approvalConfig: { apiBaseUrl: "https://ita-api.taxes.gov.il/shaam/tsandbox", apiVersion: "v2", timeoutMs: 1000 }, accountingSoftwareNumber: "270901", connectionId: 1, environment: BillingAuthorityEnvironment.SANDBOX } }),
    buildPayload: () => ({ ok: true as const, payload: { invoice_id: "x", invoice_type: 305, vat_number: 515000123, invoice_reference_number: "1", customer_vat_number: 514000000, invoice_date: "2026-06-15", invoice_issuance_date: "2026-06-15", accounting_software_number: 270901, amount_before_discount: 10000, discount: 0, payment_amount: 10000, vat_amount: 1800, payment_amount_including_vat: 11800 } as never }),
    requestApproval: async () => { counter.posts += 1; if (delayMs) await new Promise((r) => setTimeout(r, delayMs)); return result; },
    reportSafetyEvent: () => undefined,
    ...overrides,
  });

  // ── 1. cross-tenant reserve ───────────────────────────────────────────────
  console.log("--- cross-tenant reserve ---");
  const auditB0 = await auditCount(bizB.id);
  let r = await rejects(() => billingTenantTx(bizA.id, (tx) => transitions.recordAuthoritySubmissionAttemptTx(tx, { businessId: bizA.id, billingDocumentId: B1.doc.id, actorUserId: userA.id })));
  ok("A reserving B's document (own businessId) → refused", r.threw, r);
  r = await rejects(() => billingTenantTx(bizA.id, (tx) => transitions.recordAuthoritySubmissionAttemptTx(tx, { businessId: bizB.id, billingDocumentId: B1.doc.id, actorUserId: userA.id })));
  ok("A context with spoofed businessId=B → refused (RLS hides the row)", r.threw, r);
  const rawReserve = await billingTenantTx(bizA.id, (tx) => tx.billingAuthoritySubmission.updateMany({ where: { id: B1.sub.id, status: BillingAuthoritySubmissionStatus.READY }, data: { status: BillingAuthoritySubmissionStatus.SUBMITTED } }));
  ok("raw CAS updateMany on B's row from A context → count 0", rawReserve.count === 0, rawReserve);
  ok("B's submission still READY, retryCount 0", (await subOf(B1.sub.id)).status === "READY" && (await subOf(B1.sub.id)).retryCount === 0);

  // ── 2. cross-tenant uncertain mark ────────────────────────────────────────
  console.log("--- cross-tenant uncertain mark ---");
  await owner.billingAuthoritySubmission.update({ where: { id: B1.sub.id }, data: { status: BillingAuthoritySubmissionStatus.SUBMITTED } });
  const evidence = { sendCertainty: "POSSIBLY_SENT" as const, classification: null, failureKind: null, providerHttpStatus: null, providerErrorId: null, transportCode: null, receivedAllocationNumber: null };
  for (const asBiz of [bizA.id, bizB.id]) {
    r = await rejects(() => billingTenantTx(bizA.id, (tx) => transitions.recordAuthorityOutcomeUncertainTx(tx, { businessId: asBiz, billingDocumentId: B1.doc.id, reason: "TIMEOUT", observedAt: new Date(), evidence })));
    ok(`A context marking B uncertain (input businessId=${asBiz === bizA.id ? "A" : "B"}) → refused`, r.threw, r);
  }
  const b1 = await subOf(B1.sub.id);
  ok("B's submission unmarked (errorCode null)", b1.status === "SUBMITTED" && b1.errorCode === null, b1);

  // ── 3. cross-tenant approve / recover ─────────────────────────────────────
  console.log("--- cross-tenant approve/recover ---");
  for (const asBiz of [bizA.id, bizB.id]) {
    r = await rejects(() => billingTenantTx(bizA.id, (tx) => transitions.recordAuthorityApprovedTx(tx, { businessId: asBiz, billingDocumentId: B1.doc.id, allocationNumber: "20240718181618323199093572", approvedAt: new Date(), actorUserId: userA.id })));
    ok(`A context approving B (input businessId=${asBiz === bizA.id ? "A" : "B"}) → refused`, r.threw, r);
  }
  const rawDoc = await billingTenantTx(bizA.id, (tx) => tx.billingDocument.updateMany({ where: { id: B1.doc.id }, data: { allocationNumber: "999" } }));
  ok("raw allocation projection onto B's document from A context → count 0", rawDoc.count === 0, rawDoc);
  const bDoc = await owner.billingDocument.findUniqueOrThrow({ where: { id: B1.doc.id } });
  ok("B's submission not APPROVED, document has no allocation", (await subOf(B1.sub.id)).status === "SUBMITTED" && bDoc.allocationNumber === null);
  ok("no audit row written for B by A's attempts", (await auditCount(bizB.id)) === auditB0, { before: auditB0, after: await auditCount(bizB.id) });
  await owner.billingAuthoritySubmission.update({ where: { id: B1.sub.id }, data: { status: BillingAuthoritySubmissionStatus.READY } });

  // ── 4. cross-tenant execution → zero POSTs ────────────────────────────────
  console.log("--- cross-tenant execution ---");
  counter.posts = 0;
  const cross = await exec.executeAuthorityApproval({ businessId: bizA.id, billingDocumentId: B1.doc.id, actorUserId: userA.id }, depsWith(APPROVED));
  ok("A executing B's document → DOCUMENT_NOT_FOUND", cross.outcome === "preflight_failed" && cross.errorCode === "DOCUMENT_NOT_FOUND", cross);
  ok("cross-tenant execution → ZERO Approval POSTs", counter.posts === 0, counter.posts);
  ok("B untouched (READY)", (await subOf(B1.sub.id)).status === "READY");

  // ── 5. positive control on real DB (A's own document) ─────────────────────
  console.log("--- positive control ---");
  counter.posts = 0;
  const own = await exec.executeAuthorityApproval({ businessId: bizA.id, billingDocumentId: A1.doc.id, actorUserId: userA.id }, depsWith(APPROVED));
  const a1 = await subOf(A1.sub.id);
  const a1doc = await owner.billingDocument.findUniqueOrThrow({ where: { id: A1.doc.id } });
  ok("A's own execution → completed_approved, exactly 1 POST", own.outcome === "completed_approved" && counter.posts === 1, { own, posts: counter.posts });
  ok("APPROVED persisted + projected under RLS", a1.status === "APPROVED" && a1doc.allocationNumber === "20240718181618323199093572", { a1, alloc: a1doc.allocationNumber });
  const again = await exec.executeAuthorityApproval({ businessId: bizA.id, billingDocumentId: A1.doc.id, actorUserId: userA.id }, depsWith(APPROVED));
  ok("second execution → already_processed, ZERO extra POSTs", again.outcome === "already_processed" && counter.posts === 1, again);

  // ── 6. uncertain on real DB (B as itself) ─────────────────────────────────
  console.log("--- uncertain on real DB ---");
  counter.posts = 0;
  const unc = await exec.executeAuthorityApproval({ businessId: bizB.id, billingDocumentId: B1.doc.id, actorUserId: userB.id }, depsWith(UNCERTAIN));
  const b2 = await subOf(B1.sub.id);
  ok("possibly-sent → outcome_uncertain, SUBMITTED + marker persisted", unc.outcome === "outcome_uncertain" && b2.status === "SUBMITTED" && b2.errorCode === "AUTHORITY_OUTCOME_UNCERTAIN_TIMEOUT", { unc, b2 });
  const unc2 = await exec.executeAuthorityApproval({ businessId: bizB.id, billingDocumentId: B1.doc.id, actorUserId: userB.id }, depsWith(APPROVED));
  ok("uncertain: second execution → ZERO additional POSTs", unc2.outcome === "outcome_uncertain" && counter.posts === 1, { unc2, posts: counter.posts });
  const bEvt = await owner.billingAuditEvent.findFirst({ where: { businessId: bizB.id, eventType: "BILLING_AUTHORITY_OUTCOME_UNCERTAIN" } });
  ok("uncertain audit event persisted for B (tenant B)", bEvt !== null && bEvt.billingDocumentId === B1.doc.id);

  // ── 7. CAS concurrency on real Postgres ───────────────────────────────────
  console.log("--- concurrency ---");
  counter.posts = 0;
  const racers = await Promise.all([
    ...Array.from({ length: 6 }, () => exec.executeAuthorityApproval({ businessId: bizA.id, billingDocumentId: A2.doc.id, actorUserId: userA.id }, depsWith(APPROVED, {}, 150))),
    exec.executeAuthorityApproval({ businessId: bizA.id, billingDocumentId: B1.doc.id, actorUserId: userA.id }, depsWith(APPROVED, {}, 150)),
  ]);
  const winners = racers.filter((x) => x.outcome === "completed_approved").length;
  ok("6 concurrent executions of A2 + 1 cross-tenant → exactly ONE Approval POST", counter.posts === 1, { posts: counter.posts, outcomes: racers.map((x) => x.outcome) });
  ok("exactly one winner; the cross-tenant racer got DOCUMENT_NOT_FOUND", winners === 1 && racers[6].outcome === "preflight_failed", racers.map((x) => x.outcome));
  ok("A2 APPROVED once; B1 still uncertain", (await subOf(A2.sub.id)).status === "APPROVED" && (await subOf(B1.sub.id)).errorCode === "AUTHORITY_OUTCOME_UNCERTAIN_TIMEOUT");
  const attemptsA2 = await owner.billingAuditEvent.count({ where: { businessId: bizA.id, billingDocumentId: A2.doc.id, eventType: "BILLING_AUTHORITY_SUBMISSION_ATTEMPTED" } });
  ok("one SUBMISSION_ATTEMPTED audit for A2", attemptsA2 === 1, attemptsA2);

  // ── 8. APPROVED + persistence failure → uncertain marker under RLS ────────
  console.log("--- approved + persist failure ---");
  counter.posts = 0;
  const failApprove = depsWith(APPROVED, { recordApproved: async () => { throw new Error("injected persistence failure"); } });
  const apf = await exec.executeAuthorityApproval({ businessId: bizA.id, billingDocumentId: A3.doc.id, actorUserId: userA.id }, failApprove);
  const a3 = await subOf(A3.sub.id);
  ok("approved + persist failure → outcome_uncertain, row SUBMITTED + marker", apf.outcome === "outcome_uncertain" && a3.status === "SUBMITTED" && a3.errorCode === "AUTHORITY_OUTCOME_UNCERTAIN_APPROVED_PERSIST_FAILED", { apf, a3 });
  const apEvt = await owner.billingAuditEvent.findFirst({ where: { businessId: bizA.id, billingDocumentId: A3.doc.id, eventType: "BILLING_AUTHORITY_OUTCOME_UNCERTAIN" } });
  ok("received allocation kept in A's own audit evidence", (apEvt?.metadata as Record<string, unknown> | null)?.receivedAllocationNumber === "20240718181618323199093572");
  await exec.executeAuthorityApproval({ businessId: bizA.id, billingDocumentId: A3.doc.id, actorUserId: userA.id }, depsWith(APPROVED));
  ok("approved + persist failure: second execution → ZERO additional POSTs", counter.posts === 1, counter.posts);

  // ── 9. audit evidence across the tenant boundary ──────────────────────────
  console.log("--- audit RLS ---");
  const readB = await billingTenantTx(bizA.id, (tx) => tx.billingAuditEvent.findMany({ where: { businessId: bizB.id } }));
  ok("A context reads 0 of B's audit events (incl. uncertain evidence)", readB.length === 0 && (await auditCount(bizB.id)) > 0, { readable: readB.length, actual: await auditCount(bizB.id) });
  const readA3 = await billingTenantTx(bizB.id, (tx) => tx.billingAuditEvent.findMany({ where: { billingDocumentId: A3.doc.id } }));
  ok("B context cannot read A's received-allocation evidence", readA3.length === 0, readA3.length);
  // Control: the identical row shape IS insertable for A's own tenant, so the
  // forged insert below can only fail because of the tenant boundary.
  r = await rejects(() => billingTenantTx(bizA.id, (tx) => tx.billingAuditEvent.create({ data: { businessId: bizA.id, billingDocumentId: A1.doc.id, eventType: "BILLING_AUTHORITY_OUTCOME_UNCERTAIN", summary: "control", source: "SYSTEM", eventHash: "control", metadata: {} } })));
  ok("control: A context CAN insert an audit row for A", !r.threw, r);
  r = await rejects(() => billingTenantTx(bizA.id, (tx) => tx.billingAuditEvent.create({ data: { businessId: bizB.id, billingDocumentId: B1.doc.id, eventType: "BILLING_AUTHORITY_OUTCOME_UNCERTAIN", summary: "forged", source: "SYSTEM", eventHash: "forged", metadata: {} } })));
  ok("A context cannot INSERT an audit row for B (row-level security)", r.threw && /row-level security/i.test(r.message), r);
  r = await rejects(() => billingTenantTx(bizA.id, (tx) => tx.billingAuditEvent.updateMany({ where: { businessId: bizA.id }, data: { summary: "tampered" } })));
  ok("runtime cannot UPDATE audit rows (permission denied)", r.threw && /permission denied/i.test(r.message), r);
  r = await rejects(() => billingTenantTx(bizA.id, (tx) => tx.billingAuditEvent.deleteMany({ where: { businessId: bizA.id } })));
  ok("runtime cannot DELETE audit rows (permission denied)", r.threw && /permission denied/i.test(r.message), r);

  // ── Cleanup (ephemeral DB, owner) ─────────────────────────────────────────
  await prisma.$disconnect();
  const bids = `SELECT id FROM "Business" WHERE name LIKE '${MARK}%'`;
  for (const t of ["BillingAuthoritySubmission", "BillingAuditEvent", "BillingDocument"]) {
    await owner.$executeRawUnsafe(`DELETE FROM "${t}" WHERE "businessId" IN (${bids})`);
  }
  await owner.$executeRawUnsafe(`DELETE FROM "User" WHERE email LIKE '%@apsafe.test'`);
  await owner.$executeRawUnsafe(`DELETE FROM "Business" WHERE name LIKE '${MARK}%'`);
  await owner.$disconnect();

  console.log(`\n[apsafe-tenant] PASS=${pass} FAIL=${fail}${NEGATIVE ? ` (negative=${NEGATIVE})` : ""}`);
  if (fail > 0) { console.log("FAILURES:\n - " + failures.join("\n - ")); process.exit(1); }
  console.log("ALL CHECKS PASS");
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });
