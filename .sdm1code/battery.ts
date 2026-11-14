/**
 * Service Desk M1 CODE — the seven tracks end to end through the REAL service (openCase, recordIntake, recordQa,
 * recordCharge, runCaseAction, chooseAfterSaleResolution) AS the runtime role, on the M1 chain (.sd3p4/lab.sh <db>,
 * --deploy-only, then .sdm1/chain.sh: #1096, #1104 and M1 applied). Every write passes the database guards of the real
 * migrations — the case guard (D3 / D14 / completion), the deferred journal and completion triggers, RLS. Synthetic only.
 *
 *   E  the seven tracks, T1 … T7, end to end (QA templates, D15, WORK_DONE → COMPLETE, handover, T7 resolutions);
 *      K  the after-sale second step's derived key: a 199 / 200-character client key refused cleanly, the derived key
 *      within the column CHECK in the database, a replay answered with no second effect
 *   C  COMPLETE: balance UNKNOWN blocks, an open balance needs the owner's reason, one immutable completion record,
 *      no customer signature anywhere, idempotent replay, stale version refused; the record stores the balance, the
 *      approving user + time of a debt (owner decision 2026-11-11) and an overpayment; UNKNOWN writes nothing
 *   D  CHANGE_DETAILS: journaled (event tokens + detail row with the values), D12, D3 binding, track enabled by the
 *      case's OWN snapshot (D14) — a later settings change never reaches an open case
 *   O  opening: profile snapshot taken now; track not enabled / subject not fitting → refused, nothing written
 *   L  legacy: a case without a track keeps today's rules
 *   I  isolation  ·  X  erasure: service_tracks_erase_business() scrubs what the service wrote
 *
 * env: OWNER_URL (lab owner — fixtures), DATABASE_URL = DIRECT_URL (app_runtime_prod), TASK_REQUEST_HMAC_KEY / _ID,
 *      AUTH_TOKEN_SECRET.
 */
import { PrismaClient } from "@prisma/client";

import { uuidV7 } from "../lib/services/tasks/task-idempotency";
import { ServiceDeskError } from "../lib/services/service-desk/service-desk-errors";
import {
  chooseAfterSaleResolution, openCase, recordIntake, recordQa, runCaseAction, type OpenCaseInput, type ServiceDeskPrincipal,
} from "../lib/services/service-desk/service-case.service";
import { recordCharge } from "../lib/services/service-desk/case-charge.service";
import { returnFromExternal, sendToExternal } from "../lib/services/service-desk/external-work.service";
import { QA_TEMPLATE_BY_ID } from "../lib/services/service-desk/qa-templates";
import { deriveIdempotencyKey } from "../lib/services/service-desk/idempotency-key";

const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });
const runtime = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL! });
let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); } else { failures.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}
type Rows = Record<string, unknown>[];
const q = (sql: string, ...a: unknown[]) => owner.$queryRawUnsafe(sql, ...a) as Promise<Rows>;
const x = (sql: string, ...a: unknown[]) => owner.$executeRawUnsafe(sql, ...a);
const key = () => uuidV7(new Date());
async function own(b: number, sql: string, ...a: unknown[]): Promise<Rows> {
  return owner.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('app.current_business_id', $1, true)`, String(b));
    return (await tx.$queryRawUnsafe(sql, ...a)) as Rows;
  });
}
async function rtRows(b: number, sql: string, ...a: unknown[]): Promise<Rows> {
  return runtime.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('app.current_business_id', $1, true)`, String(b));
    return (await tx.$queryRawUnsafe(sql, ...a)) as Rows;
  });
}
/** The service's answer: "OK" or the refusal (code + violations / check / field), never a stack. */
async function tryIt(f: () => Promise<unknown>): Promise<string> {
  try { await f(); return "OK"; } catch (e) {
    if (e instanceof ServiceDeskError) return `${e.code}:${JSON.stringify(e.details)}`;
    return `THROW:${(e as Error).message.replace(/\s+/g, " ").slice(-240)}`;
  }
}

const t = Date.now();
async function business(tag: string, settings?: { profile: string; overrides?: object }) {
  const b = Number((await q(`INSERT INTO "Business" (name, "updatedAt") VALUES ($1, now()) RETURNING id`, `sdm1code-${tag}-${t}`))[0].id);
  const u = Number((await q(`INSERT INTO "User" (email, "businessId", "updatedAt") VALUES ($1, $2, now()) RETURNING id`, `sdm1code-${tag}-${t}@lab.invalid`, b))[0].id);
  const cust = Number((await own(b, `INSERT INTO "Customer" ("businessId", name, "updatedAt") VALUES ($1, 'לקוח סינתטי', now()) RETURNING id`, b))[0].id);
  if (settings) {
    await rtRows(b, `INSERT INTO "ServiceSettings" ("businessId", version, "updatedAt", "serviceProfileKey", "profileOverrides") VALUES ($1, 1, now(), $2, $3::jsonb) RETURNING "businessId"`,
      b, settings.profile, settings.overrides ? JSON.stringify(settings.overrides) : null);
  }
  return { b, u, cust, p: { businessId: b, userId: u } as ServiceDeskPrincipal };
}
type Biz = Awaited<ReturnType<typeof business>>;
const PROBLEM = "תקלה סינתטית";
const open = async (z: Biz, input: Partial<OpenCaseInput>) =>
  (await openCase(z.p, { customerId: z.cust, problemDescription: PROBLEM, ...input }, { idempotencyKey: key() })).case;
