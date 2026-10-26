/**
 * Rivhit → the revenue-source contract. Pure: no I/O. docs/revenue-sources-s1a-rivhit.md.
 *
 * What the API returns, as observed on the documented demo account (2026-10-26, read-only):
 *   - document and receipt TYPES are configured per business (names, numbering): which types are sales is the
 *     owner's decision — the adapter only PROPOSES (see {@link proposeTypeRoles}) and reads nothing until confirmed;
 *   - an invoice-receipt (is_invoice_receipt) also appears as a receipt with the same number ("קבלה מחשבונית מס"):
 *     its tenders are read from the document, never again from the receipt (MIRROR);
 *   - payment methods are per-business names; a document's payment line carries the NAME (payment_type_id is 0),
 *     a receipt's carries the id — both resolve through Payment.TypeList's type_code;
 *   - amounts are NIS floats; credit documents and refund receipts carry negative amounts;
 *   - no register or branch field exists anywhere (agent_id / project_id / storage_id only). Nothing here marks a
 *     document as coming from a till unless the owner names its type as a register type.
 */
import { jerusalemInstantAt } from "@/lib/utils/jerusalem-day";
import type { TenderMethod } from "@/lib/revenue-truth/types";
import type { DocumentOrigin, PosDocument, PosLine, PosReceipt, PosTender } from "../contract";

export const RIVHIT_SOURCE = "pos.rivhit" as const;

export type DocRole = "SALE" | "REFUND" | "IGNORE";
export type ReceiptRole = "RECEIPT" | "MIRROR" | "IGNORE";

export type RivhitDocType = { type: number; name: string; isAccounting: boolean; isInvoiceReceipt: boolean; pricesIncludeVat: boolean };
export type RivhitReceiptType = { type: number; name: string; isInvoiceReceipt: boolean };
export type RivhitPaymentType = { id: number; name: string; typeCode: number };

/** The owner-confirmed reading of this business's Rivhit types. Stored in the connection's encrypted bundle. */
export type TypeConfig = {
  docs: Record<string, DocRole>;
  receipts: Record<string, ReceiptRole>;
  /** Document / receipt types the owner says only the till issues. Empty until Rivhit confirms how to tell. */
  registerTypes: number[];
};

export class RivhitParseError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "RivhitParseError";
  }
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const int = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && /^-?\d+$/.test(v.trim()) ? Number(v.trim()) : NaN;
  return Number.isSafeInteger(n) ? n : null;
};
const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v.trim()) : NaN;
  return Number.isFinite(n) ? n : null;
};
const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const bool = (v: unknown): boolean => v === true;

/** Agorot from a NIS float, rounded to the agora; the sign is the caller's business. */
export function toMinorAbs(v: number): bigint {
  return BigInt(Math.round(Math.abs(v) * 100));
}

/** "26/10/2026" (or "26-10-26") → "2026-10-26". */
export function parseRivhitDay(v: unknown): string | null {
  const m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})$/.exec(text(v));
  if (!m) return null;
  const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  const mo = Number(m[2]);
  const d = Number(m[1]);
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** The instant of a Rivhit date + "HH:MM[:SS]" wall-clock time in Israel (midday when the time is unusable). */
export function rivhitInstant(day: string, time: unknown): Date {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(text(time));
  const h = m ? Number(m[1]) : 12;
  const mi = m ? Number(m[2]) : 0;
  const s = m && m[3] ? Number(m[3]) : 0;
  return h < 24 && mi < 60 && s < 60 ? jerusalemInstantAt(day, h, mi, s) : jerusalemInstantAt(day, 12, 0, 0);
}

// ── type lists ───────────────────────────────────────────────────────────────────────────────────────

export function parseDocTypes(rows: unknown[]): RivhitDocType[] {
  return rows.flatMap((r) => {
    const o = obj(r);
    const type = int(o.document_type);
    if (type === null) return [];
    return [{ type, name: text(o.document_name), isAccounting: bool(o.is_accounting), isInvoiceReceipt: bool(o.is_invoice_receipt), pricesIncludeVat: bool(o.price_include_vat) }];
  });
}

