/**
 * Service Desk P4 — migration 20261122090000_service_desk_audit_journal, AS the real roles, on the 1.3-0 lab with P4
 * applied by `prisma migrate deploy` (.sd3p4/lab.sh). Synthetic only; raw SQL only.
 *
 *   S  structure: the eight new enum values; the in-place CHECK; ServiceSettingsEvent ENABLE + FORCE RLS, SELECT / INSERT
 *      policies only, SELECT + INSERT to app_runtime only, nothing to PUBLIC; the three new functions with search_path …
 *      pg_temp last, exactly one SECURITY DEFINER (the erase), no PUBLIC execute; no existing function changed.
 *   E  the guards accept a status-preserving event — PROVEN for each of the four, as the runtime role, with the case
 *      version bumped and status / hold / outcome unchanged (also at IN_REPAIR with a hold); a record that changes status,
 *      a wrong action ↔ type pair, a seq that is not the version, free text in the payload, a non-owner actor: refused.
 *      Backward compatibility: an ordinary transition event still writes; earlier events are untouched.
 *   A  append-only: the runtime cannot UPDATE / DELETE (no privilege); the owner cannot UPDATE / DELETE / TRUNCATE; the
 *      runtime setting the erasure marker is still refused (marker + table owner); a removed user is SET NULL by the FK.
 *   R  RLS / isolation: another business neither sees nor inserts; no tenant context sees nothing.
 *   I  duplicates: the same idempotency key twice → unique; the same settings version twice → unique; a version the
 *      settings row is not at → refused; field names outside the closed set → refused; an acting user of another business
 *      → refused.
 *   X  account deletion: the erase refuses without context / when not deleting; when deleting it blanks the acting user
 *      and digest of every settings event of the business (count), a second run is 0, other businesses untouched, the
 *      rows stay (no orphans). The new case events are blanked by the EXISTING service_erase_business (unchanged).
 *   C  (COMBINED_1026=1) with #1026's migration also applied, in either order: one purge runs both doors and the new erase
 *      — settings row deleted, warranty texts anonymized, settings journal and case journal blanked, no error.
 *
 * env: OWNER_URL, RUNTIME_URL, COMBINED_1026 (optional).
 */
import { PrismaClient, Prisma } from "@prisma/client";

const withPool = (url: string) => `${url}${url.includes("?") ? "&" : "?"}connection_limit=8&pool_timeout=60`;
const owner = new PrismaClient({ datasourceUrl: withPool(process.env.OWNER_URL!) });
const runtime = new PrismaClient({ datasourceUrl: withPool(process.env.RUNTIME_URL!) });
let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); } else { failures.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}
type Rows = Record<string, unknown>[];
type Tx = Prisma.TransactionClient;
async function inTx<T>(c: PrismaClient, guc: number | null, fn: (tx: Tx) => Promise<T>): Promise<T | string> {
  return c.$transaction(async (tx) => {
    if (guc !== null) await tx.$executeRawUnsafe(`SELECT set_config('app.current_business_id', '${guc}', true)`);
    return fn(tx);
  }, { timeout: 60_000, maxWait: 60_000 }).catch((e: Error) => e.message);
}
const q = (c: PrismaClient, g: number | null, sql: string, ...a: unknown[]) => inTx(c, g, (tx) => tx.$queryRawUnsafe(sql, ...a) as Promise<Rows>);
const x = (c: PrismaClient, g: number | null, sql: string, ...a: unknown[]) => inTx(c, g, (tx) => tx.$executeRawUnsafe(sql, ...a));
const rows = (r: unknown): Rows => (Array.isArray(r) ? (r as Rows) : []);
const num = (r: unknown, k = "n") => Number(rows(r)[0]?.[k] ?? NaN);
const refused = (r: unknown, re: RegExp) => typeof r === "string" && re.test(r);
const succeeded = (r: unknown) => typeof r !== "string";
const DENIED = /permission denied/i;
const t = Date.now();
let ks = 0;
const ikey = () => `p4-lab-${t}-${String(++ks).padStart(5, "0")}`;
const HEX = (c: string) => c.repeat(64);

