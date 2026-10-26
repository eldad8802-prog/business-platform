/**
 * Rivhit (S1-A) — the adapter's client and parser against Rivhit's documented DEMO account. LOCAL ONLY (network);
 * never in CI, never against a real business. READ-ONLY: type lists, Document/Receipt List + Details, Document.Last,
 * Company.SummaryReport — nothing that writes.
 *
 *   RIVHIT_DEMO_TOKEN=<the demo api_token from rivhit-api.readme.io/docs/test-enviornment-rivhit> \
 *     npx tsx scripts/revenue-sources/rivhit-demo-probe.ts [YYYY-MM-DD] [sampleSize]
 *
 * The demo account is shared by every Rivhit tester ("all account information is visible to all test users"): this
 * prints COUNTS only — no name, phone, amount of a single document, or any other value of a document.
 */
import { addCalendarDays, jerusalemDayKey } from "@/lib/utils/jerusalem-day";
import { isRivhitToken, rivhit } from "@/lib/revenue-sources/rivhit/client";
import {
  docRole, parseDocTypes, parseDocumentDetails, parseListRow, parsePaymentTypes, parseReceiptDetails, parseReceiptTypes, parseSummary,
  proposeTypeRoles, receiptRole, reconcileDay, typeRanges, type ListRow,
} from "@/lib/revenue-sources/rivhit/parse";

const REGISTERISH = /register|kupa|cash_?desk|pos|terminal|branch_id|store_id|shift|z_?number/i;

async function main() {
  const token = process.env.RIVHIT_DEMO_TOKEN ?? "";
  if (!isRivhitToken(token)) throw new Error("set RIVHIT_DEMO_TOKEN to the documented demo api_token");
  const day = process.argv[2] ?? addCalendarDays(jerusalemDayKey(new Date()), -1);
  const sample = Number(process.argv[3] ?? 20);

  const docTypes = parseDocTypes(await rivhit.documentTypes(token));
  const receiptTypes = parseReceiptTypes(await rivhit.receiptTypes(token));
  const payTypes = parsePaymentTypes(await rivhit.paymentTypes(token));
  const cfg = proposeTypeRoles(docTypes, receiptTypes);
  const saleTypes = Object.entries(cfg.docs).filter(([, r]) => r !== "IGNORE").map(([t]) => Number(t));
  const rcptTypes = Object.entries(cfg.receipts).filter(([, r]) => r === "RECEIPT").map(([t]) => Number(t));
  console.log(`types: ${docTypes.length} document, ${receiptTypes.length} receipt, ${payTypes.length} payment`);
  console.log(`proposal: SALE ${saleTypes.filter((t) => docRole(cfg, t) === "SALE").join(",")} · REFUND ${saleTypes.filter((t) => docRole(cfg, t) === "REFUND").join(",")} · RECEIPT ${rcptTypes.join(",")} · MIRROR ${Object.entries(cfg.receipts).filter(([, r]) => r === "MIRROR").map(([t]) => t).join(",")}`);
  const named = docTypes.filter((d) => /קופה|register|pos/i.test(d.name));
  console.log(`document types whose NAME mentions a till: ${named.length}`);

  // The day check: listed documents against Rivhit's own summary.
  const rows: ListRow[] = [];
  for (const [lo, hi] of typeRanges(saleTypes)) {
    rows.push(...(await rivhit.documentList(token, { kind: "date", fromType: lo, toType: hi, fromDay: day, toDay: day })).map((r) => parseListRow(r, "document")).filter((r): r is ListRow => r !== null && saleTypes.includes(r.type)));
  }
  const checks = reconcileDay(rows, parseSummary(await rivhit.summaryReport(token, day)), saleTypes);
  console.log(`day ${day}: ${rows.length} sale/refund documents listed (${rows.filter((r) => r.cancelled).length} cancelled); summary check ${checks.filter((c) => c.ok).length}/${checks.length} types match`);
  for (const c of checks.filter((x) => !x.ok)) console.log(`  type ${c.type}: summary ${c.summaryCount} docs, listed ${c.listedCount}`);

  // Details of a sample: does every document parse, and what do the tenders look like (counts only)?
  let parsed = 0;
  const unreadable: Record<string, number> = {};
  const methods: Record<string, number> = {};
  const registerKeys = new Set<string>();
  for (const row of rows.filter((r) => docRole(cfg, r.type) !== "IGNORE").slice(0, sample)) {
    const raw = await rivhit.documentDetails(token, row.type, row.number);
    if (raw === null) {
      unreadable.not_found = (unreadable.not_found ?? 0) + 1;
      continue;
    }
    for (const k of Object.keys(raw as object)) if (REGISTERISH.test(k)) registerKeys.add(k);
    try {
      const role = docRole(cfg, row.type) as "SALE" | "REFUND";
      const doc = parseDocumentDetails(raw, { type: row.type, number: row.number, role, origin: "OFFICE_OR_UNKNOWN", payTypes });
      parsed += 1;
      for (const t of doc.tenders) methods[`${t.method}/${t.direction}`] = (methods[`${t.method}/${t.direction}`] ?? 0) + 1;
    } catch (e) {
      const code = (e as { code?: string }).code ?? "error";
      unreadable[code] = (unreadable[code] ?? 0) + 1;
    }
  }
  console.log(`document details: ${parsed} parsed, unreadable ${JSON.stringify(unreadable)}; tenders ${JSON.stringify(methods)}`);
  console.log(`fields that could name a till / branch in Document.Details: ${registerKeys.size ? [...registerKeys].join(",") : "none"}`);

  let rParsed = 0;
  const rRows: ListRow[] = [];
  for (const [lo, hi] of typeRanges(rcptTypes)) {
    rRows.push(...(await rivhit.receiptList(token, { kind: "date", fromType: lo, toType: hi, fromDay: day, toDay: day })).map((r) => parseListRow(r, "receipt")).filter((r): r is ListRow => r !== null && receiptRole(cfg, r.type) === "RECEIPT"));
  }
  const rUnreadable: Record<string, number> = {};
  for (const row of rRows.slice(0, Math.ceil(sample / 2))) {
    const raw = await rivhit.receiptDetails(token, row.type, row.number);
    try {
      if (raw && parseReceiptDetails(raw, { type: row.type, number: row.number, origin: "OFFICE_OR_UNKNOWN", payTypes, cancelled: row.cancelled }).externalId) rParsed += 1;
    } catch (e) {
      const code = (e as { code?: string }).code ?? "error";
      rUnreadable[code] = (rUnreadable[code] ?? 0) + 1;
    }
  }
  if (Object.keys(rUnreadable).length) console.log(`receipts unreadable ${JSON.stringify(rUnreadable)}`);
  console.log(`standalone receipts: ${rRows.length} listed, ${rParsed} of ${Math.min(rRows.length, Math.ceil(sample / 2))} sampled parsed`);
  const last = saleTypes.length ? await rivhit.lastDocumentNumber(token, saleTypes[0]) : 0;
  console.log(`Document.Last for type ${saleTypes[0]}: a number was returned (${last > 0 ? "yes" : "no"})`);
}

main().catch((e) => {
  console.error("probe failed:", (e as { code?: string }).code ?? (e as Error).message);
  process.exit(1);
});
