import type { SupplierConnector } from "../connector.interface";
import type { SupplierConnectorResult } from "../types";

export class GoogleSheetsSupplierConnector implements SupplierConnector {
  readonly type = "GOOGLE_SHEETS";
  readonly displayName = "Google Sheets";

  async fetchOrders(): Promise<SupplierConnectorResult> {
    // TODO: Connect to Google Sheets and map to NormalizedSupplierOrder[]
    return {
      success: true,
      connectorType: this.type,
      orders: [],
    };
  }
}

