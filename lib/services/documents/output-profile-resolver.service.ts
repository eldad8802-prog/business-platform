import {
  OUTPUT_PROFILE_CACHE_MAX_SIZE,
  OUTPUT_PROFILE_CACHE_TTL_MS_STORED,
  OUTPUT_PROFILE_CACHE_TTL_MS_UNIFIED,
  OUTPUT_PROFILE_UNIFIED_CONFIDENCE_THRESHOLD,
} from "@/lib/constants/output-profile-cache";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { getTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction } from "@/lib/tenant/transaction";

// D2/P7-W4D: run a single DB step on a short tenant transaction when a tenant
// context is established (all document routes set one); outside a context the
// step runs directly (pure unit tests / offline scripts). Under an
// established context there is NO fallback to the global client.
async function dbStep<T>(
  fn: (db: typeof prisma) => Promise<T>
): Promise<T> {
  if (getTenantContext() !== undefined) {
    // TransactionClient supports the same query surface these callbacks use;
    // the cast keeps precise select/include payload types.
    return withTenantTransaction((tx) => fn(tx as unknown as typeof prisma));
  }
  return fn(prisma);
}
import {
  buildDocumentOutputProfile,
  type DocumentOutputProfile,
  type DocumentOutputProfileSource,
} from "@/lib/services/documents/document-output-profile.service";
import type { DocumentType } from "@/lib/services/documents/document-type.service";
import { runUnifiedDocumentIntelligence } from "@/lib/services/documents/unified-extraction-engine.service";

type CacheSource = "snapshot" | "stored" | "unified" | "fallback_no_ocr";

type OutputProfileCacheEntry = {
  documentId: number;
  outputProfile: DocumentOutputProfile;
  source: CacheSource;
  /**
   * Fingerprint of the document state the profile was computed FROM. A profile
   * computed while OCR was still running (no ocrText, no ExtractedData) must
   * never be served once extraction has landed — that exact staleness put real
   * receipts on the quote_or_order path and produced approved-without-
   * FinancialRecord documents in production (Integrity Blueprint §3).
   */
  stateKey: string;
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

const KNOWN_DOCUMENT_TYPES: ReadonlySet<string> = new Set([
  "invoice",
  "receipt",
  "donation_receipt",
  "bank_transfer",
  "quote",
  "non_financial",
]);

type SnapshotForProfile = {
  id: number;
  documentType: string | null;
  isFinancial: boolean | null;
  guardrailRoute: string | null;
  financialEvidenceLevel: string | null;
  confidenceScore: number | null;
  vendorName: string | null;
  category: string | null;
  rawResult: unknown;
};

function isEvidenceLevel(
  v: string | null
): v is DocumentOutputProfileSource["financialEvidenceLevel"] {
  return v === "strong" || v === "weak" || v === "negative" || v === "uncertain";
}

/**
 * Rebuild the profile source from the engine's PERSISTED belief at extraction
 * time (ExtractionSnapshot). This is the root-cause fix for the unreachable
 * `financial_transaction` profile: the live pipeline routes receipts/invoices
 * through the real guardrail and records `guardrailRoute` + `documentType` on
 * the snapshot, but review/approve used to reconstruct a source with
 * `guardrailRoute:"unknown"` — so the financial profile could never resolve and
 * real receipts fell to quote_or_order/unknown_review (Integrity Blueprint §3).
 */
function buildSourceFromSnapshot(params: {
  snapshot: SnapshotForProfile;
  documentStatus: string;
}): DocumentOutputProfileSource | null {
  const s = params.snapshot;

  // A snapshot with no routing belief (legacy row / failed extraction) cannot
  // seed a profile — fall back to the stored heuristic.
  if (!s.guardrailRoute && s.isFinancial == null) return null;

  const documentType: DocumentType =
    s.documentType && KNOWN_DOCUMENT_TYPES.has(s.documentType)
      ? (s.documentType as DocumentType)
      : "receipt";

  const raw = s.rawResult as { searchableText?: unknown } | null;
  const searchableText =
    raw && typeof raw.searchableText === "string" && raw.searchableText.trim()
      ? raw.searchableText
      : [s.vendorName, s.category].filter(Boolean).join(" ");

  return {
    documentType,
    isFinancial: s.isFinancial ?? false,
    guardrailRoute: s.guardrailRoute ?? "unknown",
    searchableText,
    needsReview: params.documentStatus !== "approved",
    confidence: s.confidenceScore ?? 0,
    financialEvidenceLevel: isEvidenceLevel(s.financialEvidenceLevel)
      ? s.financialEvidenceLevel
      : "uncertain",
  };
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

  // State fingerprint: a cached profile is only valid for the SAME document
  // state it was computed from. Without this, a GET issued while OCR was still
  // running seeded a no-OCR ("quote") profile that approve then consumed within
  // the TTL — the production mechanism behind approved-without-FinancialRecord.
  const stateKey = [
    params.documentStatus,
    params.ocrText && params.ocrText.trim().length > 0 ? "ocr" : "no_ocr",
    params.extracted ? "extracted" : "no_extracted",
  ].join("|");

  const cached = cache.get(params.documentId);
  if (cached && !isExpired(cached, now) && cached.stateKey === stateKey) {
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

  // Preferred source: the engine's persisted belief at extraction time.
  // Best-effort — a read failure degrades to the stored/no-OCR heuristics.
  let snapshotSource: DocumentOutputProfileSource | null = null;
  try {
    const snapshot = await dbStep((db) => db.extractionSnapshot.findFirst({
      where: { documentId: params.documentId, businessId: params.businessId },
      orderBy: { id: "desc" },
      select: {
        id: true,
        documentType: true,
        isFinancial: true,
        guardrailRoute: true,
        financialEvidenceLevel: true,
        confidenceScore: true,
        vendorName: true,
        category: true,
        rawResult: true,
      },
    }));
    if (snapshot) {
      snapshotSource = buildSourceFromSnapshot({
        snapshot,
        documentStatus: params.documentStatus,
      });
    }
  } catch (err) {
    console.error("[output-profile] snapshot read failed (non-fatal):", err);
  }

  if (snapshotSource) {
    const outputProfile = buildDocumentOutputProfile(snapshotSource);
    const entry: OutputProfileCacheEntry = {
      documentId: params.documentId,
      outputProfile,
      source: "snapshot",
      stateKey,
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
      outputProfile,
      outputProfileSource: "snapshot",
      outputProfileComputedAt: toIso(now),
      outputProfileDebug: entry.debug,
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
      stateKey,
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
      stateKey,
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
    stateKey,
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

