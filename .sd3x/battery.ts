/**
 * Service Desk 1.3-0 — migration 20261121090000_service_desk_ui_erasure_text, AS the real roles, in two phases on one
 * database (.sd3x/lab.sh):
 *
 *   PHASE=pre   (1.3-0 applied, 20261121090000 pending) — fixtures, and business P erased with the APPLIED door, which
 *               keeps P's warranty texts and settings: the state any business erased before this migration is in.
 *   PHASE=post  (after `prisma migrate deploy` applied 20261121090000):
 *     X1 structure: the door is still the only SECURITY DEFINER of the three, search_path … pg_temp last, no PUBLIC
 *        execute, the runtime may execute the door; the two guards are not definers; the door now names ServiceSettings
 *        and the placeholder.
 *     X2 nothing opened for the runtime: it still cannot delete settings or rewrite a presented / locked offer's texts,
 *        not even after setting the scrub marker itself (marker + table owner); the owner without the marker cannot
 *        delete settings either.
 *     X3 the door still refuses a business that is not being deleted, and a call without tenant context.
 *     X4 a purge that fails after the door: settings and texts intact (rolled back together).
 *     X5 the door on E: settings row deleted; every offer (DRAFT, PRESENTED, LOCKED, SUPERSEDED) gets scopeText =
 *        '[נמחק]', exclusionsText NULL, erasedAt set, user references NULL; state, duration, dates, quote version,
 *        statutory notice, contentSha256, seq, case are unchanged; ServiceTextVersion.body unchanged.
 *     X6 a second run changes nothing (0).
 *     X7 P (erased by the previous version, texts kept): the new door completes it — texts replaced, settings deleted.
 *     X8 neighbour K (not being deleted): settings and offer texts untouched.
 *
 * env: OWNER_URL, RUNTIME_URL, PHASE. Synthetic only. Raw SQL only.
 */
import { createHash } from "node:crypto";
import { PrismaClient, Prisma } from "@prisma/client";

