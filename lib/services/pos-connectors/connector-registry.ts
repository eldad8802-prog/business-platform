import type { POSConnector } from "./connector.interface";
import type { POSConnectorType } from "./types";

const registry = new Map<POSConnectorType, POSConnector>();

export function registerPOSConnector(connector: POSConnector) {
  registry.set(connector.type, connector);
}

export function getPOSConnector(type: POSConnectorType) {
  return registry.get(type) ?? null;
}

export function listPOSConnectors() {
  return Array.from(registry.values());
}

