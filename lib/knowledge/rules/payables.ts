/**
 * M4 · PAYABLES — what this business's payment behaviour actually looks like.
 *
 * Four rules, one evidence set. Everything here rests on a single join that the payables ledger has
 * been recording faithfully since Phase 1a: an installment with a `dueAt`, an allocation that is not
 * reversed, and a payment with a `paidAt` and a status of RECORDED.
 *
 * WHAT MAKES THIS EVIDENCE GOOD ENOUGH TO LEARN FROM
 *   `Payment.paidAt` is never defaulted to `now()`. Every path supplies it deliberately — the owner
 *   types it, a document's date supplies it, a bank line's `bookedAt` supplies it, a cheque's asserted
 *   clearing date supplies it. So it is a claim about when money actually moved, not a timestamp of
 *   when someone got round to typing.
 *
 * WHAT IS DELIBERATELY EXCLUDED
 *   - `SETTLED_LEGACY` installments. They were backfilled from the pre-ledger obligation model with an
 *     owner's assertion and NO allocation. Counting them would mix "I remember paying this" with
 *     "here is the payment", and the first is not an observation of timing.
 *   - VOID payments and reversed allocations. A reversal is the system being told it was wrong; a
 *     derived habit that survived its own evidence being withdrawn would be the clearest possible
 *     example of knowledge outliving its truth.
 *
 * WHAT IS NOT CLAIMED
 *   Nothing here says WHY anything was paid late. Cash-flow pressure, a disputed invoice and a
 *   forgotten reminder all produce the same number, and the number is the only thing observed.
 */
import type { KnowledgeRule, RuleDescriptor, EvidenceSource } from "../rule.contract";
import type { MeasureResult } from "../measure.contract";
import {
  calendarDays,
  groupByEntity,
  latencyMeasure,
  shareMeasure,
  type LatencyPoint,
  type SharePoint,
} from "../rule-kit";

/**
 * One installment that was settled: what was owed, when it was due, when it was paid, to whom, and
 * whether anything other than the owner's word says so.
 */
export type SettlementObservation = {
  /** The `PaymentAllocation` id — the record that ties this payment to this installment. */
  readonly recordId: number;
  readonly businessId: number;
  /** `Payment.paidAt`. */
  readonly at: Date;
  /** `Installment.dueAt`. */
  readonly expectedAt: Date;
  readonly payeeId: number | null;
  /**
   * Does anything beyond a bare owner assertion support this payment?
   *
   * TRUE when the payment carries an unrevoked `PaymentEvidence` of a kind other than MANUAL — a
   * bank line, a document, a provider, a cheque. It does NOT mean the bank settled it: today there
   * is no bank feed, so a BANK_TRANSACTION evidence row is an owner-supplied statement line. The
   * name says "backed", not "settled", and that distinction is the rule's entire honesty.
   */
  readonly externallyBacked: boolean;
};

export const PAYABLES_WINDOW_DAYS = 365;

/**
 * A year, not six months.
 *
 * Payables are monthly at best and often quarterly or annual, so a 180-day window would see four
 * observations where the business has a real twelve-observation rhythm. The horizon has to fit the
 * domain's own tempo — which is exactly why this milestone refuses a single global window.
 */
const SHARED: Pick<RuleDescriptor, "domain" | "windowDays" | "freshness"> = {
  domain: "payables",
  windowDays: PAYABLES_WINDOW_DAYS,
  freshness: ["NEW_EVIDENCE", "WINDOW_ROLLED", "EVIDENCE_REVERSED", "RULE_VERSION_CHANGED"],
};

export function makePayablesSource(
  load: EvidenceSource<SettlementObservation>["load"],
): EvidenceSource<SettlementObservation> {
  return { key: "payables.settlements", windowDays: PAYABLES_WINDOW_DAYS, load };
}

/* ────────────────────────────── AP-01 · payment timing ────────────────────────────── */

export const AP01: RuleDescriptor = {
  ...SHARED,
  ruleId: "AP-01",
  measureKey: "payables.payment_timing",
  policyKey: "payables-payment-timing",
  versionLabel: "v1",
  entityType: null,
  minSupport: 5,
  valueUnit: "days",
  question: "How many days after (or before) the due date does this business usually pay?",
};

/** Half a day of movement in a median is noise; a day is the smallest change worth reporting here. */
const TIMING_TREND_MIN_DELTA = 1;

export function derivePaymentTiming(
  observations: readonly SettlementObservation[],
  now: Date,
  businessId: number,
): MeasureResult[] {
  return [
    latencyMeasure(
      {
        measureKey: AP01.measureKey,
        entityType: null,
        entityId: null,
        valueUnit: "days",
        evidenceKind: "payment-allocation",
        minSupport: AP01.minSupport,
        windowDays: AP01.windowDays,
        trendMinDelta: TIMING_TREND_MIN_DELTA,
      },
      observations as readonly LatencyPoint[],
      now,
      businessId,
    ),
  ];
}

/* ────────────────────────────── AP-03 · lateness tendency ────────────────────────────── */

export const AP03: RuleDescriptor = {
  ...SHARED,
  ruleId: "AP-03",
  measureKey: "payables.late_share",
  policyKey: "payables-late-share",
  versionLabel: "v1",
  entityType: null,
  minSupport: 5,
  valueUnit: "ratio",
  question: "What fraction of this business's settled payments went out after the due date?",
};

/**
 * Why this is separate from AP-01 rather than a field in its detail.
 *
 * A median of zero days and a median of zero days describe two different businesses when one pays
 * everything exactly on time and the other pays half a week early and half a week late. The centre
 * and the failure rate are independent facts, and collapsing the second into the first's payload
 * would make it invisible to any consumer that filters on ACTIVE measures.
 *
 * "Late" is strictly AFTER the due day, in calendar days. Paying ON the due day is not late.
 */
