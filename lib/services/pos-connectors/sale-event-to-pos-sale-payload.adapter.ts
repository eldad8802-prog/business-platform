import type { NormalizedSaleEvent } from "./types";

export type POSSalePayloadV1Compatible = {
  externalSaleId: string;
  businessId: number;
  source: string;
  items: Array<{
    quantity: number;
    sku?: string | null;
    barcode?: string | null;
    name?: string | null;
    externalProductId?: string | null;
  }>;
};

export type SaleEventToPOSPayloadResult =
  | { valid: true; payload: POSSalePayloadV1Compatible }
  | { valid: false; reason: string };

function toPositiveNumber(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

export function mapSaleEventToPOSSalePayload(
  event: NormalizedSaleEvent
): SaleEventToPOSPayloadResult {
  if (!event?.businessId || Number.isNaN(Number(event.businessId))) {
    return { valid: false, reason: "Missing businessId on sale event" };
  }

  const items = (event.lines || [])
    .map((line) => {
      const quantity = toPositiveNumber(line.quantity);
      if (!quantity) return null;

      return {
        quantity,
        sku: line.sku ?? null,
        barcode: line.barcode ?? null,
        name: line.name ?? null,
        externalProductId: line.externalProductId ?? null,
      };
    })
    .filter(Boolean) as POSSalePayloadV1Compatible["items"];

  if (!items.length) {
    return { valid: false, reason: "No valid sale lines" };
  }

  return {
    valid: true,
    payload: {
      externalSaleId: event.externalSaleId,
      businessId: Number(event.businessId),
      source: String(event.source),
      items,
    },
  };
}

