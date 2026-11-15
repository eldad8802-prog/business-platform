/**
 * Service Desk M1 tracks (migration 20261127090000, DRAFT) — the database guards AS the real runtime role, on the P4 lab
 * (.sd3p4/lab.sh <db> then --deploy-only) with #1096, #1104 and M1 applied (.sdm1/chain.sh). Synthetic only.
 * (Modelled on .sdcharge/battery.ts.)
 *
 *   G  legacy: the existing code (openCase, runCaseAction, getCase) keeps working; new columns stay NULL / default.
 *   L  place ⇔ kind: AT_BUSINESS ⇔ IN_SHOP, REMOTE ⇔ REMOTE; FIELD_SITE / AT_CUSTOMER with FIELD / MAINTENANCE.
 *   T  T7: return reason / resolution / sale reference only with AFTER_SALE.
 *   D  D3 / D11: details change only OPEN / SCHEDULED, before any binding action, always journaled (event + detail row
 *      at the new version, deferred), never leaving AT_BUSINESS after an intake was started; UNSCHEDULE only journaled;
 *      D14 snapshot fixed; detail history append-only.
 *   O  WORK_DONE / COMPLETED / COMPLETE: outcome rule widened, COMPLETED not for REPAIR, completion stamp + record
 *      (one per case, immutable, no signature columns, place = place of the work), journal pairing; closing with an open
 *      debt (owner decision 2026-11-11): the balance is always stated (no default — UNKNOWN is unrepresentable), never
 *      negative, debt XOR overpayment; a debt needs reason + approving user (same business) + approval time; no debt →
 *      none of them; the approver is the acting user (owner 2026-11-12: a second user as approver is refused until an
 *      independent approval mechanism exists); a deleted user only nulls its references; the erasure clears reason +
 *      approver, keeps the numbers.
 *   S  settings: profile key from the closed list, overrides an object; the settings journal names the new fields.
 *   V  subject: subjectKind default ITEM, attributes an object, display name bounded.
 *   I  isolation.  E  erasure: refused unless deleting; not imitable; scrubs in place; re-run safe.
 *
 * env: OWNER_URL (lab owner — fixtures), DATABASE_URL = DIRECT_URL (app_runtime_prod), TASK_REQUEST_HMAC_KEY / _ID,
 *      AUTH_TOKEN_SECRET.
 */
import { PrismaClient } from "@prisma/client";

import { uuidV7 } from "../lib/services/tasks/task-idempotency";
import { getCase, openCase, runCaseAction, type ServiceDeskPrincipal } from "../lib/services/service-desk/service-case.service";

const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });
const runtime = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL! });
let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); } else { failures.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}
type Rows = Record<string, unknown>[];
type Stmt = [string, ...unknown[]];
const q = (sql: string, ...a: unknown[]) => owner.$queryRawUnsafe(sql, ...a) as Promise<Rows>;
const x = (sql: string, ...a: unknown[]) => owner.$executeRawUnsafe(sql, ...a);
const key = () => uuidV7(new Date());
const err = (e: unknown) => (e as Error).message.replace(/\s+/g, " ").trim();
/** Runs statements AS the runtime role inside one tenant transaction; "OK" or the database's refusal. */
async function rt(b: number, ...stmts: Stmt[]): Promise<string> {
  try {
    await runtime.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_business_id', $1, true)`, String(b));
      for (const [sql, ...a] of stmts) await tx.$executeRawUnsafe(sql, ...a);
    });
    return "OK";
  } catch (e) { return `ERR:${err(e).slice(-300)}`; }
}
async function rtRows(b: number, sql: string, ...a: unknown[]): Promise<Rows> {
  return runtime.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('app.current_business_id', $1, true)`, String(b));
    return (await tx.$queryRawUnsafe(sql, ...a)) as Rows;
  });
}
/** Lab owner, in a tenant context (FORCE RLS: the owner too sees only the tenant's rows). */
async function own(b: number, sql: string, ...a: unknown[]): Promise<Rows> {
  return owner.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('app.current_business_id', $1, true)`, String(b));
    return (await tx.$queryRawUnsafe(sql, ...a)) as Rows;
  });
}

const t = Date.now();
async function business(tag: string) {
  const b = Number((await q(`INSERT INTO "Business" (name, "updatedAt") VALUES ($1, now()) RETURNING id`, `sdm1-${tag}-${t}`))[0].id);
  const u = Number((await q(`INSERT INTO "User" (email, "businessId", "updatedAt") VALUES ($1, $2, now()) RETURNING id`, `sdm1-${tag}-${t}@lab.invalid`, b))[0].id);
  const cust = Number((await own(b, `INSERT INTO "Customer" ("businessId", name, "updatedAt") VALUES ($1, 'לקוח סינתטי', now()) RETURNING id`, b))[0].id);
  return { b, u, cust, p: { businessId: b, userId: u } as ServiceDeskPrincipal };
}
type Biz = Awaited<ReturnType<typeof business>>;
const open = async (z: Biz, kind: "IN_SHOP" | "FIELD" | "MAINTENANCE") =>
  (await openCase(z.p, { kind, customerId: z.cust, problemDescription: "תקלה סינתטית" }, { idempotencyKey: key() })).case.id;

type CaseRow = { version: number; status: string; kind: string; workType: string | null; serviceLocation: string | null; returnReason: string | null; siteAddress: string | null };
async function row(z: Biz, id: number): Promise<CaseRow> {
  const r = (await own(z.b, `SELECT version, status::text status, kind::text kind, "workType"::text "workType", "serviceLocation"::text "serviceLocation",
      "returnReason"::text "returnReason", "siteAddress" FROM "ServiceCase" WHERE id = $1`, id))[0];
  return { ...(r as unknown as CaseRow), version: Number(r.version) };
}
const ev = (z: Biz, caseId: number, seq: number, eventType: string, action: string, from: string, to: string, outcome: string | null = null, user: number | null = z.u): Stmt =>
  [`INSERT INTO "ServiceCaseEvent" ("businessId", "caseId", seq, "eventType", action, "fromStatus", "toStatus", "cancellationRequestedBefore",
      "cancellationRequestedAfter", outcome, actor, "actorUserId", "idempotencyKey")
    VALUES ($1, $2, $3, $4::"ServiceEventType", $5::"ServiceCaseAction", $6::"ServiceCaseStatus", $7::"ServiceCaseStatus", false, false,
      $8::"ServiceOutcome", 'OWNER_USER', $9, $10)`, z.b, caseId, seq, eventType, action, from, to, outcome, user, key()];
