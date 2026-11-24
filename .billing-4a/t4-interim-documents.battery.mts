/**
 * 4a T4 — interim documents (issued between the official status date and the Dubiz update), against the Production
 * role topology (.billing-4a/lab.sh). Every read goes through the product code on the runtime connection
 * (app_runtime_prod: NOBYPASSRLS, member of app_runtime) in the business's tenant transaction.
 *
 *   OWNER_URL     lab_owner: fixtures (seeded issued documents with chosen issuedAt, transition rows) + read-back
 *   DATABASE_URL  app_runtime_prod
 *
 *   B1  winter bounds (UTC+2): 00:00:00.000 local of the official date is IN, 23:59:59.999 the day before is OUT;
 *       confirmedAt − 1 ms is IN, confirmedAt itself is OUT; QUOTE / DRAFT / PENDING_REVIEW are never counted
 *   B2  summer bounds (UTC+3), before any transition: the requested date to now; the same in/out pairs
 *   B3  after the transition the range comes from the BusinessKindTransition row only (a requested date is ignored)
 *   C1  credit: a tax invoice credited for its total → FULL; for part → PARTIAL; a credit note naming a receipt →
 *       LINKED only; the credit notes themselves are counted documents
 *   I1  isolation: another business's documents in the same window are never counted; asking for another business
 *       inside one business's tenant transaction sees nothing (FORCE RLS)
 *   R1  read only: the whole read runs inside a READ ONLY transaction; the runtime role holds no write privilege on
 *       BusinessKindTransition; nothing in the product code path writes
 *   H1  the route handler with its real read path: 200 with the counts; flag OFF (env unset) → 404
 *   L1  coordination with issuance: while the transition key is held exclusively, an issuance waits and takes no
 *       number; it completes once the key is released; issuances do not block each other (shared)
 *   L2  the real transition racing parallel issuances: every counted document froze EXEMPT_DEALER, and every document
 *       that froze EXEMPT_DEALER on or after the official date is counted
 *
 * Synthetic only. ZERO secrets. ZERO network.
 */
import { BillingDocumentType, PrismaClient, Prisma } from "@prisma/client";

process.env.BILLING_AUTHORITY_RUNTIME_ENVIRONMENT = "PRODUCTION";
process.env.BILLING_AUTHORITY_PRODUCTION_PILOT_BUSINESS_IDS = "9";
process.env.BILLING_AUTHORITY_PRODUCTION_PILOT_USER_IDS = "9";
process.env.BILLING_AUTHORITY_PRODUCTION_PILOT_OPERATIONS = "oauth";
let networkAttempts = 0;
globalThis.fetch = (async () => { networkAttempts++; throw new Error("network disabled in this lab"); }) as typeof fetch;

