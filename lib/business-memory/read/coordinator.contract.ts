/**
 * Business Memory READ-3 · Read Coordinator — CONTRACT (pure types).
 *
 * The coordinator combines the INCUMBENT decision (decideCategory / VendorLearning) with the R1 Claim
 * Reader and an S2 read-time freshness check, and returns a COMPARISON-READY, fail-open result. In
 * READ-3 the `effective` decision is ALWAYS the incumbent — zero product behavior change. INERT: no
 * product call-site, no BUSINESS_MEMORY_READ flag, no read-switch.
 */
import type { ReadClaimQuery, ReadClaimResult } from "./read-claim.contract";
import type { DomainLocalSubject } from "@/lib/business-memory/evidence";

/** The incumbent category decision shape (mirrors decideCategory's return). */
export interface IncumbentDecision {
  readonly category: string;
  readonly confidence: "high" | "medium" | "low";
}

/** Every reason the coordinator falls back to the incumbent (never a truncation of a real answer). */
export type FallbackReason =
  | "conflicting"
  | "absent"
  | "stale"
  | "invalid"
  | "unavailable"
  | "resolver-failure"
  | "evidence-failure"
  | "unexpected";

/** What Business Memory would contribute — never applied to the product in READ-3. */
export type MemoryOutcome =
  | { readonly status: "supported"; readonly category: string; readonly fresh: boolean; readonly fallbackReason: "stale" | null }
  | { readonly status: "conflicting"; readonly candidates: readonly string[]; readonly fallbackReason: "conflicting" }
  | { readonly status: "absent"; readonly fallbackReason: "absent" }
  | { readonly status: "invalid"; readonly fallbackReason: "invalid" }
  | { readonly status: "unavailable"; readonly fallbackReason: Extract<FallbackReason, "unavailable" | "resolver-failure" | "evidence-failure" | "unexpected"> };

/**
 * Log-safe observation. Deliberately excludes raw vendor, normalized subject, category value, and any
 * evidence payload. Only identity/outcome signals.
 */
export interface CoordinatorObservation {
  readonly businessId: number;
  readonly claimType: "vendor-category";
  readonly policyKey?: string;
  readonly versionLabel?: string;
  readonly policyVersionId?: number;
  readonly outcome: "memory-available" | "fallback";
  readonly fallbackReason: FallbackReason | null;
  readonly fingerprintMatch?: boolean;
}

/** The coordinator's comparison-ready result. `effective` is ALWAYS `incumbent` in READ-3. */
export interface VendorCategoryDecision {
  readonly incumbent: IncumbentDecision;
  readonly memory: MemoryOutcome;
  readonly effective: IncumbentDecision;
  readonly observation: CoordinatorObservation;
}

export interface CoordinatorInput {
  readonly businessId: number; // trusted, from server context
  readonly vendorName: string;
  readonly text: string;
}

export interface EvidenceIdentity {
  readonly fingerprint: string;
}

export interface ResolvedPolicyIdentity {
  readonly policyKey: string;
  readonly versionLabel: string;
  readonly policyVersionId: number;
}

/** Injectable collaborators — the coordinator core is DB-free-testable; defaults wire the real ones. */
export interface CoordinatorDeps {
  decideCategory(businessId: number, vendorName: string, text: string): Promise<IncumbentDecision>;
  normalize(vendorName: string): { normalizedKey: string };
  resolvePolicyVersion(): Promise<ResolvedPolicyIdentity>;
  readClaim(query: ReadClaimQuery): Promise<ReadClaimResult>;
  readEvidenceIdentity(businessId: number, subject: DomainLocalSubject): Promise<EvidenceIdentity>;
}
