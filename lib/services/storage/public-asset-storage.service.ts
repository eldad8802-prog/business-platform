/**
 * Public asset storage adapter — StorageService writes + CDN/public URLs.
 *
 * Keys (v1.1):
 *   biz/{businessId}/content/{uuid}.{ext}
 *   biz/{businessId}/inventory/{uuid}.{ext}
 *   biz/{businessId}/offers/{uuid}.{ext}
 *
 * DB / API continue storing the client-facing URL string (not the storage key).
 */

import { randomUUID } from "node:crypto";
import { getStorageService, normalizeStorageKey, parseStorageKey } from "@/lib/storage";
import { StorageConfigError } from "@/lib/storage/storage.errors";
import type { StorageDomain } from "@/lib/storage/types";

export type PublicAssetDomain = Extract<StorageDomain, "content" | "inventory" | "offers">;

const PUBLIC_ASSET_DOMAINS = new Set<PublicAssetDomain>([
  "content",
  "inventory",
  "offers",
]);

export function extensionFromMime(mimeType: string): string | null {
  const mime = String(mimeType || "").toLowerCase().trim();
  switch (mime) {
    case "image/jpeg":
    case "image/jpg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    case "image/heic":
      return "heic";
    case "image/heif":
      return "heif";
    case "video/mp4":
      return "mp4";
    case "video/webm":
      return "webm";
    case "video/quicktime":
      return "mov";
    default:
      if (mime.startsWith("image/")) return "img";
      if (mime.startsWith("video/")) return "mp4";
      return null;
  }
}

export function buildPublicAssetFileName(contentType: string): string {
  const ext = extensionFromMime(contentType);
  if (!ext) {
    throw new Error("Unsupported content type for public asset upload");
  }
  return `${randomUUID()}.${ext}`;
}

export function buildPublicAssetKey(
  businessId: number,
  domain: PublicAssetDomain,
  filename: string
): string {
  if (!Number.isInteger(businessId) || businessId <= 0) {
    throw new Error("buildPublicAssetKey: invalid businessId");
  }
  if (!PUBLIC_ASSET_DOMAINS.has(domain)) {
    throw new Error("buildPublicAssetKey: invalid public asset domain");
  }
  const safeName = String(filename || "").trim();
  if (!safeName || safeName.includes("/") || safeName.includes("..")) {
    throw new Error("buildPublicAssetKey: invalid filename");
  }
  return `biz/${businessId}/${domain}/${safeName}`;
}

function assertPublicAssetKey(key: string): void {
  const parsed = parseStorageKey(normalizeStorageKey(key));
  if (!PUBLIC_ASSET_DOMAINS.has(parsed.domain as PublicAssetDomain)) {
    throw new StorageConfigError(
      `Public asset key must use domain content, inventory, or offers`
    );
  }
}

export function requirePublicAssetUrl(key: string): string {
  assertPublicAssetKey(key);
  const normalized = normalizeStorageKey(key);

  const fromAdapter = getStorageService().getPublicUrl(normalized);
  if (fromAdapter) {
    return fromAdapter;
  }

  const publicBase = process.env.R2_PUBLIC_BASE_URL?.trim();
  const isProduction = process.env.NODE_ENV === "production";

  if (isProduction || !publicBase) {
    throw new StorageConfigError(
      "Public asset URL is not configured. Set R2_PUBLIC_BASE_URL and STORAGE_PROVIDER=r2 for public uploads."
    );
  }

  return `${publicBase.replace(/\/+$/, "")}/${normalized}`;
}

export async function putPublicAsset(input: {
  businessId: number;
  domain: PublicAssetDomain;
  body: Buffer;
  contentType: string;
  custom?: Record<string, string>;
}): Promise<{ key: string; publicUrl: string; filename: string }> {
  const filename = buildPublicAssetFileName(input.contentType);
  const key = buildPublicAssetKey(input.businessId, input.domain, filename);

  await getStorageService().putObject({
    key,
    body: input.body,
    contentType: input.contentType,
    metadata: {
      businessId: input.businessId,
      domain: input.domain,
      visibility: "public",
      custom: input.custom,
    },
  });

  return {
    key,
    filename,
    publicUrl: requirePublicAssetUrl(key),
  };
}

/**
 * Creatomate requires publicly fetchable absolute URLs.
 * Legacy camera uploads may still hold `/uploads/...` in localStorage.
 */
export function normalizeAssetUrlForCreatomate(url: string): string {
  const trimmed = String(url || "").trim();
  if (!trimmed) {
    return trimmed;
  }

  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }

  if (trimmed.startsWith("/")) {
    const base =
      process.env.APP_BASE_URL?.trim() ||
      process.env.NEXT_PUBLIC_APP_URL?.trim();
    if (base) {
      return `${base.replace(/\/+$/, "")}${trimmed}`;
    }
  }

  return trimmed;
}

export function normalizeAssetUrlsForCreatomate(urls: string[]): string[] {
  return urls.map(normalizeAssetUrlForCreatomate).filter(Boolean);
}

export function isAbsoluteHttpsUrl(url: string): boolean {
  return /^https:\/\/.+/i.test(String(url || "").trim());
}

/**
 * SEC-E / M-13 — delete EVERY public asset one business owns in one public domain, by
 * listing `biz/{businessId}/{domain}/` and deleting what the listing returns.
 *
 * Exists for account erasure and the surfaces it cannot reach any other way: a content
 * upload (`/api/content/upload`) is written to `biz/{id}/content/*` and its URL is kept
 * only in the browser's localStorage. There is NO database pointer, so a row-driven
 * erasure can never find it; the prefix is the only handle there is.
 *
 * Idempotent and resumable: a second run lists nothing (or only what a failed run left)
 * and deletes that. Deleting an already-absent key succeeds on both adapters. The
 * listing is re-read from the start after each page of deletes, so a cursor can never
 * skip an object that shifted position. Bounded so a runaway listing cannot spin.
 *
 * Returns how many delete calls were issued.
 */
export async function deletePublicAssetsOfBusiness(
  businessId: number,
  domain: PublicAssetDomain
): Promise<number> {
  if (!Number.isInteger(businessId) || businessId <= 0) {
    throw new Error("deletePublicAssetsOfBusiness: invalid businessId");
  }
  if (!PUBLIC_ASSET_DOMAINS.has(domain)) {
    throw new Error("deletePublicAssetsOfBusiness: invalid public asset domain");
  }
  const storage = getStorageService();
  const prefix = `biz/${businessId}/${domain}/`;
  let deleted = 0;
  for (let page = 0; page < 1000; page++) {
    const { keys } = await storage.listObjectKeys(prefix, { limit: 500 });
    if (keys.length === 0) return deleted;
    for (const key of keys) {
      // Defence in depth: the adapter already refused a wider prefix, and every key it
      // returns must still parse as this tenant's object in this domain.
      const parsed = parseStorageKey(normalizeStorageKey(key));
      if (parsed.businessId !== businessId || parsed.domain !== domain) {
        throw new StorageConfigError("listing returned a key outside the requested tenant domain");
      }
      await storage.deleteObject(key);
      deleted++;
    }
  }
  throw new StorageConfigError("public asset erasure did not converge within its page bound");
}
