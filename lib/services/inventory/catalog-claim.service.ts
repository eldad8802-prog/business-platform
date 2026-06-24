import {
  CatalogAttribute,
  CatalogProvenanceGrade,
  CatalogSubjectType,
  Prisma,
} from "@prisma/client";

/**
 * Supplier Domain Catalog — CatalogClaim ledger (append-only, corrigible).
 *
 * A CatalogClaim is a *claim, not a fact* — supplier-Reported Reality that informs
 * the Record but never authors it. The ledger follows the canonical deep law
 * (PartyResolutionClaim / RepresentationMapping):
 *   - Content is INSERT-ONLY. A claim's value is never edited and never deleted.
 *   - A new assertion SUPERSEDES the prior ACTIVE claim for the same
 *     (subject, attribute) — the old row stays, only its corrigibility metadata
 *     (status / supersededAt) changes.
 *   - A claim found false is RETRACTED (status / retractedAt / reason) — again,
 *     metadata only. Full history is always preserved.
 * The "current offer" is DERIVED from ACTIVE claims at read time — never stored.
 */

type Tx = Prisma.TransactionClient;

/** Type-safe value input — exactly one shape per CatalogValueType. */
export type CatalogValueInput =
  | { valueType: "MONEY"; valueNumber: number; currency: string }
  | { valueType: "NUMBER"; valueNumber: number }
  | { valueType: "TEXT"; valueText: string }
  | { valueType: "BOOLEAN"; valueBool: boolean };

export type RecordCatalogClaimInput = {
  businessId: number;
  subjectType: CatalogSubjectType;
  subjectId: number;
  attribute: CatalogAttribute;
  value: CatalogValueInput;
  sourceId: number;
  /** When the supplier asserted it; defaults to recordedAt if absent. */
  observedAt?: Date | null;
  provenanceGrade?: CatalogProvenanceGrade;
};

/** Map the typed value union onto the discriminated columns. */
function valueColumns(value: CatalogValueInput) {
  return {
    valueType: value.valueType,
    valueNumber: "valueNumber" in value ? value.valueNumber : null,
    valueText: "valueText" in value ? value.valueText : null,
    valueBool: "valueBool" in value ? value.valueBool : null,
    currency: "currency" in value ? value.currency : null,
  };
}

/**
 * Append a new ACTIVE claim and supersede the prior ACTIVE one for the same
 * (subject, attribute). Insert-only for content; the prior row is preserved with
 * only its corrigibility metadata changed. Single-ACTIVE per (subject, attribute)
 * is enforced here at the application layer (no partial-unique constraint).
 */
export async function recordCatalogClaimTx(tx: Tx, input: RecordCatalogClaimInput) {
  const now = new Date();

  await tx.catalogClaim.updateMany({
    where: {
      businessId: input.businessId,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      attribute: input.attribute,
      status: "ACTIVE",
    },
    data: { status: "SUPERSEDED", supersededAt: now },
  });

  return tx.catalogClaim.create({
    data: {
      businessId: input.businessId,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      attribute: input.attribute,
      ...valueColumns(input.value),
      observedAt: input.observedAt ?? undefined,
      sourceId: input.sourceId,
      provenanceGrade: input.provenanceGrade ?? "PROVIDER_ATTESTED",
      status: "ACTIVE",
    },
  });
}

/**
 * Supersede the prior ACTIVE claim for a (subject, attribute) WITHOUT a
 * replacement — used when a value is withdrawn rather than corrected. Returns the
 * number of rows superseded (0 or 1). Content is never touched.
 */
export async function supersedeCatalogClaimTx(
  tx: Tx,
  input: {
    businessId: number;
    subjectType: CatalogSubjectType;
    subjectId: number;
    attribute: CatalogAttribute;
  }
): Promise<number> {
  const res = await tx.catalogClaim.updateMany({
    where: {
      businessId: input.businessId,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      attribute: input.attribute,
      status: "ACTIVE",
    },
    data: { status: "SUPERSEDED", supersededAt: new Date() },
  });
  return res.count;
}

/**
 * Retract a specific claim found to be false. Never deletes; only corrigibility
 * metadata changes. Retracting the ACTIVE claim leaves the attribute UNKNOWN
 * (absent) until a new claim is recorded — a superseded claim is never revived.
 */
export async function retractCatalogClaimTx(
  tx: Tx,
  input: { businessId: number; claimId: number; retractedReason?: string | null }
): Promise<void> {
  const res = await tx.catalogClaim.updateMany({
    where: {
      id: input.claimId,
      businessId: input.businessId,
      status: { not: "RETRACTED" },
    },
    data: {
      status: "RETRACTED",
      retractedAt: new Date(),
      retractedReason: input.retractedReason ?? null,
    },
  });
  if (res.count !== 1) {
    throw new Error(`Catalog claim ${input.claimId} not found or already retracted`);
  }
}
