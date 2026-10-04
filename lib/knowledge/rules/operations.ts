/**
 * All-Feature Learning Coverage · W3 — running the business: appointments, the payment secretary,
 * offering demand and reports.
 *
 * SOURCES, AND WHY EACH IS THE AUTHORITY
 *   Appointment              current status and start; it keeps NO history of its own
 *   APPOINTMENT_RESCHEDULED  the ONLY record that a start was moved → an OBSERVATION_SOURCE sensor
 *   InstallmentWorkflow      ledger-mode secretary: when the owner marked an installment handled;
 *                            PaymentAllocation says when money actually moved. Handled ≠ paid, and the
 *                            gap is the habit. Dormant until the secretary ledger cutover (an owner
 *                            gate) — INSUFFICIENT_EVIDENCE until then, which is the true answer.
 *   BusinessObligation       legacy-mode secretary (today's Production): owner-asserted closure — a
 *                            CLAIM, labelled OWNER_ASSERTED in every measure's detail
 *   OfferingDemandSignal     the offering domain's own demand ledger (written idempotently, in the
 *                            booking / sale transaction)
 *   DATA_EXPORTED            the ONLY record of an accountant export → an OBSERVATION_SOURCE sensor
 *
 * NOT HERE, ON PURPOSE (docs/learning/SENSOR_COVERAGE.md): notification reads (NOT_LEARNING_RELEVANT),
 * content generation runs (NOT_LEARNING_RELEVANT — tool internals) and content posts (owner-reported
 * at LINK time, not publish time; a cadence of link times would teach data-entry rhythm, not marketing).
 */
import type { MeasureResult } from "../measure.contract";
import type { EvidenceSource, KnowledgeRule, RuleDescriptor } from "../rule.contract";
import { DAY_MS } from "../rule.contract";
import {
  cadenceMeasure, groupByEntity, latencyMeasure, shareMeasure, valueMeasure,
  type LatencyPoint, type SharePoint, type TimelinePoint, type ValuePoint,
} from "../rule-kit";

export const OPERATIONS_WINDOW_DAYS = 365;
/** The accountant-pack exports the owner hands to a bookkeeper. Generic data-transfer exports are not this habit. */
export const ACCOUNTANT_EXPORT_KINDS = ["ACCOUNTANT_PACK", "UNIFORM_FILE", "FINANCIAL_RECORDS"] as const;

/* ─────────────────────────────── observation types ─────────────────────────────── */

export type AppointmentObservation = {
  readonly recordId: number;
  readonly businessId: number;
  readonly status: "PROPOSED" | "CONFIRMED" | "COMPLETED" | "NO_SHOW" | "CANCELED";
  readonly startsAt: Date | null;
  readonly createdAt: Date;
  /** True when an APPOINTMENT_RESCHEDULED observation exists for this appointment at or before `now`. */
  readonly rescheduled: boolean;
};

export type HandledInstallmentObservation = {
  readonly recordId: number; // installment id
  readonly businessId: number;
  readonly handledAt: Date;
  /** Earliest RECORDED, unreversed payment allocated to the installment; null if none yet. */
  readonly paidAt: Date | null;
};

export type ObligationObservation = {
  readonly recordId: number;
  readonly businessId: number;
  readonly dueAt: Date;
  readonly metAt: Date;
};

export type DemandSignalObservation = {
  readonly recordId: number;
  readonly businessId: number;
  readonly businessServiceId: number;
  readonly at: Date;
};

/** One timestamped act: an accountant export, a completed content run. */
export type ActObservation = { readonly recordId: number; readonly businessId: number; readonly at: Date };

/* ─────────────────────────────── descriptors ─────────────────────────────── */

const FRESH: RuleDescriptor["freshness"] = ["NEW_EVIDENCE", "WINDOW_ROLLED", "EVIDENCE_REVERSED", "RULE_VERSION_CHANGED"];
const desc = (d: Omit<RuleDescriptor, "versionLabel" | "freshness" | "windowDays" | "entityType"> & { entityType?: RuleDescriptor["entityType"] }): RuleDescriptor =>
  ({ versionLabel: "v1", freshness: FRESH, windowDays: OPERATIONS_WINDOW_DAYS, ...d, entityType: d.entityType ?? null });
/** One timestamped act: an accountant export. */
export const APPT01 = desc({ ruleId: "APPT-01", domain: "appointments", measureKey: "appointments.no_show_share", policyKey: "appointments-no-show-share",
  minSupport: 10, valueUnit: "ratio", question: "Of this business's appointments that were due to happen, what share were no-shows?" });
export const APPT02 = desc({ ruleId: "APPT-02", domain: "appointments", measureKey: "appointments.cancellation_share", policyKey: "appointments-cancellation-share",
  minSupport: 10, valueUnit: "ratio", question: "What share of this business's booked appointments were cancelled?" });
