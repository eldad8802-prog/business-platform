/**
 * Milestone C — migration 20261106090000_public_booking_foundation, AS the real roles (.bkg/lab.sh):
 *
 *   1. The ledger: the migration is recorded and finished; nothing else is pending.
 *   2. Additive: rows that existed before the migration (.bkg/pre.sql) keep everything and take the safe defaults —
 *      no staff member becomes public, settings default to BALANCED / self-cancel 24 h / per-phone cap 2 / staff
 *      names shown, address, details and prices hidden.
 *   3. The new checks refuse out-of-range values (owner and runtime alike).
 *   4. The three doors: SECURITY DEFINER, search_path pinned, owned by the migration role; EXECUTE for app_runtime and
 *      nobody else (not PUBLIC, not app_auth).
 *   5. booking_resolve_public answers only for an ENABLED link of a live business, by exact id, and only an id: a
 *      disabled link, a deleted business, an unknown or a malformed id resolve to nothing; the runtime role still
 *      cannot read BookingSettings across businesses itself.
 *   6. booking_pending_due lists PENDING requests that are expired or two hours old, ids and times only, for live
 *      businesses; never a decided one; the limit holds.
 *   7. Isolation is unchanged: in business A's context the runtime sees nothing of B's settings, staff or requests.
 *
 * env: OWNER_URL, RUNTIME_URL. Synthetic only. ZERO network. Raw SQL only.
 */
import { PrismaClient, type Prisma } from "@prisma/client";

const withPool = (url: string) => `${url}${url.includes("?") ? "&" : "?"}connection_limit=8&pool_timeout=30`;
const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });
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
  }, { timeout: 30_000 }).catch((e: Error) => e.message);
}
const q = (client: PrismaClient, guc: number | null, sql: string, ...args: unknown[]) =>
  inTx(client, guc, (tx) => tx.$queryRawUnsafe(sql, ...args) as Promise<Rows>);
const x = (client: PrismaClient, guc: number | null, sql: string, ...args: unknown[]) =>
  inTx(client, guc, (tx) => tx.$executeRawUnsafe(sql, ...args));
const rows = (r: unknown): Rows => (Array.isArray(r) ? (r as Rows) : []);
const num = (r: unknown, key = "n") => Number(rows(r)[0]?.[key] ?? NaN);
const refused = (r: unknown, re: RegExp) => typeof r === "string" && re.test(r);
const CHECK = /check constraint|23514/i;
const DENIED = /permission denied/i;
const ids = (r: unknown, key: string) => rows(r).map((x) => Number(x[key])).sort((a, b) => a - b);

