/**
 * Service Desk P4 PR-2 — the journaled records and the account deletion, AS the runtime role, on the P4 lab (.sd3p4/lab.sh
 * <db> + --deploy-only, then .sdf/erasure-prereq.sh) and on a 1.3-0-only lab without P4 (ABSENT_*). Synthetic only.
 *
 *   T  technician: event + version in one transaction (status untouched, payload ids only, the acting user); replay;
 *      key reuse; stale version; no change; another business's staff; two at once → one; one key five times → one event;
 *      the event insert failing → the change rolled back (no partial success).
 *   I  intake data: created / changed (field-change flags, never the text in the journal); no change; not IN_SHOP;
 *      after check-in; event failure → rolled back.
 *   Q  QA: a required item failed or missing → stored, journaled, NOT completed, PASS_QA still refused; all required PASS
 *      → completed, PASS_QA passes; not in QA / unknown key → refused, nothing written.
 *   S  settings: first save + ServiceSettingsEvent (field names only); replay; stale; no change; two at once → one;
 *      the journal insert failing → the settings unchanged.
 *   A  without the P4 journal (the 1.3-0-only lab): every record write → NOT_AVAILABLE_UNTIL_AUDIT, nothing written.
 *   D  account deletion through the real deleteOwnBusinessAccount: a failure later in the purge transaction rolls the new
 *      erase back too; the rerun completes: settings events blanked and kept, the case journal's records blanked, the
 *      business's other data per the existing contract; a second deletion is "already_deleted".
 *
 * env: OWNER_URL, DATABASE_URL = DIRECT_URL (runtime), ABSENT_OWNER_URL, ABSENT_RUNTIME_URL, STORAGE_PROVIDER=local,
 *      LOCAL_STORAGE_ROOT, TASK_REQUEST_HMAC_KEY(_ID), AUTH_TOKEN_SECRET.
 */
import { spawnSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";

import { uuidV7 } from "../lib/services/tasks/task-idempotency";
import { ServiceDeskError } from "../lib/services/service-desk/service-desk-errors";
import { QA_TEMPLATES } from "../lib/services/service-desk/qa-templates";
import {
  assignTechnician, getSettings, openCase, recordIntake, recordQa, runCaseAction, updateSettings, type ServiceDeskPrincipal,
} from "../lib/services/service-desk/service-case.service";
import { deleteOwnBusinessAccount } from "../lib/services/account/account-deletion.service";
import { prismaAccountDeletionStore } from "../lib/services/account/account-deletion.prisma-store";

const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });
let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); } else { failures.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}
type Rows = Record<string, unknown>[];
const q = (sql: string, ...a: unknown[]) => owner.$queryRawUnsafe(sql, ...a) as Promise<Rows>;
const x = (sql: string, ...a: unknown[]) => owner.$executeRawUnsafe(sql, ...a);
const n = async (sql: string, ...a: unknown[]) => Number((await q(sql, ...a))[0]?.n);
const key = () => uuidV7(new Date());
async function code(fn: () => Promise<unknown>): Promise<string> {
  try { await fn(); return "OK"; } catch (e) {
    if (e instanceof ServiceDeskError) return `${e.code}${Object.keys(e.details).length ? ":" + JSON.stringify(e.details) : ""}`;
    return `ERR:${(e as Error).message.slice(0, 160)}`;
  }
}
const t = Date.now();
async function business(tag: string, db: PrismaClient = owner) {
  const one = async (sql: string, ...a: unknown[]) => Number(((await db.$queryRawUnsafe(sql, ...a)) as Rows)[0].id);
  const b = await one(`INSERT INTO "Business" (name, "updatedAt") VALUES ($1, now()) RETURNING id`, `p4r-${tag}-${t}`);
  const u = await one(`INSERT INTO "User" (email, "businessId", "updatedAt") VALUES ($1, $2, now()) RETURNING id`, `p4r-${tag}-${t}@lab.invalid`, b);
  const cust = await one(`INSERT INTO "Customer" ("businessId", name, "updatedAt") VALUES ($1, 'לקוח', now()) RETURNING id`, b);
  const staff = await one(`INSERT INTO "StaffMember" ("businessId", "displayName", "updatedAt") VALUES ($1, 'טכנאי', now()) RETURNING id`, b);
  const staff2 = await one(`INSERT INTO "StaffMember" ("businessId", "displayName", "updatedAt") VALUES ($1, 'טכנאית', now()) RETURNING id`, b);
  const device = await one(`INSERT INTO "ServiceDevice" ("businessId", "customerId", category, "updatedAt") VALUES ($1, $2, 'PHONE', now()) RETURNING id`, b, cust);
  return { b, u, cust, staff, staff2, device, p: { businessId: b, userId: u } as ServiceDeskPrincipal };
}
type Biz = Awaited<ReturnType<typeof business>>;
const open = (z: Biz, kind = "FIELD", extra: Record<string, unknown> = {}) => openCase(z.p, { kind, customerId: z.cust, problemDescription: "תקלה", ...extra }, { idempotencyKey: key() });
const ver = async (caseId: number) => n(`SELECT version AS n FROM "ServiceCase" WHERE id = $1`, caseId);
const events = (caseId: number) => n(`SELECT count(*)::int AS n FROM "ServiceCaseEvent" WHERE "caseId" = $1`, caseId);
const lastEvent = async (caseId: number) => (await q(`SELECT seq, "eventType"::text t, action::text a, "fromStatus"::text f, "toStatus"::text s, "actorUserId" u, payload::text p
  FROM "ServiceCaseEvent" WHERE "caseId" = $1 ORDER BY seq DESC LIMIT 1`, caseId))[0];
