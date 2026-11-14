/**
 * Service Desk M1 — the database side of the case TRACK (migration 20261127090000). Everything here runs inside the
 * command's tenant transaction, AFTER the case row is locked FOR UPDATE (lockCase), so the facts cannot move before the
 * command commits; the database guard re-checks the same rules on the same locked row (service_case_guard (a)–(d), the
 * deferred journal / completion triggers).
 *
 *   - loadTrackState    the case's own snapshot (D14) → ServiceTrackFacts (null = a case without a track: today's rules)
 *   - countDetailBlockers  the D3 blockers of CHANGE_DETAILS (the guard's list + D12 intake + D16 appointment started)
 *   - verifyTrackFits   a details change keeps a track its subject fits (every track is open to every business)
 *   - planOpening       a case opened with a track: the chosen profile template (else general) snapshot, the place, the subject
 *
 * No free text leaves this module in an error: codes and field names only.
 */
import type { Prisma } from "@prisma/client";
import type { ServiceCaseDetails, ServiceCaseKind, ServiceDetailBlockers, ServiceTrackFacts } from "./contracts";
import { ServiceDeskError } from "./service-desk-errors";
import {
  buildProfileSnapshot,
  isServiceProfileKey,
  type AfterSaleResolution,
  type ProfileOverrides,
  type ProfileSnapshot,
  type ReturnReason,
  type ServiceLocation,
  type ServiceSubjectKind,
  type ServiceWorkType,
} from "./service-profiles";
import {
  buildTrackFacts,
  deriveTrack,
  effectiveLocation,
  effectiveWorkType,
  parseSnapshot,
  planTrackOpening,
  subjectFitsTrack,
  type TrackOpening,
  type TrackOpeningInput,
} from "./tracks.core";

type Tx = Prisma.TransactionClient;

/** The M1 columns lockCase reads with the case row (same SELECT, same lock). */
export type TrackRow = {
  kind: ServiceCaseKind;
  workType: string | null;
  serviceLocation: string | null;
  siteAddress: string | null;
  returnReason: string | null;
  afterSaleResolution: string | null;
  profileSnapshot: unknown;
  appointmentId: number | null;
  deviceId: number | null;
};

export type TrackState = {
  /** null = the case has no snapshot (opened before M1, or without a track): the core keeps today's kind rules. */
  track: ServiceTrackFacts | null;
  snapshot: ProfileSnapshot | null;
  subjectKind: ServiceSubjectKind | null;
  details: ServiceCaseDetails;
};

