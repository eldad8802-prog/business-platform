/**
 * Business Obligation — application services (WP3).
 *
 * The coordinator's operational behavior: recognize, update, postpone (snooze),
 * complete (owner-asserted closure), release, list, and the morning briefing.
 *
 * Depends only on the `ObligationStore` port and an injected clock + series-id
 * generator, so it is fully unit-testable without a database (an in-memory store
 * fake is provided in `obligation-store.memory.ts`).
 *
 * Canonical guardrails (docs/dubiz-business-obligation-domain-v1.md):
 *  - outbound only; the business is always the payer.
 *  - operational coordination only; never financial truth or payment execution.
 *  - closure is owner-asserted in MVP (settlementAssertedBy = OWNER); the future
 *    event-verified path keeps the same surface (Blueprint §0.5).
 *  - an obligation ends only through explicit closure (Met / Released).
 */

import { NotFoundError, ValidationError } from "@/lib/errors";
import {
  deriveBriefing,
  isIdempotentNoop,
  assertTransitionAllowed,
  nextOccurrence,
  normalizeAmount,
  normalizeCurrency,
} from "./obligation-core";
import {
  DEFAULT_ATTENTION_WINDOW_DAYS,
  type Briefing,
  type ObligationRecord,
  type ObligationStore,
  type OrientationRecord,
  type RecurrenceCadence,
} from "./obligations.types";

const RECURRENCE_VALUES: readonly RecurrenceCadence[] = [
  "NONE",
  "WEEKLY",
  "MONTHLY",
  "YEARLY",
];

const MAX_OBLIGEE_LEN = 200;
const MAX_NOTE_LEN = 1000;

export interface ObligationServiceDeps {
  store: ObligationStore;
  now?: () => Date;
  attentionWindowDays?: number;
  /** Generates a recurrence series id. Default: crypto.randomUUID(). */
  newSeriesId?: () => string;
}

export interface RecognizeObligationInput {
  businessId: number;
  obligeeName: string;
  amount: string | number;
  currency?: string;
  dueAt: Date;
  recurrence?: RecurrenceCadence;
  note?: string | null;
}

export interface UpdateObligationInput {
  obligeeName?: string;
  amount?: string | number;
  currency?: string;
  dueAt?: Date;
  recurrence?: RecurrenceCadence;
  note?: string | null;
}

export interface CompleteObligationResult {
  obligation: ObligationRecord;
  /** The next recognized instance for a recurring obligation, else null. */
  nextInstance: ObligationRecord | null;
}

// --- validation helpers ----------------------------------------------------

function assertPositiveInt(value: number, field: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new ValidationError(`${field} must be a positive integer`);
  }
}

function normalizeObligeeName(raw: string): string {
  const name = (raw ?? "").trim();
  if (name === "") throw new ValidationError("obligeeName is required");
  if (name.length > MAX_OBLIGEE_LEN) {
    throw new ValidationError("obligeeName is too long");
  }
  return name;
}

function validateDueAt(dueAt: Date): Date {
  if (!(dueAt instanceof Date) || Number.isNaN(dueAt.getTime())) {
    throw new ValidationError("dueAt must be a valid date");
  }
  return dueAt;
}

function validateRecurrence(value: RecurrenceCadence | undefined): RecurrenceCadence {
  const cadence = value ?? "NONE";
  if (!RECURRENCE_VALUES.includes(cadence)) {
    throw new ValidationError("invalid recurrence cadence");
  }
  return cadence;
}

function normalizeNote(note: string | null | undefined): string | null {
  if (note == null) return null;
  const trimmed = note.trim();
  if (trimmed === "") return null;
  if (trimmed.length > MAX_NOTE_LEN) {
    throw new ValidationError("note is too long");
  }
  return trimmed;
}

function defaultNow(deps: ObligationServiceDeps): Date {
  return (deps.now ?? (() => new Date()))();
}

function defaultSeriesId(deps: ObligationServiceDeps): string {
  if (deps.newSeriesId) return deps.newSeriesId();
  // Lazy import keeps the module load pure; randomUUID is only used in prod.
  return globalThis.crypto.randomUUID();
}

// --- services --------------------------------------------------------------

/** Recognize a new obligation — the secretary begins remembering it. */
export async function recognizeObligation(
  input: RecognizeObligationInput,
  deps: ObligationServiceDeps
): Promise<ObligationRecord> {
  assertPositiveInt(input.businessId, "businessId");
  const obligeeName = normalizeObligeeName(input.obligeeName);
  const amount = normalizeAmount(input.amount);
  const currency = normalizeCurrency(input.currency);
  const dueAt = validateDueAt(input.dueAt);
  const recurrence = validateRecurrence(input.recurrence);
  const note = normalizeNote(input.note);

  return deps.store.createObligation({
    businessId: input.businessId,
    obligeeName,
    amount,
    currency,
    dueAt,
    state: "OPEN",
    source: "MANUAL",
    recurrence,
    recurrenceSeriesId: recurrence === "NONE" ? null : defaultSeriesId(deps),
    note,
    followUpAt: null,
  });
}

async function loadOrThrow(
  businessId: number,
  id: number,
  deps: ObligationServiceDeps
): Promise<ObligationRecord> {
  const found = await deps.store.findObligationById(businessId, id);
  if (!found) throw new NotFoundError("Obligation not found");
  return found;
}