const PH = "[נמחק]";
const PHASE = process.env.PHASE;
const withPool = (url: string) => `${url}${url.includes("?") ? "&" : "?"}connection_limit=8&pool_timeout=60`;
const owner = new PrismaClient({ datasourceUrl: withPool(process.env.OWNER_URL!) });
const runtime = new PrismaClient({ datasourceUrl: withPool(process.env.RUNTIME_URL!) });

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { failures.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}
type Rows = Record<string, unknown>[];
type Tx = Prisma.TransactionClient;
async function inTx<T>(client: PrismaClient, guc: number | null, fn: (tx: Tx) => Promise<T>): Promise<T | string> {
  return client.$transaction(async (tx) => {
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
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
let keySeq = 0;
const ikey = () => `sd3x-lab-key-${String(++keySeq).padStart(6, "0")}-${Date.now()}`;
const one = async (sql: string, ...a: unknown[]) => num(await q(owner, null, sql, ...a), "id");

async function business(name: string) {
  const biz = await one(`INSERT INTO "Business" (name, "updatedAt") VALUES ($1, now()) RETURNING id`, name);
  const cust = await one(`INSERT INTO "Customer" ("businessId", name, "updatedAt") VALUES ($1, 'לקוח סינתטי', now()) RETURNING id`, biz);
  const user = await one(`INSERT INTO "User" (email, "businessId", "updatedAt") VALUES ($1, $2, now()) RETURNING id`, `${name}@lab.invalid`, biz);
  const staff = await one(`INSERT INTO "StaffMember" ("businessId", "displayName", "updatedAt") VALUES ($1, 'טכנאי', now()) RETURNING id`, biz);
  return { biz, cust, user, staff };
}
type B = Awaited<ReturnType<typeof business>>;
async function openCase(b: B): Promise<number> {
  const r = await inTx(runtime, b.biz, async (tx) => {
    const n = Number(((await tx.$queryRawUnsafe(`INSERT INTO "ServiceCaseNumberSequence" ("businessId", "nextValue") VALUES ($1, 2)
      ON CONFLICT ("businessId") DO UPDATE SET "nextValue" = "ServiceCaseNumberSequence"."nextValue" + 1, "updatedAt" = now() RETURNING "nextValue" - 1 AS n`, b.biz)) as Rows)[0].n);
    const id = Number(((await tx.$queryRawUnsafe(`INSERT INTO "ServiceCase" ("businessId", "caseNumber", kind, "customerId", "problemDescription", "updatedAt")
      VALUES ($1, $2, 'IN_SHOP', $3, 'המסך לא נדלק', now()) RETURNING id`, b.biz, n, b.cust)) as Rows)[0].id);
    await tx.$executeRawUnsafe(`INSERT INTO "ServiceCaseEvent" ("businessId", "caseId", seq, "eventType", action, "fromStatus", "toStatus", "cancellationRequestedBefore", "cancellationRequestedAfter", actor, payload, "idempotencyKey")
      VALUES ($1, $2, 1, 'case.opened', 'OPEN', NULL, 'OPEN', false, false, 'OWNER_USER', '{}', $3)`, b.biz, id, ikey());
    return id;
  });
  if (typeof r === "string") throw new Error(`openCase: ${r}`);
  return r;
}
async function moveTx(tx: Tx, biz: number, caseId: number, set: string, action: string, type: string, from: string, to: string, outcome: string | null = null) {
  const v = Number(((await tx.$queryRawUnsafe(`UPDATE "ServiceCase" SET ${set}, version = version + 1, "updatedAt" = now() WHERE id = $1 RETURNING version`, caseId)) as Rows)[0].version);
  await tx.$executeRawUnsafe(`INSERT INTO "ServiceCaseEvent" ("businessId", "caseId", seq, "eventType", action, "fromStatus", "toStatus", "cancellationRequestedBefore", "cancellationRequestedAfter", outcome, actor, payload, "idempotencyKey")
    VALUES ($1, $2, $3, $4::"ServiceEventType", $5::"ServiceCaseAction", $6::"ServiceCaseStatus", $7::"ServiceCaseStatus", false, false, $8::"ServiceOutcome", 'SYSTEM', $9::jsonb, $10)`,
    biz, caseId, v, type, action, from, to, outcome, JSON.stringify(outcome === "CANCELLED" ? { reasonRecorded: true } : {}), ikey());
}
async function readyCase(b: B): Promise<number> {
  const c = await openCase(b);
  const r = await inTx(runtime, b.biz, async (tx) => {
    await moveTx(tx, b.biz, c, `status = 'CHECKED_IN'`, "CHECK_IN", "case.checked_in", "OPEN", "CHECKED_IN");
    await moveTx(tx, b.biz, c, `status = 'READY', outcome = 'CANCELLED', "cancelReason" = 'הלקוח ביטל', "cancelledAt" = now(), "readyAt" = now()`,
      "CANCEL", "case.cancelled", "CHECKED_IN", "READY", "CANCELLED");
    return 1;
  });
  if (typeof r === "string") throw new Error(`readyCase: ${r}`);
  return c;
}
const handover = (b: B, c: number) => x(runtime, b.biz, `INSERT INTO "ServiceHandover" ("businessId", "caseId", "receivedByName", "signatureCaptured", "openBalanceAgorot", "actorUserId")
  VALUES ($1, $2, 'דנה כהן', true, 0, $3)`, b.biz, c, b.user);
async function approvedText(b: B, kind: "TERMS" | "STATUTORY_NOTICE", body: string) {
  const id = num(await q(runtime, b.biz, `INSERT INTO "ServiceTextVersion" ("businessId", kind, version, body, "bodySha256", "legalStatus", "createdByUserId")
    VALUES ($1, $2::"ServiceTextKind", (SELECT COALESCE(max(version), 0) + 1 FROM "ServiceTextVersion" WHERE "businessId" = $1 AND kind = $2::"ServiceTextKind"),
      $3, encode(sha256(convert_to($3, 'UTF8')), 'hex'), 'DRAFT', $4) RETURNING id`, b.biz, kind, body, b.user), "id");
  const r = await x(runtime, b.biz, `UPDATE "ServiceTextVersion" SET "legalStatus" = 'LEGALLY_APPROVED', "legallyApprovedAt" = now(), "legallyApprovedByUserId" = $2 WHERE id = $1`, id, b.user);
  if (typeof r === "string" || !Number.isFinite(id)) throw new Error(`approvedText: ${r}`);
  return id;
}
const offerSql = `INSERT INTO "ServiceWarrantyOffer" ("businessId", "caseId", seq, state, source, "durationValue", "durationUnit", "scopeText",
    "exclusionsText", "statutoryNoticeVersionId", "contentSha256", "presentedAt", "presentedByUserId", "createdByUserId", "updatedAt")
  VALUES ($1, $2, (SELECT COALESCE(max(seq), 0) + 1 FROM "ServiceWarrantyOffer" WHERE "businessId" = $1 AND "caseId" = $2),
    $3::"ServiceWarrantyOfferState", 'INTAKE', 90, 'DAYS', $4, $5, $6, $7, CASE WHEN $3::text <> 'DRAFT' THEN now() END, CASE WHEN $3::text <> 'DRAFT' THEN $8::int END, $8, now()) RETURNING id`;
async function offer(b: B, c: number, state: string, scope: string, excl: string | null, notice: number) {
  const id = num(await q(runtime, b.biz, offerSql, b.biz, c, state, scope, excl, notice, sha(`${scope}|${excl}`), b.user), "id");
  if (!Number.isFinite(id)) throw new Error(`offer ${state} failed`);
  return id;
}
const lockSet = `state = 'LOCKED', "lockedAt" = now(), "startsOn" = (SELECT h."deliveredAt"::date FROM "ServiceHandover" h WHERE h."caseId" = "ServiceWarrantyOffer"."caseId"),
  "endsOn" = public.service_warranty_end((SELECT h."deliveredAt"::date FROM "ServiceHandover" h WHERE h."caseId" = "ServiceWarrantyOffer"."caseId"), "durationValue", "durationUnit")`;
async function settings(b: B, terms: number) {
  const r = await x(runtime, b.biz, `INSERT INTO "ServiceSettings" ("businessId", "defaultStaffMemberId", "warrantyTemplateValue", "warrantyTemplateUnit", "warrantyTemplateScope",
    "warrantyTemplateExclusions", "activeTermsVersionId", "updatedAt") VALUES ($1, $2, 3, 'MONTHS', 'אחריות על החלק שהוחלף — טכנאי יוסי 052-0000000', 'נזקי מים ונפילה', $3, now())`, b.biz, b.staff, terms);
  if (typeof r === "string") throw new Error(`settings: ${r}`);
}

/** A business with settings and offers in every state: PRESENTED (live), DRAFT, LOCKED (after handover), SUPERSEDED. */
async function fixture(name: string) {
  const b = await business(name);
  const terms = await approvedText(b, "TERMS", `תנאי שירות של ${name}`);
  const notice = await approvedText(b, "STATUTORY_NOTICE", `הודעה חוקית של ${name}`);
  await settings(b, terms);
  const c1 = await readyCase(b);
  const presented = await offer(b, c1, "PRESENTED", "החלפת מסך — הלקוחה דנה, 050-1234567", "נזקי מים", notice);
  const draft = await offer(b, c1, "DRAFT", "טיוטה: סוללה", null, notice);
  const c2 = await readyCase(b);
  const toLock = await offer(b, c2, "PRESENTED", "החלפת סוללה", "שבר במסך", notice);
  if (typeof (await handover(b, c2)) === "string") throw new Error("handover");
  const lr = await x(runtime, b.biz, `UPDATE "ServiceWarrantyOffer" SET ${lockSet} WHERE id = $1`, toLock);
  if (typeof lr === "string") throw new Error(`lock: ${lr}`);
  // SUPERSEDED: a third case's presented offer replaced by a successor at COMMIT (the chain is checked deferred)
  const c3 = await readyCase(b);
  const old = await offer(b, c3, "PRESENTED", "ניקוי לוח", null, notice);
  const sr = await inTx(runtime, b.biz, async (tx) => {
    await tx.$executeRawUnsafe(`UPDATE "ServiceWarrantyOffer" SET state = 'SUPERSEDED' WHERE id = $1`, old);
    await tx.$queryRawUnsafe(`INSERT INTO "ServiceWarrantyOffer" ("businessId", "caseId", seq, state, source, "durationValue", "durationUnit", "scopeText",
      "statutoryNoticeVersionId", "contentSha256", "supersedesOfferId", "changeReason", "presentedAt", "presentedByUserId", "createdByUserId", "updatedAt")
      VALUES ($1, $2, 2, 'PRESENTED', 'INTAKE', 120, 'DAYS', 'ניקוי לוח והחלפת מחבר', $3, $4, $5, 'הלקוח ביקש הרחבה', now(), $6, $6, now()) RETURNING id`,
      b.biz, c3, notice, sha("ניקוי לוח והחלפת מחבר"), old, b.user);
    return 1;
  });
  if (typeof sr === "string") throw new Error(`supersede: ${sr}`);
  return { b, terms, notice, offers: { presented, draft, locked: toLock, superseded: old } };
}
const offersOf = async (biz: number) => rows(await q(owner, null, `SELECT id, state::text AS s, seq, "caseId" AS c, "durationValue" AS v, "durationUnit"::text AS u,
  "startsOn"::text AS so, "endsOn"::text AS eo, "quoteVersion" AS qv, "statutoryNoticeVersionId" AS sn, "contentSha256" AS h, "scopeText" AS st,
  "exclusionsText" AS ex, "changeReason" AS r, "presentedByUserId" AS p, "createdByUserId" AS cb, "erasedAt" IS NOT NULL AS e
  FROM "ServiceWarrantyOffer" WHERE "businessId" = $1 ORDER BY id`, biz));
// Field by field, in a fixed order: the "before" snapshots round-trip through jsonb, which reorders object keys.
const factsKey = (o: Record<string, unknown>) => JSON.stringify([o.id, o.s, o.seq, o.c, o.v, o.u, o.so, o.eo, o.qv, o.sn, o.h]);
const textsKey = (o: Record<string, unknown>) => JSON.stringify([o.id, o.st, o.ex, o.r, o.p, o.cb, o.e]);
const settingsCount = async (biz: number) => num(await q(owner, null, `SELECT count(*)::int AS n FROM "ServiceSettings" WHERE "businessId" = $1`, biz));
const bodies = async (biz: number) => JSON.stringify(rows(await q(owner, null, `SELECT id, body FROM "ServiceTextVersion" WHERE "businessId" = $1 ORDER BY id`, biz)));
const door = (biz: number | null) => q(runtime, biz, `SELECT public.service_desk_ui_erase_business() AS n`);
const setOwnerFacts = (k: string, v: unknown) => x(owner, null, `INSERT INTO "_sd3x_lab" (k, v) VALUES ($1, $2::jsonb) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v`, k, JSON.stringify(v));
const getOwnerFacts = async (k: string) => rows(await q(owner, null, `SELECT v FROM "_sd3x_lab" WHERE k = $1`, k))[0]?.v as any;

async function pre() {
  console.log("pre — 1.3-0 applied, 20261121090000 pending");
  await x(owner, null, `CREATE TABLE IF NOT EXISTS "_sd3x_lab" (k text PRIMARY KEY, v jsonb NOT NULL)`);
  const t = Date.now();
  const E = await fixture(`sd3x-e-${t}`), K = await fixture(`sd3x-k-${t}`), P = await fixture(`sd3x-p-${t}`);
  await x(owner, null, `UPDATE "Business" SET "deletionRequestedAt" = now() WHERE id = $1`, P.b.biz);
  const pn = await door(P.b.biz);
  const po = await offersOf(P.b.biz);
  ok("pre: the APPLIED door erases P but keeps its warranty texts and its settings row (the gap this migration closes)",
    succeeded(pn) && po.every((o) => o.e === true && o.st !== PH) && po.some((o) => o.ex !== null) && (await settingsCount(P.b.biz)) === 1, JSON.stringify(po.map((o) => o.st)));
  await setOwnerFacts("fixtures", { E, K, P });
  await setOwnerFacts("beforeE", { offers: await offersOf(E.b.biz), bodies: await bodies(E.b.biz) });
  await setOwnerFacts("beforeK", { offers: await offersOf(K.b.biz), bodies: await bodies(K.b.biz) });
}

async function post() {
  console.log("post — 20261121090000 applied");
  const { E, K, P } = await getOwnerFacts("fixtures");
  const beforeE = await getOwnerFacts("beforeE"), beforeK = await getOwnerFacts("beforeK");

  // X1
  const fn = rows(await q(owner, null, `SELECT p.proname AS n, p.prosecdef AS d, array_to_string(p.proconfig, ',') AS cfg, p.prosrc AS src,
      has_function_privilege('public', p.oid, 'EXECUTE') AS pub, has_function_privilege('app_runtime', p.oid, 'EXECUTE') AS rt
    FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('service_desk_ui_erase_business', 'service_settings_guard', 'service_warranty_offer_guard') ORDER BY p.proname`));
  const by = Object.fromEntries(fn.map((r) => [String(r.n), r]));
  ok("X1 the door: SECURITY DEFINER, search_path … pg_temp last, no PUBLIC execute, the runtime may execute",
    by.service_desk_ui_erase_business?.d === true && /search_path=.*pg_temp$/.test(String(by.service_desk_ui_erase_business?.cfg)) && by.service_desk_ui_erase_business?.pub === false && by.service_desk_ui_erase_business?.rt === true,
    JSON.stringify(by.service_desk_ui_erase_business && { d: by.service_desk_ui_erase_business.d, cfg: by.service_desk_ui_erase_business.cfg, pub: by.service_desk_ui_erase_business.pub }));
  ok("X1 the two guards stay INVOKER, search_path … pg_temp last, no PUBLIC execute",
    ["service_settings_guard", "service_warranty_offer_guard"].every((k) => by[k]?.d === false && /pg_temp$/.test(String(by[k]?.cfg)) && by[k]?.pub === false));
  ok("X1 the door now deletes ServiceSettings and writes the placeholder",
    /DELETE FROM public\."ServiceSettings"/.test(String(by.service_desk_ui_erase_business?.src)) && String(by.service_desk_ui_erase_business?.src).includes(PH));

  // X2
  const kOffer = beforeK.offers.find((o: any) => o.s === "PRESENTED").id, kLocked = beforeK.offers.find((o: any) => o.s === "LOCKED").id;
  ok("X2 the runtime cannot delete settings (no privilege)", refused(await x(runtime, K.b.biz, `DELETE FROM "ServiceSettings" WHERE "businessId" = $1`, K.b.biz), DENIED));
  ok("X2 the runtime cannot rewrite a presented or locked offer's texts",
    refused(await x(runtime, K.b.biz, `UPDATE "ServiceWarrantyOffer" SET "scopeText" = $2, "exclusionsText" = NULL WHERE id = $1`, kOffer, PH), /SERVICE_WARRANTY_CONTENT_FIXED|SERVICE_WARRANTY_FINAL|SERVICE_WARRANTY/)
    && refused(await x(runtime, K.b.biz, `UPDATE "ServiceWarrantyOffer" SET "scopeText" = $2, "exclusionsText" = NULL WHERE id = $1`, kLocked, PH), /SERVICE_WARRANTY/));
  ok("X2 …not even after setting the scrub marker itself (marker + table owner), nor erasing like the door",
    refused(await inTx(runtime, K.b.biz, async (tx) => { await tx.$executeRawUnsafe(`SELECT set_config('dubiz.service_ui_erasure', 'on', true)`);
      return tx.$executeRawUnsafe(`UPDATE "ServiceWarrantyOffer" SET "scopeText" = $2, "exclusionsText" = NULL, "changeReason" = NULL, "presentedByUserId" = NULL, "createdByUserId" = NULL, "erasedAt" = now() WHERE id = $1`, kOffer, PH); }), /SERVICE_WARRANTY/));
  ok("X2 the owner without the marker cannot delete settings (SERVICE_SETTINGS_NO_DELETE)",
    refused(await x(owner, null, `DELETE FROM "ServiceSettings" WHERE "businessId" = $1`, K.b.biz), /SERVICE_SETTINGS_NO_DELETE/));
  // X3
  ok("X3 the door still refuses a business that is not being deleted", refused(await door(K.b.biz), /SERVICE_UI_ERASURE_NOT_DELETING/));
  ok("X3 the door still refuses a call without tenant context", refused(await door(null), /SERVICE_UI_ERASURE_NO_CONTEXT/));

  // X4
  await x(owner, null, `UPDATE "Business" SET "deletionRequestedAt" = now() WHERE id = $1`, E.b.biz);
  const failed = await inTx(runtime, E.b.biz, async (tx) => { await tx.$queryRawUnsafe(`SELECT public.service_desk_ui_erase_business() AS n`); throw new Error("lab: purge failed later"); });
  ok("X4 a purge that fails after the door: settings and texts intact (rolled back together)",
    refused(failed, /lab: purge failed later/) && (await settingsCount(E.b.biz)) === 1 && (await offersOf(E.b.biz)).every((o) => o.st !== PH && o.e === false));

  // X5
  const n = await door(E.b.biz);
  const after = await offersOf(E.b.biz);
  ok("X5 the door succeeds: rows = 2 texts + 5 offers + 1 settings", succeeded(n) && num(n) === 8, String(n));
  ok("X5 E's settings row is deleted", (await settingsCount(E.b.biz)) === 0);
  ok("X5 every offer (DRAFT, PRESENTED, LOCKED, SUPERSEDED, successor): scopeText = placeholder, exclusionsText NULL, erasedAt set, no user, no reason",
    after.length === 5 && after.every((o) => o.st === PH && o.ex === null && o.e === true && o.p === null && o.cb === null && o.r === null)
    && new Set(after.map((o) => o.s)).size === 4, JSON.stringify(after.map((o) => [o.s, o.st, o.ex])));
  ok("X5 the facts stay: state, seq, case, duration, dates, quote version, statutory notice, contentSha256",
    JSON.stringify(after.map(factsKey)) === JSON.stringify(beforeE.offers.map(factsKey)));
  ok("X5 ServiceTextVersion.body unchanged", (await bodies(E.b.biz)) === beforeE.bodies);
  // X6
  ok("X6 a second run changes nothing (0)", num(await door(E.b.biz)) === 0 && JSON.stringify(await offersOf(E.b.biz)) === JSON.stringify(after));
  // X7
  const pn = await door(P.b.biz);
  const po = await offersOf(P.b.biz);
  ok("X7 P (erased by the previous version): the new door completes it — 5 offers' texts replaced + its settings row (6)",
    num(pn) === 6 && po.every((o) => o.st === PH && o.ex === null && o.e === true) && (await settingsCount(P.b.biz)) === 0, `${pn} ${JSON.stringify(po.map((o) => o.st))}`);
  // X8
  ok("X8 neighbour K untouched: settings row, offer texts and facts, bodies",
    (await settingsCount(K.b.biz)) === 1
    && JSON.stringify((await offersOf(K.b.biz)).map(factsKey)) === JSON.stringify(beforeK.offers.map(factsKey))
    && JSON.stringify((await offersOf(K.b.biz)).map(textsKey)) === JSON.stringify(beforeK.offers.map(textsKey))
    && (await bodies(K.b.biz)) === beforeK.bodies,
    JSON.stringify({ now: (await offersOf(K.b.biz)).map(textsKey), before: beforeK.offers.map(textsKey) }));
}

(PHASE === "pre" ? pre() : PHASE === "post" ? post() : Promise.reject(new Error("PHASE must be pre or post")))
  .catch((e) => { failures.push(`crash: ${(e as Error).message}`); console.error(e); })
  .finally(async () => {
    console.log(`\n${pass} passed, ${failures.length} failed`);
    if (failures.length) console.log("FAILED:\n  " + failures.join("\n  "));
    await owner.$disconnect(); await runtime.$disconnect();
    process.exit(failures.length ? 1 : 0);
  });
