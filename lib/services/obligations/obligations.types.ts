/**
 * Business Obligation domain — shared types and the persistence port.
 *
 * Canonical: a Business Obligation is an OUTBOUND, forward-looking
 * commitment-to-pay (the business is always the payer). This module owns
 * *operational coordination* only — never financial truth, payment execution,
 * or documents. See `docs/dubiz-business-obligation-domain-v1.md`.
 *
 * Domain state/source/recurrence types are plain string-literal unions
 * (independent of the generated Prisma client) so the core logic and its tests
 * stay pure and DB-free. The Prisma-backed store maps between these unions and
 * Prisma enums — the values are identical by construction.
 */

/**
 * Persisted lifecycle state. An obligation is recognized as `OPEN` and ends
 * only through an explicit closure: `MET` (honored) or `RELEASED` (the
 * commitment ceased to exist). Overdue-but-unmet obligations stay `OPEN` and
 * are surfaced loudly (Critical) — they are never silently dropped. (A terminal
 * BREACHED state is intentionally out of MVP scope: there is no owner "mark as
 * breached" action in the UX Blueprint; overdue items remain OPEN and surfaced.)
 */
export type ObligationLifecycleState = "OPEN" | "MET" | "RELEASED";

/** Origin of the obligation. MVP wires only MANUAL; the model is built so other
 * intake channels (Documents, Suppliers, Bank) plug in later without change. */
export type ObligationSource = "MANUAL";

/** Simple fixed recurrence cadence. No RRULE-grade scheduling in MVP. */
export type RecurrenceCadence = "NONE" | "WEEKLY" | "MONTHLY" | "YEARLY";

/** Who asserted that the obligation was met. MVP: the owner. Future: an
 * event-verified settlement from Payments/Billing/bank (Integration §4 / §7).
 * The owner experience of closure is identical across both (Blueprint §0.5). */
export type SettlementAssertedBy = "OWNER";

/** The morning verdict — a conclusion about control, never a tally.
 * `STILL_SETTLING_IN` is the pre-orientation posture (Blueprint §0.3): it never
 * claims global "you're in control". */
export type MorningState = "CALM" | "BUSY" | "CRITICAL" | "STILL_SETTLING_IN";

/** Why a surfaced obligation needs the owner now (drives UI framing). */
export type AttentionReason = "OVERDUE" | "DUE_TODAY" | "DUE_SOON";

export const DEFAULT_CURRENCY = "ILS";

/** The near window: how far ahead an obligation is surfaced for attention.
 * The single product constant the Blueprint left as "near window" (§0.2). */
export const DEFAULT_ATTENTION_WINDOW_DAYS = 7;

// --- Persisted record shape (what the store reads/writes) -----------------

export interface ObligationRecord {
  id: number;
  businessId: number;
  /** The party to be paid (landlord, supplier, employee, tax authority). */
  obligeeName: string;
  /** Decimal serialized as string to avoid float drift. */
  amount: string;
  currency: string;
  /** When the obligation must be met. */
  dueAt: Date;
  state: ObligationLifecycleState;
  source: ObligationSource;
  recurrence: RecurrenceCadence;
  /** Ties recurring instances into one persisting series. Null for one-offs. */
  recurrenceSeriesId: string | null;
  note: string | null;
  /** Owner postponed: suppressed from attention until this moment (unless
   * the obligation becomes break-today, which always resurfaces). */
  followUpAt: Date | null;
  /** Set when closed as MET. Null otherwise. */
  settlementAssertedBy: SettlementAssertedBy | null;
  metAt: Date | null;
  releasedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

// --- Store inputs ----------------------------------------------------------

export interface CreateObligationRow {
  businessId: number;
  obligeeName: string;
  amount: string;
  currency: string;
  dueAt: Date;
  state: ObligationLifecycleState;
  source: ObligationSource;
  recurrence: RecurrenceCadence;
  recurrenceSeriesId: string | null;
  note: string | null;
  followUpAt: Date | null;
}

export interface ObligationPatch {
  obligeeName?: string;
  amount?: string;
  currency?: string;
  dueAt?: Date;
  state?: ObligationLifecycleState;
  recurrence?: RecurrenceCadence;
  note?: string | null;
  followUpAt?: Date | null;
  settlementAssertedBy?: SettlementAssertedBy | null;
  metAt?: Date | null;
  releasedAt?: Date | null;
}

export interface ListObligationsOptions {
  /** When set, only obligations in these lifecycle states. */
  states?: ObligationLifecycleState[];
  limit?: number;
}

/** Per-business orientation: has the owner affirmed the recurring backbone is
 * reasonably captured? Governs whether global Calm is allowed (Blueprint §0.3). */
export interface OrientationRecord {
  businessId: number;
  oriented: boolean;
  orientedAt: Date | null;
}

// --- Derived briefing shapes (output of the pure core) --------------------

export interface BriefingItem {
  obligation: ObligationRecord;
  reason: AttentionReason;
}

export interface BriefingCounts {
  open: number;
  attention: number;
  breakToday: number;
  watching: number;
}

export interface Briefing {
  state: MorningState;
  oriented: boolean;
  /** Surfaced obligations, ordered most-consequential-first. */
  attention: BriefingItem[];
  /** Silent tier — tracked and on schedule (or postponed). Ordered by dueAt. */
  watching: ObligationRecord[];
  counts: BriefingCounts;
  generatedAt: string;
}

export interface BriefingConfig {
  /** How far ahead an obligation is surfaced (days). */
  attentionWindowDays?: number;
  /** Whether the business has been oriented (affirmed the backbone). */
  oriented?: boolean;
}

/**
 * Persistence port for the obligations domain. Production uses the
 * Prisma-backed implementation; tests use an in-memory fake. Services depend on
 * this interface only — never on Prisma directly — which keeps the coordinator
 * logic unit-testable without a database.
 */
export interface ObligationStore {
  createObligation(row: CreateObligationRow): Promise<ObligationRecord>;
  updateObligation(
    businessId: number,
    id: number,
    patch: ObligationPatch
  ): Promise<ObligationRecord>;
  findObligationById(
    businessId: number,
    id: number
  ): Promise<ObligationRecord | null>;
  listObligations(
    businessId: number,
    options?: ListObligationsOptions
  ): Promise<ObligationRecord[]>;

  getOrientation(businessId: number): Promise<OrientationRecord>;
  setOriented(businessId: number, orientedAt: Date): Promise<OrientationRecord>;
}
