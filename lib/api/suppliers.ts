import { buildClientAuthHeaders } from "@/lib/client-session";
import type {
  SupplierPaymentMethod,
  SupplierTaxIdType,
} from "@/lib/services/inventory/supplier-profile";

/**
 * Supplier CRM surface client (Phase S1).
 *
 * Reuses the existing inventory supplier routes (`/api/inventory/suppliers`,
 * `/api/inventory/suppliers/[id]`) — no new route or read-model is introduced.
 * The inventory error taxonomy stays server-side: this client only observes HTTP
 * status codes + the `{ error }` message string, so `InventoryError` never leaks
 * into the CRM surface. The wire returns the raw Supplier row (including the
 * caller's own `businessId`, which is not another tenant's and is intentionally
 * ignored here).
 */

export type SupplierStatusFilter = "active" | "inactive" | "all";

export type SupplierListRow = {
  id: number;
  name: string;
  isActive: boolean;
  phone: string | null;
  email: string | null;
};

export type Supplier = {
  id: number;
  name: string;
  isActive: boolean;
  phone: string | null;
  email: string | null;
  notes: string | null;
  defaultLeadTimeDays: number | null;
  legalName: string | null;
  taxId: string | null;
  taxIdType: SupplierTaxIdType | null;
  category: string | null;
  website: string | null;
  contactName: string | null;
  contactRole: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  addressStreet: string | null;
  addressCity: string | null;
  addressPostalCode: string | null;
  paymentTermsDays: number | null;
  preferredPaymentMethod: SupplierPaymentMethod | null;
  createdAt: string;
  updatedAt: string;
};

/** Why the server thinks an existing supplier might be the same one. */
export type SupplierMatchReason = "TAX_ID" | "PHONE" | "EMAIL" | "NAME";

export type PossibleSupplierMatch = {
  id: number;
  name: string;
  isActive: boolean;
  phone: string | null;
  email: string | null;
  taxId: string | null;
  reasons: SupplierMatchReason[];
};

/**
 * Creation result. The server has ALWAYS returned `possibleMatches` alongside
 * the created supplier; the client used to read only `data.supplier` and drop
 * them on the floor, which is why two identical suppliers could be created with
 * no warning at all. Returning both makes the advisory reachable.
 */
export type CreateSupplierResult = {
  supplier: Supplier;
  possibleMatches: PossibleSupplierMatch[];
};

export type CreateSupplierInput = {
  name: string;
  phone?: string | null;
  email?: string | null;
  notes?: string | null;
  defaultLeadTimeDays?: number | null;
  legalName?: string | null;
  taxId?: string | null;
  taxIdType?: SupplierTaxIdType | null;
  category?: string | null;
  website?: string | null;
  contactName?: string | null;
  contactRole?: string | null;
  contactPhone?: string | null;
  contactEmail?: string | null;
  addressStreet?: string | null;
  addressCity?: string | null;
  addressPostalCode?: string | null;
  paymentTermsDays?: number | null;
  preferredPaymentMethod?: SupplierPaymentMethod | null;
};

/** Fields the existing PATCH route already supports. */
export type UpdateSupplierInput = {
  name?: string;
  phone?: string | null;
  email?: string | null;
  notes?: string | null;
  defaultLeadTimeDays?: number | null;
  isActive?: boolean;
  legalName?: string | null;
  taxId?: string | null;
  taxIdType?: SupplierTaxIdType | null;
  category?: string | null;
  website?: string | null;
  contactName?: string | null;
  contactRole?: string | null;
  contactPhone?: string | null;
  contactEmail?: string | null;
  addressStreet?: string | null;
  addressCity?: string | null;
  addressPostalCode?: string | null;
  paymentTermsDays?: number | null;
  preferredPaymentMethod?: SupplierPaymentMethod | null;
};

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init?: RequestInit,
  timeoutMs = 15000
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new Error("הבקשה ארכה זמן רב מדי. בדקו את החיבור ונסו שוב.");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function extractError(res: Response, fallback: string): Promise<string> {
  try {
    const data = await res.json();
    if (data?.error) return data.error as string;
  } catch {
    /* ignore */
  }
  return fallback;
}

