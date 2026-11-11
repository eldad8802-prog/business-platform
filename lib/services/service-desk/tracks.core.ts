/**
 * Service Desk M1 — the case TRACK (T1–T7) wired to the case machine (migration 20261127090000; service-profiles.ts).
 * Pure: no database, no clock, no network, no input mutation.
 *
 *   - the effective work type / place of a case (NULL columns = derived from kind, exactly as the migration header says);
 *   - which track a case is on, from its work type, place and subject;
 *   - opening a case with a track: kind / workType / serviceLocation / subject consistent, T5's place chosen, on-site
 *     tracks with an address, T7 with its return reason;
 *   - the requirements a case is judged by — ONLY from its own profile snapshot (D14, D17);
 *   - the completion type a place allows (CHECK ServiceCase_completion_place);
 *   - the T7 after-sale resolution: which existing transitions it runs (section כח), and EXCHANGE refused until the
 *     inventory contract exists (EXCHANGE_NEEDS_INVENTORY).
 */
import type {
  ServiceCaseAction,
  ServiceCaseKind,
  ServiceCaseStatus,
  ServiceCompletionType,
  ServiceTrackFacts,
} from "./contracts";
import {
  AFTER_SALE_RESOLUTIONS,
  RETURN_REASONS,
  SERVICE_TRACKS,
  TRACKS,
  requirementsFromSnapshot,
  suggestedResolution,
  type AfterSaleResolution,
  type ProfileSnapshot,
  type Requirements,
  type ReturnReason,
  type ServiceLocation,
  type ServiceSubjectKind,
  type ServiceTrack,
  type ServiceWorkType,
} from "./service-profiles";

export const SERVICE_WORK_TYPES = ["REPAIR", "MAINTENANCE", "INSTALLATION", "INSPECTION", "PROFESSIONAL", "REMOTE_SUPPORT", "AFTER_SALE"] as const satisfies readonly ServiceWorkType[];
export const SERVICE_LOCATIONS = ["AT_BUSINESS", "AT_CUSTOMER", "FIELD_SITE", "REMOTE"] as const satisfies readonly ServiceLocation[];
export const SERVICE_SUBJECT_KINDS = ["ITEM", "VEHICLE", "SYSTEM", "NONE"] as const satisfies readonly ServiceSubjectKind[];

/** Limits of the migration's CHECKs (ServiceCase_track_texts, ServiceDevice_subject_fields, ServiceCompletion_texts). */
export const TRACK_TEXT_LIMITS = { siteAddress: 500, siteNotes: 2000, originalSaleRef: 120, displayName: 200, attributesBytes: 8192, confirmedByName: 200, completionNote: 2000, detailReason: 1000 } as const;

export const isTrack = (v: unknown): v is ServiceTrack => typeof v === "string" && (SERVICE_TRACKS as readonly string[]).includes(v);
export const isWorkType = (v: unknown): v is ServiceWorkType => typeof v === "string" && (SERVICE_WORK_TYPES as readonly string[]).includes(v);
export const isLocation = (v: unknown): v is ServiceLocation => typeof v === "string" && (SERVICE_LOCATIONS as readonly string[]).includes(v);
export const isSubjectKind = (v: unknown): v is ServiceSubjectKind => typeof v === "string" && (SERVICE_SUBJECT_KINDS as readonly string[]).includes(v);
export const isReturnReason = (v: unknown): v is ReturnReason => typeof v === "string" && (RETURN_REASONS as readonly string[]).includes(v);
export const isResolution = (v: unknown): v is AfterSaleResolution => typeof v === "string" && (AFTER_SALE_RESOLUTIONS as readonly string[]).includes(v);

// ── Effective values (NULL = derived from kind) ──────────────────────────────────────────────────────────────

/** The migration's rule: IN_SHOP → AT_BUSINESS; REMOTE → REMOTE; FIELD / MAINTENANCE → AT_CUSTOMER. */
export function effectiveLocation(kind: ServiceCaseKind, serviceLocation: ServiceLocation | null): ServiceLocation {
  if (serviceLocation !== null) return serviceLocation;
  return kind === "IN_SHOP" ? "AT_BUSINESS" : kind === "REMOTE" ? "REMOTE" : "AT_CUSTOMER";
}

