/**
 * Revenue truth — the application code (lib/revenue-truth) on the migrated lab database, as the RUNTIME role
 * (app_runtime_prod: NOSUPERUSER NOBYPASSRLS) through tenantTx — the path a future consumer would take.
 *
 *   A. Idempotent ingestion: the same event is one row (DUPLICATE); the same key with a changed payload is
 *      CONFLICT and writes nothing; a Z replay adds no lines.
 *   B. An invoice and its payment, written by the EXISTING code (BillingDocument + PaymentTransaction + the system
 *      receipt, and the existing FinancialEvent writers): FinancialEvent holds TWO income rows exactly as today,
 *      the revenue view counts ONE sale and ONE receipt.
 *   C. A POS sale and the day's Z: one sale; a bank credit: no sale; installments: no growth.
 *   D. Decisions: transitions, idempotency, over-allocation refused under the lock, a rejected pair stays rejected.
 *   E. Tenant isolation through the app code: another business sees nothing and cannot reference anything.
 *   F. Currencies are never added together.
 *   H. Evidence recorded in error: rejection only when nothing confirmed still stands on it; idempotent; never
 *      CONFIRMED; links on it refused; restore; sale / receipt dependencies; a race won by exactly one; tenancy.
 *   G. The existing systems are byte-identical before and after every revenue write.
 *
 * env: OWNER_URL (fixtures, BYPASSRLS), RUNTIME_URL (the app). Synthetic only. ZERO network.
 */
const RUNTIME_URL = process.env.RUNTIME_URL?.trim();
const OWNER_URL = process.env.OWNER_URL?.trim();
if (!RUNTIME_URL || !OWNER_URL || !/^postgres(ql)?:\/\//i.test(RUNTIME_URL) || /neon\.tech|vercel/i.test(RUNTIME_URL + OWNER_URL)) {
  console.error("ABORT (DB safety guard): OWNER_URL and RUNTIME_URL must name the ephemeral lab database.");
  process.exit(1);
}
process.env.DATABASE_URL = RUNTIME_URL;

import { PrismaClient } from "@prisma/client";

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { failures.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}
const J = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x instanceof Map ? Object.fromEntries(x) : x));
const B = (n: number) => BigInt(n);
async function rejects(fn: () => Promise<unknown>): Promise<string> {
  try { await fn(); return ""; } catch (e) { return e instanceof Error ? e.message : String(e); }
}
let seq = 0;
const key = (p: string) => `${p}${Date.now().toString(36)}${(++seq).toString().padStart(4, "0")}`;