export function parseReceiptTypes(rows: unknown[]): RivhitReceiptType[] {
  return rows.flatMap((r) => {
    const o = obj(r);
    const type = int(o.receipt_type);
    return type === null ? [] : [{ type, name: text(o.receipt_name), isInvoiceReceipt: bool(o.is_invoice_receipt) }];
  });
}

export function parsePaymentTypes(rows: unknown[]): RivhitPaymentType[] {
  return rows.flatMap((r) => {
    const o = obj(r);
    const id = int(o.payment_type);
    const typeCode = int(o.type_code);
    return id === null || typeCode === null ? [] : [{ id, name: text(o.payment_name), typeCode }];
  });
}

const PURCHASE_OR_INTERNAL = /קניות|קנייה|עצמית|שיריון|ספק|מלאי/;

/**
 * A PROPOSAL the owner must confirm: accounting documents named as invoices are sales, credit invoices are
 * refunds, everything else (orders, quotes, delivery notes, stock movements, purchases, self-invoices) is ignored.
 * Receipts: an invoice-receipt's mirror is never read twice; other receipt types are money received.
 */
export function proposeTypeRoles(docs: RivhitDocType[], receipts: RivhitReceiptType[]): TypeConfig {
  const docRoles: Record<string, DocRole> = {};
  for (const d of docs) {
    let role: DocRole = "IGNORE";
    if (d.isAccounting && !PURCHASE_OR_INTERNAL.test(d.name)) {
      if (/זיכוי/.test(d.name)) role = "REFUND";
      else if (/חשבונית|חשבון/.test(d.name)) role = "SALE";
    }
    docRoles[String(d.type)] = role;
  }
  const receiptRoles: Record<string, ReceiptRole> = {};
  for (const r of receipts) receiptRoles[String(r.type)] = r.isInvoiceReceipt ? "MIRROR" : "RECEIPT";
  return { docs: docRoles, receipts: receiptRoles, registerTypes: [] };
}

export function docRole(cfg: TypeConfig, type: number): DocRole {
  return cfg.docs[String(type)] ?? "IGNORE";
}
export function receiptRole(cfg: TypeConfig, type: number): ReceiptRole {
  return cfg.receipts[String(type)] ?? "IGNORE";
}
export function originOf(cfg: TypeConfig, type: number): DocumentOrigin {
  return cfg.registerTypes.includes(type) ? "REGISTER" : "OFFICE_OR_UNKNOWN";
}

/** The types of one role, as contiguous [from, to] ranges — fewer list calls. */
export function typeRanges(types: number[]): Array<[number, number]> {
  const sorted = [...new Set(types)].sort((a, b) => a - b);
  const out: Array<[number, number]> = [];
  for (const t of sorted) {
    const last = out[out.length - 1];
    if (last && t === last[1] + 1) last[1] = t;
    else out.push([t, t]);
  }
  return out;
}

// ── tenders ──────────────────────────────────────────────────────────────────────────────────────────

const BRANDS: Array<[RegExp, string]> = [
  [/ישראכרט|isracard/i, "isracard"],
  [/ויזה|visa/i, "visa"],
  [/מאסטר|master/i, "mastercard"],
  [/דיינרס|diners/i, "diners"],
  [/אמריקן|amex|american/i, "amex"],
];

/**
 * A payment line → a tender, or null for a line that is not money taken (type_code 0: tax withheld at source,
 * a deposit drawn down). Resolution: the id when it names a known type, else the exact name; unknown → OTHER.
 */
export function tenderOf(
  raw: unknown,
  payTypes: RivhitPaymentType[],
  forceOut: boolean
): PosTender | null | "zero" {
  const o = obj(raw);
  const amount = num(o.amount);
  const line = int(o.line_number);
  if (amount === null || line === null) throw new RivhitParseError("payment_malformed");
  if (Math.round(Math.abs(amount) * 100) === 0) return "zero";
  const id = int(o.payment_type_id);
  const name = text(o.payment_type);
  const known = (id !== null && id > 0 ? payTypes.find((p) => p.id === id) : undefined) ?? payTypes.find((p) => p.name === name);
  const code = known?.typeCode;
  if (code === 0) return null;
  const label = known?.name ?? name;
  let method: TenderMethod = "OTHER";
  if (code === 1) method = "CASH";
  else if (code === 2) method = "CHEQUE";
  else if (code === 3) method = "CARD";
  else if (code === 4) method = "DIGITAL_WALLET";
  else if (code === 9) method = /העברה|transfer/i.test(label) ? "BANK_TRANSFER" : /bit|ביט|פייבוקס|paybox|pay/i.test(label) ? "DIGITAL_WALLET" : "OTHER";
  const cardBrand = method === "CARD" ? (BRANDS.find(([re]) => re.test(label))?.[1] ?? null) : null;
  return { line, method, direction: forceOut || amount < 0 ? "OUT" : "IN", amountMinor: toMinorAbs(amount), cardBrand };
}

