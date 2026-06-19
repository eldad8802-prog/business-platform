import {
  PartyClaimConfidence,
  PartyClaimStatus,
  PartyResolutionMethod,
  PartyRoleType,
  PartySignalType,
  Prisma,
} from "@prisma/client";
import { ConflictError, ValidationError } from "@/lib/errors";
import { normalizeCustomerPhone } from "@/lib/services/integrations/whatsapp/phone";

export type RoleRowSignalInput = {
  phone?: string | null;
  taxId?: string | null;
  name?: string | null;
};

export type StrongSignals = {
  phone: string | null;
  taxId: string | null;
};

export type PartyResolutionOutcome =
  | "APPLIED"
  | "NOOP"
  | "CONFLICT"
  | "SINGLETON";

export type PartyRow = {
  id: number;
  businessId: number;
  createdAt: Date;
  updatedAt: Date;
};

export type PartyResolutionClaimRow = {
  id: number;
  businessId: number;
  partyId: number;
  subjectType: PartyRoleType;
  subjectId: number;
  // Nullable: anchor claims (signal-conflict isolation) carry no signal; both
  // columns are nullable in the schema. Mirrors the actual model.
  signalType: PartySignalType | null;
  signalValue: string | null;
  confidence: PartyClaimConfidence;
  method: PartyResolutionMethod;
  source: string;
  resolvedByUserId: number | null;
  status: PartyClaimStatus;
  createdAt: Date;
  updatedAt: Date;
};

export type CreateClaimTxInput = {
  businessId: number;
  partyId: number;
  subjectType: PartyRoleType;
  subjectId: number;
  signalType: PartySignalType;
  signalValue: string;
  confidence: PartyClaimConfidence;
  source: string;
  resolvedByUserId?: number | null;
};

export type CreateClaimTxResult = {
  claim: PartyResolutionClaimRow;
  outcome: "APPLIED" | "NOOP";
};

export type ResolvePartyForRoleRowTxInput = {
  businessId: number;
  subjectType: PartyRoleType;
  subjectId: number;
  signals: RoleRowSignalInput;
  source: string;
  resolvedByUserId?: number | null;
};

export type ResolvePartyForRoleRowTxResult = {
  party: PartyRow;
  claims: PartyResolutionClaimRow[];
  outcome: PartyResolutionOutcome;
  signalConflict: boolean;
};

export type RoleRowRef = {
  businessId: number;
  subjectType: PartyRoleType;
  subjectId: number;
};

const CLAIM_SELECT = {
  id: true,
  businessId: true,
  partyId: true,
  subjectType: true,
  subjectId: true,
  signalType: true,
  signalValue: true,
  confidence: true,
  method: true,
  source: true,
  resolvedByUserId: true,
  status: true,
  createdAt: true,
  updatedAt: true,
} as const;

const PARTY_SELECT = {
  id: true,
  businessId: true,
  createdAt: true,
  updatedAt: true,
} as const;

