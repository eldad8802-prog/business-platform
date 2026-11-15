/**
 * Service Desk 1.3a — the data service and its access gate, AS the real runtime role, on the 1.3-0 lab
 * (.sd3/lab.sh <db> --with-sd3: 1.2a + 1.2b + M2 + 1.3-0 applied by migrate deploy), real local storage. Synthetic only.
 *
 *   F  access modes from the real flag rows: not launched (GLOBAL_DEFAULT) → NONE even with cases; per-business ENABLED →
 *      FULL; BUSINESS_DISABLED + cases (launched) → READ_ONLY; without cases → NONE; global OFF + BUSINESS_DISABLED →
 *      NONE; emergency → NONE; the edge: READ_ONLY reads pass, writes 403 before any work.
 *   C  opening: number, version 1, event seq 1 with the actor; replay; same key + other body; stale / malformed key;
 *      a customer of another business; a device of another customer.
 *   T  transitions through the core and the guards: owner without a technician (diagnosis, on-site check-in); version
 *      conflict; coverage needed for a repair; holds; finish → READY; QA refused without its checklist; out-of-scope
 *      actions; "not collected" needs a reminder; cancel stamps and the reason stays out of the journal payload;
 *      IN_SHOP check-in refused without a stored signature (1.3b) — and accepted once the object exists.
 *   S  technician: without the P4 audit journal the journaled command is refused (NOT_AVAILABLE_UNTIL_AUDIT), nothing
 *      written; the lab assigns as the owner; an inactive assigned technician is refused at diagnosis. (P4 records:
 *      .sd3p4/records-battery.ts.)
 *   I  isolation: another business cannot read, list, see the journal of, or act on a case.
 *   K  races: two actions at one version → one wins; one key five times at once → one event; 20 parallel openings →
 *      20 distinct contiguous numbers.
 *   ST settings: without the P4 audit journal a save is refused, nothing written; the lab seeds them as the owner; the
 *      default technician on a new case.
 *   W  repeat warranty from the parent's LOCKED offer end date; no locked offer → "not recorded"; foreign parent refused.
 *
 * env: OWNER_URL (lab owner), DATABASE_URL = DIRECT_URL (app_runtime_prod), STORAGE_PROVIDER=local, LOCAL_STORAGE_ROOT,
 *      TASK_REQUEST_HMAC_KEY / _ID, AUTH_TOKEN_SECRET.
 */
import { PrismaClient } from "@prisma/client";

import { uuidV7 } from "../lib/services/tasks/task-idempotency";
import { resolveServiceDeskMode } from "../lib/services/service-desk/service-desk-gate";
import { serviceDeskRoute } from "../lib/services/service-desk/service-desk-http";
import { ServiceDeskError } from "../lib/services/service-desk/service-desk-errors";
import {
  assignTechnician, getCase, getSettings, listCaseEvents, listCases, openCase, recordIntake, runCaseAction, updateSettings,
  type ServiceDeskPrincipal,
} from "../lib/services/service-desk/service-case.service";

const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });
let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); } else { failures.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}
// P4 PR-2: the technician / intake / QA / settings commands are journaled and need migration 20261122090000. This
// battery runs on the 1.3-0 lab (journal absent: the commands must refuse with no write) and as the P4 workflow's
// regression with the journal applied (there the records battery .sd3p4/records-battery.ts proves them); the
// absent-journal checks are skipped — and NOT counted — when the journal is present.
let journalPresent = false;
async function absent(name: string, cond: () => Promise<boolean>) {
  if (journalPresent) { console.log(`  [SKIP] ${name} — the audit journal is applied here (see .sd3p4/records-battery.ts)`); return; }
  ok(name, await cond());
}
type Rows = Record<string, unknown>[];
const q = (sql: string, ...a: unknown[]) => owner.$queryRawUnsafe(sql, ...a) as Promise<Rows>;
const x = (sql: string, ...a: unknown[]) => owner.$executeRawUnsafe(sql, ...a);
const n = async (sql: string, ...a: unknown[]) => Number((await q(sql, ...a))[0]?.n);
const key = (at = new Date()) => uuidV7(at);
async function code(fn: () => Promise<unknown>): Promise<string> {
  try { await fn(); return "OK"; } catch (e) {
    if (e instanceof ServiceDeskError) return `${e.code}${e.details && Object.keys(e.details).length ? ":" + JSON.stringify(e.details) : ""}`;
    return `ERR:${(e as Error).message.slice(0, 160)}`;
  }
}
const t = Date.now();
async function business(tag: string) {
  const b = Number((await q(`INSERT INTO "Business" (name, "updatedAt") VALUES ($1, now()) RETURNING id`, `sd3a-${tag}-${t}`))[0].id);
  const u = Number((await q(`INSERT INTO "User" (email, "businessId", "updatedAt") VALUES ($1, $2, now()) RETURNING id`, `sd3a-${tag}-${t}@lab.invalid`, b))[0].id);
  const cust = Number((await q(`INSERT INTO "Customer" ("businessId", name, "updatedAt") VALUES ($1, 'לקוח סינתטי', now()) RETURNING id`, b))[0].id);
  const cust2 = Number((await q(`INSERT INTO "Customer" ("businessId", name, "updatedAt") VALUES ($1, 'לקוח נוסף', now()) RETURNING id`, b))[0].id);
  const staff = Number((await q(`INSERT INTO "StaffMember" ("businessId", "displayName", "updatedAt") VALUES ($1, 'טכנאי', now()) RETURNING id`, b))[0].id);
  const device = Number((await q(`INSERT INTO "ServiceDevice" ("businessId", "customerId", category, "updatedAt") VALUES ($1, $2, 'PHONE', now()) RETURNING id`, b, cust))[0].id);
  return { b, u, cust, cust2, staff, device, p: { businessId: b, userId: u } as ServiceDeskPrincipal };
}
type Biz = Awaited<ReturnType<typeof business>>;
const setPolicy = (globalEnabled: boolean, emergencyDisabled = false) =>
  x(`UPDATE "PlatformFeaturePolicy" SET "globalEnabled" = $1, "emergencyDisabled" = $2, "updatedAt" = now() WHERE "featureKey" = 'service_desk'`, globalEnabled, emergencyDisabled);