function tendersOf(payments: unknown, payTypes: RivhitPaymentType[], forceOut: boolean): { tenders: PosTender[]; skipped: number } {
  const tenders: PosTender[] = [];
  let skipped = 0;
  for (const p of Array.isArray(payments) ? payments : []) {
    const t = tenderOf(p, payTypes, forceOut);
    if (t === null) skipped += 1;
    else if (t !== "zero") tenders.push(t);
  }
  const lines = new Set(tenders.map((t) => t.line));
  if (lines.size !== tenders.length) throw new RivhitParseError("payment_line_repeated");
  return { tenders, skipped };
}

// ── list rows ────────────────────────────────────────────────────────────────────────────────────────

export type ListRow = { type: number; number: number; day: string; cancelled: boolean; amountMinor: bigint; negative: boolean; vatMinor: bigint };

/** One Document.List / Receipt.List row (receipts carry no VAT). */
export function parseListRow(raw: unknown, kind: "document" | "receipt"): ListRow | null {
  const o = obj(raw);
  const type = int(o[`${kind}_type`]);
  const number = int(o[`${kind}_number`]);
  const day = parseRivhitDay(o[`${kind}_date`]);
  const amount = num(o.amount);
  if (type === null || number === null || day === null || amount === null) return null;
  const vat = num(o.total_vat) ?? 0;
  return { type, number, day, cancelled: bool(o.is_cancelled), amountMinor: toMinorAbs(amount), negative: amount < 0, vatMinor: toMinorAbs(vat) };
}

// ── details ──────────────────────────────────────────────────────────────────────────────────────────

/** "02/005106" → 5106, or a plain number. */
function numberPart(v: unknown): number | null {
  const s = text(v) || (typeof v === "number" ? String(v) : "");
  const m = /^(?:\d+\/)?0*(\d+)$/.exec(s);
  return m ? Number(m[1]) : null;
}

function vatRate(v: unknown): number {
  const m = /^(\d+(?:\.\d+)?)\s*%?$/.exec(text(v));
  return m ? Number(m[1]) / 100 : 0;
}

/**
 * Document.Details → a PosDocument. `type` / `number` are the ones requested (Details answers the type by NAME).
 * Gross = what the customer paid + the discount, VAT included; a VAT-exclusive document's discount is grossed up
 * at its own rate. Refund documents: every tender is money paid back (OUT).
 */
export function parseDocumentDetails(
  raw: unknown,
  ctx: { type: number; number: number; role: "SALE" | "REFUND"; origin: DocumentOrigin; payTypes: RivhitPaymentType[] }
): PosDocument {
  const o = obj(raw);
  const answered = numberPart(o.document_number);
  if (answered !== null && answered !== ctx.number) throw new RivhitParseError("document_mismatch");
  const day = parseRivhitDay(o.document_date);
  if (!day) throw new RivhitParseError("document_date");
  const totalF = num(o.document_total);
  const vatF = num(o.total_vat);
  if (totalF === null || vatF === null) throw new RivhitParseError("document_amounts");
  // A foreign-currency document still carries its NIS totals (document_total / total_vat / payment amount are NIS; the
  // foreign amounts are the *_mtc fields): it is recorded in NIS, as Rivhit books it — never converted here.
  const pricesIncludeVat = bool(o.price_include_vat);
  const total = toMinorAbs(totalF);
  const vat = toMinorAbs(vatF);
  const discF = num(o.discount_amount) ?? 0;
  const rate = vat === BigInt(0) ? 0 : vatRate(o.vat_percent);
  const discount = discF > 0 ? toMinorAbs(pricesIncludeVat ? discF : discF * (1 + rate)) : BigInt(0);
  if (vat > total) throw new RivhitParseError("document_vat_exceeds_total");
  const lines: PosLine[] = (Array.isArray(o.items) ? o.items : []).flatMap((it) => {
    const i = obj(it);
    const line = int(i.line);
    const totalLine = num(i.total_line);
    if (line === null || totalLine === null) return [];
    const ref = text(i.catalog_number) || (int(i.item_id) !== null ? String(int(i.item_id)) : "");
    return [{ line, itemRef: ref ? ref.slice(0, 64) : null, quantity: num(i.quantity) ?? 0, lineTotalMinor: toMinorAbs(totalLine) }];
  });
  const { tenders, skipped } = tendersOf(o.payments, ctx.payTypes, ctx.role === "REFUND");
  return {
    externalId: `doc:${ctx.type}:${ctx.number}`,
    kind: ctx.role,
    origin: ctx.origin,
    occurredAt: rivhitInstant(day, o.documnet_time ?? o.document_time),
    businessDay: day,
    registerKey: null,
    currency: "ILS",
    grossMinor: total + discount,
    discountMinor: discount,
    vatMinor: vat,
    pricesIncludeVat,
    lines,
    tenders,
    skippedTenders: skipped,
    cancelled: bool(o.is_cancelled),
  };
}