async function main() {
  // ── 1. Ledger ──────────────────────────────────────────────────────────────────────────────────
  console.log("1. ledger");
  ok("1.1 the migration is recorded and finished",
    num(await q(owner, null, `SELECT count(*)::int AS n FROM "_prisma_migrations" WHERE migration_name = '20261106090000_public_booking_foundation' AND finished_at IS NOT NULL AND rolled_back_at IS NULL`)) === 1);
  ok("1.2 no migration is unfinished or rolled back",
    num(await q(owner, null, `SELECT count(*)::int AS n FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL`)) === 0);

  // ── 2. Existing rows keep everything and take the safe defaults ───────────────────────────────
  console.log("2. existing rows");
  const pre = rows(await q(owner, null, `SELECT b.id AS biz FROM "Business" b WHERE b.name = 'bkg-pre-A'`));
  const bizA = Number(pre[0]?.biz);
  ok("2.0 the pre-migration fixture exists (.bkg/pre.sql)", Number.isInteger(bizA) && bizA > 0);
  const staff = rows(await q(owner, null, `SELECT "displayName", "publicBookable", active FROM "StaffMember" WHERE "businessId" = $1 ORDER BY id`, bizA));
  ok("2.1 existing staff: unchanged, and NOT public", staff.length === 2 && staff.every((s) => s.publicBookable === false) && staff[0].displayName === "דנה" && staff[0].active === true, JSON.stringify(staff));
  const st = rows(await q(owner, null, `SELECT enabled, "publicId", "defaultApprovalMode"::text AS approval, "pendingTtlMinutes" AS ttl,
      "assignmentMode"::text AS assign, "selfCancelEnabled" AS sce, "selfCancelWindowHours" AS scw, "maxOpenRequestsPerPhone" AS cap,
      "showAddress" AS sa, "showBusinessDetails" AS sd, "showPrices" AS sp, "showStaffNames" AS ss, version FROM "BookingSettings" WHERE "businessId" = $1`, bizA))[0];
  ok("2.2 existing settings: their own values kept", !!st && st.enabled === true && st.approval === "MANUAL" && Number(st.ttl) === 720 && Number(st.version) === 1, JSON.stringify(st));
  ok("2.3 …and the defaults: BALANCED, self-cancel on, 24 h, cap 2, staff names shown, address / details / prices hidden",
    !!st && st.assign === "BALANCED" && st.sce === true && Number(st.scw) === 24 && Number(st.cap) === 2 && st.ss === true && st.sa === false && st.sd === false && st.sp === false, JSON.stringify(st));
  ok("2.4 the column and the enum are NOT NULL with their defaults",
    num(await q(owner, null, `SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name IN ('StaffMember','BookingSettings') AND column_name IN ('publicBookable','assignmentMode','selfCancelEnabled','selfCancelWindowHours','maxOpenRequestsPerPhone','showAddress','showBusinessDetails','showPrices','showStaffNames') AND is_nullable = 'NO' AND column_default IS NOT NULL`)) === 9);

  // ── 3. The new checks ─────────────────────────────────────────────────────────────────────────
  console.log("3. checks");
  ok("3.1 a self-cancel window over 720 hours is refused", refused(await x(owner, null, `UPDATE "BookingSettings" SET "selfCancelWindowHours" = 721 WHERE "businessId" = $1`, bizA), CHECK));
  ok("3.2 a negative window is refused", refused(await x(owner, null, `UPDATE "BookingSettings" SET "selfCancelWindowHours" = -1 WHERE "businessId" = $1`, bizA), CHECK));
  ok("3.3 a per-phone cap of 0 is refused", refused(await x(owner, null, `UPDATE "BookingSettings" SET "maxOpenRequestsPerPhone" = 0 WHERE "businessId" = $1`, bizA), CHECK));
  ok("3.4 a per-phone cap over 10 is refused (the runtime too)", refused(await x(runtime, bizA, `UPDATE "BookingSettings" SET "maxOpenRequestsPerPhone" = 11 WHERE "businessId" = $1`, bizA), CHECK));
  ok("3.5 the runtime can set the business's own values in its own context",
    (await x(runtime, bizA, `UPDATE "BookingSettings" SET "assignmentMode" = 'PRIORITY', "selfCancelWindowHours" = 48, "showPrices" = true WHERE "businessId" = $1`, bizA)) === 1
    && num(await q(owner, null, `SELECT count(*)::int AS n FROM "BookingSettings" WHERE "businessId" = $1 AND "assignmentMode" = 'PRIORITY' AND "selfCancelWindowHours" = 48`, bizA)) === 1);

  // ── 4. The doors: definer, pinned path, owner, EXECUTE ──────────────────────────────────────────
  console.log("4. functions");
  const fns = rows(await q(owner, null, `SELECT p.proname AS name, p.prosecdef AS def, array_to_string(p.proconfig, ',') AS cfg, pg_get_userbyid(p.proowner) AS own,
      has_function_privilege('app_runtime', p.oid, 'EXECUTE') AS rt, has_function_privilege('app_auth', p.oid, 'EXECUTE') AS au,
      EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0) AS pub
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname IN ('booking_resolve_public','booking_pending_due','booking_resolve_manage_token') ORDER BY 1`));
  ok("4.1 the three functions exist", fns.length === 3, JSON.stringify(fns));
  ok("4.2 SECURITY DEFINER with search_path pinned to pg_catalog, public", fns.length === 3 && fns.every((f) => f.def === true && String(f.cfg).includes("search_path=pg_catalog, public")));
  ok("4.3 owned by the migration role", fns.every((f) => f.own === "lab_owner"), JSON.stringify(fns.map((f) => f.own)));
  ok("4.4 EXECUTE for app_runtime", fns.every((f) => f.rt === true));
  ok("4.5 …and NOT for PUBLIC or app_auth", fns.every((f) => f.pub === false && f.au === false));

  // ── 5. booking_resolve_public ─────────────────────────────────────────────────────────────────
  console.log("5. resolve");
  const live = "bkgPublicIdLive_0123456789AB";
  const off = "bkgPublicIdOff__0123456789AB";
  const gone = "bkgPublicIdGone_0123456789AB";
  const mk = async (name: string, publicId: string, enabled: boolean, deleted = false) => {
    const b = num(await q(owner, null, `INSERT INTO "Business" (name, "updatedAt"${deleted ? `, "deletionRequestedAt"` : ""}) VALUES ($1, now()${deleted ? ", now()" : ""}) RETURNING id AS n`, name));
    await x(owner, null, `INSERT INTO "BookingSettings" ("businessId", enabled, "publicId", "updatedAt") VALUES ($1, $2, $3, now())`, b, enabled, publicId);
    return b;
  };
  const bizLive = await mk("bkg-live", live, true);
  const bizOff = await mk("bkg-off", off, false);
  await mk("bkg-gone", gone, true, true);
  const resolve = (id: string) => q(runtime, null, `SELECT booking_resolve_public AS id FROM public.booking_resolve_public($1)`, id);
  ok("5.1 an enabled link of a live business → its id, and only an id", ids(await resolve(live), "id").join() === String(bizLive)
    && Object.keys(rows(await resolve(live))[0] ?? {}).join() === "id");
  ok("5.2 a disabled link → nothing", rows(await resolve(off)).length === 0);
  ok("5.3 a business being deleted → nothing", rows(await resolve(gone)).length === 0);
  ok("5.4 an unknown id → nothing", rows(await resolve("bkgPublicIdNope_0123456789AB")).length === 0);
  ok("5.5 a malformed id (short / SQL-ish / wildcard) → nothing, never an error",
    rows(await resolve("short")).length === 0 && rows(await resolve("' OR 1=1 --xxxxxxxxxxxxxxxxx")).length === 0 && rows(await resolve("%%%%%%%%%%%%%%%%%%%%%%%%")).length === 0);
  ok("5.6 the runtime cannot read BookingSettings without a business context (RLS)",
    num(await q(runtime, null, `SELECT count(*)::int AS n FROM "BookingSettings"`)) === 0);
  ok("5.7 …and in business A's context sees only A's row", ids(await q(runtime, bizA, `SELECT "businessId" AS b FROM "BookingSettings"`), "b").join() === String(bizA));
  ok("5.8 the runtime cannot write a function of its own into public", refused(await x(runtime, null, `CREATE FUNCTION public.bkg_probe() RETURNS int LANGUAGE sql AS 'SELECT 1'`), DENIED));

  // ── 6. booking_pending_due ─────────────────────────────────────────────────────────────────────
  console.log("6. pending due");
  // Each fixture appointment in its own hour: they share the business's lane, and the no-overlap constraint holds.
  let slot = 0;
  const appt = async (b: number, startsHoursAhead: number) => num(await q(owner, null,
    `INSERT INTO "Appointment" ("businessId", status, "startsAt", "endsAt", "durationMinutes", "createdByActor", "sourceChannel", kind, "updatedAt")
     VALUES ($1, 'PROPOSED', now() + ($2 || ' hours')::interval, now() + ($2 || ' hours')::interval + interval '30 minutes', 30, 'CUSTOMER', 'PUBLIC_BOOKING', 'CUSTOMER', now()) RETURNING id AS n`, b, String(startsHoursAhead)));
  const request = async (b: number, createdHoursAgo: number, expiresInHours: number, status = "PENDING") => num(await q(owner, null,
    `INSERT INTO "BookingRequest" ("businessId", "appointmentId", status, "contactName", "contactPhone", fingerprint, "expiresAt", "decidedAt", "createdAt", "updatedAt")
     VALUES ($1, $2, $3::text::"BookingRequestStatus", 'לקוח לדוגמה', '972500000000', encode(sha256(random()::text::bytea), 'hex'),
             now() + ($4 || ' hours')::interval, CASE WHEN $6::text = 'PENDING' THEN NULL ELSE now() END, now() - ($5 || ' hours')::interval, now()) RETURNING id AS n`,
    b, await appt(b, 24 + slot++), status, String(expiresInHours), String(createdHoursAgo), status));
  const fresh = await request(bizLive, 0.5, 11);
  const reminded = await request(bizLive, 3, 9);
  const expired = await request(bizLive, 1, -0.1);
  const decided = await request(bizLive, 5, 7, "APPROVED");
  const due = (limit = 100) => q(runtime, null, `SELECT "businessId" AS b, "requestId" AS r, "createdAt", "expiresAt" FROM public.booking_pending_due(now()::timestamp(3), $1::int)`, limit);
  const got = ids(await due(), "r");
  ok("6.1 a request two hours old (reminder) and an expired one are due", got.includes(reminded) && got.includes(expired), JSON.stringify(got));
  ok("6.2 a fresh, unexpired request is not", !got.includes(fresh));
  ok("6.3 a decided request is never listed", !got.includes(decided));
  ok("6.4 ids and times only", Object.keys(rows(await due())[0] ?? {}).sort().join() === ["b", "createdAt", "expiresAt", "r"].sort().join());
  ok("6.5 the limit holds", rows(await due(1)).length === 1);
  ok("6.6 the runtime still cannot read those requests without a context", num(await q(runtime, null, `SELECT count(*)::int AS n FROM "BookingRequest"`)) === 0);

  // ── 6b. booking_resolve_manage_token ───────────────────────────────────────────────────────────
  console.log("6b. manage token");
  const hash = (t: string) => q(owner, null, `SELECT encode(sha256($1::bytea), 'hex') AS h`, t).then((r) => String(rows(r)[0]?.h));
  const tok = async (b: number, raw: string, expiresInHours: number, revoked = false) => {
    await x(owner, null, `INSERT INTO "AppointmentManageToken" ("businessId", "appointmentId", "tokenHash", "expiresAt", "revokedAt", "createdAt")
      VALUES ($1, $2, $3, now() + ($4 || ' hours')::interval, CASE WHEN $5 THEN now() ELSE NULL END, now() - interval '2 hours')`,
      b, await appt(b, 48 + slot++), await hash(raw), String(expiresInHours), revoked);
  };
  await tok(bizLive, "live-token", 24);
  await tok(bizLive, "revoked-token", 24, true);
  await tok(bizLive, "stale-token", -1);
  const byToken = async (raw: string) => q(runtime, null, `SELECT booking_resolve_manage_token AS id FROM public.booking_resolve_manage_token($1)`, await hash(raw));
  ok("6b.1 a live token's hash → its business id only", ids(await byToken("live-token"), "id").join() === String(bizLive));
  ok("6b.2 a revoked token → nothing", rows(await byToken("revoked-token")).length === 0);
  ok("6b.3 an expired token → nothing", rows(await byToken("stale-token")).length === 0);
  ok("6b.4 an unknown hash, a raw token or a malformed value → nothing", rows(await byToken("nope")).length === 0
    && rows(await q(runtime, null, `SELECT * FROM public.booking_resolve_manage_token('live-token')`)).length === 0
    && rows(await q(runtime, null, `SELECT * FROM public.booking_resolve_manage_token('%')`)).length === 0);
  ok("6b.5 the runtime cannot read tokens without a context", num(await q(runtime, null, `SELECT count(*)::int AS n FROM "AppointmentManageToken"`)) === 0);

  // ── 7. Isolation unchanged ─────────────────────────────────────────────────────────────────────
  console.log("7. isolation");
  ok("7.1 in A's context: none of the live business's requests", num(await q(runtime, bizA, `SELECT count(*)::int AS n FROM "BookingRequest" WHERE "businessId" = $1`, bizLive)) === 0);
  ok("7.2 in A's context: none of another business's staff", num(await q(runtime, bizA, `SELECT count(*)::int AS n FROM "StaffMember" WHERE "businessId" <> $1`, bizA)) === 0);
  ok("7.3 A cannot make another business's staff public", (await x(runtime, bizA, `UPDATE "StaffMember" SET "publicBookable" = true WHERE "businessId" <> $1`, bizA)) === 0
    && num(await q(owner, null, `SELECT count(*)::int AS n FROM "StaffMember" WHERE "businessId" <> $1 AND "publicBookable"`, bizA)) === 0);
  ok("7.4 A cannot enable another business's link", (await x(runtime, bizA, `UPDATE "BookingSettings" SET enabled = true WHERE "businessId" = $1`, bizOff)) === 0
    && rows(await resolve(off)).length === 0);

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) { console.log(failures.map((f) => ` - ${f}`).join("\n")); process.exitCode = 1; }
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(async () => { await owner.$disconnect(); await runtime.$disconnect(); });
