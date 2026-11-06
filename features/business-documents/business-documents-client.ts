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
