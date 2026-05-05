import {
  OUTPUT_PROFILE_CACHE_MAX_SIZE,
  OUTPUT_PROFILE_CACHE_TTL_MS_STORED,
  OUTPUT_PROFILE_CACHE_TTL_MS_UNIFIED,
  OUTPUT_PROFILE_UNIFIED_CONFIDENCE_THRESHOLD,
} from "@/lib/constants/output-profile-cache";
import {
  buildDocumentOutputProfile,
  type DocumentOutputProfile,
  type DocumentOutputProfileSource,
} from "@/lib/services/documents/document-output-profile.service";
import { runUnifiedDocumentIntelligence } from "@/lib/services/documents/unified-extraction-engine.service";

type CacheSource = "stored" | "unified" | "fallback_no_ocr";

type OutputProfileCacheEntry = {
  documentId: number;
  outputProfile: DocumentOutputProfile;
  source: CacheSource;
  computedAtMs: number;
  expiresAtMs: number;
  lastAccessAtMs: number;
  debug?: {
    cacheHit: boolean;
    unifiedAttempted: boolean;
    unifiedReason?: string;
  };
};

const cache = new Map<number, OutputProfileCacheEntry>();

function nowMs(): number {
  return Date.now();
}

function isExpired(e: OutputProfileCacheEntry, now: number): boolean {
  return e.expiresAtMs <= now;
}

function evictIfNeeded() {
  if (cache.size <= OUTPUT_PROFILE_CACHE_MAX_SIZE) return;

  const entries = Array.from(cache.values());
  const now = nowMs();

  // 1) remove expired
  for (const e of entries) {
    if (isExpired(e, now)) cache.delete(e.documentId);
  }
  if (cache.size <= OUTPUT_PROFILE_CACHE_MAX_SIZE) return;

  // 2) remove least-recently-accessed
  const byAccess = Array.from(cache.values()).sort(
    (a, b) => a.lastAccessAtMs - b.lastAccessAtMs
  );
  const overflow = cache.size - OUTPUT_PROFILE_CACHE_MAX_SIZE;
  for (let i = 0; i < overflow; i++) {
    cache.delete(byAccess[i].documentId);
  }
}

function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

function buildSourceFromStored(params: {
  documentStatus: string;
  extracted: {
    amount: number | null;
    vendorName: string | null;
    date: Date | null;
    direction: string | null;
    category: string | null;
    confidenceScore: number | null;
  } | null;
}): DocumentOutputProfileSource {
  const needsReview = params.documentStatus !== "approved";
  const confidence = params.extracted?.confidenceScore ?? 0;

  const hasAmount = typeof params.extracted?.amount === "number";
  const hasVendor = Boolean(params.extracted?.vendorName);
  const hasDirection =
    params.extracted?.direction === "expense" || params.extracted?.direction === "income";

  const isFinancial = Boolean(hasAmount && hasVendor) || Boolean(hasDirection);

  const searchableText = [
    params.extracted?.vendorName,
    params.extracted?.category,
  ]
    .filter(Boolean)
    .join(" ");

  // We don't have these from stored data today; pass safe defaults.
  const docType: DocumentOutputProfileSource["documentType"] = hasDirection || hasAmount
    ? "receipt"
    : "non_financial";

  return {
    documentType: docType,
    isFinancial,
    guardrailRoute: "unknown",
    searchableText,
    needsReview,
    confidence,
    financialEvidenceLevel: isFinancial ? "weak" : "uncertain",
  };
}

