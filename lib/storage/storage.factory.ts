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
 * Test-only: install a service (e.g. a fake that counts writes). Refused in
 * production so no runtime path can swap the storage backend.
 */
export function setStorageServiceForTests(service: StorageService | null): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error("setStorageServiceForTests is not available in production");
  }
  cachedService = service;
}
