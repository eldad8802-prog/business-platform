import { PartyRoleType, PartySignalType } from "@prisma/client";

/**
 * Party Backfill — VERIFICATION (read-only), Phase 1 T2b-3.
 *
 * Post-run assertions over the resulting Party / PartyResolutionClaim state.
 * **Read-only by construction:** the ports only *load*; nothing here writes,
 * mutates, runs a migration, or touches Billing / intake / runtime. It is fully
 * decoupled (dependency-injected) so it can be unit-tested without a live DB and
 * later wired to real reads after an `execute` run.
 *
 * Checks (per `dubiz-phase-1-t2-backfill-design-v1.md` §7 / runner-design §4):
 *   1. Totality — every Customer/Lead has an ACTIVE claim (→ a Party).
 *   2. Tenant isolation — every claim points to a Party of the SAME businessId.
 *   3. No-signal-invariant — no (signalType, signalValue) maps to >1 Party.
 *   4. Billing-untouched readiness — a deterministic checksum helper for before/after.
 *   5. Idempotency readiness — a count snapshot + comparator (no new parties/claims).
 *   6. Summary counts per business.
 *
 * T2b-3 scope locks: no execute changes · no new health metrics · no tsx
 * entrypoint · no rollout · no real DB · no migration/backfill run · no
 * Supplier/Vendor · no FinancialEvent re-anchor · no T3 anchor upgrade.
 */

/** A subject row to verify (Customer or Lead). Only `id` is needed. */
export type SubjectRow = { id: number };

/** A Party as seen by verification — its owning businessId is the key fact. */
export type PartyRecord = { id: number; businessId: number };

/** The slice of an ACTIVE PartyResolutionClaim verification needs (read-only). */
export type VerificationClaim = {
  partyId: number;
  subjectType: PartyRoleType;
  subjectId: number;
  signalType: PartySignalType | null;
  signalValue: string | null;
  source: string;
};

/**
 * Injected read-only ports. Each loader is `businessId`-scoped; verification
 * never crosses tenants except to *detect* a cross-tenant claim (which is a
 * violation it reports). No write port exists — read-only is structural.
 */
export type VerificationDeps = {
  listBusinessIds: () => Promise<number[]>;
  loadCustomers: (businessId: number) => Promise<SubjectRow[]>;
  loadLeads: (businessId: number) => Promise<SubjectRow[]>;
  loadParties: (businessId: number) => Promise<PartyRecord[]>;
  loadActiveClaims: (businessId: number) => Promise<VerificationClaim[]>;
};

/** Conflict anchors are tagged by the resolution service with this source suffix. */
const SIGNAL_CONFLICT_SUFFIX = ":SIGNAL_CONFLICT";

export type BusinessVerification = {
  businessId: number;
  // summary counts
  customers: number;
  leads: number;
  parties: number;
  claims: number;
  signalClaims: number;
  anchorClaims: number;
  conflicts: number;
  // findings (counts + a bounded sample for inspection)
  missingSubjects: number;
  missingSubjectSamples: string[];
  tenantViolations: number;
  tenantViolationSamples: string[];
  signalInvariantViolations: number;
  signalInvariantSamples: string[];
  // per-business verdict
  totalityHolds: boolean;
  tenantIsolationHolds: boolean;
  noSignalInvariantViolation: boolean;
  ok: boolean;
};

export type VerificationReport = {
  perBusiness: BusinessVerification[];
  totals: {
    businesses: number;
    customers: number;
    leads: number;
    parties: number;
    claims: number;
    signalClaims: number;
    anchorClaims: number;
    conflicts: number;
    missingSubjects: number;
    tenantViolations: number;
    signalInvariantViolations: number;
    totalityHolds: boolean;
    tenantIsolationHolds: boolean;
    noSignalInvariantViolation: boolean;
    ok: boolean;
  };
};

const MAX_SAMPLES = 20;