/** A plain transition: case update (version + 1) and its event. */
async function step(z: Biz, id: number, set: string, action: string, eventType: string, to: string, outcome: string | null = null): Promise<string> {
  const c = await row(z, id);
  return rt(z.b, [`UPDATE "ServiceCase" SET ${set}${set ? ", " : ""}status = $2::"ServiceCaseStatus", version = version + 1 WHERE id = $1`, id, to],
    ev(z, id, c.version + 1, eventType, action, c.status, to, outcome));
}
type Details = Partial<{ kind: string; workType: string | null; serviceLocation: string | null; siteAddress: string | null; returnReason: string | null; status: string }>;
/** CHANGE_DETAILS: case update + event + detail row (each part can be left out or falsified). */
async function changeDetails(z: Biz, id: number, d: Details, o: { noEvent?: boolean; noDetail?: boolean; afterLie?: boolean; detailSeqOffset?: number; extra?: Stmt[]; skipUpdate?: boolean } = {}): Promise<string> {
  const c = await row(z, id);
  const n: CaseRow = { ...c, ...d } as CaseRow;
  const toStatus = d.status ?? c.status;
  const fields = (["kind", "workType", "serviceLocation", "siteAddress", "returnReason"] as const).filter((f) => (c as Record<string, unknown>)[f] !== (n as Record<string, unknown>)[f]);
  const stmts: Stmt[] = [...(o.extra ?? [])];
  if (!o.skipUpdate) {
    stmts.push([`UPDATE "ServiceCase" SET kind = $2::"ServiceCaseKind", "workType" = $3::"ServiceWorkType", "serviceLocation" = $4::"ServiceLocationKind",
        "siteAddress" = $5, "returnReason" = $6::"ServiceReturnReason", status = $7::"ServiceCaseStatus", version = version + 1 WHERE id = $1`,
      id, n.kind, n.workType, n.serviceLocation, n.siteAddress, n.returnReason, toStatus]);
  }
  if (!o.noEvent) stmts.push(ev(z, id, c.version + 1, "case.details_changed", "CHANGE_DETAILS", c.status, toStatus));
  if (!o.noDetail) {
    stmts.push([`INSERT INTO "ServiceCaseDetailChange" ("businessId", "caseId", "caseVersion", "changedFields", "kindBefore", "kindAfter",
        "workTypeBefore", "workTypeAfter", "serviceLocationBefore", "serviceLocationAfter", "returnReasonBefore", "returnReasonAfter",
        "siteAddressBefore", "siteAddressAfter", reason, "actorUserId")
      VALUES ($1, $2, $3, $4::text[], $5::"ServiceCaseKind", $6::"ServiceCaseKind", $7::"ServiceWorkType", $8::"ServiceWorkType",
        $9::"ServiceLocationKind", $10::"ServiceLocationKind", $11::"ServiceReturnReason", $12::"ServiceReturnReason", $13, $14, $15, $16)`,
      z.b, id, c.version + 1 + (o.detailSeqOffset ?? 0), fields.length ? fields : ["workType"], c.kind, n.kind, c.workType,
      o.afterLie ? (n.workType === "INSPECTION" ? "INSTALLATION" : "INSPECTION") : n.workType,
      c.serviceLocation, n.serviceLocation, c.returnReason, n.returnReason, c.siteAddress, n.siteAddress, "הלקוח ביקש שינוי", z.u]);
  }
  return rt(z.b, ...stmts);
}
/** The balance a completion states (agorot), and the debt approval: reason, approving user, approval time (now()). */
type Bal = { open?: number; over?: number; reason?: string | null; approver?: number | null; approvedAt?: boolean; omitBalance?: boolean };
const completion = (z: Biz, id: number, type: string, user: number | null = z.u, bal: Bal = {}): Stmt =>
  bal.omitBalance
    ? [`INSERT INTO "ServiceCompletion" ("businessId", "caseId", "completionType", "actorUserId") VALUES ($1, $2, $3::"ServiceCompletionType", $4)`, z.b, id, type, user]
    : [`INSERT INTO "ServiceCompletion" ("businessId", "caseId", "completionType", "confirmedByName", note, "openBalanceAgorot", "overpaidAgorot",
          "debtOverrideReason", "debtApprovedByUserId", "debtApprovedAt", "actorUserId")
        VALUES ($1, $2, $3::"ServiceCompletionType", 'דנה (סינתטי)', 'הותקן ונבדק', $4::int, $5::int, $6::text, $7::int, CASE WHEN $8::boolean THEN now() END, $9::int)`,
      z.b, id, type, bal.open ?? 0, bal.over ?? 0, bal.reason ?? null, bal.approver ?? null, bal.approvedAt ?? false, user];
async function complete(z: Biz, id: number, type: string, o: { noRecord?: boolean; recordType?: string; bal?: Bal } = {}): Promise<string> {
  const c = await row(z, id);
  const stmts: Stmt[] = [[`UPDATE "ServiceCase" SET status = 'CLOSED', "closedAt" = now(), "completionType" = $2::"ServiceCompletionType", "completedAt" = now(),
      version = version + 1 WHERE id = $1`, id, type]];
  if (!o.noRecord) stmts.push(completion(z, id, o.recordType ?? type, z.u, o.bal));
  stmts.push(ev(z, id, c.version + 1, "case.completed", "COMPLETE", c.status, "CLOSED", "COMPLETED"));
  return rt(z.b, ...stmts);
}