/** Receipt.Details → a PosReceipt (no sale of its own; the tenders' signs give the direction). */
export function parseReceiptDetails(
  raw: unknown,
  ctx: { type: number; number: number; origin: DocumentOrigin; payTypes: RivhitPaymentType[]; cancelled: boolean }
): PosReceipt {
  const o = obj(raw);
  const answered = numberPart(o.receipt_number);
  if (answered !== null && answered !== ctx.number) throw new RivhitParseError("receipt_mismatch");
  const day = parseRivhitDay(o.receipt_date);
  if (!day) throw new RivhitParseError("receipt_date");
  const { tenders, skipped } = tendersOf(o.payments, ctx.payTypes, false);
  return {
    externalId: `rcpt:${ctx.type}:${ctx.number}`,
    origin: ctx.origin,
    occurredAt: rivhitInstant(day, o.receipt_time),
    businessDay: day,
    registerKey: null,
    currency: "ILS",
    tenders,
    skippedTenders: skipped,
    cancelled: ctx.cancelled,
  };
}

// ── daily completeness ───────────────────────────────────────────────────────────────────────────────

export type SummaryByType = Map<number, { count: number; totalMinor: bigint; negative: boolean }>;

/** Company.SummaryReport → per document type: count and VAT-inclusive total (cancelled documents included). */
export function parseSummary(raw: unknown): SummaryByType {
  const out: SummaryByType = new Map();
  for (const r of Array.isArray(obj(raw).Documents) ? (obj(raw).Documents as unknown[]) : []) {
    const o = obj(r);
    const type = int(o.DocType);
    const count = int(o.DocCount);
    const total = num(o.TotalWithVat);
    if (type === null || count === null || total === null) continue;
    out.set(type, { count, totalMinor: toMinorAbs(total), negative: total < 0 });
  }
  return out;
}

export type DayCheck = { type: number; ok: boolean; summaryCount: number; listedCount: number; summaryMinor: bigint; listedMinor: bigint };

/**
 * One day's list rows against Rivhit's own summary, for the sale and refund types. Rivhit's summary counts
 * cancelled documents too (observed: list totals including cancelled = summary, to the agora), so every listed
 * row is summed.
 */
export function reconcileDay(rows: ListRow[], summary: SummaryByType, saleTypes: number[]): DayCheck[] {
  return [...new Set(saleTypes)].sort((a, b) => a - b).map((type) => {
    const mine = rows.filter((r) => r.type === type);
    const signed = mine.reduce((s, r) => s + (r.negative ? -r.amountMinor : r.amountMinor), BigInt(0));
    const sum = summary.get(type);
    const summarySigned = sum ? (sum.negative ? -sum.totalMinor : sum.totalMinor) : BigInt(0);
    const summaryCount = sum?.count ?? 0;
    return {
      type,
      ok: summaryCount === mine.length && summarySigned === signed,
      summaryCount,
      listedCount: mine.length,
      summaryMinor: summarySigned,
      listedMinor: signed,
    };
  });
}