const setOverride = async (b: number, state: "ENABLED" | "DISABLED" | null) => {
  await x(`DELETE FROM "BusinessFeatureAccess" WHERE "businessId" = $1 AND "featureKey" = 'service_desk'`, b);
  if (state) await x(`INSERT INTO "BusinessFeatureAccess" ("businessId", "featureKey", state, reason, "updatedAt") VALUES ($1, 'service_desk', $2::"BusinessFeatureAccessState", 'sd3a lab', now())`, b, state);
};
const open = (z: Biz, kind = "FIELD", extra: Record<string, unknown> = {}, k = key()) => openCase(z.p, { kind, customerId: z.cust, problemDescription: "תקלה סינתטית", ...extra }, { idempotencyKey: k });
const act = (z: Biz, id: number, action: Record<string, unknown>, expectedVersion: number, k = key()) => runCaseAction(z.p, id, { action, expectedVersion }, { idempotencyKey: k });
const events = (b: number, id: number) => n(`SELECT count(*)::int AS n FROM "ServiceCaseEvent" WHERE "businessId" = $1 AND "caseId" = $2`, b, id);

async function main() {
  journalPresent = (await q(`SELECT to_regclass('public."ServiceSettingsEvent"') IS NOT NULL AND EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'qa.recorded') r`))[0].r === true;
  console.log(`audit journal (P4) ${journalPresent ? "PRESENT" : "absent"}`);
  const A = await business("a"), B = await business("b"), C = await business("c");
  const sdPolicy = (await q(`SELECT "globalEnabled" g, "emergencyDisabled" e FROM "PlatformFeaturePolicy" WHERE "featureKey" = 'service_desk'`))[0];
  ok("setup: the lab carries the service_desk policy seeded OFF by 1.3-0", sdPolicy?.g === false && sdPolicy?.e === false, JSON.stringify(sdPolicy));

  console.log("C — opening");
  const k1 = key();
  const o1 = await open(A, "FIELD", { problemDescription: "המזגן לא מקרר" }, k1);
  ok("C1 a case opens at OPEN, version 1, number 1; the event is seq 1 with the acting user", o1.case.status === "OPEN" && o1.case.version === 1 && o1.case.caseNumber === 1 && o1.event.seq === 1 && !o1.replayed
    && Number((await q(`SELECT "actorUserId" a FROM "ServiceCaseEvent" WHERE "caseId" = $1 AND seq = 1`, o1.case.id))[0].a) === A.u);
  const r1 = await open(A, "FIELD", { problemDescription: "המזגן לא מקרר" }, k1);
  ok("C2 the same key + same request → the stored result (replayed), still one event", r1.replayed && r1.case.id === o1.case.id && (await events(A.b, o1.case.id)) === 1);
  ok("C3 the same key + another request → IDEMPOTENCY_KEY_REUSED", (await code(() => open(A, "IN_SHOP", {}, k1))) === "IDEMPOTENCY_KEY_REUSED");
  ok("C4 a key older than 24 h → IDEMPOTENCY_KEY_STALE; a malformed key → IDEMPOTENCY_KEY_INVALID",
    (await code(() => open(A, "FIELD", {}, key(new Date(Date.now() - 25 * 3600_000))))) === "IDEMPOTENCY_KEY_STALE"
    && (await code(() => open(A, "FIELD", {}, "not-a-uuid-key"))) === "IDEMPOTENCY_KEY_INVALID");
  ok("C5 a customer of another business → refused (never opened)", (await code(() => openCase(A.p, { kind: "FIELD", customerId: B.cust, problemDescription: "תקלה" }, { idempotencyKey: key() }))).startsWith("SERVER_CHECK_FAILED"));
  ok("C6 a device of another customer → refused", (await code(() => openCase(A.p, { kind: "IN_SHOP", customerId: A.cust2, deviceId: A.device, problemDescription: "תקלה" }, { idempotencyKey: key() }))).startsWith("SERVER_CHECK_FAILED"));
  ok("C7 an unknown kind → refused", (await code(() => openCase(A.p, { kind: "HOME", customerId: A.cust, problemDescription: "תקלה" }, { idempotencyKey: key() }))).startsWith("REFUSED"));

  ok("C8 no problem description → INVALID_INPUT (the database requires one)", (await code(() => openCase(A.p, { kind: "FIELD", customerId: A.cust }, { idempotencyKey: key() }))).startsWith("INVALID_INPUT"));

  console.log("T — transitions");
  const id = o1.case.id;
  const ci = await act(A, id, { type: "CHECK_IN" }, 1);
  ok("T1 on-site check-in with no technician → CHECKED_IN v2 (the owner handles it)", ci.case.status === "CHECKED_IN" && ci.case.version === 2
    && (await q(`SELECT payload->>'handledByOwner' h, "actorUserId" a FROM "ServiceCaseEvent" WHERE "caseId" = $1 AND seq = 2`, id))[0].h === "true");
  const dg = await act(A, id, { type: "START_DIAGNOSIS" }, 2);
  ok("T2 diagnosis with no technician → DIAGNOSING (owner decision 2)", dg.case.status === "DIAGNOSING" && dg.case.version === 3);
  ok("T3 a stale expectedVersion → VERSION_CONFLICT, no event written", (await code(() => act(A, id, { type: "START_REPAIR" }, 2))) === "VERSION_CONFLICT" && (await events(A.b, id)) === 3);
  ok("T4 a repair without an approved quote or cover → REFUSED COVERAGE_NOT_APPROVED", (await code(() => act(A, id, { type: "START_REPAIR" }, 3))).includes("COVERAGE_NOT_APPROVED"));
  await x(`UPDATE "ServiceCase" SET "coverageSource" = 'MANUFACTURER', "coverageDecision" = 'APPROVED' WHERE id = $1`, id); // lab: a cover (no 1.3a command records one)
  const sr = await act(A, id, { type: "START_REPAIR" }, 3);
  const hold = await act(A, id, { type: "SET_HOLD", reason: "PARTS" }, sr.case.version);
  ok("T5 with an approved cover: repair starts; a hold is set in place", sr.case.status === "IN_REPAIR" && hold.case.status === "IN_REPAIR" && hold.case.holdReason === "PARTS");
  const clr = await act(A, id, { type: "CLEAR_HOLD" }, hold.case.version);
  const fin = await act(A, id, { type: "FINISH_REPAIR", outcome: "REPAIRED" }, clr.case.version);
  ok("T6 hold cleared; an on-site repair finishes → READY / REPAIRED, readyAt stamped", fin.case.status === "READY" && fin.case.outcome === "REPAIRED"
    && (await q(`SELECT "readyAt" IS NOT NULL r FROM "ServiceCase" WHERE id = $1`, id))[0].r === true);
  ok("T7 out of scope → ACTION_NOT_IN_SCOPE (SCHEDULE, SEND_QUOTE, DELIVER, REPLACED)",
    (await code(() => act(A, id, { type: "SCHEDULE", appointmentId: 1 }, fin.case.version))).startsWith("ACTION_NOT_IN_SCOPE")
    && (await code(() => act(A, id, { type: "SEND_QUOTE", quote: { version: 1, totalAgorot: 100, docHash: "h" } }, fin.case.version))).startsWith("ACTION_NOT_IN_SCOPE")
    && (await code(() => act(A, id, { type: "DELIVER" }, fin.case.version))).startsWith("ACTION_NOT_IN_SCOPE")
    && (await code(() => act(A, id, { type: "FINISH_REPAIR", outcome: "REPLACED" }, fin.case.version))).startsWith("ACTION_NOT_IN_SCOPE"));
  ok("T8 'not collected' without a documented reminder → REFUSED PICKUP_REMINDERS_REQUIRED", (await code(() => act(A, id, { type: "ABANDON", reason: "לא הגיע" }, fin.case.version))).includes("PICKUP_REMINDERS_REQUIRED"));
  const o2 = await open(A, "FIELD");
  const cx = await act(A, o2.case.id, { type: "CANCEL", reason: "הלקוח ביטל — דנה 050" }, 1);
  const cxRow = (await q(`SELECT "cancelledAt" IS NOT NULL s, "cancelReason" r FROM "ServiceCase" WHERE id = $1`, o2.case.id))[0];
  const cxEv = (await q(`SELECT payload::text p FROM "ServiceCaseEvent" WHERE "caseId" = $1 AND seq = 2`, o2.case.id))[0];
  ok("T9 cancel → CANCELLED, cancelledAt stamped, the reason in its column only — never in the journal payload",
    cx.case.status === "CANCELLED" && cxRow.s === true && cxRow.r === "הלקוח ביטל — דנה 050" && !String(cxEv.p).includes("דנה"));
  ok("T10 a CANCELLED case takes no further action (TERMINAL_STATUS)", (await code(() => act(A, o2.case.id, { type: "CHECK_IN" }, 2))).includes("TERMINAL_STATUS"));
  // IN_SHOP: intake data, then check-in needs a STORED signature (1.3b writes it; here the lab simulates one)
  const s1 = await open(A, "IN_SHOP", { deviceId: A.device });
  // P4 PR-2: recording intake is journaled and needs the audit journal migration, which this lab (1.3-0 only) lacks →
  // the command is refused with no write; the lab writes the intake row as the owner instead.
  await absent("T11 without the audit journal: intake → NOT_AVAILABLE_UNTIL_AUDIT, no intake row written", async () =>
    (await code(() => recordIntake(A.p, s1.case.id, { conditionNote: "שריטה בפינה", accessoriesNote: "מטען", conditionRecorded: true, accessoriesRecorded: true, expectedVersion: 1 }, { idempotencyKey: key() }))) === "NOT_AVAILABLE_UNTIL_AUDIT"
    && (await q(`SELECT count(*)::int n FROM "ServiceCaseIntake" WHERE "caseId" = $1`, s1.case.id))[0].n === 0
    && (await events(A.b, s1.case.id)) === 1);
  await x(`INSERT INTO "ServiceCaseIntake" ("businessId", "caseId", "conditionNote", "accessoriesNote", "conditionRecorded", "accessoriesRecorded", "updatedAt") VALUES ($1, $2, 'שריטה בפינה', 'מטען', true, true, now())`, A.b, s1.case.id);
  // Owner decision 2026-11-11: no customer signature. The documented intake checks in on the owner's explicit confirmation.
  ok("T12 IN_SHOP check-in without the owner's confirmation → REFUSED INTAKE_NOT_CONFIRMED", (await code(() => act(A, s1.case.id, { type: "CHECK_IN" }, 1))).includes("INTAKE_NOT_CONFIRMED"));
  const sci = await act(A, s1.case.id, { type: "CHECK_IN", intakeConfirmed: true }, 1);
  const sciEv = (await q(`SELECT payload->>'intakeConfirmed' c, "actorUserId" a, "fromStatus"::text f, "toStatus"::text t FROM "ServiceCaseEvent" WHERE "caseId" = $1 AND seq = 2`, s1.case.id))[0];
  ok("T13 no signature, no stored object: the owner's confirmation checks the documented intake in → CHECKED_IN",
    sci.case.status === "CHECKED_IN" && (await q(`SELECT "signedAt" s FROM "ServiceCaseIntake" WHERE "caseId" = $1`, s1.case.id))[0].s === null);
  ok("T14 … the journal names the confirmation, the acting user and the status change", sciEv.c === "true" && Number(sciEv.a) === A.u && sciEv.f === "OPEN" && sciEv.t === "CHECKED_IN");
  await absent("T15 without the audit journal: intake after check-in → still NOT_AVAILABLE_UNTIL_AUDIT (no write attempted)", async () => (await code(() => recordIntake(A.p, s1.case.id, { conditionNote: "אחר", accessoriesNote: null, conditionRecorded: true, accessoriesRecorded: true, expectedVersion: sci.case.version }, { idempotencyKey: key() }))) === "NOT_AVAILABLE_UNTIL_AUDIT");
  await x(`UPDATE "ServiceCase" SET "coverageSource" = 'STORE', "coverageDecision" = 'APPROVED' WHERE id = $1`, s1.case.id);
  const sdg = await act(A, s1.case.id, { type: "START_DIAGNOSIS" }, 2);
  const srp = await act(A, s1.case.id, { type: "START_REPAIR" }, sdg.case.version);
  const sfn = await act(A, s1.case.id, { type: "FINISH_REPAIR" }, srp.case.version);
  ok("T16 IN_SHOP repair finishes → QA", sfn.case.status === "QA");
  ok("T17 PASS_QA without the checklist → REFUSED QA_INCOMPLETE (no 1.3a command records one)", (await code(() => act(A, s1.case.id, { type: "PASS_QA", outcome: "REPAIRED" }, sfn.case.version))).includes("QA_INCOMPLETE"));
  const fqa = await act(A, s1.case.id, { type: "FAIL_QA" }, sfn.case.version);
  const mnr = await act(A, s1.case.id, { type: "MARK_NOT_REPAIRABLE" }, fqa.case.version);
  ok("T18 FAIL_QA → back to IN_REPAIR; not repairable → READY / NOT_REPAIRED", fqa.case.status === "IN_REPAIR" && mnr.case.status === "READY" && mnr.case.outcome === "NOT_REPAIRED");

  console.log("S — technician");
  const s2 = await open(A, "FIELD");
  // P4 PR-2: assignment is journaled (full coverage in .sd3p4/records-battery.ts); without the migration it is refused.
  await absent("S1 without the audit journal: assign → NOT_AVAILABLE_UNTIL_AUDIT (own or another business's staff)", async () =>
    (await code(() => assignTechnician(A.p, s2.case.id, { staffMemberId: A.staff, expectedVersion: 1 }, { idempotencyKey: key() }))) === "NOT_AVAILABLE_UNTIL_AUDIT"
    && (await code(() => assignTechnician(A.p, s2.case.id, { staffMemberId: B.staff, expectedVersion: 1 }, { idempotencyKey: key() }))) === "NOT_AVAILABLE_UNTIL_AUDIT");
  ok("S2 … nothing written: no technician, version 1, one event",
    (await q(`SELECT "staffMemberId" s, version v FROM "ServiceCase" WHERE id = $1`, s2.case.id))[0].s === null && (await events(A.b, s2.case.id)) === 1);
  ok("S3 a malformed Idempotency-Key → IDEMPOTENCY_KEY_INVALID before any lookup", (await code(() => assignTechnician(A.p, s2.case.id, { staffMemberId: null, expectedVersion: 1 }, { idempotencyKey: "not-a-key" }))) === "IDEMPOTENCY_KEY_INVALID");
  await x(`UPDATE "ServiceCase" SET "staffMemberId" = $2 WHERE id = $1`, s2.case.id, A.staff); // lab: the assignment (journaled command needs P4)
  const sci2 = await act(A, s2.case.id, { type: "CHECK_IN" }, 1);
  await x(`UPDATE "StaffMember" SET active = false WHERE id = $1`, A.staff);
  ok("S4 an assigned technician who is no longer active → diagnosis refused (SERVER_CHECK_FAILED)", (await code(() => act(A, s2.case.id, { type: "START_DIAGNOSIS" }, sci2.case.version))).includes("STAFF_BELONGS_TO_BUSINESS"));
  await x(`UPDATE "StaffMember" SET active = true WHERE id = $1`, A.staff);
  const sdx = await act(A, s2.case.id, { type: "START_DIAGNOSIS" }, sci2.case.version);
  ok("S5 an active technician of the business → diagnosis, journal says not the owner", sdx.case.status === "DIAGNOSING"
    && (await q(`SELECT payload->>'handledByOwner' h FROM "ServiceCaseEvent" WHERE "caseId" = $1 AND seq = $2`, s2.case.id, sdx.event.seq))[0].h === "false");

  console.log("I — isolation");
  ok("I1 another business cannot read the case, its journal or find it in its list",
    (await code(() => getCase(B.b, id))) === "NOT_FOUND" && (await code(() => listCaseEvents(B.b, id))) === "NOT_FOUND"
    && !(await listCases(B.b)).cases.some((c) => c.id === id));
  ok("I2 another business cannot act on the case, assign it or record its intake (404)",
    (await code(() => act(B, id, { type: "CANCEL" }, fin.case.version))) === "NOT_FOUND"
    && (await code(() => assignTechnician(B.p, s2.case.id, { staffMemberId: null, expectedVersion: 1 }, { idempotencyKey: key() }))) === "NOT_FOUND"
    && (await code(() => recordIntake(B.p, s1.case.id, { conditionNote: null, accessoriesNote: null, conditionRecorded: true, accessoriesRecorded: true, expectedVersion: 1 }, { idempotencyKey: key() }))) === "NOT_FOUND");
  ok("I3 the list is scoped and newest first", (await listCases(A.b)).cases.every((c, i, a) => i === 0 || a[i - 1].id > c.id) && (await listCases(A.b)).cases.length >= 4);

  console.log("K — races");
  const k3 = await open(A, "FIELD");
  const both = await Promise.all([code(() => act(A, k3.case.id, { type: "CHECK_IN" }, 1)), code(() => act(A, k3.case.id, { type: "CANCEL" }, 1))]);
  ok("K1 two different actions at the same version at once → exactly one wins, the other VERSION_CONFLICT; one event", both.filter((r) => r === "OK").length === 1 && both.includes("VERSION_CONFLICT") && (await events(A.b, k3.case.id)) === 2, JSON.stringify(both));
  const k4 = await open(A, "FIELD");
  const kk = key();
  const five = await Promise.all(Array.from({ length: 5 }, () => act(A, k4.case.id, { type: "CHECK_IN" }, 1, kk).then((r) => r, (e) => e)));
  ok("K2 one key sent five times at once → one transition, every answer the same case and seq", five.every((r) => !(r instanceof Error) && (r as { event: { seq: number } }).event.seq === 2) && (await events(A.b, k4.case.id)) === 2, JSON.stringify(five.map((r) => (r instanceof Error ? r.message : r.event.seq))));
  const before = await n(`SELECT COALESCE(max("caseNumber"), 0)::int AS n FROM "ServiceCase" WHERE "businessId" = $1`, C.b);
  const many = await Promise.all(Array.from({ length: 20 }, () => open(C, "FIELD")));
  const nums = many.map((r) => r.case.caseNumber).sort((a, b) => a - b);
  ok("K3 20 openings at once → 20 distinct, contiguous numbers and 20 opening events", new Set(nums).size === 20 && nums[0] === before + 1 && nums[19] === before + 20
    && (await n(`SELECT count(*)::int AS n FROM "ServiceCaseEvent" WHERE "businessId" = $1 AND seq = 1`, C.b)) === 20, JSON.stringify(nums));

  const openKey = key();
  const before4 = await n(`SELECT COALESCE(max("caseNumber"), 0)::int AS n FROM "ServiceCase" WHERE "businessId" = $1`, C.b);
  const fiveOpen = await Promise.all(Array.from({ length: 5 }, () => open(C, "FIELD", {}, openKey).then((r) => r, (e) => e)));
  const after4 = await n(`SELECT COALESCE(max("caseNumber"), 0)::int AS n FROM "ServiceCase" WHERE "businessId" = $1`, C.b);
  ok("K4 one opening key sent five times at once → one case, every answer the same id, no case number consumed twice",
    fiveOpen.every((r) => !(r instanceof Error) && r.case.id === (fiveOpen[0] as { case: { id: number } }).case.id) && after4 === before4 + 1,
    JSON.stringify(fiveOpen.map((r) => (r instanceof Error ? r.message : r.case.id))));

  console.log("ST — settings");
  ok("ST1 no settings yet → version null, nothing set", (await getSettings(A.b)).version === null);
  // P4 PR-2: settings saves are journaled in ServiceSettingsEvent; without the migration they are refused, nothing written.
  await absent("ST2 without the audit journal: save → NOT_AVAILABLE_UNTIL_AUDIT, no settings row", async () =>
    (await code(() => updateSettings(A.p, { expectedVersion: null, defaultStaffMemberId: A.staff, warrantyTemplate: { value: 3, unit: "MONTHS", scope: "החלפת חלקים בתיקון", exclusions: null } }, { idempotencyKey: key() }))) === "NOT_AVAILABLE_UNTIL_AUDIT"
    && (await getSettings(A.b)).version === null);
  await absent("ST3 … the same for another business's staff (refused before any check)", async () =>
    (await code(() => updateSettings(A.p, { expectedVersion: null, defaultStaffMemberId: B.staff, warrantyTemplate: null }, { idempotencyKey: key() }))) === "NOT_AVAILABLE_UNTIL_AUDIT");
  await x(`INSERT INTO "ServiceSettings" ("businessId", "defaultStaffMemberId", "warrantyTemplateValue", "warrantyTemplateUnit", "warrantyTemplateScope", "updatedAt") VALUES ($1, $2, 3, 'MONTHS', 'החלפת חלקים בתיקון', now())`, A.b, A.staff); // lab: the settings
  const withDefault = await open(A, "FIELD");
  ok("ST4 a new case gets the default technician from the settings", withDefault.case.staffMemberId === A.staff);
  await x(`UPDATE "StaffMember" SET active = false WHERE id = $1`, A.staff);
  const noDefault = await open(A, "FIELD");
  await x(`UPDATE "StaffMember" SET active = true WHERE id = $1`, A.staff);
  ok("ST5 a default technician who is no longer active → none (the owner), never an inactive one", noDefault.case.staffMemberId === null);

  console.log("W — repeat warranty (ש4)");
  // A parent REPAIRED and handed back, with a LOCKED offer of 30 days. Handover and lock are 1.3c; the lab writes them.
  const notice = Number((await q(`INSERT INTO "ServiceTextVersion" ("businessId", kind, version, body, "bodySha256", "legalStatus", "legallyApprovedAt", "legallyApprovedByUserId", "createdByUserId")
    VALUES ($1, 'STATUTORY_NOTICE', 1, 'הודעה', encode(sha256(convert_to('הודעה','UTF8')),'hex'), 'DRAFT', NULL, NULL, $2) RETURNING id`, A.b, A.u))[0].id);
  await x(`UPDATE "ServiceTextVersion" SET "legalStatus" = 'LEGALLY_APPROVED', "legallyApprovedAt" = now(), "legallyApprovedByUserId" = $2 WHERE id = $1`, notice, A.u);
  const par = (await q(`SELECT id, version FROM "ServiceCase" WHERE id = $1`, id))[0]; // READY / REPAIRED from T6
  await x(`INSERT INTO "ServiceWarrantyOffer" ("businessId", "caseId", seq, state, source, "durationValue", "durationUnit", "scopeText", "statutoryNoticeVersionId", "contentSha256", "presentedAt", "presentedByUserId", "createdByUserId", "updatedAt")
    VALUES ($1, $2, 1, 'PRESENTED', 'INTAKE', 30, 'DAYS', 'תיקון', $3, $4, now(), $5, $5, now())`, A.b, id, notice, "a".repeat(64), A.u);
  await x(`INSERT INTO "ServiceHandover" ("businessId", "caseId", "receivedByName", "signatureCaptured", "openBalanceAgorot", "actorUserId") VALUES ($1, $2, 'מקבל', true, 0, $3)`, A.b, id, A.u);
  await x(`UPDATE "ServiceWarrantyOffer" SET state = 'LOCKED', "lockedAt" = now(), "startsOn" = (SELECT h."deliveredAt"::date FROM "ServiceHandover" h WHERE h."caseId" = $1),
    "endsOn" = public.service_warranty_end((SELECT h."deliveredAt"::date FROM "ServiceHandover" h WHERE h."caseId" = $1), 30, 'DAYS') WHERE "caseId" = $1`, id);
  await owner.$transaction(async (tx) => {
    const v = Number(par.version) + 1;
    await tx.$executeRawUnsafe(`UPDATE "ServiceCase" SET status = 'DELIVERED', "deliveredAt" = now(), version = $2, "updatedAt" = now() WHERE id = $1`, id, v);
    await tx.$executeRawUnsafe(`INSERT INTO "ServiceCaseEvent" ("businessId", "caseId", seq, "eventType", action, "fromStatus", "toStatus", "cancellationRequestedBefore", "cancellationRequestedAfter", outcome, actor, payload, "idempotencyKey")
      VALUES ($1, $2, $3, 'case.delivered', 'DELIVER', 'READY', 'DELIVERED', false, false, 'REPAIRED', 'SYSTEM', '{}', $4)`, A.b, id, v, `sd3a-deliver-${t}`);
  });
  const ends = String((await q(`SELECT to_char("endsOn", 'YYYY-MM-DD') e FROM "ServiceWarrantyOffer" WHERE "caseId" = $1`, id))[0].e);
  const rep = await open(A, "FIELD", { parentCaseId: id });
  ok("W1 a repeat within the locked warranty: the decision names the locked end date", rep.repeat?.ok === true && rep.repeat.withinRepairWarranty && rep.repeat.warrantyEndsOn === ends, JSON.stringify(rep.repeat));
  const noLock = await open(A, "FIELD");
  await owner.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`UPDATE "ServiceCase" SET status = 'CANCELLED', outcome = 'CANCELLED', "cancelledAt" = now(), version = 2, "updatedAt" = now() WHERE id = $1`, noLock.case.id);
    await tx.$executeRawUnsafe(`INSERT INTO "ServiceCaseEvent" ("businessId", "caseId", seq, "eventType", action, "fromStatus", "toStatus", "cancellationRequestedBefore", "cancellationRequestedAfter", outcome, actor, payload, "idempotencyKey")
      VALUES ($1, $2, 2, 'case.cancelled', 'CANCEL', 'OPEN', 'CANCELLED', false, false, 'CANCELLED', 'SYSTEM', '{}', $3)`, A.b, noLock.case.id, `sd3a-cx-${t}`);
  });
  ok("W2 a parent that was not handed back cannot have a repeat (REFUSED)", (await code(() => open(A, "FIELD", { parentCaseId: noLock.case.id }))).startsWith("REFUSED"));
  ok("W3 a parent of another business → refused (never revealed)", (await code(() => openCase(B.p, { kind: "FIELD", customerId: B.cust, parentCaseId: id, problemDescription: "תקלה" }, { idempotencyKey: key() }))).startsWith("SERVER_CHECK_FAILED"));

  console.log("F — access modes from the real flag rows");
  await setOverride(A.b, null); await setPolicy(false);
  ok("F1 not launched (global OFF, no override) → NONE even though the business has cases", (await resolveServiceDeskMode(A.b)) === "NONE");
  await setOverride(A.b, "ENABLED");
  ok("F2 per-business ENABLED → FULL", (await resolveServiceDeskMode(A.b)) === "FULL");
  await setOverride(A.b, "DISABLED");
  ok("F3 BUSINESS_DISABLED while global OFF (pre-launch) + cases → NONE", (await resolveServiceDeskMode(A.b)) === "NONE");
  await setPolicy(true);
  await setOverride(B.b, "DISABLED");
  const bCases = await n(`SELECT count(*)::int AS n FROM "ServiceCase" WHERE "businessId" = $1`, B.b);
  ok("F4 launched + BUSINESS_DISABLED + cases → READ_ONLY; the same without cases → NONE", (await resolveServiceDeskMode(A.b)) === "READ_ONLY" && bCases === 0 && (await resolveServiceDeskMode(B.b)) === "NONE");
  await setPolicy(true, true);
  ok("F5 the emergency switch on top → NONE", (await resolveServiceDeskMode(A.b)) === "NONE");
  await setPolicy(true, false);
  await setOverride(A.b, null);
  ok("F6 launched, no override, catalog default OFF → NONE", (await resolveServiceDeskMode(A.b)) === "NONE");
  await setOverride(A.b, "DISABLED");
  const user = async () => ({ id: A.u, businessId: A.b });
  const req = (m: string) => new Request("https://lab.test/api/service-desk/cases", { method: m });
  let wrote = false;
  const rr = await serviceDeskRoute(req("GET"), "read", async () => new Response("read"), { user });
  const rw = await serviceDeskRoute(req("POST"), "write", async () => { wrote = true; return new Response("w"); }, { user });
  ok("F7 the edge in READ_ONLY (real flags): a read runs, a write is 403 before any work", rr.status === 200 && rw.status === 403 && !wrote);
  await setOverride(A.b, null); await setOverride(B.b, null); await setPolicy(false, false);
  ok("F8 the lab's flag rows are restored (global OFF, no override)", (await resolveServiceDeskMode(A.b)) === "NONE");

  console.log("H — the real routes with a real session (option B: un-audited writes closed until P4)");
  const { signAuthToken } = await import("../lib/auth-token");
  const tokenA = signAuthToken(A.u);
  const routes = {
    technician: await import("../app/api/service-desk/cases/[id]/technician/route"),
    intake: await import("../app/api/service-desk/cases/[id]/intake/route"),
    qa: await import("../app/api/service-desk/cases/[id]/qa/route"),
    settings: await import("../app/api/service-desk/settings/route"),
    actions: await import("../app/api/service-desk/cases/[id]/actions/route"),
    case: await import("../app/api/service-desk/cases/[id]/route"),
    staff: await import("../app/api/service-desk/staff/route"),
  };
  const http = (method: string, body: unknown, token: string | null, extra: Record<string, string> = {}) =>
    new Request("https://lab.test/api/service-desk/x", { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json", ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
  const params = (caseId: number) => ({ params: Promise.resolve({ id: String(caseId) }) });
  const hCase = await open(A, "IN_SHOP", { deviceId: A.device });
  const snap = async () => JSON.stringify({
    c: (await q(`SELECT "staffMemberId" s, version v, "updatedAt" u FROM "ServiceCase" WHERE id = $1`, hCase.case.id))[0],
    i: await n(`SELECT count(*)::int AS n FROM "ServiceCaseIntake" WHERE "caseId" = $1`, hCase.case.id),
    st: (await q(`SELECT version v, "defaultStaffMemberId" d, "updatedAt" u FROM "ServiceSettings" WHERE "businessId" = $1`, A.b))[0] ?? null,
    e: await n(`SELECT count(*)::int AS n FROM "ServiceCaseEvent" WHERE "businessId" = $1`, A.b),
  });
  // P4 PR-2: the routes are open in code but journaled — each needs the Idempotency-Key and expectedVersion, and the
  // service refuses NOT_AVAILABLE_UNTIL_AUDIT before any write while the audit journal migration is absent (this lab).
  const closedCalls = async (token: string | null) => [
    await routes.technician.PUT(http("PUT", { staffMemberId: A.staff, expectedVersion: 1 }, token, { "idempotency-key": key() }), params(hCase.case.id)),
    await routes.intake.PUT(http("PUT", { conditionNote: "x", accessoriesNote: null, conditionRecorded: true, accessoriesRecorded: true, expectedVersion: 1 }, token, { "idempotency-key": key() }), params(hCase.case.id)),
    await routes.qa.PUT(http("PUT", { results: { powers_on: "PASS" }, expectedVersion: 1 }, token, { "idempotency-key": key() }), params(hCase.case.id)),
    await routes.settings.PUT(http("PUT", { expectedVersion: 1, defaultStaffMemberId: null, warrantyTemplate: null }, token, { "idempotency-key": key() })),
  ];
  await setPolicy(false); await setOverride(A.b, "ENABLED"); // FULL for A (lab only)
  const beforeH = await snap();
  const full: Response[] = journalPresent ? [] : await closedCalls(tokenA);
  const fullBodies = await Promise.all(full.map((r) => r.json()));
  await absent("H1 FULL without the audit journal: PUT technician / intake / qa / settings (with key + version) → 422 NOT_AVAILABLE_UNTIL_AUDIT, never a success",
    async () => full.length === 4 && full.every((r) => r.status === 422) && fullBodies.every((b) => b.error === "NOT_AVAILABLE_UNTIL_AUDIT"));
  await absent("H2 … and nothing was written: case (technician, version, updatedAt), intake, settings and the journal are unchanged", async () => (await snap()) === beforeH);
  ok("H3 no session → 401 on the closed routes (authentication unchanged)", (await closedCalls(null)).every((r) => r.status === 401));
  await setOverride(A.b, null);
  ok("H4 NONE (not launched) → 404 on the closed routes (the gate unchanged)", (await closedCalls(tokenA)).every((r) => r.status === 404));
  await setPolicy(true); await setOverride(A.b, "DISABLED");
  ok("H5 READ_ONLY → 403 READ_ONLY on the closed routes, before the closure", (await Promise.all((await closedCalls(tokenA)).map(async (r) => r.status === 403 && (await r.json()).error === "READ_ONLY"))).every(Boolean));
  const settingsRead = await routes.settings.GET(http("GET", undefined, tokenA));
  ok("H6 READ_ONLY still reads (GET settings, GET case)", settingsRead.status === 200 && (await routes.case.GET(http("GET", undefined, tokenA), params(hCase.case.id))).status === 200);
  // UI 1.3a: GET /api/service-desk/staff — the technician pickers' list, under the Service Desk gate (not appointments).
  const inactive = Number((await q(`INSERT INTO "StaffMember" ("businessId", "displayName", active, "updatedAt") VALUES ($1, 'לא פעיל', false, now()) RETURNING id`, A.b))[0].id);
  const erased = Number((await q(`INSERT INTO "StaffMember" ("businessId", "displayName", "erasedAt", "updatedAt") VALUES ($1, '', now(), now()) RETURNING id`, A.b))[0].id);
  const staffRes = await routes.staff.GET(http("GET", undefined, tokenA));
  const staffIds = staffRes.status === 200 ? ((await staffRes.json()).staff as { id: number; displayName: string }[]).map((m) => m.id) : [];
  ok("HS1 GET staff (READ_ONLY reads): this business's active staff only — not inactive, not erased, never another business's",
    staffRes.status === 200 && staffIds.includes(A.staff) && !staffIds.includes(inactive) && !staffIds.includes(erased) && !staffIds.includes(B.staff));
  ok("HS2 GET staff: no session → 401", (await routes.staff.GET(http("GET", undefined, null))).status === 401);
  await setOverride(A.b, null); await setPolicy(false);
  ok("HS3 GET staff: NONE (not open) → 404, like every Service Desk route", (await routes.staff.GET(http("GET", undefined, tokenA))).status === 404);
  await q(`DELETE FROM "StaffMember" WHERE id = ANY($1::int[])`, [inactive, erased]);
  await setPolicy(true); await setOverride(A.b, "DISABLED");
  ok("H7 still nothing written after every refusal", (await snap()) === beforeH);
  await setPolicy(false); await setOverride(A.b, "ENABLED");
  const hk = key();
  const a1 = await routes.actions.POST(http("POST", { action: { type: "CANCEL" }, expectedVersion: 1 }, tokenA, { "idempotency-key": hk }), params(hCase.case.id));
  const a2 = await routes.actions.POST(http("POST", { action: { type: "CANCEL" }, expectedVersion: 1 }, tokenA, { "idempotency-key": hk }), params(hCase.case.id));
  const a3 = await routes.actions.POST(http("POST", { action: { type: "CHECK_IN" }, expectedVersion: 1 }, tokenA, { "idempotency-key": hk }), params(hCase.case.id));
  const [b1, b2, b3] = [await a1.json(), await a2.json(), await a3.json()];
  ok("H8 the journaled action route still works end to end, idempotent: replay answered, another body under the key refused",
    a1.status === 200 && b1.case.status === "CANCELLED" && !b1.replayed && a2.status === 200 && b2.replayed === true && a3.status === 409 && b3.error === "IDEMPOTENCY_KEY_REUSED",
    JSON.stringify([a1.status, a2.status, a3.status]));
  const tokenB = signAuthToken(B.u);
  await setOverride(B.b, "ENABLED");
  const cross = await routes.case.GET(http("GET", undefined, tokenB), params(hCase.case.id));
  ok("H9 isolation through the real route: business B's session → 404 for A's case", cross.status === 404);
  await setOverride(A.b, null); await setOverride(B.b, null); await setPolicy(false, false);

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) console.log("FAILED:\n  " + failures.join("\n  "));
}

main()
  .catch((e) => { failures.push(`crash: ${(e as Error).message}`); console.error(e); console.log(`\n${pass} passed, ${failures.length} failed`); })
  .finally(async () => { await owner.$disconnect(); process.exit(failures.length ? 1 : 0); });