/** IN_SHOP / FIELD → REPAIR; MAINTENANCE → MAINTENANCE; REMOTE → REMOTE_SUPPORT. */
export function effectiveWorkType(kind: ServiceCaseKind, workType: ServiceWorkType | null): ServiceWorkType {
  if (workType !== null) return workType;
  return kind === "MAINTENANCE" ? "MAINTENANCE" : kind === "REMOTE" ? "REMOTE_SUPPORT" : "REPAIR";
}

/** The kind that matches a place (CHECK ServiceCase_location_matches_kind); an on-site case keeps FIELD / MAINTENANCE. */
export function kindForLocation(location: ServiceLocation, previous: ServiceCaseKind | null = null): ServiceCaseKind {
  if (location === "AT_BUSINESS") return "IN_SHOP";
  if (location === "REMOTE") return "REMOTE";
  return previous === "FIELD" || previous === "MAINTENANCE" ? previous : "FIELD";
}

/**
 * The track of a case: AFTER_SALE → T7; INSTALLATION → T4; PROFESSIONAL → T5; REMOTE_SUPPORT or any work done
 * remotely → T6; work at the business → T2 for a vehicle, T1 otherwise; work on site → T3 (REPAIR / MAINTENANCE /
 * INSPECTION, section ב table).
 */
export function deriveTrack(workType: ServiceWorkType, location: ServiceLocation, subjectKind: ServiceSubjectKind | null): ServiceTrack {
  if (workType === "AFTER_SALE") return "T7";
  if (workType === "INSTALLATION") return "T4";
  if (workType === "PROFESSIONAL") return "T5";
  if (workType === "REMOTE_SUPPORT" || location === "REMOTE") return "T6";
  if (location === "AT_BUSINESS") return subjectKind === "VEHICLE" ? "T2" : "T1";
  return "T3";
}

/** The places a track may run at. T5 (professional) anywhere; T4 at the customer or a field site; T3 likewise. */
export function allowedLocations(track: ServiceTrack): readonly ServiceLocation[] {
  switch (track) {
    case "T1": case "T2": case "T7": return ["AT_BUSINESS"];
    case "T3": case "T4": return ["AT_CUSTOMER", "FIELD_SITE"];
    case "T5": return ["AT_BUSINESS", "AT_CUSTOMER", "FIELD_SITE", "REMOTE"];
    case "T6": return ["REMOTE"];
  }
}

/** The requirements a case is judged by — its own snapshot only; T7 reads the chosen resolution's row (repair row until then). */
export function requirementsOf(snapshot: ProfileSnapshot, track: ServiceTrack, resolution: AfterSaleResolution | null): Requirements {
  return requirementsFromSnapshot(snapshot, track, track === "T7" && resolution !== null ? resolution : undefined);
}

/**
 * The track facts the case machine judges a track case by, from the case's own columns and snapshot (D14). The service
 * loads the inputs under the case lock; this is the one place they are turned into facts. A case without a snapshot
 * has no facts (null) and keeps today's kind rules — callers never call this for one.
 */
export function buildTrackFacts(input: {
  snapshot: ProfileSnapshot;
  kind: ServiceCaseKind;
  workType: ServiceWorkType | null;
  serviceLocation: ServiceLocation | null;
  subjectKind: ServiceSubjectKind | null;
  afterSaleResolution: AfterSaleResolution | null;
  siteAddressSet: boolean;
  moneyCommitment: boolean;
  creditDocumentLinked: boolean;
}): ServiceTrackFacts {
  const workType = effectiveWorkType(input.kind, input.workType);
  const location = effectiveLocation(input.kind, input.serviceLocation);
  const track = deriveTrack(workType, location, input.subjectKind);
  const resolution = track === "T7" ? input.afterSaleResolution : null;
  return {
    track,
    workType,
    location,
    itemAtBusiness: TRACKS[track].itemAtBusiness,
    requirements: requirementsOf(input.snapshot, track, resolution),
    afterSaleResolution: resolution,
    siteAddressSet: input.siteAddressSet,
    moneyCommitment: input.moneyCommitment,
    creditDocumentLinked: input.creditDocumentLinked,
  };
}

