import type { BusinessIdentityDimension, BusinessIdentityFact, Prisma } from "@prisma/client";
import { BOT_AUDIENCE_TAGS, BOT_PRIORITIES, BOT_TONES } from "@/lib/features/bot/bot-profile";
import { readChoiceProvenance } from "@/lib/features/content/choice-provenance";
import {
  deriveIdentitySignals,
  SIGNAL_RULES_VERSION,
  SIGNAL_WINDOW_DAYS,
  suggestionRef,
  type IdentityEvidence,
  type IdentitySignal,
} from "./identity-signals";
import { DIMENSION_RULES, IDENTITY_DIMENSIONS, IdentityInputError } from "./identity-vocabulary";
import {
  createIdentityStatement,
  listActiveIdentityStatements,
  STATEMENT_SELECT,
  type IdentityStatementRow,
} from "./identity-statement.service";
import {
  FACT_AUTHORITY_SELECT,
  FACT_SOURCES,
  factValueHash,
  IDENTITY_FACTS,
  listActiveFactAuthorities,
  loadIdentityFactValues,
  type FactAuthorityRow,
} from "./identity-fact-authority.service";

/**
 * P2 · BusinessIdentity — a READ MODEL, like P1's BusinessOffering. Not a table.
 *
 * Every item says which knowledge state it is in, and the states are never merged:
 *   identity facts   UNKNOWN → KNOWN (a value exists) → OWNER_CONFIRMED → PUBLIC_USE_APPROVED,
 *                    from a BusinessIdentityFactAuthority row that still matches the current value
 *   statements       OWNER_CONFIRMED (a BusinessIdentityStatement row) → PUBLIC_USE_APPROVED
 *   signals          DERIVED (MACHINE_PROPOSAL, internal only)
 *
 * Fact existence never grants public use, and neither does a billing field: the billing phone, email
 * and address appear here only as PUBLIC_* facts that stay KNOWN until the owner designates them.
 * No customer rows, conversations or content text.
 */

type Tx = Prisma.TransactionClient;
const DAY = 86_400_000;

export type FactState = "UNKNOWN" | "KNOWN" | "OWNER_CONFIRMED" | "PUBLIC_USE_APPROVED";

export type IdentityFactView = {
  fact: BusinessIdentityFact;
  /** The canonical value, read from its source (the owner's own screen shows it). */
  value: string | null;
  sourceField: string;
  state: FactState;
  /** The authority row behind OWNER_CONFIRMED / PUBLIC_USE_APPROVED. */
  authorityId: number | null;
  /** An authority existed but the value has changed since: it no longer counts. */
  authorityStale: boolean;
};

/** Internal taxonomy — known, never a public claim, so not governed by fact authority. */
export type ProfileFactView = {
  key: "category" | "subCategory" | "businessModel";
  value: string | null;
  state: "UNKNOWN" | "KNOWN";
};

export type IdentityStatementView = IdentityStatementRow & {
  state: "OWNER_CONFIRMED";
  publicUse: "INTERNAL_ONLY" | "PUBLIC_USE_APPROVED";
  publicUseEligible: boolean;
};

export type IdentityConflict = {
  kind: "MACHINE_VS_OWNER";
  dimension: BusinessIdentityDimension;
  signalKey: string;
  suggestedCode: string;
  ownerStatementId: number;
  resolution: "RESOLVED_BY_AUTHORITY";
  prevailing: "OWNER_CONFIRMED";
};

export type BusinessIdentityView = {
  businessId: number;
  facts: IdentityFactView[];
  profile: ProfileFactView[];
  offering: {
    state: "FACT";
    activeServices: number;
    activeProducts: number;
    /** The owner's emphasis (P1 featuredByOwner). Reused, not duplicated. */
    featured: { kind: "SERVICE" | "PRODUCT"; canonicalId: number }[];
  };
  statements: IdentityStatementView[];
  signals: (IdentitySignal & { suggestions: (IdentitySignal["suggestions"][number] & { alreadyConfirmed: boolean })[] })[];
  conflicts: IdentityConflict[];
  /** Dimensions the owner has not stated. Unknown stays unknown; nothing is filled in. */
  unknownDimensions: BusinessIdentityDimension[];
  rulesVersion: string;
};

