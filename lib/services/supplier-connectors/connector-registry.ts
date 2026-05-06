import type { SupplierConnector } from "./connector.interface";
import type { SupplierConnectorType } from "./types";
import { CsvSupplierConnector } from "./csv/csv-supplier.connector";
import { GoogleSheetsSupplierConnector } from "./google-sheets/google-sheets.connector";

const registry = new Map<SupplierConnectorType, SupplierConnector>();

export function registerSupplierConnector(connector: SupplierConnector) {
  registry.set(connector.type, connector);
}

registerSupplierConnector(new CsvSupplierConnector());
registerSupplierConnector(new GoogleSheetsSupplierConnector());

export function getSupplierConnector(type: SupplierConnectorType) {
  return registry.get(type) ?? null;
}

export function listSupplierConnectors() {
  return Array.from(registry.values());
}