async function main() {
  const owner = new PrismaClient({ datasourceUrl: OWNER_URL });
  const { prisma } = await import("@/lib/prisma");
  const { tenantTx } = await import("@/lib/tenant/tenant-tx");
  const store = await import("@/lib/revenue-truth/store");
  const { readRevenueView } = await import("@/lib/revenue-truth/sources");
  const { requireSingleCurrency } = await import("@/lib/revenue-truth/read-model");
  const { CurrencyMismatchError } = await import("@/lib/money/money");
  const { ensureBillingInvoicePostedEvent, ensurePaymentPostedEvent } = await import("@/lib/services/financial-events/financial-event.service");

  const window = { fromDay: "2026-10-01", toDay: "2026-10-31" };
  const NOW = new Date("2026-10-23T12:00:00.000Z");
  const mk = async (sql: string, ...args: unknown[]) => Number(((await owner.$queryRawUnsafe(sql, ...args)) as { id: number }[])[0].id);
  const bizA = await mk(`INSERT INTO "Business" ("name", "updatedAt") VALUES ('rev-app-A', now()) RETURNING "id"`);
  const bizB = await mk(`INSERT INTO "Business" ("name", "updatedAt") VALUES ('rev-app-B', now()) RETURNING "id"`);
  const pos = (biz: number, ext: string, o: Partial<import("@/lib/revenue-truth/store").SaleInput> = {}) => store.recordSale(biz, {
    sourceKind: "POS", capture: "API_PUSH", sourceScope: "pos.lab", externalId: ext, kind: "SALE", occurredAt: new Date("2026-10-20T08:00:00Z"),
    businessDay: "2026-10-20", registerKey: "r1", currency: "ILS", grossMinor: B(11800), vatMinor: B(1800), ...o,
  });

  const existing = async () => J(await owner.$queryRawUnsafe(
    `SELECT (SELECT coalesce(md5(string_agg(t::text, '|' ORDER BY t."id")), '-') FROM "FinancialEvent" t) AS fe,
            (SELECT coalesce(md5(string_agg(t::text, '|' ORDER BY t."id")), '-') FROM "FinancialRecord" t) AS fr,
            (SELECT coalesce(md5(string_agg(t::text, '|' ORDER BY t."id")), '-') FROM "BillingDocument" t) AS bd,
            (SELECT coalesce(md5(string_agg(t::text, '|' ORDER BY t."id")), '-') FROM "PaymentTransaction" t) AS pt,
            (SELECT coalesce(md5(string_agg(t::text, '|' ORDER BY t."id")), '-') FROM "ExternalTransaction" t) AS et`));

  // ── B (fixtures first). An invoice and its payment, through the EXISTING writers ─────────────────
  console.log("B. invoice + payment: FinancialEvent books two incomes, revenue truth one sale");
  const issuedAt = new Date("2026-10-15T09:00:00Z");
  const invoice = await owner.billingDocument.create({
    data: { businessId: bizA, documentType: "TAX_INVOICE", status: "ISSUED", documentNumber: 900001, currency: "ILS", subtotalAmount: "100.00", vatAmount: "18.00", totalAmount: "118.00", issuedAt },
  });
  const request = await owner.paymentRequest.create({ data: { businessId: bizA, billingDocumentId: invoice.id, provider: "CARDCOM", amount: "118.00", currency: "ILS", status: "PAID", paidAt: issuedAt } });
  const payment = await owner.paymentTransaction.create({ data: { paymentRequestId: request.id, provider: "CARDCOM", providerTransactionId: key("cc"), amount: "118.00", currency: "ILS", status: "PAID", createdAt: issuedAt } });
  await owner.billingDocument.create({
    data: { businessId: bizA, documentType: "RECEIPT", status: "ISSUED", documentNumber: 900002, currency: "ILS", subtotalAmount: "118.00", vatAmount: "0", totalAmount: "118.00", issuedAt, sourcePaymentTransactionId: payment.id },
  });
  await tenantTx(bizA, async (tx) => {
    await ensureBillingInvoicePostedEvent(tx, invoice);
    await ensurePaymentPostedEvent(tx, { businessId: bizA, paymentRequestId: request.id, transactionId: payment.id, amount: "118.00", currency: "ILS", occurredAt: issuedAt });
  });
  const feIncome = await owner.financialEvent.count({ where: { businessId: bizA, direction: "INCOME" } });
  ok("the existing FinancialEvent writers still book the invoice AND its payment as two INCOME rows (unchanged)", feIncome === 2, String(feIncome));
  const vB = (await readRevenueView(bizA, window, NOW)).view.byCurrency.get("ILS")!;
  ok("revenue truth: ONE sale of 118.00 (11800), VAT 1800", vB.sales.netMinor === B(11800) && vB.sales.vatMinor === B(1800), J(vB.sales));
  ok("revenue truth: ONE receipt of 11800 (the system receipt for the payment is the same receipt)", vB.receipts.inMinor === B(11800), J(vB.receipts));

  const before = await existing();

  // ── A. Idempotent ingestion ────────────────────────────────────────────────────────────────────
  console.log("A. idempotent ingestion");
  const hash1 = "a".repeat(64);
  const first = await pos(bizA, "sale-1", { sourcePayloadHash: hash1 });
  const again = await pos(bizA, "sale-1", { sourcePayloadHash: hash1 });
  const changed = await pos(bizA, "sale-1", { sourcePayloadHash: "b".repeat(64), grossMinor: B(99999) });
  const rows = await owner.revenueSale.count({ where: { businessId: bizA, externalId: "sale-1" } });
  ok("first delivery CREATED", first.status === "CREATED", J(first));
  ok("the same delivery again is DUPLICATE, same id", again.status === "DUPLICATE" && again.id === first.id, J(again));
  ok("the same key with a changed payload is CONFLICT and writes nothing (one row, original amount)",
    changed.status === "CONFLICT" && rows === 1 && (await owner.revenueSale.findUniqueOrThrow({ where: { id: first.id } })).grossMinor === B(11800), J(changed));
  const z = {
    sourceKind: "POS" as const, capture: "FILE_STRUCTURED" as const, sourceScope: "upload.z", externalId: "z-1041", salesScope: "pos.lab", registerKey: "r1",
    zNumber: B(1041), businessDay: "2026-10-20", currency: "ILS", grossMinor: B(11800), vatMinor: B(1800), validation: "PASSED" as const,
    tenders: [{ method: "CARD" as const, amountMinor: B(11800), label: "visa" }], vatLines: [{ category: "STANDARD" as const, rateBasisPoints: 1800, taxableMinor: B(10000), vatMinor: B(1800) }],
  };
  const z1 = await store.recordDailyClose(bizA, z);
  const z1again = await store.recordDailyClose(bizA, z);
  const lines = await owner.revenueDailyCloseTender.count({ where: { dailyCloseId: z1.id } }) + await owner.revenueDailyCloseVat.count({ where: { dailyCloseId: z1.id } });
  ok("a Z replay is DUPLICATE and adds no tender / VAT line (2 lines, not 4)", z1.status === "CREATED" && z1again.status === "DUPLICATE" && lines === 2, J({ z1, z1again, lines }));

  // ── C. One sale across layers ──────────────────────────────────────────────────────────────────
  console.log("C. one sale across layers");
  const vC = (await readRevenueView(bizA, window, NOW)).view;
  const ilsC = vC.byCurrency.get("ILS")!;
  ok("POS sale + its Z + the invoice/payment: net = 11800 (Z) + 11800 (invoice) = 23600, not 35400",
    ilsC.sales.netMinor === B(23600), J(ilsC.sales));
  ok("the register day is CLOSED with zero variance", vC.days.length === 1 && vC.days[0].status === "CLOSED" && vC.days[0].varianceMinor === B(0), J(vC.days));
  const credit = await mk(`INSERT INTO "ExternalTransaction" ("businessId", "source", "externalId", "direction", "amount", "currency", "bookedAt", "updatedAt")
    VALUES ($1, 'OWNER_UPLOAD', $2, 'CREDIT', 115.00, 'ILS', TIMESTAMP '2026-10-22 08:00', now()) RETURNING "id"`, bizA, key("bank"));
  const vBank = (await readRevenueView(bizA, window, NOW)).view.byCurrency.get("ILS")!;
  ok("a bank credit adds no sale (net still 23600) and shows as unmatched money in (11500)",
    vBank.sales.netMinor === B(23600) && vBank.deposits.unmatchedMinor === B(11500), J(vBank.deposits));
  const tenderId = (await owner.revenueDailyCloseTender.findFirstOrThrow({ where: { dailyCloseId: z1.id, method: "CARD" } })).id;
  const settlements: import("@/lib/revenue-truth/store").WriteResult[] = [];
  for (const n of [1, 2, 3]) {
    settlements.push(await store.recordSettlement(bizA, {
      sourceKind: "ACQUIRER", capture: "FILE_STRUCTURED", sourceScope: "upload.isracard", externalId: `st-${n}`, acquirer: "isracard",
      valueDate: "2026-10-22", currency: "ILS", grossMinor: n < 3 ? B(3933) : B(3934), feeMinor: B(33), installmentNumber: n, installmentCount: 3, validation: "PASSED",
    }));
  }
  const tenderLinks = [];
  for (const st of settlements) {
    const holds = (await owner.revenueSettlement.findUniqueOrThrow({ where: { id: st.id } })).grossMinor;
    const l = await store.proposeLink(bizA, { linkKind: "TENDER_SETTLED_BY", dailyCloseTenderId: tenderId, settlementId: st.id, amountMinor: holds, currency: "ILS", basis: "RULE_EXACT", proposedBy: "SYSTEM" });
    tenderLinks.push(l);
    await store.recordDecision(bizA, { subject: { linkId: l.id }, decision: "CONFIRMED", actor: "SYSTEM", idempotencyKey: key("dec") });
  }
  const vInst = (await readRevenueView(bizA, window, NOW)).view.byCurrency.get("ILS")!;
  ok("three installments settled: net sales unchanged (23600), card awaiting settlement 0, fees 99",
    vInst.sales.netMinor === B(23600) && vInst.inTransit.cardAwaitingSettlementMinor === B(0) && vInst.settlements.feesMinor === B(99), J({ s: vInst.sales.netMinor, t: vInst.inTransit, f: vInst.settlements.feesMinor }));

  // ── D. Decisions ───────────────────────────────────────────────────────────────────────────────
  console.log("D. decisions");
  const dep = await store.proposeLink(bizA, { linkKind: "SETTLEMENT_DEPOSITED_AS", settlementId: settlements[0].id, externalTransactionId: credit, amountMinor: B(3900), currency: "ILS", basis: "RULE_TOLERANCE", proposedBy: "SYSTEM" });
  const depAgain = await store.proposeLink(bizA, { linkKind: "SETTLEMENT_DEPOSITED_AS", settlementId: settlements[0].id, externalTransactionId: credit, amountMinor: B(3900), currency: "ILS", basis: "RULE_TOLERANCE", proposedBy: "SYSTEM" });
  ok("a pair is proposed once (ALREADY_PROPOSED, same id)", dep.status === "PROPOSED" && depAgain.status === "ALREADY_PROPOSED" && depAgain.id === dep.id);
  const idem = key("dec");
  const c1 = await store.recordDecision(bizA, { subject: { linkId: dep.id }, decision: "CONFIRMED", actor: "OWNER_USER", idempotencyKey: idem });
  const c2 = await store.recordDecision(bizA, { subject: { linkId: dep.id }, decision: "CONFIRMED", actor: "OWNER_USER", idempotencyKey: idem });
  ok("a decision retried with its key is DUPLICATE (one row)", c1.status === "RECORDED" && c2.status === "DUPLICATE" && c2.id === c1.id);
  const twice = await rejects(() => store.recordDecision(bizA, { subject: { linkId: dep.id }, decision: "CONFIRMED", actor: "OWNER_USER", idempotencyKey: key("dec") }));
  ok("CONFIRMED → CONFIRMED is refused (INVALID_TRANSITION)", /INVALID_TRANSITION/.test(twice), twice);
  const dep2 = await store.proposeLink(bizA, { linkKind: "SETTLEMENT_DEPOSITED_AS", settlementId: settlements[1].id, externalTransactionId: credit, amountMinor: B(3900), currency: "ILS", basis: "RULE_TOLERANCE", proposedBy: "SYSTEM" });
  await store.recordDecision(bizA, { subject: { linkId: dep2.id }, decision: "CONFIRMED", actor: "OWNER_USER", idempotencyKey: key("dec") });
  const dep3 = await store.proposeLink(bizA, { linkKind: "SETTLEMENT_DEPOSITED_AS", settlementId: settlements[2].id, externalTransactionId: credit, amountMinor: B(3901), currency: "ILS", basis: "RULE_TOLERANCE", proposedBy: "SYSTEM" });
  const over = await rejects(() => store.recordDecision(bizA, { subject: { linkId: dep3.id }, decision: "CONFIRMED", actor: "OWNER_USER", idempotencyKey: key("dec") }));
  ok("confirming a third deposit link past the bank line (3900 + 3900 + 3901 > 11500) is refused (OVER_ALLOCATION)", /OVER_ALLOCATION/.test(over), over);
  // Two concurrent confirmations that each fit alone but not together: the lock lets exactly one through.
  const st4 = await store.recordSettlement(bizA, { sourceKind: "ACQUIRER", capture: "FILE_STRUCTURED", sourceScope: "upload.max", externalId: "st-race", acquirer: "max", valueDate: "2026-10-22", currency: "ILS", grossMinor: B(3700), validation: "PASSED" });
  const st5 = await store.recordSettlement(bizA, { sourceKind: "ACQUIRER", capture: "FILE_STRUCTURED", sourceScope: "upload.max", externalId: "st-race-2", acquirer: "max", valueDate: "2026-10-22", currency: "ILS", grossMinor: B(3700), validation: "PASSED" });
  const ra = await store.proposeLink(bizA, { linkKind: "SETTLEMENT_DEPOSITED_AS", settlementId: st4.id, externalTransactionId: credit, amountMinor: B(3700), currency: "ILS", basis: "RULE_TOLERANCE", proposedBy: "SYSTEM" });
  const rb = await store.proposeLink(bizA, { linkKind: "SETTLEMENT_DEPOSITED_AS", settlementId: st5.id, externalTransactionId: credit, amountMinor: B(3700), currency: "ILS", basis: "RULE_TOLERANCE", proposedBy: "SYSTEM" });
  const race = await Promise.allSettled([
    store.recordDecision(bizA, { subject: { linkId: ra.id }, decision: "CONFIRMED", actor: "SYSTEM", idempotencyKey: key("dec") }),
    store.recordDecision(bizA, { subject: { linkId: rb.id }, decision: "CONFIRMED", actor: "SYSTEM", idempotencyKey: key("dec") }),
  ]);
  const won = race.filter((r) => r.status === "fulfilled").length;
  const lost = race.filter((r) => r.status === "rejected" && /OVER_ALLOCATION/.test(String((r as PromiseRejectedResult).reason))).length;
  ok("two concurrent confirmations that only fit one at a time: exactly one wins, the other is OVER_ALLOCATION", won === 1 && lost === 1, J(race.map((r) => r.status)));
  await store.recordDecision(bizA, { subject: { linkId: dep3.id }, decision: "REJECTED", actor: "OWNER_USER", idempotencyKey: key("dec") });
  const revive = await rejects(() => store.recordDecision(bizA, { subject: { linkId: dep3.id }, decision: "CONFIRMED", actor: "OWNER_USER", idempotencyKey: key("dec") }));
  ok("a REJECTED link can never be confirmed again", /INVALID_TRANSITION/.test(revive), revive);
  const vD = (await readRevenueView(bizA, window, NOW)).view.byCurrency.get("ILS")!;
  ok("after the deposits: net sales STILL 23600; bank 11500 = 11500 matched", vD.sales.netMinor === B(23600) && vD.deposits.matchedMinor === B(11500) && vD.deposits.unmatchedMinor === B(0), J(vD.deposits));

  // ── E. Tenant isolation through the app code ───────────────────────────────────────────────────
  console.log("E. tenant isolation");
  const vOther = (await readRevenueView(bizB, window, NOW)).view;
  ok("business B's view is empty: nothing of A is visible through the app code", vOther.byCurrency.size === 0 && vOther.days.length === 0, J(vOther));
  const crossRefund = await rejects(() => pos(bizB, "b-refund", { kind: "REFUND", originalSaleId: first.id, grossMinor: B(100), vatMinor: B(0) }));
  ok("B cannot record a refund of A's sale (composite key)", /foreign key|23503|constraint/i.test(crossRefund), crossRefund);
  const crossLink = await rejects(() => store.proposeLink(bizB, { linkKind: "SETTLEMENT_DEPOSITED_AS", settlementId: settlements[0].id, externalTransactionId: credit, amountMinor: B(1), currency: "ILS", basis: "OWNER_MANUAL", proposedBy: "OWNER_USER" }));
  ok("B cannot link A's settlement to A's bank line (guard / composite key)", /REVENUE_LINK_|foreign key|23503/i.test(crossLink), crossLink);
  const crossDecision = await rejects(() => store.recordDecision(bizB, { subject: { linkId: dep.id }, decision: "REVOKED", actor: "OWNER_USER", idempotencyKey: key("dec") }));
  ok("B cannot decide on A's link (NOT_FOUND under B's RLS)", /NOT_FOUND/.test(crossDecision), crossDecision);
  const sameExtInB = await pos(bizB, "sale-1");
  ok("the same external id in B is B's own new row", sameExtInB.status === "CREATED" && sameExtInB.id !== first.id);
  const noContext = await rejects(() => prisma.revenueSale.findMany({ where: { businessId: bizA } }).then((r) => { if (r.length > 0) throw new Error(`context-less read returned ${r.length} row(s)`); }));
  ok("a context-less read through the app client returns nothing (FORCE RLS)", noContext === "", noContext);

  // ── F. Currencies ──────────────────────────────────────────────────────────────────────────────
  console.log("F. currencies");
  await pos(bizA, "usd-1", { sourceScope: "pos.us", currency: "USD", grossMinor: B(5000), vatMinor: B(763) });
  const vF = (await readRevenueView(bizA, window, NOW)).view;
  ok("ILS and USD stay apart (ILS 23600, USD 5000)", vF.byCurrency.get("ILS")!.sales.netMinor === B(23600) && vF.byCurrency.get("USD")!.sales.netMinor === B(5000));
  const mixed = await rejects(async () => requireSingleCurrency(vF));
  ok("one figure over ILS + USD throws CurrencyMismatchError", mixed !== "" && (() => { try { requireSingleCurrency(vF); return false; } catch (e) { return e instanceof CurrencyMismatchError; } })(), mixed);

  // ── H. Evidence recorded in error ──────────────────────────────────────────────────────────────
  console.log("H. evidence recorded in error");
  const bizH = await mk(`INSERT INTO "Business" ("name", "updatedAt") VALUES ('rev-app-H', now()) RETURNING "id"`);
  const vH = async () => (await readRevenueView(bizH, window, NOW)).view;
  const ilsH = async () => (await vH()).byCurrency.get("ILS")!;
  const dec = (subject: import("@/lib/revenue-truth/store").DecisionInput["subject"], decision: "CONFIRMED" | "REJECTED" | "REVOKED", k = key("dec")) =>
    store.recordDecision(bizH, { subject, decision, actor: "OWNER_USER", idempotencyKey: k });
  const hSale = await pos(bizH, "h-sale", { grossMinor: B(20000), vatMinor: B(3051) });
  const hReceipt = await store.recordReceipt(bizH, { sourceKind: "POS", capture: "API_PUSH", sourceScope: "pos.lab", externalId: "h-rcpt", saleId: hSale.id, direction: "IN", method: "CARD", receivedAt: new Date("2026-10-20T08:00:00Z"), businessDay: "2026-10-20", registerKey: "r1", currency: "ILS", amountMinor: B(20000) });
  const hSt = await store.recordSettlement(bizH, { sourceKind: "ACQUIRER", capture: "FILE_STRUCTURED", sourceScope: "upload.max", externalId: "h-st-dup", acquirer: "max", valueDate: "2026-10-22", currency: "ILS", grossMinor: B(20000), feeMinor: B(200), validation: "PASSED" });
  const hBank = await mk(`INSERT INTO "ExternalTransaction" ("businessId", "source", "externalId", "direction", "amount", "currency", "bookedAt", "updatedAt")
    VALUES ($1, 'OWNER_UPLOAD', $2, 'CREDIT', 198.00, 'ILS', TIMESTAMP '2026-10-22 09:00', now()) RETURNING "id"`, bizH, key("bank"));
  const lSettle = await store.proposeLink(bizH, { linkKind: "TENDER_SETTLED_BY", receiptId: hReceipt.id, settlementId: hSt.id, amountMinor: B(20000), currency: "ILS", basis: "RULE_EXACT", proposedBy: "SYSTEM" });
  const lDeposit = await store.proposeLink(bizH, { linkKind: "SETTLEMENT_DEPOSITED_AS", settlementId: hSt.id, externalTransactionId: hBank, amountMinor: B(19800), currency: "ILS", basis: "RULE_EXACT", proposedBy: "SYSTEM" });
  await dec({ linkId: lSettle.id }, "CONFIRMED");
  await dec({ linkId: lDeposit.id }, "CONFIRMED");
  const stRowBefore = J(await owner.revenueSettlement.findUniqueOrThrow({ where: { id: hSt.id } }));

  const blocked = await rejects(() => dec({ settlementId: hSt.id }, "REJECTED"));
  ok("rejecting a settlement that confirmed links still name is refused (HAS_CONFIRMED_LINKS) — no match may stand on excluded money", /HAS_CONFIRMED_LINKS/.test(blocked), blocked);
  await dec({ linkId: lSettle.id }, "REVOKED");
  await dec({ linkId: lDeposit.id }, "REVOKED");
  const rejKey = key("dec");
  const r1 = await dec({ settlementId: hSt.id }, "REJECTED", rejKey);
  const r1again = await dec({ settlementId: hSt.id }, "REJECTED", rejKey);
  ok("with the links revoked the rejection is RECORDED; retried with its key it is DUPLICATE (one row)", r1.status === "RECORDED" && r1again.status === "DUPLICATE" && r1again.id === r1.id, J({ r1, r1again }));
  const r2 = await rejects(() => dec({ settlementId: hSt.id }, "REJECTED"));
  ok("rejecting it again under a new key is refused (REJECTED → REJECTED is not a transition)", /INVALID_TRANSITION/.test(r2), r2);
  const conf = await rejects(() => dec({ settlementId: hSt.id }, "CONFIRMED"));
  ok("evidence is never CONFIRMED (INVALID_TRANSITION)", /INVALID_TRANSITION/.test(conf), conf);
  const relink = await rejects(() => dec({ linkId: lSettle.id }, "CONFIRMED"));
  ok("confirming a link on the rejected settlement is refused (REJECTED_EVIDENCE)", /REJECTED_EVIDENCE/.test(relink), relink);
  const afterRej = await ilsH();
  ok("the rejected settlement counts nowhere: no settlement gross, card awaiting settlement 20000, bank credit unmatched 19800",
    afterRej.settlements.grossMinor === B(0) && afterRej.inTransit.cardAwaitingSettlementMinor === B(20000) && afterRej.deposits.unmatchedMinor === B(19800), J({ s: afterRej.settlements, t: afterRej.inTransit, d: afterRej.deposits }));
  ok("the settlement row is byte-identical after its rejection (kept, never edited)", J(await owner.revenueSettlement.findUniqueOrThrow({ where: { id: hSt.id } })) === stRowBefore);
  ok("the settlement's own decision history is exactly the one rejection (the revocations are on the links)", (await owner.revenueDecision.findMany({ where: { businessId: bizH, settlementId: hSt.id } })).map((d) => d.decision).join(",") === "REJECTED");
  await dec({ settlementId: hSt.id }, "REVOKED");
  await dec({ linkId: lSettle.id }, "CONFIRMED");
  const restored = await ilsH();
  ok("the rejection REVOKED and the link re-confirmed: the settlement counts again and closes the card again", restored.settlements.grossMinor === B(20000) && restored.inTransit.cardAwaitingSettlementMinor === B(0), J(restored.inTransit));

  const saleBlocked = await rejects(() => dec({ saleId: hSale.id }, "REJECTED"));
  ok("rejecting a sale that a live receipt still pays is refused (HAS_LIVE_DEPENDENTS)", /HAS_LIVE_DEPENDENTS|HAS_CONFIRMED_LINKS/.test(saleBlocked), saleBlocked);
  await dec({ linkId: lSettle.id }, "REVOKED");
  await dec({ receiptId: hReceipt.id }, "REJECTED");
  const saleOk = await dec({ saleId: hSale.id }, "REJECTED");
  ok("receipt rejected first, then the sale: RECORDED", saleOk.status === "RECORDED");
  const restoreChild = await rejects(() => dec({ receiptId: hReceipt.id }, "REVOKED"));
  ok("restoring the receipt while its sale is rejected is refused (DEPENDS_ON_REJECTED)", /DEPENDS_ON_REJECTED/.test(restoreChild), restoreChild);
  const afterSale = await ilsH();
  ok("the rejected sale and receipt count nowhere (net sales 0, money in 0)", afterSale.sales.netMinor === B(0) && afterSale.receipts.inMinor === B(0), J({ s: afterSale.sales.netMinor, r: afterSale.receipts.inMinor }));

  // Race: rejecting a settlement and confirming a link on it, at once. The per-object lock lets exactly one win.
  const raceSt = await store.recordSettlement(bizH, { sourceKind: "ACQUIRER", capture: "FILE_STRUCTURED", sourceScope: "upload.max", externalId: "h-st-race", acquirer: "max", valueDate: "2026-10-22", currency: "ILS", grossMinor: B(5000), validation: "PASSED" });
  const raceBank = await mk(`INSERT INTO "ExternalTransaction" ("businessId", "source", "externalId", "direction", "amount", "currency", "bookedAt", "updatedAt")
    VALUES ($1, 'OWNER_UPLOAD', $2, 'CREDIT', 50.00, 'ILS', TIMESTAMP '2026-10-22 10:00', now()) RETURNING "id"`, bizH, key("bank"));
  const raceLink = await store.proposeLink(bizH, { linkKind: "SETTLEMENT_DEPOSITED_AS", settlementId: raceSt.id, externalTransactionId: raceBank, amountMinor: B(5000), currency: "ILS", basis: "RULE_EXACT", proposedBy: "SYSTEM" });
  const raceH = await Promise.allSettled([dec({ settlementId: raceSt.id }, "REJECTED"), dec({ linkId: raceLink.id }, "CONFIRMED")]);
  const reasons = raceH.map((r) => (r.status === "fulfilled" ? "ok" : String((r as PromiseRejectedResult).reason).match(/HAS_CONFIRMED_LINKS|REJECTED_EVIDENCE/)?.[0] ?? String((r as PromiseRejectedResult).reason)));
  ok("concurrent rejection vs. link confirmation on one settlement: exactly one wins, the other is refused by the rule it would break",
    reasons.filter((x) => x === "ok").length === 1 && reasons.some((x) => x === "HAS_CONFIRMED_LINKS" || x === "REJECTED_EVIDENCE"), J(reasons));
  const raceState = await owner.revenueDecision.findMany({ where: { businessId: bizH, OR: [{ settlementId: raceSt.id }, { linkId: raceLink.id }] } });
  ok("…and the books end consistent: never a rejected settlement with a confirmed link on it", raceState.length === 1, J(raceState.map((d) => d.decision)));

  const crossH = await rejects(() => store.recordDecision(bizA, { subject: { settlementId: hSt.id }, decision: "REJECTED", actor: "OWNER_USER", idempotencyKey: key("dec") }));
  ok("another business cannot reject this business's settlement (NOT_FOUND under its RLS)", /NOT_FOUND/.test(crossH), crossH);
  const crossSale = await rejects(() => store.recordDecision(bizA, { subject: { saleId: hSale.id }, decision: "REVOKED", actor: "OWNER_USER", idempotencyKey: key("dec") }));
  ok("…nor restore its sale (NOT_FOUND)", /NOT_FOUND/.test(crossSale), crossSale);

  // ── G. Existing systems ────────────────────────────────────────────────────────────────────────
  console.log("G. existing systems");
  const after = await existing();
  // The bank credits inserted in C and H are fixtures of this battery (owner inserts), not revenue writes: compare the rest.
  const afterWithoutFixture = J(await owner.$queryRawUnsafe(
    `SELECT (SELECT coalesce(md5(string_agg(t::text, '|' ORDER BY t."id")), '-') FROM "FinancialEvent" t) AS fe,
            (SELECT coalesce(md5(string_agg(t::text, '|' ORDER BY t."id")), '-') FROM "FinancialRecord" t) AS fr,
            (SELECT coalesce(md5(string_agg(t::text, '|' ORDER BY t."id")), '-') FROM "BillingDocument" t) AS bd,
            (SELECT coalesce(md5(string_agg(t::text, '|' ORDER BY t."id")), '-') FROM "PaymentTransaction" t) AS pt,
            (SELECT coalesce(md5(string_agg(t::text, '|' ORDER BY t."id")), '-') FROM "ExternalTransaction" t WHERE t."id" <> $1 AND t."businessId" <> $2) AS et`, credit, bizH));
  ok("FinancialEvent, FinancialRecord, BillingDocument, PaymentTransaction, ExternalTransaction byte-identical after every revenue write",
    afterWithoutFixture === before, `${before} → ${after}`);
  ok("still exactly two FinancialEvent rows: revenue truth wrote none", (await owner.financialEvent.count()) === 2);

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) { console.log("FAILED:\n - " + failures.join("\n - ")); process.exitCode = 1; }
  await owner.$disconnect();
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