export async function resolveDocumentOutputProfile(params: {
  documentId: number;
  businessId: number;
  ocrText: string | null;
  documentStatus: string;
  extracted: {
    amount: number | null;
    vendorName: string | null;
    date: Date | null;
    direction: string | null;
    category: string | null;
    confidenceScore: number | null;
  } | null;
  allowUnified: boolean;
  debug?: boolean;
}): Promise<{
  outputProfile: DocumentOutputProfile;
  outputProfileSource: CacheSource;
  outputProfileComputedAt: string;
  outputProfileDebug?: OutputProfileCacheEntry["debug"];
}> {
  const now = nowMs();
  const cached = cache.get(params.documentId);
  if (cached && !isExpired(cached, now)) {
    cached.lastAccessAtMs = now;
    cache.set(params.documentId, cached);
    return {
      outputProfile: cached.outputProfile,
      outputProfileSource: cached.source,
      outputProfileComputedAt: toIso(cached.computedAtMs),
      outputProfileDebug: params.debug
        ? {
            cacheHit: true,
            unifiedAttempted: Boolean(cached.debug?.unifiedAttempted),
            ...(cached.debug?.unifiedReason
              ? { unifiedReason: cached.debug.unifiedReason }
              : {}),
          }
        : undefined,
    };
  }

  // No OCR → fallback profile (unknown_review minimal)
  if (!params.ocrText || params.ocrText.trim().length === 0) {
    const outputProfile = buildDocumentOutputProfile({
      documentType: "quote",
      isFinancial: true,
      guardrailRoute: "unknown",
      searchableText: "",
      needsReview: true,
      confidence: 0,
      financialEvidenceLevel: "uncertain",
    });

    const entry: OutputProfileCacheEntry = {
      documentId: params.documentId,
      outputProfile,
      source: "fallback_no_ocr",
      computedAtMs: now,
      expiresAtMs: now + OUTPUT_PROFILE_CACHE_TTL_MS_STORED,
      lastAccessAtMs: now,
      debug: params.debug
        ? { cacheHit: false, unifiedAttempted: false, unifiedReason: "no_ocr" }
        : undefined,
    };
    cache.set(params.documentId, entry);
    evictIfNeeded();

    return {
      outputProfile,
      outputProfileSource: "fallback_no_ocr",
      outputProfileComputedAt: toIso(now),
      outputProfileDebug: entry.debug,
    };
  }

  const storedSource = buildSourceFromStored({
    documentStatus: params.documentStatus,
    extracted: params.extracted,
  });

  const storedProfile = buildDocumentOutputProfile(storedSource);

  const confidence = params.extracted?.confidenceScore ?? 0;
  const significantMissing =
    !params.extracted ||
    (!params.extracted.vendorName && (params.extracted.amount == null || params.extracted.amount === 0));

  const shouldRunUnified =
    params.allowUnified &&
    (confidence < OUTPUT_PROFILE_UNIFIED_CONFIDENCE_THRESHOLD || significantMissing);

  if (!shouldRunUnified) {
    const entry: OutputProfileCacheEntry = {
      documentId: params.documentId,
      outputProfile: storedProfile,
      source: "stored",
      computedAtMs: now,
      expiresAtMs: now + OUTPUT_PROFILE_CACHE_TTL_MS_STORED,
      lastAccessAtMs: now,
      debug: params.debug
        ? { cacheHit: false, unifiedAttempted: false }
        : undefined,
    };
    cache.set(params.documentId, entry);
    evictIfNeeded();

    return {
      outputProfile: storedProfile,
      outputProfileSource: "stored",
      outputProfileComputedAt: toIso(now),
      outputProfileDebug: entry.debug,
    };
  }

  // Unified fallback (GET only)
  const unified = await runUnifiedDocumentIntelligence({
    businessId: params.businessId,
    rawText: params.ocrText,
  });

  const entry: OutputProfileCacheEntry = {
    documentId: params.documentId,
    outputProfile: unified.outputProfile,
    source: "unified",
    computedAtMs: now,
    expiresAtMs: now + OUTPUT_PROFILE_CACHE_TTL_MS_UNIFIED,
    lastAccessAtMs: now,
    debug: params.debug
      ? {
          cacheHit: false,
          unifiedAttempted: true,
          unifiedReason:
            confidence < OUTPUT_PROFILE_UNIFIED_CONFIDENCE_THRESHOLD
              ? "low_confidence"
              : "missing_fields",
        }
      : undefined,
  };
  cache.set(params.documentId, entry);
  evictIfNeeded();

  return {
    outputProfile: unified.outputProfile,
    outputProfileSource: "unified",
    outputProfileComputedAt: toIso(now),
    outputProfileDebug: entry.debug,
  };
}