async function main() {
  const A = await business("a");
  const B = await business("b");

  console.log("G — legacy behaviour");
  const g1 = await open(A, "IN_SHOP");
  const g2 = await open(A, "FIELD");
  const g1row = (await own(A.b, `SELECT "workType", "serviceLocation", "siteAddress", "profileKey", "completionType", "returnReason" FROM "ServiceCase" WHERE id = $1`, g1))[0];
  ok("G1 openCase (unchanged code) opens cases after M1; every new column is NULL (derived from kind at read time)",
    Object.values(g1row).every((v) => v === null), JSON.stringify(g1row));
  const card = await getCase(A.b, g1);
  ok("G2 getCase reads it as before", card.id === g1 && card.status === "OPEN");
  let cancelOut = "OK";
  try { await runCaseAction(A.p, g2, { action: { type: "CANCEL" }, expectedVersion: 1 }, { idempotencyKey: key() }); } catch (e) { cancelOut = err(e); }
  ok("G3 runCaseAction (CANCEL) still works on a legacy case", cancelOut === "OK" && (await row(A, g2)).status === "CANCELLED", cancelOut);
  const g3 = await open(A, "FIELD");
  ok("G4 a legacy transition (OPEN → CHECKED_IN) that touches no new column passes the replaced guard",
    (await step(A, g3, `"checkedInAt" = now()`, "CHECK_IN", "case.checked_in", "CHECKED_IN")) === "OK");

  console.log("L — place ⇔ kind");
  const l1 = await open(A, "IN_SHOP");
  ok("L1 AT_CUSTOMER with kind IN_SHOP → ServiceCase_location_matches_kind", (await changeDetails(A, l1, { serviceLocation: "AT_CUSTOMER" })).includes("location_matches_kind"));
  ok("L2 AT_BUSINESS with kind IN_SHOP → written (journaled)", (await changeDetails(A, l1, { serviceLocation: "AT_BUSINESS", workType: "REPAIR" })) === "OK");
  const l2 = await open(A, "FIELD");
  ok("L3 AT_BUSINESS with kind FIELD → refused; REMOTE with kind FIELD → refused",
    (await changeDetails(A, l2, { serviceLocation: "AT_BUSINESS" })).includes("location_matches_kind")
      && (await changeDetails(A, l2, { serviceLocation: "REMOTE" })).includes("location_matches_kind"));
  ok("L4 kind REMOTE with AT_CUSTOMER → refused; kind REMOTE + REMOTE + REMOTE_SUPPORT → written",
    (await changeDetails(A, l2, { kind: "REMOTE", serviceLocation: "AT_CUSTOMER" })).includes("location_matches_kind")
      && (await changeDetails(A, l2, { kind: "REMOTE", serviceLocation: "REMOTE", workType: "REMOTE_SUPPORT" })) === "OK");
  const l3 = await open(A, "MAINTENANCE");
  ok("L5 FIELD_SITE with kind MAINTENANCE → written, with a site address", (await changeDetails(A, l3, { serviceLocation: "FIELD_SITE", workType: "MAINTENANCE", siteAddress: "רחוב סינתטי 1, תל אביב" })) === "OK");
  ok("L6 a site address over 500 characters → ServiceCase_track_texts", (await changeDetails(A, l3, { siteAddress: "א".repeat(501) })).includes("track_texts"));

  console.log("T — after-sale (T7) fields");
  const t1 = await open(A, "IN_SHOP");
  ok("T1 a return reason without AFTER_SALE → ServiceCase_after_sale_fields (also with no work type at all)",
    (await changeDetails(A, t1, { workType: "REPAIR", returnReason: "DEFECT" })).includes("after_sale_fields")
      && (await changeDetails(A, t1, { returnReason: "DEFECT" })).includes("after_sale_fields"));
  ok("T2 AFTER_SALE + DEFECT → written", (await changeDetails(A, t1, { workType: "AFTER_SALE", serviceLocation: "AT_BUSINESS", returnReason: "DEFECT" })) === "OK");
  ok("T3 resolution and sale reference on the AFTER_SALE case → written; a blank reference → refused",
    (await rt(A.b, [`UPDATE "ServiceCase" SET "afterSaleResolution" = 'EXCHANGE', "originalSaleRef" = 'קבלה 1042' WHERE id = $1`, t1])) === "OK"
      && (await rt(A.b, [`UPDATE "ServiceCase" SET "originalSaleRef" = '  ' WHERE id = $1`, t1])).includes("track_texts"));
  ok("T4 a resolution on a non-AFTER_SALE case → refused", (await rt(A.b, [`UPDATE "ServiceCase" SET "afterSaleResolution" = 'CREDIT' WHERE id = $1`, l1])).includes("after_sale_fields"));

  console.log("D — details change (D3 / D11 / D14)");
  const d1 = await open(A, "IN_SHOP");
  ok("D1 a legacy OPEN case (NULL work type / place) gets explicit values: IN_SHOP → FIELD / REPAIR / AT_CUSTOMER + address, journaled → written",
    (await changeDetails(A, d1, { kind: "FIELD", workType: "REPAIR", serviceLocation: "AT_CUSTOMER", siteAddress: "רחוב הדוגמה 5" })) === "OK");
  const d1row = await row(A, d1);
  const d1hist = await own(A.b, `SELECT "changedFields"::text f, "kindBefore"::text kb, "kindAfter"::text ka, "siteAddressAfter" sa FROM "ServiceCaseDetailChange" WHERE "caseId" = $1`, d1);
  ok("D2 the case holds the new values; the detail row holds before / after and the field names",
    d1row.kind === "FIELD" && d1row.serviceLocation === "AT_CUSTOMER" && d1hist.length === 1 && d1hist[0].kb === "IN_SHOP" && d1hist[0].ka === "FIELD"
      && String(d1hist[0].f).includes("siteAddress") && d1hist[0].sa === "רחוב הדוגמה 5", JSON.stringify(d1hist));
  ok("D3 a change without its event → rolled back at COMMIT (the event FK / SERVICE_CASE_DETAILS_NOT_JOURNALED)",
    (await changeDetails(A, d1, { workType: "INSPECTION" }, { noEvent: true })).startsWith("ERR"));
  ok("D4 a change with its event but no detail row → SERVICE_CASE_DETAILS_NOT_JOURNALED",
    (await changeDetails(A, d1, { workType: "INSPECTION" }, { noDetail: true })).includes("SERVICE_CASE_DETAILS_NOT_JOURNALED"));
  ok("D5 a detail row whose after-values are not the case's → SERVICE_DETAIL_CHANGE_MISMATCH",
    (await changeDetails(A, d1, { workType: "INSPECTION" }, { afterLie: true })).includes("SERVICE_DETAIL_CHANGE_MISMATCH"));
  ok("D6 a detail row at the wrong version (no such event) → refused",
    (await changeDetails(A, d1, { workType: "INSPECTION" }, { detailSeqOffset: 5 })).startsWith("ERR"));
  ok("D7 a detail row with field names that do not match the values → ServiceCaseDetailChange_fields_match",
    (await rt(A.b, [`INSERT INTO "ServiceCaseDetailChange" ("businessId", "caseId", "caseVersion", "changedFields", "kindBefore", "kindAfter", "actorUserId")
       VALUES ($1, $2, 2, ARRAY['workType'], 'IN_SHOP', 'FIELD', $3)`, A.b, d1, A.u])).includes("fields_match"));
  ok("D8 a details change that also moves the case forward (OPEN → SCHEDULED) → SERVICE_CASE_DETAILS_FIXED",
    (await changeDetails(A, d1, { workType: "INSPECTION", status: "SCHEDULED" })).includes("SERVICE_CASE_DETAILS_FIXED"));

  const d2 = await open(A, "FIELD");
  ok("D9 OPEN → SCHEDULED (legacy SCHEDULE)", (await step(A, d2, "", "SCHEDULE", "case.scheduled", "SCHEDULED")) === "OK");
  ok("D10 RESCHEDULE keeps SCHEDULED (journal pairing) → written; RESCHEDULE from OPEN → ServiceCaseEvent_tracks_in_place",
    (await step(A, d2, "", "RESCHEDULE", "case.rescheduled", "SCHEDULED")) === "OK"
      && (await step(A, d1, "", "RESCHEDULE", "case.rescheduled", "OPEN")).includes("tracks_in_place"));
  ok("D11 a SCHEDULED case changes its place (FIELD_SITE) → written", (await changeDetails(A, d2, { serviceLocation: "FIELD_SITE", workType: "INSTALLATION" })) === "OK");
  ok("D12 SCHEDULED → OPEN without CHANGE_DETAILS (a status write journaled as another action) → SERVICE_CASE_DETAILS_NOT_JOURNALED",
    (await step(A, d2, "", "CLEAR_HOLD", "hold.cleared", "OPEN")).includes("SERVICE_CASE_DETAILS_NOT_JOURNALED"));
  ok("D13 UNSCHEDULE inside CHANGE_DETAILS (SCHEDULED → OPEN, D13) → written",
    (await changeDetails(A, d2, { siteAddress: "אתר סינתטי 9", status: "OPEN" })) === "OK" && (await row(A, d2)).status === "OPEN");

  const d3 = await open(A, "FIELD");
  await step(A, d3, `"checkedInAt" = now()`, "CHECK_IN", "case.checked_in", "CHECKED_IN");
  ok("D14 after CHECK_IN: work type / place / kind / address → SERVICE_CASE_DETAILS_FIXED (B1)",
    (await changeDetails(A, d3, { workType: "INSPECTION" })).includes("SERVICE_CASE_DETAILS_FIXED")
      && (await changeDetails(A, d3, { kind: "MAINTENANCE" })).includes("SERVICE_CASE_DETAILS_FIXED")
      && (await changeDetails(A, d3, { siteAddress: "כתובת אחרת" })).includes("SERVICE_CASE_DETAILS_FIXED"));
  ok("D15 … even by a bare UPDATE with no journal at all", (await rt(A.b, [`UPDATE "ServiceCase" SET "workType" = 'INSPECTION' WHERE id = $1`, d3])).includes("SERVICE_CASE_DETAILS_FIXED"));
  ok("D16 site notes are not a D3 detail: editable after CHECK_IN", (await rt(A.b, [`UPDATE "ServiceCase" SET "siteNotes" = 'קוד שער 1234' WHERE id = $1`, d3])) === "OK");

  const d4 = await open(A, "IN_SHOP");
  await step(A, d4, `"coverageSource" = 'STORE', "coverageDecision" = 'PENDING'`, "RECORD_COVERAGE", "coverage.recorded", "OPEN");
  ok("D17 a recorded cover (blocker 5) fixes the details", (await changeDetails(A, d4, { workType: "INSPECTION" })).includes("SERVICE_CASE_DETAILS_FIXED"));
  const d5 = await open(A, "IN_SHOP");
  ok("D18 an UNSIGNED intake started at the business (D12): the work type may change …",
    (await rt(A.b, [`INSERT INTO "ServiceCaseIntake" ("businessId", "caseId") VALUES ($1, $2)`, A.b, d5])) === "OK"
      && (await changeDetails(A, d5, { workType: "INSPECTION" })) === "OK");
  ok("D19 … but the case cannot leave AT_BUSINESS", (await changeDetails(A, d5, { kind: "FIELD", serviceLocation: "AT_CUSTOMER" })).includes("cannot leave AT_BUSINESS"));
  const d6 = await open(A, "IN_SHOP");
  ok("D20 a signed intake written earlier in the SAME transaction (B5) fixes everything",
    (await changeDetails(A, d6, { workType: "INSPECTION" }, { extra: [[`INSERT INTO "ServiceCaseIntake" ("businessId", "caseId", "customerSigned", "signedAt") VALUES ($1, $2, true, now())`, A.b, d6]] }))
      .includes("SERVICE_CASE_DETAILS_FIXED"));

  // D14: a case opened with its profile snapshot (inserted directly with its opening event, as the stage-3 code will)
  const openWithProfile = (z: Biz, n: number, pk: string | null, snap: string | null): Stmt[] => [
    [`INSERT INTO "ServiceCase" ("businessId", "caseNumber", kind, "customerId", "problemDescription", "workType", "serviceLocation", "profileKey", "profileSnapshot")
      VALUES ($1, $2, 'FIELD', $3, 'התקנה', 'INSTALLATION', 'AT_CUSTOMER', $4, $5::jsonb)`, z.b, n, z.cust, pk, snap],
    [`INSERT INTO "ServiceCaseEvent" ("businessId", "caseId", seq, "eventType", action, "toStatus", "cancellationRequestedBefore", "cancellationRequestedAfter", actor, "actorUserId", "idempotencyKey")
      VALUES ($1, currval(pg_get_serial_sequence('"ServiceCase"', 'id')), 1, 'case.opened', 'OPEN', 'OPEN', false, false, 'OWNER_USER', $2, $3)`, z.b, z.u, key()]];
  ok("D21 a key without its snapshot → ServiceCase_profile_snapshot", (await rt(A.b, ...openWithProfile(A, 900001, "installer", null))).includes("profile_snapshot"));
  ok("D22 a case opened with profileKey + profileSnapshot → written", (await rt(A.b, ...openWithProfile(A, 900002, "installer", `{"rows":{"T4":{"qa":"REQUIRED"}}}`))) === "OK");
  const d7 = Number((await own(A.b, `SELECT id FROM "ServiceCase" WHERE "businessId" = $1 AND "caseNumber" = 900002`, A.b))[0].id);
  ok("D23 the snapshot never changes (also not NULL → value on a legacy case) → SERVICE_CASE_PROFILE_FIXED",
    (await rt(A.b, [`UPDATE "ServiceCase" SET "profileSnapshot" = '{}' WHERE id = $1`, d7])).includes("SERVICE_CASE_PROFILE_FIXED")
      && (await rt(A.b, [`UPDATE "ServiceCase" SET "profileKey" = 'general', "profileSnapshot" = '{}' WHERE id = $1`, d5])).includes("SERVICE_CASE_PROFILE_FIXED"));

  ok("D24 the detail history is never updated or deleted by the runtime role",
    (await rt(A.b, [`UPDATE "ServiceCaseDetailChange" SET reason = 'x' WHERE "caseId" = $1`, d1])) !== "OK"
      && (await rt(A.b, [`DELETE FROM "ServiceCaseDetailChange" WHERE "caseId" = $1`, d1])) !== "OK");
  let dcOwner = "OK";
  try { await own(A.b, `UPDATE "ServiceCaseDetailChange" SET reason = 'x' WHERE "caseId" = $1 RETURNING id`, d1); } catch (e) { dcOwner = err(e); }
  let dcTrunc = "OK";
  try { await x(`TRUNCATE "ServiceCaseDetailChange"`); } catch (e) { dcTrunc = err(e); }
  ok("D25 … nor by the table owner (SERVICE_DETAIL_CHANGE_APPEND_ONLY), and never truncated", dcOwner.includes("SERVICE_DETAIL_CHANGE_APPEND_ONLY") && dcTrunc !== "OK", `${dcOwner} / ${dcTrunc}`);
  ok("D26 a detail row by another business's user → SERVICE_USER_OTHER_BUSINESS",
    (await rt(A.b, [`INSERT INTO "ServiceCaseDetailChange" ("businessId", "caseId", "caseVersion", "changedFields", "kindBefore", "kindAfter", "actorUserId")
       VALUES ($1, $2, 2, ARRAY['kind'], 'IN_SHOP', 'FIELD', $3)`, A.b, d1, B.u])).includes("SERVICE_USER_OTHER_BUSINESS"));

  console.log("O — WORK_DONE, COMPLETED, COMPLETE");
  const o1 = await open(A, "FIELD");
  await changeDetails(A, o1, { workType: "INSTALLATION", serviceLocation: "FIELD_SITE", siteAddress: "אתר בנייה סינתטי" });
  ok("O1 WORK_DONE without an outcome → ServiceCase_outcome_by_status_v2", (await step(A, o1, "", "FINISH_REPAIR", "repair.finished", "WORK_DONE")).includes("outcome_by_status_v2"));
  ok("O2 WORK_DONE with outcome COMPLETED (INSTALLATION) → written", (await step(A, o1, `outcome = 'COMPLETED'`, "FINISH_REPAIR", "repair.finished", "WORK_DONE", "COMPLETED")) === "OK");
  const o2 = await open(A, "FIELD");
  await changeDetails(A, o2, { workType: "REPAIR", serviceLocation: "AT_CUSTOMER" });
  ok("O3 COMPLETED on a REPAIR case → ServiceCase_completed_not_repair; REPAIRED → written",
    (await step(A, o2, `outcome = 'COMPLETED'`, "FINISH_REPAIR", "repair.finished", "WORK_DONE", "COMPLETED")).includes("completed_not_repair")
      && (await step(A, o2, `outcome = 'REPAIRED'`, "FINISH_REPAIR", "repair.finished", "WORK_DONE", "REPAIRED")) === "OK");
  ok("O4 an outcome outside the outcome statuses is still refused (OPEN + REPAIRED)", (await rt(A.b, [`UPDATE "ServiceCase" SET outcome = 'REPAIRED' WHERE id = $1`, d1])).includes("outcome_by_status_v2"));
  ok("O5 a completion stamp on a case that is not CLOSED → ServiceCase_completion_stamp",
    (await rt(A.b, [`UPDATE "ServiceCase" SET "completionType" = 'OWNER_CONFIRMED_ON_SITE', "completedAt" = now() WHERE id = $1`, o1])).includes("completion_stamp"));
  ok("O6 the confirmation place must be the work's place (FIELD_SITE completed as REMOTE / AT_BUSINESS) → ServiceCase_completion_place",
    (await complete(A, o1, "OWNER_CONFIRMED_REMOTE")).includes("completion_place") && (await complete(A, o1, "OWNER_CONFIRMED_AT_BUSINESS")).includes("completion_place"));
  ok("O7 CLOSED with a completion stamp but no completion record → SERVICE_COMPLETION_MISSING at COMMIT",
    (await complete(A, o1, "OWNER_CONFIRMED_ON_SITE", { noRecord: true })).includes("SERVICE_COMPLETION_MISSING"));
  ok("O8 a completion record of another type than the case's → refused at COMMIT",
    (await complete(A, o1, "OWNER_CONFIRMED_ON_SITE", { recordType: "OWNER_CONFIRMED_REMOTE" })).startsWith("ERR"));
  ok("O9 a completion record for a case that is not WORK_DONE (OPEN) → SERVICE_COMPLETION_NOT_WORK_DONE",
    (await rt(A.b, completion(A, d1, "OWNER_CONFIRMED_ON_SITE"))).includes("SERVICE_COMPLETION_NOT_WORK_DONE"));
  ok("O10 a completion confirmed by another business's user, or by no user → refused",
    (await rt(A.b, completion(A, o1, "OWNER_CONFIRMED_ON_SITE", B.u))).includes("SERVICE_USER_OTHER_BUSINESS")
      && (await rt(A.b, completion(A, o1, "OWNER_CONFIRMED_ON_SITE", null))).includes("SERVICE_COMPLETION_NEW"));
  ok("O11 COMPLETE: WORK_DONE → CLOSED + stamp + record + case.completed → written", (await complete(A, o1, "OWNER_CONFIRMED_ON_SITE")) === "OK");
  ok("O12 one completion per case (a second record → 23505 / refused)", (await rt(A.b, completion(A, o1, "OWNER_CONFIRMED_ON_SITE"))).startsWith("ERR"));
  ok("O13 the completion stamp is written once", (await rt(A.b, [`UPDATE "ServiceCase" SET "completedAt" = now() + interval '1 day' WHERE id = $1`, o1])).includes("SERVICE_CASE_COMPLETION_WRITE_ONCE"));
  ok("O14 the record is never updated or deleted by the runtime role",
    (await rt(A.b, [`UPDATE "ServiceCompletion" SET note = 'x' WHERE "caseId" = $1`, o1])) !== "OK"
      && (await rt(A.b, [`DELETE FROM "ServiceCompletion" WHERE "caseId" = $1`, o1])) !== "OK");
  let cOwner = "OK";
  try { await own(A.b, `UPDATE "ServiceCompletion" SET note = 'x' WHERE "caseId" = $1 RETURNING id`, o1); } catch (e) { cOwner = err(e); }
  let cTrunc = "OK";
  try { await x(`TRUNCATE "ServiceCompletion"`); } catch (e) { cTrunc = err(e); }
  ok("O15 … nor by the table owner (SERVICE_COMPLETION_FIXED), and never truncated", cOwner.includes("SERVICE_COMPLETION_FIXED") && cTrunc !== "OK", `${cOwner} / ${cTrunc}`);
  const sigCols = await q(`SELECT column_name FROM information_schema.columns WHERE table_name = 'ServiceCompletion'
      AND column_name IN ('signatureCaptured', 'signatureKey', 'confirmationChannel', 'signedAt')`);
  ok("O16 no signature columns exist on ServiceCompletion (owner decision 2026-11-11)", sigCols.length === 0, JSON.stringify(sigCols));
  // Owner decision 2026-11-11: closing with an open debt — explicit approval (reason + approving user + time), the
  // balance and an overpayment stored, never an unknown balance. On o1 (already completed): a row that passes every rule
  // is refused ONLY by the one-per-case key, so each probe isolates one rule.
  const onlyKey = (s: string) => s.includes("23505") || s.includes("Unique") || s.includes("unique");
  const probe = (bal: Bal, user: number | null = A.u) => rt(A.b, completion(A, o1, "OWNER_CONFIRMED_ON_SITE", user, bal));
  const debtOk: Bal = { open: 5000, reason: "לקוח קבוע", approver: A.u, approvedAt: true };
  const noBalance = await probe({ omitBalance: true });
  ok("O16b no stated balance (an UNKNOWN balance has no representation: NOT NULL, no default) → refused",
    noBalance.includes("openBalanceAgorot") && (noBalance.includes("23502") || noBalance.toLowerCase().includes("null")), noBalance);
  const noReason = await probe({ ...debtOk, reason: null });
  const withAll = await probe(debtOk);
  ok("O16c an open debt without the owner's reason → ServiceCompletion_debt_decided; with reason + approver + time only the one-per-case key refuses",
    noReason.includes("ServiceCompletion_debt_decided") && onlyKey(withAll) && !withAll.includes("debt_decided"), noReason + " | " + withAll);
  const noTime = await probe({ ...debtOk, approvedAt: false });
  ok("O16d an open debt without the approval time → ServiceCompletion_debt_decided", noTime.includes("ServiceCompletion_debt_decided"), noTime);
  const noApprover = await probe({ ...debtOk, approver: null });
  const otherApprover = await probe({ ...debtOk, approver: B.u });
  // actor = approver = a user of ANOTHER business: approver = actor holds, so the same-business trigger is what refuses
  const otherActor = await probe({ ...debtOk, approver: B.u }, B.u);
  ok("O16e an open debt without the approving user → SERVICE_COMPLETION_DEBT_UNAPPROVED; an approver of another business → SERVICE_APPROVER_NOT_ACTOR; actor + approver of another business → SERVICE_USER_OTHER_BUSINESS",
    noApprover.includes("SERVICE_COMPLETION_DEBT_UNAPPROVED") && otherApprover.includes("SERVICE_APPROVER_NOT_ACTOR")
      && otherActor.includes("SERVICE_USER_OTHER_BUSINESS"), [noApprover, otherApprover, otherActor].join(" | "));
  const negOpen = await probe({ open: -100 });
  const negOver = await probe({ over: -1 });
  const bothSides = await probe({ ...debtOk, over: 200 });
  const overOnly = await probe({ over: 1500 });
  ok("O16f a negative balance or overpayment, or a debt AND an overpayment together → ServiceCompletion_balance; an overpayment alone passes (only the key refuses)",
    negOpen.includes("ServiceCompletion_balance") && negOver.includes("ServiceCompletion_balance") && bothSides.includes("ServiceCompletion_balance") && onlyKey(overOnly),
    [negOpen, negOver, bothSides, overOnly].join(" | "));
  const strayReason = await probe({ reason: "סתם" });
  const strayApprover = await probe({ approver: A.u });
  const strayTime = await probe({ approvedAt: true });
  ok("O16g no debt → no reason, no approver, no approval time (ServiceCompletion_debt_decided)",
    [strayReason, strayApprover, strayTime].every((s) => s.includes("ServiceCompletion_debt_decided")), [strayReason, strayApprover, strayTime].join(" | "));
  // End to end (owner decision 2026-11-12 — the approver is the authenticated user who performed the action, until an
  // independent approval mechanism exists): a debt "approved" by a SECOND user of the business while the owner acts is
  // refused and nothing of the COMPLETE is written; the same second user acting AND approving closes it; an overpaid case.
  const approver = Number((await q(`INSERT INTO "User" (email, "businessId", "updatedAt") VALUES ($1, $2, now()) RETURNING id`, `sdm1-approver-${t}@lab.invalid`, A.b))[0].id);
  const toWorkDone = async (id: number) => {
    await changeDetails(A, id, { workType: "INSTALLATION", serviceLocation: "FIELD_SITE", siteAddress: "אתר סינתטי 3" });
    return step(A, id, `outcome = 'COMPLETED'`, "FINISH_REPAIR", "repair.finished", "WORK_DONE", "COMPLETED");
  };
  const o3 = await open(A, "FIELD");
  const o4 = await open(A, "FIELD");
  const o3debt: Bal = { open: 7000, reason: "ישלם בסוף החודש", approver, approvedAt: true };
  const o3wd = (await toWorkDone(o3)) === "OK";
  const o3v = (await row(A, o3)).version;
  const byOther = await complete(A, o3, "OWNER_CONFIRMED_ON_SITE", { bal: o3debt });
  const afterRefusal = await row(A, o3);
  const noRecord = await own(A.b, `SELECT count(*)::int n FROM "ServiceCompletion" WHERE "caseId" = $1`, o3);
  const asApprover = { ...A, u: approver, p: { businessId: A.b, userId: approver } as ServiceDeskPrincipal };
  const o3done = o3wd && (await complete(asApprover, o3, "OWNER_CONFIRMED_ON_SITE", { bal: o3debt })) === "OK";
  const o4done = (await toWorkDone(o4)) === "OK" && (await complete(A, o4, "OWNER_CONFIRMED_ON_SITE", { bal: { over: 1500 } })) === "OK";
  const rec = await own(A.b, `SELECT "caseId", "openBalanceAgorot" o, "overpaidAgorot" v, "debtOverrideReason" r, "debtApprovedByUserId" a, "actorUserId" u,
      ("debtApprovedAt" IS NOT NULL AND "debtApprovedAt" <= "completedAt") t FROM "ServiceCompletion" WHERE "caseId" IN ($1, $2) ORDER BY "caseId"`, o3, o4);
  ok("O16h COMPLETE with a debt approved by a SECOND user while the owner acts → SERVICE_APPROVER_NOT_ACTOR, nothing written (case still WORK_DONE at its version, no record); the same user acting AND approving → written; COMPLETE with an overpayment → written; the records hold the balance, reason, approver = actor, time and the overpayment",
    o3wd && byOther.includes("SERVICE_APPROVER_NOT_ACTOR") && afterRefusal.status === "WORK_DONE" && afterRefusal.version === o3v && Number(noRecord[0].n) === 0
      && o3done && o4done && rec.length === 2 && Number(rec[0].o) === 7000 && Number(rec[0].v) === 0 && rec[0].r === "ישלם בסוף החודש"
      && Number(rec[0].a) === approver && Number(rec[0].u) === approver && rec[0].t === true
      && Number(rec[1].o) === 0 && Number(rec[1].v) === 1500 && rec[1].r === null && rec[1].a === null, `${byOther} ${JSON.stringify(afterRefusal)} ${JSON.stringify(rec)}`);
  ok("O16i the approval is part of the permanent record (the runtime cannot rewrite it)",
    (await rt(A.b, [`UPDATE "ServiceCompletion" SET "debtOverrideReason" = 'אחר' WHERE "caseId" = $1`, o3])) !== "OK"
      && (await rt(A.b, [`UPDATE "ServiceCompletion" SET "openBalanceAgorot" = 0, "debtOverrideReason" = NULL, "debtApprovedByUserId" = NULL, "debtApprovedAt" = NULL WHERE "caseId" = $1`, o3])) !== "OK");
  let delOut = "OK";
  try { await x(`DELETE FROM "User" WHERE id = $1`, approver); } catch (e) { delOut = err(e); }
  const afterDel = (await own(A.b, `SELECT "openBalanceAgorot" o, "debtOverrideReason" r, "debtApprovedByUserId" a, "debtApprovedAt" IS NOT NULL t, "actorUserId" u FROM "ServiceCompletion" WHERE "caseId" = $1`, o3))[0];
  ok("O16j a deleted acting approver: the FK sets the approver and the actor (the same user) to NULL and nothing else moves (balance, reason, time kept)",
    delOut === "OK" && afterDel.a === null && afterDel.u === null && Number(afterDel.o) === 7000 && afterDel.r === "ישלם בסוף החודש" && afterDel.t === true, `${delOut} ${JSON.stringify(afterDel)}`);
  const o5 = await open(A, "FIELD");
  ok("O16k a debt approved by the acting owner → written (its approver is scrubbed by the erasure, E3b)",
    (await toWorkDone(o5)) === "OK" && (await complete(A, o5, "OWNER_CONFIRMED_ON_SITE", { bal: { open: 300, reason: "חוב קטן", approver: A.u, approvedAt: true } })) === "OK");
  // the same-business trigger checks at INSERT only (so a deleted actor-approver's FK action works, O16j); after birth
  // the guard alone keeps the people fixed — even the table owner cannot re-point them, to any user
  const repoint = async (u: number) => { try { await own(A.b, `UPDATE "ServiceCompletion" SET "actorUserId" = $2, "debtApprovedByUserId" = $2 WHERE "caseId" = $1`, o5, u); return "OK"; } catch (e) { return err(e); } };
  const toOther = await repoint(B.u);
  const toSame = await repoint(Number((await q(`INSERT INTO "User" (email, "businessId", "updatedAt") VALUES ($1, $2, now()) RETURNING id`, `sdm1-repoint-${t}@lab.invalid`, A.b))[0].id));
  ok("O16l after birth the actor + approver cannot be re-pointed, not even by the table owner (another business's user, or another user of the same business) → SERVICE_COMPLETION_FIXED",
    toOther.includes("SERVICE_COMPLETION_FIXED") && toSame.includes("SERVICE_COMPLETION_FIXED"), toOther + " | " + toSame);
  const o2v = (await row(A, o2)).version;
  ok("O17 a COMPLETE journaled from a status other than WORK_DONE → ServiceCaseEvent_tracks_in_place",
    (await rt(A.b, [`UPDATE "ServiceCase" SET status = 'CLOSED', "closedAt" = now(), "completionType" = 'OWNER_CONFIRMED_ON_SITE', "completedAt" = now(), version = version + 1 WHERE id = $1`, o2],
      completion(A, o2, "OWNER_CONFIRMED_ON_SITE"), ev(A, o2, o2v + 1, "case.completed", "COMPLETE", "IN_REPAIR", "CLOSED", "REPAIRED"))).includes("tracks_in_place"));
  const d1v = (await row(A, d1)).version;
  ok("O18 an action paired with another action's event type (CHANGE_DETAILS + case.rescheduled) → ServiceCaseEvent_tracks_in_place",
    (await rt(A.b, [`UPDATE "ServiceCase" SET version = version + 1 WHERE id = $1`, d1], ev(A, d1, d1v + 1, "case.rescheduled", "CHANGE_DETAILS", "OPEN", "OPEN"))).includes("tracks_in_place"));
  ok("O19 a CLOSED case's details are fixed", (await changeDetails(A, o1, { workType: "INSPECTION" })).includes("SERVICE_CASE_DETAILS_FIXED"));

  console.log("S — settings");
  ok("S1 serviceProfileKey 'garage' with overrides → written",
    (await rt(A.b, [`INSERT INTO "ServiceSettings" ("businessId", version, "updatedAt", "serviceProfileKey", "profileOverrides") VALUES ($1, 1, now(), 'garage', '{"terms":{"case":"כרטיס"}}')`, A.b])) === "OK");
  ok("S2 an unknown profile key → ServiceSettings_profile; overrides not an object → ServiceSettings_profile",
    (await rt(A.b, [`UPDATE "ServiceSettings" SET "serviceProfileKey" = 'bakery', version = version + 1 WHERE "businessId" = $1`, A.b])).includes("ServiceSettings_profile")
      && (await rt(A.b, [`UPDATE "ServiceSettings" SET "profileOverrides" = '[]', version = version + 1 WHERE "businessId" = $1`, A.b])).includes("ServiceSettings_profile"));
  const sev = (fields: string[]): Stmt => [`INSERT INTO "ServiceSettingsEvent" ("businessId", "settingsVersion", "changedFields", actor, "actorUserId", "idempotencyKey")
    VALUES ($1, 1, $2::text[], 'OWNER_USER', $3, $4)`, A.b, fields, A.u, key()];
  ok("S3 the settings journal names the new fields; an unknown field name is still refused",
    (await rt(A.b, sev(["serviceProfileKey", "profileOverrides"]))) === "OK" && (await rt(A.b, sev(["bogusField"]))).includes("ServiceSettingsEvent_fields_v2"));

  console.log("V — service subject");
  const dev = (sk: string | null, name: string | null, attrs: string | null): Stmt =>
    [`INSERT INTO "ServiceDevice" ("businessId", "customerId", ${sk ? `"subjectKind", ` : ""}"displayName", attributes) VALUES ($1, $2, ${sk ? `'${sk}', ` : ""}$3, $4::jsonb)`, A.b, A.cust, name, attrs];
  ok("V1 a VEHICLE subject with a name and attributes → written; without a kind it is ITEM",
    (await rt(A.b, dev("VEHICLE", "הרכב של דנה", `{"plate":"12-345-67","km":120000}`))) === "OK" && (await rt(A.b, dev(null, null, null))) === "OK"
      && Number((await own(A.b, `SELECT count(*)::int n FROM "ServiceDevice" WHERE "businessId" = $1 AND "subjectKind" = 'ITEM' AND "displayName" IS NULL AND "customerId" = $2`, A.b, A.cust))[0].n) >= 1);
  ok("V2 attributes that are not an object, or a 201-character name → ServiceDevice_subject_fields",
    (await rt(A.b, dev("SYSTEM", null, `[1,2]`))).includes("subject_fields") && (await rt(A.b, dev("SYSTEM", "ש".repeat(201), null))).includes("subject_fields"));

  console.log("I — isolation");
  const bc = await open(B, "FIELD");
  const seenByB = await rtRows(B.b, `SELECT (SELECT count(*) FROM "ServiceCompletion" WHERE "businessId" = $1)::int c, (SELECT count(*) FROM "ServiceCaseDetailChange" WHERE "businessId" = $1)::int d`, A.b);
  ok("I1 business B reads none of A's completions or detail changes", Number(seenByB[0].c) === 0 && Number(seenByB[0].d) === 0, JSON.stringify(seenByB));
  ok("I2 B cannot write a completion or a detail change into A (RLS / no such case)",
    (await rt(B.b, completion(A, o2, "OWNER_CONFIRMED_ON_SITE"))).startsWith("ERR")
      && (await rt(B.b, [`INSERT INTO "ServiceCaseDetailChange" ("businessId", "caseId", "caseVersion", "changedFields", "kindBefore", "kindAfter", "actorUserId")
           VALUES ($1, $2, 2, ARRAY['kind'], 'IN_SHOP', 'FIELD', $3)`, A.b, d1, B.u])).startsWith("ERR"));
  ok("I3 B cannot change A's case details (invisible under B's context: 0 rows)",
    (await rt(B.b, [`UPDATE "ServiceCase" SET "workType" = 'INSPECTION' WHERE id = $1`, d1])) === "OK" && (await row(A, d1)).workType === "REPAIR");
  void bc;

  console.log("E — erasure");
  const early = await rt(A.b, [`SELECT public.service_tracks_erase_business()`]);
  ok("E1 erasure is refused while the business is not being deleted", early.includes("SERVICE_TRACKS_ERASURE_NOT_DELETING"), early);
  const imitate = await rt(A.b, [`SELECT set_config('dubiz.service_tracks_erasure', 'on', true)`], [`UPDATE "ServiceCase" SET "siteAddress" = NULL WHERE id = $1`, o1]);
  ok("E2 the runtime cannot imitate the scrub by setting the marker itself (a CLOSED case's address stays fixed)", imitate.includes("SERVICE_CASE_DETAILS_FIXED"), imitate);
  await x(`UPDATE "Business" SET "deletionRequestedAt" = now() WHERE id = $1`, A.b);
  let erased = -1;
  let both = "OK";
  try {
    const r = await rtRows(A.b, `SELECT public.service_erase_business() AS f, public.service_tracks_erase_business() AS n`);
    erased = Number(r[0].n);
  } catch (e) { both = err(e); }
  const left = (await own(A.b, `SELECT
      (SELECT count(*) FROM "ServiceCase" WHERE "businessId" = $1 AND ("siteAddress" IS NOT NULL OR "siteNotes" IS NOT NULL OR "originalSaleRef" IS NOT NULL))::int c,
      (SELECT count(*) FROM "ServiceDevice" WHERE "businessId" = $1 AND ("displayName" IS NOT NULL OR attributes IS NOT NULL))::int v,
      (SELECT count(*) FROM "ServiceCompletion" WHERE "businessId" = $1 AND ("confirmedByName" IS NOT NULL OR note IS NOT NULL OR "actorUserId" IS NOT NULL
         OR "debtOverrideReason" IS NOT NULL OR "debtApprovedByUserId" IS NOT NULL OR "erasedAt" IS NULL))::int k,
      (SELECT count(*) FROM "ServiceCaseDetailChange" WHERE "businessId" = $1 AND (reason IS NOT NULL OR "actorUserId" IS NOT NULL OR "siteAddressBefore" IS NOT NULL OR "siteAddressAfter" IS NOT NULL OR "erasedAt" IS NULL))::int d,
      (SELECT count(*) FROM "ServiceCaseDetailChange" WHERE "businessId" = $1)::int dn,
      (SELECT count(*) FROM "ServiceCase" WHERE "businessId" = $1 AND "workType" IS NOT NULL)::int kept,
      (SELECT "completionType"::text FROM "ServiceCase" WHERE id = $2) ct`, A.b, o1))[0];
  ok("E3 with the foundation erasure in one transaction: addresses, notes, sale refs, subject names / attributes, completion and detail personal fields blanked; work types, completion type and the detail rows kept",
    both === "OK" && erased > 0 && Number(left.c) === 0 && Number(left.v) === 0 && Number(left.k) === 0 && Number(left.d) === 0
      && Number(left.dn) >= 6 && Number(left.kept) >= 6 && left.ct === "OWNER_CONFIRMED_ON_SITE", `${both} ${erased} ${JSON.stringify(left)}`);
  const debtKept = await own(A.b, `SELECT "caseId", "openBalanceAgorot" o, "overpaidAgorot" v, "debtApprovedAt" IS NOT NULL t, "debtOverrideReason" r, "debtApprovedByUserId" a
      FROM "ServiceCompletion" WHERE "caseId" IN ($1, $2, $3) ORDER BY "caseId"`, o3, o4, o5);
  ok("E3b the erasure clears the debt reason and the approver (o5: approved by a live user) and keeps the balance, the overpayment and the approval time (ServiceCompletion_debt_decided still holds)",
    debtKept.length === 3 && debtKept.every((r) => r.r === null && r.a === null)
      && Number(debtKept[0].o) === 7000 && debtKept[0].t === true && Number(debtKept[1].v) === 1500 && debtKept[1].t === false
      && Number(debtKept[2].o) === 300 && debtKept[2].t === true, JSON.stringify(debtKept));
  const again = Number((await rtRows(A.b, `SELECT public.service_tracks_erase_business() AS n`))[0].n);
  ok("E4 re-run safe (0 rows the second time)", again === 0, String(again));
  ok("E5 nothing new is written for a business being deleted",
    (await rt(A.b, completion(A, o2, "OWNER_CONFIRMED_ON_SITE"))).includes("SERVICE_UI_BUSINESS_DELETING"));
  const bLeft = await own(B.b, `SELECT count(*)::int n FROM "ServiceCase" WHERE "businessId" = $1 AND "erasedAt" IS NULL`, B.b);
  ok("E6 another business is untouched", Number(bLeft[0].n) === 1);

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length > 0) process.exitCode = 1;
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(async () => { await owner.$disconnect(); await runtime.$disconnect(); });