type CaseRow = Record<string, unknown> & { version: number; status: string };
async function row(z: Biz, id: number): Promise<CaseRow> {
  const r = (await own(z.b, `SELECT version, status::text status, kind::text kind, outcome::text outcome, "workType"::text "workType",
      "serviceLocation"::text "serviceLocation", "siteAddress", "siteNotes", "profileKey", "profileSnapshot", "completionType"::text "completionType",
      "completedAt", "afterSaleResolution"::text "afterSaleResolution", "returnReason"::text "returnReason", "deviceId", "closedAt", "deliveredAt"
      FROM "ServiceCase" WHERE id = $1`, id))[0];
  return { ...r, version: Number(r.version), status: String(r.status) } as CaseRow;
}
/** One action through runCaseAction at the case's current version. */
async function act(z: Biz, id: number, action: Record<string, unknown>, k = key()): Promise<string> {
  const v = (await row(z, id)).version;
  return tryIt(() => runCaseAction(z.p, id, { action, expectedVersion: v }, { idempotencyKey: k }));
}
async function walk(z: Biz, id: number, actions: Record<string, unknown>[]): Promise<string> {
  for (const a of actions) {
    const r = await act(z, id, a);
    if (r !== "OK") return `${String(a.type)}: ${r}`;
  }
  return "OK";
}
const intake = async (z: Biz, id: number) => {
  const v = (await row(z, id)).version;
  return tryIt(() => recordIntake(z.p, id, { conditionNote: "שריטה בפינה", accessoriesNote: "ללא", conditionRecorded: true, accessoriesRecorded: true, expectedVersion: v }, { idempotencyKey: key() }));
};
const qa = async (z: Biz, id: number, template: string) => {
  const v = (await row(z, id)).version;
  const results = Object.fromEntries(QA_TEMPLATE_BY_ID[template].items.map((i) => [i.key, "PASS"]));
  return tryIt(() => recordQa(z.p, id, { results, expectedVersion: v }, { idempotencyKey: key() }));
};
const charge = async (z: Biz, id: number, body: { mode: string; amountAgorot?: number; reason?: string }) => {
  const v = (await row(z, id)).version;
  return tryIt(() => recordCharge(z.p, id, { ...body, expectedVersion: v }, { idempotencyKey: key() }));
};
const events = async (z: Biz, id: number) =>
  own(z.b, `SELECT seq, action::text action, "eventType"::text "eventType", "fromStatus"::text "fromStatus", "toStatus"::text "toStatus", payload, "idempotencyKey" FROM "ServiceCaseEvent" WHERE "caseId" = $1 ORDER BY seq`, id);
const count = async (z: Biz, table: string, id: number) => Number((await own(z.b, `SELECT count(*)::int n FROM "${table}" WHERE "caseId" = $1`, id))[0].n);
const done = (type: string, extra: Record<string, unknown> = {}) => ({ type: "COMPLETE", completion: { completionType: type, ownerConfirmed: true, ...extra } });

