export type SupplierConnectorType = string;

export type NormalizedSupplierOrderLine = {
  lineId: string;
  productName: string;
  quantity: number;
  unitType?: string | null;
  sku?: string | null;
  barcode?: string | null;
  notes?: string | null;
};

export type NormalizedSupplierOrder = {
  orderId: string;
  connectorType: SupplierConnectorType;
  supplierName?: string | null;
  externalOrderId?: string | null;
  orderDate?: string | Date | null;
  currency?: string | null;
  raw?: unknown;
  lines: NormalizedSupplierOrderLine[];
};

export type SupplierConnectorResult = {
  success: boolean;
  connectorType: SupplierConnectorType;
  orders: NormalizedSupplierOrder[];
  errors?: Array<{
    message: string;
    code?: string;
    details?: unknown;
  }>;
  meta?: Record<string, unknown>;
};

