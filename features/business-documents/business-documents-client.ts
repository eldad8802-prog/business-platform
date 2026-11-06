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
