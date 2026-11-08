/**
 * Service Desk 1.3-0 / PR-1 — migration 20261120090000_service_desk_ui_foundation, AS the real roles
 * (.sd3/lab.sh <db> --with-sd3: 1.2a + 1.2b + M2 applied, then 1.3-0 through `prisma migrate deploy`).
 *
 * Every check pins the owner-approved 1.3-0 plan (v4, decisions ו1–ו6):
 *   1. Structure: eight tables ENABLE + FORCE RLS, per-operation policies without DELETE, explicit grants, fifteen
 *      functions with search_path … pg_temp last, exactly three SECURITY DEFINER, no PUBLIC execute, flag seeded OFF.
 *   2. Isolation between businesses: reads, writes, references (case, text, staff, user), no tenant context.
 *   3. Texts and versions (ו4): next version, born DRAFT, body fixed, approval once, hash bound to the body, race.
 *   4. Settings: optimistic version, text kinds, warranty template all-or-none.
 *   5. Intake terms snapshot: approved texts only, own hash, before the signature, once, fixed.
 *   6. Warranty (ו2): states, presenting, adverse change + reaffirmation, supersede chain at COMMIT, lock at
 *      handover with exact dates, extension only after handover, one draft / one live per case.
 *   7. Intake photos: exact key, type, size, ten per case (with a race), frozen after the signature.
 *   8. Share journal: the stored copy only (quote PDF / intake slip), idempotency, append-only.
 *   9. Phone reminders (ו3): READY only, time window, who called, idempotency, append-only.
 *  10. Deletion (ו1): writes refused while deleting, the erasure door, the storage-erasure job (no job before the
 *      purge commits, resumable, DONE only when nothing is left and the quarantine is old), isolation of the job.
 * While the new tables are absent every check prints PENDING (never a pass) and the run exits 0.
 *
 * env: OWNER_URL, RUNTIME_URL. Synthetic only. Raw SQL only.
 */
import { createHash } from "node:crypto";
import { PrismaClient, Prisma } from "@prisma/client";

const withPool = (url: string) => `${url}${url.includes("?") ? "&" : "?"}connection_limit=16&pool_timeout=60`;
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
const UNIQUE = /unique constraint|duplicate key|23505/i, FK = /foreign key|23503/i, CHECK = /check constraint|23514/i;
const DENIED = /permission denied/i, RLS = /row-level security/i;
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const H = (c: string) => c.repeat(64);
let keySeq = 0;
const ikey = () => `sd3-lab-key-${String(++keySeq).padStart(6, "0")}`;

const MIG = "20261120090000_service_desk_ui_foundation";
const TABLES = ["ServiceTextVersion", "ServiceSettings", "ServiceIntakeTermsSnapshot", "ServiceWarrantyOffer", "ServiceIntakePhoto",
  "ServiceShareEvent", "ServicePhoneReminder", "ServiceStorageErasure"];
const APPEND_ONLY = ["ServiceIntakeTermsSnapshot", "ServiceIntakePhoto", "ServiceShareEvent", "ServicePhoneReminder"];
const FUNCS = ["service_ui_business_writable", "service_ui_in_erasure", "service_text_version_guard", "service_settings_guard",
  "service_intake_terms_guard", "service_warranty_end", "service_warranty_offer_guard", "service_warranty_chain_check",
  "service_intake_photo_guard", "service_share_event_guard", "service_phone_reminder_guard", "service_storage_erasure_guard",
  "service_desk_ui_erase_business", "service_storage_erasure_due", "service_storage_erasure_record_pass"];
const DEFINERS = ["service_desk_ui_erase_business", "service_storage_erasure_due", "service_storage_erasure_record_pass"];

// ── fixtures (owner) ─────────────────────────────────────────────────────────────────────────────────────────
const one = async (sql: string, ...a: unknown[]) => num(await q(owner, null, sql, ...a), "id");
async function business(name: string) {
  const biz = await one(`INSERT INTO "Business" (name, "updatedAt") VALUES ($1, now()) RETURNING id`, name);
  const cust = await one(`INSERT INTO "Customer" ("businessId", name, "updatedAt") VALUES ($1, 'לקוח סינתטי', now()) RETURNING id`, biz);
  const user = await one(`INSERT INTO "User" (email, "businessId", "updatedAt") VALUES ($1, $2, now()) RETURNING id`, `${name}@lab.invalid`, biz);
  const staff = await one(`INSERT INTO "StaffMember" ("businessId", "displayName", "updatedAt") VALUES ($1, 'טכנאי', now()) RETURNING id`, biz);
  return { biz, cust, user, staff };
}
type B = Awaited<ReturnType<typeof business>>;
const billingDoc = (b: B) => one(`INSERT INTO "BillingDocument" ("businessId", "documentType", "updatedAt") VALUES ($1, 'QUOTE'::"BillingDocumentType", now()) RETURNING id`, b.biz);

// ── runtime helpers (the way PR-2 will write) ────────────────────────────────────────────────────────────────
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
/** A case waiting for pickup: checked in, then READY (cancelled path of 1.2a), readyAt stamped. */
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
const intake = (b: B, c: number) => x(runtime, b.biz, `INSERT INTO "ServiceCaseIntake" ("businessId", "caseId", "deviceSnapshot", "conditionNote", "conditionRecorded", "accessoriesRecorded", "updatedAt")
  VALUES ($1, $2, '{"brand":"Samsung"}', 'שריטה', true, true, now())`, b.biz, c);
const sign = (b: B, c: number) => x(runtime, b.biz, `UPDATE "ServiceCaseIntake" SET "customerSigned" = true, "signedAt" = now(), "signatureKey" = $2 WHERE "caseId" = $1`,
  c, `biz/${b.biz}/service/cases/${c}/intake/signature.png`);
const handover = (b: B, c: number) => x(runtime, b.biz, `INSERT INTO "ServiceHandover" ("businessId", "caseId", "receivedByName", "signatureCaptured", "openBalanceAgorot", "actorUserId")
  VALUES ($1, $2, 'דנה כהן', true, 0, $3)`, b.biz, c, b.user);

async function text(b: B, kind: "TERMS" | "STATUTORY_NOTICE", body: string, o: { version?: number; sha?: string; status?: string } = {}) {
  return q(runtime, b.biz, `INSERT INTO "ServiceTextVersion" ("businessId", kind, version, body, "bodySha256", "legalStatus", "createdByUserId")
    VALUES ($1, $2::"ServiceTextKind", COALESCE($3, (SELECT COALESCE(max(version), 0) + 1 FROM "ServiceTextVersion" WHERE "businessId" = $1 AND kind = $2::"ServiceTextKind")),
      $4, COALESCE($5, encode(sha256(convert_to($4, 'UTF8')), 'hex')), $6::"ServiceTextLegalStatus", $7) RETURNING id`,
    b.biz, kind, o.version ?? null, body, o.sha ?? null, o.status ?? "DRAFT", b.user);
}
const approve = (b: B, id: number, by: number | null = b.user) => x(runtime, b.biz,
  `UPDATE "ServiceTextVersion" SET "legalStatus" = 'LEGALLY_APPROVED', "legallyApprovedAt" = now(), "legallyApprovedByUserId" = $2 WHERE id = $1`, id, by);
async function approvedText(b: B, kind: "TERMS" | "STATUTORY_NOTICE", body: string) {
  const id = num(await text(b, kind, body), "id");
  const r = await approve(b, id);
  if (typeof r === "string") throw new Error(`approve: ${r}`);
  return id;
}

type Offer = Partial<{ seq: number; state: string; source: string; quoteVersion: number | null; value: number; unit: string; scope: string;
  exclusions: string | null; notice: number; supersedes: number | null; reason: string | null; adverse: boolean; reaffirm: boolean;
  presented: boolean; presentedBy: number | null; lockedAt: string | null; startsOn: string | null; endsOn: string | null }>;
