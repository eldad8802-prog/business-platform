import type { POSConnectorResult, POSConnectorType } from "./types";

export type POSConnectorContext = {
  businessId?: number;
  userId?: number;
  credentials?: unknown;
  config?: Record<string, unknown>;
};

export interface POSConnector {
  readonly type: POSConnectorType;
  readonly displayName: string;

  fetchSales(context: POSConnectorContext): Promise<POSConnectorResult>;
}