export async function getSuppliers(options?: {
  query?: string;
  status?: SupplierStatusFilter;
}): Promise<SupplierListRow[]> {
  const params = new URLSearchParams();
  const q = options?.query?.trim();
  if (q) params.set("q", q);
  // Default is "active" server-side; only send when the caller widens the scope.
  if (options?.status && options.status !== "active") {
    params.set("status", options.status);
  }
  const qs = params.toString() ? `?${params.toString()}` : "";

  const res = await fetchWithTimeout(`/api/inventory/suppliers${qs}`, {
    method: "GET",
    headers: buildClientAuthHeaders(),
    cache: "no-store",
  });

  if (res.status === 401) throw new Error("UNAUTHORIZED");
  if (!res.ok) throw new Error("Failed to fetch suppliers");

  const data = await res.json();
  return (data.suppliers || []) as SupplierListRow[];
}

export async function getSupplier(id: number): Promise<Supplier> {
  const res = await fetchWithTimeout(`/api/inventory/suppliers/${id}`, {
    method: "GET",
    headers: buildClientAuthHeaders(),
    cache: "no-store",
  });

  if (res.status === 401) throw new Error("UNAUTHORIZED");
  if (res.status === 404) throw new Error("NOT_FOUND");
  if (!res.ok) throw new Error("Failed to fetch supplier");

  const data = await res.json();
  return data.supplier as Supplier;
}

export async function createSupplier(
  input: CreateSupplierInput
): Promise<CreateSupplierResult> {
  const res = await fetchWithTimeout("/api/inventory/suppliers", {
    method: "POST",
    headers: buildClientAuthHeaders(),
    body: JSON.stringify(input),
  });

  if (res.status === 401) throw new Error("UNAUTHORIZED");
  if (!res.ok) throw new Error(await extractError(res, "Failed to create supplier"));

  const data = await res.json();
  return {
    supplier: data.supplier as Supplier,
    possibleMatches: Array.isArray(data.possibleMatches)
      ? (data.possibleMatches as PossibleSupplierMatch[])
      : [],
  };
}

/**
 * Supplier purchase history (S4-P5 UI reading the S4-P4 read model). Mirrors the
 * `GET /api/inventory/suppliers/[id]/purchase-orders` response shape 1:1. Orders
 * are related to the supplier by id server-side; `supplierName` here is the Tier-1
 * snapshot for display only. `status` is kept as a plain string so the Prisma enum
 * never reaches the client bundle.
 */
export type SupplierPurchaseHistorySummary = {
  purchaseOrderCount: number;
  openPurchaseOrderCount: number;
  lastPurchaseOrderAt: string | null;
  /** Actually received (posted) value — spend, not intent. */
  receivedValue: number;
  orderedValue: number;
  linesWithoutCost: number;
  totalLineCount: number;
};

export type SupplierPurchasedItem = {
  itemId: number;
  name: string;
  orderCount: number;
  totalQty: number;
  firstUnitCost: number | null;
  lastUnitCost: number | null;
};

export type SupplierPurchaseOrderItem = {
  id: number;
  supplierId: number | null;
  supplierName: string | null;
  status: string;
  orderDate: string | null;
  createdAt: string;
  lineCount: number;
  orderedValue: number | null;
};

export type SupplierPurchaseHistory = {
  summary: SupplierPurchaseHistorySummary;
  items: SupplierPurchaseOrderItem[];
  purchasedItems: SupplierPurchasedItem[];
  pagination: { limit: number; offset: number; total: number; hasMore: boolean };
};

export async function getSupplierPurchaseHistory(
  id: number,
  options?: { limit?: number; offset?: number }
): Promise<SupplierPurchaseHistory> {
  const params = new URLSearchParams();
  if (options?.limit != null) params.set("limit", String(options.limit));
  if (options?.offset != null) params.set("offset", String(options.offset));
  const qs = params.toString() ? `?${params.toString()}` : "";

  const res = await fetchWithTimeout(
    `/api/inventory/suppliers/${id}/purchase-orders${qs}`,
    {
      method: "GET",
      headers: buildClientAuthHeaders(),
      cache: "no-store",
    }
  );

  if (res.status === 401) throw new Error("UNAUTHORIZED");
  if (res.status === 404) throw new Error("NOT_FOUND");
  if (!res.ok) throw new Error("Failed to fetch purchase history");

  return (await res.json()) as SupplierPurchaseHistory;
}

export async function updateSupplier(
  id: number,
  input: UpdateSupplierInput
): Promise<Supplier> {
  const res = await fetchWithTimeout(`/api/inventory/suppliers/${id}`, {
    method: "PATCH",
    headers: buildClientAuthHeaders(),
    body: JSON.stringify(input),
  });

  if (res.status === 401) throw new Error("UNAUTHORIZED");
  if (res.status === 404) throw new Error("NOT_FOUND");
  if (!res.ok) throw new Error(await extractError(res, "Failed to update supplier"));

  const data = await res.json();
  return data.supplier as Supplier;
}
