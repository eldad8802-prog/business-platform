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

import { createHash, randomUUID } from "node:crypto";
import { getStorageService, normalizeStorageKey, parseStorageKey } from "@/lib/storage";
import { StorageConfigError } from "@/lib/storage/storage.errors";
import type { StorageDomain } from "@/lib/storage/types";
import {
  PublicAssetRejectedError,
  verifyPublicAsset,
} from "./public-asset-validation";

export { PublicAssetRejectedError } from "./public-asset-validation";

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
    case "video/mp4":
      return "mp4";
    case "video/webm":
      return "webm";
    case "video/quicktime":
      return "mov";
    default:
      // M-2: CLOSED set. There is no catch-all any more — an unknown image/*
      // (svg+xml, x-icon, heic, ...) used to be stored as ".img" with the
      // client's Content-Type, which is how SVG reached a public bucket.
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

export type StoredPublicAsset = {
  key: string;
  publicUrl: string;
  filename: string;
  /**
   * What an erasure / audit ledger (workstream E, M-13) needs to track the
   * object without re-reading it: the VERIFIED content type, byte size and a
   * sha256 of the stored bytes.
   */
  businessId: number;
  domain: PublicAssetDomain;
  contentType: string;
  sizeBytes: number;
  sha256: string;
};

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

/**
 * The ONLY writer of public objects. Verification (M-2) runs here, before any
 * storage call, so no caller can put unverified bytes in a public domain:
 * a rejected file throws {@link PublicAssetRejectedError} and nothing is written.
 *
 * `contentType` is the CLIENT's declared type — it is checked, never stored.
 * The stored Content-Type / Content-Disposition / Cache-Control come from the
 * verified container.
 */
export async function putPublicAsset(input: {
  businessId: number;
  domain: PublicAssetDomain;
  body: Buffer;
  contentType: string;
  /** Client filename — used only for the extension-consistency check. */
  fileName?: string | null;
  custom?: Record<string, string>;
}): Promise<StoredPublicAsset> {
  const verdict = verifyPublicAsset({
    domain: input.domain,
    body: input.body,
    declaredContentType: input.contentType,
    fileName: input.fileName,
  });
  if (!verdict.ok) {
    throw new PublicAssetRejectedError(verdict);
  }

  const filename = `${randomUUID()}.${verdict.ext}`;
  const key = buildPublicAssetKey(input.businessId, input.domain, filename);

  await getStorageService().putObject({
    key,
    body: input.body,
    contentType: verdict.contentType,
    contentDisposition: `${verdict.contentDisposition}; filename="${filename}"`,
    cacheControl: verdict.cacheControl,
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
    businessId: input.businessId,
    domain: input.domain,
    contentType: verdict.contentType,
    sizeBytes: input.body.length,
    sha256: createHash("sha256").update(input.body).digest("hex"),
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