export const APPT03 = desc({ ruleId: "APPT-03", domain: "appointments", measureKey: "appointments.booking_lead_days", policyKey: "appointments-booking-lead-days",
  minSupport: 5, valueUnit: "days", question: "How far ahead are this business's appointments usually booked?" });
export const APPT04 = desc({ ruleId: "APPT-04", domain: "appointments", measureKey: "appointments.reschedule_share", policyKey: "appointments-reschedule-share",
  minSupport: 10, valueUnit: "ratio", question: "What share of this business's appointments were moved at least once?",
  evidenceSensors: ["APPOINTMENT_RESCHEDULED"] });
export const SEC01 = desc({ ruleId: "SEC-01", domain: "secretary", measureKey: "secretary.handled_to_paid_days", policyKey: "secretary-handled-to-paid-days",
  minSupport: 5, valueUnit: "days", question: "How many days after marking a payment 'handled' is the money actually recorded as paid?" });
export const SEC02 = desc({ ruleId: "SEC-02", domain: "secretary", measureKey: "secretary.obligation_closure_timing", policyKey: "secretary-obligation-closure-timing",
  minSupport: 5, valueUnit: "days", question: "How many days after (or before) the due day does this owner usually mark an obligation as met? (Owner-asserted.)" });
export const OFF01 = desc({ ruleId: "OFF-01", domain: "offering", measureKey: "offering.demand_cadence", policyKey: "offering-demand-cadence",
  entityType: "business-service", minSupport: 4, valueUnit: "days", question: "How many days typically pass between two demand signals for this service?" });
export const REP01 = desc({ ruleId: "REP-01", domain: "reports", measureKey: "reports.accountant_export_cadence", policyKey: "reports-accountant-export-cadence",
  minSupport: 3, valueUnit: "days", question: "How many days typically pass between two accountant exports by this owner?",
  evidenceSensors: ["DATA_EXPORTED"] });

/* ─────────────────────────────── derivation (pure) ─────────────────────────────── */

const days = (from: Date, to: Date) => (to.getTime() - from.getTime()) / DAY_MS;
const due = (a: AppointmentObservation, now: Date): a is AppointmentObservation & { startsAt: Date } =>
  a.startsAt !== null && a.startsAt.getTime() <= now.getTime();

export function deriveNoShowShare(rows: readonly AppointmentObservation[], now: Date, businessId: number): MeasureResult[] {
  const pts: SharePoint[] = rows.filter((a) => due(a, now) && (a.status === "COMPLETED" || a.status === "NO_SHOW"))
    .map((a) => ({ recordId: a.recordId, businessId: a.businessId, at: a.startsAt as Date, hit: a.status === "NO_SHOW" }));
  return [shareMeasure({ measureKey: APPT01.measureKey, entityType: null, entityId: null, valueUnit: "ratio", evidenceKind: "appointment",
    minSupport: APPT01.minSupport, windowDays: APPT01.windowDays }, pts, now, businessId)];
}

/** Booked = ever left PROPOSED. A CANCELED appointment's start is when it would have happened. */
export function deriveCancellationShare(rows: readonly AppointmentObservation[], now: Date, businessId: number): MeasureResult[] {
  const pts: SharePoint[] = rows.filter((a) => due(a, now) && a.status !== "PROPOSED" && a.status !== "CONFIRMED")
    .map((a) => ({ recordId: a.recordId, businessId: a.businessId, at: a.startsAt as Date, hit: a.status === "CANCELED" }));
  return [shareMeasure({ measureKey: APPT02.measureKey, entityType: null, entityId: null, valueUnit: "ratio", evidenceKind: "appointment",
    minSupport: APPT02.minSupport, windowDays: APPT02.windowDays }, pts, now, businessId)];
}

export function deriveBookingLead(rows: readonly AppointmentObservation[], now: Date, businessId: number): MeasureResult[] {
  const pts: ValuePoint[] = rows.filter((a) => a.startsAt !== null && a.status !== "PROPOSED" && a.startsAt.getTime() >= a.createdAt.getTime()
      && a.createdAt.getTime() <= now.getTime())
    .map((a) => ({ recordId: a.recordId, businessId: a.businessId, at: a.createdAt, value: days(a.createdAt, a.startsAt as Date) }));
  return [valueMeasure({ measureKey: APPT03.measureKey, entityType: null, entityId: null, valueUnit: "days", evidenceKind: "appointment",
    minSupport: APPT03.minSupport, windowDays: APPT03.windowDays, trendMinDelta: 2 }, pts, now, businessId)];
}

export function deriveRescheduleShare(rows: readonly AppointmentObservation[], now: Date, businessId: number): MeasureResult[] {
  const pts: SharePoint[] = rows.filter((a) => due(a, now) && a.status !== "PROPOSED")
    .map((a) => ({ recordId: a.recordId, businessId: a.businessId, at: a.startsAt as Date, hit: a.rescheduled }));
  return [shareMeasure({ measureKey: APPT04.measureKey, entityType: null, entityId: null, valueUnit: "ratio", evidenceKind: "appointment",
    minSupport: APPT04.minSupport, windowDays: APPT04.windowDays }, pts, now, businessId)];
}