function normalizeTaxId(taxId: string | null | undefined): string | null {
  if (taxId === null || taxId === undefined) {
    return null;
  }
  const trimmed = taxId.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function extractStrongSignals(input: RoleRowSignalInput): StrongSignals {
  return {
    phone: normalizeCustomerPhone(input.phone),
    taxId: normalizeTaxId(input.taxId),
  };
}

export function confidenceForSignalType(
  signalType: PartySignalType
): PartyClaimConfidence {
  return signalType === PartySignalType.TAX_ID
    ? PartyClaimConfidence.KNOWN
    : PartyClaimConfidence.BELIEVED;
}

async function findActiveClaimsForSubjectTx(
  tx: Prisma.TransactionClient,
  businessId: number,
  subjectType: PartyRoleType,
  subjectId: number
): Promise<PartyResolutionClaimRow[]> {
  return tx.partyResolutionClaim.findMany({
    where: {
      businessId,
      subjectType,
      subjectId,
      status: PartyClaimStatus.ACTIVE,
    },
    select: CLAIM_SELECT,
  });
}

function uniquePartyIds(claims: PartyResolutionClaimRow[]): number[] {
  return [...new Set(claims.map((claim) => claim.partyId))];
}

export async function findCandidatePartyBySignalTx(
  tx: Prisma.TransactionClient,
  businessId: number,
  signalType: PartySignalType,
  signalValue: string
): Promise<PartyRow | null> {
  const claim = await tx.partyResolutionClaim.findFirst({
    where: {
      businessId,
      signalType,
      signalValue,
      status: PartyClaimStatus.ACTIVE,
    },
    select: {
      party: {
        select: PARTY_SELECT,
      },
    },
  });

  return claim?.party ?? null;
}

export async function createPartyTx(
  tx: Prisma.TransactionClient,
  businessId: number
): Promise<PartyRow> {
  return tx.party.create({
    data: { businessId },
    select: PARTY_SELECT,
  });
}

export async function createClaimTx(
  tx: Prisma.TransactionClient,
  input: CreateClaimTxInput
): Promise<CreateClaimTxResult> {
  const existingClaims = await findActiveClaimsForSubjectTx(
    tx,
    input.businessId,
    input.subjectType,
    input.subjectId
  );

  const existingForSignal = existingClaims.find(
    (claim) => claim.signalType === input.signalType
  );

  if (existingForSignal) {
    if (existingForSignal.signalValue !== input.signalValue) {
      throw new ConflictError(
        "PARTY_CLAIM_SIGNAL_CONFLICT",
        "Active claim for this subject and signal already exists with a different value"
      );
    }

    if (existingForSignal.partyId !== input.partyId) {
      throw new ConflictError(
        "PARTY_SUBJECT_PARTY_CONFLICT",
        "Active claims for this subject already point to a different party"
      );
    }

    return { claim: existingForSignal, outcome: "NOOP" };
  }

  const linkedPartyIds = uniquePartyIds(existingClaims);
  if (linkedPartyIds.length === 1 && linkedPartyIds[0] !== input.partyId) {
    throw new ConflictError(
      "PARTY_SUBJECT_PARTY_CONFLICT",
      "Active claims for this subject already point to a different party"
    );
  }

  const claim = await tx.partyResolutionClaim.create({
    data: {
      businessId: input.businessId,
      partyId: input.partyId,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      signalType: input.signalType,
      signalValue: input.signalValue,
      confidence: input.confidence,
      method: PartyResolutionMethod.DETERMINISTIC_EXACT,
      source: input.source,
      resolvedByUserId: input.resolvedByUserId ?? null,
      status: PartyClaimStatus.ACTIVE,
    },
    select: CLAIM_SELECT,
  });

  return { claim, outcome: "APPLIED" };
}

/**
 * Anchor claim — a corrigible subject↔Party link with **no signal basis**.
 *
 * Used for subjects that cannot be resolved by a strong signal (no signal, or a
 * signal conflict). It makes the subject lookup-able in the graph (totality)
 * WITHOUT writing a phone/taxId value that would pollute candidate resolution.
 *
 * `confidence = UNKNOWN`: the subject is anchored to its own singleton for
 * read-through only — its broader identity is *not* established (which is
 * exactly what the absence of a signal encodes). Never KNOWN.
 */
export async function createAnchorClaimTx(
  tx: Prisma.TransactionClient,
  input: {
    businessId: number;
    partyId: number;
    subjectType: PartyRoleType;
    subjectId: number;
    source: string;
    resolvedByUserId?: number | null;
  }
): Promise<PartyResolutionClaimRow> {
  return tx.partyResolutionClaim.create({
    data: {
      businessId: input.businessId,
      partyId: input.partyId,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      signalType: null,
      signalValue: null,
      confidence: PartyClaimConfidence.UNKNOWN,
      method: PartyResolutionMethod.SELF_ANCHOR,
      source: input.source,
      resolvedByUserId: input.resolvedByUserId ?? null,
      status: PartyClaimStatus.ACTIVE,
    },
    select: CLAIM_SELECT,
  });
}

function buildClaimSpecs(
  strong: StrongSignals,
  source: string
): Array<{
  signalType: PartySignalType;
  signalValue: string;
  confidence: PartyClaimConfidence;
  source: string;
}> {
  const specs: Array<{
    signalType: PartySignalType;
    signalValue: string;
    confidence: PartyClaimConfidence;
    source: string;
  }> = [];

  if (strong.phone) {
    specs.push({
      signalType: PartySignalType.PHONE,
      signalValue: strong.phone,
      confidence: PartyClaimConfidence.BELIEVED,
      source,
    });
  }

  if (strong.taxId) {
    specs.push({
      signalType: PartySignalType.TAX_ID,
      signalValue: strong.taxId,
      confidence: PartyClaimConfidence.KNOWN,
      source,
    });
  }

  return specs;
}

function allClaimsNoop(
  claimResults: CreateClaimTxResult[]
): boolean {
  return claimResults.length > 0 && claimResults.every((result) => result.outcome === "NOOP");
}

export async function resolvePartyForRoleRowTx(
  tx: Prisma.TransactionClient,
  input: ResolvePartyForRoleRowTxInput
): Promise<ResolvePartyForRoleRowTxResult> {
  const strong = extractStrongSignals(input.signals);
  const claimSpecs = buildClaimSpecs(strong, input.source);
  const existingClaims = await findActiveClaimsForSubjectTx(
    tx,
    input.businessId,
    input.subjectType,
    input.subjectId
  );
  const existingPartyIds = uniquePartyIds(existingClaims);

  if (claimSpecs.length === 0) {
    if (existingPartyIds.length === 1) {
      const party = await tx.party.findFirst({
        where: {
          id: existingPartyIds[0],
          businessId: input.businessId,
        },
        select: PARTY_SELECT,
      });
      if (!party) {
        throw new ValidationError("Existing party for subject was not found");
      }
      return {
        party,
        claims: existingClaims,
        outcome: "NOOP",
        signalConflict: false,
      };
    }

    const party = await createPartyTx(tx, input.businessId);
    const anchor = await createAnchorClaimTx(tx, {
      businessId: input.businessId,
      partyId: party.id,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      source: input.source,
      resolvedByUserId: input.resolvedByUserId,
    });
    return {
      party,
      claims: [anchor],
      outcome: "SINGLETON",
      signalConflict: false,
    };
  }

  const phoneParty = strong.phone
    ? await findCandidatePartyBySignalTx(
        tx,
        input.businessId,
        PartySignalType.PHONE,
        strong.phone
      )
    : null;
  const taxIdParty = strong.taxId
    ? await findCandidatePartyBySignalTx(
        tx,
        input.businessId,
        PartySignalType.TAX_ID,
        strong.taxId
      )
    : null;

  let targetParty: PartyRow;
  let outcome: PartyResolutionOutcome = "APPLIED";
  let signalConflict = false;

  if (
    phoneParty &&
    taxIdParty &&
    phoneParty.id !== taxIdParty.id
  ) {
    // Fail-safe: distinct strong signals disagree (e.g. person ↔ organization).
    // Anchor the subject to its own isolated Party and DO NOT write signal
    // claims — writing phone/taxId claims here would map those values to a
    // second Party and pollute future candidate lookups. The conflict is
    // recorded via outcome/signalConflict; the resolution stays corrigible.
    signalConflict = true;
    outcome = "CONFLICT";
    targetParty = await createPartyTx(tx, input.businessId);
  } else if (taxIdParty) {
    targetParty = taxIdParty;
  } else if (phoneParty) {
    targetParty = phoneParty;
  } else if (existingPartyIds.length === 1) {
    const party = await tx.party.findFirst({
      where: {
        id: existingPartyIds[0],
        businessId: input.businessId,
      },
      select: PARTY_SELECT,
    });
    if (!party) {
      throw new ValidationError("Existing party for subject was not found");
    }
    targetParty = party;
  } else {
    targetParty = await createPartyTx(tx, input.businessId);
  }

  let claims: PartyResolutionClaimRow[] = [];
  if (!signalConflict) {
    const claimResults: CreateClaimTxResult[] = [];
    for (const spec of claimSpecs) {
      claimResults.push(
        await createClaimTx(tx, {
          businessId: input.businessId,
          partyId: targetParty.id,
          subjectType: input.subjectType,
          subjectId: input.subjectId,
          signalType: spec.signalType,
          signalValue: spec.signalValue,
          confidence: spec.confidence,
          source: input.source,
          resolvedByUserId: input.resolvedByUserId,
        })
      );
    }
    claims = claimResults.map((result) => result.claim);
    if (allClaimsNoop(claimResults)) {
      outcome = "NOOP";
    }
  } else {
    // Signal conflict: anchor the subject to its isolated Party (read-through
    // totality) without writing signal claims that would pollute resolution.
    const anchor = await createAnchorClaimTx(tx, {
      businessId: input.businessId,
      partyId: targetParty.id,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      source: `${input.source}:SIGNAL_CONFLICT`,
      resolvedByUserId: input.resolvedByUserId,
    });
    claims = [anchor];
  }

  return {
    party: targetParty,
    claims,
    outcome,
    signalConflict,
  };
}

export async function lookupPartyForRoleRow(
  db: Prisma.TransactionClient,
  input: RoleRowRef
): Promise<PartyRow | null> {
  const claims = await db.partyResolutionClaim.findMany({
    where: {
      businessId: input.businessId,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      status: PartyClaimStatus.ACTIVE,
    },
    select: CLAIM_SELECT,
  });

  const partyIds = uniquePartyIds(claims);
  if (partyIds.length === 0) {
    return null;
  }
  if (partyIds.length > 1) {
    throw new ConflictError(
      "PARTY_SUBJECT_MULTI_PARTY",
      "Active claims for this subject point to multiple parties"
    );
  }

  return db.party.findFirst({
    where: {
      id: partyIds[0],
      businessId: input.businessId,
    },
    select: PARTY_SELECT,
  });
}

export async function lookupRoleRowsForParty(
  db: Prisma.TransactionClient,
  input: { businessId: number; partyId: number }
): Promise<RoleRowRef[]> {
  const claims = await db.partyResolutionClaim.findMany({
    where: {
      businessId: input.businessId,
      partyId: input.partyId,
      status: PartyClaimStatus.ACTIVE,
    },
    select: {
      subjectType: true,
      subjectId: true,
      businessId: true,
    },
  });

  const seen = new Set<string>();
  const members: RoleRowRef[] = [];

  for (const claim of claims) {
    const key = `${claim.subjectType}:${claim.subjectId}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    members.push({
      businessId: claim.businessId,
      subjectType: claim.subjectType,
      subjectId: claim.subjectId,
    });
  }

  return members;
}
