import type { SupplierConnectorResult, SupplierConnectorType } from "./types";

export type SupplierConnectorContext = {
  businessId?: number;
  userId?: number;
  credentials?: unknown;
  config?: Record<string, unknown>;
};

export interface SupplierConnector {
  readonly type: SupplierConnectorType;
  readonly displayName: string;

  fetchOrders(context: SupplierConnectorContext): Promise<SupplierConnectorResult>;
}