const offerSql = `INSERT INTO "ServiceWarrantyOffer" ("businessId", "caseId", seq, state, source, "quoteVersion", "durationValue", "durationUnit", "scopeText",
    "exclusionsText", "statutoryNoticeVersionId", "contentSha256", "supersedesOfferId", "changeReason", "customerAdverse", "customerReaffirmedAt",
    "customerReaffirmMethod", "presentedAt", "presentedByUserId", "lockedAt", "startsOn", "endsOn", "createdByUserId", "updatedAt")
  VALUES ($1, $2, COALESCE($3, (SELECT COALESCE(max(seq), 0) + 1 FROM "ServiceWarrantyOffer" WHERE "businessId" = $1 AND "caseId" = $2)),
    $4::"ServiceWarrantyOfferState", $5::"ServiceWarrantyOfferSource", $6, $7, $8::"ServiceDurationUnit", $9, $10, $11, $12, $13, $14, $15,
    CASE WHEN $16 THEN now() END, CASE WHEN $16 THEN 'PHONE'::"ServiceReaffirmMethod" END, CASE WHEN $17 THEN now() END, $18,
    $19::timestamp, $20::date, $21::date, $22, now()) RETURNING id`;
function offerArgs(b: B, c: number, o: Offer) {
  const state = o.state ?? "DRAFT";
  const presented = o.presented ?? (state !== "DRAFT");
  return [b.biz, c, o.seq ?? null, state, o.source ?? "INTAKE", o.quoteVersion ?? null, o.value ?? 90, o.unit ?? "DAYS", o.scope ?? "החלפת מסך",
    o.exclusions ?? null, o.notice!, H("a"), o.supersedes ?? null, o.reason ?? null, o.adverse ?? false, o.reaffirm ?? false, presented,
    o.presentedBy !== undefined ? o.presentedBy : (presented ? b.user : null), o.lockedAt ?? null, o.startsOn ?? null, o.endsOn ?? null, b.user];
}
const offer = (b: B, c: number, o: Offer) => q(runtime, b.biz, offerSql, ...offerArgs(b, c, o));
const offerTx = async (tx: Tx, b: B, c: number, o: Offer) => Number(((await tx.$queryRawUnsafe(offerSql, ...offerArgs(b, c, o))) as Rows)[0].id);
const offerState = async (id: number) => String(rows(await q(owner, null, `SELECT state::text AS s FROM "ServiceWarrantyOffer" WHERE id = $1`, id))[0]?.s);
const lockSet = `state = 'LOCKED', "lockedAt" = now(), "startsOn" = (SELECT h."deliveredAt"::date FROM "ServiceHandover" h WHERE h."caseId" = "ServiceWarrantyOffer"."caseId"),
  "endsOn" = public.service_warranty_end((SELECT h."deliveredAt"::date FROM "ServiceHandover" h WHERE h."caseId" = "ServiceWarrantyOffer"."caseId"), "durationValue", "durationUnit")`;

const photoKey = (b: B, c: number, s: string, ext = "jpg") => `biz/${b.biz}/service/cases/${c}/intake/photos/${s}.${ext}`;
const photo = (b: B, c: number, s: string, o: Partial<{ key: string; mime: string; size: number; biz: number }> = {}) =>
  x(runtime, b.biz, `INSERT INTO "ServiceIntakePhoto" ("businessId", "caseId", "storageKey", sha256, "mimeType", "byteSize", "createdByUserId")
    VALUES ($1, $2, $3, $4, $5, $6, $7)`, o.biz ?? b.biz, c, o.key ?? photoKey(b, c, s), s, o.mime ?? "image/jpeg", o.size ?? 250_000, b.user);
const share = (b: B, c: number, o: Partial<{ kind: string; qv: number | null; key: string; sha: string; channel: string; actor: number | null; idem: string }>) =>
  x(runtime, b.biz, `INSERT INTO "ServiceShareEvent" ("businessId", "caseId", "objectKind", "quoteVersion", "objectKey", "objectSha256", channel, "actorUserId", "idempotencyKey")
    VALUES ($1, $2, $3::"ServiceShareObjectKind", $4, $5, $6, $7::"ServiceShareChannel", $8, $9)`,
    b.biz, c, o.kind ?? "QUOTE_PDF", o.qv === undefined ? 1 : o.qv, o.key!, o.sha!, o.channel ?? "SHARE_SHEET", o.actor === undefined ? b.user : o.actor, o.idem ?? ikey());
const remind = (b: B, c: number, o: Partial<{ at: string; outcome: string; note: string | null; actor: number | null; idem: string }> = {}) =>
  x(runtime, b.biz, `INSERT INTO "ServicePhoneReminder" ("businessId", "caseId", "calledAt", "actorUserId", outcome, note, "idempotencyKey")
    VALUES ($1, $2, COALESCE($3::timestamp, now()), $4, $5::"ServicePhoneReminderOutcome", $6, $7)`,
    b.biz, c, o.at ?? null, o.actor === undefined ? b.user : o.actor, o.outcome ?? "REACHED", o.note ?? null, o.idem ?? ikey());

