/**
 * Browser calls for the business-documents screens. Every call goes to an EXISTING
 * server route that authenticates the user and scopes the query to the user's own
 * business on the server (session → businessId → tenant transaction). The browser
 * never sends a business id.
 */
import { buildClientAuthHeaders } from "@/lib/client-session";

import type { BillingListRow } from "./customer-documents-model";

export class DocsApiError extends Error {
  constructor(public readonly status: number | null, message: string) {
    super(message);
    this.name = "DocsApiError";
  }
}

async function getJson<T>(url: string, timeoutMs = 15000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: "GET", headers: buildClientAuthHeaders(), cache: "no-store", signal: controller.signal });
    if (!res.ok) throw new DocsApiError(res.status, `HTTP ${res.status}`);
    return (await res.json()) as T;
  } catch (e) {
    if (e instanceof DocsApiError) throw e;
    throw new DocsApiError(null, e instanceof Error ? e.message : String(e));
  } finally {
    clearTimeout(timer);
  }
}

export const PAGE_SIZE = 50;

/** One page of a customer's billing documents, from the existing list route (newest first, id cursor). */
export async function listCustomerDocuments(customerId: number, cursor: number | null): Promise<{ documents: BillingListRow[]; nextCursor: number | null }> {
  const qs = new URLSearchParams({ customerId: String(customerId), limit: String(PAGE_SIZE) });
  if (cursor) qs.set("cursor", String(cursor));
  const data = await getJson<{ documents: BillingListRow[]; nextCursor: number | null }>(`/api/billing/documents?${qs.toString()}`);
  return { documents: data.documents ?? [], nextCursor: data.nextCursor ?? null };
}

/** The customer's display name, from the existing customer card route. */
export async function getCustomerName(customerId: number): Promise<string> {
  const data = await getJson<{ customer?: { name?: string | null } }>(`/api/customers/${customerId}`);
  return (data.customer?.name ?? "").trim();
}

// ---- ר2 letters ----------------------------------------------------------------------------------

export type LetterProblemWire = { field: string; message: string };

export class LetterRequestError extends DocsApiError {
  constructor(status: number | null, public readonly problems: LetterProblemWire[]) {
    super(status, "letter request failed");
    this.name = "LetterRequestError";
  }
}

async function postLetter(path: "preview" | "pdf", body: unknown, signal?: AbortSignal): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`/api/business-documents/letters/${path}`, {
      method: "POST",
      headers: { ...buildClientAuthHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      signal,
    });
  } catch {
    throw new LetterRequestError(null, []);
  }
  if (!res.ok) {
    let problems: LetterProblemWire[] = [];
    try {
      const j = (await res.json()) as { problems?: LetterProblemWire[] };
      problems = Array.isArray(j.problems) ? j.problems : [];
    } catch {
      /* not JSON */
    }
    throw new LetterRequestError(res.status, problems);
  }
  return res;
}

export async function previewLetter(body: unknown, signal?: AbortSignal): Promise<string> {
  return (await postLetter("preview", body, signal)).text();
}

export async function letterPdf(body: unknown, signal?: AbortSignal): Promise<Blob> {
  return (await postLetter("pdf", body, signal)).blob();
}

export type PickOption = { id: number; name: string };

export async function listCustomerOptions(): Promise<PickOption[]> {
  const data = await getJson<{ customers?: Array<{ id: number; name: string }> }>(`/api/customers?status=active`);
  return (data.customers ?? []).map((c) => ({ id: c.id, name: c.name }));
}

export async function listSupplierOptions(): Promise<PickOption[]> {
  const data = await getJson<{ suppliers?: Array<{ id: number; name: string }> }>(`/api/inventory/suppliers?status=active&limit=200`);
  return (data.suppliers ?? []).map((s) => ({ id: s.id, name: s.name }));
}

// ---- ר1 quote share ------------------------------------------------------------------------------

export type ShareEventKindWire = "DOWNLOADED" | "SHARE_SHEET_OPENED" | "MARKED_SENT" | "RESPONSE_ACCEPTED" | "RESPONSE_DECLINED" | "NOTE" | "CORRECTION";

export type ShareableQuote = { id: number; number: string | null; customerName: string | null; total: string; currency: string; validUntil: string | null; convertedToInvoice: boolean; lastEvent: ShareEventKindWire | null };