async function business(tag: string) {
  const one = async (sql: string, ...a: unknown[]) => num(await q(owner, null, sql, ...a), "id");
  const b = await one(`INSERT INTO "Business" (name, "updatedAt") VALUES ($1, now()) RETURNING id`, `p4-${tag}-${t}`);
  const u = await one(`INSERT INTO "User" (email, "businessId", "updatedAt") VALUES ($1, $2, now()) RETURNING id`, `p4-${tag}-${t}@lab.invalid`, b);
  const cust = await one(`INSERT INTO "Customer" ("businessId", name, "updatedAt") VALUES ($1, 'לקוח', now()) RETURNING id`, b);
  const staff = await one(`INSERT INTO "StaffMember" ("businessId", "displayName", "updatedAt") VALUES ($1, 'טכנאי', now()) RETURNING id`, b);
  return { b, u, cust, staff };
}
type B = Awaited<ReturnType<typeof business>>;

/** A case with its opening event, as the runtime (the 1.3a service's shape). */
async function openCase(z: B, kind = "FIELD"): Promise<number> {
  const r = await inTx(runtime, z.b, async (tx) => {
    const n = Number(((await tx.$queryRawUnsafe(`INSERT INTO "ServiceCaseNumberSequence" ("businessId", "nextValue", "updatedAt") VALUES ($1, 2, now())
      ON CONFLICT ("businessId") DO UPDATE SET "nextValue" = "ServiceCaseNumberSequence"."nextValue" + 1 RETURNING "nextValue" - 1 AS n`, z.b)) as Rows)[0].n);
    const id = Number(((await tx.$queryRawUnsafe(`INSERT INTO "ServiceCase" ("businessId", "caseNumber", kind, "customerId", "problemDescription", "updatedAt")
      VALUES ($1, $2, $3::"ServiceCaseKind", $4, 'תקלה', now()) RETURNING id`, z.b, n, kind, z.cust)) as Rows)[0].id);
    await tx.$executeRawUnsafe(`INSERT INTO "ServiceCaseEvent" ("businessId", "caseId", seq, "eventType", action, "fromStatus", "toStatus", "cancellationRequestedBefore", "cancellationRequestedAfter", actor, "actorUserId", payload, "idempotencyKey")
      VALUES ($1, $2, 1, 'case.opened', 'OPEN', NULL, 'OPEN', false, false, 'OWNER_USER', $3, '{}', $4)`, z.b, id, z.u, ikey());
    return id;
  });
  if (typeof r === "string") throw new Error(`openCase: ${r}`);
  return r;
}
type Ev = { type: string; action: string; from?: string; to?: string; payload?: string; actor?: string; seqDelta?: number; set?: string; holdBefore?: string | null; holdAfter?: string | null };
/** One event exactly as the service writes it: bump the case version (and apply `set`), then append seq = version. */
const event = (z: B, caseId: number, e: Ev) => inTx(runtime, z.b, async (tx) => {
  const c = ((await tx.$queryRawUnsafe(`SELECT status::text s, version v, "holdReason"::text h FROM "ServiceCase" WHERE id = $1 FOR UPDATE`, caseId)) as Rows)[0];
  const v = Number(c.v) + 1;
  await tx.$executeRawUnsafe(`UPDATE "ServiceCase" SET version = $2${e.set ? ", " + e.set : ""}, "updatedAt" = now() WHERE id = $1`, caseId, v);
  const after = ((await tx.$queryRawUnsafe(`SELECT status::text s, "holdReason"::text h FROM "ServiceCase" WHERE id = $1`, caseId)) as Rows)[0];
  await tx.$executeRawUnsafe(`INSERT INTO "ServiceCaseEvent" ("businessId", "caseId", seq, "eventType", action, "fromStatus", "toStatus", "holdReasonBefore", "holdReasonAfter",
      "cancellationRequestedBefore", "cancellationRequestedAfter", actor, "actorUserId", payload, "idempotencyKey")
    VALUES ($1, $2, $3, $4::"ServiceEventType", $5::"ServiceCaseAction", $6::"ServiceCaseStatus", $7::"ServiceCaseStatus", $8::"ServiceHoldReason", $9::"ServiceHoldReason",
      false, false, $10::"ServiceActor", $11, $12::jsonb, $13)`,
    z.b, caseId, v + (e.seqDelta ?? 0), e.type, e.action, e.from ?? String(c.s), e.to ?? String(after.s),
    e.holdBefore !== undefined ? e.holdBefore : (c.h ?? null), e.holdAfter !== undefined ? e.holdAfter : (after.h ?? null),
    e.actor ?? "OWNER_USER", (e.actor ?? "OWNER_USER") === "OWNER_USER" ? z.u : null, e.payload ?? "{}", ikey());
  return v;
});
const settingsEvent = (z: B, o: Partial<{ version: number; fields: string[]; key: string; user: number | null; biz: number; guc: number }> = {}) =>
  x(runtime, o.guc ?? z.b, `INSERT INTO "ServiceSettingsEvent" ("businessId", "settingsVersion", "changedFields", actor, "actorUserId", "idempotencyKey", "requestDigest", "digestKeyId")
    VALUES ($1, $2, $3::text[], 'OWNER_USER', $4, $5, $6, 'lab')`, o.biz ?? z.b, o.version ?? 1, o.fields ?? ["defaultStaffMemberId"], o.user === undefined ? z.u : o.user, o.key ?? ikey(), HEX("a"));