async function main() {
  const present = num(await q(owner, null, `SELECT count(*)::int AS n FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname = ANY($1::text[])`, TABLES));
  if (present !== TABLES.length) {
    console.log(`PENDING: ${MIG} is not applied (${present}/${TABLES.length} tables) — no check runs, none passes`);
    console.log(`0 passed, 0 failed, PENDING`);
    return;
  }

  // ── 1. Structure ───────────────────────────────────────────────────────────────────────────────────────────
  console.log("1. structure");
  ok("1.1 the migration is recorded and finished; nothing is pending or rolled back",
    num(await q(owner, null, `SELECT count(*)::int AS n FROM "_prisma_migrations" WHERE migration_name = $1 AND finished_at IS NOT NULL AND rolled_back_at IS NULL`, MIG)) === 1
    && num(await q(owner, null, `SELECT count(*)::int AS n FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL`)) === 0);
  ok("1.2 eight tables, each ENABLE + FORCE row-level security",
    num(await q(owner, null, `SELECT count(*)::int AS n FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname = ANY($1::text[]) AND relrowsecurity AND relforcerowsecurity`, TABLES)) === 8);
  const pol = rows(await q(owner, null, `SELECT tablename AS t, cmd, count(*)::int AS n FROM pg_policies WHERE tablename = ANY($1::text[]) GROUP BY 1, 2`, TABLES));
  ok("1.3 eighteen per-operation policies; none for DELETE, none FOR ALL",
    pol.reduce((s, r) => s + Number(r.n), 0) === 18 && !pol.some((r) => r.cmd === "DELETE" || r.cmd === "ALL"), JSON.stringify(pol));
  ok("1.4 every policy is the tenant expression (no permissive true)",
    num(await q(owner, null, `SELECT count(*)::int AS n FROM pg_policies WHERE tablename = ANY($1::text[])
      AND COALESCE(qual, with_check) NOT LIKE '%current_setting(''app.current_business_id''%'`, TABLES)) === 0);
  const priv = async (t: string, p: string) => num(await q(owner, null, `SELECT has_table_privilege('app_runtime', $1, $2)::int AS n`, `public."${t}"`, p)) === 1;
  let noDelete = true, appendOnly = true;
  for (const t of TABLES) { if (await priv(t, "DELETE") || await priv(t, "TRUNCATE")) noDelete = false; }
  for (const t of [...APPEND_ONLY, "ServiceStorageErasure"]) { if (await priv(t, "UPDATE")) appendOnly = false; }
  ok("1.5 the runtime holds no DELETE / TRUNCATE on any new table", noDelete);
  ok("1.6 the four journals and the erasure job: no UPDATE for the runtime", appendOnly);
  ok("1.7 the erasure job: SELECT only for the runtime (written by its functions)",
    await priv("ServiceStorageErasure", "SELECT") && !(await priv("ServiceStorageErasure", "INSERT")));
  ok("1.8 PUBLIC holds nothing on the new tables",
    num(await q(owner, null, `SELECT count(*)::int AS n FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a WHERE c.relname = ANY($1::text[]) AND a.grantee = 0`, TABLES)) === 0);
  const fn = rows(await q(owner, null, `SELECT proname AS p, prosecdef AS d, array_to_string(proconfig, ',') AS cfg,
      EXISTS (SELECT 1 FROM aclexplode(COALESCE(proacl, acldefault('f', proowner))) a WHERE a.grantee = 0) AS pub
    FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = ANY($1::text[])`, FUNCS));
  ok("1.9 fifteen new functions, each with search_path = pg_catalog, public, pg_temp",
    fn.length === 15 && fn.every((r) => r.cfg === "search_path=pg_catalog, public, pg_temp"), JSON.stringify(fn.filter((r) => r.cfg !== "search_path=pg_catalog, public, pg_temp")));
  ok("1.10 exactly three SECURITY DEFINER (erasure door, due list, pass record)",
    JSON.stringify(fn.filter((r) => r.d).map((r) => r.p).sort()) === JSON.stringify([...DEFINERS].sort()));
  ok("1.11 no new function is executable by PUBLIC", fn.every((r) => !r.pub), JSON.stringify(fn.filter((r) => r.pub).map((r) => r.p)));
  const flag = rows(await q(owner, null, `SELECT d."defaultEnabled" AS de, p."globalEnabled" AS ge, p."emergencyDisabled" AS ed,
      (SELECT count(*)::int FROM "BusinessFeatureAccess" a WHERE a."featureKey" = 'service_desk') AS overrides
    FROM "PlatformFeatureDefinition" d JOIN "PlatformFeaturePolicy" p ON p."featureKey" = d.key WHERE d.key = 'service_desk'`))[0];
  ok("1.12 the feature flag service_desk is seeded OFF (default off, global off, no business override)",
    !!flag && flag.de === false && flag.ge === false && Number(flag.overrides) === 0, JSON.stringify(flag));
  ok("1.13 all 22 triggers exist and are enabled (guards, same-business users, no-truncate, the deferred chain)",
    num(await q(owner, null, `SELECT count(*)::int AS n FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      WHERE c.relname = ANY($1::text[]) AND NOT t.tgisinternal AND t.tgenabled = 'O'`, TABLES)) === 22);

  // ── fixtures ─────────────────────────────────────────────────────────────────────────────────────────────
  const A = await business(`sd3-a-${Date.now()}`), Bz = await business(`sd3-b-${Date.now()}`);
  const termsA = await approvedText(A, "TERMS", "תנאי שירות — גרסה 1");
  const noticeA = await approvedText(A, "STATUTORY_NOTICE", "אין באחריות זו כדי לגרוע מזכויות הצרכן לפי כל דין.");
  const termsB = await approvedText(Bz, "TERMS", "תנאי שירות של עסק ב");
  const noticeB = await approvedText(Bz, "STATUTORY_NOTICE", "הודעה של עסק ב");

  // ── 2. Isolation ───────────────────────────────────────────────────────────────────────────────────────────
  console.log("2. isolation between businesses");
  const cA = await openCase(A), cB = await openCase(Bz);
  ok("2.1 business B reads none of A's texts", num(await q(runtime, Bz.biz, `SELECT count(*)::int AS n FROM "ServiceTextVersion" WHERE "businessId" = $1`, A.biz)) === 0);
  ok("2.2 no tenant context → zero rows from every new table", (await Promise.all(TABLES.map(async (t) =>
    num(await q(runtime, null, `SELECT count(*)::int AS n FROM "${t}"`))))).every((n) => n === 0));
  const r23 = await q(runtime, A.biz, `INSERT INTO "ServiceTextVersion" ("businessId", kind, version, body, "bodySha256") VALUES ($1, 'TERMS', 1, 'x', encode(sha256('x'), 'hex')) RETURNING id`, Bz.biz);
  ok("2.3 writing a row of another business → refused by RLS", refused(r23, RLS), String(r23));
  ok("2.4 a warranty offer naming another business's case → refused",
    refused(await offer(A, cB, { notice: noticeA }), /DZU05|SERVICE_WARRANTY_CASE|foreign key/));
  const r25 = await offer(A, cA, { notice: noticeB });
  ok("2.5 a warranty offer naming another business's statutory notice → refused", refused(r25, /foreign key|23503|SERVICE_WARRANTY_NOTICE_KIND/), String(r25));
  ok("2.6 settings naming another business's terms or technician → refused",
    refused(await x(runtime, A.biz, `INSERT INTO "ServiceSettings" ("businessId", "activeTermsVersionId", "updatedAt") VALUES ($1, $2, now())`, A.biz, termsB), /DZU03|foreign key/)
    && refused(await x(runtime, A.biz, `INSERT INTO "ServiceSettings" ("businessId", "defaultStaffMemberId", "updatedAt") VALUES ($1, $2, now())`, A.biz, Bz.staff), FK));
  ok("2.7 a user of another business as author → refused (DZS03)",
    refused(await q(runtime, A.biz, `INSERT INTO "ServiceTextVersion" ("businessId", kind, version, body, "bodySha256", "createdByUserId") VALUES ($1, 'TERMS', 2, 'y', encode(sha256('y'), 'hex'), $2) RETURNING id`, A.biz, Bz.user), /SERVICE_USER_OTHER_BUSINESS/));
  ok("2.8 a photo key under another business's prefix → refused",
    refused(await photo(A, cA, H("1"), { key: `biz/${Bz.biz}/service/cases/${cA}/intake/photos/${H("1")}.jpg` }), CHECK));
  ok("2.9 an intake terms snapshot with another business's texts → refused",
    refused(await x(runtime, A.biz, `INSERT INTO "ServiceIntakeTermsSnapshot" ("businessId", "caseId", "termsVersionId", "termsSha256", "statutoryNoticeVersionId", "statutorySha256")
      VALUES ($1, $2, $3, $4, $5, $6)`, A.biz, cA, termsB, sha("תנאי שירות של עסק ב"), noticeB, sha("הודעה של עסק ב")), /DZU04|foreign key/));
  ok("2.10 business B cannot approve A's draft (row invisible: zero rows changed)", await (async () => {
    const d = num(await text(A, "TERMS", "טיוטה של א"), "id");
    const r = await approve(Bz, d, Bz.user);
    return r === 0 && String(rows(await q(owner, null, `SELECT "legalStatus"::text AS s FROM "ServiceTextVersion" WHERE id = $1`, d))[0].s) === "DRAFT";
  })());

  // ── 3. Texts and versions ──────────────────────────────────────────────────────────────────────────────────
  console.log("3. texts and versions (ו4)");
  ok("3.1 a version number that is not the next → refused", refused(await text(A, "TERMS", "קפיצה", { version: 99 }), /SERVICE_TEXT_VERSION_NOT_NEXT/));
  ok("3.2 a text born LEGALLY_APPROVED → refused (approval is a separate step)", refused(await text(A, "TERMS", "מאושר מראש", { status: "LEGALLY_APPROVED" }), /SERVICE_TEXT_INSERT_DRAFT|check constraint/));
  ok("3.3 a hash that is not the body's → refused", refused(await text(A, "TERMS", "גוף", { sha: H("0") }), CHECK));
  ok("3.4 an empty body or one over 20,000 characters → refused",
    refused(await text(A, "TERMS", ""), CHECK) && refused(await text(A, "TERMS", "א".repeat(20001)), CHECK));
  const d1 = num(await text(A, "TERMS", "טיוטה לשינוי"), "id");
  ok("3.5 the body of a draft never changes", refused(await x(runtime, A.biz, `UPDATE "ServiceTextVersion" SET body = 'אחר', "bodySha256" = encode(sha256(convert_to('אחר','UTF8')),'hex') WHERE id = $1`, d1), /SERVICE_TEXT_FIXED/));
  ok("3.6 approval without the approver → refused", refused(await approve(A, d1, null), /SERVICE_TEXT_FIXED/));
  ok("3.7 approval with time and approver → accepted", succeeded(await approve(A, d1)));
  ok("3.8 a second approval / back to DRAFT → refused",
    refused(await approve(A, d1), /SERVICE_TEXT_FIXED/)
    && refused(await x(runtime, A.biz, `UPDATE "ServiceTextVersion" SET "legalStatus" = 'DRAFT', "legallyApprovedAt" = NULL, "legallyApprovedByUserId" = NULL WHERE id = $1`, d1), /SERVICE_TEXT_FIXED/));
  ok("3.9 the body of an approved text never changes (even for the owner)",
    refused(await x(owner, null, `UPDATE "ServiceTextVersion" SET body = 'x', "bodySha256" = encode(sha256('x'),'hex') WHERE id = $1`, d1), /SERVICE_TEXT_FIXED/));
  ok("3.10 a text version is never deleted or truncated (even by the owner)",
    refused(await x(runtime, A.biz, `DELETE FROM "ServiceTextVersion" WHERE id = $1`, d1), DENIED)
    && refused(await x(owner, null, `DELETE FROM "ServiceTextVersion" WHERE id = $1`, d1), /SERVICE_TEXT_FIXED|foreign key/)
    && refused(await x(owner, null, `TRUNCATE "ServiceTextVersion" CASCADE`), /SERVICE_JOURNAL_NO_TRUNCATE|cannot truncate/));
  const race = await Promise.all([0, 1].map(() => text(A, "STATUTORY_NOTICE", `נוסח מקביל`, { version: 2 })));
  ok("3.11 two writers of the same next version at once → exactly one succeeds", race.filter(succeeded).length === 1, JSON.stringify(race));
  ok("3.12 each kind numbers its own versions (TERMS and STATUTORY_NOTICE are separate)",
    num(await q(owner, null, `SELECT max(version)::int AS n FROM "ServiceTextVersion" WHERE "businessId" = $1 AND kind = 'STATUTORY_NOTICE'`, A.biz)) === 2);

  // ── 4. Settings ──────────────────────────────────────────────────────────────────────────────────────────
  console.log("4. settings");
  ok("4.1 settings born at version 2 → refused", refused(await x(runtime, A.biz, `INSERT INTO "ServiceSettings" ("businessId", version, "updatedAt") VALUES ($1, 2, now())`, A.biz), /SERVICE_SETTINGS_VERSION/));
  ok("4.2 active terms that are a statutory notice → refused",
    refused(await x(runtime, A.biz, `INSERT INTO "ServiceSettings" ("businessId", "activeTermsVersionId", "updatedAt") VALUES ($1, $2, now())`, A.biz, noticeA), /SERVICE_SETTINGS_TEXT_KIND/));
  ok("4.3 a half warranty template (value without unit / scope) → refused",
    refused(await x(runtime, A.biz, `INSERT INTO "ServiceSettings" ("businessId", "warrantyTemplateValue", "updatedAt") VALUES ($1, 3, now())`, A.biz), CHECK));
  ok("4.4 full settings (technician, template 3 months, terms + notice) → accepted",
    succeeded(await x(runtime, A.biz, `INSERT INTO "ServiceSettings" ("businessId", "defaultStaffMemberId", "warrantyTemplateValue", "warrantyTemplateUnit", "warrantyTemplateScope",
      "activeTermsVersionId", "activeStatutoryNoticeVersionId", "updatedAt") VALUES ($1, $2, 3, 'MONTHS', 'חלקים ועבודה', $3, $4, now())`, A.biz, A.staff, termsA, noticeA)));
  ok("4.5 a change without moving version by one (lost update) → refused; with it → accepted",
    refused(await x(runtime, A.biz, `UPDATE "ServiceSettings" SET "warrantyTemplateValue" = 6, "updatedAt" = now() WHERE "businessId" = $1`, A.biz), /SERVICE_SETTINGS_VERSION/)
    && succeeded(await x(runtime, A.biz, `UPDATE "ServiceSettings" SET "warrantyTemplateValue" = 6, version = version + 1, "updatedAt" = now() WHERE "businessId" = $1 AND version = 1`, A.biz)));
  ok("4.6 a template over the bound (121 months) → refused",
    refused(await x(runtime, A.biz, `UPDATE "ServiceSettings" SET "warrantyTemplateValue" = 121, version = version + 1, "updatedAt" = now() WHERE "businessId" = $1`, A.biz), CHECK));

  // ── 5. Intake terms snapshot ─────────────────────────────────────────────────────────────────────────────
  console.log("5. intake terms snapshot");
  const snap = (b: B, c: number, t: number, ts: string, n: number, ns: string) => x(runtime, b.biz, `INSERT INTO "ServiceIntakeTermsSnapshot"
    ("businessId", "caseId", "termsVersionId", "termsSha256", "statutoryNoticeVersionId", "statutorySha256", "presentedByUserId") VALUES ($1, $2, $3, $4, $5, $6, $7)`, b.biz, c, t, ts, n, ns, b.user);
  const tS = sha("תנאי שירות — גרסה 1"), nS = sha("אין באחריות זו כדי לגרוע מזכויות הצרכן לפי כל דין.");
  const draftT = num(await text(A, "TERMS", "טיוטה שלא אושרה"), "id");
  const c5 = await openCase(A);
  await intake(A, c5);
  ok("5.1 a DRAFT terms text is never shown as approved → refused", refused(await snap(A, c5, draftT, sha("טיוטה שלא אושרה"), noticeA, nS), /SERVICE_INTAKE_TERMS_NOT_APPROVED/));
  ok("5.2 a hash that is not the version's → refused", refused(await snap(A, c5, termsA, H("b"), noticeA, nS), /SERVICE_INTAKE_TERMS_NOT_APPROVED/));
  ok("5.3 the kinds swapped → refused", refused(await snap(A, c5, noticeA, nS, termsA, tS), /SERVICE_INTAKE_TERMS_NOT_APPROVED/));
  ok("5.4 approved texts with their own hashes, before the signature → accepted", succeeded(await snap(A, c5, termsA, tS, noticeA, nS)));
  ok("5.5 a second snapshot for the case → refused", refused(await snap(A, c5, termsA, tS, noticeA, nS), UNIQUE));
  ok("5.6 the snapshot never changes (runtime: no privilege; owner: refused)",
    refused(await x(runtime, A.biz, `UPDATE "ServiceIntakeTermsSnapshot" SET "termsSha256" = $2 WHERE "caseId" = $1`, c5, H("c")), DENIED)
    && refused(await x(owner, null, `UPDATE "ServiceIntakeTermsSnapshot" SET "termsSha256" = $2 WHERE "caseId" = $1`, c5, H("c")), /SERVICE_INTAKE_TERMS_FIXED/));
  const c5b = await openCase(A);
  await intake(A, c5b); await sign(A, c5b);
  ok("5.7 after the intake is signed → refused (terms are captured before the signature)", refused(await snap(A, c5b, termsA, tS, noticeA, nS), /SERVICE_INTAKE_TERMS_AFTER_SIGNATURE/));
  ok("5.8 a later terms version leaves the snapshot as it was",
    succeeded(await approvedText(A, "TERMS", "תנאי שירות — גרסה 3").then(() => 1))
    && num(await q(owner, null, `SELECT "termsVersionId" AS n FROM "ServiceIntakeTermsSnapshot" WHERE "caseId" = $1`, c5)) === termsA);

  // ── 6. Warranty ──────────────────────────────────────────────────────────────────────────────────────────
  console.log("6. warranty offers (ו2)");
  const draftNotice = num(await text(A, "STATUTORY_NOTICE", "הודעה בטיוטה"), "id");
  const w = await openCase(A);
  ok("6.1 a draft with a draft notice → accepted (drafts are internal)", succeeded(await offer(A, w, { notice: draftNotice })));
  const wDraft = num(rows(await q(owner, null, `SELECT id FROM "ServiceWarrantyOffer" WHERE "caseId" = $1`, w)), "id");
  ok("6.2 a second draft for the case → refused", refused(await offer(A, w, { notice: noticeA }), UNIQUE));
  ok("6.3 the draft's content can be edited", succeeded(await x(runtime, A.biz, `UPDATE "ServiceWarrantyOffer" SET "durationValue" = 120 WHERE id = $1`, wDraft)));
  ok("6.4 presenting with a notice that is not legally approved → refused",
    refused(await x(runtime, A.biz, `UPDATE "ServiceWarrantyOffer" SET state = 'PRESENTED', "presentedAt" = now(), "presentedByUserId" = $2 WHERE id = $1`, wDraft, A.user), /SERVICE_WARRANTY_NOTICE_NOT_APPROVED/));
  ok("6.5 presenting without who presented → refused",
    refused(await x(runtime, A.biz, `UPDATE "ServiceWarrantyOffer" SET state = 'PRESENTED', "presentedAt" = now(), "statutoryNoticeVersionId" = $2 WHERE id = $1`, wDraft, noticeA), /SERVICE_WARRANTY_PRESENT/));
  ok("6.6 presenting with the approved notice, time and who → accepted",
    succeeded(await x(runtime, A.biz, `UPDATE "ServiceWarrantyOffer" SET state = 'PRESENTED', "presentedAt" = now(), "presentedByUserId" = $2, "statutoryNoticeVersionId" = $3 WHERE id = $1`, wDraft, A.user, noticeA)));
  ok("6.7 the content of a presented offer never changes (duration, scope, notice)",
    refused(await x(runtime, A.biz, `UPDATE "ServiceWarrantyOffer" SET "durationValue" = 30 WHERE id = $1`, wDraft), /SERVICE_WARRANTY_CONTENT_FIXED/)
    && refused(await x(runtime, A.biz, `UPDATE "ServiceWarrantyOffer" SET "scopeText" = 'רק מסך' WHERE id = $1`, wDraft), /SERVICE_WARRANTY_CONTENT_FIXED/));
  ok("6.8 withdrawing a presented offer without a successor → refused at COMMIT",
    refused(await x(runtime, A.biz, `UPDATE "ServiceWarrantyOffer" SET state = 'SUPERSEDED' WHERE id = $1`, wDraft), /SERVICE_WARRANTY_CHAIN/) && await offerState(wDraft) === "PRESENTED");
  const supersede = (o: Offer) => inTx(runtime, A.biz, async (tx) => {
    await tx.$executeRawUnsafe(`UPDATE "ServiceWarrantyOffer" SET state = 'SUPERSEDED' WHERE id = $1`, wDraft);
    return offerTx(tx, A, w, { notice: noticeA, supersedes: wDraft, ...o });
  });
  ok("6.9 a successor without a reason → refused", refused(await supersede({ state: "PRESENTED", value: 180 }), /SERVICE_WARRANTY_REASON_REQUIRED/));
  ok("6.10 a shorter warranty (same unit) not marked adverse → refused", refused(await supersede({ state: "PRESENTED", value: 30, reason: "שינוי מחיר" }), /SERVICE_WARRANTY_ADVERSE_UNMARKED/));
  ok("6.11 adverse and presented without the customer's renewed agreement → refused",
    refused(await supersede({ state: "PRESENTED", value: 30, reason: "שינוי מחיר", adverse: true }), /SERVICE_WARRANTY_REAFFIRM_REQUIRED/));
  const succ = await supersede({ state: "PRESENTED", value: 30, reason: "שינוי מחיר", adverse: true, reaffirm: true });
  ok("6.12 adverse with the renewed agreement (phone), predecessor SUPERSEDED in the same transaction → accepted",
    succeeded(succ) && await offerState(wDraft) === "SUPERSEDED", String(succ));
  const wLive = Number(succ);
  ok("6.13 a superseded offer never changes again",
    refused(await x(runtime, A.biz, `UPDATE "ServiceWarrantyOffer" SET state = 'PRESENTED' WHERE id = $1`, wDraft), /SERVICE_WARRANTY_FINAL/));
  ok("6.14 a second live (presented) offer for the case → refused", refused(await offer(A, w, { state: "PRESENTED", notice: noticeA }), UNIQUE));
  ok("6.15 locking before the handover → refused", refused(await x(runtime, A.biz, `UPDATE "ServiceWarrantyOffer" SET ${lockSet} WHERE id = $1`, wLive), /SERVICE_WARRANTY_LOCK_NO_HANDOVER|null value|check constraint/));
  await handover(A, w);
  ok("6.16 locking with a start that is not the delivery day → refused",
    refused(await x(runtime, A.biz, `UPDATE "ServiceWarrantyOffer" SET state = 'LOCKED', "lockedAt" = now(), "startsOn" = current_date - 3, "endsOn" = current_date + 27 WHERE id = $1`, wLive), /SERVICE_WARRANTY_DATES/));
  ok("6.17 locking with an end that is not exactly one duration later → refused",
    refused(await x(runtime, A.biz, `UPDATE "ServiceWarrantyOffer" SET state = 'LOCKED', "lockedAt" = now(), "startsOn" = (SELECT "deliveredAt"::date FROM "ServiceHandover" WHERE "caseId" = $2), "endsOn" = current_date + 400 WHERE id = $1`, wLive, w), /SERVICE_WARRANTY_DATES/));
  ok("6.18 locking at handover with exact dates → accepted", succeeded(await x(runtime, A.biz, `UPDATE "ServiceWarrantyOffer" SET ${lockSet} WHERE id = $1`, wLive)));
  ok("6.19 a locked offer's dates never change", refused(await x(runtime, A.biz, `UPDATE "ServiceWarrantyOffer" SET "endsOn" = "endsOn" + 1 WHERE id = $1`, wLive), /SERVICE_WARRANTY_CONTENT_FIXED/));
  const locked = rows(await q(owner, null, `SELECT "startsOn"::text AS s, "endsOn"::text AS e FROM "ServiceWarrantyOffer" WHERE id = $1`, wLive))[0];
  const extend = (o: Offer) => inTx(runtime, A.biz, async (tx) => {
    await tx.$executeRawUnsafe(`UPDATE "ServiceWarrantyOffer" SET state = 'SUPERSEDED' WHERE id = $1`, wLive);
    return offerTx(tx, A, w, { notice: noticeA, supersedes: wLive, state: "LOCKED", reason: "הארכה כמחווה", lockedAt: new Date().toISOString(), startsOn: String(locked.s), ...o });
  });
  const endFor = async (v: number, u: string) => {
    const r = await q(owner, null, `SELECT public.service_warranty_end($1::date, $2::int, $3::"ServiceDurationUnit")::text AS d`, String(locked?.s), v, u);
    if (!rows(r)[0]) throw new Error(`endFor: ${String(r)} / locked=${JSON.stringify(locked)}`);
    return String(rows(r)[0].d);
  };
  ok("6.20 after handover: a shorter period → refused", refused(await extend({ value: 10, endsOn: await endFor(10, "DAYS") }), /SERVICE_WARRANTY_AFTER_HANDOVER/));
  ok("6.21 after handover: a different scope → refused", refused(await extend({ value: 60, scope: "רק סוללה", endsOn: await endFor(60, "DAYS") }), /SERVICE_WARRANTY_AFTER_HANDOVER/));
  ok("6.22 after handover: a different start → refused", refused(await extend({ value: 60, startsOn: "2020-01-01", endsOn: "2020-03-01" }), /SERVICE_WARRANTY_AFTER_HANDOVER/));
  const ext = await extend({ value: 60, endsOn: await endFor(60, "DAYS") });
  ok("6.23 after handover: an extension (same scope and start, later end) → accepted, itself LOCKED", succeeded(ext) && await offerState(Number(ext)) === "LOCKED", String(ext));
  ok("6.24 one month after 31 January is 28 February (calendar months, not 30 days)",
    String(rows(await q(owner, null, `SELECT public.service_warranty_end('2027-01-31', 1, 'MONTHS')::text AS d`))[0].d) === "2027-02-28");
  const wq = await openCase(A);
  ok("6.25 source QUOTE without the quote version → refused", refused(await offer(A, wq, { notice: noticeA, source: "QUOTE" }), CHECK));
  ok("6.26 source QUOTE naming a quote version that does not exist → refused", refused(await offer(A, wq, { notice: noticeA, source: "QUOTE", quoteVersion: 7 }), FK));
  ok("6.27 a seq that is not the next → refused", refused(await offer(A, wq, { notice: noticeA, seq: 5 }), /SERVICE_WARRANTY_SEQ/));
  ok("6.28 a first offer with a change reason → refused", refused(await offer(A, wq, { notice: noticeA, reason: "סתם" }), /SERVICE_WARRANTY_FIRST/));
  ok("6.29 a duration over the bound (3651 days) → refused", refused(await offer(A, wq, { notice: noticeA, value: 3651 }), CHECK));
  const discard = num(await offer(A, wq, { notice: noticeA }), "id");
  ok("6.30 a draft is discarded (DRAFT → SUPERSEDED) without a successor → accepted",
    succeeded(await x(runtime, A.biz, `UPDATE "ServiceWarrantyOffer" SET state = 'SUPERSEDED' WHERE id = $1`, discard)));
  ok("6.31 a discarded draft cannot be superseded by a successor (only presented / locked are)",
    refused(await offer(A, wq, { notice: noticeA, supersedes: discard, reason: "ניסיון" }), /SERVICE_WARRANTY_SUPERSEDE/));
  ok("6.32 an offer is never deleted (runtime: no privilege; owner: refused)",
    refused(await x(runtime, A.biz, `DELETE FROM "ServiceWarrantyOffer" WHERE id = $1`, discard), DENIED)
    && refused(await x(owner, null, `DELETE FROM "ServiceWarrantyOffer" WHERE id = $1`, discard), /SERVICE_WARRANTY_NO_DELETE/));

  // ── 7. Intake photos ─────────────────────────────────────────────────────────────────────────────────────
  console.log("7. intake photos");
  const p = await openCase(A);
  await intake(A, p);
  ok("7.1 a key that is not biz/{b}/service/cases/{c}/intake/photos/{sha}.{ext} → refused",
    refused(await photo(A, p, H("1"), { key: `biz/${A.biz}/service/cases/${p}/photos/${H("1")}.jpg` }), CHECK)
    && refused(await photo(A, p, H("1"), { key: photoKey(A, p, H("2")) }), CHECK));
  ok("7.2 an extension that does not match the type → refused", refused(await photo(A, p, H("1"), { key: photoKey(A, p, H("1"), "png") }), CHECK));
  ok("7.3 a type outside jpeg / png / webp → refused", refused(await photo(A, p, H("1"), { mime: "image/heic", key: photoKey(A, p, H("1"), "heic") }), CHECK));
  ok("7.4 over 10 MB → refused", refused(await photo(A, p, H("1"), { size: 10_485_761 }), CHECK));
  ok("7.5 a valid photo → accepted; the same content again → refused",
    succeeded(await photo(A, p, H("1"))) && refused(await photo(A, p, H("1")), UNIQUE));
  for (let i = 2; i <= 9; i++) await photo(A, p, H(String(i)));
  const prace = await Promise.all(["a", "b"].map((c) => photo(A, p, H(c))));
  ok("7.6 the tenth photo raced by two writers → exactly one succeeds (case locked)", prace.filter(succeeded).length === 1, JSON.stringify(prace));
  ok("7.7 an eleventh photo → refused", refused(await photo(A, p, H("c")), /SERVICE_INTAKE_PHOTO_LIMIT/));
  ok("7.8 a photo record never changes or goes (runtime: no privilege; owner: refused)",
    refused(await x(runtime, A.biz, `UPDATE "ServiceIntakePhoto" SET "byteSize" = 1 WHERE "caseId" = $1`, p), DENIED)
    && refused(await x(owner, null, `UPDATE "ServiceIntakePhoto" SET "byteSize" = 1 WHERE "caseId" = $1`, p), /SERVICE_INTAKE_PHOTO_FIXED/)
    && refused(await x(owner, null, `DELETE FROM "ServiceIntakePhoto" WHERE "caseId" = $1`, p), /SERVICE_INTAKE_PHOTO_FIXED/));
  const ps = await openCase(A);
  await intake(A, ps); await sign(A, ps);
  ok("7.9 after the intake is signed → refused (photos frozen)", refused(await photo(A, ps, H("d")), /SERVICE_INTAKE_PHOTO_AFTER_SIGNATURE/));

  // ── 8. Share journal ─────────────────────────────────────────────────────────────────────────────────────
  console.log("8. share journal");
  const sc = await openCase(A);
  const doc = await billingDoc(A);
  const qKey = `biz/${A.biz}/service/cases/${sc}/quotes/v1-${H("e")}.pdf`;
  await x(runtime, A.biz, `INSERT INTO "ServiceQuote" ("businessId", "caseId", version, "billingDocumentId", "totalAgorot", "docHash", "sentPdfKey", "sentPdfSha256", "sentByUserId")
    VALUES ($1, $2, 1, $3, 45000, $4, $5, $6, $7)`, A.biz, sc, doc, H("d"), qKey, H("e"), A.user);
  ok("8.1 the sent quote's own key and hash → accepted", succeeded(await share(A, sc, { key: qKey, sha: H("e") })));
  ok("8.2 a hash that is not the stored copy's → refused", refused(await share(A, sc, { key: qKey, sha: H("f") }), /SERVICE_SHARE_NOT_STORED_COPY/));
  ok("8.3 a quote version that was not sent → refused", refused(await share(A, sc, { qv: 2, key: qKey, sha: H("e") }), /SERVICE_SHARE_NOT_STORED_COPY/));
  ok("8.4 without who shared → refused", refused(await share(A, sc, { key: qKey, sha: H("e"), actor: null }), /SERVICE_SHARE_ACTOR/));
  const idem = ikey();
  ok("8.5 the same idempotency key twice → the second refused (a double tap records once)",
    succeeded(await share(A, sc, { key: qKey, sha: H("e"), idem, channel: "WHATSAPP_MANUAL" })) && refused(await share(A, sc, { key: qKey, sha: H("e"), idem }), UNIQUE));
  await intake(A, sc); await sign(A, sc);
  const slip = `biz/${A.biz}/service/cases/${sc}/intake/slip-${H("7")}.pdf`;
  await x(runtime, A.biz, `UPDATE "ServiceCaseIntake" SET "slipPdfKey" = $2 WHERE "caseId" = $1`, sc, slip);
  ok("8.6 the intake slip: its key and the hash it carries → accepted; another hash → refused",
    succeeded(await share(A, sc, { kind: "INTAKE_SLIP", qv: null, key: slip, sha: H("7"), channel: "DOWNLOAD" }))
    && refused(await share(A, sc, { kind: "INTAKE_SLIP", qv: null, key: slip, sha: H("8") }), /SERVICE_SHARE_NOT_STORED_COPY/));
  ok("8.7 the journal is append-only (runtime: no privilege; owner: refused)",
    refused(await x(runtime, A.biz, `UPDATE "ServiceShareEvent" SET channel = 'DOWNLOAD' WHERE "caseId" = $1`, sc), DENIED)
    && refused(await x(owner, null, `UPDATE "ServiceShareEvent" SET channel = 'DOWNLOAD' WHERE "caseId" = $1`, sc), /SERVICE_SHARE_APPEND_ONLY/)
    && refused(await x(owner, null, `DELETE FROM "ServiceShareEvent" WHERE "caseId" = $1`, sc), /SERVICE_SHARE_APPEND_ONLY/));

  // ── 9. Phone reminders ───────────────────────────────────────────────────────────────────────────────────
  console.log("9. phone reminders (ו3)");
  const notReady = await openCase(A), rc = await readyCase(A);
  ok("9.1 a case that is not READY → refused", refused(await remind(A, notReady), /SERVICE_PHONE_REMINDER_NOT_READY/));
  ok("9.2 a call in the future → refused", refused(await remind(A, rc, { at: new Date(Date.now() + 3600_000).toISOString() }), /SERVICE_PHONE_REMINDER_TIME/));
  ok("9.3 a call before the device was ready → refused", refused(await remind(A, rc, { at: new Date(Date.now() - 86400_000).toISOString() }), /SERVICE_PHONE_REMINDER_TIME/));
  ok("9.4 without who called → refused", refused(await remind(A, rc, { actor: null }), /SERVICE_PHONE_REMINDER_ACTOR/));
  ok("9.5 a note over 1000 characters → refused", refused(await remind(A, rc, { note: "א".repeat(1001) }), CHECK));
  const ri = ikey();
  ok("9.6 REACHED / LEFT_MESSAGE / NO_ANSWER recorded; the same idempotency key twice → once",
    succeeded(await remind(A, rc, { outcome: "NO_ANSWER", idem: ri })) && refused(await remind(A, rc, { idem: ri }), UNIQUE)
    && succeeded(await remind(A, rc, { outcome: "LEFT_MESSAGE", note: "השארתי הודעה" })) && succeeded(await remind(A, rc)));
  ok("9.7 append-only (runtime: no privilege; owner: refused)",
    refused(await x(runtime, A.biz, `UPDATE "ServicePhoneReminder" SET outcome = 'REACHED' WHERE "caseId" = $1`, rc), DENIED)
    && refused(await x(owner, null, `UPDATE "ServicePhoneReminder" SET outcome = 'REACHED' WHERE "caseId" = $1`, rc), /SERVICE_PHONE_REMINDER_APPEND_ONLY/));
  ok("9.8 business B cannot record a reminder on A's case", refused(await remind(Bz, rc), /SERVICE_PHONE_REMINDER_NOT_READY|row-level|foreign key/));

  // ── 10. Deletion: writes refused, erasure door, storage-erasure job ──────────────────────────────────────
  console.log("10. deletion (ו1)");
  const E = await business(`sd3-e-${Date.now()}`);
  const eT = await approvedText(E, "TERMS", "תנאי עסק נמחק"), eN = await approvedText(E, "STATUTORY_NOTICE", "הודעה של עסק נמחק");
  const eCase = await readyCase(E);
  await intake(E, eCase);
  await photo(E, eCase, H("1"));
  await x(runtime, E.biz, `INSERT INTO "ServiceIntakeTermsSnapshot" ("businessId", "caseId", "termsVersionId", "termsSha256", "statutoryNoticeVersionId", "statutorySha256", "presentedByUserId")
    VALUES ($1, $2, $3, $4, $5, $6, $7)`, E.biz, eCase, eT, sha("תנאי עסק נמחק"), eN, sha("הודעה של עסק נמחק"), E.user);
  const eOffer = await offer(E, eCase, { state: "PRESENTED", notice: eN });
  await remind(E, eCase, { note: "דיברתי עם דנה" });
  const ePre = await offer(E, eCase, { notice: eN });  // a draft alongside the presented one
  ok("10.0 fixtures for the deleted business were written", succeeded(eOffer) && succeeded(ePre));
  ok("10.1 not deleting → the erasure door refuses", refused(await q(runtime, E.biz, `SELECT public.service_desk_ui_erase_business() AS n`), /SERVICE_UI_ERASURE_NOT_DELETING/));
  ok("10.2 no tenant context → the door refuses", refused(await q(runtime, null, `SELECT public.service_desk_ui_erase_business() AS n`), /SERVICE_UI_ERASURE_NO_CONTEXT/));
  ok("10.3 the runtime cannot open an erasure job itself (no privilege)",
    refused(await x(runtime, E.biz, `INSERT INTO "ServiceStorageErasure" ("businessId") VALUES ($1)`, E.biz), DENIED));
  ok("10.4 even the owner cannot write the job outside its functions",
    refused(await x(owner, null, `INSERT INTO "ServiceStorageErasure" ("businessId") VALUES ($1)`, E.biz), /SERVICE_STORAGE_ERASURE_FIXED/));
  ok("10.5 the runtime setting the job marker itself is still refused (marker + table owner)",
    refused(await inTx(runtime, E.biz, async (tx) => { await tx.$executeRawUnsafe(`SELECT set_config('dubiz.service_storage_erasure', 'on', true)`);
      return tx.$executeRawUnsafe(`INSERT INTO "ServiceStorageErasure" ("businessId") VALUES ($1)`, E.biz); }), DENIED));
  ok("10.6 the runtime setting the scrub marker cannot blank a journal (no privilege) or a text's author",
    refused(await inTx(runtime, E.biz, async (tx) => { await tx.$executeRawUnsafe(`SELECT set_config('dubiz.service_ui_erasure', 'on', true)`);
      return tx.$executeRawUnsafe(`UPDATE "ServiceTextVersion" SET "createdByUserId" = NULL, "legallyApprovedByUserId" = NULL, "erasedAt" = now() WHERE "businessId" = $1`, E.biz); }), /SERVICE_TEXT_FIXED/));

  await x(owner, null, `UPDATE "Business" SET "deletionRequestedAt" = now() WHERE id = $1`, E.biz);
  const deleting = [
    ["text", text(E, "TERMS", "חדש בזמן מחיקה")],
    ["settings", x(runtime, E.biz, `INSERT INTO "ServiceSettings" ("businessId", "updatedAt") VALUES ($1, now())`, E.biz)],
    ["photo", photo(E, eCase, H("2"))],
    ["offer", offer(E, eCase, { notice: eN, state: "DRAFT" })],
    ["share", share(E, eCase, { kind: "INTAKE_SLIP", qv: null, key: `biz/${E.biz}/service/x/${H("3")}.pdf`, sha: H("3") })],
    ["reminder", remind(E, eCase)],
    ["approve", approve(E, eT)],
  ] as const;
  const dres = await Promise.all(deleting.map(([, pr]) => pr));
  ok("10.7 while the business is being deleted every new write is refused (text, settings, photo, offer, share, reminder, approval)",
    dres.every((r) => refused(r, /SERVICE_UI_BUSINESS_DELETING|SERVICE_TEXT_FIXED/)) && refused(dres[2], /SERVICE_UI_BUSINESS_DELETING/),
    JSON.stringify(dres.map((r, i) => [deleting[i][0], typeof r === "string" ? r.slice(0, 80) : r])));

  // The purge transaction fails AFTER the door ran: nothing of it remains, and no object may be deleted.
  const failed = await inTx(runtime, E.biz, async (tx) => {
    await tx.$queryRawUnsafe(`SELECT public.service_desk_ui_erase_business() AS n`);
    throw new Error("lab: purge failed later in the same transaction");
  });
  ok("10.8 a purge that fails after the door: no job, nothing scrubbed (rolled back together)",
    refused(failed, /lab: purge failed/)
    && num(await q(owner, null, `SELECT count(*)::int AS n FROM "ServiceStorageErasure" WHERE "businessId" = $1`, E.biz)) === 0
    && num(await q(owner, null, `SELECT count(*)::int AS n FROM "ServiceWarrantyOffer" WHERE "businessId" = $1 AND "erasedAt" IS NULL`, E.biz)) === 2);
  ok("10.9 without a committed job the sweeper has nothing: the due list omits it, a pass is refused",
    !rows(await q(runtime, null, `SELECT "businessId" FROM public.service_storage_erasure_due(100)`)).some((r) => Number(r.businessId) === E.biz)
    && refused(await q(runtime, E.biz, `SELECT public.service_storage_erasure_record_pass(0, 0, NULL::text) AS s`), /SERVICE_STORAGE_ERASURE_NO_JOB/));

  const erased = await q(runtime, E.biz, `SELECT public.service_desk_ui_erase_business() AS n`);
  // 2 texts + 1 snapshot + 2 offers + 1 photo + 1 reminder
  ok("10.10 the door scrubs the business's rows in place (7) and opens the job", succeeded(erased) && num(erased) === 7, String(erased));
  const eo = rows(await q(owner, null, `SELECT "changeReason" AS r, "presentedByUserId" AS p, "createdByUserId" AS c, state::text AS s, "durationValue" AS v, "erasedAt" IS NOT NULL AS e
    FROM "ServiceWarrantyOffer" WHERE "businessId" = $1 ORDER BY seq`, E.biz));
  ok("10.11 offers keep their facts (state, duration) and lose who acted", eo.length === 2 && eo.every((r) => r.p === null && r.c === null && r.e === true) && eo[0].s === "PRESENTED" && Number(eo[0].v) === 90, JSON.stringify(eo));
  const er = rows(await q(owner, null, `SELECT note, "actorUserId" AS a, outcome::text AS o FROM "ServicePhoneReminder" WHERE "businessId" = $1`, E.biz))[0];
  ok("10.12 the reminder keeps the outcome and loses the note and the caller", !!er && er.note === null && er.a === null && er.o === "REACHED");
  const et = rows(await q(owner, null, `SELECT body, "createdByUserId" AS c, "legallyApprovedByUserId" AS l, "legalStatus"::text AS s FROM "ServiceTextVersion" WHERE "businessId" = $1 ORDER BY id`, E.biz));
  ok("10.13 texts keep the business's own wording and status; the users are gone", et.length === 2 && et.every((r) => r.c === null && r.l === null && r.s === "LEGALLY_APPROVED" && String(r.body).length > 0));
  ok("10.14 a second run of the door scrubs nothing more and keeps one job",
    num(await q(runtime, E.biz, `SELECT public.service_desk_ui_erase_business() AS n`)) === 0
    && num(await q(owner, null, `SELECT count(*)::int AS n FROM "ServiceStorageErasure" WHERE "businessId" = $1`, E.biz)) === 1);
  ok("10.15 the committed job is due; the due list carries business ids only",
    rows(await q(runtime, null, `SELECT * FROM public.service_storage_erasure_due(100)`)).some((r) => Number(r.businessId) === E.biz && Object.keys(r).length === 1));
  const job = async () => rows(await q(owner, null, `SELECT state::text AS s, attempts, "objectsDeleted"::int AS d, "lastPassRemaining" AS r, "lastError" AS e, "completedAt" AS c FROM "ServiceStorageErasure" WHERE "businessId" = $1`, E.biz))[0];
  const pass_ = (d: number, r: number, e: string | null, ctx = E.biz) => q(runtime, ctx, `SELECT public.service_storage_erasure_record_pass($1::int, $2::int, $3::text) AS s`, d, r, e);
  ok("10.16 a pass that leaves objects → still PENDING (counts recorded)", String(rows(await pass_(5, 3, null))[0]?.s) === "PENDING_OBJECTS" && (await job()).r === 3);
  ok("10.17 a pass that failed (storage error) → still PENDING, the error kept (≤ 500)",
    String(rows(await pass_(0, 3, "R2 503 ".repeat(100)))[0]?.s) === "PENDING_OBJECTS" && String((await job()).e).length === 500);
  ok("10.18 a clean empty listing inside the first hour of quarantine → still PENDING (an in-flight upload may land)",
    String(rows(await pass_(3, 0, null))[0]?.s) === "PENDING_OBJECTS");
  ok("10.19 a crash between passes loses nothing: the job is still due with its counters",
    rows(await q(runtime, null, `SELECT "businessId" FROM public.service_storage_erasure_due(100)`)).some((r) => Number(r.businessId) === E.biz)
    && Number((await job()).attempts) === 3 && Number((await job()).d) === 8);
  ok("10.20 business B cannot record a pass for A's job, nor read it",
    refused(await pass_(0, 0, null, Bz.biz), /SERVICE_STORAGE_ERASURE_NO_JOB/)
    && num(await q(runtime, Bz.biz, `SELECT count(*)::int AS n FROM "ServiceStorageErasure" WHERE "businessId" = $1`, E.biz)) === 0);
  ok("10.21 negative counts → refused", refused(await pass_(-1, 0, null), /SERVICE_STORAGE_ERASURE_INPUT/));
  await x(owner, null, `UPDATE "Business" SET "deletionRequestedAt" = now() - interval '2 hours' WHERE id = $1`, E.biz);
  ok("10.22 quarantine older than an hour, but objects remain → PENDING", String(rows(await pass_(0, 1, null))[0]?.s) === "PENDING_OBJECTS");
  ok("10.23 quarantine older than an hour, a clean empty listing → DONE", String(rows(await pass_(1, 0, null))[0]?.s) === "DONE" && (await job()).c !== null);
  ok("10.24 DONE is final: a later pass changes nothing; the job is no longer due",
    String(rows(await pass_(0, 4, "x"))[0]?.s) === "DONE" && (await job()).r === 0
    && !rows(await q(runtime, null, `SELECT "businessId" FROM public.service_storage_erasure_due(100)`)).some((r) => Number(r.businessId) === E.biz));
  ok("10.25 the owner cannot reopen or delete the job",
    refused(await x(owner, null, `UPDATE "ServiceStorageErasure" SET state = 'PENDING_OBJECTS', "completedAt" = NULL WHERE "businessId" = $1`, E.biz), /SERVICE_STORAGE_ERASURE_FIXED/)
    && refused(await x(owner, null, `DELETE FROM "ServiceStorageErasure" WHERE "businessId" = $1`, E.biz), /SERVICE_STORAGE_ERASURE_FIXED/));
  // A business with no Service Desk data at all: the door succeeds (the purge must not break for it).
  const N = await business(`sd3-n-${Date.now()}`);
  await x(owner, null, `UPDATE "Business" SET "deletionRequestedAt" = now() WHERE id = $1`, N.biz);
  ok("10.26 a business with no service data: the door succeeds (0 rows) and opens its job",
    num(await q(runtime, N.biz, `SELECT public.service_desk_ui_erase_business() AS n`)) === 0
    && num(await q(owner, null, `SELECT count(*)::int AS n FROM "ServiceStorageErasure" WHERE "businessId" = $1`, N.biz)) === 1);
  // A job alone (deletion flag hypothetically cleared) still refuses uploads.
  const J = await business(`sd3-j-${Date.now()}`);
  const jCase = await openCase(J);
  await intake(J, jCase);
  await x(owner, null, `UPDATE "Business" SET "deletionRequestedAt" = now() WHERE id = $1`, J.biz);
  await q(runtime, J.biz, `SELECT public.service_desk_ui_erase_business() AS n`);
  await x(owner, null, `UPDATE "Business" SET "deletionRequestedAt" = NULL WHERE id = $1`, J.biz);
  ok("10.27 an open erasure job alone refuses new photo rows (no object key may enter a business being erased)",
    refused(await photo(J, jCase, H("4")), /SERVICE_UI_BUSINESS_DELETING/));
  ok("10.28 business A (not deleting) is untouched by E's erasure",
    num(await q(owner, null, `SELECT count(*)::int AS n FROM "ServiceWarrantyOffer" WHERE "businessId" = $1 AND "erasedAt" IS NOT NULL`, A.biz)) === 0
    && num(await q(owner, null, `SELECT count(*)::int AS n FROM "ServiceStorageErasure" WHERE "businessId" = $1`, A.biz)) === 0);
  // A user removed by the owner: ON DELETE SET NULL passes the guards, the content stays.
  const U = num(await q(owner, null, `INSERT INTO "User" (email, "businessId", "updatedAt") VALUES ($1, $2, now()) RETURNING id AS n`, `sd3-u-${Date.now()}@lab.invalid`, A.biz));
  const uText = num(await q(runtime, A.biz, `INSERT INTO "ServiceTextVersion" ("businessId", kind, version, body, "bodySha256", "createdByUserId")
    VALUES ($1, 'TERMS', (SELECT max(version) + 1 FROM "ServiceTextVersion" WHERE "businessId" = $1 AND kind = 'TERMS'), 'נוסח של משתמש שיוסר', encode(sha256(convert_to('נוסח של משתמש שיוסר','UTF8')),'hex'), $2) RETURNING id`, A.biz, U), "id");
  const delU = await x(owner, null, `DELETE FROM "User" WHERE id = $1`, U);
  ok("10.29 removing a user: the reference becomes NULL, the text stays",
    succeeded(delU) && rows(await q(owner, null, `SELECT "createdByUserId" AS c, body FROM "ServiceTextVersion" WHERE id = $1`, uText))[0]?.c === null, String(delU));
}

main()
  .catch((e) => { failures.push(`crash: ${(e as Error).message}`); console.error(e); })
  .finally(async () => {
    console.log(`\n${pass} passed, ${failures.length} failed`);
    if (failures.length) console.log("FAILED:\n  " + failures.join("\n  "));
    await owner.$disconnect(); await runtime.$disconnect();
    process.exit(failures.length ? 1 : 0);
  });
