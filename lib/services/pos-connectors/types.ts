export type POSConnectorType = string;

export type NormalizedSaleEventLine = {
  externalProductId?: string | null;
  sku?: string | null;
  barcode?: string | null;
  name?: string | null;
  quantity: number;
  unitPrice?: number | null;
  rawPayload?: unknown;
};

export type NormalizedSaleEvent = {
  externalSaleId: string;
  businessId?: number;
  source: POSConnectorType;
  soldAt: string | Date;
  rawPayload: unknown;
  lines: NormalizedSaleEventLine[];
};

export type POSConnectorResult = {
  success: boolean;
  connectorType: POSConnectorType;
  sales: NormalizedSaleEvent[];
  errors?: Array<{
    message: string;
    code?: string;
    details?: unknown;
  }>;
  meta?: Record<string, unknown>;
};

