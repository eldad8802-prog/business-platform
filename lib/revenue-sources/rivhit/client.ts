/**
 * Rivhit Online API — the READ-ONLY calls S1-A makes (rivhit-api.readme.io). SERVER-ONLY.
 *
 *   One URL serves test and production ("The Rivhit API uses the Production URL for all environments"); the
 *   business's own api_token travels in the JSON body. Only list / details / type-list / report operations are
 *   reachable from here — nothing that creates, cancels or changes a document.
 *
 *   Limits Rivhit documents: 200 requests / minute, a 30-second response cap ("narrow the range"), no paging.
 *   Calls are paced (MIN_INTERVAL_MS) and every caller passes a bounded range.
 *
 *   Errors are bounded codes; the token, a response body or a customer value never reaches a message or a log.
 */

export const RIVHIT_BASE_URL = "https://api.rivhit.co.il/online/RivhitOnlineAPI.svc";
/** ~170 calls a minute at most from one process — under Rivhit's 200. */
export const MIN_INTERVAL_MS = 350;
const TIMEOUT_MS = 28_000;

export type RivhitErrorCode = "unauthorized" | "rate_limited" | "rivhit_error" | "unreachable" | "malformed";

export class RivhitApiError extends Error {
  constructor(readonly code: RivhitErrorCode) {
    super(code);
    this.name = "RivhitApiError";
  }
}

type RivhitFetch = (url: string, init: { method: "POST"; headers: Record<string, string>; body: string }) => Promise<{ status: number; json: unknown }>;

const realFetch: RivhitFetch = async (url, init) => {
  const r = await fetch(url, { ...init, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
  let json: unknown = null;
  try {
    json = await r.json();
  } catch {
    json = null;
  }
  return { status: r.status, json };
};
let rivhitFetch: RivhitFetch = realFetch;
let pace = true;
export function setRivhitFetchForTests(fn: RivhitFetch | null, opts: { pace?: boolean } = {}): void {
  if (process.env.NODE_ENV === "production") throw new Error("test hook disabled in production");
  rivhitFetch = fn ?? realFetch;
  pace = opts.pace ?? fn === null;
}

let lastCallAt = 0;
async function paced(): Promise<void> {
  if (!pace) return;
  const wait = lastCallAt + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt = Date.now();
}

/** The READ operations, and only those. */
export type RivhitReadOp =
  | "Company.Details"
  | "Document.TypeList"
  | "Receipt.TypeList"
  | "Payment.TypeList"
  | "Document.List"
  | "Document.Details"
  | "Receipt.List"
  | "Receipt.Details"
  | "Document.Last"
  | "Receipt.Last"
  | "Company.SummaryReport";

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
export function isRivhitToken(v: unknown): v is string {
  return typeof v === "string" && UUID.test(v);
}

/**
 * One call. Resolves to `data` (null when Rivhit answers "no data found", error_code 204); rejects with a
 * bounded {@link RivhitApiError}.
 */
export async function rivhitCall(op: RivhitReadOp, token: string, body: Record<string, unknown> = {}): Promise<unknown> {
  if (!isRivhitToken(token)) throw new RivhitApiError("unauthorized");
  await paced();
  let res: { status: number; json: unknown };
  try {
    res = await rivhitFetch(`${RIVHIT_BASE_URL}/${op}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ ...body, api_token: token }),
    });
  } catch {
    throw new RivhitApiError("unreachable");
  }
  const j = (res.json ?? null) as { error_code?: unknown; data?: unknown } | null;
  const code = typeof j?.error_code === "number" ? j.error_code : typeof j?.error_code === "string" ? Number.parseInt(j.error_code, 10) : NaN;
  if (res.status === 401 || res.status === 403 || code === 401) throw new RivhitApiError("unauthorized");
  if (res.status === 429) throw new RivhitApiError("rate_limited");
  if (code === 204) return null;
  if (res.status >= 500 && !Number.isFinite(code)) throw new RivhitApiError("unreachable");
  if (res.status !== 200 || code !== 0) throw new RivhitApiError(Number.isFinite(code) ? "rivhit_error" : "malformed");
  return j?.data ?? null;
}

/** DD/MM/YYYY, the date format every list filter accepts. */
export function rivhitDate(day: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) throw new Error("rivhit: day must be YYYY-MM-DD");
  return `${m[3]}/${m[2]}/${m[1]}`;
}

export type ListRange =
  | { kind: "number"; type: number; from: number; to: number }
  | { kind: "date"; fromType: number; toType: number; fromDay: string; toDay: string };

function rangeBody(range: ListRange, prefix: "document" | "receipt"): Record<string, unknown> {
  if (range.kind === "number") {
    return {
      [`from_${prefix}_type`]: range.type,
      [`to_${prefix}_type`]: range.type,
      [`from_${prefix}_number`]: Math.max(1, range.from),
      [`to_${prefix}_number`]: Math.min(999_999, range.to),
    };
  }
  return {
    [`from_${prefix}_type`]: range.fromType,
    [`to_${prefix}_type`]: range.toType,
    from_date: rivhitDate(range.fromDay),
    to_date: rivhitDate(range.toDay),
  };
}

function listOf(data: unknown, key: string): unknown[] {
  if (data === null) return [];
  const v = (data as Record<string, unknown> | null)?.[key];
  if (!Array.isArray(v)) throw new RivhitApiError("malformed");
  return v;
}

function lastNumber(data: unknown, key: string): number {
  if (data === null) return 0;
  const v = (data as Record<string, unknown> | null)?.[key];
  const m = /^(?:\d+\/)?0*(\d+)$/.exec(typeof v === "number" ? String(v) : typeof v === "string" ? v.trim() : "");
  if (!m) throw new RivhitApiError("malformed");
  return Number(m[1]);
}

export const rivhit = {
  companyDetails: (token: string) => rivhitCall("Company.Details", token),
  documentTypes: async (token: string) => listOf(await rivhitCall("Document.TypeList", token), "document_type_list"),
  receiptTypes: async (token: string) => listOf(await rivhitCall("Receipt.TypeList", token), "receipt_type_list"),
  paymentTypes: async (token: string) => listOf(await rivhitCall("Payment.TypeList", token), "payment_type_list"),
  documentList: async (token: string, range: ListRange) => listOf(await rivhitCall("Document.List", token, rangeBody(range, "document")), "document_list"),
  receiptList: async (token: string, range: ListRange) => listOf(await rivhitCall("Receipt.List", token, rangeBody(range, "receipt")), "receipt_list"),
  documentDetails: (token: string, type: number, number: number) => rivhitCall("Document.Details", token, { document_type: type, document_number: number }),
  receiptDetails: (token: string, type: number, number: number) => rivhitCall("Receipt.Details", token, { receipt_type: type, receipt_number: number }),
  /** The number of the last document / receipt of a type (0 when the type has none). Only the number is kept. */
  lastDocumentNumber: async (token: string, type: number) => lastNumber(await rivhitCall("Document.Last", token, { document_type: type }), "document_number"),
  lastReceiptNumber: async (token: string, type: number) => lastNumber(await rivhitCall("Receipt.Last", token, { receipt_type: type }), "receipt_number"),
  summaryReport: (token: string, day: string) => {
    const [y, m, d] = day.split("-").map(Number);
    return rivhitCall("Company.SummaryReport", token, { year: y, month: m, day: d });
  },
};
