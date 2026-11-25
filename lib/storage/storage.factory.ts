import type { StorageService } from "./types";
import { loadStorageConfig } from "./config";
import { LocalFsStorageService } from "./local-storage.adapter";
import { R2StorageService } from "./r2-storage.adapter";
import { MeteredStorageService } from "./metered-storage";

let cachedService: StorageService | null = null;

export function getStorageService(): StorageService {
  if (cachedService) {
    return cachedService;
  }

  const config = loadStorageConfig();
  // Subscriptions stage C: every write and delete is metered (metered-storage.ts) — one choke point for the quota.
  cachedService = new MeteredStorageService(
    config.provider === "local"
      ? new LocalFsStorageService(config)
      : new R2StorageService(config),
  );

  return cachedService;
}

export function resetStorageServiceForTests(): void {
  cachedService = null;
}