function subjectKey(subjectType: PartyRoleType, subjectId: number): string {
  return `${subjectType}:${subjectId}`;
}

/**
 * Deterministic checksum of a set of rows, for **Billing-untouched readiness**:
 * snapshot Customer / Lead / BillingDocument before a run and re-check after to
 * prove they were not mutated. Order-independent (rows are sorted by id) and
 * pure. Verification itself never reads or writes Billing — this is the tool a
 * caller uses around an execute run.
 */
export function rowsChecksum(rows: Array<Record<string, unknown>>): string {
  const normalized = rows
    .map((r) =>
      Object.keys(r)
        .sort()
        .map((k) => `${k}=${String(r[k])}`)
        .join("|")
    )
    .sort();
  let h = 0;
  const joined = `${normalized.length}#${normalized.join("\n")}`;
  for (let i = 0; i < joined.length; i++) {
    h = (Math.imul(31, h) + joined.charCodeAt(i)) | 0;
  }
  return `${normalized.length}:${(h >>> 0).toString(16)}`;
}

export type PartyClaimCounts = { parties: number; claims: number };

/**
 * Idempotency readiness: compare count snapshots taken around a re-run. A
 * re-run must add zero Parties and zero claims (the service NOOPs resolved
 * subjects). Pure comparator — the caller supplies the before/after counts.
 */
export function comparePartyClaimCounts(
  before: PartyClaimCounts,
  after: PartyClaimCounts
): { partiesAdded: number; claimsAdded: number; idempotent: boolean } {
  const partiesAdded = after.parties - before.parties;
  const claimsAdded = after.claims - before.claims;
  return {
    partiesAdded,
    claimsAdded,
    idempotent: partiesAdded === 0 && claimsAdded === 0,
  };
}

/** Extract a {parties, claims} count snapshot from a verification report. */
export function snapshotCounts(report: VerificationReport): PartyClaimCounts {
  return { parties: report.totals.parties, claims: report.totals.claims };
}

/**
 * Run all read-only verification checks. Builds a global partyId→businessId map
 * first (so a cross-tenant claim is detectable), then evaluates each business.
 */