async function main() {
  console.log("S — structure");
  const labels = async (typ: string) => rows(await q(owner, null, `SELECT enumlabel l FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = $1`, typ)).map((r) => String(r.l));
  const et = await labels("ServiceEventType"), ca = await labels("ServiceCaseAction");
  ok("S1 four new event types and four new actions exist", ["case.technician_assigned", "intake.recorded", "coverage.recorded", "qa.recorded"].every((v) => et.includes(v))
    && ["ASSIGN_TECHNICIAN", "RECORD_INTAKE", "RECORD_COVERAGE", "RECORD_QA"].every((v) => ca.includes(v)));
  ok("S2 ServiceCaseEvent carries the in-place CHECK", num(await q(owner, null, `SELECT count(*)::int n FROM pg_constraint WHERE conname = 'ServiceCaseEvent_record_in_place'`)) === 1);
  const rls = rows(await q(owner, null, `SELECT relrowsecurity r, relforcerowsecurity f FROM pg_class WHERE relname = 'ServiceSettingsEvent'`))[0];
  const pols = rows(await q(owner, null, `SELECT cmd FROM pg_policies WHERE tablename = 'ServiceSettingsEvent' ORDER BY cmd`)).map((r) => String(r.cmd));
  ok("S3 ServiceSettingsEvent: ENABLE + FORCE RLS; per-command SELECT and INSERT policies only", rls?.r === true && rls?.f === true && JSON.stringify(pols) === '["INSERT","SELECT"]', JSON.stringify({ rls, pols }));
  const grants = rows(await q(owner, null, `SELECT grantee, privilege_type p FROM information_schema.role_table_grants WHERE table_name = 'ServiceSettingsEvent' AND grantee IN ('app_runtime', 'PUBLIC') ORDER BY 1, 2`));
  ok("S4 grants: SELECT + INSERT to app_runtime, nothing to PUBLIC", JSON.stringify(grants.map((g) => `${g.grantee}:${g.p}`)) === '["app_runtime:INSERT","app_runtime:SELECT"]', JSON.stringify(grants));
  const fns = rows(await q(owner, null, `SELECT proname p, prosecdef d, array_to_string(proconfig, ',') cfg, has_function_privilege('public', oid, 'EXECUTE') pub, has_function_privilege('app_runtime', oid, 'EXECUTE') rt
    FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('service_settings_event_matches', 'service_settings_event_guard', 'service_settings_journal_erase_business') ORDER BY 1`));
  ok("S5 three new functions, search_path … pg_temp last, only the erase is SECURITY DEFINER and runtime-executable, none PUBLIC",
    fns.length === 3 && fns.every((f) => f.cfg === "search_path=pg_catalog, public, pg_temp" && f.pub === false)
    && JSON.stringify(fns.filter((f) => f.d).map((f) => f.p)) === '["service_settings_journal_erase_business"]'
    && fns.find((f) => f.p === "service_settings_journal_erase_business")?.rt === true, JSON.stringify(fns));

  const A = await business("a"), Bz = await business("b");
  console.log("E — status-preserving events (the guards, proven)");
  const c1 = await openCase(A);
  const types: [string, string, string?, string?][] = [
    ["case.technician_assigned", "ASSIGN_TECHNICIAN", `"staffMemberId" = ${A.staff}`, `{"fromStaffMemberId":null,"toStaffMemberId":${A.staff}}`],
    ["intake.recorded", "RECORD_INTAKE", undefined, `{"conditionNoteChanged":true,"accessoriesNoteChanged":false,"conditionRecorded":true,"accessoriesRecorded":true}`],
    ["coverage.recorded", "RECORD_COVERAGE", `"coverageSource" = 'MANUFACTURER', "coverageDecision" = 'APPROVED'`, `{"source":"MANUFACTURER","decision":"APPROVED"}`],
    ["qa.recorded", "RECORD_QA", undefined, `{"items":4,"passed":4,"requiredFailed":0}`],
  ];
  for (const [type, action, set, payload] of types) {
    const r = await event(A, c1, { type, action, set, payload });
    ok(`E1 ${type}: version bumped, status unchanged — accepted by the existing guards`, succeeded(r), String(r));
  }
  const cs = rows(await q(owner, null, `SELECT status::text s, version v FROM "ServiceCase" WHERE id = $1`, c1))[0];
  ok("E2 the case stayed OPEN while its version moved 1 → 5; the journal is seq 1..5 without a gap", cs.s === "OPEN" && Number(cs.v) === 5
    && JSON.stringify(rows(await q(owner, null, `SELECT seq FROM "ServiceCaseEvent" WHERE "caseId" = $1 ORDER BY seq`, c1)).map((r) => Number(r.seq))) === "[1,2,3,4,5]");
  // At IN_REPAIR with a hold: move the case there the way the service would (CHECK_IN → START_DIAGNOSIS → START_REPAIR → SET_HOLD).
  for (const [type, action, set] of [["case.checked_in", "CHECK_IN", `status = 'CHECKED_IN'`], ["case.diagnosis_started", "START_DIAGNOSIS", `status = 'DIAGNOSING'`],
    ["repair.started", "START_REPAIR", `status = 'IN_REPAIR'`], ["hold.set", "SET_HOLD", `"holdReason" = 'PARTS'`]] as const) {
    const r = await event(A, c1, { type, action, set, ...(action === "SET_HOLD" ? { holdBefore: null, holdAfter: "PARTS" } : {}) });
    if (!succeeded(r)) throw new Error(`setup ${action}: ${r}`);
  }
  ok("E3 backward compatibility: ordinary transitions (CHECK_IN … SET_HOLD) still write", rows(await q(owner, null, `SELECT status::text s FROM "ServiceCase" WHERE id = $1`, c1))[0].s === "IN_REPAIR");
  ok("E4 a record at IN_REPAIR with a hold (hold unchanged) — accepted", succeeded(await event(A, c1, { type: "qa.recorded", action: "RECORD_QA", payload: `{"items":1,"passed":0,"requiredFailed":1}` })));
  ok("E5 a record that changes the status → refused (ServiceCaseEvent_record_in_place / matches_case)",
    refused(await event(A, c1, { type: "intake.recorded", action: "RECORD_INTAKE", set: `status = 'QA', "holdReason" = NULL`, holdAfter: null }), /record_in_place|SERVICE_EVENT_CASE_MISMATCH|check constraint/));
  ok("E6 a record that drops the hold → refused", refused(await event(A, c1, { type: "coverage.recorded", action: "RECORD_COVERAGE", set: `"holdReason" = NULL`, holdAfter: null }), /record_in_place|check constraint/));
  ok("E7 a wrong action ↔ type pair → refused", refused(await event(A, c1, { type: "qa.recorded", action: "ASSIGN_TECHNICIAN" }), /record_in_place|check constraint/)
    && refused(await event(A, c1, { type: "case.technician_assigned", action: "CHECK_IN" }), /record_in_place|check constraint/));
  ok("E8 a seq that is not the case version → refused (existing trigger)", refused(await event(A, c1, { type: "qa.recorded", action: "RECORD_QA", seqDelta: 1 }), /SERVICE_EVENT_CASE_MISMATCH/));
  ok("E9 free text in the payload → refused (existing closed-payload CHECK)", refused(await event(A, c1, { type: "intake.recorded", action: "RECORD_INTAKE", payload: `{"note":"שריטה בפינה"}` }), /payload_closed|check constraint/));
  ok("E10 a record by SYSTEM → refused (owner only)", refused(await event(A, c1, { type: "qa.recorded", action: "RECORD_QA", actor: "SYSTEM" }), /record_in_place|check constraint/));
  const firstEvents = JSON.stringify(rows(await q(owner, null, `SELECT seq, "eventType"::text t, payload::text p FROM "ServiceCaseEvent" WHERE "caseId" = $1 AND seq <= 5 ORDER BY seq`, c1)));
  ok("E11 the runtime still cannot UPDATE or DELETE a case event (append-only, unchanged)",
    refused(await x(runtime, A.b, `UPDATE "ServiceCaseEvent" SET payload = '{}' WHERE "caseId" = $1 AND seq = 2`, c1), /DENIED|SERVICE_EVENT_APPEND_ONLY|permission/i)
    && refused(await x(runtime, A.b, `DELETE FROM "ServiceCaseEvent" WHERE "caseId" = $1 AND seq = 2`, c1), /DENIED|SERVICE_EVENT_APPEND_ONLY|permission/i));

  console.log("I — the settings journal: shape and duplicates");
  ok("I0 no settings row yet → an event is refused (it must name the version just written)", refused(await settingsEvent(A), /SERVICE_SETTINGS_EVENT_MISMATCH/));
  await x(runtime, A.b, `INSERT INTO "ServiceSettings" ("businessId", "defaultStaffMemberId", "updatedAt") VALUES ($1, $2, now())`, A.b, A.staff);
  const k1 = ikey();
  ok("I1 an event for settings version 1 → written", succeeded(await settingsEvent(A, { key: k1 })));
  ok("I2 the same idempotency key again → refused (unique)", refused(await settingsEvent(A, { key: k1 }), /unique|duplicate|23505/i));
  ok("I3 the same settings version twice → refused (unique)", refused(await settingsEvent(A), /unique|duplicate|23505/i));
  ok("I4 a version the settings row is not at → refused", refused(await settingsEvent(A, { version: 7 }), /SERVICE_SETTINGS_EVENT_MISMATCH/));
  await x(runtime, A.b, `UPDATE "ServiceSettings" SET "defaultStaffMemberId" = NULL, version = 2, "updatedAt" = now() WHERE "businessId" = $1`, A.b);
  ok("I5 field names outside the closed set (or a value) → refused", refused(await settingsEvent(A, { version: 2, fields: ["warrantyTemplateScope"] }), /check constraint/)
    && refused(await settingsEvent(A, { version: 2, fields: ["אחריות 3 חודשים"] }), /check constraint/) && refused(await settingsEvent(A, { version: 2, fields: [] }), /check constraint/));
  ok("I6 an acting user of another business → refused", refused(await settingsEvent(A, { version: 2, user: Bz.u }), /SERVICE_USER|same business|DZS|check|violat/i));
  ok("I7 version 2 with two fields → written", succeeded(await settingsEvent(A, { version: 2, fields: ["defaultStaffMemberId", "warrantyTemplate"] })));

  console.log("A — append-only");
  ok("A1 the runtime cannot UPDATE or DELETE a settings event (no privilege)",
    refused(await x(runtime, A.b, `UPDATE "ServiceSettingsEvent" SET "changedFields" = '{warrantyTemplate}' WHERE "businessId" = $1`, A.b), DENIED)
    && refused(await x(runtime, A.b, `DELETE FROM "ServiceSettingsEvent" WHERE "businessId" = $1`, A.b), DENIED));
  ok("A2 the owner cannot UPDATE, DELETE or TRUNCATE it either", refused(await x(owner, null, `UPDATE "ServiceSettingsEvent" SET "actorUserId" = NULL WHERE "businessId" = $1`, A.b), /SERVICE_SETTINGS_EVENT_APPEND_ONLY/)
    && refused(await x(owner, null, `DELETE FROM "ServiceSettingsEvent" WHERE "businessId" = $1`, A.b), /SERVICE_SETTINGS_EVENT_APPEND_ONLY/)
    && refused(await x(owner, null, `TRUNCATE "ServiceSettingsEvent"`), /NO_TRUNCATE|SERVICE_JOURNAL/));
  ok("A3 the runtime setting the erasure marker itself is still refused (marker + table owner)",
    refused(await inTx(runtime, A.b, async (tx) => { await tx.$executeRawUnsafe(`SELECT set_config('dubiz.service_settings_journal_erasure', 'on', true)`);
      return tx.$executeRawUnsafe(`UPDATE "ServiceSettingsEvent" SET "actorUserId" = NULL, "requestDigest" = NULL, "digestKeyId" = NULL WHERE "businessId" = $1`, A.b); }), DENIED));
  const uTmp = num(await q(owner, null, `INSERT INTO "User" (email, "businessId", "updatedAt") VALUES ($1, $2, now()) RETURNING id AS n`, `p4-tmp-${t}@lab.invalid`, Bz.b));
  await x(runtime, Bz.b, `INSERT INTO "ServiceSettings" ("businessId", "updatedAt") VALUES ($1, now())`, Bz.b);
  await settingsEvent(Bz, { user: uTmp });
  ok("A4 removing a user: the FK sets the acting user NULL, the event stays", succeeded(await x(owner, null, `DELETE FROM "User" WHERE id = $1`, uTmp))
    && rows(await q(owner, null, `SELECT "actorUserId" a FROM "ServiceSettingsEvent" WHERE "businessId" = $1`, Bz.b))[0]?.a === null);

  console.log("R — RLS / isolation");
  ok("R1 another business sees none of A's settings events; no tenant context sees nothing",
    num(await q(runtime, Bz.b, `SELECT count(*)::int n FROM "ServiceSettingsEvent" WHERE "businessId" = $1`, A.b)) === 0
    && num(await q(runtime, null, `SELECT count(*)::int n FROM "ServiceSettingsEvent"`)) === 0
    && num(await q(runtime, A.b, `SELECT count(*)::int n FROM "ServiceSettingsEvent"`)) === 2);
  ok("R2 another business cannot insert an event for A (RLS WITH CHECK)", refused(await settingsEvent(A, { version: 2, guc: Bz.b, key: ikey() }), /row-level security|SERVICE_SETTINGS_EVENT_MISMATCH/));

  console.log("X — account deletion of the journal");
  ok("X1 the erase refuses without a tenant context, and for a business not being deleted",
    refused(await q(runtime, null, `SELECT public.service_settings_journal_erase_business() n`), /NO_CONTEXT/)
    && refused(await q(runtime, A.b, `SELECT public.service_settings_journal_erase_business() n`), /NOT_DELETING/));
  await x(owner, null, `UPDATE "Business" SET "deletionRequestedAt" = now() WHERE id = $1`, A.b);
  const xn = await inTx(runtime, A.b, async (tx) => {
    const n1 = Number(((await tx.$queryRawUnsafe(`SELECT public.service_settings_journal_erase_business() n`)) as Rows)[0].n);
    const n2 = Number(((await tx.$queryRawUnsafe(`SELECT public.service_erase_business() n`)) as Rows)[0].n);
    return { n1, n2 };
  });
  ok("X2 in one purge transaction: the new erase blanks A's two settings events; the existing service door blanks the case journal",
    succeeded(xn) && (xn as { n1: number }).n1 === 2, JSON.stringify(xn));
  const after = rows(await q(owner, null, `SELECT "actorUserId" a, "requestDigest" d, "digestKeyId" k, "settingsVersion" v, "changedFields"::text f FROM "ServiceSettingsEvent" WHERE "businessId" = $1 ORDER BY id`, A.b));
  ok("X3 the settings events stay (no orphans) with only version, field names, time and key — no user, no digest",
    after.length === 2 && after.every((r) => r.a === null && r.d === null && r.k === null) && after.map((r) => Number(r.v)).join() === "1,2");
  ok("X4 the new case events lost their acting user (the existing service_erase_business, unchanged)",
    num(await q(owner, null, `SELECT count(*)::int n FROM "ServiceCaseEvent" WHERE "caseId" = $1 AND "actorUserId" IS NOT NULL`, c1)) === 0);
  ok("X5 a second run of the erase changes nothing (0); business B untouched",
    num(await q(runtime, A.b, `SELECT public.service_settings_journal_erase_business() n`)) === 0
    && rows(await q(owner, null, `SELECT "requestDigest" d FROM "ServiceSettingsEvent" WHERE "businessId" = $1`, Bz.b))[0]?.d !== null);
  ok("X6 a business being deleted takes no new settings event (its settings writes are refused)",
    refused(await x(runtime, A.b, `UPDATE "ServiceSettings" SET version = 3, "updatedAt" = now() WHERE "businessId" = $1`, A.b), /SERVICE_UI_BUSINESS_DELETING|DZU02/));

  if (process.env.COMBINED_1026 === "1") {
    console.log("C — combined with #1026 (both migrations applied)");
    const C = await business("c");
    await x(runtime, C.b, `INSERT INTO "ServiceSettings" ("businessId", "defaultStaffMemberId", "warrantyTemplateValue", "warrantyTemplateUnit", "warrantyTemplateScope", "updatedAt")
      VALUES ($1, $2, 3, 'MONTHS', 'תבנית', now())`, C.b, C.staff);
    await settingsEvent(C);
    const cc = await openCase(C);
    await event(C, cc, { type: "case.technician_assigned", action: "ASSIGN_TECHNICIAN", set: `"staffMemberId" = ${C.staff}`, payload: `{"toStaffMemberId":${C.staff}}` });
    await x(owner, null, `UPDATE "Business" SET "deletionRequestedAt" = now() WHERE id = $1`, C.b);
    const purge = await inTx(runtime, C.b, async (tx) => {
      for (const fn of ["service_erase_business", "service_desk_ui_erase_business", "service_settings_journal_erase_business"]) await tx.$queryRawUnsafe(`SELECT public.${fn}() n`);
      return 1;
    });
    ok("C1 one purge runs the 1.2a door, the 1.3-0 door (#1026 version) and the new erase — no error", succeeded(purge), String(purge));
    ok("C2 #1026's policy took effect (settings row deleted) and P4's journal is blanked and kept",
      num(await q(owner, null, `SELECT count(*)::int n FROM "ServiceSettings" WHERE "businessId" = $1`, C.b)) === 0
      && rows(await q(owner, null, `SELECT "actorUserId" a, "requestDigest" d FROM "ServiceSettingsEvent" WHERE "businessId" = $1`, C.b)).every((r) => r.a === null && r.d === null)
      && num(await q(owner, null, `SELECT count(*)::int n FROM "ServiceSettingsEvent" WHERE "businessId" = $1`, C.b)) === 1);
    ok("C3 the case journal (with the new event) is blanked", num(await q(owner, null, `SELECT count(*)::int n FROM "ServiceCaseEvent" WHERE "caseId" = $1 AND "actorUserId" IS NOT NULL`, cc)) === 0);
  }
  ok("E12 earlier events were never rewritten", firstEvents === JSON.stringify(rows(await q(owner, null, `SELECT seq, "eventType"::text t, payload::text p FROM "ServiceCaseEvent" WHERE "caseId" = $1 AND seq <= 5 ORDER BY seq`, c1))));
}

main()
  .catch((e) => { failures.push(`crash: ${(e as Error).message}`); console.error(e); })
  .finally(async () => {
    console.log(`\n${pass} passed, ${failures.length} failed`);
    if (failures.length) console.log("FAILED:\n  " + failures.join("\n  "));
    await owner.$disconnect(); await runtime.$disconnect();
    process.exit(failures.length ? 1 : 0);
  });
