import { buildClientAuthHeaders } from "@/lib/client-session";

/**
 * Read-only lists the inventory overview and "דורש טיפול" show next to stock:
 * product drafts awaiting review, POS sales awaiting a match, and supplier-purchase
 * drafts awaiting receipt. Existing endpoints, unchanged; each is best-effort so one
 * failing source never hides the others (the screen says which part failed).
 */
export type PendingProductDraft = { id: number; name: string; imageUrl?: string | null; status: string; confidence?: number | null };
export type PendingSale = { id: number; name: string; quantity: number | null; createdAt?: string };
export type PendingOrderDraft = { id: number; supplierName: string | null; lineCount: number; createdAt?: string; status: string };

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: buildClientAuthHeaders(), cache: "no-store" });
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}

export async function loadPendingProductDrafts(): Promise<PendingProductDraft[]> {
  const data = (await getJson("/api/inventory/drafts?status=PENDING_REVIEW")) as { drafts?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>;
  const rows = Array.isArray(data) ? data : data?.drafts ?? [];
  return rows
    .filter((d) => (d.status ?? "PENDING_REVIEW") === "PENDING_REVIEW")
    .map((d) => ({
      id: Number(d.id),
      name: String(d.detectedName ?? d.name ?? "טיוטת מוצר"),
      imageUrl: (d.imageUrl as string) ?? null,
      status: String(d.status ?? "PENDING_REVIEW"),
      confidence: typeof d.confidenceScore === "number" ? (d.confidenceScore as number) : null,
    }));
}

export async function loadPendingSales(): Promise<PendingSale[]> {
  const data = (await getJson("/api/inventory/unmatched")) as { pendingMatches?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>;
  const rows = Array.isArray(data) ? data : data?.pendingMatches ?? [];
  return rows.map((r) => {
    const meta = (r.metadata ?? {}) as Record<string, unknown>;
    return {
      id: Number(r.id),
      name: String(meta.name ?? meta.sku ?? meta.barcode ?? r.externalSaleId ?? "פריט מהקופה"),
      quantity: typeof meta.quantity === "number" ? (meta.quantity as number) : null,
      createdAt: r.createdAt as string | undefined,
    };
  });
}

export async function loadPendingOrderDrafts(): Promise<PendingOrderDraft[]> {
  const data = (await getJson("/api/inventory/supplier-purchases")) as { drafts?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>;
  const rows = Array.isArray(data) ? data : data?.drafts ?? [];
  return rows
    .filter((d) => d.status === "PENDING_REVIEW")
    .map((d) => ({
      id: Number(d.id),
      supplierName: (d.supplierName as string) ?? null,
      lineCount: Array.isArray(d.lines) ? (d.lines as unknown[]).length : 0,
      createdAt: d.createdAt as string | undefined,
      status: String(d.status),
    }));
}
