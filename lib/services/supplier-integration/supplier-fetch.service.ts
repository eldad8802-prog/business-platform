export type SupplierOrderLine = {
  rawName: string | null;
  quantity: number;
  unitType: string | null;
  sku: string | null;
  barcode: string | null;
};

export type SupplierOrder = {
  supplierName: string | null;
  externalOrderId: string | null;
  source: string | null;
  orderDate: string | null;
  lines: SupplierOrderLine[];
};

export async function fetchSupplierOrders(): Promise<SupplierOrder[]> {
  return [
    {
      supplierName: "Demo Supplier",
      externalOrderId: "DEMO-1001",
      source: "MOCK",
      orderDate: new Date().toISOString(),
      lines: [
        {
          rawName: "Coffee Beans",
          quantity: 10,
          unitType: "KG",
          sku: "COF-001",
          barcode: null,
        },
        {
          rawName: "Paper Cups",
          quantity: 500,
          unitType: "UNIT",
          sku: null,
          barcode: "1234567890123",
        },
      ],
    },
  ];
}