/** Lab fault: the next INSERT into `table` matching `when` fails (a trigger the owner adds and removes). */
async function withFault<T>(table: string, when: string, fn: () => Promise<T>): Promise<T> {
  await x(`CREATE OR REPLACE FUNCTION public.p4r_lab_fault() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RAISE EXCEPTION 'P4R_LAB_FAULT'; END $f$`);
  await x(`CREATE TRIGGER p4r_lab_fault BEFORE INSERT ON "${table}" FOR EACH ROW WHEN (${when}) EXECUTE FUNCTION public.p4r_lab_fault()`);
  try { return await fn(); } finally { await x(`DROP TRIGGER IF EXISTS p4r_lab_fault ON "${table}"`); }
}

async function main() {
  const A = await business("a"), B = await business("b");

  console.log("T — technician");
  const c1 = (await open(A)).case.id;
  const kT = key();
  const t1 = await assignTechnician(A.p, c1, { staffMemberId: A.staff, expectedVersion: 1 }, { idempotencyKey: kT });
  const e1 = await lastEvent(c1);
  ok("T1 assigned: version 1 → 2, event case.technician_assigned seq 2, status unchanged, the acting user, ids only",
    t1.case.staffMemberId === A.staff && t1.case.version === 2 && !t1.replayed && e1.t === "case.technician_assigned" && e1.a === "ASSIGN_TECHNICIAN"
    && Number(e1.seq) === 2 && e1.f === "OPEN" && e1.s === "OPEN" && Number(e1.u) === A.u && String(e1.p) === `{"toStaffMemberId": ${A.staff}, "fromStaffMemberId": null}`, JSON.stringify(e1));
  const t1r = await assignTechnician(A.p, c1, { staffMemberId: A.staff, expectedVersion: 1 }, { idempotencyKey: kT });
  ok("T2 the same key + same request → replayed, still one record", t1r.replayed && (await events(c1)) === 2);
  ok("T3 the same key + another request → IDEMPOTENCY_KEY_REUSED", (await code(() => assignTechnician(A.p, c1, { staffMemberId: null, expectedVersion: 1 }, { idempotencyKey: kT }))) === "IDEMPOTENCY_KEY_REUSED");
  ok("T4 a stale expectedVersion → VERSION_CONFLICT, nothing written", (await code(() => assignTechnician(A.p, c1, { staffMemberId: A.staff2, expectedVersion: 1 }, { idempotencyKey: key() }))) === "VERSION_CONFLICT" && (await events(c1)) === 2);
  ok("T5 assigning the same technician again → REFUSED NO_CHANGE, no event", (await code(() => assignTechnician(A.p, c1, { staffMemberId: A.staff, expectedVersion: 2 }, { idempotencyKey: key() }))).includes("NO_CHANGE") && (await events(c1)) === 2);
  ok("T6 another business's staff member → refused, nothing written", (await code(() => assignTechnician(A.p, c1, { staffMemberId: B.staff, expectedVersion: 2 }, { idempotencyKey: key() }))).includes("STAFF_BELONGS_TO_BUSINESS") && (await ver(c1)) === 2);
  ok("T7 another business cannot assign on this case (404)", (await code(() => assignTechnician(B.p, c1, { staffMemberId: null, expectedVersion: 2 }, { idempotencyKey: key() }))) === "NOT_FOUND");
  const race = await Promise.all([code(() => assignTechnician(A.p, c1, { staffMemberId: A.staff2, expectedVersion: 2 }, { idempotencyKey: key() })), code(() => assignTechnician(A.p, c1, { staffMemberId: null, expectedVersion: 2 }, { idempotencyKey: key() }))]);
  ok("T8 two assignments at one version at once → one wins, the other VERSION_CONFLICT; one event", race.filter((r) => r === "OK").length === 1 && race.includes("VERSION_CONFLICT") && (await events(c1)) === 3, JSON.stringify(race));
  const c2 = (await open(A)).case.id;
  const k5 = key();
  const five = await Promise.all(Array.from({ length: 5 }, () => assignTechnician(A.p, c2, { staffMemberId: A.staff, expectedVersion: 1 }, { idempotencyKey: k5 }).then((r) => r, (e) => e)));
  ok("T9 one key five times at once → one record, every answer seq 2", five.every((r) => !(r instanceof Error) && r.event.seq === 2) && (await events(c2)) === 2, JSON.stringify(five.map((r) => (r instanceof Error ? r.message : r.event.seq))));
  const vBefore = await ver(c2);
  const faulted = await withFault("ServiceCaseEvent", `NEW."caseId" = ${c2} AND NEW.action::text = 'ASSIGN_TECHNICIAN'`, () => code(() => assignTechnician(A.p, c2, { staffMemberId: A.staff2, expectedVersion: vBefore }, { idempotencyKey: key() })));
  ok("T10 the event insert fails → the assignment is rolled back (technician, version unchanged; no partial success)",
    faulted !== "OK" && (await q(`SELECT "staffMemberId" s FROM "ServiceCase" WHERE id = $1`, c2))[0].s === A.staff && (await ver(c2)) === vBefore && (await events(c2)) === 2, faulted);

  console.log("I — intake data");
  const s1 = (await open(A, "IN_SHOP", { deviceId: A.device })).case.id;
  const i1 = await recordIntake(A.p, s1, { conditionNote: "שריטה — דנה 050", accessoriesNote: "מטען", conditionRecorded: true, accessoriesRecorded: true, expectedVersion: 1 }, { idempotencyKey: key() });
  const ie = await lastEvent(s1);
  ok("I1 intake created: event intake.recorded with change flags — never the text", i1.case.version === 2 && ie.t === "intake.recorded" && String(ie.p).includes('"created": true')
    && !String(ie.p).includes("דנה") && !String(ie.p).includes("מטען"), String(ie.p));
  const i2 = await recordIntake(A.p, s1, { conditionNote: "שריטה — דנה 050", accessoriesNote: null, conditionRecorded: true, accessoriesRecorded: false, expectedVersion: 2 }, { idempotencyKey: key() });
  const ie2 = await lastEvent(s1);
  ok("I2 intake changed: flags say what changed", i2.case.version === 3 && String(ie2.p).includes('"accessoriesNoteChanged": true') && String(ie2.p).includes('"conditionNoteChanged": false'), String(ie2.p));
  ok("I3 the same data again → REFUSED NO_CHANGE, no event", (await code(() => recordIntake(A.p, s1, { conditionNote: "שריטה — דנה 050", accessoriesNote: null, conditionRecorded: true, accessoriesRecorded: false, expectedVersion: 3 }, { idempotencyKey: key() }))).includes("NO_CHANGE") && (await events(s1)) === 3);
  const c1v = await ver(c1);
  ok("I4 an on-site case has no intake record (REFUSED)", (await code(() => recordIntake(A.p, c1, { conditionNote: null, accessoriesNote: null, conditionRecorded: true, accessoriesRecorded: true, expectedVersion: c1v }, { idempotencyKey: key() }))).includes("INTAKE_ONLY_IN_SHOP"));
  const faultI = await withFault("ServiceCaseEvent", `NEW."caseId" = ${s1} AND NEW.action::text = 'RECORD_INTAKE'`, () => code(() => recordIntake(A.p, s1, { conditionNote: "אחר", accessoriesNote: null, conditionRecorded: true, accessoriesRecorded: false, expectedVersion: 3 }, { idempotencyKey: key() })));
  ok("I5 the event insert fails → the intake data is rolled back", faultI !== "OK" && (await q(`SELECT "conditionNote" c FROM "ServiceCaseIntake" WHERE "caseId" = $1`, s1))[0].c === "שריטה — דנה 050" && (await ver(s1)) === 3);

  console.log("Q — QA");
  // Owner decision 2026-11-11: no customer signature — the owner confirms the documented intake.
  await x(`UPDATE "ServiceCaseIntake" SET "accessoriesRecorded" = true WHERE "caseId" = $1`, s1);
  let v = await ver(s1);
  for (const action of [{ type: "CHECK_IN", intakeConfirmed: true }, { type: "START_DIAGNOSIS" }]) v = (await runCaseAction(A.p, s1, { action, expectedVersion: v }, { idempotencyKey: key() })).case.version;
  ok("I6 after check-in the intake is closed to edits (REFUSED)", (await code(() => recordIntake(A.p, s1, { conditionNote: null, accessoriesNote: null, conditionRecorded: true, accessoriesRecorded: true, expectedVersion: v }, { idempotencyKey: key() }))).startsWith("REFUSED"));
  await x(`UPDATE "ServiceCase" SET "coverageSource" = 'STORE', "coverageDecision" = 'APPROVED' WHERE id = $1`, s1); // lab: a cover (1.3c records it)
  for (const action of [{ type: "START_REPAIR" }, { type: "FINISH_REPAIR" }]) v = (await runCaseAction(A.p, s1, { action, expectedVersion: v }, { idempotencyKey: key() })).case.version;
  ok("Q0 the case is in QA", (await q(`SELECT status::text s FROM "ServiceCase" WHERE id = $1`, s1))[0].s === "QA");
  const req = QA_TEMPLATES.IN_SHOP.items.filter((i) => i.required).map((i) => i.key);
  const partial = Object.fromEntries(req.map((k, i) => [k, i === 0 ? "FAIL" : "PASS"]));
  const qa1 = await recordQa(A.p, s1, { results: partial, expectedVersion: v }, { idempotencyKey: key() });
  const qe = await lastEvent(s1);
  ok("Q1 a required item FAILED → stored and journaled, NOT completed (qaCompletedAt NULL)", qa1.qa?.completed === false
    && (await q(`SELECT "qaCompletedAt" IS NULL x FROM "ServiceCase" WHERE id = $1`, s1))[0].x === true && qe.t === "qa.recorded" && String(qe.p).includes('"completed": false') && String(qe.p).includes('"requiredFailed": 1'));
  v = qa1.case.version;
  ok("Q2 … and PASS_QA is still refused (QA_INCOMPLETE)", (await code(() => runCaseAction(A.p, s1, { action: { type: "PASS_QA", outcome: "REPAIRED" }, expectedVersion: v }, { idempotencyKey: key() }))).includes("QA_INCOMPLETE"));
  const missing = Object.fromEntries(req.slice(1).map((k) => [k, "PASS"]));
  const qa2 = await recordQa(A.p, s1, { results: missing, expectedVersion: v }, { idempotencyKey: key() });
  ok("Q3 a required item not recorded → NOT completed", qa2.qa?.completed === false && String((await lastEvent(s1)).p).includes('"requiredMissing": 1'));
  v = qa2.case.version;
  ok("Q4 an unknown key → INVALID_INPUT, nothing written", (await code(() => recordQa(A.p, s1, { results: { ...missing, hacked: "PASS" }, expectedVersion: v }, { idempotencyKey: key() }))).startsWith("INVALID_INPUT") && (await ver(s1)) === v);
  const qa3 = await recordQa(A.p, s1, { results: Object.fromEntries(req.map((k) => [k, "PASS"])), expectedVersion: v }, { idempotencyKey: key() });
  ok("Q5 every required item PASS → completed (qaCompletedAt set)", qa3.qa?.completed === true && (await q(`SELECT "qaCompletedAt" IS NOT NULL x FROM "ServiceCase" WHERE id = $1`, s1))[0].x === true);
  const pq = await runCaseAction(A.p, s1, { action: { type: "PASS_QA", outcome: "REPAIRED" }, expectedVersion: qa3.case.version }, { idempotencyKey: key() });
  ok("Q6 … and PASS_QA passes → READY / REPAIRED", pq.case.status === "READY" && pq.case.outcome === "REPAIRED");
  ok("Q7 outside QA → REFUSED QA_ONLY_IN_QA", (await code(() => recordQa(A.p, s1, { results: { [req[0]]: "PASS" }, expectedVersion: pq.case.version }, { idempotencyKey: key() }))).includes("QA_ONLY_IN_QA"));

  console.log("S — settings");
  const kS = key();
  const st1 = await updateSettings(A.p, { expectedVersion: null, defaultStaffMemberId: A.staff, warrantyTemplate: { value: 3, unit: "MONTHS", scope: "תבנית", exclusions: null } }, { idempotencyKey: kS });
  const se = (await q(`SELECT "settingsVersion" v, "changedFields"::text f, "actorUserId" u FROM "ServiceSettingsEvent" WHERE "businessId" = $1 ORDER BY id`, A.b));
  ok("S1 first save → version 1 and one journal event naming both fields, the acting user", st1.version === 1 && !st1.replayed && se.length === 1 && Number(se[0].v) === 1
    && se[0].f === "{defaultStaffMemberId,warrantyTemplate}" && Number(se[0].u) === A.u, JSON.stringify(se));
  const st1r = await updateSettings(A.p, { expectedVersion: null, defaultStaffMemberId: A.staff, warrantyTemplate: { value: 3, unit: "MONTHS", scope: "תבנית", exclusions: null } }, { idempotencyKey: kS });
  ok("S2 the same key + same request → replayed, no second event", st1r.replayed && (await n(`SELECT count(*)::int n FROM "ServiceSettingsEvent" WHERE "businessId" = $1`, A.b)) === 1);
  ok("S3 a stale expectedVersion → VERSION_CONFLICT; no change → REFUSED NO_CHANGE",
    (await code(() => updateSettings(A.p, { expectedVersion: null, defaultStaffMemberId: null, warrantyTemplate: null }, { idempotencyKey: key() }))) === "VERSION_CONFLICT"
    && (await code(() => updateSettings(A.p, { expectedVersion: 1, defaultStaffMemberId: A.staff, warrantyTemplate: { value: 3, unit: "MONTHS", scope: "תבנית", exclusions: null } }, { idempotencyKey: key() }))).includes("NO_CHANGE"));
  const sr = await Promise.all([code(() => updateSettings(A.p, { expectedVersion: 1, defaultStaffMemberId: A.staff2, warrantyTemplate: null }, { idempotencyKey: key() })), code(() => updateSettings(A.p, { expectedVersion: 1, defaultStaffMemberId: null, warrantyTemplate: null }, { idempotencyKey: key() }))]);
  ok("S4 two saves at one version at once → one wins, the other VERSION_CONFLICT; one more event", sr.filter((r) => r === "OK").length === 1 && sr.includes("VERSION_CONFLICT")
    && (await n(`SELECT count(*)::int n FROM "ServiceSettingsEvent" WHERE "businessId" = $1`, A.b)) === 2, JSON.stringify(sr));
  const before = (await getSettings(A.b)).version;
  const faultS = await withFault("ServiceSettingsEvent", `NEW."businessId" = ${A.b}`, () => code(() => updateSettings(A.p, { expectedVersion: before, defaultStaffMemberId: A.staff, warrantyTemplate: null }, { idempotencyKey: key() })));
  ok("S5 the journal insert fails → the settings change is rolled back (version unchanged)", faultS !== "OK" && (await getSettings(A.b)).version === before, faultS);

  console.log("A — without the P4 journal (1.3-0-only lab)");
  if (process.env.ABSENT_OWNER_URL && process.env.ABSENT_RUNTIME_URL) {
    const env = { ...process.env, OWNER_URL: process.env.ABSENT_OWNER_URL, DATABASE_URL: process.env.ABSENT_RUNTIME_URL, DIRECT_URL: process.env.ABSENT_RUNTIME_URL, P4R_ABSENT_CHILD: "1" };
    const r = spawnSync(process.execPath, [...process.execArgv, process.argv[1]], { env, encoding: "utf8" });
    const out = `${r.stdout}`;
    for (const line of out.split("\n").filter((l) => /\[(PASS|FAIL)\] A\d/.test(l))) {
      const m = /\[(PASS|FAIL)\] (.*)$/.exec(line)!;
      ok(m[2], m[1] === "PASS");
    }
    if (!/\[(PASS|FAIL)\] A\d/.test(out)) ok("A0 the absent-journal child ran", false, (r.stderr || out).slice(-400));
  } else ok("A0 ABSENT_* lab configured", false);

  console.log("D — account deletion (real path)");
  const D = await business("d");
  const dc = (await open(D)).case.id;
  await assignTechnician(D.p, dc, { staffMemberId: D.staff, expectedVersion: 1 }, { idempotencyKey: key() });
  await updateSettings(D.p, { expectedVersion: null, defaultStaffMemberId: D.staff, warrantyTemplate: null }, { idempotencyKey: key() });
  await x(`CREATE OR REPLACE FUNCTION public.p4r_lab_purge_fault() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RAISE EXCEPTION 'P4R_LAB_PURGE_FAULT'; END $f$`);
  await x(`CREATE TRIGGER p4r_lab_purge_fault BEFORE UPDATE ON "ReceivingSession" FOR EACH STATEMENT EXECUTE FUNCTION public.p4r_lab_purge_fault()`);
  const failed = await code(() => deleteOwnBusinessAccount(prismaAccountDeletionStore, { businessId: D.b, actorUserId: D.u }));
  await x(`DROP TRIGGER IF EXISTS p4r_lab_purge_fault ON "ReceivingSession"`);
  ok("D1 a failure later in the purge transaction (after the new erase) → the deletion fails and the new erase is rolled back (actor + digest still present)",
    failed !== "OK" && (await q(`SELECT "actorUserId" a, "requestDigest" d FROM "ServiceSettingsEvent" WHERE "businessId" = $1`, D.b)).every((r) => r.a !== null && r.d !== null)
    && (await n(`SELECT count(*)::int n FROM "ServiceCaseEvent" WHERE "caseId" = $1 AND "actorUserId" IS NOT NULL`, dc)) > 0, failed);
  const done = await deleteOwnBusinessAccount(prismaAccountDeletionStore, { businessId: D.b, actorUserId: D.u });
  ok("D2 the rerun completes (deleted)", done.status === "deleted", JSON.stringify(done));
  const sev = await q(`SELECT "actorUserId" a, "requestDigest" d, "digestKeyId" k, "settingsVersion" v, "changedFields"::text f FROM "ServiceSettingsEvent" WHERE "businessId" = $1`, D.b);
  ok("D3 the settings journal is kept and blanked: no acting user, no digest; version and field names stay",
    sev.length === 1 && sev.every((r) => r.a === null && r.d === null && r.k === null) && Number(sev[0].v) === 1, JSON.stringify(sev));
  ok("D4 the case journal's records lost their acting user and digest (existing service_erase_business)",
    (await n(`SELECT count(*)::int n FROM "ServiceCaseEvent" WHERE "caseId" = $1 AND ("actorUserId" IS NOT NULL OR "requestDigest" IS NOT NULL)`, dc)) === 0
    && (await n(`SELECT count(*)::int n FROM "ServiceCaseEvent" WHERE "caseId" = $1 AND "eventType"::text = 'case.technician_assigned'`, dc)) === 1);
  ok("D5 the technician's display name is blanked by the existing purge (the payload's staff id is a pseudonym)", (await q(`SELECT "displayName" d FROM "StaffMember" WHERE id = $1`, D.staff))[0].d === "");
  ok("D6 a second deletion → already_deleted", (await deleteOwnBusinessAccount(prismaAccountDeletionStore, { businessId: D.b, actorUserId: D.u })).status === "already_deleted");
}

