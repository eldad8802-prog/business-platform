import type { StorageService } from "./types";
import { loadStorageConfig } from "./config";
import { LocalFsStorageService } from "./local-storage.adapter";
import { R2StorageService } from "./r2-storage.adapter";

let cachedService: StorageService | null = null;

export function getStorageService(): StorageService {
  if (cachedService) {
    return cachedService;
  }

  const config = loadStorageConfig();
  cachedService =
    config.provider === "local"
      ? new LocalFsStorageService(config)
      : new R2StorageService(config);

  return cachedService;
}

export function resetStorageServiceForTests(): void {
  cachedService = null;
}

/**
 * TEST SEAM (SEC-E fault injection): install a specific storage service — for example
 * a wrapper around the real local adapter that fails a chosen delete — so the erasure
 * battery can prove a storage error leaves the erasure retryable and converging.
 * Production code never calls this.
 */
export function setStorageServiceForTests(service: StorageService): void {
  cachedService = service;
}
