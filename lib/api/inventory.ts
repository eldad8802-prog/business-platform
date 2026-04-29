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
  currentQuantity: number;
  minimumQuantity: number;
  reorderPoint: number | null;
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

function getAuthToken() {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("token");
}

function buildHeaders() {
  const token = getAuthToken();

  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

export async function getInventoryItems(): Promise<InventoryItemDTO[]> {
  const res = await fetch("/api/inventory/items", {
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
  const res = await fetch("/api/inventory/categories", {
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
  const res = await fetch("/api/inventory/categories", {
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
  const res = await fetch(`/api/inventory/items/${id}`, {
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
  const res = await fetch(`/api/inventory/movements?itemId=${itemId}`, {
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
  unitType: string;
  initialQuantity: number;
  minimumQuantity: number;
  reorderPoint?: number | null;
  categoryId?: number | null;
}) {
  const res = await fetch("/api/inventory/items", {
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
  const res = await fetch(`/api/inventory/items/${id}`, {
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

  const res = await fetch(`/api/inventory/items/${itemId}/image`, {
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
  const res = await fetch("/api/inventory/movements", {
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
  const res = await fetch("/api/inventory/sales", {
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
  const response = await fetch(`/api/inventory/alerts/${alertId}/resolve`, {
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

  const res = await fetch(url, {
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
  const res = await fetch("/api/inventory/unmatched", {
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

export async function resolvePendingMatch(
  pendingMatchId: number,
  data: ResolvePendingMatchInput
) {
  const res = await fetch(`/api/inventory/unmatched/${pendingMatchId}/resolve`, {
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