export function deriveHandledToPaid(rows: readonly HandledInstallmentObservation[], now: Date, businessId: number): MeasureResult[] {
  const pts: LatencyPoint[] = rows.filter((h) => h.paidAt !== null)
    .map((h) => ({ recordId: h.recordId, businessId: h.businessId, at: h.paidAt as Date, expectedAt: h.handledAt }));
  return [latencyMeasure({ measureKey: SEC01.measureKey, entityType: null, entityId: null, valueUnit: "days", evidenceKind: "installment-workflow",
    minSupport: SEC01.minSupport, windowDays: SEC01.windowDays, trendMinDelta: 1 }, pts, now, businessId)];
}

export function deriveObligationClosure(rows: readonly ObligationObservation[], now: Date, businessId: number): MeasureResult[] {
  const pts: LatencyPoint[] = rows.map((o) => ({ recordId: o.recordId, businessId: o.businessId, at: o.metAt, expectedAt: o.dueAt }));
  const m = latencyMeasure({ measureKey: SEC02.measureKey, entityType: null, entityId: null, valueUnit: "days", evidenceKind: "business-obligation",
    minSupport: SEC02.minSupport, windowDays: SEC02.windowDays, trendMinDelta: 1 }, pts, now, businessId);
  return [{ ...m, detail: { ...(m.detail ?? {}), authority: "OWNER_ASSERTED" } }];
}

export function deriveDemandCadence(rows: readonly DemandSignalObservation[], now: Date, businessId: number): MeasureResult[] {
  return [...groupByEntity(rows, (r) => r.businessServiceId)].map(([serviceId, group]) => cadenceMeasure({
    measureKey: OFF01.measureKey, entityType: "business-service", entityId: serviceId, valueUnit: "days", evidenceKind: "offering-demand-signal",
    minSupport: OFF01.minSupport, windowDays: OFF01.windowDays, trendMinDelta: 3 },
    group.map((g): TimelinePoint => ({ recordId: g.recordId, businessId: g.businessId, at: g.at })), now, businessId));
}

const cadenceOf = (d: RuleDescriptor, evidenceKind: string, trendMinDelta: number) =>
  (rows: readonly ActObservation[], now: Date, businessId: number): MeasureResult[] =>
    [cadenceMeasure({ measureKey: d.measureKey, entityType: null, entityId: null, valueUnit: "days", evidenceKind,
      minSupport: d.minSupport, windowDays: d.windowDays, trendMinDelta }, rows, now, businessId)];

export const deriveExportCadence = cadenceOf(REP01, "learning-event:DATA_EXPORTED", 7);

/* ─────────────────────────────── rules ─────────────────────────────── */

const src = <T>(key: string) => (load: EvidenceSource<T>["load"]): EvidenceSource<T> => ({ key, windowDays: OPERATIONS_WINDOW_DAYS, load });
export const makeAppointmentSource = src<AppointmentObservation>("appointments.appointments");
export const makeHandledInstallmentSource = src<HandledInstallmentObservation>("secretary.handled-installments");
export const makeObligationSource = src<ObligationObservation>("secretary.obligations");
export const makeDemandSignalSource = src<DemandSignalObservation>("offering.demand-signals");
export const makeAccountantExportSource = src<ActObservation>("reports.accountant-exports");

type R<T> = KnowledgeRule<T>;
const rule = <T extends { readonly businessId: number }>(
  descriptor: RuleDescriptor, source: EvidenceSource<T>,
  derive: (rows: readonly T[], now: Date, businessId: number) => MeasureResult[],
): R<T> => ({ descriptor, source, derive: (rows, now) => derive(rows, now, rows[0]?.businessId ?? 0) });

export function operationsRules(s: {
  appointments: EvidenceSource<AppointmentObservation>;
  handled: EvidenceSource<HandledInstallmentObservation>;
  obligations: EvidenceSource<ObligationObservation>;
  demand: EvidenceSource<DemandSignalObservation>;
  exports: EvidenceSource<ActObservation>;
}): R<never>[] {
  return [
    rule(APPT01, s.appointments, deriveNoShowShare),
    rule(APPT02, s.appointments, deriveCancellationShare),
    rule(APPT03, s.appointments, deriveBookingLead),
    rule(APPT04, s.appointments, deriveRescheduleShare),
    rule(SEC01, s.handled, deriveHandledToPaid),
    rule(SEC02, s.obligations, deriveObligationClosure),
    rule(OFF01, s.demand, deriveDemandCadence),
    rule(REP01, s.exports, deriveExportCadence),
  ] as unknown as R<never>[];
}
