/**
 * Shared receive path for the three public-asset upload routes (M-2):
 *   POST /api/content/upload             domain "content"
 *   POST /api/offers/image               domain "offers"
 *   POST /api/inventory/items/[id]/image domain "inventory"
 *
 * Order (each step refuses before the next costs anything):
 *   rate limit (per user AND per business) → Content-Length precheck →
 *   multipart parse → real byte length → putPublicAsset (verify, then write).
 *
 * The routes keep their own auth and response shapes; this owns the part that
 * must be identical on all three, so no route can drift back to "any image/*".
 */

import { consumeRateLimit } from "@/lib/security/rate-limit";
import {
  PUBLIC_ASSET_POLICIES,
  PublicAssetRejectedError,
  type PublicAssetRejectionCode,
} from "./public-asset-validation";
import {
  putPublicAsset,
  type PublicAssetDomain,
  type StoredPublicAsset,
} from "./public-asset-storage.service";

/** Multipart framing on top of the file itself. */
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

export type PublicUploadRateLimits = {
  userPerHour: number;
  businessPerDay: number;
};

export const PUBLIC_UPLOAD_RATE_LIMITS: Record<PublicAssetDomain, PublicUploadRateLimits> = {
  content: { userPerHour: 30, businessPerDay: 200 },
  offers: { userPerHour: 30, businessPerDay: 200 },
  inventory: { userPerHour: 60, businessPerDay: 500 },
};

/** Rate-limit key prefixes. `content` keeps its historical keys verbatim. */
const RATE_KEY_PREFIX: Record<PublicAssetDomain, string> = {
  content: "content:upload",
  offers: "offers:image",
  inventory: "inventory:item-image",
};

export type PublicUploadFailure = {
  ok: false;
  status: 400 | 413 | 415 | 429;
  code:
    | "RATE_LIMITED"
    | "BODY_TOO_LARGE"
    | "MISSING_FILE"
    | "BAD_MULTIPART"
    | PublicAssetRejectionCode;
  error: string;
};

export type PublicUploadResult =
  | { ok: true; stored: StoredPublicAsset }
  | PublicUploadFailure;

type RateLimiter = typeof consumeRateLimit;

export async function receivePublicAssetUpload(input: {
  req: Request;
  user: { id: number; businessId: number };
  domain: PublicAssetDomain;
  source: string;
  /** Test seam only; production uses the shared limiter. */
  rateLimiter?: RateLimiter;
}): Promise<PublicUploadResult> {
  const { req, user, domain } = input;
  const limiter = input.rateLimiter ?? consumeRateLimit;
  const limits = PUBLIC_UPLOAD_RATE_LIMITS[domain];
  const prefix = RATE_KEY_PREFIX[domain];

  const userLimit = await limiter({
    key: `${prefix}:user:${user.id}`,
    limit: limits.userPerHour,
    windowMs: 60 * 60_000,
  });
  if (!userLimit.allowed) {
    return tooMany();
  }
  const businessLimit = await limiter({
    key: `${prefix}:business:${user.businessId}`,
    limit: limits.businessPerDay,
    windowMs: 24 * 60 * 60_000,
  });
  if (!businessLimit.allowed) {
    return tooMany();
  }

  const maxBytes = PUBLIC_ASSET_POLICIES[domain].maxBytes;
  const declaredLength = Number(req.headers.get("content-length") ?? "");
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > maxBytes + MULTIPART_OVERHEAD_BYTES
  ) {
    return {
      ok: false,
      status: 413,
      code: "BODY_TOO_LARGE",
      error: `File too large (max ${Math.round(maxBytes / 1024 / 1024)}MB)`,
    };
  }

  let file: FormDataEntryValue | null;
  try {
    const formData = await req.formData();
    file = formData.get("file");
  } catch {
    return { ok: false, status: 400, code: "BAD_MULTIPART", error: "Invalid upload" };
  }
  if (!file || typeof file === "string") {
    return { ok: false, status: 400, code: "MISSING_FILE", error: "No file" };
  }
  // Cheap refusal on the declared size before buffering; the real length is
  // re-checked on the bytes inside verifyPublicAsset.
  if (typeof file.size === "number" && file.size > maxBytes) {
    return {
      ok: false,
      status: 413,
      code: "TOO_LARGE",
      error: `File too large (max ${Math.round(maxBytes / 1024 / 1024)}MB)`,
    };
  }

  const body = Buffer.from(await file.arrayBuffer());

  try {
    const stored = await putPublicAsset({
      businessId: user.businessId,
      domain,
      body,
      contentType: file.type,
      fileName: "name" in file ? (file as File).name : null,
      custom: { source: input.source },
    });
    return { ok: true, stored };
  } catch (error) {
    if (error instanceof PublicAssetRejectedError) {
      return { ok: false, status: error.status, code: error.code, error: error.message };
    }
    throw error;
  }
}

function tooMany(): PublicUploadFailure {
  return {
    ok: false,
    status: 429,
    code: "RATE_LIMITED",
    error: "Too many requests. Please try again later.",
  };
}
