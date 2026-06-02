import { STORAGE_DOMAINS, type ParsedStorageKey, type StorageDomain } from "./types";
import { StorageKeyError } from "./storage.errors";

const DOMAIN_SET = new Set<string>(STORAGE_DOMAINS);

const STORAGE_KEY_PATTERN =
  /^biz\/(\d+)\/(documents|billing|content|inventory|offers)\/(.+)$/;

export function normalizeStorageKey(key: string): string {
  const trimmed = key.trim().replace(/\\/g, "/");
  while (trimmed.includes("//")) {
    const next = trimmed.replace("//", "/");
    if (next === trimmed) break;
    return normalizeStorageKey(next);
  }
  return trimmed.replace(/^\/+/, "");
}

export function parseStorageKey(key: string): ParsedStorageKey {
  const normalized = normalizeStorageKey(key);
  const match = STORAGE_KEY_PATTERN.exec(normalized);

  if (!match) {
    throw new StorageKeyError(
      "Storage key must match biz/{businessId}/{domain}/..."
    );
  }

  const businessId = Number(match[1]);
  const domain = match[2] as StorageDomain;
  const relativePath = match[3];

  if (!Number.isInteger(businessId) || businessId <= 0) {
    throw new StorageKeyError("Storage key businessId must be a positive integer");
  }

  if (!relativePath || relativePath.length === 0) {
    throw new StorageKeyError("Storage key must include an object path after domain");
  }

  if (relativePath.includes("..")) {
    throw new StorageKeyError("Storage key must not contain '..'");
  }

  return { businessId, domain, relativePath };
}

export function assertSafeStorageKey(key: string): string {
  if (!key || typeof key !== "string") {
    throw new StorageKeyError("Storage key is required");
  }

  if (key.includes("\0")) {
    throw new StorageKeyError("Storage key must not contain null bytes");
  }

  const normalized = normalizeStorageKey(key);

  if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) {
    throw new StorageKeyError("Storage key must be a relative path");
  }

  const parsed = parseStorageKey(normalized);

  if (!DOMAIN_SET.has(parsed.domain)) {
    throw new StorageKeyError(`Unknown storage domain: ${parsed.domain}`);
  }

  return normalized;
}

export function assertKeyMatchesMetadata(
  key: string,
  businessId: number,
  domain: StorageDomain
): void {
  const normalized = assertSafeStorageKey(key);
  const parsed = parseStorageKey(normalized);

  if (parsed.businessId !== businessId) {
    throw new StorageKeyError("Storage key businessId does not match metadata.businessId");
  }

  if (parsed.domain !== domain) {
    throw new StorageKeyError("Storage key domain does not match metadata.domain");
  }
}