/** Everything the read model is built from — loaded in one tenant transaction, or given by a test. */
export type IdentityInputs = {
  businessId: number;
  factValues: Record<BusinessIdentityFact, string | null>;
  factAuthorities: FactAuthorityRow[];
  profile: { category: string | null; subCategory: string | null; businessModel: string | null } | null;
  statements: IdentityStatementRow[];
  evidence: IdentityEvidence;
  featured: { kind: "SERVICE" | "PRODUCT"; canonicalId: number }[];
};

function pickAllowed<T extends string>(value: unknown, allowed: readonly T[]): T[] {
  return Array.isArray(value) ? value.filter((v): v is T => typeof v === "string" && (allowed as readonly string[]).includes(v)) : [];
}

export async function loadIdentityEvidence(businessId: number, tx: Tx, asOf = new Date()): Promise<IdentityEvidence> {
  const since = new Date(asOf.getTime() - SIGNAL_WINDOW_DAYS * DAY);
  const [services, products, demand, selections, bot, runs] = await Promise.all([
    tx.businessService.findMany({
      where: { businessId },
      select: { id: true, active: true, categoryLabel: true, fulfillment: true, priceMode: true },
    }),
    tx.inventoryItem.findMany({
      where: { businessId },
      select: { id: true, isActive: true, category: { select: { name: true } } },
    }),
    tx.offeringDemandSignal.findMany({
      where: { businessId, createdAt: { gte: since, lte: asOf } },
      select: { offeringKind: true, businessServiceId: true, inventoryItemId: true, signalType: true, appointment: { select: { status: true } } },
    }),
    tx.contentEvent.findMany({
      where: { businessId, eventType: "VARIANT_SELECTED", createdAt: { gte: since, lte: asOf }, contentVariantId: { not: null } },
      select: { contentVariant: { select: { variantKey: true } } },
    }),
    tx.businessBot.findUnique({
      where: { businessId },
      select: { profile: { select: { voice: true, approach: true } } },
    }),
    // Four JSON paths of each run, extracted in the database: the run's prompt, context and insight
    // answers never leave it.
    tx.$queryRaw<Array<{ tone: string | null; provenance: unknown; audienceTypes: unknown }>>`
      SELECT "inputSnapshot" #>> '{data,selectedDirection,tone}' AS "tone",
             "inputSnapshot" #> '{data,choiceProvenance}'        AS "provenance",
             "inputSnapshot" #> '{data,audienceTypes}'           AS "audienceTypes"
        FROM "ContentRun"
       WHERE "businessId" = ${businessId} AND "createdAt" >= ${since} AND "createdAt" <= ${asOf}`,
  ]);

  const voice = (bot?.profile?.voice ?? null) as Record<string, unknown> | null;
  const approach = (bot?.profile?.approach ?? null) as Record<string, unknown> | null;
  return {
    services: services.map((s) => ({ id: s.id, active: s.active, categoryLabel: s.categoryLabel, fulfillment: s.fulfillment, priceMode: s.priceMode })),
    products: products.map((p) => ({ id: p.id, active: p.isActive, category: p.category?.name ?? null })),
    demand: demand.flatMap((d) => {
      const id = d.offeringKind === "SERVICE" ? d.businessServiceId : d.inventoryItemId;
      return id === null ? [] : [{ offeringKind: d.offeringKind, offeringId: id, signalType: d.signalType, appointmentStatus: d.appointment?.status ?? null }];
    }),
    variantSelections: selections.flatMap((e) => (e.contentVariant ? [e.contentVariant.variantKey] : [])),
    bot: bot?.profile
      ? {
          tone: pickAllowed(voice ? [voice.tone] : [], BOT_TONES)[0] ?? null,
          audienceTags: pickAllowed(voice?.audienceTags, BOT_AUDIENCE_TAGS),
          priorities: pickAllowed(approach?.priorities, BOT_PRIORITIES),
        }
      : null,
    contentChoices: runs.map((r) => {
      const p = readChoiceProvenance(r.provenance);
      return {
        tone: typeof r.tone === "string" ? r.tone : null,
        toneSource: p.tone,
        audienceTypes: Array.isArray(r.audienceTypes) ? r.audienceTypes.filter((t): t is string => typeof t === "string") : [],
        audienceSource: p.audience,
      };
    }),
  };
}