async function absentChild() {
  const Z = await business("z");
  const zc = (await open(Z)).case.id;
  const v0 = await ver(zc);
  const results = [
    await code(() => assignTechnician(Z.p, zc, { staffMemberId: Z.staff, expectedVersion: v0 }, { idempotencyKey: key() })),
    await code(() => updateSettings(Z.p, { expectedVersion: null, defaultStaffMemberId: Z.staff, warrantyTemplate: null }, { idempotencyKey: key() })),
  ];
  const zs = (await open(Z, "IN_SHOP", { deviceId: Z.device })).case.id;
  results.push(await code(() => recordIntake(Z.p, zs, { conditionNote: "x", accessoriesNote: null, conditionRecorded: true, accessoriesRecorded: true, expectedVersion: 1 }, { idempotencyKey: key() })));
  results.push(await code(() => recordQa(Z.p, zc, { results: { original_fault_resolved: "PASS" }, expectedVersion: v0 }, { idempotencyKey: key() })));
  ok("A1 technician / settings / intake / QA without the journal → NOT_AVAILABLE_UNTIL_AUDIT", results.every((r) => r === "NOT_AVAILABLE_UNTIL_AUDIT"), JSON.stringify(results));
  ok("A2 nothing was written: case versions, technician, intake, settings unchanged",
    (await ver(zc)) === v0 && (await q(`SELECT "staffMemberId" s FROM "ServiceCase" WHERE id = $1`, zc))[0].s === null
    && (await n(`SELECT count(*)::int n FROM "ServiceCaseIntake" WHERE "caseId" = $1`, zs)) === 0
    && (await n(`SELECT count(*)::int n FROM "ServiceSettings" WHERE "businessId" = $1`, Z.b)) === 0);
}

(process.env.P4R_ABSENT_CHILD === "1" ? absentChild() : main())
  .catch((e) => { failures.push(`crash: ${(e as Error).message}`); console.error(e); })
  .finally(async () => {
    console.log(`\n${pass} passed, ${failures.length} failed`);
    if (failures.length) console.log("FAILED:\n  " + failures.join("\n  "));
    await owner.$disconnect();
    process.exit(failures.length ? 1 : 0);
  });
