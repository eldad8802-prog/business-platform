/**
 * 4a T5 — numbering continuity across "מעבר לעוסק מורשה" (exempt → authorized, same business file), against the
 * Production role topology (.billing-4a/lab.sh). Lab proof only: no product code, no migration, no Production.
 *
 *   OWNER_URL     lab_owner — fixtures and read-back only
 *   DATABASE_URL  app_runtime_prod (NOBYPASSRLS LOGIN member of app_runtime) — every billing and transition call goes
 *                 through the application's own services on this connection
 *
 *   N1  exempt: three RECEIPTs → 1, 2, 3; a TAX_INVOICE is refused before numbering (no counter, no number)
 *   N2  the transition (the application's performKindTransition → the definer function) → TRANSITIONED
 *   N3  first TAX_INVOICE = 1; RECEIPT continues at 4; TAX_INVOICE_RECEIPT = 1; CREDIT_NOTE = 1
 *   N4  the allocation gate applies to the new tax invoices: a READY invoice of a non-pilot business is refused
 *       (Production settings) and takes no number; the next invoice gets the next number
 *   N5  no duplicate / gap in any series; every counter = max issued + 1; parallel issuance stays unique+contiguous
 *   N6  the old receipts after the transition: issuedSnapshot / legalSnapshotHash / number byte-identical; snapshot
 *       still says EXEMPT_DEALER with no VAT number; the HTML the Production renderer prints is byte-identical; the
 *       pdfmake PDF is byte-identical except the per-render creation date and ID; the served (stored) PDF is the same
 *       bytes; DZ010 refuses an edit
 *   N7  new documents freeze AUTHORIZED_DEALER and the VAT number
 *   N8  declared opening: a business that transitions, then declares and opens its TAX_INVOICE series at 459 →
 *       first tax invoice = 459; an opening for an already used series is refused (DZD32)
 *   N9  isolation: another business's counters are not touched
 *
 * Production allocation settings as in Production (runtime environment PRODUCTION, pilot business/user 9, oauth).
 * Synthetic only. ZERO secrets. ZERO network (fetch is trapped).
 *
 *   OWNER_URL=… DATABASE_URL=… DIRECT_URL=… AUTH_TOKEN_SECRET=<synthetic> BILLING_PDF_STORAGE_ROOT=<tmp> \
 *   LOCAL_STORAGE_ROOT=<tmp> STORAGE_PROVIDER=local npx tsx .billing-4a/t5-numbering.battery.mts
 */
import { createHash } from "node:crypto";
import { BillingDocumentType, CustomerTaxIdType, PrismaClient } from "@prisma/client";

process.env.BILLING_AUTHORITY_RUNTIME_ENVIRONMENT = "PRODUCTION";
process.env.BILLING_AUTHORITY_PRODUCTION_PILOT_BUSINESS_IDS = "9";
process.env.BILLING_AUTHORITY_PRODUCTION_PILOT_USER_IDS = "9";
process.env.BILLING_AUTHORITY_PRODUCTION_PILOT_OPERATIONS = "oauth";
let networkAttempts = 0;
globalThis.fetch = (async () => {
  networkAttempts++;
  throw new Error("network disabled in this lab");
}) as typeof fetch;

const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });
let pass = 0;
const failures: string[] = [];
const notes: string[] = [];
function ok(name: string, cond: boolean, detail: unknown = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { failures.push(name); console.log(`  [FAIL] ${name}${detail !== "" ? " — " + (typeof detail === "string" ? detail : JSON.stringify(detail)) : ""}`); }
}
function observed(name: string, value: unknown) {
  const line = `${name}: ${typeof value === "string" ? value : JSON.stringify(value)}`;
  notes.push(line);
  console.log(`  [OBSERVED] ${line}`);
}
// Prisma's raw-query errors start with blank / "Invalid … invocation" lines: keep the whole text, flattened.
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").trim().slice(0, 400);
async function refusal(fn: () => Promise<unknown>): Promise<string | null> {
  try { await fn(); return null; } catch (e) { return msg(e) + ((e as { code?: string }).code ? ` [${(e as { code?: string }).code}]` : ""); }
}
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
type Rows = Record<string, unknown>[];