/** A snapshot read back from the database is accepted only in the shape and version this code writes (fail closed). */
export function parseSnapshot(raw: unknown): ProfileSnapshot | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const s = raw as Partial<ProfileSnapshot>;
  if (s.version !== 1 || typeof s.profileKey !== "string" || !s.requirements || !s.afterSale || !Array.isArray(s.enabledTracks)) return null;
  for (const t of SERVICE_TRACKS) if (!s.requirements[t]) return null;
  for (const r of AFTER_SALE_RESOLUTIONS) if (!s.afterSale[r]) return null;
  return s as ProfileSnapshot;
}

/** The completion type a place allows — the owner confirms where the work was done (never a customer signature). */
export function completionTypeFor(location: ServiceLocation): ServiceCompletionType {
  return location === "REMOTE" ? "OWNER_CONFIRMED_REMOTE" : location === "AT_BUSINESS" ? "OWNER_CONFIRMED_AT_BUSINESS" : "OWNER_CONFIRMED_ON_SITE";
}

/** The case reaches READY (an owner-confirmed handover follows) rather than WORK_DONE (an owner-confirmed COMPLETE). */
export function handsBack(t: ServiceTrackFacts): boolean {
  return t.requirements.handoverByOwner;
}

// ── Opening with a track ─────────────────────────────────────────────────────────────────────────────────────

export type TrackSubjectInput = { kind?: unknown; displayName?: unknown; attributes?: unknown };
export type TrackOpeningInput = {
  track: unknown;
  serviceLocation?: unknown;
  siteAddress?: unknown;
  siteNotes?: unknown;
  returnReason?: unknown;
  originalSaleRef?: unknown;
  subject?: unknown;
};
export type TrackOpening = {
  track: ServiceTrack;
  kind: ServiceCaseKind;
  workType: ServiceWorkType;
  serviceLocation: ServiceLocation;
  siteAddress: string | null;
  siteNotes: string | null;
  returnReason: ReturnReason | null;
  originalSaleRef: string | null;
  /** A new subject (ServiceDevice) to create with the case, or null (an existing deviceId, or none). */
  subject: { subjectKind: ServiceSubjectKind; displayName: string | null; attributes: Record<string, string | number | boolean | null> | null } | null;
  /** The subject kind the track expects (T2: VEHICLE). */
  expectedSubjectKind: ServiceSubjectKind;
  suggestedResolution: AfterSaleResolution | null;
};
export type TrackOpeningResult = { ok: true; opening: TrackOpening } | { ok: false; code: string; field: string };

const codePoints = (s: string) => Array.from(s).length;

function optText(v: unknown, max: number, field: string, exactTrim = false): { ok: true; value: string | null } | { ok: false; field: string } {
  if (v === undefined || v === null) return { ok: true, value: null };
  if (typeof v !== "string") return { ok: false, field };
  const t = v.trim();
  if (t.length === 0) return { ok: true, value: null };
  if (codePoints(t) > max || (exactTrim && /[\u0000-\u001f\u007f]/.test(t))) return { ok: false, field };
  return { ok: true, value: t };
}

/**
 * The opening of a case with a track: everything the case row and its subject will hold, consistent with the
 * migration's CHECKs (location ⇔ kind; after-sale fields only on T7; text limits; attributes a flat object of
 * scalars ≤ 8 KB). Refusals name a field, never echo a value.
 */
