import { buildClientAuthHeaders } from "@/lib/client-session";

export type InventoryAlertDTO = {
  id: number;
  type: string;
  message?: string | null;
  isResolved?: boolean;
  createdAt?: string;
};

export type InventoryCategoryDTO = {
  id: number;
  businessId: number;
  name: string;
  createdAt: string;
  updatedAt: string;
};

export type InventoryPendingMatchMetadataDTO = {
  externalSaleId: string;
  sku: string | null;
  barcode: string | null;
  name: string | null;
  quantity: number;
  source: string | null;
  unmatchedItems?: Array<{
    sku: string | null;
    barcode: string | null;
    name: string | null;
    quantity: number;
  }>;
  allItems?: Array<{
    sku: string | null;
    barcode: string | null;
    name: string | null;
    quantity: number;
  }>;
};

export type InventoryPendingMatchDTO = {
  id: number;
  businessId: number;
  externalSaleId: string;
  status: "PENDING" | "RESOLVED" | "REJECTED";
  metadata: InventoryPendingMatchMetadataDTO;
  createdAt: string;
  resolvedAt?: string | null;
  resolvedByUserId?: number | null;
  resolvedItemId?: number | null;
};

export type InventoryItemDTO = {
  id: number;
  name: string;
  sku?: string | null;
  barcode: string | null;
  unitType: string;
  supplierName?: string | null;
  currentQuantity: number;
  minimumQuantity: number;
  reorderPoint: number | null;
  costPerUnit?: number | null;
  sellPricePerUnit?: number | null;
  lastPurchaseCost?: number | null;
  lastPurchaseCostAt?: string | null;
  imageUrl?: string | null;
  alerts?: InventoryAlertDTO[];
  categoryId?: number | null;
  category?: InventoryCategoryDTO | null;
};

export type InventoryMovementDTO = {
  id: number;
  itemId: number;
  movementType: string;
  reason: string;
  quantityDelta: number;
  quantityBefore: number;
  quantityAfter: number;
  note: string | null;
  createdAt: string;
};

export type CreateInventorySaleInput = {
  items: Array<{
    itemId: number;
    quantity: number;
  }>;
  note?: string;
};

export type ResolvePendingMatchInput =
  | {
      action: "LINK_EXISTING";
      itemId: number;
    }
  | {
      action: "CREATE_NEW";
      itemData: {
        name: string;
        unitType: string;
        minimumQuantity?: number;
        reorderPoint?: number | null;
        costPerUnit?: number | null;
        sellPricePerUnit?: number | null;
        sku?: string | null;
        barcode?: string | null;
      };
    }
  | {
      action: "REJECT";
    };

function buildHeaders() {
  return buildClientAuthHeaders();
}

/**
 * fetch with a hard timeout so a hung request rejects instead of leaving the
 * caller (and its loading UI) stuck forever. On timeout the promise rejects and
 * each caller's existing catch surfaces an error state. 15s is well above any
 * healthy response, so it only trips on genuine hangs / lost connections.
 */
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
    // Surface a friendly, localized message instead of the raw
    // "signal is aborted without reason" AbortError text.
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new Error("הבקשה ארכה זמן רב מדי. בדקו את החיבור ונסו שוב.");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function getInventoryItems(): Promise<InventoryItemDTO[]> {
  const res = await fetchWithTimeout("/api/inventory/items", {
    method: "GET",
    headers: buildHeaders(),
    cache: "no-store",
  });

  if (res.status === 401) {
    throw new Error("UNAUTHORIZED");
  }

  if (!res.ok) {
    throw new Error("Failed to fetch inventory items");
  }

  const data = await res.json();
  return data.items || [];
}

export async function getInventoryCategories(): Promise<InventoryCategoryDTO[]> {
  const res = await fetchWithTimeout("/api/inventory/categories", {
    method: "GET",
    headers: buildHeaders(),
    cache: "no-store",
  });

  if (res.status === 401) {
    throw new Error("UNAUTHORIZED");
  }

  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error || "Failed to fetch inventory categories");
  }

  const data = await res.json();
  return data.categories || [];
}

export async function createInventoryCategory(data: {
  name: string;
}): Promise<InventoryCategoryDTO> {
  const res = await fetchWithTimeout("/api/inventory/categories", {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify(data),
  });

  if (res.status === 401) {
    throw new Error("UNAUTHORIZED");
  }

  if (!res.ok) {
    const responseData = await res.json().catch(() => null);
    throw new Error(
      responseData?.error || "Failed to create inventory category"
    );
  }

  const responseData = await res.json();
  return responseData.category;
}