export function deriveLateShare(
  observations: readonly SettlementObservation[],
  now: Date,
  businessId: number,
): MeasureResult[] {
  const points: SharePoint[] = observations.map((o) => ({
    recordId: o.recordId,
    businessId: o.businessId,
    at: o.at,
    hit: calendarDays(o.expectedAt, o.at) > 0,
  }));
  return [
    shareMeasure(
      {
        measureKey: AP03.measureKey,
        entityType: null,
        entityId: null,
        valueUnit: "ratio",
        evidenceKind: "payment-allocation",
        minSupport: AP03.minSupport,
        windowDays: AP03.windowDays,
      },
      points,
      now,
      businessId,
    ),
  ];
}

/* ────────────────────────────── AP-04 · per-payee timing ────────────────────────────── */

export const AP04: RuleDescriptor = {
  ...SHARED,
  ruleId: "AP-04",
  measureKey: "payables.payee_payment_timing",
  policyKey: "payables-payee-payment-timing",
  versionLabel: "v1",
  entityType: "payee",
  /**
   * Four, where the business-level rule wants five.
   *
   * Not a relaxation — a recognition that the question is narrower. "How do you treat the landlord"
   * is answerable from four rents in a way "how do you pay in general" is not answerable from four
   * payments, because the four rents are the same obligation recurring and the four payments are not
   * necessarily anything. Below four this stays silent, per payee, and says so.
   */
  minSupport: 4,
  valueUnit: "days",
  question: "Does this business treat some payees differently from others, in timing?",
};

/**
 * Payments with no `payeeId` are dropped rather than pooled.
 *
 * `payeeNameSnapshot` would let them be grouped by name, and that is precisely the false join this
 * milestone exists to avoid: two snapshots reading the same are not evidence of the same payee, and a
 * measure attached to a name rather than a record cannot be pointed at afterwards.
 */
export function derivePayeeTiming(
  observations: readonly SettlementObservation[],
  now: Date,
  businessId: number,
): MeasureResult[] {
  const withPayee = observations.filter(
    (o): o is SettlementObservation & { payeeId: number } => o.payeeId != null,
  );
  const byPayee = groupByEntity(withPayee, (o) => o.payeeId);

  return [...byPayee.entries()].map(([payeeId, rows]) =>
    latencyMeasure(
      {
        measureKey: AP04.measureKey,
        entityType: "payee",
        entityId: payeeId,
        valueUnit: "days",
        evidenceKind: "payment-allocation",
        minSupport: AP04.minSupport,
        windowDays: AP04.windowDays,
        trendMinDelta: TIMING_TREND_MIN_DELTA,
      },
      rows as readonly LatencyPoint[],
      now,
      businessId,
    ),
  );
}

/* ────────────────────────────── AP-06 · evidence backing ────────────────────────────── */

export const AP06: RuleDescriptor = {
  ...SHARED,
  ruleId: "AP-06",
  measureKey: "payables.payment_evidence_backing",
  policyKey: "payables-payment-evidence-backing",
  // v2 (M5.5): CHEQUE evidence is owner-asserted, not external backing.
  versionLabel: "v2",
  entityType: null,
  minSupport: 5,
  valueUnit: "ratio",
  question: "How much of this business's payment record rests on something more than the owner's memory?",
};

/**
 * A measure ABOUT the evidence, not about the money — and the reason it is worth a rule of its own.
 *
 * Every other payables number here is only as good as the payments underneath it. If nine in ten
 * payments are a bare owner assertion typed weeks later, then AP-01's median is a median of
 * recollections, and a consumer deserves to be able to see that before leaning on it. This is the
 * measure that lets the knowledge layer be sceptical about itself.
 *
 * It says NOTHING about whether a payment actually happened. An unbacked payment is not a suspect
 * payment; it is one the business has no second record of.
 */
export function deriveEvidenceBacking(
  observations: readonly SettlementObservation[],
  now: Date,
  businessId: number,
): MeasureResult[] {
  const points: SharePoint[] = observations.map((o) => ({
    recordId: o.recordId,
    businessId: o.businessId,
    at: o.at,
    hit: o.externallyBacked,
  }));
  return [
    shareMeasure(
      {
        measureKey: AP06.measureKey,
        entityType: null,
        entityId: null,
        valueUnit: "ratio",
        evidenceKind: "payment-allocation",
        minSupport: AP06.minSupport,
        windowDays: AP06.windowDays,
      },
      points,
      now,
      businessId,
    ),
  ];
}

/* ────────────────────────────── the four rules ────────────────────────────── */

export function payablesRules(
  source: EvidenceSource<SettlementObservation>,
): KnowledgeRule<SettlementObservation>[] {
  // The tenant is read off the sample rather than taken as an argument, which keeps `derive` pure and
  // total: an empty sample simply has no tenant to read. The derivation service overwrites the
  // evidence set's owner with the caller's trusted id before anything is persisted, so this value
  // never reaches the database — it only has to be consistent within one derivation.
  const tenantOf = (o: readonly SettlementObservation[]): number => o[0]?.businessId ?? 0;
  return [
    { descriptor: AP01, source, derive: (o, n) => derivePaymentTiming(o, n, tenantOf(o)) },
    { descriptor: AP03, source, derive: (o, n) => deriveLateShare(o, n, tenantOf(o)) },
    { descriptor: AP04, source, derive: (o, n) => derivePayeeTiming(o, n, tenantOf(o)) },
    { descriptor: AP06, source, derive: (o, n) => deriveEvidenceBacking(o, n, tenantOf(o)) },
  ];
}