export function planTrackOpening(input: TrackOpeningInput): TrackOpeningResult {
  if (!isTrack(input.track)) return { ok: false, code: "INVALID_INPUT", field: "track" };
  const track = input.track;
  const def = TRACKS[track];
  let location: ServiceLocation;
  if (def.location === "ANY") {
    if (!isLocation(input.serviceLocation)) return { ok: false, code: "INVALID_INPUT", field: "serviceLocation" };
    location = input.serviceLocation;
  } else if (input.serviceLocation === undefined || input.serviceLocation === null) {
    location = def.location;
  } else {
    if (!isLocation(input.serviceLocation) || !allowedLocations(track).includes(input.serviceLocation)) return { ok: false, code: "INVALID_INPUT", field: "serviceLocation" };
    location = input.serviceLocation;
  }
  const onSite = location === "AT_CUSTOMER" || location === "FIELD_SITE";
  const addr = optText(input.siteAddress, TRACK_TEXT_LIMITS.siteAddress, "siteAddress");
  if (!addr.ok) return { ok: false, code: "INVALID_INPUT", field: addr.field };
  const notes = optText(input.siteNotes, TRACK_TEXT_LIMITS.siteNotes, "siteNotes");
  if (!notes.ok) return { ok: false, code: "INVALID_INPUT", field: notes.field };
  // An address belongs to work on site; it is not required at opening (SCHEDULE requires it), but never elsewhere.
  if (!onSite && (addr.value !== null || notes.value !== null)) return { ok: false, code: "INVALID_INPUT", field: addr.value !== null ? "siteAddress" : "siteNotes" };

  let returnReason: ReturnReason | null = null;
  let originalSaleRef: string | null = null;
  if (track === "T7") {
    if (!isReturnReason(input.returnReason)) return { ok: false, code: "RETURN_REASON_REQUIRED", field: "returnReason" };
    returnReason = input.returnReason;
    const ref = optText(input.originalSaleRef, TRACK_TEXT_LIMITS.originalSaleRef, "originalSaleRef", true);
    if (!ref.ok) return { ok: false, code: "INVALID_INPUT", field: ref.field };
    originalSaleRef = ref.value;
  } else if ((input.returnReason !== undefined && input.returnReason !== null) || (input.originalSaleRef !== undefined && input.originalSaleRef !== null)) {
    return { ok: false, code: "AFTER_SALE_FIELDS", field: input.returnReason !== undefined && input.returnReason !== null ? "returnReason" : "originalSaleRef" };
  }

  let subject: TrackOpening["subject"] = null;
  if (input.subject !== undefined && input.subject !== null) {
    const s = input.subject as TrackSubjectInput;
    if (typeof s !== "object" || Array.isArray(s)) return { ok: false, code: "INVALID_INPUT", field: "subject" };
    const known = new Set(["kind", "displayName", "attributes"]);
    for (const k of Object.keys(s)) if (!known.has(k)) return { ok: false, code: "INVALID_INPUT", field: `subject.${k}`.slice(0, 40) };
    const subjectKind = s.kind === undefined || s.kind === null ? def.subject : s.kind;
    if (!isSubjectKind(subjectKind)) return { ok: false, code: "INVALID_INPUT", field: "subject.kind" };
    const name = optText(s.displayName, TRACK_TEXT_LIMITS.displayName, "subject.displayName");
    if (!name.ok) return { ok: false, code: "INVALID_INPUT", field: name.field };
    let attributes: Record<string, string | number | boolean | null> | null = null;
    if (s.attributes !== undefined && s.attributes !== null) {
      const a = s.attributes;
      if (typeof a !== "object" || Array.isArray(a)) return { ok: false, code: "INVALID_INPUT", field: "subject.attributes" };
      const entries = Object.entries(a as Record<string, unknown>);
      if (entries.length > 40) return { ok: false, code: "INVALID_INPUT", field: "subject.attributes" };
      for (const [k, v] of entries) {
        if (!/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(k)) return { ok: false, code: "INVALID_INPUT", field: "subject.attributes" };
        if (!(v === null || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v)) || (typeof v === "string" && codePoints(v) <= 500))) {
          return { ok: false, code: "INVALID_INPUT", field: "subject.attributes" };
        }
      }
      attributes = entries.length === 0 ? null : (Object.fromEntries(entries) as Record<string, string | number | boolean | null>);
      if (attributes && Buffer.byteLength(JSON.stringify(attributes), "utf8") > TRACK_TEXT_LIMITS.attributesBytes - 512) {
        return { ok: false, code: "INVALID_INPUT", field: "subject.attributes" };
      }
    }
    subject = { subjectKind, displayName: name.value, attributes };
  }

  return {
    ok: true,
    opening: {
      track,
      kind: kindForLocation(location),
      workType: def.workType,
      serviceLocation: location,
      siteAddress: addr.value,
      siteNotes: notes.value,
      returnReason,
      originalSaleRef,
      subject,
      expectedSubjectKind: def.subject,
      suggestedResolution: returnReason ? suggestedResolution(returnReason) : null,
    },
  };
}

/**
 * The subject a case names must keep its track derivable: T2 needs a VEHICLE, T1 must not name one (it would read
 * back as T2). Other tracks accept any subject kind (or none).
 */
export function subjectFitsTrack(track: ServiceTrack, subjectKind: ServiceSubjectKind | null): boolean {
  if (track === "T2") return subjectKind === "VEHICLE";
  if (track === "T1") return subjectKind !== "VEHICLE";
  return true;
}