export async function getInventoryItemById(
  id: number
): Promise<InventoryItemDTO> {
  const res = await fetchWithTimeout(`/api/inventory/items/${id}`, {
    method: "GET",
    headers: buildHeaders(),
    cache: "no-store",
  });

  if (res.status === 401) {
    throw new Error("UNAUTHORIZED");
  }

  if (res.status === 404) {
    throw new Error("NOT_FOUND");
  }

  if (!res.ok) {
    throw new Error("Failed to fetch inventory item");
  }

  const data = await res.json();
  return data.item;
}

export async function getInventoryMovementsByItemId(
  itemId: number
): Promise<InventoryMovementDTO[]> {
  const res = await fetchWithTimeout(`/api/inventory/movements?itemId=${itemId}`, {
    method: "GET",
    headers: buildHeaders(),
    cache: "no-store",
  });

  if (res.status === 401) {
    throw new Error("UNAUTHORIZED");
  }

  if (!res.ok) {
    throw new Error("Failed to fetch movements");
  }

  const data = await res.json();
  return data.movements || [];
}

export async function createInventoryItem(data: {
  name: string;
  barcode?: string | null;
  sku?: string | null;
  supplierName?: string | null;
  unitType: string;
  initialQuantity: number;
  minimumQuantity: number;
  reorderPoint?: number | null;
  costPerUnit?: number | null;
  sellPricePerUnit?: number | null;
  categoryId?: number | null;
}) {
  const res = await fetchWithTimeout("/api/inventory/items", {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify(data),
  });

  if (res.status === 401) {
    throw new Error("UNAUTHORIZED");
  }

  if (!res.ok) {
    const responseData = await res.json().catch(() => null);
    throw new Error(responseData?.error || "Failed to create inventory item");
  }

  const responseData = await res.json();
  return responseData.item;
}

export async function updateInventoryItem(
  id: number,
  data: {
    imageUrl?: string | null;
    name?: string;
    unitType?: string;
    minimumQuantity?: number;
    reorderPoint?: number | null;
    costPerUnit?: number | null;
    sellPricePerUnit?: number | null;
    sku?: string | null;
    barcode?: string | null;
    isActive?: boolean;
    categoryId?: number | null;
  }
) {
  const res = await fetchWithTimeout(`/api/inventory/items/${id}`, {
    method: "PATCH",
    headers: buildHeaders(),
    body: JSON.stringify(data),
  });

  if (res.status === 401) {
    throw new Error("UNAUTHORIZED");
  }

  if (res.status === 404) {
    throw new Error("NOT_FOUND");
  }

  if (!res.ok) {
    const responseData = await res.json().catch(() => null);
    throw new Error(responseData?.error || "Failed to update inventory item");
  }

  const responseData = await res.json();
  return responseData.item;
}

export async function uploadInventoryItemImage(itemId: number, file: File) {
  const token =
    typeof window !== "undefined" ? localStorage.getItem("token") : null;

  const formData = new FormData();
  formData.append("file", file);

  const res = await fetchWithTimeout(`/api/inventory/items/${itemId}/image`, {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    body: formData,
  });

  if (res.status === 401) {
    throw new Error("UNAUTHORIZED");
  }

  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error || "Upload failed");
  }

  const data = await res.json();
  return data.item;
}

export async function createInventoryMovement(data: {
  itemId: number;
  quantityDelta: number;
  movementType: string;
  reason: string;
  note?: string;
}) {
  const res = await fetchWithTimeout("/api/inventory/movements", {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify(data),
  });

  if (res.status === 401) {
    throw new Error("UNAUTHORIZED");
  }

  if (!res.ok) {
    const responseData = await res.json().catch(() => null);
    throw new Error(
      responseData?.error || "Failed to create inventory movement"
    );
  }

  const responseData = await res.json();
  return responseData.movement;
}

export async function createInventorySale(data: CreateInventorySaleInput) {
  const res = await fetchWithTimeout("/api/inventory/sales", {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify(data),
  });

  if (res.status === 401) {
    throw new Error("UNAUTHORIZED");
  }

  if (!res.ok) {
    const responseData = await res.json().catch(() => null);
    throw new Error(responseData?.error || "Failed to create inventory sale");
  }

  const responseData = await res.json();
  return responseData;
}

export async function resolveInventoryAlert(alertId: number) {
  const response = await fetchWithTimeout(`/api/inventory/alerts/${alertId}/resolve`, {
    method: "PATCH",
    headers: buildHeaders(),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || "Failed to resolve alert");
  }

  return data;
}

