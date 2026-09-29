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

/**
 * A tenant+domain-scoped key PREFIX for list/delete-by-prefix (erasure).
 *
 * Must be exactly `biz/{businessId}/{domain}/` optionally followed by further
 * safe path segments, and must END with "/" so `biz/4/` can never match
 * `biz/42/...`. No `..`, no empty/"." segments, no NUL, no backslash tricks
 * (normalized first). A bare `biz/` or `biz/{id}/` (all domains) is refused —
 * bulk operations are always confined to one tenant AND one domain.
 */
export function assertSafeStoragePrefix(prefix: string): {
  prefix: string;
  businessId: number;
  domain: StorageDomain;
} {
  if (!prefix || typeof prefix !== "string") {
    throw new StorageKeyError("Storage prefix is required");
  }
  if (prefix.includes("\0")) {
    throw new StorageKeyError("Storage prefix must not contain null bytes");
  }
  const normalized = normalizeStorageKey(prefix);
  if (!normalized.endsWith("/")) {
    throw new StorageKeyError("Storage prefix must end with '/'");
  }
  const m = new RegExp(`^biz/([0-9]+)/(${STORAGE_DOMAINS.join("|")})/(.*)$`).exec(normalized);
  if (!m) {
    throw new StorageKeyError("Storage prefix must match biz/{businessId}/{domain}/...");
  }
  const businessId = Number(m[1]);
  if (!Number.isInteger(businessId) || businessId <= 0 || String(businessId) !== m[1]) {
    throw new StorageKeyError("Storage prefix businessId must be a positive integer");
  }
  const rest = m[3];
  if (rest.length > 0) {
    const segments = rest.slice(0, -1).split("/");
    for (const seg of segments) {
      if (seg === "" || seg === "." || seg === "..") {
        throw new StorageKeyError("Storage prefix contains an invalid path segment");
      }
    }
  }
  return { prefix: normalized, businessId, domain: m[2] as StorageDomain };
}
