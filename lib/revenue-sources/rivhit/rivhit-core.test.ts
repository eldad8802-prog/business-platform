/**
 * Rivhit (S1-A) — the pure parts: parsing, tender mapping, type proposals, the day check, the two adapter contracts,
 * intake receipts, routing, the read-only client and the sync state. No database, no network (a fake fetch).
 * Shapes follow what the documented Rivhit demo account returned on 2026-10-26; every value here is synthetic.
 *
 * Run: npx tsx lib/revenue-sources/rivhit/rivhit-core.test.ts
 */
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://unused@localhost:1/unused";

import { readFileSync } from "node:fs";
import { join } from "node:path";

let total = 0;
let failures = 0;
function check(name: string, cond: boolean, extra = ""): void {
  total += 1;
  if (!cond) failures += 1;
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${name}${extra && !cond ? " — " + extra : ""}`);
}
const throwsCode = (fn: () => unknown): string => {
  try {
    fn();
    return "";
  } catch (e) {
    return (e as { code?: string }).code ?? String(e);
  }
};

(async () => {
  const P = await import("./parse");
  const C = await import("../contract");
  const A = await import("./adapter");
  const S = await import("./sync");
  const client = await import("./client");
  const { decideRoute } = await import("@/lib/intake/routing/rules");

  const payTypes = P.parsePaymentTypes([
    { payment_type: 1, payment_name: "שיק", type_code: 2 },
    { payment_type: 2, payment_name: "מזומן", type_code: 1 },
    { payment_type: 3, payment_name: "נ.מס במקור", type_code: 0 },
    { payment_type: 5, payment_name: "ויזה", type_code: 3 },
    { payment_type: 9, payment_name: "העברה בנקאית", type_code: 9 },
    { payment_type: 10, payment_name: "BIT", type_code: 9 },
    { payment_type: 15, payment_name: "ביביט", type_code: 4 },
  ]);

  console.log("Dates and times (Israel)");
  check("26/10/2026 → 2026-10-26", P.parseRivhitDay("26/10/2026") === "2026-10-26");
  check("26-10-26 → 2026-10-26", P.parseRivhitDay("26-10-26") === "2026-10-26");
  check("31/02/2026 is refused", P.parseRivhitDay("31/02/2026") === null);
  check("winter time: 26/10/2026 19:49:45 is 17:49:45Z", P.rivhitInstant("2026-10-26", "19:49:45").toISOString() === "2026-10-26T17:49:45.000Z", P.rivhitInstant("2026-10-26", "19:49:45").toISOString());
  check("summer time: 15/07/2026 10:00 is 07:00Z", P.rivhitInstant("2026-07-15", "10:00").toISOString() === "2026-07-15T07:00:00.000Z");
  check("an unusable time falls on the same day (midday)", P.rivhitInstant("2026-10-26", "xx").toISOString().startsWith("2026-10-26T10:00"));

  console.log("Type roles are a proposal");
  const docTypes = P.parseDocTypes([
    { document_type: 1, document_name: "חשבונית מס", is_accounting: true, is_invoice_receipt: false },
    { document_type: 2, document_name: "חשבונית מס קבלה ", is_accounting: true, is_invoice_receipt: true, price_include_vat: true },
    { document_type: 3, document_name: "חשבונית מס זיכוי", is_accounting: true },
    { document_type: 4, document_name: "תעודת משלוח 1", is_accounting: false },
    { document_type: 6, document_name: "הצעת מחיר", is_accounting: false },
    { document_type: 7, document_name: "הזמנה", is_accounting: false },
    { document_type: 9, document_name: "חשבונית קניות למלאי", is_accounting: true },
    { document_type: 14, document_name: "חשבונית מס עצמית", is_accounting: false },
    { document_type: 21, document_name: "חשבונית מס שיריון", is_accounting: true },
  ]);
  const receiptTypes = P.parseReceiptTypes([
    { receipt_type: 1, receipt_name: "קבלה ", is_invoice_receipt: false },
    { receipt_type: 2, receipt_name: "קבלה מחשבונית מס", is_invoice_receipt: true },
  ]);
  const cfg = P.proposeTypeRoles(docTypes, receiptTypes);
  check("tax invoice and invoice-receipt → SALE", cfg.docs["1"] === "SALE" && cfg.docs["2"] === "SALE");
  check("credit invoice → REFUND", cfg.docs["3"] === "REFUND");
  check("delivery note, quote, order → IGNORE", cfg.docs["4"] === "IGNORE" && cfg.docs["6"] === "IGNORE" && cfg.docs["7"] === "IGNORE");
  check("purchase, self-invoice, reservation → IGNORE", cfg.docs["9"] === "IGNORE" && cfg.docs["14"] === "IGNORE" && cfg.docs["21"] === "IGNORE");
  check("the invoice-receipt's mirror receipt is never read twice (MIRROR)", cfg.receipts["2"] === "MIRROR" && cfg.receipts["1"] === "RECEIPT");
  check("no type is proven to come from a till", cfg.registerTypes.length === 0 && P.originOf(cfg, 2) === "OFFICE_OR_UNKNOWN");
  check("an unknown type is ignored", P.docRole(cfg, 77) === "IGNORE" && P.receiptRole(cfg, 77) === "IGNORE");
  check("type ranges: 1,2,3,5 → [1,3],[5,5]", JSON.stringify(P.typeRanges([3, 1, 2, 5])) === "[[1,3],[5,5]]");

  console.log("Tenders");
  const cash = P.tenderOf({ line_number: 1, amount: 19.82, payment_type: "מזומן", payment_type_id: 0 }, payTypes, false);
  check("a document's line names the method (id 0): מזומן → CASH", typeof cash === "object" && cash !== null && cash.method === "CASH" && cash.amountMinor === BigInt(1982) && cash.direction === "IN");
  const cheque = P.tenderOf({ line_number: 1, amount: -1, payment_type: "שיק", payment_type_id: 1 }, payTypes, false);
  check("a receipt's line carries the id: 1 → CHEQUE; negative → OUT", typeof cheque === "object" && cheque !== null && cheque.method === "CHEQUE" && cheque.direction === "OUT" && cheque.amountMinor === BigInt(100));
  check("tax withheld at source (type_code 0) is not money taken", P.tenderOf({ line_number: 2, amount: 5, payment_type: "נ.מס במקור", payment_type_id: 3 }, payTypes, false) === null);
  const visa = P.tenderOf({ line_number: 3, amount: 100, payment_type: "ויזה", payment_type_id: 5 }, payTypes, false);
  check("ויזה → CARD, brand visa", typeof visa === "object" && visa !== null && visa.method === "CARD" && visa.cardBrand === "visa");
  const transfer = P.tenderOf({ line_number: 4, amount: 10, payment_type: "העברה בנקאית", payment_type_id: 9 }, payTypes, false);
  const bit = P.tenderOf({ line_number: 5, amount: 10, payment_type: "BIT", payment_type_id: 10 }, payTypes, false);
  check("code 9: transfer → BANK_TRANSFER, BIT → DIGITAL_WALLET", typeof transfer === "object" && transfer?.method === "BANK_TRANSFER" && typeof bit === "object" && bit?.method === "DIGITAL_WALLET");
  const unknown = P.tenderOf({ line_number: 6, amount: 10, payment_type: "משהו אחר", payment_type_id: 0 }, payTypes, false);
  check("an unknown method is OTHER, never guessed", typeof unknown === "object" && unknown?.method === "OTHER");
  const refundLine = P.tenderOf({ line_number: 1, amount: 50, payment_type: "מזומן", payment_type_id: 0 }, payTypes, true);
  check("on a refund document every tender is money paid back (OUT)", typeof refundLine === "object" && refundLine?.direction === "OUT");
  check("a zero line is dropped", P.tenderOf({ line_number: 7, amount: 0.001, payment_type: "מזומן" }, payTypes, false) === "zero");
  check("a malformed line is refused", throwsCode(() => P.tenderOf({ amount: 1 }, payTypes, false)) === "payment_malformed");

  console.log("Document details → PosDocument");
  const detail = {
    document_type: "חשבונית מס קבלה ", document_number: "02/005106", document_date: "26/10/2026", documnet_time: "19:49:45",
    document_total: 19.82, total_vat: 3.02, total_without_vat: 16.8, discount_amount: 0, price_include_vat: false, is_cancelled: false,
    currency_id: 1, vat_percent: "18.00%", customer_name: "SYNTHETIC CUSTOMER", customer_phone: "0500000000",
    items: [{ line: 1, quantity: 1, price_nis: 16.8, total_line: 16.8, item_id: 7, catalog_number: "SKU-1", description: "SYNTHETIC ITEM" }],
    payments: [{ line_number: 1, amount: 19.82, payment_type: "מזומן", payment_type_id: 0 }],
  };
  const doc = P.parseDocumentDetails(detail, { type: 2, number: 5106, role: "SALE", origin: "OFFICE_OR_UNKNOWN", payTypes });
  check("identity doc:2:5106", doc.externalId === "doc:2:5106");
  check("gross 19.82 incl. VAT, VAT 3.02, no discount", doc.grossMinor === BigInt(1982) && doc.vatMinor === BigInt(302) && doc.discountMinor === BigInt(0));
  check("one cash tender of 19.82", doc.tenders.length === 1 && doc.tenders[0].method === "CASH" && doc.tenders[0].amountMinor === BigInt(1982));
  check("no customer value is carried", !JSON.stringify(doc, (_k, v) => (typeof v === "bigint" ? v.toString() : v)).includes("SYNTHETIC CUSTOMER") && !JSON.stringify(doc, (_k, v) => (typeof v === "bigint" ? v.toString() : v)).includes("0500000000"));
  check("item text is not carried, only its reference", !JSON.stringify(doc, (_k, v) => (typeof v === "bigint" ? v.toString() : v)).includes("SYNTHETIC ITEM") && doc.lines[0].itemRef === "SKU-1");
  check("origin stays OFFICE_OR_UNKNOWN", doc.origin === "OFFICE_OR_UNKNOWN");
  const discounted = P.parseDocumentDetails({ ...detail, document_total: 106.2, total_vat: 16.2, discount_amount: 10 }, { type: 2, number: 5106, role: "SALE", origin: "OFFICE_OR_UNKNOWN", payTypes });
  check("a VAT-exclusive discount is grossed up at the document's rate (10 → 11.80)", discounted.discountMinor === BigInt(1180) && discounted.grossMinor === BigInt(10620 + 1180));
  check("a different document number is refused", throwsCode(() => P.parseDocumentDetails(detail, { type: 2, number: 5107, role: "SALE", origin: "OFFICE_OR_UNKNOWN", payTypes })) === "document_mismatch");
  const foreign = P.parseDocumentDetails({ ...detail, currency_id: 2, document_total_mtc: 5.4 }, { type: 2, number: 5106, role: "SALE", origin: "OFFICE_OR_UNKNOWN", payTypes });
  check("a foreign-currency document is recorded from its NIS totals, never converted", foreign.currency === "ILS" && foreign.grossMinor === BigInt(1982));
  const credit = P.parseDocumentDetails({ ...detail, document_number: "03/000010", document_total: -50, total_vat: -7.63, payments: [{ line_number: 1, amount: -50, payment_type: "מזומן" }] }, { type: 3, number: 10, role: "REFUND", origin: "OFFICE_OR_UNKNOWN", payTypes });
  check("a credit document: positive amounts, kind REFUND, tender OUT", credit.kind === "REFUND" && credit.grossMinor === BigInt(5000) && credit.vatMinor === BigInt(763) && credit.tenders[0].direction === "OUT");

  console.log("Receipt details → PosReceipt");
  const rc = P.parseReceiptDetails(
    { receipt_number: "01/004228", receipt_date: "26/10/2026", receipt_time: "19:50:28", currency_id: 1, payments: [{ line_number: 1, amount: -1, payment_type: "שיק", payment_type_id: 1 }, { line_number: 2, amount: -1, payment_type: "שיק", payment_type_id: 1 }] },
    { type: 1, number: 4228, origin: "OFFICE_OR_UNKNOWN", payTypes, cancelled: false }
  );
  check("rcpt:1:4228 with two cheque lines paid back", rc.externalId === "rcpt:1:4228" && rc.tenders.length === 2 && rc.tenders.every((t) => t.direction === "OUT" && t.method === "CHEQUE"));
  check("a repeated payment line is refused", throwsCode(() => P.parseReceiptDetails({ receipt_number: "01/1", receipt_date: "26/10/2026", payments: [{ line_number: 1, amount: 1, payment_type: "שיק" }, { line_number: 1, amount: 2, payment_type: "שיק" }] }, { type: 1, number: 1, origin: "OFFICE_OR_UNKNOWN", payTypes, cancelled: false })) === "payment_line_repeated");

  console.log("The day check against Rivhit's own summary");
  const rows = [
    P.parseListRow({ document_type: 1, document_number: 10, document_date: "25/10/2026", amount: 100, total_vat: 15.25, is_cancelled: false }, "document")!,
    P.parseListRow({ document_type: 1, document_number: 11, document_date: "25/10/2026", amount: 50, total_vat: 7.63, is_cancelled: true }, "document")!,
    P.parseListRow({ document_type: 3, document_number: 4, document_date: "25/10/2026", amount: -20, total_vat: -3.05, is_cancelled: false }, "document")!,
  ];
  const summary = P.parseSummary({ Documents: [{ DocType: 1, DocCount: 2, TotalWithVat: 150 }, { DocType: 3, DocCount: 1, TotalWithVat: -20 }] });
  const day = P.reconcileDay(rows, summary, [1, 3]);
  check("counts and totals match, cancelled included (Rivhit counts them)", day.every((c) => c.ok), JSON.stringify(day, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
  const short = P.reconcileDay(rows.slice(1), summary, [1, 3]);
  check("a missing document fails its type's check", short.find((c) => c.type === 1)?.ok === false && short.find((c) => c.type === 3)?.ok === true);

  console.log("Contracts: a sale and a card charge are different truths");
  const rev = C.posDocumentToRevenue(doc);
  check("a document → one sale + one receipt per tender, ids derived from the document", rev.sale.externalId === "doc:2:5106" && rev.receipts.length === 1 && rev.receipts[0].externalId === "doc:2:5106:pay:1");
  check("an unproven origin is written as ACCOUNTING_APP, never POS", rev.sale.sourceKind === "ACCOUNTING_APP" && rev.receipts[0].sourceKind === "ACCOUNTING_APP");
  check("only a proven till document is POS", C.sourceKindOf("REGISTER") === "POS");
  check("a void has its own identity and the same money", (() => { const v = C.voidOf(rev.sale); return v.externalId === "doc:2:5106:void" && v.kind === "VOID" && v.grossMinor === rev.sale.grossMinor; })());
  const pe = C.paymentEventToRevenue({ externalId: "pp:1", kind: "CHARGE", occurredAt: new Date(), businessDay: "2026-10-26", terminalRef: null, currency: "ILS", amountMinor: BigInt(500), cardBrand: "visa", installmentCount: 3 });
  check("a card charge → a CARD receipt from a PAYMENT_PROVIDER, and no sale at all", !("sale" in pe) && pe.receipts.length === 1 && pe.receipts[0].method === "CARD" && pe.receipts[0].sourceKind === "PAYMENT_PROVIDER");
  check("a provider cancellation is money out, not a sale void", C.paymentEventToRevenue({ externalId: "pp:2", kind: "CANCEL", occurredAt: new Date(), businessDay: "2026-10-26", terminalRef: null, currency: "ILS", amountMinor: BigInt(500), cardBrand: null, installmentCount: null }).receipts[0].direction === "OUT");

  console.log("Intake receipts");
  const r1 = A.documentReceipt("pubAAAAAAAAAAAAAAAAAAAAAA", doc);
  const r1b = A.documentReceipt("pubAAAAAAAAAAAAAAAAAAAAAA", { ...doc });
  const r2 = A.documentReceipt("pubBBBBBBBBBBBBBBBBBBBBBB", doc);
  const rv = A.voidReceipt("pubAAAAAAAAAAAAAAAAAAAAAA", doc.externalId);
  check("the same document → the same receipt identity (a re-read is a duplicate)", r1.externalEventId === r1b.externalEventId);
  check("another connection → another identity", r1.externalEventId !== r2.externalEventId);
  check("its void → a different identity", rv.externalEventId !== r1.externalEventId);
  check("family CUSTOM, providerAccountRef = the connection's public id", r1.family === "CUSTOM" && r1.providerAccountRef === "pubAAAAAAAAAAAAAAAAAAAAAA");
  check("the payload holds no customer value", !JSON.stringify(r1.payload).includes("SYNTHETIC CUSTOMER") && !JSON.stringify(r1.payload).includes("0500000000"));
  check("normalize: a document → target revenue, no contact, no identity", (() => { const n = A.normalizeRivhit({ eventType: r1.eventType, payload: r1.payload, occurredAt: r1.occurredAt }); return n.ok && n.normalized.target === "revenue" && n.normalized.contactHints === null && n.normalized.identity === "none"; })());
  check("normalize: a malformed payload is terminal", (() => { const n = A.normalizeRivhit({ eventType: "revenue.document", payload: { doc: { externalId: "doc:x" } }, occurredAt: null }); return !n.ok && n.code === "payload_malformed"; })());
  check("normalize: an unknown event type is terminal", !A.normalizeRivhit({ eventType: "revenue.other", payload: {}, occurredAt: null }).ok);
  check("the payload hash ignores key order (a jsonb round trip)", A.payloadHash({ a: 1, b: { c: 2, d: 3 } }) === A.payloadHash({ b: { d: 3, c: 2 }, a: 1 }));
  check("the scope names the connection", A.rivhitScope(42) === "pos.rivhit:c42" && /^[a-z][a-z0-9_.:-]{0,79}$/.test(A.rivhitScope(42)));

  console.log("Routing (R10)");
  const base = { eventType: "revenue.document", identityState: "none" as never, coreDestinations: [] as never[] };
  const d1 = decideRoute({ ...base, family: "CUSTOM", target: "revenue" });
  check("CUSTOM + revenue → R10, the adapter writes it, no owner review", d1.rule === "R10_REVENUE" && d1.destination === "revenue" && d1.executor === "adapter" && !d1.ownerReviewRequired);
  check("a COMMERCE event never reaches revenue through R10 (R5 first)", decideRoute({ ...base, family: "COMMERCE", target: "revenue" }).rule === "R5_COMMERCE");
  check("revenue can never become a Lead (R0)", decideRoute({ ...base, family: "CUSTOM", target: "lead" }).rule === "R0_FORBIDDEN_LEAD");
  check("the adapter only emits CUSTOM", JSON.stringify(A.rivhitAdapter.families) === '["CUSTOM"]' && A.rivhitAdapter.coreDestinations === undefined);

  console.log("The read-only client");
  const calls: Array<{ url: string; body: string }> = [];
  let answer: { status: number; json: unknown } = { status: 200, json: { error_code: 0, data: { document_list: [] } } };
  client.setRivhitFetchForTests(async (url, init) => {
    calls.push({ url, body: init.body });
    return answer;
  });
  const token = "00000000-1111-2222-3333-444444444444";
  await client.rivhit.documentList(token, { kind: "number", type: 2, from: 11, to: 110 });
  check("the token travels in the body, never in the URL", calls[0].url.endsWith("/Document.List") && !calls[0].url.includes(token) && JSON.parse(calls[0].body).api_token === token);
  check("a number range is one type, bounded", (() => { const b = JSON.parse(calls[0].body); return b.from_document_type === 2 && b.to_document_type === 2 && b.from_document_number === 11 && b.to_document_number === 110; })());
  answer = { status: 200, json: { error_code: 0, data: { receipt_list: [] } } };
  await client.rivhit.receiptList(token, { kind: "date", fromType: 1, toType: 1, fromDay: "2026-10-01", toDay: "2026-10-02" });
  check("a date range is sent as DD/MM/YYYY", JSON.parse(calls[1].body).from_date === "01/10/2026" && JSON.parse(calls[1].body).to_date === "02/10/2026");
  answer = { status: 401, json: { error_code: 401, client_message: "שגיאת הרשאות", debug_message: "-9999 : UNAUTHORIZED", data: null } };
  check("a rejected token → unauthorized", (await client.rivhitCall("Company.Details", token).catch((e) => e.code)) === "unauthorized");
  answer = { status: 200, json: { error_code: 204, client_message: "לא נמצאו נתונים", data: null } };
  check("no data found → null, not an error", (await client.rivhitCall("Document.Details", token, { document_type: 2, document_number: 1 })) === null);
  answer = { status: 200, json: { error_code: -94, data: null } };
  check("any other Rivhit error → a bounded code", (await client.rivhitCall("Document.List", token).catch((e) => e.code)) === "rivhit_error");
  const before = calls.length;
  check("a token that is not a UUID is refused without a call", (await client.rivhitCall("Company.Details", "not-a-token").catch((e) => e.code)) === "unauthorized" && calls.length === before);
  answer = { status: 200, json: { error_code: 0, data: { document_number: "02/005106" } } };
  check("the last number of a type: 02/005106 → 5106", (await client.rivhit.lastDocumentNumber(token, 2)) === 5106);
  client.setRivhitFetchForTests(null);
  const src = readFileSync(join(process.cwd(), "lib/revenue-sources/rivhit/client.ts"), "utf8");
  check("the client names no write operation (New / Cancel / Close / Update / Delete / Copy / Reopen / SetStartNumber)", !/"[A-Za-z]+\.(New|Cancel|Close|Update|Delete|Copy|Copies|Reopen|SetStartNumber|AddJournal|InvoiceApproval)"/.test(src));

  console.log("Sync state (kept encrypted, as strings)");
  const state = {
    apiToken: token, companyId: "123", types: cfg, typesConfirmed: true, payTypes, payTypesAt: "2026-10-26T00:00:00.000Z",
    cursor: { docs: { "2": 5106 }, receipts: { "1": 4234 } }, backfill: { fromDay: "2026-10-01", toDay: "2026-10-25", nextDay: "2026-10-03" },
    rescanAt: null, unreadable: ["doc:2:9:unsupported_currency"], checks: [{ day: "2026-10-01", type: 1, ok: true, summaryCount: 2, listedCount: 2, summaryMinor: BigInt(15000), listedMinor: BigInt(15000) }],
  };
  const enc = S.encodeState(state);
  check("every value is a string (the bundle is Record<string, string>)", Object.values(enc).every((v) => typeof v === "string"));
  const dec = S.decodeState(enc)!;
  check("round trip keeps cursor, backfill, unreadable, checks", dec.cursor.docs["2"] === 5106 && dec.backfill?.nextDay === "2026-10-03" && dec.unreadable.length === 1 && dec.checks[0].summaryMinor === BigInt(15000) && dec.typesConfirmed);
  check("no token, no state", S.decodeState({ ...enc, apiToken: "" }) === null);
  check("bounded work per run", S.CALL_BUDGET <= 100 && S.FORWARD_WINDOW <= 200 && client.MIN_INTERVAL_MS >= 300);

  console.log(`\n${total - failures}/${total} passed`);
  if (failures) process.exit(1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