export async function getInventoryAlerts(params?: {
  type?: string;
  isResolved?: boolean;
}) {
  const searchParams = new URLSearchParams();

  if (params?.type) {
    searchParams.set("type", params.type);
  }

  if (typeof params?.isResolved === "boolean") {
    searchParams.set("isResolved", String(params.isResolved));
  }

  const queryString = searchParams.toString();
  const url = queryString
    ? `/api/inventory/alerts?${queryString}`
    : "/api/inventory/alerts";

  const res = await fetchWithTimeout(url, {
    method: "GET",
    headers: buildHeaders(),
    cache: "no-store",
  });

  if (res.status === 401) {
    throw new Error("UNAUTHORIZED");
  }

  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error || "Failed to fetch inventory alerts");
  }

  const data = await res.json();
  return data.alerts || [];
}

export async function getPendingMatches(): Promise<InventoryPendingMatchDTO[]> {
  const res = await fetchWithTimeout("/api/inventory/unmatched", {
    method: "GET",
    headers: buildHeaders(),
    cache: "no-store",
  });

  if (res.status === 401) {
    throw new Error("UNAUTHORIZED");
  }

  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error || "Failed to fetch pending matches");
  }

  const data = await res.json();
  return data.pendingMatches || [];
}

export type PurchaseOrderLineDTO = {
  id: number;
  itemId: number | null;
  rawName: string | null;
  sku: string | null;
  barcode: string | null;
  orderedQty: number;
  unitCost: number | null;
  unitType: string | null;
  status: string;
  receivedQty?: number;
  closedShortQty?: number;
  openQty?: number;
  remainingDecision?: string | null;
};

export type PurchaseOrderDTO = {
  id: number;
  supplierName: string | null;
  externalOrderId: string | null;
  status: string;
  orderDate: string | null;
  createdAt: string;
  lines: PurchaseOrderLineDTO[];
};

export async function getPurchaseOrder(id: number): Promise<PurchaseOrderDTO> {
  const res = await fetchWithTimeout(`/api/inventory/purchase-orders/${id}`, {
    method: "GET",
    headers: buildHeaders(),
    cache: "no-store",
  });
  if (res.status === 401) throw new Error("UNAUTHORIZED");
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error || "Failed to fetch purchase order");
  }
  const data = await res.json();
  return data.purchaseOrder;
}

export async function createReceivingSession(
  purchaseOrderId: number,
  payload: { lines: Array<{ purchaseOrderLineId: number; receivedQty: number; unitCost?: number | null }>; note?: string | null }
): Promise<{ id: number }> {
  const res = await fetchWithTimeout(`/api/inventory/purchase-orders/${purchaseOrderId}/receiving-sessions`, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify(payload),
  });
  if (res.status === 401) throw new Error("UNAUTHORIZED");
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error || "Failed to create receiving session");
  }
  const data = await res.json();
  return data.receivingSession;
}

export async function postReceivingSession(receivingSessionId: number) {
  const res = await fetchWithTimeout(`/api/inventory/receiving-sessions/${receivingSessionId}/post`, {
    method: "POST",
    headers: buildHeaders(),
  });
  if (res.status === 401) throw new Error("UNAUTHORIZED");
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error || "Failed to post receiving session");
  }
  return res.json();
}

export async function setLineRemainingDecision(
  purchaseOrderId: number,
  lineId: number,
  payload: { remainingDecision: string; remainingDecisionQty?: number | null; remainingDecisionNote?: string | null }
) {
  const res = await fetchWithTimeout(`/api/inventory/purchase-orders/${purchaseOrderId}/lines/${lineId}/remaining-decision`, {
    method: "PATCH",
    headers: buildHeaders(),
    body: JSON.stringify(payload),
  });
  if (res.status === 401) throw new Error("UNAUTHORIZED");
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error || "Failed to set remaining decision");
  }
  return res.json();
}

export async function resolvePendingMatch(
  pendingMatchId: number,
  data: ResolvePendingMatchInput
) {
  const res = await fetchWithTimeout(`/api/inventory/unmatched/${pendingMatchId}/resolve`, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify(data),
  });

  if (res.status === 401) {
    throw new Error("UNAUTHORIZED");
  }

  if (!res.ok) {
    const responseData = await res.json().catch(() => null);
    throw new Error(responseData?.error || "Failed to resolve pending match");
  }

  return res.json();
}
