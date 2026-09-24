import { STORAGE_DOMAINS, type ParsedStorageKey, type StorageDomain } from "./types";
import { StorageKeyError } from "./storage.errors";

const DOMAIN_SET = new Set<string>(STORAGE_DOMAINS);

// Derived from STORAGE_DOMAINS (single source of truth) so a new domain — e.g.
// "crm" — is recognized here without editing a second hardcoded list. The
// trailing (.+) allows nested relative paths (e.g. crm/CUSTOMER/49/att-...pdf).
const STORAGE_KEY_PATTERN = new RegExp(
  `^biz/(\\d+)/(${STORAGE_DOMAINS.join("|")})/(.+)$`
);

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

const TENANT_DOMAIN_PREFIX_PATTERN = new RegExp(`^biz/(\\d+)/(${STORAGE_DOMAINS.join("|")})/$`);

/**
 * SEC-E / M-13 — a listing prefix must name exactly ONE tenant's ONE domain directory,
 * `biz/{businessId}/{domain}/`, with the trailing slash. Anything wider (`biz/`,
 * `biz/1` — which would also match `biz/12/...`) is refused, so a listing can never
 * enumerate across tenants.
 */
export function assertTenantDomainPrefix(prefix: string): {
  prefix: string;
  businessId: number;
  domain: StorageDomain;
} {
  if (!prefix || typeof prefix !== "string" || prefix.includes("\0") || prefix.includes("..")) {
    throw new StorageKeyError("Listing prefix is invalid");
  }
  const normalized = normalizeStorageKey(prefix);
  const match = TENANT_DOMAIN_PREFIX_PATTERN.exec(normalized);
  if (!match) {
    throw new StorageKeyError("Listing prefix must be exactly biz/{businessId}/{domain}/");
  }
  const businessId = Number(match[1]);
  if (!Number.isInteger(businessId) || businessId <= 0) {
    throw new StorageKeyError("Listing prefix businessId must be a positive integer");
  }
  return { prefix: normalized, businessId, domain: match[2] as StorageDomain };
}