async function main() {
  // A: the general profile + T2 and T4 enabled by the owner (overrides); B: another business; C: the plain general profile.
  const A = await business("a", { profile: "general", overrides: { enabledTracks: ["T2", "T4"] } });
  const B = await business("b");
  const C = await business("c");

  console.log("E — the seven tracks, end to end, through the real service");
  {
    // T1 — repair at the business: intake confirmed by the owner, QA (IN_SHOP.v2), owner-confirmed handover
    const c = await open(A, { track: "T1", subject: { displayName: "טלפון סינתטי" } });
    const r0 = await row(A, c.id);
    ok("E1 T1 opens IN_SHOP / REPAIR / AT_BUSINESS with the profile snapshot taken now (D14)", r0.kind === "IN_SHOP" && r0.workType === "REPAIR" && r0.serviceLocation === "AT_BUSINESS" && r0.profileKey === "general" && r0.profileSnapshot !== null && r0.deviceId !== null, JSON.stringify({ k: r0.kind, w: r0.workType, p: r0.profileKey }));
    ok("E1 the intake must be confirmed (no signature): CHECK_IN without it refused", (await act(A, c.id, { type: "CHECK_IN", intakeConfirmed: true })).includes("INTAKE_INCOMPLETE"));
    const path = [await intake(A, c.id), await walk(A, c.id, [{ type: "CHECK_IN", intakeConfirmed: true }, { type: "START_DIAGNOSIS" }, { type: "START_REPAIR" }, { type: "FINISH_REPAIR" }]),
      await qa(A, c.id, "IN_SHOP.v2"), await walk(A, c.id, [{ type: "PASS_QA", outcome: "REPAIRED" }]),
      await charge(A, c.id, { mode: "NO_CHARGE", reason: "תיקון באחריות" }),
      await walk(A, c.id, [{ type: "DELIVER", receipt: { handoverConfirmed: true, receivedByName: "דנה" } }, { type: "CLOSE" }])];
    const r1 = await row(A, c.id);
    ok("E1 T1: intake → diagnosis → repair (D15: nothing committed) → QA → READY → handover → CLOSED", path.every((s) => s === "OK") && r1.status === "CLOSED", path.join(" | "));
    ok("E1 T1: a handover record, no completion record", (await count(A, "ServiceHandover", c.id)) === 1 && (await count(A, "ServiceCompletion", c.id)) === 0);
  }
  {
    // E1b — a failed QA round: the stamp of the earlier complete checklist does not carry into the next round
    const c = await open(A, { track: "T1", subject: { displayName: "טלפון סינתטי ב" } });
    const pre = [await intake(A, c.id), await walk(A, c.id, [{ type: "CHECK_IN", intakeConfirmed: true }, { type: "START_DIAGNOSIS" }, { type: "START_REPAIR" }, { type: "FINISH_REPAIR" }]),
      await qa(A, c.id, "IN_SHOP.v2"), await walk(A, c.id, [{ type: "FAIL_QA" }, { type: "FINISH_REPAIR" }])];
    const stamp = (await own(A.b, `SELECT "qaCompletedAt" FROM "ServiceCase" WHERE id = $1`, c.id))[0].qaCompletedAt;
    const again = await act(A, c.id, { type: "PASS_QA", outcome: "REPAIRED" });
    ok("E1b after FAIL_QA and a new repair the case is back in QA with no completion stamp", pre.every((s) => s === "OK") && (await row(A, c.id)).status === "QA" && stamp === null, pre.join(" | "));
    ok("E1b PASS_QA without a fresh checklist is refused (QA_INCOMPLETE)", again.includes("QA_INCOMPLETE"), again);
    const fresh = [await qa(A, c.id, "IN_SHOP.v2"), await walk(A, c.id, [{ type: "PASS_QA", outcome: "REPAIRED" }])];
    ok("E1b a fresh complete checklist lets PASS_QA through", fresh.every((s) => s === "OK") && (await row(A, c.id)).status === "READY", fresh.join(" | "));
  }
  {
    // E1d — the same rule on the supplier path: FAIL_QA → repair → (on hold) → external → back to QA. The send clears the hold
    // (CHECK ServiceCase_hold_only_in_repair) and the return into QA starts a new round: no stamp of the earlier checklist.
    const supplier = Number((await q(`INSERT INTO "Supplier" ("businessId", name, "updatedAt") VALUES ($1, 'ספק סינתטי', now()) RETURNING id`, A.b))[0].id);
    const c = await open(A, { track: "T1", subject: { displayName: "טלפון סינתטי ד" } });
    const pre = [await intake(A, c.id), await walk(A, c.id, [{ type: "CHECK_IN", intakeConfirmed: true }, { type: "START_DIAGNOSIS" }, { type: "START_REPAIR" }, { type: "FINISH_REPAIR" }]),
      await qa(A, c.id, "IN_SHOP.v2"), await walk(A, c.id, [{ type: "FAIL_QA" }, { type: "SET_HOLD", reason: "PARTS" }])];
    const sent = await tryIt(async () => sendToExternal(A.p, c.id, { expectedVersion: (await row(A, c.id)).version, supplierId: supplier, sendReason: "בדיקת ספק" }, { idempotencyKey: key() }));
    const hold = (await own(A.b, `SELECT "holdReason"::text h, status::text s FROM "ServiceCase" WHERE id = $1`, c.id))[0];
    ok("E1d SEND_TO_EXTERNAL from IN_REPAIR on hold: sent, the hold cleared (the core's holdReasonAfter)", pre.every((s) => s === "OK") && sent === "OK" && hold?.s === "EXTERNAL" && hold?.h === null, `${pre.join(" | ")} ${sent}`);
    const work = (await own(A.b, `SELECT id, version FROM "ServiceExternalWork" WHERE "caseId" = $1`, c.id))[0];
    const back = work ? await tryIt(async () => returnFromExternal(A.p, Number(work.id), { expectedVersion: Number(work.version), caseExpectedVersion: (await row(A, c.id)).version, next: "QA", result: "REPAIRED", followUpRequired: false }, { idempotencyKey: key() })) : "NO_WORK";
    const stamp = (await own(A.b, `SELECT "qaCompletedAt" FROM "ServiceCase" WHERE id = $1`, c.id))[0].qaCompletedAt;
    const again = await act(A, c.id, { type: "PASS_QA", outcome: "REPAIRED" });
    ok("E1d back from the supplier into QA: a new round with no completion stamp", back === "OK" && (await row(A, c.id)).status === "QA" && stamp === null, back);
    ok("E1d PASS_QA without a fresh checklist is refused (QA_INCOMPLETE)", again.includes("QA_INCOMPLETE"), again);
  }
  {
    // E1c — owner 2026-11-12: T1 QA is REQUIRED but its built-in IN_SHOP.v2 checklist is a suggestion: no check must PASS,
    // yet the checklist must have been performed (every check recorded) — a single click does not complete it.
    const c = await open(A, { track: "T1", subject: { displayName: "טלפון סינתטי ג" } });
    const pre = [await intake(A, c.id), await walk(A, c.id, [{ type: "CHECK_IN", intakeConfirmed: true }, { type: "START_DIAGNOSIS" }, { type: "START_REPAIR" }, { type: "FINISH_REPAIR" }])];
    const one = await tryIt(async () => { const v = (await row(A, c.id)).version; await recordQa(A.p, c.id, { results: { powers_on: "PASS" }, expectedVersion: v }, { idempotencyKey: key() }); return "OK"; });
    const stamp1 = (await own(A.b, `SELECT "qaCompletedAt" FROM "ServiceCase" WHERE id = $1`, c.id))[0].qaCompletedAt;
    const refused = await act(A, c.id, { type: "PASS_QA", outcome: "REPAIRED" });
    ok("E1c one recorded check on a REQUIRED track: stored, NOT completed, PASS_QA refused (QA_INCOMPLETE)",
      pre.every((s) => s === "OK") && one === "OK" && stamp1 === null && refused.includes("QA_INCOMPLETE"), `${pre.join(" | ")} ${one} ${refused}`);
    const allFail = await tryIt(async () => {
      const v = (await row(A, c.id)).version;
      await recordQa(A.p, c.id, { results: Object.fromEntries(QA_TEMPLATE_BY_ID["IN_SHOP.v2"].items.map((i) => [i.key, "FAIL"])), expectedVersion: v }, { idempotencyKey: key() });
      return "OK";
    });
    const stored = (await own(A.b, `SELECT "qaCompletedAt" IS NOT NULL done, "qaChecklist"->>'template' t FROM "ServiceCase" WHERE id = $1`, c.id))[0];
    ok("E1c every check recorded (all FAILED) → completed against IN_SHOP.v2 — no built-in check must PASS; the owner then decides FAIL_QA",
      allFail === "OK" && stored.done === true && stored.t === "IN_SHOP.v2", `${allFail} ${JSON.stringify(stored)}`);
    ok("E1c … FAIL_QA stays available (back to repair)", (await walk(A, c.id, [{ type: "FAIL_QA" }])) === "OK" && (await row(A, c.id)).status === "IN_REPAIR");
  }
  {
    // T2 — a vehicle at the business: VEHICLE.v1 checklist
    const c = await open(A, { track: "T2", subject: { displayName: "רכב סינתטי", attributes: { plate: "12-345-67", km: 120000 } } });
    const path = [await intake(A, c.id), await walk(A, c.id, [{ type: "CHECK_IN", intakeConfirmed: true }, { type: "START_DIAGNOSIS" }, { type: "START_REPAIR" }, { type: "FINISH_REPAIR" }])];
    ok("E2 T2: QA with the IN_SHOP checklist is refused (the track's template is VEHICLE.v1)", (await qa(A, c.id, "IN_SHOP.v2")).startsWith("INVALID_INPUT"));
    path.push(await qa(A, c.id, "VEHICLE.v1"), await walk(A, c.id, [{ type: "PASS_QA", outcome: "REPAIRED" }]));
    const sub = (await own(A.b, `SELECT "subjectKind"::text k, attributes FROM "ServiceDevice" WHERE id = (SELECT "deviceId" FROM "ServiceCase" WHERE id = $1)`, c.id))[0];
    ok("E2 T2: vehicle subject created with its attributes → QA (VEHICLE.v1) → READY", path.every((s) => s === "OK") && (await row(A, c.id)).status === "READY" && sub?.k === "VEHICLE", path.join(" | "));
    ok("E2 T2 needs a vehicle: opening with an ITEM subject refused (SUBJECT_DOES_NOT_FIT_TRACK)", (await tryIt(() => open(A, { track: "T2", subject: { kind: "ITEM" } }))).includes("SUBJECT_DOES_NOT_FIT_TRACK"));
  }
  let t3 = 0;
  {
    // T3 — on site: no intake, QA optional (skipped), WORK_DONE → owner-confirmed COMPLETE
    const c = await open(A, { track: "T3", siteAddress: "רחוב הדוגמה 1, עיר סינתטית" });
    t3 = c.id;
    const path = await walk(A, c.id, [{ type: "CHECK_IN" }, { type: "START_DIAGNOSIS" }, { type: "START_REPAIR" }, { type: "FINISH_REPAIR", outcome: "REPAIRED" }]);
    const r = await row(A, c.id);
    ok("E3 T3: arrival (no intake) → repair → FINISH_REPAIR skips the optional QA → WORK_DONE (outcome kept)", path === "OK" && r.status === "WORK_DONE" && r.outcome === "REPAIRED" && r.kind === "FIELD", path);
  }
  {
    // T4 — installation at a field site: QA required (INSTALLATION.v1), COMPLETED
    const c = await open(A, { track: "T4", serviceLocation: "FIELD_SITE", siteAddress: "אתר סינתטי 2" });
    const path = [await walk(A, c.id, [{ type: "CHECK_IN" }, { type: "START_DIAGNOSIS" }, { type: "START_REPAIR" }, { type: "FINISH_REPAIR" }]),
      await qa(A, c.id, "INSTALLATION.v1"), await walk(A, c.id, [{ type: "PASS_QA", outcome: "COMPLETED" }]),
      await charge(A, c.id, { mode: "NO_CHARGE", reason: "התקנה כלולה בעסקה" }),
      await act(A, c.id, done("OWNER_CONFIRMED_ON_SITE"))];
    const r = await row(A, c.id);
    ok("E4 T4: install → QA (INSTALLATION.v1) → COMPLETED → WORK_DONE → COMPLETE on site → CLOSED", path.every((s) => s === "OK") && r.status === "CLOSED" && r.outcome === "COMPLETED" && r.completionType === "OWNER_CONFIRMED_ON_SITE" && r.closedAt !== null && r.completedAt !== null, path.join(" | "));
  }
  {
    // T5 — professional service at the business: no intake, QA off, nothing held
    const c = await open(A, { track: "T5", serviceLocation: "AT_BUSINESS" });
    const path = [await walk(A, c.id, [{ type: "CHECK_IN" }, { type: "START_DIAGNOSIS" }, { type: "START_REPAIR" }, { type: "FINISH_REPAIR", outcome: "COMPLETED" }]),
      await charge(A, c.id, { mode: "NO_CHARGE", reason: "ייעוץ חינם" }), await act(A, c.id, done("OWNER_CONFIRMED_AT_BUSINESS"))];
    ok("E5 T5 at the business: no intake, no QA → COMPLETED → COMPLETE at the business", path.every((s) => s === "OK") && (await row(A, c.id)).status === "CLOSED", path.join(" | "));
    const c2 = await open(A, { track: "T5", serviceLocation: "AT_BUSINESS" });
    await walk(A, c2.id, [{ type: "CHECK_IN" }]);
    ok("E5 T5: a cancel → CANCELLED (no item held, no reason required)", (await act(A, c2.id, { type: "CANCEL" })) === "OK" && (await row(A, c2.id)).status === "CANCELLED");
  }
  {
    // T6 — remote support
    const c = await open(A, { track: "T6" });
    const path = [await walk(A, c.id, [{ type: "CHECK_IN" }, { type: "START_DIAGNOSIS" }, { type: "START_REPAIR" }, { type: "FINISH_REPAIR", outcome: "COMPLETED" }]),
      await charge(A, c.id, { mode: "NO_CHARGE", reason: "תמיכה בחוזה" })];
    ok("E6 T6: the completion type must be the place: ON_SITE refused for remote work", (await act(A, c.id, done("OWNER_CONFIRMED_ON_SITE"))).includes("COMPLETION_TYPE_MISMATCH"));
    path.push(await act(A, c.id, done("OWNER_CONFIRMED_REMOTE")));
    const r = await row(A, c.id);
    ok("E6 T6 opens REMOTE / REMOTE and completes remotely", path.every((s) => s === "OK") && r.kind === "REMOTE" && r.status === "CLOSED" && r.completionType === "OWNER_CONFIRMED_REMOTE", path.join(" | "));
  }
  {
    // T7 — after-sale: CREDIT (no approval, no QA → WORK_DONE; COMPLETE needs the linked credit note), RETURN_ORIGINAL,
    // EXCHANGE refused
    const c = await open(A, { track: "T7", returnReason: "DEFECT", originalSaleRef: "INV-2026-0001", subject: { displayName: "מוצר שהוחזר" } });
    const path = [await intake(A, c.id), await walk(A, c.id, [{ type: "CHECK_IN", intakeConfirmed: true }, { type: "START_DIAGNOSIS" }])];
    const before = (await row(A, c.id)).version;
    ok("E7 T7 EXCHANGE refused before anything is written (EXCHANGE_NEEDS_INVENTORY)",
      (await tryIt(() => chooseAfterSaleResolution(A.p, c.id, { resolution: "EXCHANGE", expectedVersion: before }, { idempotencyKey: key() }))).includes("EXCHANGE_NEEDS_INVENTORY") && (await row(A, c.id)).version === before);
    path.push(await tryIt(() => chooseAfterSaleResolution(A.p, c.id, { resolution: "CREDIT", expectedVersion: before }, { idempotencyKey: key() })));
    const r = await row(A, c.id);
    const ev = await events(A, c.id);
    const last2 = ev.slice(-2);
    ok("E7 T7 CREDIT: resolution recorded, START_REPAIR + FINISH_REPAIR COMPLETED in one command → WORK_DONE", path.every((s) => s === "OK") && r.afterSaleResolution === "CREDIT" && r.status === "WORK_DONE" && r.outcome === "COMPLETED", path.join(" | "));
    ok("E7 …two journal events: the first names the resolution, the second's key is the request key + #2",
      last2.length === 2 && last2[0].action === "START_REPAIR" && (last2[0].payload as Record<string, unknown>).afterSaleResolution === "CREDIT" && last2[1].action === "FINISH_REPAIR" && String(last2[1].idempotencyKey) === `${String(last2[0].idempotencyKey)}#2`);
    ok("E7 a resolution is chosen once", (await tryIt(() => chooseAfterSaleResolution(A.p, c.id, { resolution: "REPAIR", expectedVersion: r.version }, { idempotencyKey: key() }))).includes("RESOLUTION_ALREADY_CHOSEN"));
    await charge(A, c.id, { mode: "NO_CHARGE", reason: "זיכוי — ללא חיוב שירות" });
    ok("E7 COMPLETE without the linked credit note → CREDIT_DOCUMENT_REQUIRED", (await act(A, c.id, done("OWNER_CONFIRMED_AT_BUSINESS"))).includes("CREDIT_DOCUMENT_REQUIRED"));
    const c2 = await open(A, { track: "T7", returnReason: "NOT_AS_DESCRIBED" });
    await intake(A, c2.id);
    await walk(A, c2.id, [{ type: "CHECK_IN", intakeConfirmed: true }, { type: "START_DIAGNOSIS" }]);
    const v2 = (await row(A, c2.id)).version;
    const back = await tryIt(() => chooseAfterSaleResolution(A.p, c2.id, { resolution: "RETURN_ORIGINAL", expectedVersion: v2 }, { idempotencyKey: key() }));
    const r2 = await row(A, c2.id);
    ok("E7 RETURN_ORIGINAL → READY (NOT_REPAIRED), the item goes back through the owner-confirmed handover", back === "OK" && r2.status === "READY" && r2.outcome === "NOT_REPAIRED", back);
    ok("E7 a T7 opening needs a return reason", (await tryIt(() => open(A, { track: "T7" }))).includes("RETURN_REASON_REQUIRED"));

    // K — the derived key of the second step (deriveIdempotencyKey): a long client key answers cleanly (never a
    // constraint error), a replay is recognised and has no second effect.
    const c3 = await open(A, { track: "T7", returnReason: "DEFECT" });
    await intake(A, c3.id);
    await walk(A, c3.id, [{ type: "CHECK_IN", intakeConfirmed: true }, { type: "START_DIAGNOSIS" }]);
    const v3 = (await row(A, c3.id)).version;
    const n3 = (await events(A, c3.id)).length;
    const long = [199, 200].map((n) => "a".repeat(n));
    const longAns: string[] = [];
    for (const lk of long) longAns.push(await tryIt(() => chooseAfterSaleResolution(A.p, c3.id, { resolution: "CREDIT", expectedVersion: v3 }, { idempotencyKey: lk })));
    ok("K1 a 199- / 200-character client key → IDEMPOTENCY_KEY_INVALID (a clean answer, not a constraint error), nothing written",
      longAns.every((s) => s.startsWith("IDEMPOTENCY_KEY_INVALID")) && (await row(A, c3.id)).version === v3 && (await events(A, c3.id)).length === n3, longAns.join(" | "));
    const tokensDef = String((await q(`SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conname = 'ServiceCaseEvent_tokens'`))[0]?.d ?? "");
    const derivedLong = long.map((lk) => deriveIdempotencyKey(lk, 2));
    const fits = await q(`SELECT bool_and(k ~ '^[A-Za-z0-9:_#-]{8,200}$') ok FROM unnest($1::text[]) k`, derivedLong);
    ok("K2 the column CHECK is ^[A-Za-z0-9:_#-]{8,200}$ and the derived key of a 199- / 200-character key satisfies it in the database",
      tokensDef.includes("^[A-Za-z0-9:_#-]{8,200}$") && fits[0]?.ok === true && derivedLong.every((d) => d.length <= 200), { lens: derivedLong.map((d) => d.length), tokensDef: tokensDef.slice(0, 120) });
    const k3 = key();
    const first3 = await chooseAfterSaleResolution(A.p, c3.id, { resolution: "CREDIT", expectedVersion: v3 }, { idempotencyKey: k3 });
    const afterFirst = { r: await row(A, c3.id), ev: await events(A, c3.id) };
    const replay3 = await chooseAfterSaleResolution(A.p, c3.id, { resolution: "CREDIT", expectedVersion: v3 }, { idempotencyKey: k3 });
    const afterReplay = { r: await row(A, c3.id), ev: await events(A, c3.id) };
    ok("K3 after-sale with a key: two events, the first keyed by the request key, the second by deriveIdempotencyKey(key, 2)",
      first3.replayed === false && afterFirst.ev.length === n3 + 2 && String(afterFirst.ev[n3].idempotencyKey) === k3 && String(afterFirst.ev[n3 + 1].idempotencyKey) === deriveIdempotencyKey(k3, 2));
    ok("K4 the same request again → replayed, no second effect (same version, same events, same resolution and status)",
      replay3.replayed === true && afterReplay.r.version === afterFirst.r.version && afterReplay.ev.length === afterFirst.ev.length
      && afterReplay.r.afterSaleResolution === "CREDIT" && afterReplay.r.status === afterFirst.r.status);
  }

  console.log("C — COMPLETE on T3: the balance, the record, replay");
  {
    const id = t3;
    ok("C1 no charge recorded → BALANCE_UNKNOWN (never read as zero)", (await act(A, id, done("OWNER_CONFIRMED_ON_SITE"))).includes("BALANCE_UNKNOWN"));
    ok("C2 a charge can be recorded in WORK_DONE", (await charge(A, id, { mode: "CHARGEABLE", amountAgorot: 25_000 })) === "OK");
    ok("C3 open balance 250 ₪ without the owner's decision → refused", (await act(A, id, done("OWNER_CONFIRMED_ON_SITE"))).includes("OPEN_BALANCE_NEEDS_OWNER_DECISION"));
    ok("C4 not confirmed by the owner → refused", (await act(A, id, { ...done("OWNER_CONFIRMED_ON_SITE"), completion: { completionType: "OWNER_CONFIRMED_ON_SITE", ownerConfirmed: false } })).includes("COMPLETION_NOT_CONFIRMED"));
    const v = (await row(A, id)).version;
    ok("C5 a stale version → VERSION_CONFLICT", (await tryIt(() => runCaseAction(A.p, id, { action: done("OWNER_CONFIRMED_ON_SITE", {}), expectedVersion: v - 1 }, { idempotencyKey: key() }))).startsWith("VERSION_CONFLICT"));
    const k = key();
    const body = { ...done("OWNER_CONFIRMED_ON_SITE", { confirmedByName: "  יוסי (סינתטי) ", note: "הוחלף ממסר" }), debtOverride: { reason: "לקוח קבוע — ישלם בסוף החודש" } };
    const first = await tryIt(() => runCaseAction(A.p, id, { action: body, expectedVersion: v }, { idempotencyKey: k }));
    const replay = await tryIt(() => runCaseAction(A.p, id, { action: body, expectedVersion: v }, { idempotencyKey: k }));
    const r = await row(A, id);
    const rec = (await own(A.b, `SELECT "completionType"::text t, "confirmedByName" n, note, "actorUserId" u, "openBalanceAgorot" bal, "debtOverrideReason" why FROM "ServiceCompletion" WHERE "caseId" = $1`, id));
    ok("C6 with the owner's debt decision → CLOSED, completion stamped, outcome kept", first === "OK" && r.status === "CLOSED" && r.completionType === "OWNER_CONFIRMED_ON_SITE" && r.outcome === "REPAIRED", first);
    ok("C7 the same request again → replayed, still one completion record", replay === "OK" && rec.length === 1);
    ok("C8b the record keeps the balance and the owner's documented debt reason (handover rule)", Number(rec[0]?.bal) === 25_000 && rec[0]?.why === "לקוח קבוע — ישלם בסוף החודש", JSON.stringify({ bal: rec[0]?.bal, why: rec[0]?.why }));
    ok("C8 the record: trimmed name, note, the acting user — and no signature column exists", rec[0]?.n === "יוסי (סינתטי)" && rec[0]?.note === "הוחלף ממסר" && Number(rec[0]?.u) === A.u
      && (await q(`SELECT count(*)::int n FROM information_schema.columns WHERE table_name = 'ServiceCompletion' AND column_name ILIKE '%signat%'`))[0].n === 0);
    const ev = (await events(A, id)).at(-1)!;
    const payload = JSON.stringify(ev.payload);
    ok("C9 the journal: COMPLETE WORK_DONE → CLOSED, the debt and balance as tokens, no name / note / reason text", ev.action === "COMPLETE" && ev.toStatus === "CLOSED"
      && (ev.payload as Record<string, unknown>).debtOverride === true && Number((ev.payload as Record<string, unknown>).openBalanceAgorot) === 25_000
      && !payload.includes("יוסי") && !payload.includes("ממסר") && !payload.includes("לקוח קבוע"));
    ok("C10 a closed case is final: COMPLETE again → refused", (await act(A, id, done("OWNER_CONFIRMED_ON_SITE"))).includes("TERMINAL_STATUS"));
    // Owner decision 2026-11-11: closing with an open debt = explicit approval stored with the record.
    const appr = (await own(A.b, `SELECT "debtApprovedByUserId" a, ("debtApprovedAt" IS NOT NULL AND "debtApprovedAt" <= "completedAt") t, "overpaidAgorot" o FROM "ServiceCompletion" WHERE "caseId" = $1`, id))[0];
    ok("C11 the debt record names the approving user (the acting owner) and the approval time; no overpayment", Number(appr?.a) === A.u && appr?.t === true && Number(appr?.o) === 0, JSON.stringify(appr));
    const clean = (await own(A.b, `SELECT count(*)::int n FROM "ServiceCompletion" WHERE "businessId" = $1 AND "openBalanceAgorot" = 0
        AND ("debtOverrideReason" IS NOT NULL OR "debtApprovedByUserId" IS NOT NULL OR "debtApprovedAt" IS NOT NULL)`, A.b))[0];
    ok("C12 completions without a debt (T4 / T5 / T6, NO_CHARGE) carry no reason, approver or approval time", Number(clean.n) === 0, JSON.stringify(clean));
  }
  {
    // An overpaid case (the billing facts stubbed through the reader seam): the overpayment is stored, not only journaled;
    // an UNKNOWN balance first blocks and writes nothing.
    const c = await open(A, { track: "T3", siteAddress: "רחוב העודף 7" });
    await walk(A, c.id, [{ type: "CHECK_IN" }, { type: "START_DIAGNOSIS" }, { type: "START_REPAIR" }, { type: "FINISH_REPAIR", outcome: "REPAIRED" }]);
    const unknownReader = async () => ({ state: "UNKNOWN", openBalanceAgorot: null, reason: "READ_ERROR" }) as const;
    const overReader = async () => ({ state: "SETTLED", openBalanceAgorot: 0, overpaidAgorot: 1_200 }) as const;
    const v = (await row(A, c.id)).version;
    const blocked = await tryIt(() => runCaseAction(A.p, c.id, { action: done("OWNER_CONFIRMED_ON_SITE"), expectedVersion: v }, { idempotencyKey: key() }, { settlement: unknownReader }));
    ok("C13 an UNKNOWN balance → BALANCE_UNKNOWN, no completion record, the case stays WORK_DONE",
      blocked.includes("BALANCE_UNKNOWN") && (await count(A, "ServiceCompletion", c.id)) === 0 && (await row(A, c.id)).status === "WORK_DONE", blocked);
    const paid = await tryIt(() => runCaseAction(A.p, c.id, { action: done("OWNER_CONFIRMED_ON_SITE"), expectedVersion: v }, { idempotencyKey: key() }, { settlement: overReader }));
    const rec = (await own(A.b, `SELECT "openBalanceAgorot" b, "overpaidAgorot" o, "debtOverrideReason" r, "debtApprovedByUserId" a, "debtApprovedAt" t FROM "ServiceCompletion" WHERE "caseId" = $1`, c.id))[0];
    const ev = (await events(A, c.id)).at(-1)!;
    ok("C14 an overpaid case closes; the record stores the overpayment (1,200 agorot) with no debt approval, and the journal shows it",
      paid === "OK" && Number(rec?.b) === 0 && Number(rec?.o) === 1_200 && rec?.r === null && rec?.a === null && rec?.t === null
        && Number((ev.payload as Record<string, unknown>).overpaidAgorot) === 1_200, `${paid} ${JSON.stringify(rec)}`);
  }

  console.log("D — CHANGE_DETAILS through the service");
  {
    const c = await open(A, { track: "T3", siteAddress: "רחוב ישן 1" });
    const change = (next: Record<string, unknown>, extra: Record<string, unknown> = {}) => act(A, c.id, { type: "CHANGE_DETAILS", next: { kind: "FIELD", workType: "REPAIR", serviceLocation: "AT_CUSTOMER", siteAddress: "רחוב ישן 1", returnReason: null, ...next }, ...extra });
    const r1 = await change({ siteAddress: "רחוב חדש 9" }, { reason: "הלקוח עבר דירה" });
    const r = await row(A, c.id);
    const d = (await own(A.b, `SELECT "caseVersion" v, "changedFields" f, "siteAddressBefore" b, "siteAddressAfter" a, reason FROM "ServiceCaseDetailChange" WHERE "caseId" = $1`, c.id))[0];
    const ev = (await events(A, c.id)).at(-1)!;
    ok("D1 a new address: case updated, detail row at the event's seq with before / after / reason", r1 === "OK" && r.siteAddress === "רחוב חדש 9" && Number(d?.v) === r.version && d?.b === "רחוב ישן 1" && d?.a === "רחוב חדש 9" && d?.reason === "הלקוח עבר דירה", r1);
    ok("D2 the journal event: CHANGE_DETAILS in place, field names only", ev.action === "CHANGE_DETAILS" && ev.fromStatus === "OPEN" && ev.toStatus === "OPEN" && (ev.payload as Record<string, unknown>).changedFields === "siteAddress" && !JSON.stringify(ev.payload).includes("רחוב"));
    ok("D3 to professional work on site (T5) → allowed", (await change({ workType: "PROFESSIONAL", siteAddress: "רחוב חדש 9" })) === "OK");
    // Owner decision 2026-11-11 (universal service): every track is open to every business, whatever its category or profile.
    const cC = await open(C, { track: "T3", siteAddress: "רחוב 3" });
    ok("D4 universal: to installation (T4) on a business that never enabled it → allowed",
      (await act(C, cC.id, { type: "CHANGE_DETAILS", next: { kind: "FIELD", workType: "INSTALLATION", serviceLocation: "AT_CUSTOMER", siteAddress: "רחוב 3", returnReason: null } })) === "OK"
      && (await row(C, cC.id)).workType === "INSTALLATION");
    const cS = await open(C, { track: "T1" });
    ok("D5 universal: a repair at the business moves on site before work starts (T1 → T3) — allowed",
      (await act(C, cS.id, { type: "CHANGE_DETAILS", next: { kind: "FIELD", workType: "REPAIR", serviceLocation: "AT_CUSTOMER", siteAddress: "רחוב 4", returnReason: null } })) === "OK"
      && (await row(C, cS.id)).serviceLocation === "AT_CUSTOMER");
    const c1 = await open(A, { track: "T1" });
    await intake(A, c1.id);
    ok("D6 D12: an intake was started at the business — moving on site refused",
      (await act(A, c1.id, { type: "CHANGE_DETAILS", next: { kind: "FIELD", workType: "REPAIR", serviceLocation: "AT_CUSTOMER", siteAddress: "רחוב 5", returnReason: null } })).includes("INTAKE_STARTED_AT_BUSINESS"));
    await walk(A, c1.id, [{ type: "CHECK_IN", intakeConfirmed: true }]);
    ok("D7 past OPEN / SCHEDULED nothing changes", (await act(A, c1.id, { type: "CHANGE_DETAILS", next: { kind: "IN_SHOP", workType: "MAINTENANCE", serviceLocation: "AT_BUSINESS", siteAddress: null, returnReason: null } })).includes("INVALID_TRANSITION"));
  }

  console.log("O — opening");
  {
    // Universal: the business category never decides the profile, tracks or requirements (owner decision 2026-11-11).
    await q(`INSERT INTO "BusinessProfile" ("businessId", category, "subCategory", "updatedAt") VALUES ($1, $2, $3, now())`, C.b, "automotive", "garage").catch(() => undefined);
    const o1 = await tryIt(async () => { const c = await open(C, { track: "T2", subject: { kind: "VEHICLE" } }); const r = await row(C, c.id); if (r.profileKey !== "general") throw new Error(String(r.profileKey)); });
    ok("O1 universal: any track opens on any business; the category does not pick the profile (general unless the owner chose one)", o1 === "OK", o1);
    ok("O2 an address at the business is refused", (await tryIt(() => open(A, { track: "T1", siteAddress: "x" }))).startsWith("INVALID_INPUT"));
    ok("O3 a kind contradicting the track is refused", (await tryIt(() => open(A, { track: "T6", kind: "IN_SHOP" }))).startsWith("INVALID_INPUT"));
    ok("O4 track fields without a track are refused", (await tryIt(() => open(A, { kind: "IN_SHOP", siteAddress: "x" }))).startsWith("INVALID_INPUT"));
    ok("O5 REMOTE without a track is refused", (await tryIt(() => open(A, { kind: "REMOTE" }))).includes("TRACK_REQUIRED"));
  }

  console.log("L — legacy (no track)");
  {
    const c = await open(A, { kind: "FIELD" });
    const r = await row(A, c.id);
    const path = await walk(A, c.id, [{ type: "CHECK_IN" }, { type: "START_DIAGNOSIS" }]);
    ok("L1 opened without a track: no snapshot, no work type; START_REPAIR still needs a cover (today's rule)", r.profileSnapshot === null && r.workType === null && path === "OK" && (await act(A, c.id, { type: "START_REPAIR" })).includes("COVERAGE_NOT_APPROVED"));
    ok("L2 MARK_NOT_REPAIRABLE → READY (today's handover)", (await act(A, c.id, { type: "MARK_NOT_REPAIRABLE" })) === "OK" && (await row(A, c.id)).status === "READY");
  }

  console.log("I — isolation");
  ok("I1 another business cannot act on the case (NOT_FOUND)", (await tryIt(() => runCaseAction(B.p, t3, { action: { type: "CANCEL" }, expectedVersion: 1 }, { idempotencyKey: key() }))).startsWith("NOT_FOUND"));
  ok("I2 …nor choose its after-sale resolution", (await tryIt(() => chooseAfterSaleResolution(B.p, t3, { resolution: "CREDIT", expectedVersion: 1 }, { idempotencyKey: key() }))).startsWith("NOT_FOUND"));

  console.log("X — erasure of what the service wrote");
  {
    await x(`UPDATE "Business" SET "deletionRequestedAt" = now() WHERE id = $1`, A.b);
    const n = Number((await rtRows(A.b, `SELECT public.service_tracks_erase_business() AS n`))[0].n);
    const left = (await own(A.b, `SELECT
        (SELECT count(*)::int FROM "ServiceCase" WHERE "businessId" = $1 AND ("siteAddress" IS NOT NULL OR "siteNotes" IS NOT NULL OR "originalSaleRef" IS NOT NULL)) c,
        (SELECT count(*)::int FROM "ServiceDevice" WHERE "businessId" = $1 AND ("displayName" IS NOT NULL OR attributes IS NOT NULL)) d,
        (SELECT count(*)::int FROM "ServiceCompletion" WHERE "businessId" = $1 AND ("confirmedByName" IS NOT NULL OR note IS NOT NULL OR "debtOverrideReason" IS NOT NULL OR "actorUserId" IS NOT NULL
           OR "debtApprovedByUserId" IS NOT NULL)) k,
        (SELECT count(*)::int FROM "ServiceCompletion" WHERE "businessId" = $1 AND "openBalanceAgorot" = 25000 AND "debtApprovedAt" IS NOT NULL) "debtKept",
        (SELECT count(*)::int FROM "ServiceCompletion" WHERE "businessId" = $1 AND "overpaidAgorot" = 1200) "overKept",
        (SELECT count(*)::int FROM "ServiceCaseDetailChange" WHERE "businessId" = $1 AND (reason IS NOT NULL OR "siteAddressBefore" IS NOT NULL OR "siteAddressAfter" IS NOT NULL OR "actorUserId" IS NOT NULL)) h,
        (SELECT count(*)::int FROM "ServiceCompletion" WHERE "businessId" = $1) kept`, A.b))[0];
    ok("X1 the tracks erasure scrubs every M1 personal column the service wrote; the records themselves stay", n > 0 && Number(left.c) === 0 && Number(left.d) === 0 && Number(left.k) === 0 && Number(left.h) === 0 && Number(left.kept) >= 3, JSON.stringify(left));
    ok("X1b …the debt reason and approver are cleared; the balance, the approval time and the overpayment stay", Number(left.debtKept) === 1 && Number(left.overKept) === 1, JSON.stringify(left));
    const other = (await own(C.b, `SELECT count(*)::int n FROM "ServiceCase" WHERE "businessId" = $1 AND "siteAddress" IS NOT NULL`, C.b))[0];
    ok("X2 another business is untouched", Number(other.n) >= 1);
  }

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) console.log(failures.map((f) => `  - ${f}`).join("\n"));
  await owner.$disconnect();
  await runtime.$disconnect();
  process.exit(failures.length ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await owner.$disconnect();
  await runtime.$disconnect();
  process.exit(1);
});
