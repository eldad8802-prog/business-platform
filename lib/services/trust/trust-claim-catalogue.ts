import { createHash } from "node:crypto";
import type { TrustClaimClass, TrustClaimKind } from "@prisma/client";

/**
 * P3-A · The trust-claim catalogue — pure, no database.
 *
 * A trust claim is a statement Dubiz may one day make about a business ("since 1998", "a licensed
 * electrician", "12-month guarantee"). It is closed and typed on purpose:
 *   - the KIND fixes the CLASS (the database CHECK BusinessTrustClaim_kind_class agrees);
 *   - the owner gives structured PARAMETERS, never free wording — the wording is rendered here, so a
 *     claim cannot smuggle in a superlative ("number 1", "the best", "trusted by hundreds");
 *   - SERVED_CUSTOMERS is the only evidence-backed kind: it binds to an evidence CONDITION
 *     (rule + version + "served customers ≥ bucket"), never to a count;
 *   - LICENSED / CERTIFIED / AUTHORIZED_DEALER are verification-required: an owner attestation plus a
 *     PRIVATE supporting document; their public wording says the information was provided by the
 *     business — there is no external verifier.
 * PROHIBITED is vocabulary only: no kind maps to it.
 */

export const TRUST_CLAIM_KINDS = ["FOUNDED_YEAR", "SERVED_CUSTOMERS", "LICENSED", "CERTIFIED", "AUTHORIZED_DEALER", "GUARANTEE"] as const satisfies readonly TrustClaimKind[];

export const CLAIM_CLASS: Record<TrustClaimKind, TrustClaimClass> = {
  SERVED_CUSTOMERS: "SAFE_FACTUAL",
  FOUNDED_YEAR: "OWNER_ASSERTED",
  GUARANTEE: "OWNER_ASSERTED",
  LICENSED: "VERIFICATION_REQUIRED",
  CERTIFIED: "VERIFICATION_REQUIRED",
  AUTHORIZED_DEALER: "VERIFICATION_REQUIRED",
};

/** Owner-asserted and verification claims are re-confirmed every 12 months (unless they expire earlier). */
export const RECONFIRM_MONTHS = 12;

/** SERVED_CUSTOMERS public buckets: a claim says "more than N", N from this list, never an exact count. */
export const SERVED_CUSTOMER_BUCKETS = [50, 100, 200, 500, 1000, 2000, 5000, 10000] as const;

export const EVIDENCE_RULE_VERSION = "p3.evidence.v1";
export const SERVED_CUSTOMERS_RULE_ID = "p3.served_customers";

export class TrustClaimInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrustClaimInputError";
  }
}

export function isTrustClaimKind(value: unknown): value is TrustClaimKind {
  return typeof value === "string" && (TRUST_CLAIM_KINDS as readonly string[]).includes(value);
}

export function isVerificationRequired(kind: TrustClaimKind): boolean {
  return CLAIM_CLASS[kind] === "VERIFICATION_REQUIRED";
}

/** The largest bucket a served-customer count supports (null below the smallest). */
export function servedCustomersBucket(count: number): number | null {
  let best: number | null = null;
  for (const b of SERVED_CUSTOMER_BUCKETS) if (count >= b) best = b;
  return best;
}

export function wordingHash(wording: string): string {
  return createHash("sha256").update(wording, "utf8").digest("hex");
}

function text(value: unknown, field: string, max: number, required = true): string | null {
  if (value === undefined || value === null || (typeof value === "string" && !value.trim())) {
    if (required) throw new TrustClaimInputError(`${field} is required`);
    return null;
  }
  if (typeof value !== "string") throw new TrustClaimInputError(`${field} must be text`);
  const v = value.replace(/\s+/g, " ").trim();
  if (v.length > max) throw new TrustClaimInputError(`${field} is too long`);
  // Parameters name things (a licence, an issuer, a brand); they are not a place for links or contacts.
  if (/(https?:\/\/|www\.|@)/i.test(v)) throw new TrustClaimInputError(`${field} cannot hold links or contact details`);
  return v;
}

function isoDate(value: unknown, field: string, now: Date): Date | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new TrustClaimInputError(`${field} must be YYYY-MM-DD`);
  const d = new Date(`${value}T23:59:59.000Z`);
  if (Number.isNaN(d.getTime())) throw new TrustClaimInputError(`${field} is not a date`);
  if (d.getTime() <= now.getTime()) throw new TrustClaimInputError(`${field} has already passed`);
  return d;
}

function scope(prefix: string, ...parts: (string | null)[]): string {
  const h = createHash("sha256").update(parts.map((p) => (p ?? "").toLowerCase()).join("|"), "utf8").digest("hex").slice(0, 16);
  return `${prefix}-${h}`;
}

export type NormalizedClaim = {
  kind: TrustClaimKind;
  claimClass: TrustClaimClass;
  scopeKey: string;
  params: Record<string, string | number>;
  wording: string;
  validUntil: Date | null;
  evidence: { ruleId: string; ruleVersion: string; condition: { metric: "served_customers"; gte: number } } | null;
};