/** An ACTIVE after-sale credit link (an issued credit note — the link command and the charge migration's guard check it). */
export async function creditDocumentLinked(tx: Tx, b: number, caseId: number): Promise<boolean> {
  const r = await tx.$queryRaw<{ ok: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM "ServiceCaseBillingLink"
                    WHERE "businessId" = ${b}::int AND "caseId" = ${caseId}::int
                      AND role::text = 'AFTER_SALE_CREDIT' AND "unlinkedAt" IS NULL AND "erasedAt" IS NULL) AS ok`;
  return r[0]?.ok === true;
}

/**
 * D15: a money commitment to the customer exists — a quote (every ServiceQuote row was at least SENT) or a part line with a
 * customer price that is not cancelled. With workApproval BY_D15 the work then needs an approved quote or cover.
 */
async function moneyCommitment(tx: Tx, b: number, caseId: number): Promise<boolean> {
  const r = await tx.$queryRaw<{ ok: boolean }[]>`
    SELECT (EXISTS (SELECT 1 FROM "ServiceQuote" WHERE "businessId" = ${b}::int AND "caseId" = ${caseId}::int)
         OR EXISTS (SELECT 1 FROM "ServicePart" WHERE "businessId" = ${b}::int AND "caseId" = ${caseId}::int
                     AND "customerUnitPriceAgorot" IS NOT NULL AND state::text <> 'CANCELLED')) AS ok`;
  return r[0]?.ok === true;
}

export async function loadTrackState(tx: Tx, b: number, caseId: number, row: TrackRow): Promise<TrackState> {
  const details: ServiceCaseDetails = {
    kind: row.kind,
    workType: (row.workType as ServiceWorkType | null) ?? null,
    serviceLocation: (row.serviceLocation as ServiceLocation | null) ?? null,
    siteAddress: row.siteAddress ?? null,
    returnReason: (row.returnReason as ReturnReason | null) ?? null,
  };
  const subjectKind = row.deviceId === null ? null : ((await tx.$queryRaw<{ k: string }[]>`
    SELECT "subjectKind"::text AS k FROM "ServiceDevice" WHERE id = ${row.deviceId}::int AND "businessId" = ${b}::int`)[0]?.k as ServiceSubjectKind | undefined) ?? null;
  if (row.profileSnapshot === null || row.profileSnapshot === undefined) return { track: null, snapshot: null, subjectKind, details };
  // Fail closed: a snapshot this code did not write is never guessed at.
  const snapshot = parseSnapshot(row.profileSnapshot);
  if (!snapshot) throw new ServiceDeskError("SERVER_CHECK_FAILED", { check: "PROFILE_SNAPSHOT_VALID" });
  const track = buildTrackFacts({
    snapshot,
    kind: row.kind,
    workType: details.workType,
    serviceLocation: details.serviceLocation,
    subjectKind,
    afterSaleResolution: (row.afterSaleResolution as AfterSaleResolution | null) ?? null,
    siteAddressSet: details.siteAddress !== null,
    moneyCommitment: await moneyCommitment(tx, b, caseId),
    creditDocumentLinked: await creditDocumentLinked(tx, b, caseId),
  });
  return { track, snapshot, subjectKind, details };
}

/**
 * The D3 blockers of CHANGE_DETAILS, counted under the case lock. `binding` is exactly the database guard's list
 * (blockers 2, 4, 6–9); `intakeStarted` is D12 (an intake row or an intake photo); `appointmentStarted` is blocker 11,
 * which only the server can see (D16: the Appointment module is not touched) — the linked appointment's start passed,
 * it actually started, or it is no longer PROPOSED / CONFIRMED.
 */
export async function countDetailBlockers(tx: Tx, b: number, caseId: number, appointmentId: number | null, now: Date): Promise<ServiceDetailBlockers> {
  const r = (await tx.$queryRaw<{ binding: boolean; intake: boolean; appt: boolean }[]>`
    SELECT (EXISTS (SELECT 1 FROM "ServiceIntakeTermsSnapshot" s WHERE s."businessId" = ${b}::int AND s."caseId" = ${caseId}::int)
         OR EXISTS (SELECT 1 FROM "ServiceCaseIntake" i WHERE i."businessId" = ${b}::int AND i."caseId" = ${caseId}::int AND i."signedAt" IS NOT NULL)
         OR EXISTS (SELECT 1 FROM "ServiceQuote" q WHERE q."businessId" = ${b}::int AND q."caseId" = ${caseId}::int AND q.state::text IN ('SENT', 'APPROVED'))
         OR EXISTS (SELECT 1 FROM "ServiceWarrantyOffer" w WHERE w."businessId" = ${b}::int AND w."caseId" = ${caseId}::int AND w."presentedAt" IS NOT NULL)
         OR EXISTS (SELECT 1 FROM "ServicePart" p WHERE p."businessId" = ${b}::int AND p."caseId" = ${caseId}::int AND p.state::text <> 'CANCELLED')
         OR EXISTS (SELECT 1 FROM "ServiceExternalWork" x WHERE x."businessId" = ${b}::int AND x."caseId" = ${caseId}::int)
         OR EXISTS (SELECT 1 FROM "ServiceHandover" h WHERE h."businessId" = ${b}::int AND h."caseId" = ${caseId}::int)
         OR EXISTS (SELECT 1 FROM "ServiceCompletion" k WHERE k."businessId" = ${b}::int AND k."caseId" = ${caseId}::int)) AS binding,
           (EXISTS (SELECT 1 FROM "ServiceCaseIntake" i WHERE i."businessId" = ${b}::int AND i."caseId" = ${caseId}::int)
         OR EXISTS (SELECT 1 FROM "ServiceIntakePhoto" f WHERE f."businessId" = ${b}::int AND f."caseId" = ${caseId}::int)) AS intake,
           (${appointmentId}::int IS NOT NULL AND EXISTS (
              SELECT 1 FROM "Appointment" a WHERE a.id = ${appointmentId}::int AND a."businessId" = ${b}::int
                 AND (a.status::text NOT IN ('PROPOSED', 'CONFIRMED') OR a."actualStartedAt" IS NOT NULL
                      OR (a."startsAt" IS NOT NULL AND a."startsAt" <= ${now}::timestamp)))) AS appt`)[0];
  return { binding: r?.binding === true, intakeStarted: r?.intake === true, appointmentStarted: r?.appt === true };
}

/**
 * SUBJECT_FITS_TRACK: the track the new details derive is one the case's OWN snapshot enables, and the case's
 * subject keeps it derivable (T2 needs a vehicle; T1 must not name one). Refused, never assumed.
 */
export function verifyTrackFits(state: TrackState, after: ServiceCaseDetails): void {
  if (!state.snapshot) throw new ServiceDeskError("SERVER_CHECK_FAILED", { check: "SUBJECT_FITS_TRACK" });
  const track = deriveTrack(effectiveWorkType(after.kind, after.workType), effectiveLocation(after.kind, after.serviceLocation), state.subjectKind);
  // Owner decision 2026-11-11 (universal service): every track is open to every business — only the subject must fit.
  if (!subjectFitsTrack(track, state.subjectKind)) {
    throw new ServiceDeskError("SERVER_CHECK_FAILED", { check: "SUBJECT_FITS_TRACK", track });
  }
}

// ── Opening with a track ─────────────────────────────────────────────────────────────────────────────────────

export type PlannedOpening = { opening: TrackOpening; profileKey: string; snapshot: ProfileSnapshot };

/**
 * D14: the snapshot is taken from the business's profile AT the opening — ServiceSettings.serviceProfileKey, else the
 * profile of the business category — with the owner's overrides, validated. The track must be one it enables. The
 * request names nothing of the snapshot: it cannot loosen a requirement.
 */
export async function planOpening(tx: Tx, b: number, input: TrackOpeningInput): Promise<PlannedOpening> {
  const plan = planTrackOpening(input);
  if (!plan.ok) {
    if (plan.code === "INVALID_INPUT") throw new ServiceDeskError("INVALID_INPUT", { field: plan.field });
    throw new ServiceDeskError("REFUSED", { violations: [plan.code], field: plan.field });
  }
  const s = (await tx.$queryRaw<{ key: string | null; overrides: unknown }[]>`
    SELECT "serviceProfileKey" AS key, "profileOverrides" AS overrides FROM "ServiceSettings" WHERE "businessId" = ${b}::int`)[0];
  // Owner decision 2026-11-11 (universal service): the business category never decides anything here. A profile is a
  // template the owner may choose in the settings; without that choice every business gets the general profile.
  const chosen = typeof s?.key === "string" ? s.key.trim() : "";
  const profileKey = isServiceProfileKey(chosen) ? chosen : "general";
  const built = buildProfileSnapshot(profileKey, (s?.overrides ?? null) as ProfileOverrides | null);
  // Overrides that no longer validate are never applied silently: the opening is refused until the settings are fixed.
  if (!built.ok) throw new ServiceDeskError("SERVER_CHECK_FAILED", { check: "PROFILE_OVERRIDES_VALID" });
  // Every track is open to every business (owner decision 2026-11-11): the profile's tracks are suggestions only.
  return { opening: plan.opening, profileKey, snapshot: built.snapshot };
}

/** The subject of an opening: an existing device of the customer (its kind) or the new one the opening creates. */
export async function subjectKindOf(tx: Tx, b: number, customerId: number, deviceId: number | null, planned: TrackOpening): Promise<ServiceSubjectKind | null> {
  if (deviceId !== null) {
    const k = (await tx.$queryRaw<{ k: string }[]>`
      SELECT "subjectKind"::text AS k FROM "ServiceDevice" WHERE id = ${deviceId}::int AND "businessId" = ${b}::int AND "customerId" = ${customerId}::int AND "erasedAt" IS NULL`)[0]?.k;
    if (!k) throw new ServiceDeskError("SERVER_CHECK_FAILED", { check: "DEVICE_BELONGS_TO_CUSTOMER" });
    return k as ServiceSubjectKind;
  }
  return planned.subject?.subjectKind ?? null;
}

/** Creates the opening's new subject (ServiceDevice) for the customer; returns its id. */
export async function createSubject(tx: Tx, b: number, customerId: number, subject: NonNullable<TrackOpening["subject"]>): Promise<number> {
  return Number((await tx.$queryRaw<{ id: number }[]>`
    INSERT INTO "ServiceDevice" ("businessId", "customerId", "subjectKind", "displayName", attributes, "updatedAt")
    VALUES (${b}::int, ${customerId}::int, ${subject.subjectKind}::"ServiceSubjectKind", ${subject.displayName}::text,
            ${subject.attributes === null ? null : JSON.stringify(subject.attributes)}::jsonb, now())
    RETURNING id`)[0].id);
}