export async function verifyBackfill(
  deps: VerificationDeps
): Promise<VerificationReport> {
  const businessIds = await deps.listBusinessIds();

  // Global map: which business owns each Party. Lets us flag a claim whose
  // partyId belongs to a different business (or to no known Party at all).
  const partyOwner = new Map<number, number>();
  const partiesByBusiness = new Map<number, PartyRecord[]>();
  for (const businessId of businessIds) {
    const parties = await deps.loadParties(businessId);
    partiesByBusiness.set(businessId, parties);
    for (const party of parties) partyOwner.set(party.id, party.businessId);
  }

  const perBusiness: BusinessVerification[] = [];

  for (const businessId of businessIds) {
    const customers = await deps.loadCustomers(businessId);
    const leads = await deps.loadLeads(businessId);
    const claims = await deps.loadActiveClaims(businessId);
    const parties = partiesByBusiness.get(businessId) ?? [];

    // ── Totality: every Customer/Lead must have an ACTIVE claim.
    const subjectsWithClaim = new Set<string>();
    for (const c of claims) {
      subjectsWithClaim.add(subjectKey(c.subjectType, c.subjectId));
    }
    const missingSamples: string[] = [];
    let missingSubjects = 0;
    for (const c of customers) {
      if (!subjectsWithClaim.has(subjectKey(PartyRoleType.CUSTOMER, c.id))) {
        missingSubjects += 1;
        if (missingSamples.length < MAX_SAMPLES) {
          missingSamples.push(subjectKey(PartyRoleType.CUSTOMER, c.id));
        }
      }
    }
    for (const l of leads) {
      if (!subjectsWithClaim.has(subjectKey(PartyRoleType.LEAD, l.id))) {
        missingSubjects += 1;
        if (missingSamples.length < MAX_SAMPLES) {
          missingSamples.push(subjectKey(PartyRoleType.LEAD, l.id));
        }
      }
    }

    // ── Tenant isolation: every claim's Party must belong to this business.
    const tenantSamples: string[] = [];
    let tenantViolations = 0;
    // ── Counts + signal grouping (single pass over claims).
    let signalClaims = 0;
    let anchorClaims = 0;
    let conflicts = 0;
    const partiesBySignal = new Map<string, Set<number>>();
    for (const c of claims) {
      const owner = partyOwner.get(c.partyId);
      if (owner !== businessId) {
        tenantViolations += 1;
        if (tenantSamples.length < MAX_SAMPLES) {
          tenantSamples.push(
            `claim(party=${c.partyId}, owner=${owner ?? "none"})`
          );
        }
      }

      if (c.signalType === null) {
        anchorClaims += 1;
        if (c.source.endsWith(SIGNAL_CONFLICT_SUFFIX)) conflicts += 1;
      } else {
        signalClaims += 1;
        const key = `${c.signalType}:${c.signalValue}`;
        let set = partiesBySignal.get(key);
        if (!set) {
          set = new Set<number>();
          partiesBySignal.set(key, set);
        }
        set.add(c.partyId);
      }
    }

    // ── No-signal-invariant: a signal value must map to exactly one Party.
    const signalSamples: string[] = [];
    let signalInvariantViolations = 0;
    for (const [key, set] of partiesBySignal) {
      if (set.size > 1) {
        signalInvariantViolations += 1;
        if (signalSamples.length < MAX_SAMPLES) {
          signalSamples.push(`${key} → ${set.size} parties`);
        }
      }
    }

    const totalityHolds = missingSubjects === 0;
    const tenantIsolationHolds = tenantViolations === 0;
    const noSignalInvariantViolation = signalInvariantViolations === 0;

    perBusiness.push({
      businessId,
      customers: customers.length,
      leads: leads.length,
      parties: parties.length,
      claims: claims.length,
      signalClaims,
      anchorClaims,
      conflicts,
      missingSubjects,
      missingSubjectSamples: missingSamples,
      tenantViolations,
      tenantViolationSamples: tenantSamples,
      signalInvariantViolations,
      signalInvariantSamples: signalSamples,
      totalityHolds,
      tenantIsolationHolds,
      noSignalInvariantViolation,
      ok: totalityHolds && tenantIsolationHolds && noSignalInvariantViolation,
    });
  }

  const totals = perBusiness.reduce(
    (acc, b) => {
      acc.customers += b.customers;
      acc.leads += b.leads;
      acc.parties += b.parties;
      acc.claims += b.claims;
      acc.signalClaims += b.signalClaims;
      acc.anchorClaims += b.anchorClaims;
      acc.conflicts += b.conflicts;
      acc.missingSubjects += b.missingSubjects;
      acc.tenantViolations += b.tenantViolations;
      acc.signalInvariantViolations += b.signalInvariantViolations;
      return acc;
    },
    {
      businesses: perBusiness.length,
      customers: 0,
      leads: 0,
      parties: 0,
      claims: 0,
      signalClaims: 0,
      anchorClaims: 0,
      conflicts: 0,
      missingSubjects: 0,
      tenantViolations: 0,
      signalInvariantViolations: 0,
      totalityHolds: false,
      tenantIsolationHolds: false,
      noSignalInvariantViolation: false,
      ok: false,
    }
  );
  totals.totalityHolds = totals.missingSubjects === 0;
  totals.tenantIsolationHolds = totals.tenantViolations === 0;
  totals.noSignalInvariantViolation = totals.signalInvariantViolations === 0;
  totals.ok =
    totals.totalityHolds &&
    totals.tenantIsolationHolds &&
    totals.noSignalInvariantViolation;

  return { perBusiness, totals };
}
