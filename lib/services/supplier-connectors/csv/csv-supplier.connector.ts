import type { SupplierConnector } from "../connector.interface";
import type { NormalizedSupplierOrder, SupplierConnectorResult } from "../types";
import { parseCsvToRecords } from "./csv-parser";

export class CsvSupplierConnector implements SupplierConnector {
  readonly type = "CSV";
  readonly displayName = "CSV";

  parseCsvTextToOrders(csvText: string): NormalizedSupplierOrder[] {
    const records = parseCsvToRecords(csvText);
    if (!records.length) return [];

    const orders: NormalizedSupplierOrder[] = [];

    for (let i = 0; i < records.length; i++) {
      const record = records[i] || {};

      const supplierName = (record.supplierName || "").trim() || "Unknown Supplier";
      const externalOrderId = (record.externalOrderId || "").trim() || null;

      const quantityRaw = record.quantity ?? "";
      const quantity = Number(quantityRaw);
      if (!Number.isFinite(quantity) || quantity <= 0) {
        continue;
      }

      const orderId = externalOrderId || `csv-${i + 1}`;

      orders.push({
        orderId,
        connectorType: this.type,
        supplierName,
        externalOrderId,
        raw: record,
        lines: [
          {
            lineId: `line-${i + 1}`,
            productName: (record.rawName || "").trim() || "",
            sku: (record.sku || "").trim() || null,
            barcode: (record.barcode || "").trim() || null,
            quantity,
            unitType: (record.unitType || "").trim() || null,
            notes: (record.notes || "").trim() || null,
          },
        ],
      });
    }

    return orders;
  }

  async fetchOrders(): Promise<SupplierConnectorResult> {
    // TODO: Parse CSV source and map to NormalizedSupplierOrder[]
    return {
      success: true,
      connectorType: this.type,
      orders: [],
    };
  }
}