// ── T7: the after-sale resolution (section כח) ──────────────────────────────────────────────────────────────

/**
 * The inventory contract EXCHANGE waits for (owned by the inventory team; nothing here calls it). The service needs
 * ONE function, run in the caller's tenant transaction (same tx as the case event), idempotent by a request key:
 *   issueExchange(tx, { businessId, caseId, replacement: { inventoryItemId, quantity: 1 }, returned: { originalSaleRef,
 *     disposition: "QUARANTINE" | "RESTOCK" }, requestKey }) → { issueMovementId, returnMovementId | null }
 * — one OUT movement for the replacement (reason SERVICE_PART / EXCHANGE, never a second SALE movement), the returned
 * item received without restocking unless chosen (DISPOSE_RETURNED_ITEM, section טז), atomic under the item lock (M0),
 * refusing a negative stock. Until it exists EXCHANGE is refused, before anything is written.
 */
export const EXCHANGE_INVENTORY_CONTRACT = "inventory.issueExchange(tx, { businessId, caseId, replacement, returned, requestKey }) — M0 atomic movements, caller's tx";

export type AfterSaleStep = Extract<ServiceCaseAction, { type: "START_REPAIR" | "FINISH_REPAIR" | "MARK_NOT_REPAIRABLE" }>;
export type AfterSaleDecision =
  | { ok: true; resolution: AfterSaleResolution; steps: AfterSaleStep[] }
  | { ok: false; code: "NOT_AFTER_SALE" | "RESOLUTION_ALREADY_CHOSEN" | "INVALID_TRANSITION" | "EXCHANGE_NEEDS_INVENTORY" | "NO_CHANGE" | "INVALID_INPUT" };

/**
 * Choosing how a T7 case ends, after inspection (DIAGNOSING) or during the repair (IN_REPAIR). The choice is journaled
 * by the existing transitions it runs (each judged by the case machine with the resolution's own requirement row):
 *   REPAIR           DIAGNOSING → START_REPAIR (D15 per the repair row); continues as a repair (QA, READY, handover)
 *   RETURN_ORIGINAL  → MARK_NOT_REPAIRABLE → READY (outcome NOT_REPAIRED): the item goes back through the normal
 *                    owner-confirmed handover (a NO_CHARGE decision is typical)
 *   CREDIT           → (START_REPAIR, no approval: the CREDIT row needs none) → FINISH_REPAIR COMPLETED → WORK_DONE; the
 *                    item stays with the business; COMPLETE needs an AFTER_SALE_CREDIT link to an issued credit note
 *   EXCHANGE         refused: EXCHANGE_NEEDS_INVENTORY (see EXCHANGE_INVENTORY_CONTRACT)
 */
export function decideAfterSale(input: { track: ServiceTrack | null; status: ServiceCaseStatus; current: AfterSaleResolution | null; resolution: unknown }): AfterSaleDecision {
  if (!isResolution(input.resolution)) return { ok: false, code: "INVALID_INPUT" };
  if (input.track !== "T7") return { ok: false, code: "NOT_AFTER_SALE" };
  if (input.resolution === "EXCHANGE") return { ok: false, code: "EXCHANGE_NEEDS_INVENTORY" };
  if (input.current !== null) return { ok: false, code: input.current === input.resolution ? "NO_CHANGE" : "RESOLUTION_ALREADY_CHOSEN" };
  if (input.status !== "DIAGNOSING" && input.status !== "IN_REPAIR") return { ok: false, code: "INVALID_TRANSITION" };
  const r = input.resolution;
  const diagnosing = input.status === "DIAGNOSING";
  switch (r) {
    case "REPAIR":
      // In IN_REPAIR the case already is a repair (the repair row applies while nothing is chosen).
      return diagnosing ? { ok: true, resolution: r, steps: [{ type: "START_REPAIR" }] } : { ok: false, code: "NO_CHANGE" };
    case "RETURN_ORIGINAL":
      return { ok: true, resolution: r, steps: [{ type: "MARK_NOT_REPAIRABLE" }] };
    case "CREDIT":
      return { ok: true, resolution: r, steps: diagnosing ? [{ type: "START_REPAIR" }, { type: "FINISH_REPAIR", outcome: "COMPLETED" }] : [{ type: "FINISH_REPAIR", outcome: "COMPLETED" }] };
  }
}