export async function loadIdentityInputs(businessId: number, tx: Tx, asOf = new Date()): Promise<IdentityInputs> {
  if (!Number.isInteger(businessId) || businessId <= 0) throw new IdentityInputError("Invalid business");
  const [factValues, factAuthorities, profile, statements, evidence, featuredServices, featuredProducts] = await Promise.all([
    loadIdentityFactValues(businessId, tx),
    listActiveFactAuthorities(businessId, tx),
    tx.businessProfile.findUnique({ where: { businessId }, select: { category: true, subCategory: true, businessModel: true } }),
    listActiveIdentityStatements(businessId, tx),
    loadIdentityEvidence(businessId, tx, asOf),
    tx.businessService.findMany({ where: { businessId, active: true, featuredByOwner: true }, select: { id: true } }),
    tx.inventoryItem.findMany({ where: { businessId, isActive: true, featuredByOwner: true }, select: { id: true } }),
  ]);
  return {
    businessId,
    factValues,
    factAuthorities,
    profile,
    statements,
    evidence,
    featured: [
      ...featuredServices.map((s) => ({ kind: "SERVICE" as const, canonicalId: s.id })),
      ...featuredProducts.map((p) => ({ kind: "PRODUCT" as const, canonicalId: p.id })),
    ],
  };
}

/** Pure: the read model from its inputs. */
export function assembleBusinessIdentity(input: IdentityInputs): BusinessIdentityView {
  const facts: IdentityFactView[] = IDENTITY_FACTS.map((fact) => {
    const value = input.factValues[fact];
    const authority = input.factAuthorities.find((a) => a.fact === fact) ?? null;
    const current = authority !== null && value !== null && authority.valueHash === factValueHash(value);
    const state: FactState = value === null ? "UNKNOWN" : !current ? "KNOWN" : authority!.publicUseApproved ? "PUBLIC_USE_APPROVED" : "OWNER_CONFIRMED";
    return {
      fact,
      value,
      sourceField: FACT_SOURCES[fact].sourceField,
      state,
      authorityId: current ? authority!.id : null,
      authorityStale: authority !== null && !current,
    };
  });

  const profileFact = (key: ProfileFactView["key"], v: string | null | undefined): ProfileFactView =>
    ({ key, value: v?.trim() ? v.trim() : null, state: v?.trim() ? "KNOWN" : "UNKNOWN" });

  const statementViews: IdentityStatementView[] = input.statements.map((s) => ({
    ...s,
    state: "OWNER_CONFIRMED",
    publicUse: s.publicUseApproved ? "PUBLIC_USE_APPROVED" : "INTERNAL_ONLY",
    publicUseEligible: DIMENSION_RULES[s.dimension].publicUseEligible,
  }));

  const confirmed = new Set(input.statements.map((s) => `${s.dimension}:${s.code}`));
  const signals = deriveIdentitySignals(input.evidence).map((sig) => ({
    ...sig,
    suggestions: sig.suggestions.map((s) => ({ ...s, alreadyConfirmed: confirmed.has(`${s.dimension}:${s.code}`) })),
  }));

  // A machine suggestion for a single-valued dimension the owner already stated differently: both
  // are kept, and the owner's statement prevails by authority.
  const conflicts: IdentityConflict[] = [];
  for (const sig of signals) {
    for (const s of sig.suggestions) {
      if (!DIMENSION_RULES[s.dimension].single) continue;
      const owner = input.statements.find((row) => row.dimension === s.dimension);
      if (owner && owner.code !== s.code) {
        conflicts.push({
          kind: "MACHINE_VS_OWNER",
          dimension: s.dimension,
          signalKey: sig.key,
          suggestedCode: s.code,
          ownerStatementId: owner.id,
          resolution: "RESOLVED_BY_AUTHORITY",
          prevailing: "OWNER_CONFIRMED",
        });
      }
    }
  }

  const stated = new Set(input.statements.map((s) => s.dimension));
  return {
    businessId: input.businessId,
    facts,
    profile: [
      profileFact("category", input.profile?.category),
      profileFact("subCategory", input.profile?.subCategory),
      profileFact("businessModel", input.profile?.businessModel),
    ],
    offering: {
      state: "FACT",
      activeServices: input.evidence.services.filter((s) => s.active).length,
      activeProducts: input.evidence.products.filter((p) => p.active).length,
      featured: input.featured,
    },
    statements: statementViews,
    signals,
    conflicts,
    unknownDimensions: IDENTITY_DIMENSIONS.filter((d) => !stated.has(d)),
    rulesVersion: SIGNAL_RULES_VERSION,
  };
}