/** Update an open obligation's essentials (who / amount / when / note). */
export async function updateObligation(
  businessId: number,
  id: number,
  input: UpdateObligationInput,
  deps: ObligationServiceDeps
): Promise<ObligationRecord> {
  assertPositiveInt(businessId, "businessId");
  assertPositiveInt(id, "id");
  const current = await loadOrThrow(businessId, id, deps);
  assertTransitionAllowed(current.state, "UPDATE");

  const patch: Parameters<ObligationStore["updateObligation"]>[2] = {};
  if (input.obligeeName !== undefined) {
    patch.obligeeName = normalizeObligeeName(input.obligeeName);
  }
  if (input.amount !== undefined) patch.amount = normalizeAmount(input.amount);
  if (input.currency !== undefined) {
    patch.currency = normalizeCurrency(input.currency);
  }
  if (input.dueAt !== undefined) patch.dueAt = validateDueAt(input.dueAt);
  if (input.recurrence !== undefined) {
    patch.recurrence = validateRecurrence(input.recurrence);
  }
  if (input.note !== undefined) patch.note = normalizeNote(input.note);

  return deps.store.updateObligation(businessId, id, patch);
}

/** Postpone ("not now") — suppress from attention until followUpAt. */
export async function snoozeObligation(
  businessId: number,
  id: number,
  followUpAt: Date,
  deps: ObligationServiceDeps
): Promise<ObligationRecord> {
  assertPositiveInt(businessId, "businessId");
  assertPositiveInt(id, "id");
  const now = defaultNow(deps);
  const target = validateDueAt(followUpAt);
  if (target.getTime() <= now.getTime()) {
    throw new ValidationError("followUpAt must be in the future");
  }
  const current = await loadOrThrow(businessId, id, deps);
  assertTransitionAllowed(current.state, "POSTPONE");
  return deps.store.updateObligation(businessId, id, { followUpAt: target });
}

/**
 * Complete — owner-asserted closure (Met). Idempotent if already Met. For a
 * recurring obligation, the next instance is recognized automatically (same
 * series), so the owner never re-enters what recurs.
 */
export async function completeObligation(
  businessId: number,
  id: number,
  deps: ObligationServiceDeps
): Promise<CompleteObligationResult> {
  assertPositiveInt(businessId, "businessId");
  assertPositiveInt(id, "id");
  const now = defaultNow(deps);
  const current = await loadOrThrow(businessId, id, deps);

  if (isIdempotentNoop(current.state, "COMPLETE")) {
    return { obligation: current, nextInstance: null };
  }
  assertTransitionAllowed(current.state, "COMPLETE");

  const obligation = await deps.store.updateObligation(businessId, id, {
    state: "MET",
    metAt: now,
    settlementAssertedBy: "OWNER",
    followUpAt: null,
  });

  let nextInstance: ObligationRecord | null = null;
  if (current.recurrence !== "NONE") {
    const nextDue = nextOccurrence(current.dueAt, current.recurrence);
    if (nextDue) {
      nextInstance = await deps.store.createObligation({
        businessId,
        obligeeName: current.obligeeName,
        amount: current.amount,
        currency: current.currency,
        dueAt: nextDue,
        state: "OPEN",
        source: current.source,
        recurrence: current.recurrence,
        recurrenceSeriesId: current.recurrenceSeriesId,
        note: current.note,
        followUpAt: null,
      });
    }
  }

  return { obligation, nextInstance };
}

/** Release — the underlying commitment ceased to exist. Idempotent. Releasing a
 * recurring obligation stops the series (no next instance is recognized). */
export async function releaseObligation(
  businessId: number,
  id: number,
  deps: ObligationServiceDeps
): Promise<ObligationRecord> {
  assertPositiveInt(businessId, "businessId");
  assertPositiveInt(id, "id");
  const now = defaultNow(deps);
  const current = await loadOrThrow(businessId, id, deps);

  if (isIdempotentNoop(current.state, "RELEASE")) return current;
  assertTransitionAllowed(current.state, "RELEASE");

  return deps.store.updateObligation(businessId, id, {
    state: "RELEASED",
    releasedAt: now,
    followUpAt: null,
  });
}

/** List obligations for the business (defaults to OPEN only). */
export async function listObligations(
  businessId: number,
  deps: ObligationServiceDeps,
  options?: { includeClosed?: boolean; limit?: number }
): Promise<ObligationRecord[]> {
  assertPositiveInt(businessId, "businessId");
  return deps.store.listObligations(businessId, {
    states: options?.includeClosed ? undefined : ["OPEN"],
    limit: options?.limit,
  });
}

/** The morning briefing — the conclusion-first verdict. */
export async function getBriefing(
  businessId: number,
  deps: ObligationServiceDeps
): Promise<Briefing> {
  assertPositiveInt(businessId, "businessId");
  const now = defaultNow(deps);
  const [open, orientation] = await Promise.all([
    deps.store.listObligations(businessId, { states: ["OPEN"] }),
    deps.store.getOrientation(businessId),
  ]);
  return deriveBriefing(open, now, {
    attentionWindowDays:
      deps.attentionWindowDays ?? DEFAULT_ATTENTION_WINDOW_DAYS,
    oriented: orientation.oriented,
  });
}

export async function getOrientation(
  businessId: number,
  deps: ObligationServiceDeps
): Promise<OrientationRecord> {
  assertPositiveInt(businessId, "businessId");
  return deps.store.getOrientation(businessId);
}

/** Mark the business oriented — the owner affirmed the recurring backbone. */
export async function markOriented(
  businessId: number,
  deps: ObligationServiceDeps
): Promise<OrientationRecord> {
  assertPositiveInt(businessId, "businessId");
  return deps.store.setOriented(businessId, defaultNow(deps));
}