/**
 * Validate the owner's parameters for one kind and render the canonical wording. Throws
 * TrustClaimInputError. `servedCustomers` = the CURRENT evidence (p3.evidence.v1) — a SERVED_CUSTOMERS
 * claim can only be confirmed for a bucket that evidence supports today.
 */
export function normalizeTrustClaim(kind: unknown, raw: unknown, ctx: { now: Date; servedCustomers: number | null }): NormalizedClaim {
  if (!isTrustClaimKind(kind)) throw new TrustClaimInputError("Unknown claim kind");
  const p = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const base = { kind, claimClass: CLAIM_CLASS[kind] };
  switch (kind) {
    case "FOUNDED_YEAR": {
      const year = Number(p.foundedYear);
      if (!Number.isInteger(year) || year < 1800 || year > ctx.now.getUTCFullYear()) throw new TrustClaimInputError("foundedYear must be a past year");
      return { ...base, scopeKey: "default", params: { foundedYear: year }, wording: `פועלים מאז ${year}`, validUntil: null, evidence: null };
    }
    case "SERVED_CUSTOMERS": {
      const threshold = Number(p.threshold);
      if (!(SERVED_CUSTOMER_BUCKETS as readonly number[]).includes(threshold)) throw new TrustClaimInputError("threshold must be one of the public buckets");
      if (ctx.servedCustomers === null || ctx.servedCustomers < threshold) {
        throw new TrustClaimInputError("The business's own completed work does not support this number yet");
      }
      return {
        ...base,
        scopeKey: "default",
        params: { threshold },
        wording: `שירתנו יותר מ-${threshold.toLocaleString("en-US")} לקוחות`,
        validUntil: null,
        evidence: { ruleId: SERVED_CUSTOMERS_RULE_ID, ruleVersion: EVIDENCE_RULE_VERSION, condition: { metric: "served_customers", gte: threshold } },
      };
    }
    case "LICENSED": {
      const licenseType = text(p.licenseType, "licenseType", 80)!;
      const issuer = text(p.issuer, "issuer", 80)!;
      const licenseNumber = text(p.licenseNumber, "licenseNumber", 40, false);
      const validUntil = isoDate(p.validUntil, "validUntil", ctx.now);
      return {
        ...base,
        scopeKey: scope("lic", licenseType, issuer),
        params: { licenseType, issuer, ...(licenseNumber ? { licenseNumber } : {}), ...(validUntil ? { validUntil: String(p.validUntil) } : {}) },
        wording: `בעל/ת רישיון ${licenseType} מטעם ${issuer} (לפי מידע שמסר העסק)`,
        validUntil,
        evidence: null,
      };
    }
    case "CERTIFIED": {
      const certificationName = text(p.certificationName, "certificationName", 80)!;
      const issuer = text(p.issuer, "issuer", 80)!;
      const validUntil = isoDate(p.validUntil, "validUntil", ctx.now);
      return {
        ...base,
        scopeKey: scope("cert", certificationName, issuer),
        params: { certificationName, issuer, ...(validUntil ? { validUntil: String(p.validUntil) } : {}) },
        wording: `${certificationName} מטעם ${issuer} (לפי מידע שמסר העסק)`,
        validUntil,
        evidence: null,
      };
    }
    case "AUTHORIZED_DEALER": {
      const brand = text(p.brand, "brand", 80)!;
      const validUntil = isoDate(p.validUntil, "validUntil", ctx.now);
      return {
        ...base,
        scopeKey: scope("dealer", brand),
        params: { brand, ...(validUntil ? { validUntil: String(p.validUntil) } : {}) },
        wording: `משווק מורשה של ${brand} (לפי מידע שמסר העסק)`,
        validUntil,
        evidence: null,
      };
    }
    case "GUARANTEE": {
      const coverage = text(p.coverage, "coverage", 120)!;
      const duration = text(p.duration, "duration", 40)!;
      const conditions = text(p.conditions, "conditions", 200)!;
      return {
        ...base,
        scopeKey: "default",
        params: { coverage, duration, conditions },
        wording: `אחריות ${duration} על ${coverage}. ${conditions}`,
        validUntil: null,
        evidence: null,
      };
    }
  }
}

/** The kinds the claim guard (P2 claim-like text) can point an owner to. */
export const CLAIM_LIKE_TO_KIND: Record<string, TrustClaimKind | null> = {
  FOUNDED_YEAR: "FOUNDED_YEAR",
  SERVED_CUSTOMERS: "SERVED_CUSTOMERS",
  LICENSED: "LICENSED",
  CERTIFIED: "CERTIFIED",
  AUTHORIZED_DEALER: "AUTHORIZED_DEALER",
  GUARANTEE: "GUARANTEE",
  PROHIBITED_SUPERLATIVE: null,
};
