import { buildClientAuthHeaders } from "@/lib/client-session";

/**
 * Document ↔ supplier link client (flag `document_supplier_linking`). A 404 from these routes means the
 * feature is OFF for this business (or the record is not the business's): the caller renders nothing.
 */

export type LinkMethod = "MANUAL_PICK" | "SUGGESTION_ACCEPTED";
export type SuggestionReason = "TAX_ID" | "NAME";

export type SupplierSuggestion = {
  supplierId: number;
  name: string;
  isActive: boolean;
  reason: SuggestionReason;
  strength: "STRONG" | "WEAK";
};

export type SuggestionNote =
  | "NO_READING"
  | "INCOME_DOCUMENT"
  | "OWN_BUSINESS_NAME"
  | "SEVERAL_SUPPLIERS_SHARE_TAX_ID"
  | "TAX_ID_INVALID"
  | "CONFLICTING_TAX_IDS";

export type DocumentSupplierLinkState = {
  documentId: number;
  version: number;
  link: {
    supplierId: number;
    supplierName: string;
    supplierActive: boolean;
    method: LinkMethod;
    suggestionReason: SuggestionReason | null;
    linkedAt: string;
  } | null;
  reading: {
    vendorName: string | null;
    /** False ⇒ no supplier identified with confidence (a generic word, or the business itself). */
    vendorIdentified: boolean;
    issuerTaxId: string | null;
    issuerCheck: string | null;
    ownBusinessExcluded: boolean;
  } | null;
  suggestions: SupplierSuggestion[];
  notes: SuggestionNote[];
  replayed?: boolean;
};

export type SupplierDocumentRow = {
  documentId: number;
  linkedAt: string;
  method: LinkMethod;
  fileName: string | null;
  receivedAt: string;
  status: string;
  vendorName: string | null;
  documentDate: string | null;
  approved: { amount: number; direction: string; date: string } | null;
};

export class SupplierLinkHttpError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: buildClientAuthHeaders(), cache: "no-store" });
  if (res.status === 401) throw new Error("UNAUTHORIZED");
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new SupplierLinkHttpError(res.status, body?.error ?? "FAILED");
  }
  return (await res.json()) as T;
}

/** null ⇒ the feature is OFF (404). */
export async function getDocumentSupplierLink(documentId: number): Promise<DocumentSupplierLinkState | null> {
  try {
    return await call<DocumentSupplierLinkState>(`/api/documents/${documentId}/supplier-link`);
  } catch (e) {
    if (e instanceof SupplierLinkHttpError && e.status === 404) return null;
    throw e;
  }
}

export function newIdempotencyKey(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID().replace(/-/g, "");
  return `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

export function changeDocumentSupplierLink(
  documentId: number,
  body:
    | { action: "link"; supplierId: number; method: LinkMethod; suggestionReason?: SuggestionReason | null; expectedVersion: number; idempotencyKey: string }
    | { action: "unlink"; expectedVersion: number; idempotencyKey: string }
    | { action: "dismiss"; supplierId: number; idempotencyKey: string }
): Promise<DocumentSupplierLinkState> {
  return call<DocumentSupplierLinkState>(`/api/documents/${documentId}/supplier-link`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** null ⇒ the feature is OFF (404). */
export async function getSupplierDocuments(
  supplierId: number,
  page: { offset: number; limit: number }
): Promise<{ rows: SupplierDocumentRow[]; total: number; hasMore: boolean } | null> {
  try {
    return await call(`/api/inventory/suppliers/${supplierId}/documents?offset=${page.offset}&limit=${page.limit}`);
  } catch (e) {
    if (e instanceof SupplierLinkHttpError && e.status === 404) return null;
    throw e;
  }
}