export type QuoteShareViewWire = {
  quote: { id: number; number: string | null; customerName: string | null; total: string; currency: string; validUntil: string | null; convertedToInvoice: boolean; serviceDesk: boolean };
  currentContentHash: string;
  copies: { id: number; createdAt: string; contentCheckedAt: string; quoteNumber: string; total: string; currency: string; changedSince: boolean }[];
  events: { id: number; kind: ShareEventKindWire; copyId: number | null; channel: string | null; note: string | null; correctsEventId: number | null; createdAt: string; corrected: boolean; olderVersion: boolean }[];
  state: { response: "ACCEPTED" | "DECLINED" | null; sentAt: string | null; staleResponses: number };
};

/** A refusal from the server, with its Hebrew message when it sent one. */
export class ShareRequestError extends DocsApiError {
  constructor(status: number | null, public readonly code: string, message: string) {
    super(status, message);
    this.name = "ShareRequestError";
  }
}

async function postJson<T>(url: string, body: unknown, timeoutMs = 60000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: "POST", headers: { ...buildClientAuthHeaders(), "Content-Type": "application/json" }, body: JSON.stringify(body), cache: "no-store", signal: controller.signal });
    const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string; problems?: { message: string }[] } & T;
    if (!res.ok) throw new ShareRequestError(res.status, data.error ?? "ERROR", data.message ?? data.problems?.[0]?.message ?? "הפעולה נכשלה. נסו שוב.");
    return data as T;
  } catch (e) {
    if (e instanceof ShareRequestError) throw e;
    throw new ShareRequestError(null, "NETWORK", "אין חיבור. נסו שוב.");
  } finally {
    clearTimeout(timer);
  }
}

export async function listShareableQuotes(): Promise<ShareableQuote[]> {
  return (await getJson<{ quotes: ShareableQuote[] }>("/api/business-documents/quotes")).quotes ?? [];
}

export async function getQuoteShare(quoteId: number): Promise<QuoteShareViewWire> {
  return getJson<QuoteShareViewWire>(`/api/business-documents/quotes/${quoteId}/share`);
}

/** A fresh server-issued key for one operation. A retry of the SAME action must reuse the key it got. */
export async function issueKey(operation: "QUOTE_SHARE_COPY" | "QUOTE_SHARE_EVENT" | "LETTER_SAVE"): Promise<string> {
  return (await postJson<{ idempotencyKey: string }>("/api/business-documents/requests", { operation }, 15000)).idempotencyKey;
}

export async function prepareShareCopy(quoteId: number, idempotencyKey: string): Promise<{ id: number }> {
  return postJson<{ id: number }>(`/api/business-documents/quotes/${quoteId}/share/copies`, { idempotencyKey });
}

export async function recordShareEvent(quoteId: number, idempotencyKey: string, event: { kind: ShareEventKindWire; copyId?: number; channel?: string; note?: string; correctsEventId?: number }): Promise<{ id: number }> {
  return postJson<{ id: number }>(`/api/business-documents/quotes/${quoteId}/share/events`, { idempotencyKey, ...event }, 15000);
}

/** The stored copy's bytes (private route; the browser never gets a storage URL). */
export async function fetchCopyPdf(copyId: number): Promise<Blob> {
  const res = await fetch(`/api/business-documents/quote-copies/${copyId}/pdf?download=1`, { headers: buildClientAuthHeaders(), cache: "no-store" });
  if (!res.ok) throw new ShareRequestError(res.status, "FILE", "לא ניתן להוריד את הקובץ השמור.");
  return res.blob();
}

// ---- saved letters -------------------------------------------------------------------------------

export type SavedLetterWire = { id: number; recipientKind: "CUSTOMER" | "SUPPLIER" | "FREE"; recipientName: string; linkRemoved: boolean; subject: string; letterDate: string; createdAt: string };

export async function saveLetterRequest(body: Record<string, unknown>, idempotencyKey: string): Promise<SavedLetterWire> {
  return postJson<SavedLetterWire>("/api/business-documents/letters", { ...body, idempotencyKey });
}

export async function listSavedLetters(): Promise<SavedLetterWire[]> {
  return (await getJson<{ letters: SavedLetterWire[] }>("/api/business-documents/letters")).letters ?? [];
}

export async function hideSavedLetter(letterId: number): Promise<void> {
  await postJson<{ result: string }>(`/api/business-documents/letters/${letterId}/hide`, {}, 15000);
}

export async function fetchSavedLetterPdf(letterId: number): Promise<Blob> {
  const res = await fetch(`/api/business-documents/letters/${letterId}/pdf`, { headers: buildClientAuthHeaders(), cache: "no-store" });
  if (!res.ok) throw new ShareRequestError(res.status, "FILE", "לא ניתן להוריד את המכתב השמור.");
  return res.blob();
}
