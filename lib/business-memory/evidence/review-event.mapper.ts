/**
 * Business Memory IMPL-2 · ReviewEvent → Owner-Decision Evidence MAPPER.
 *
 * THE SINGLE PLACE that knows `ReviewEvent` physically (IMPL-2 §4). Everything downstream speaks the
 * store-agnostic contract in ./evidence-contract. If the canonical owner-decision store is ever
 * swapped (unified log / C0), only this file (+ its sibling reader's row source) changes; the contract
 * and every consumer stay put (IMPL-2 §10 store-swap test).
 *
 * Pure functions only — no DB, no Prisma client, no I/O. Input is a structural row shape (the fields
 * the reader selects), NOT a Prisma model type, so the Prisma type never leaks past this boundary.
 */
import { normalizeVendorForLearning } from "@/lib/services/documents/vendor-normalization.service";
import type {
  DomainLocalSubject,
  EvidenceRef,
  FieldVerdict,
  OwnerDecisionEvidence,
} from "./evidence-contract";

/**
 * The minimal structural shape of a `ReviewEvent` row this mapper reads. Deliberately a local
 * interface (not `import type { ReviewEvent }` from Prisma) so no Prisma type crosses the seam.
 * `verdicts` is the canonical per-field object `{ field: { belief, final, verdict, delta? } }`
 * (see correction-ledger.service `buildVerdicts`). Owner-final CATEGORY lives at `verdicts.category.final`
 * (there is no top-level category column); owner-final VENDOR is the top-level `vendorFinal`.
 */
export interface ReviewEventRow {
  id: number;
  businessId: number;
  occurredAt: Date | string;
  vendorFinal: string | null;
  directionFinal: string | null;
  verdicts: unknown; // canonical JSON: { [field]: { belief, final, verdict, delta? } }
}

const VALID_VERDICTS: ReadonlySet<string> = new Set([
  "confirmed",
  "corrected",
  "rejected",
  "not-submitted",
]);

/** Read one field's `{ final, verdict }` out of the canonical `verdicts` JSON, defensively. */
function readVerdictField(verdicts: unknown, field: string): { final: string | null; verdict: FieldVerdict } {
  const v = verdicts as Record<string, unknown> | null | undefined;
  const cell = v && typeof v === "object" ? (v[field] as Record<string, unknown> | undefined) : undefined;
  const rawFinal = cell ? cell["final"] : undefined;
  const final = rawFinal == null ? null : String(rawFinal);
  const rawVerdict = cell ? cell["verdict"] : undefined;
  const verdict: FieldVerdict = VALID_VERDICTS.has(String(rawVerdict))
    ? (String(rawVerdict) as FieldVerdict)
    : "not-submitted";
  return { final, verdict };
}

/**
 * Build the domain-local vendor subject for a raw owner-final vendor string, using the SAME canonical
 * normalization the learning path uses — so "the evidence set of a subject" is defined consistently
 * (IMPL-2 §9 determinism / §11 subject identity). Reads the normalizer's `normalizedKey` only.
 */
export function vendorSubject(businessId: number, vendorFinal: string | null): DomainLocalSubject {
  const normalizedKey = normalizeVendorForLearning(vendorFinal ?? "").normalizedKey;
  return { domain: "vendor", normalizedKey, businessId };
}

/** occurredAt → ISO-8601 string (never leak a Date across the contract). */
function toIso(occurredAt: Date | string): string {
  return occurredAt instanceof Date ? occurredAt.toISOString() : new Date(occurredAt).toISOString();
}

/**
 * Map one `ReviewEvent` row to an `OwnerDecisionEvidence` item. This is a lossless-enough READOUT: it
 * surfaces the owner-final values + verdicts as data. It makes NO decision, picks NO winner, and
 * performs NO dedup — interpretation is the future Derivation Policy's job (IMPL-2 §6).
 */
export function mapReviewEvent(row: ReviewEventRow): OwnerDecisionEvidence {
  const ref: EvidenceRef = { kind: "review-event", businessId: row.businessId, recordId: row.id };
  const category = readVerdictField(row.verdicts, "category");
  const vendorV = readVerdictField(row.verdicts, "vendorName");
  const directionV = readVerdictField(row.verdicts, "direction");
  return {
    authority: "owner-decision",
    ref,
    businessId: row.businessId,
    subject: vendorSubject(row.businessId, row.vendorFinal),
    occurredAt: toIso(row.occurredAt),
    ordinal: row.id,
    ownerFinal: {
      vendor: row.vendorFinal,
      category: category.final,
      direction: row.directionFinal,
    },
    verdicts: {
      vendor: vendorV.verdict,
      category: category.verdict,
      direction: directionV.verdict,
    },
  };
}

/** True iff an owner-decision evidence item belongs to the given domain-local subject (same tenant + key). */
export function matchesSubject(evidence: OwnerDecisionEvidence, subject: DomainLocalSubject): boolean {
  return (
    evidence.businessId === subject.businessId &&
    evidence.subject.domain === subject.domain &&
    evidence.subject.normalizedKey === subject.normalizedKey
  );
}