const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });
let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail: unknown = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { failures.push(name); console.log(`  [FAIL] ${name}${detail !== "" ? " — " + (typeof detail === "string" ? detail : JSON.stringify(detail)) : ""}`); }
}
const observed = (name: string, v: unknown) => console.log(`  [OBSERVED] ${name}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
type Rows = Record<string, unknown>[];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function withCheckDigit(eight: string): string {
  let sum = 0;
  for (let i = 0; i < 8; i++) { let d = Number(eight[i]) * (i % 2 === 0 ? 1 : 2); if (d > 9) d -= 9; sum += d; }
  return eight + String((10 - (sum % 10)) % 10);
}

async function main() {
  const svc = await import("@/lib/services/billing/kind-transition/interim-documents");
  const { handleInterimDocumentsGet, defaultInterimDocumentsDeps } = await import("@/lib/services/billing/kind-transition/interim-documents-handler");
  const { billingTenantTx } = await import("@/lib/services/billing/billing-tenant-tx");
  const { issueBillingDocument } = await import("@/lib/services/billing/billing-issue.service");
  const { createReceiptDraft } = await import("@/lib/services/billing/receipt/billing-receipt-draft.service");
  const { performKindTransition } = await import("@/lib/services/legal-identity/kind-transition.service");
  const { kindTransitionStatementSha256, israelToday } = await import("@/lib/legal-identity/kind-transition");
  const { prisma: runtime } = await import("@/lib/prisma");

  const [who] = (await runtime.$queryRawUnsafe(`SELECT current_user::text who, r.rolsuper, r.rolbypassrls, pg_has_role(current_user,'app_runtime','member') m FROM pg_roles r WHERE r.rolname = current_user`)) as Rows;
  ok("P0 runtime = NOBYPASSRLS non-superuser member of app_runtime", !who.rolsuper && !who.rolbypassrls && who.m === true, who);
  const { replayRepositoryRls } = await import("../.tax-classification-lab/lab-kit.mts");
  ok("P0 replayed the repository's RLS statements", (await replayRepositoryRls(process.env.OWNER_URL!)) > 50);

  // ------------------------------------------------------------------ fixtures
  const stamp = Date.now();
  let n = 0;
  async function business(kind: "EXEMPT_DEALER" | "AUTHORIZED_DEALER", eight: string) {
    const taxId = withCheckDigit(eight);
    const b = (await owner.$queryRawUnsafe(`INSERT INTO "Business" ("name","updatedAt") VALUES ($1, now()) RETURNING id`, `t4-${stamp}-${++n}`)) as Rows;
    const businessId = Number(b[0].id);
    const u = (await owner.$queryRawUnsafe(`INSERT INTO "User" ("email","password","name","businessId","updatedAt") VALUES ($1,$2,'דנה',$3, now()) RETURNING id`,
      `t4-${stamp}-${n}@lab.invalid`, "$2b$10$" + "A".repeat(53), businessId)) as Rows;
    await owner.$queryRawUnsafe(`INSERT INTO "BusinessProfile" ("businessId","billingBusinessKind","billingLegalName","billingTaxId","billingVatNumber","billingAddress",
         "billingPhone","billingEmail","legalIdentityConfirmedAt","legalIdentitySource","updatedAt")
       VALUES ($1,$2,'דנה כהן',$3,$4,'הרצל 1','0501234567','b@lab.invalid', now(), 'SIGNUP', now())`, businessId, kind, taxId, kind === "AUTHORIZED_DEALER" ? taxId : null);
    const priv = await owner.customer.create({ data: { businessId, name: "לקוח פרטי" } });
    return { businessId, userId: Number(u[0].id), privateId: priv.id, taxId };
  }
  type Biz = Awaited<ReturnType<typeof business>>;
  const numbers: Record<string, number> = {};
  /** A seeded document (owner): chosen type / status / issuedAt; no product path involved. */
  /** kind = what issuedSnapshot.extensions.billingBusinessKind froze (null → no snapshot, as before the billing MVP). */
  async function seed(b: Biz, t: string, status: string, issuedAt: string | null, total = "100.00", referenceDocumentId: number | null = null, kind: string | null = null): Promise<number> {
    const key = `${b.businessId}:${t}`;
    const num = status === "ISSUED" ? (numbers[key] = (numbers[key] ?? 0) + 1) : null;
    const snap = kind === null ? null : JSON.stringify({ extensions: { billingBusinessKind: kind } });
    const r = (await owner.$queryRawUnsafe(
      `INSERT INTO "BillingDocument" ("businessId","documentType","status","issuedAt","documentNumber","documentNumberFormatted","subtotalAmount","totalAmount","currency","referenceDocumentId","issuedSnapshot","updatedAt")
       VALUES ($1, $2::"BillingDocumentType", $3::"BillingDocumentStatus", $4::timestamptz AT TIME ZONE 'UTC', $5, $6, $7::numeric, $7::numeric, 'ILS', $8, $9::jsonb, now()) RETURNING id`,
      b.businessId, t, status, issuedAt, num, num === null ? null : String(num), total, referenceDocumentId, snap)) as Rows;
    return Number(r[0].id);
  }
  async function transitionRow(b: Biz, statusEffectiveDate: string, confirmedAt: string) {
    await owner.$queryRawUnsafe(
      `INSERT INTO "BusinessKindTransition" ("businessId","fromKind","toKind","statusEffectiveDate","confirmedAt","confirmedByUserId","reauthMethod","reauthAt","statementVersion","statementSha256")
       VALUES ($1,'EXEMPT_DEALER','AUTHORIZED_DEALER',$2::date,$3::timestamptz,$4,'PASSWORD',$3::timestamptz,'kind-transition-exempt-to-authorized-v1',$5)`,
      b.businessId, statusEffectiveDate, confirmedAt, b.userId, "0".repeat(64));
  }
  const read = (b: Biz, args: { from?: string | null; now?: Date; list?: boolean; cursor?: string | null; tenant?: number }) =>
    billingTenantTx(args.tenant ?? b.businessId, (tx) => svc.readInterimDocumentsTx(tx, { businessId: b.businessId, requestedFromDate: args.from ?? null, now: args.now ?? new Date(), list: !!args.list, cursor: args.cursor ?? null }));
  const ids = (r: Awaited<ReturnType<typeof read>>) => (r.ok ? (r.result.items ?? []).map((i) => i.id).sort((a, z) => a - z) : []);

  // ================================================================== B1 winter
  console.log("\n— B1 winter bounds (Asia/Jerusalem = UTC+2), after the transition");
  const W = await business("EXEMPT_DEALER", "31000000");
  const wConfirmed = "2026-02-01T10:00:00.000Z";
  const wOutBefore = await seed(W, "RECEIPT", "ISSUED", "2026-01-14T21:59:59.999Z"); // 23:59:59.999 on 01-14 local
  const wInStart = await seed(W, "RECEIPT", "ISSUED", "2026-01-14T22:00:00.000Z"); // 00:00 on 01-15 local
  const wInMid = await seed(W, "TAX_INVOICE", "ISSUED", "2026-01-20T08:00:00.000Z", "118.00");
  const wInEnd = await seed(W, "RECEIPT", "ISSUED", "2026-02-01T09:59:59.999Z");
  const wOutEnd = await seed(W, "RECEIPT", "ISSUED", wConfirmed);
  const wQuote = await seed(W, "QUOTE", "ISSUED", "2026-01-21T08:00:00.000Z");
  const wDraft = await seed(W, "TAX_INVOICE", "DRAFT", null);
  const wPending = await seed(W, "TAX_INVOICE", "PENDING_REVIEW", null);
  await transitionRow(W, "2026-01-15", wConfirmed);
  const w = await read(W, { list: true });
  observed("B1 result", w.ok ? { range: w.result.range, count: w.result.count, ids: ids(w) } : w);
  ok("B1 00:00:00.000 local of the official date is counted; 23:59:59.999 the day before is not",
    ids(w).includes(wInStart) && !ids(w).includes(wOutBefore));
  ok("B1 confirmedAt − 1 ms is counted; confirmedAt itself is not", ids(w).includes(wInEnd) && !ids(w).includes(wOutEnd));
  ok("B1 QUOTE, DRAFT and PENDING_REVIEW are never counted", ![wQuote, wDraft, wPending].some((i) => ids(w).includes(i)));
  ok("B1 count = 3 (start, mid tax invoice, end)", w.ok && w.result.count === 3 && JSON.stringify(ids(w)) === JSON.stringify([wInStart, wInMid, wInEnd].sort((a, z) => a - z)));
  ok("B1 documentDate is the Israeli calendar day of issuedAt (printed date)",
    w.ok && (w.result.items ?? []).find((i) => i.id === wInStart)?.documentDate === "2026-01-15");

  // ================================================================== B3 range from the record only
  const w2 = await read(W, { from: "2025-01-01", list: true });
  ok("B3 after the transition a requested date is ignored: the range comes from the record (source TRANSITION_RECORD)",
    w2.ok && w2.result.range.source === "TRANSITION_RECORD" && w2.result.range.fromDate === "2026-01-15" && w2.result.range.to === wConfirmed && w2.result.count === 3);

  // ================================================================== K1 what the document froze decides
  console.log("\n— K1 what each document froze decides inside the window");
  const K = await business("EXEMPT_DEALER", "31000006");
  const kConfirmed = "2026-06-01T09:00:00.000Z";
  const kExempt = await seed(K, "RECEIPT", "ISSUED", "2026-05-20T08:00:00.000Z", "10.00", null, "EXEMPT_DEALER");
  const kAuthEarly = await seed(K, "TAX_INVOICE", "ISSUED", "2026-06-01T08:59:59.990Z", "118.00", null, "AUTHORIZED_DEALER"); // stamped before confirmedAt, issued after
  const kExemptLate = await seed(K, "RECEIPT", "ISSUED", "2026-06-01T09:00:00.005Z", "10.00", null, "EXEMPT_DEALER"); // stamped after confirmedAt, issued before
  const kExemptBefore = await seed(K, "RECEIPT", "ISSUED", "2026-04-30T08:00:00.000Z", "10.00", null, "EXEMPT_DEALER");
  await transitionRow(K, "2026-05-01", kConfirmed);
  const k = await read(K, { list: true });
  observed("K1 ids", ids(k));
  ok("K1 a document that froze AUTHORIZED_DEALER is never counted, even with issuedAt before confirmedAt", !ids(k).includes(kAuthEarly));
  ok("K1 a document that froze EXEMPT_DEALER inside the window is counted, also one stamped a moment after confirmedAt",
    ids(k).includes(kExempt) && ids(k).includes(kExemptLate));
  ok("K1 the window's start still applies to EXEMPT_DEALER documents", !ids(k).includes(kExemptBefore));
  const kCount = await billingTenantTx(K.businessId, (tx) => svc.countInterimDocumentsTx(tx, { businessId: K.businessId, fromDate: "2026-05-01", to: kConfirmed }));
  ok("K1 countInterimDocumentsTx applies the same rule (2)", kCount === 2 && k.ok && k.result.count === 2, { kCount });

  // ================================================================== B2 summer, before any transition
  console.log("\n— B2 summer bounds (UTC+3), before any transition: requested date → now");
  const S = await business("EXEMPT_DEALER", "31000001");
  const sOut = await seed(S, "RECEIPT", "ISSUED", "2026-07-14T20:59:59.999Z");
  const sIn = await seed(S, "RECEIPT", "ISSUED", "2026-07-14T21:00:00.000Z");
  const sNowish = new Date("2026-08-01T12:00:00.000Z");
  const sInEnd = await seed(S, "RECEIPT", "ISSUED", "2026-08-01T11:59:59.999Z");
  const sOutEnd = await seed(S, "RECEIPT", "ISSUED", "2026-08-01T12:00:00.000Z");
  const s = await read(S, { from: "2026-07-15", now: sNowish, list: true });
  observed("B2 result", s.ok ? { range: s.result.range, count: s.result.count, ids: ids(s) } : s);
  ok("B2 00:00 local (21:00Z the day before) counted, 20:59:59.999Z not", ids(s).includes(sIn) && !ids(s).includes(sOut));
  ok("B2 before the transition the window ends at now (exclusive)", ids(s).includes(sInEnd) && !ids(s).includes(sOutEnd) && s.ok && s.result.range.source === "REQUEST");
  const sNoDate = await read(S, {});
  ok("B2 no transition and no date → FROM_DATE_REQUIRED", !sNoDate.ok && sNoDate.code === "FROM_DATE_REQUIRED");

  // ================================================================== C1 credit
  console.log("\n— C1 credit state");
  const C = await business("EXEMPT_DEALER", "31000002");
  const full = await seed(C, "TAX_INVOICE", "ISSUED", "2026-03-02T10:00:00.000Z", "118.00");
  const part = await seed(C, "TAX_INVOICE", "ISSUED", "2026-03-03T10:00:00.000Z", "118.00");
  const rcp = await seed(C, "RECEIPT", "ISSUED", "2026-03-04T10:00:00.000Z", "100.00");
  const cnFull = await seed(C, "CREDIT_NOTE", "ISSUED", "2026-03-05T10:00:00.000Z", "118.00", full);
  const cnPart = await seed(C, "CREDIT_NOTE", "ISSUED", "2026-05-05T10:00:00.000Z", "50.00", part); // after the window: still reported
  await seed(C, "CREDIT_NOTE", "DRAFT", null, "68.00", part); // a draft credit note never counts toward the credit
  const cnRcp = await seed(C, "CREDIT_NOTE", "ISSUED", "2026-03-06T10:00:00.000Z", "100.00", rcp);
  await transitionRow(C, "2026-03-01", "2026-04-01T00:00:00.000Z");
  const c = await read(C, { list: true });
  const st = (id: number) => (c.ok ? (c.result.items ?? []).find((i) => i.id === id)?.creditState : undefined);
  observed("C1 items", c.ok ? (c.result.items ?? []).map((i) => [i.id, i.documentType, i.creditState, i.creditedAmount]) : c);
  ok("C1 invoice credited for its total → FULL", st(full) === "FULL");
  ok("C1 invoice credited for part (a later credit note counts; a draft one does not) → PARTIAL, not FULL", st(part) === "PARTIAL");
  ok("C1 a credit note naming a receipt → LINKED only", st(rcp) === "LINKED");
  ok("C1 credit notes issued in the window are themselves counted; one issued after it is not", ids(c).includes(cnFull) && ids(c).includes(cnRcp) && !ids(c).includes(cnPart));
  ok("C1 summary counts", c.ok && JSON.stringify(c.result.credit) === JSON.stringify({ full: 1, partial: 1, linked: 1 }), c.ok ? c.result.credit : c);

  // ================================================================== I1 isolation
  console.log("\n— I1 isolation");
  const O = await business("EXEMPT_DEALER", "31000003");
  await seed(O, "RECEIPT", "ISSUED", "2026-01-20T08:00:00.000Z");
  await seed(O, "RECEIPT", "ISSUED", "2026-01-21T08:00:00.000Z");
  const wAgain = await read(W, {});
  ok("I1 another business's documents in the same window are not counted", wAgain.ok && wAgain.result.count === 3);
  const cross = await billingTenantTx(O.businessId, (tx) => svc.countInterimDocumentsTx(tx, { businessId: W.businessId, fromDate: "2026-01-15", to: wConfirmed }));
  ok("I1 asking for business W inside business O's tenant transaction sees nothing (FORCE RLS)", cross === 0, cross);
  const crossRead = await read(W, { tenant: O.businessId });
  ok("I1 …and the transition record of W is invisible there too (FROM_DATE_REQUIRED)", !crossRead.ok);

  // ================================================================== R1 read only
  console.log("\n— R1 read only");
  const ro = await billingTenantTx(W.businessId, async (tx) => {
    await tx.$executeRawUnsafe(`SET TRANSACTION READ ONLY`);
    const a = await svc.readInterimDocumentsTx(tx, { businessId: W.businessId, requestedFromDate: null, now: new Date(), list: true });
    const b = await svc.countInterimDocumentsTx(tx, { businessId: W.businessId, fromDate: "2026-01-15", to: wConfirmed });
    return { a: a.ok ? a.result.count : -1, b };
  });
  ok("R1 the full read (count, credit, list) and the count run inside a READ ONLY transaction", ro.a === 3 && ro.b === 3, ro);
  const priv = (await owner.$queryRawUnsafe(`SELECT
      has_table_privilege('app_runtime','"BusinessKindTransition"','INSERT,UPDATE,DELETE') AS bkt_write,
      has_table_privilege('app_runtime','"BusinessKindTransition"','SELECT') AS bkt_read`)) as Rows;
  ok("R1 the runtime reads BusinessKindTransition and holds no write privilege on it", priv[0].bkt_read === true && priv[0].bkt_write === false, priv[0]);

  // ================================================================== H1 route
  console.log("\n— H1 route handler (real read path)");
  const deps = { ...defaultInterimDocumentsDeps, enabled: () => true, context: async () => ({ user: { id: W.userId, businessId: W.businessId } }) };
  const r1 = await handleInterimDocumentsGet(new Request("http://x/api/billing/kind-transition/interim-documents?list=1"), deps);
  const j1 = await r1.json();
  ok("H1 200 with the record's range and the count", r1.status === 200 && j1.count === 3 && j1.range.source === "TRANSITION_RECORD" && j1.items.length === 3, { s: r1.status, c: j1.count });
  delete process.env.BUSINESS_KIND_TRANSITION_ENABLED;
  const r2 = await handleInterimDocumentsGet(new Request("http://x/api/billing/kind-transition/interim-documents?list=1"), { ...defaultInterimDocumentsDeps, context: deps.context });
  ok("H1 flag unset (Production today) → 404", r2.status === 404);

  // ================================================================== L1 coordination with issuance
  console.log("\n— L1 coordination with issuance (the transition key)");
  const X = await business("EXEMPT_DEALER", "31000004");
  const issueDeps = { executeApproval: async () => ({ outcome: "completed_approved", billingDocumentId: 0, submissionId: -1, allocationNumber: null, safeToRetry: false }) } as never;
  const receiptDraft = async (b: Biz) => (await createReceiptDraft({ businessId: b.businessId, actorUserId: b.userId, documentType: BillingDocumentType.RECEIPT, customerId: b.privateId, currency: "ILS",
    paymentLines: [{ method: "CASH", amount: "10.00", paymentDate: new Date().toISOString() }] } as never)).id;
  const d1 = await receiptDraft(X);
  const d2 = await receiptDraft(X);
  const d3 = await receiptDraft(X);
  // Issuances share the key: two in parallel both complete.
  const t0 = Date.now();
  await Promise.all([issueBillingDocument({ businessId: X.businessId, billingDocumentId: d1, actorUserId: X.userId }, issueDeps),
                     issueBillingDocument({ businessId: X.businessId, billingDocumentId: d2, actorUserId: X.userId }, issueDeps)]);
  ok("L1 two issuances of one business run together (shared key)", Date.now() - t0 < 15_000);
  // Hold the key exclusively in another session, as the transition does.
  let released = false;
  let issuedWhileHeld: string | null = null;
  const holder = owner.$transaction(async (t) => {
    await t.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtextextended('legal_identity:' || $1::int, 0))`, X.businessId);
    await sleep(2500);
    const row = ((await t.$queryRawUnsafe(`SELECT "documentNumber" n, status::text s FROM "BillingDocument" WHERE id = $1`, d3)) as Rows)[0];
    issuedWhileHeld = `${row.s}/${row.n}`;
    released = true;
  }, { timeout: 30_000, maxWait: 30_000 });
  await sleep(400);
  const tIssue = Date.now();
  const issuing = issueBillingDocument({ businessId: X.businessId, billingDocumentId: d3, actorUserId: X.userId }, issueDeps).then(() => ({ at: Date.now(), released }));
  await holder;
  const done = await issuing;
  ok("L1 while the key is held exclusively the issuance waits: still a DRAFT with no number", issuedWhileHeld === "DRAFT/null", issuedWhileHeld);
  ok("L1 the issuance completes only after the key is released", done.released === true && done.at - tIssue >= 1500, { waitedMs: done.at - tIssue });
  const d3row = ((await owner.$queryRawUnsafe(`SELECT status::text s, "documentNumber" n FROM "BillingDocument" WHERE id = $1`, d3)) as Rows)[0];
  ok("L1 …and then issues normally (number 3)", d3row.s === "ISSUED" && d3row.n === 3, d3row);

  // ================================================================== L2 the real transition racing issuances
  console.log("\n— L2 the real transition racing parallel issuances");
  const Y = await business("EXEMPT_DEALER", "31000005");
  const drafts: number[] = [];
  for (let i = 0; i < 6; i++) drafts.push(await receiptDraft(Y)); // setup, sequential
  const date = israelToday();
  const sha256 = kindTransitionStatementSha256({ businessId: Y.businessId, actorUserId: Y.userId, legalName: "דנה כהן", taxId: Y.taxId, vatNumber: Y.taxId, statusEffectiveDate: date });
  const results = await Promise.allSettled([
    ...drafts.slice(0, 3).map((id) => issueBillingDocument({ businessId: Y.businessId, billingDocumentId: id, actorUserId: Y.userId }, issueDeps)),
    performKindTransition(Y.businessId, Y.userId, { vatNumber: Y.taxId, statusEffectiveDate: date, reauthMethod: "PASSWORD", reauthAt: new Date(), statementSha256: sha256 }),
    ...drafts.slice(3).map((id) => issueBillingDocument({ businessId: Y.businessId, billingDocumentId: id, actorUserId: Y.userId }, issueDeps)),
  ]);
  observed("L2 outcomes", results.map((r) => (r.status === "fulfilled" ? (typeof r.value === "string" ? r.value : "issued") : `rejected: ${String((r.reason as Error)?.message).slice(0, 80)}`)));
  const yDocs = (await owner.$queryRawUnsafe(`SELECT id, "issuedAt" at, "issuedSnapshot"->'extensions'->>'billingBusinessKind' k FROM "BillingDocument" WHERE "businessId" = $1 AND status = 'ISSUED'`, Y.businessId)) as Rows;
  const yRead = await read(Y, { list: true });
  const counted = new Set(ids(yRead));
  observed("L2 documents", yDocs.map((d) => [Number(d.id), String(d.k), counted.has(Number(d.id))]));
  ok("L2 the transition succeeded", results.some((r) => r.status === "fulfilled" && r.value === "TRANSITIONED"));
  ok("L2 every counted document froze EXEMPT_DEALER", yDocs.filter((d) => counted.has(Number(d.id))).every((d) => d.k === "EXEMPT_DEALER"));
  ok("L2 every document that froze EXEMPT_DEALER is counted", yDocs.filter((d) => d.k === "EXEMPT_DEALER").every((d) => counted.has(Number(d.id))));

  ok("network: no fetch was attempted", networkAttempts === 0, networkAttempts);
  console.log(`\nT4 interim-documents battery: ${pass} passed, ${failures.length} failed`);
  if (failures.length) { console.log("FAILED:\n  " + failures.join("\n  ")); process.exitCode = 1; }
  await owner.$disconnect();
  await runtime.$disconnect();
}

main().catch(async (e) => { console.error(e); process.exitCode = 1; await owner.$disconnect(); });
void Prisma;