function withCheckDigit(eight: string): string {
  let sum = 0;
  for (let i = 0; i < 8; i++) { let d = Number(eight[i]) * (i % 2 === 0 ? 1 : 2); if (d > 9) d -= 9; sum += d; }
  return eight + String((10 - (sum % 10)) % 10);
}
/** pdfkit stamps every render with a creation date and a random file ID; nothing else may differ. */
function normalizePdf(buf: Buffer): string {
  // pdfkit writes the date on its own line after the /CreationDate key: "(D:20261122235413Z)".
  return buf.toString("latin1")
    .replace(/\(D:\d{14}Z\)/g, "(D:X)")
    .replace(/\/ID \[<[0-9a-fA-F]+> <[0-9a-fA-F]+>\]/g, "/ID [<X> <X>]");
}

const LINES = [{ description: "שירות ייעוץ", quantity: "1", unitPrice: "1000", vatRatePercent: "18" }];
const LARGE = [{ description: "פרויקט התקנה", quantity: "1", unitPrice: "30000", vatRatePercent: "18" }];

async function main() {
  const { performKindTransition } = await import("@/lib/services/legal-identity/kind-transition.service");
  const { kindTransitionStatementSha256, israelToday } = await import("@/lib/legal-identity/kind-transition");
  const { issueBillingDocument, hashIssuedSnapshot } = await import("@/lib/services/billing/billing-issue.service");
  const { createBillingDraft } = await import("@/lib/services/billing/billing-draft.service");
  const { createReceiptDraft } = await import("@/lib/services/billing/receipt/billing-receipt-draft.service");
  const { createBillingCreditNoteDraft } = await import("@/lib/services/billing/billing-credit-reversal.service");
  const { buildBillingInvoiceHtml } = await import("@/lib/services/billing/pdf/billing-pdf-html-template");
  const { getNotoSansHebrewFontDataUri } = await import("@/lib/services/billing/pdf/billing-pdf-html-renderer");
  const { renderBillingPdfFromSnapshot } = await import("@/lib/services/billing/pdf/billing-pdf-renderer");
  const { getFiscalBillingPdfForDelivery } = await import("@/lib/services/billing/signed-pdf-delivery.wiring");
  const { prisma: runtime } = await import("@/lib/prisma");

  // ------------------------------------------------------------------ posture
  const [who] = (await runtime.$queryRawUnsafe(
    `SELECT current_user::text AS who, r.rolsuper, r.rolbypassrls, pg_has_role(current_user, 'app_runtime', 'member') AS member
       FROM pg_roles r WHERE r.rolname = current_user`)) as Array<{ who: string; rolsuper: boolean; rolbypassrls: boolean; member: boolean }>;
  console.log(`runtime connection: ${who.who} (superuser=${who.rolsuper}, bypassrls=${who.rolbypassrls}, app_runtime member=${who.member})`);
  ok("P0 the application runs as a NOBYPASSRLS, non-superuser member of app_runtime", !who.rolsuper && !who.rolbypassrls && who.member, who);
  // Billing tables come from `db push` in the base lab: replay every RLS / policy statement the repository ships
  // (the same kit as the tax-classification lab) so they carry Production's FORCE RLS and tenant policies.
  const { replayRepositoryRls } = await import("../.tax-classification-lab/lab-kit.mts");
  const replayed = await replayRepositoryRls(process.env.OWNER_URL!);
  ok("P0 replayed the repository's RLS statements", replayed > 50, replayed);
  const objs = (await owner.$queryRawUnsafe(`
    SELECT
      (SELECT count(*) FROM pg_trigger WHERE tgname = 'BillingDocumentNumberSequence_series_opening')::int AS series_apply,
      (SELECT count(*) FROM pg_proc WHERE proname = 'business_kind_transition_to_authorized')::int AS bkt_fn,
      (SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relname = 'BillingDocument' AND t.tgname = 'secf_fiscal_immutable')::int AS dz010,
      (SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relname = 'BillingDocument' AND NOT t.tgisinternal)::int AS doc_triggers,
      (SELECT relforcerowsecurity FROM pg_class WHERE relname = 'BillingDocument') AS doc_force_rls,
      (SELECT relforcerowsecurity FROM pg_class WHERE relname = 'BillingDocumentNumberSequence') AS seq_force_rls`)) as Rows;
  observed("P1 lab objects", objs[0]);
  ok("P1 series_opening_apply on the counter + the transition function are installed (by migrate deploy)",
    objs[0].series_apply === 1 && objs[0].bkt_fn === 1, objs[0]);
  ok("P1 DZ010 (secf_fiscal_immutable) is on BillingDocument and FORCE RLS is on the billing tables",
    objs[0].dz010 === 1 && objs[0].doc_force_rls === true && objs[0].seq_force_rls === true, objs[0]);

  // ------------------------------------------------------------------ fixtures (owner)
  const stamp = Date.now();
  let n = 0;
  const TAX = withCheckDigit(String(30_000_000 + (stamp % 9_000_000)).padStart(8, "0").slice(0, 8));
  const LEGAL_NAME = "דנה כהן";
  async function business(kind: "EXEMPT_DEALER" | "AUTHORIZED_DEALER", taxId: string) {
    const b = (await owner.$queryRawUnsafe(`INSERT INTO "Business" ("name","updatedAt") VALUES ($1, now()) RETURNING id`, `t5-${stamp}-${++n}`)) as Rows;
    const businessId = Number(b[0].id);
    const u = (await owner.$queryRawUnsafe(
      `INSERT INTO "User" ("email","password","name","businessId","updatedAt") VALUES ($1,$2,'דנה',$3, now()) RETURNING id`,
      `t5-${stamp}-${n}@lab.invalid`, "$2b$10$" + "A".repeat(53), businessId)) as Rows;
    await owner.$queryRawUnsafe(
      `INSERT INTO "BusinessProfile" ("businessId","billingBusinessKind","billingLegalName","billingTaxId","billingVatNumber","billingAddress",
         "billingPhone","billingEmail","legalIdentityConfirmedAt","legalIdentitySource","updatedAt")
       VALUES ($1,$2,$3,$4,$5,'הרצל 1, תל אביב','0501234567','biz@lab.invalid', now(), 'SIGNUP', now())`,
      businessId, kind, LEGAL_NAME, taxId, kind === "AUTHORIZED_DEALER" ? taxId : null);
    const dealer = await owner.customer.create({ data: { businessId, name: "לקוח עוסק מורשה", taxId: "515000131", taxIdType: CustomerTaxIdType.AUTHORIZED_DEALER } });
    const priv = await owner.customer.create({ data: { businessId, name: "לקוח פרטי" } });
    return { businessId, userId: Number(u[0].id), dealerId: dealer.id, privateId: priv.id };
  }
  const approvals: number[] = [];
  const deps = {
    executeApproval: async (input: { billingDocumentId: number }) => {
      approvals.push(input.billingDocumentId);
      return { outcome: "completed_approved", billingDocumentId: input.billingDocumentId, submissionId: -1, allocationNumber: "123456789", safeToRetry: false };
    },
  } as never;

  type Biz = Awaited<ReturnType<typeof business>>;
  const issue = (b: Biz, id: number) => issueBillingDocument({ businessId: b.businessId, billingDocumentId: id, actorUserId: b.userId }, deps);
  const receipt = async (b: Biz, amount = "100.00") => {
    const d = await createReceiptDraft({ businessId: b.businessId, actorUserId: b.userId, documentType: BillingDocumentType.RECEIPT, customerId: b.privateId, currency: "ILS",
      paymentLines: [{ method: "CASH", amount, paymentDate: new Date().toISOString() }] } as never);
    return { id: d.id, r: await issue(b, d.id) };
  };
  const invoice = async (b: Biz, lines = LINES, customerId = b.privateId) => {
    const d = await createBillingDraft({ businessId: b.businessId, actorUserId: b.userId, documentType: BillingDocumentType.TAX_INVOICE, customerId, initialLines: lines });
    return d.id;
  };
  const doc = (id: number) => owner.billingDocument.findUniqueOrThrow({ where: { id } });
  const counters = async (businessId: number) =>
    Object.fromEntries(((await owner.$queryRawUnsafe(`SELECT "documentType"::text t, "nextNumber" n FROM "BillingDocumentNumberSequence" WHERE "businessId" = $1 ORDER BY 1`, businessId)) as Rows)
      .map((r) => [String(r.t), Number(r.n)]));
  const numbers = async (businessId: number, t: string) =>
    ((await owner.$queryRawUnsafe(`SELECT "documentNumber" n FROM "BillingDocument" WHERE "businessId" = $1 AND "documentType"::text = $2 AND "documentNumber" IS NOT NULL ORDER BY 1`, businessId, t)) as Rows)
      .map((r) => Number(r.n));

  const E = await business("EXEMPT_DEALER", TAX);
  const OTHER = await business("AUTHORIZED_DEALER", withCheckDigit("03141592"));
  // Another business with its own series, before anything happens to E (N9).
  const otherInv = await invoice(OTHER);
  await issue(OTHER, otherInv);
  const otherBefore = await counters(OTHER.businessId);

  // ================================================================== N1 exempt
  console.log("\n— N1 exempt business");
  const oldReceipts: number[] = [];
  for (let i = 0; i < 3; i++) oldReceipts.push((await receipt(E, `${100 + i}.00`)).id);
  ok("N1 three receipts while exempt → 1, 2, 3", JSON.stringify(await numbers(E.businessId, "RECEIPT")) === "[1,2,3]", await numbers(E.businessId, "RECEIPT"));
  let exemptInvoiceDraft: number | null = null;
  const draftRefusal = await refusal(async () => { exemptInvoiceDraft = await invoice(E); });
  observed("N1 creating a TAX_INVOICE draft while exempt", draftRefusal ?? `allowed (draft ${exemptInvoiceDraft})`);
  if (exemptInvoiceDraft !== null) {
    const r = await refusal(() => issue(E, exemptInvoiceDraft!));
    ok("N1 issuing a TAX_INVOICE while exempt is refused", r !== null, r ?? "issued");
    const d = await doc(exemptInvoiceDraft);
    ok("N1 the refused draft keeps no number and stays a draft", d.documentNumber === null && d.status === "DRAFT", { n: d.documentNumber, s: d.status });
  }
  ok("N1 no TAX_INVOICE counter exists while exempt", !("TAX_INVOICE" in (await counters(E.businessId))), await counters(E.businessId));

  // capture the old receipts before the transition
  const font = getNotoSansHebrewFontDataUri();
  type Capture = { row: string; hash: string | null; html: string; pdfmake: string; served: string | null; servedError: string | null };
  const capture = async (id: number): Promise<Capture> => {
    const d = await doc(id);
    const snapshot = d.issuedSnapshot as never;
    let served: string | null = null;
    let servedError: string | null = null;
    try {
      const r = await getFiscalBillingPdfForDelivery({ businessId: E.businessId, actorUserId: E.userId, billingDocumentId: id });
      served = sha(r.buffer);
    } catch (e) { servedError = msg(e); }
    return {
      row: JSON.stringify({ n: d.documentNumber, f: d.documentNumberFormatted, s: d.issuedSnapshot, i: d.issuedAt, st: d.status }),
      hash: d.legalSnapshotHash,
      html: sha(buildBillingInvoiceHtml(snapshot, font)),
      pdfmake: sha(normalizePdf(await renderBillingPdfFromSnapshot(snapshot))),
      served, servedError,
    };
  };
  const before = new Map<number, Capture>();
  for (const id of oldReceipts) before.set(id, await capture(id));
  // pdfmake determinism control: two renders of the same snapshot, normalised, are equal (else N6 would prove nothing)
  {
    const s = (await doc(oldReceipts[0])).issuedSnapshot as never;
    const [a, b] = [await renderBillingPdfFromSnapshot(s), await renderBillingPdfFromSnapshot(s)];
    ok("N6-control two pdfmake renders of one snapshot differ only in creation date / ID", normalizePdf(a) === normalizePdf(b), { raw_equal: a.equals(b) });
  }

  // ================================================================== N2 transition
  console.log("\n— N2 transition (application service → definer function)");
  const date = israelToday();
  const statementSha256 = kindTransitionStatementSha256({ businessId: E.businessId, actorUserId: E.userId, legalName: LEGAL_NAME, taxId: TAX, vatNumber: TAX, statusEffectiveDate: date });
  const result = await performKindTransition(E.businessId, E.userId, { vatNumber: TAX, statusEffectiveDate: date, reauthMethod: "PASSWORD", reauthAt: new Date(), statementSha256 });
  ok("N2 performKindTransition → TRANSITIONED", result === "TRANSITIONED", result);
  const prof = ((await owner.$queryRawUnsafe(`SELECT "billingBusinessKind" k, "billingVatNumber" v FROM "BusinessProfile" WHERE "businessId" = $1`, E.businessId)) as Rows)[0];
  ok("N2 profile is AUTHORIZED_DEALER with VAT number = id number", prof.k === "AUTHORIZED_DEALER" && prof.v === TAX, prof);
  ok("N2 the transition touched no counter", JSON.stringify(await counters(E.businessId)) === JSON.stringify({ RECEIPT: 4 }), await counters(E.businessId));

  // ================================================================== N3 / N4 after
  console.log("\n— N3/N4 after the transition");
  const inv1 = await invoice(E);
  await issue(E, inv1);
  ok("N3 first TAX_INVOICE = 1 (no declared opening)", (await doc(inv1)).documentNumber === 1, (await doc(inv1)).documentNumber);

  const big = await invoice(E, LARGE, E.dealerId);
  const approvalsBefore = approvals.length;
  const gate = await refusal(() => issue(E, big));
  ok("N4 a READY tax invoice of a non-pilot business is refused by the allocation gate (Production settings)", gate !== null && /ALLOCATION|הקצאה|allocation/i.test(gate), gate ?? "issued");
  ok("N4 the refused invoice took no number and the executor was not called", (await doc(big)).documentNumber === null && approvals.length === approvalsBefore, { n: (await doc(big)).documentNumber });
  const inv2 = await invoice(E);
  await issue(E, inv2);
  ok("N4 the next tax invoice is 2 (the gate refusal consumed nothing)", (await doc(inv2)).documentNumber === 2, (await doc(inv2)).documentNumber);

  const r4 = await receipt(E);
  ok("N3 RECEIPT continues at 4 (same series across the transition)", (await doc(r4.id)).documentNumber === 4, (await doc(r4.id)).documentNumber);
  const tirDraft = await createReceiptDraft({ businessId: E.businessId, actorUserId: E.userId, documentType: BillingDocumentType.TAX_INVOICE_RECEIPT, customerId: E.privateId, currency: "ILS",
    goodsLines: LINES, paymentLines: [{ method: "CASH", amount: "1180.00", paymentDate: new Date().toISOString() }] } as never);
  await issue(E, tirDraft.id);
  ok("N3 first TAX_INVOICE_RECEIPT = 1", (await doc(tirDraft.id)).documentNumber === 1, (await doc(tirDraft.id)).documentNumber);
  const cn = await createBillingCreditNoteDraft({ businessId: E.businessId, actorUserId: E.userId, sourceBillingDocumentId: inv1 });
  await issue(E, cn.id);
  ok("N3 first CREDIT_NOTE = 1", (await doc(cn.id)).documentNumber === 1, (await doc(cn.id)).documentNumber);

  // ================================================================== N5 continuity + concurrency
  console.log("\n— N5 continuity");
  const drafts: number[] = [];
  for (let i = 0; i < 8; i++) drafts.push(await invoice(E));
  const settled = await Promise.allSettled(drafts.map((id) => issue(E, id)));
  const conc = (await Promise.all(drafts.map(doc))).map((d) => d.documentNumber).filter((x): x is number => x !== null).sort((a, b) => a - b);
  observed("N5 parallel issuance outcomes", settled.map((s) => s.status));
  ok("N5 eight parallel tax invoices → unique and contiguous", new Set(conc).size === conc.length && conc.length > 0 && conc[conc.length - 1] - conc[0] === conc.length - 1, conc);
  const c = await counters(E.businessId);
  for (const t of ["RECEIPT", "TAX_INVOICE", "TAX_INVOICE_RECEIPT", "CREDIT_NOTE"]) {
    const ns = await numbers(E.businessId, t);
    const contiguous = ns.every((v, i) => v === i + 1);
    ok(`N5 ${t}: 1..${ns.length} with no duplicate or gap; counter = max + 1`, contiguous && new Set(ns).size === ns.length && c[t] === ns.length + 1, { ns, counter: c[t] });
  }
  const dup = (await owner.$queryRawUnsafe(`SELECT "documentType"::text t, "documentNumber" n, count(*)::int k FROM "BillingDocument" WHERE "businessId" = $1 AND "documentNumber" IS NOT NULL GROUP BY 1,2 HAVING count(*) > 1`, E.businessId)) as Rows;
  ok("N5 no (type, number) appears twice", dup.length === 0, dup);

  // ================================================================== N6 old receipts unchanged
  console.log("\n— N6 historical receipts");
  for (const id of oldReceipts) {
    const a = before.get(id)!;
    const b = await capture(id);
    const d = await doc(id);
    const s = d.issuedSnapshot as { extensions?: { billingBusinessKind?: string }; issuer?: Record<string, unknown> };
    ok(`N6 receipt ${d.documentNumber}: row (number, snapshot, issuedAt, status) byte-identical`, a.row === b.row);
    ok(`N6 receipt ${d.documentNumber}: legalSnapshotHash unchanged and still = hash(snapshot)`, a.hash === b.hash && b.hash === hashIssuedSnapshot(d.issuedSnapshot as never));
    ok(`N6 receipt ${d.documentNumber}: snapshot still EXEMPT_DEALER, no VAT number`, s.extensions?.billingBusinessKind === "EXEMPT_DEALER" && !s.issuer?.vatNumber, { kind: s.extensions?.billingBusinessKind, vat: s.issuer?.vatNumber });
    ok(`N6 receipt ${d.documentNumber}: Production HTML byte-identical`, a.html === b.html);
    ok(`N6 receipt ${d.documentNumber}: pdfmake PDF byte-identical (creation date / ID normalised)`, a.pdfmake === b.pdfmake);
    if (a.served && b.served) ok(`N6 receipt ${d.documentNumber}: the served PDF is the same bytes`, a.served === b.served);
    else observed(`N6 receipt ${d.documentNumber}: served PDF not available in this lab`, a.servedError ?? b.servedError);
  }
  const edit = await refusal(() => runtime.$transaction(async (tx) => {
    await tx.$queryRawUnsafe(`SELECT set_config('app.current_business_id', $1, true)`, String(E.businessId));
    await tx.$executeRawUnsafe(`UPDATE "BillingDocument" SET "documentNumber" = 99 WHERE id = $1`, oldReceipts[0]);
  }));
  ok("N6 the runtime cannot renumber an issued receipt (DZ010 / grants)", edit !== null, edit ?? "updated");
  ok("N6 still number 1 after the attempt", (await doc(oldReceipts[0])).documentNumber === 1);

  // ================================================================== N7 new documents
  const ns = (await doc(inv1)).issuedSnapshot as { extensions?: { billingBusinessKind?: string }; issuer?: Record<string, unknown> };
  observed("N7 new invoice issuer snapshot keys", Object.keys(ns.issuer ?? {}));
  ok("N7 the new tax invoice froze AUTHORIZED_DEALER and the VAT number", ns.extensions?.billingBusinessKind === "AUTHORIZED_DEALER" && JSON.stringify(ns.issuer ?? {}).includes(TAX), ns.extensions);

  // ================================================================== N8 declared opening
  console.log("\n— N8 declared series opening after the transition");
  const S = await business("EXEMPT_DEALER", withCheckDigit("21212121"));
  await receipt(S); await receipt(S);
  const sDate = israelToday();
  const sTax = withCheckDigit("21212121");
  const sRes = await performKindTransition(S.businessId, S.userId, { vatNumber: sTax, statusEffectiveDate: sDate, reauthMethod: "PASSWORD", reauthAt: new Date(),
    statementSha256: kindTransitionStatementSha256({ businessId: S.businessId, actorUserId: S.userId, legalName: LEGAL_NAME, taxId: sTax, vatNumber: sTax, statusEffectiveDate: sDate }) });
  ok("N8 transition (no declaration yet) → TRANSITIONED", sRes === "TRANSITIONED", sRes);
  // The owner writes the declaration fixture (what the emailed-link flow records: INITIAL, authorized individual).
  const decl = (await owner.$queryRawUnsafe(
    `INSERT INTO "BusinessIssuerDeclaration" ("businessId","version","kind","track","legalForm","vatStatus","legalName","idType","idNumber","vatRegistrationNumber",
       "address","phone","email","effectiveFrom","authorizedUserId","authorityBasis","declaredByUserId","declarantName","declarantCapacity",
       "statementVersion","statementSha256","reauthMethod","reauthAt")
     VALUES ($1, 1, 'INITIAL', 'AUTHORIZED_DEALER_INDIVIDUAL', 'INDIVIDUAL', 'AUTHORIZED', $2, 'ISRAELI_ID', $3, $3, 'הרצל 1, תל אביב', '0501234567', 'biz@lab.invalid',
       now(), $4, 'SOLE_USER_VERIFIED', $4, 'דנה', 'בעלים', 'v1', $5, 'EMAIL_LINK', now()) RETURNING id`,
    S.businessId, LEGAL_NAME, sTax, S.userId, "b".repeat(64))) as Rows;
  const opening = await refusal(() => runtime.$transaction(async (tx) => {
    await tx.$queryRawUnsafe(`SELECT set_config('app.current_business_id', $1, true)`, String(S.businessId));
    await tx.$executeRawUnsafe(
      `INSERT INTO "BillingSeriesOpening" ("businessId","documentType","openingNumber","source","previousToolName","lastNumberInPreviousTool","declarationId","declaredByUserId")
       VALUES ($1, 'TAX_INVOICE', 459, 'CONTINUES_PREVIOUS_TOOL', 'כלי קודם', 458, $2, $3)`, S.businessId, Number(decl[0].id), S.userId);
  }));
  ok("N8 the runtime records a TAX_INVOICE opening at 459 (series never used)", opening === null, opening);
  const sInv = await invoice(S);
  await issue(S, sInv);
  ok("N8 first tax invoice after the opening = 459", (await doc(sInv)).documentNumber === 459, (await doc(sInv)).documentNumber);
  const sRcpt = await receipt(S);
  ok("N8 receipts are untouched by the tax-invoice opening (3)", (await doc(sRcpt.id)).documentNumber === 3, (await doc(sRcpt.id)).documentNumber);
  const late = await refusal(() => runtime.$transaction(async (tx) => {
    await tx.$queryRawUnsafe(`SELECT set_config('app.current_business_id', $1, true)`, String(S.businessId));
    await tx.$executeRawUnsafe(
      `INSERT INTO "BillingSeriesOpening" ("businessId","documentType","openingNumber","source","previousToolName","lastNumberInPreviousTool","declarationId","declaredByUserId")
       VALUES ($1, 'RECEIPT', 100, 'CONTINUES_PREVIOUS_TOOL', 'כלי קודם', 99, $2, $3)`, S.businessId, Number(decl[0].id), S.userId);
  }));
  ok("N8 an opening for the already used RECEIPT series is refused (DZD32)", late !== null && /SERIES_ALREADY_USED|DZD32/.test(late), late ?? "accepted");

  // ================================================================== N9 isolation
  ok("N9 the other business's counters are unchanged", JSON.stringify(await counters(OTHER.businessId)) === JSON.stringify(otherBefore), { before: otherBefore, after: await counters(OTHER.businessId) });
  ok("N9 zero network attempts", networkAttempts === 0, networkAttempts);

  console.log(`\nT5: ${pass} passed, ${failures.length} failed`);
  if (notes.length) console.log("observed:\n  " + notes.join("\n  "));
  await owner.$disconnect();
  await runtime.$disconnect();
  if (failures.length) { console.log("FAILED:\n  " + failures.join("\n  ")); process.exit(1); }
}

main().catch(async (e) => {
  console.error(e);
  await owner.$disconnect();
  process.exit(1);
});