export async function getBusinessIdentity(businessId: number, tx: Tx, asOf = new Date()): Promise<BusinessIdentityView> {
  return assembleBusinessIdentity(await loadIdentityInputs(businessId, tx, asOf));
}

export type PublicClaim =
  | { kind: "FACT"; key: BusinessIdentityFact; value: string; ref: { store: "BusinessIdentityFactAuthority"; id: number }; sourceField: string }
  | { kind: "STATEMENT"; key: BusinessIdentityDimension; value: string; ref: { store: "BusinessIdentityStatement"; id: number } };

/**
 * The ONLY identity material a future public surface may use: facts whose authority is current and
 * PUBLIC_USE_APPROVED, and owner statements approved for public use. Everything else — KNOWN facts,
 * stale approvals, internal statements, coded directives, derived signals — is absent by construction.
 */
export function publicUseInventory(view: BusinessIdentityView): PublicClaim[] {
  const out: PublicClaim[] = [];
  for (const f of view.facts) {
    if (f.state === "PUBLIC_USE_APPROVED" && f.value !== null && f.authorityId !== null) {
      out.push({ kind: "FACT", key: f.fact, value: f.value, ref: { store: "BusinessIdentityFactAuthority", id: f.authorityId }, sourceField: f.sourceField });
    }
  }
  for (const s of view.statements) {
    if (s.publicUse === "PUBLIC_USE_APPROVED" && s.publicUseEligible && s.text !== null) {
      out.push({ kind: "STATEMENT", key: s.dimension, value: s.text, ref: { store: "BusinessIdentityStatement", id: s.id } });
    }
  }
  return out;
}

/**
 * The owner adopts one suggestion of one derived signal. The signal is RECOMPUTED here from this
 * tenant's evidence: a client cannot adopt a signal that does not currently hold for its own
 * business, and cannot invent provenance.
 */
export async function adoptIdentitySuggestion(
  input: { businessId: number; userId: number; signalKey: unknown; dimension: unknown; code: unknown },
  tx: Tx,
  asOf = new Date(),
): Promise<IdentityStatementRow> {
  if (typeof input.signalKey !== "string" || typeof input.dimension !== "string" || typeof input.code !== "string") {
    throw new IdentityInputError("signalKey, dimension and code are required");
  }
  const evidence = await loadIdentityEvidence(input.businessId, tx, asOf);
  const sig = deriveIdentitySignals(evidence).find((s) => s.key === input.signalKey && s.status === "SUPPORTED");
  const suggestion = sig?.suggestions.find((s) => s.dimension === input.dimension && s.code === input.code);
  if (!sig || !suggestion) throw new IdentityInputError("This suggestion is not currently supported by this business's evidence");
  return createIdentityStatement(
    {
      businessId: input.businessId,
      userId: input.userId,
      dimension: suggestion.dimension,
      code: suggestion.code,
      source: "OWNER_ADOPTED_SUGGESTION",
      sourceRef: suggestionRef(sig.key, suggestion),
    },
    tx,
  );
}

/**
 * Resolve a Business Knowledge Snapshot provenance reference back to its canonical identity row —
 * within ONE business. Both the explicit businessId filter and RLS stand between a reference and
 * another tenant's row; a foreign id resolves to null.
 */
export async function resolveIdentityProvenance(
  businessId: number,
  ref: { store: string; id: number | string },
  tx: Tx,
): Promise<
  | { store: "BusinessIdentityStatement"; row: IdentityStatementRow & { status: string } }
  | { store: "BusinessIdentityFactAuthority"; row: FactAuthorityRow }
  | null
> {
  const id = Number(ref.id);
  if (!Number.isInteger(businessId) || businessId <= 0 || !Number.isInteger(id) || id <= 0) return null;
  if (ref.store === "BusinessIdentityStatement") {
    const row = await tx.businessIdentityStatement.findFirst({ where: { id, businessId }, select: STATEMENT_SELECT });
    return row ? { store: "BusinessIdentityStatement", row } : null;
  }
  if (ref.store === "BusinessIdentityFactAuthority") {
    const row = await tx.businessIdentityFactAuthority.findFirst({ where: { id, businessId }, select: FACT_AUTHORITY_SELECT });
    return row ? { store: "BusinessIdentityFactAuthority", row } : null;
  }
  return null;
}
