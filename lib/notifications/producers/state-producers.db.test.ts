/**
 * The state producers A–E inside the status sweep, on a real database, AS THE RESTRICTED RUNTIME (NOSUPERUSER
 * NOBYPASSRLS, a member of app_runtime), over the real migration 20261210090000_notification_engine_foundation (built
 * by `.nte/lab.sh <db> --with-nte`). No push is sent (the sweep only writes rows; the worker is not run).
 *
 *   write          an engine-ON business: obligation due today + overdue (legacy secretary store) + a payables-ledger
 *                  commitment of its own (a backfilled copy is NOT read twice), a customer payment that failed, a link
 *                  expired > 24 h unpaid, a failed document, a confirmed appointment in 45 minutes ⇒ one whole-business
 *                  row each; PUSH owed only for the payment and the appointment (catalog defaults), with the TTL;
 *                  no row for: a link-creation failure, a request paid by another request of the same invoice, a
 *                  processing document, a cancelled appointment, a later appointment, a MET obligation
 *   isolation      the other business gets only its own facts; neither runtime sees the other's rows
 *   no duplicate   a second pass five minutes later: no new row, no new delivery
 *   resolve        handled ⇒ resolved: obligation MET (store state), the failed request paid by a newer request,
 *                  the document retried (processing), the appointment cancelled; rescheduled ⇒ the old key resolves and
 *                  the new start is a new row; an overdue obligation moving to its next stage resolves the previous
 *   ITA            integration off (no PRODUCTION runtime / pilot) ⇒ nothing; on ⇒ FAILED and stuck (> 60 min) rows; a
 *                  fresh SUBMITTED is not stuck; APPROVED ⇒ resolved
 *   feature off    appointments / documents DISABLED ⇒ no such rows; engine OFF ⇒ nothing
 *   lock           another holder of the business's advisory lock ⇒ the producers skip (leaseBusy), nothing written
 *   time zone      BookingSettings America/New_York ⇒ local time in the reminder; Asia/Jerusalem across the October
 *                  2026 DST change: the due DAY and the reminder's local time
 *   owned facts    the sweep's narrow reads produce the same owned items as the full home snapshot
 *
 * env: DATABASE_URL / DIRECT_URL = the runtime login (app_runtime_prod), OWNER_URL = the migration role (fixtures
 * only). Synthetic data only. Run: npx tsx lib/notifications/producers/state-producers.db.test.ts
 */
import { PrismaClient, Prisma } from "@prisma/client";

let failed = 0;
let checks = 0;
function ok(name: string, cond: boolean, extra?: unknown): void {
  checks += 1;
  if (cond) console.log(`  [PASS] ${name}`);
  else {
    failed += 1;
    console.log(`  [FAIL] ${name}`, extra === undefined ? "" : JSON.stringify(extra, (_k, v) => (typeof v === "bigint" ? Number(v) : v)).slice(0, 800));
  }
}

async function main() {
  delete process.env.BILLING_AUTHORITY_RUNTIME_ENVIRONMENT;
  delete process.env.BILLING_AUTHORITY_PRODUCTION_PILOT_BUSINESS_IDS;
  delete process.env.BILLING_AUTHORITY_PRODUCTION_PILOT_OPERATIONS;
  delete process.env.SECRETARY_LEDGER_STORE;
  const { runStatusSweep, loadOwnedFacts, availableScopes, selectSweepItems } = await import("./status-sweep");
  const { SWEEP_LOCK_NAMESPACE } = await import("./state-producers");
  const { tenantTx } = await import("@/lib/tenant/tenant-tx");
  const { runWithTenantContext } = await import("@/lib/tenant/context");
  const { getBusinessStatusSnapshot } = await import("@/lib/business-status/business-status.service");
  const { businessGates } = await import("../engine/engine-gate");
  const { buildDedupeKey } = await import("../notification-policy");

  const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;
  const T0 = new Date();
  const at = (ms: number) => new Date(T0.getTime() + ms);
  const q = { quiet: true, concurrency: 2 } as const;

  /* ── fixtures (owner) ──────────────────────────────────────────────────────────────────────────────────────── */
  for (const [key, def] of [["notifications_engine", false], ["billing", true], ["inventory", true], ["documents", true], ["appointments", true]] as const) {
    await owner.$executeRawUnsafe(`INSERT INTO "PlatformFeatureDefinition" ("key", "displayName", "category", "description", "defaultEnabled", "mutable")
      VALUES ($1, $1, 'lab', 'lab', $2, true) ON CONFLICT ("key") DO NOTHING`, key, def);
  }
  const stamp = Date.now();
  const biz = async (name: string, engine: boolean, off: string[] = []) => {
    const b = await owner.business.create({ data: { name: `${name}-${stamp}` } });
    await owner.businessFeatureAccess.createMany({
      data: ["notifications_engine", "billing", "inventory", "documents", "appointments"].map((featureKey) => ({
        businessId: b.id, featureKey, state: featureKey === "notifications_engine" ? (engine ? "ENABLED" as const : "DISABLED" as const) : off.includes(featureKey) ? "DISABLED" as const : "ENABLED" as const,
      })),
    });
    await owner.user.create({ data: { email: `u-${name}-${stamp}@nte6b.lab`, password: "x", businessId: b.id } });
    return b.id;
  };
  const A = await biz("st-A", true);
  const B = await biz("st-B", true);
  const C = await biz("st-C", false);
  const D = await biz("st-D", true, ["appointments", "documents"]);
  const NY = await biz("st-NY", true);
  const J = await biz("st-J", true);
  await owner.bookingSettings.create({ data: { businessId: NY, timeZone: "America/New_York" } as never });

  const obligation = (businessId: number, dueAt: Date, over: Record<string, unknown> = {}) =>
    owner.businessObligation.create({ data: { businessId, obligeeName: "משכיר", amount: new Prisma.Decimal("1200.00"), dueAt, ...over } as never, select: { id: true } });
  const doc = (businessId: number, status: string) =>
    owner.document.create({ data: { businessId, fileUrl: "lab://x", source: "upload", mimeType: "application/pdf", status }, select: { id: true } });
  const appt = (businessId: number, startsAt: Date, status = "CONFIRMED") =>
    owner.appointment.create({ data: { businessId, status, startsAt, durationMinutes: 30, createdByActor: "CUSTOMER", sourceChannel: "PUBLIC_BOOKING", kind: "CUSTOMER" } as never, select: { id: true } });
  const invoice = (businessId: number, status = "ISSUED") =>
    owner.billingDocument.create({ data: { businessId, documentType: "TAX_INVOICE", status } as never, select: { id: true } });
  const payReq = (businessId: number, over: Record<string, unknown>) =>
    owner.paymentRequest.create({ data: { businessId, provider: "CARDCOM", amount: new Prisma.Decimal("250.00"), ...over } as never, select: { id: true } });

  const aDue = await obligation(A, at(0));
  const aLate = await obligation(A, at(-3 * DAY));
  await obligation(A, at(-2 * DAY), { state: "MET", metAt: at(-DAY) });
  await obligation(A, at(10 * DAY));
  // A payables-ledger commitment of the business's own, overdue — and a backfilled copy of a legacy obligation.
  const own = await owner.commitment.create({ data: { businessId: A, title: "ליסינג", payeeNameSnapshot: "חברה", scheduleKind: "ONE_OFF" } as never, select: { id: true } });
  const ownInst = await owner.installment.create({ data: { businessId: A, commitmentId: own.id, sequence: 1, scheduledAmount: new Prisma.Decimal("900.00"), dueAt: at(-DAY) } as never, select: { id: true } });
  const copy = await owner.commitment.create({ data: { businessId: A, title: "copy", payeeNameSnapshot: "משכיר", scheduleKind: "ONE_OFF", legacyObligationId: aLate.id } as never, select: { id: true } });
  await owner.installment.create({ data: { businessId: A, commitmentId: copy.id, sequence: 1, scheduledAmount: new Prisma.Decimal("1200.00"), dueAt: at(-3 * DAY) } as never });

  const inv1 = await invoice(A);
  const inv2 = await invoice(A);
  const aPayFailed = await payReq(A, { status: "FAILED", paymentUrl: "https://pay.lab/1", billingDocumentId: inv1.id, createdAt: at(-2 * DAY) });
  await owner.paymentTransaction.create({ data: { paymentRequestId: aPayFailed.id, provider: "CARDCOM", amount: new Prisma.Decimal("250.00"), status: "FAILED" } as never });
  await payReq(A, { status: "FAILED", paymentUrl: null }); // link creation failed on screen
  await payReq(A, { status: "FAILED", paymentUrl: "https://pay.lab/2", billingDocumentId: inv2.id, createdAt: at(-3 * DAY) });
  await payReq(A, { status: "PAID", paymentUrl: "https://pay.lab/3", billingDocumentId: inv2.id, createdAt: at(-2 * DAY), paidAt: at(-2 * DAY) }); // inv2 paid by another request
  const aPayExpired = await payReq(A, { status: "PENDING", paymentUrl: "https://pay.lab/4", expiresAt: at(-25 * HOUR), createdAt: at(-5 * DAY) });
  await payReq(A, { status: "PENDING", paymentUrl: "https://pay.lab/5", expiresAt: at(-2 * HOUR), createdAt: at(-5 * DAY) }); // inside the grace

  const aDocFailed = await doc(A, "failed");
  await doc(A, "processing");
  const aAppt = await appt(A, at(45 * MIN));
  await appt(A, at(40 * MIN), "CANCELED");
  await appt(A, at(3 * HOUR));
  const aMove = await appt(A, at(50 * MIN));

  const inv3 = await invoice(A);
  const inv4 = await invoice(A);
  const inv5 = await invoice(A);
  const subFailed = await owner.billingAuthoritySubmission.create({ data: { businessId: A, billingDocumentId: inv3.id, status: "FAILED", lastAttemptAt: at(-HOUR) } as never, select: { id: true } });
  const subStuck = await owner.billingAuthoritySubmission.create({ data: { businessId: A, billingDocumentId: inv4.id, status: "SUBMITTED", submittedAt: at(-2 * HOUR), lastAttemptAt: at(-2 * HOUR), createdAt: at(-2 * HOUR) } as never, select: { id: true } });
  await owner.billingAuthoritySubmission.create({ data: { businessId: A, billingDocumentId: inv5.id, status: "SUBMITTED", submittedAt: at(-5 * MIN), lastAttemptAt: at(-5 * MIN) } as never });

  const bDoc = await doc(B, "failed");
  const bAppt = await appt(B, at(45 * MIN));
  await doc(C, "failed");
  await appt(C, at(45 * MIN));
  await obligation(C, at(0));
  await doc(D, "failed");
  await appt(D, at(45 * MIN));
  const dObl = await obligation(D, at(0));

  // A pending-review billing document + supplier draft for the owned-facts equivalence check.
  await invoice(A, "PENDING_REVIEW");
  await owner.supplierPurchaseDraft.create({ data: { businessId: A, status: "PENDING_REVIEW", supplierName: "ספק" } as never });

  const PROD = ["obligations.due", "payments.request_failed", "billing.allocation_failed", "documents.processing_failed", "appointments.upcoming"];
  const rows = (businessId: number) => owner.notification.findMany({ where: { businessId, semanticCategory: { in: PROD } }, orderBy: { id: "asc" } });
  const open = async (businessId: number) => (await rows(businessId)).filter((n) => n.resolvedAt === null);
  const deliveries = (businessId: number) => owner.notificationDelivery.findMany({ where: { businessId, notification: { semanticCategory: { in: PROD } } }, orderBy: { id: "asc" } });
  const day = (d: Date, tz = "Asia/Jerusalem") => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

  /* ── 1. write ──────────────────────────────────────────────────────────────────────────────────────────────── */
  console.log("1. write");
  const r1 = await runStatusSweep(T0, { ...q, businessIds: [A, B, C, D] });
  ok("report: three engine-ON businesses swept, one OFF, no error, no producer failure", r1.swept === 3 && r1.engineOff === 1 && r1.errors === 0 && r1.producersFailed === 0, r1);
  const aKeys = (await open(A)).map((n) => n.dedupeKey).sort();
  const want = [
    `st:obligations.due:business_obligation:${aDue.id}:${day(at(0))}:due`,
    `st:obligations.due:business_obligation:${aLate.id}:${day(at(-3 * DAY))}:late3`,
    `st:obligations.due:installment:${ownInst.id}:${day(at(-DAY))}:late1`,
    `st:payments.request_failed:payment_request:${aPayFailed.id}:failed`,
    `st:payments.request_failed:payment_request:${aPayExpired.id}:expired`,
    `st:documents.processing_failed:document_processing:${aDocFailed.id}`,
    `st:appointments.upcoming:appointment:${aAppt.id}:${at(45 * MIN).toISOString()}`,
    `st:appointments.upcoming:appointment:${aMove.id}:${at(50 * MIN).toISOString()}`,
  ].sort();
  ok("A: exactly the real facts, one row each (no link-creation failure, no paid-elsewhere, no grace-period link, no processing doc, no cancelled / later appointment, no MET obligation, the ledger copy not read twice, ITA off)",
    JSON.stringify(aKeys) === JSON.stringify(want), { aKeys, want });
  const aRows = await open(A);
  ok("A: whole-business rows (userId NULL) with the catalog category in semanticCategory", aRows.every((n) => n.userId === null && PROD.includes(n.semanticCategory)));
  ok("A: deep links — secretary / payables / the request / the document / the calendar",
    aRows.some((n) => n.href === "/secretary") && aRows.some((n) => n.href === "/payables") && aRows.some((n) => n.href === `/payments/${aPayFailed.id}`) &&
    aRows.some((n) => n.href === `/documents/review/${aDocFailed.id}`) && aRows.some((n) => n.href === "/calendar"));
  const aDel = await deliveries(A);
  const pushRows = aDel.filter((d) => d.channel === "PUSH");
  const pushCats = new Set(pushRows.map((d) => aRows.find((n) => n.id === d.notificationId)?.semanticCategory));
  ok("A: in-app delivery for every row", aRows.every((n) => aDel.some((d) => d.notificationId === n.id && d.channel === "IN_APP" && d.status === "SENT")));
  // notify() owes ONE push row per notification whenever the category MAY push (a user can switch it on); the worker
  // decides with the user's preferences — under the catalog defaults obligations / documents end 'pref_off' (never sent).
  ok("A: one owed PUSH per row (PENDING, whole business) — the worker applies the defaults", pushRows.length === aRows.length && pushRows.every((d) => d.status === "PENDING" && d.userId === null), { n: pushRows.length, pushCats: [...pushCats] });
  const { getCategory } = await import("../catalog");
  ok("catalog defaults: push for payments / appointments, digest (no push) for obligations / documents",
    getCategory("payments.request_failed")!.defaults.push && getCategory("appointments.upcoming")!.defaults.push &&
    !getCategory("obligations.due")!.defaults.push && getCategory("obligations.due")!.defaults.delivery === "digest" &&
    !getCategory("documents.processing_failed")!.defaults.push && getCategory("documents.processing_failed")!.defaults.delivery === "digest");
  const apptPush = pushRows.find((d) => aRows.find((n) => n.id === d.notificationId)?.semanticCategory === "appointments.upcoming")!;
  ok("A: the appointment push expires 30 min after creation — before the start", Math.abs(apptPush.expiresAt!.getTime() - T0.getTime() - 30 * MIN) < 5_000);
  const oblPush = pushRows.find((d) => aRows.find((n) => n.id === d.notificationId)?.semanticCategory === "obligations.due")!;
  ok("A: an obligation's owed row carries the 12 h TTL", Math.abs(oblPush.expiresAt!.getTime() - T0.getTime() - 12 * HOUR) < 5_000);
  ok("the sweep kicked the worker for the businesses that owe a push (no-op outside a request)", r1.kicked >= 2, r1);

  console.log("2. isolation / feature off / engine off");
  const bKeys = (await open(B)).map((n) => n.dedupeKey).sort();
  ok("B: only its own failed document and appointment", JSON.stringify(bKeys) === JSON.stringify([
    `st:appointments.upcoming:appointment:${bAppt.id}:${at(45 * MIN).toISOString()}`, `st:documents.processing_failed:document_processing:${bDoc.id}`,
  ].sort()), bKeys);
  ok("B's runtime cannot read A's rows (RLS)", (await tenantTx(B, (tx) => tx.notification.count({ where: { businessId: A } }))) === 0);
  ok("A's runtime cannot read B's rows (RLS)", (await tenantTx(A, (tx) => tx.notification.count({ where: { businessId: B } }))) === 0);
  ok("C (engine OFF): nothing", (await rows(C)).length === 0);
  const dKeys = (await open(D)).map((n) => n.dedupeKey);
  ok("D (appointments + documents DISABLED): only its obligation", dKeys.length === 1 && dKeys[0]!.includes(`business_obligation:${dObl.id}:`), dKeys);

  /* ── 3. no duplicate ───────────────────────────────────────────────────────────────────────────────────────── */
  console.log("3. no duplicate across passes");
  const nRows = (await rows(A)).length;
  const nDel = (await deliveries(A)).length;
  const r2 = await runStatusSweep(at(5 * MIN), { ...q, businessIds: [A, A, B] });
  ok("five minutes later: no new row, no new delivery (dedupe key + cooldown); a repeated id is swept once",
    (await rows(A)).length === nRows && (await deliveries(A)).length === nDel && r2.producerNotified === 0 && r2.businesses === 2, { r2 });

  /* ── 4. resolve after handling ─────────────────────────────────────────────────────────────────────────────── */
  console.log("4. resolve after handling");
  await owner.businessObligation.update({ where: { id: aDue.id }, data: { state: "MET", metAt: at(6 * MIN) } });
  await payReq(A, { status: "PAID", paymentUrl: "https://pay.lab/6", billingDocumentId: inv1.id, createdAt: at(6 * MIN), paidAt: at(6 * MIN) });
  await owner.document.update({ where: { id: aDocFailed.id }, data: { status: "processing" } });
  await owner.appointment.update({ where: { id: aAppt.id }, data: { status: "CANCELED" } });
  await owner.appointment.update({ where: { id: aMove.id }, data: { startsAt: at(55 * MIN) } });
  const r3 = await runStatusSweep(at(7 * MIN), { ...q, businessIds: [A] });
  const resolvedKeys = (await rows(A)).filter((n) => n.resolvedAt !== null).map((n) => n.dedupeKey).sort();
  ok("handled ⇒ resolved: obligation MET, payment paid by a newer request, document retried, appointment cancelled, the old start of the moved one",
    JSON.stringify(resolvedKeys) === JSON.stringify([
      `st:obligations.due:business_obligation:${aDue.id}:${day(at(0))}:due`,
      `st:payments.request_failed:payment_request:${aPayFailed.id}:failed`,
      `st:documents.processing_failed:document_processing:${aDocFailed.id}`,
      `st:appointments.upcoming:appointment:${aAppt.id}:${at(45 * MIN).toISOString()}`,
      `st:appointments.upcoming:appointment:${aMove.id}:${at(50 * MIN).toISOString()}`,
    ].sort()), { resolvedKeys, r3 });
  const moved = (await open(A)).find((n) => n.dedupeKey === `st:appointments.upcoming:appointment:${aMove.id}:${at(55 * MIN).toISOString()}`);
  ok("rescheduled ⇒ the new start is a new row with its own owed push", moved !== undefined && (await deliveries(A)).some((d) => d.notificationId === moved.id && d.channel === "PUSH"));
  ok("B untouched by A's handling", (await open(B)).length === 2);
  const r4 = await runStatusSweep(at(4 * DAY), { ...q, businessIds: [A] });
  const lateKeys = (await rows(A)).filter((n) => n.dedupeKey.includes(`business_obligation:${aLate.id}:`));
  ok("the overdue obligation moves to its next stage (day 7): a new row, the day-3 row resolved",
    lateKeys.length === 2 && lateKeys.some((n) => n.dedupeKey.endsWith(":late7") && n.resolvedAt === null) && lateKeys.some((n) => n.dedupeKey.endsWith(":late3") && n.resolvedAt !== null), { keys: lateKeys.map((n) => [n.dedupeKey, n.resolvedAt]), r4 });

  /* ── 5. ITA ────────────────────────────────────────────────────────────────────────────────────────────────── */
  console.log("5. ITA allocation numbers");
  const ita = async () => (await open(A)).filter((n) => n.semanticCategory === "billing.allocation_failed").map((n) => n.dedupeKey).sort();
  ok("integration off: no allocation row despite FAILED / stuck submissions", (await ita()).length === 0);
  process.env.BILLING_AUTHORITY_RUNTIME_ENVIRONMENT = "SANDBOX";
  process.env.BILLING_AUTHORITY_PRODUCTION_PILOT_BUSINESS_IDS = String(A);
  process.env.BILLING_AUTHORITY_PRODUCTION_PILOT_OPERATIONS = "oauth,submissions";
  await runStatusSweep(at(4 * DAY + MIN), { ...q, businessIds: [A] });
  ok("SANDBOX runtime: still nothing", (await ita()).length === 0);
  process.env.BILLING_AUTHORITY_RUNTIME_ENVIRONMENT = "PRODUCTION";
  await runStatusSweep(T0, { ...q, businessIds: [A] });
  ok("PRODUCTION + pilot: the FAILED and the stuck (2 h) submissions, not the fresh one (5 min)", JSON.stringify(await ita()) === JSON.stringify([
    `st:billing.allocation_failed:billing_authority_submission:${subFailed.id}:failed`, `st:billing.allocation_failed:billing_authority_submission:${subStuck.id}:stuck`,
  ].sort()), await ita());
  await owner.billingAuthoritySubmission.update({ where: { id: subFailed.id }, data: { status: "APPROVED", allocationNumber: "123456789" } });
  await runStatusSweep(at(MIN), { ...q, businessIds: [A] });
  ok("APPROVED ⇒ resolved; the stuck one stays", JSON.stringify(await ita()) === JSON.stringify([`st:billing.allocation_failed:billing_authority_submission:${subStuck.id}:stuck`]), await ita());
  process.env.BILLING_AUTHORITY_PRODUCTION_PILOT_BUSINESS_IDS = "999999";
  await runStatusSweep(at(2 * MIN), { ...q, businessIds: [A] });
  ok("pilot no longer admits the business: nothing new, and the open row is NOT resolved by an unswept scope", (await ita()).length === 1);
  delete process.env.BILLING_AUTHORITY_RUNTIME_ENVIRONMENT;

  /* ── 6. lock ───────────────────────────────────────────────────────────────────────────────────────────────── */
  console.log("6. per-business lock");
  await doc(B, "failed");
  const before = (await rows(B)).length;
  const held = await owner.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${SWEEP_LOCK_NAMESPACE}::int, ${B}::int)`;
    return runStatusSweep(at(8 * MIN), { ...q, businessIds: [B] });
  }, { timeout: 30_000 });
  ok("another holder of B's lock: the producers skip, nothing written", held.leaseBusy === 1 && (await rows(B)).length === before, held);
  const after = await runStatusSweep(at(9 * MIN), { ...q, businessIds: [B] });
  ok("released: the next pass writes the new failure (nothing lost)", after.leaseBusy === 0 && (await rows(B)).length === before + 1, after);

  /* ── 7. time zones ─────────────────────────────────────────────────────────────────────────────────────────── */
  console.log("7. time zones");
  const nyStart = new Date("2026-11-01T14:00:00Z"); // 09:00 New York, the day its clocks go back
  await appt(NY, nyStart);
  await runStatusSweep(new Date("2026-11-01T13:10:00Z"), { ...q, businessIds: [NY] });
  const nyRow = (await open(NY)).find((n) => n.semanticCategory === "appointments.upcoming");
  ok("BookingSettings America/New_York: the reminder shows 09:00 local", nyRow?.summary?.includes("09:00") === true, nyRow?.summary);
  const jDue = await obligation(J, new Date("2026-10-24T22:30:00Z")); // 01:30 on 25 Oct in Jerusalem
  const jAppt = await appt(J, new Date("2026-10-25T06:30:00Z")); // 08:30 local after the change (UTC+2)
  await runStatusSweep(new Date("2026-10-25T05:40:00Z"), { ...q, businessIds: [J] });
  const jRows = await open(J);
  ok("Jerusalem, October DST day: the obligation is due on the 25th (not the UTC 24th)", jRows.some((n) => n.dedupeKey === `st:obligations.due:business_obligation:${jDue.id}:2026-10-25:due`), jRows.map((n) => n.dedupeKey));
  ok("…and the reminder shows 08:30 local", jRows.find((n) => n.entityId === jAppt.id)?.summary?.includes("08:30") === true);

  /* ── 8. owned facts = the home snapshot's ──────────────────────────────────────────────────────────────────── */
  console.log("8. owned facts");
  const gates = await businessGates(A);
  const narrow = await runWithTenantContext({ businessId: A }, () => loadOwnedFacts(A, availableScopes(gates), new Date()));
  const full = await runWithTenantContext({ businessId: A }, () => getBusinessStatusSnapshot(A));
  const nk = selectSweepItems(narrow.items, gates).map((i) => buildDedupeKey(A, i)).sort();
  const fk = selectSweepItems(full.items, gates).map((i) => buildDedupeKey(A, i)).sort();
  ok("the narrow reads produce exactly the full snapshot's owned items", nk.length > 0 && JSON.stringify(nk) === JSON.stringify(fk), { nk, fk });
  ok("…with complete present sets for every owned scope", Object.values(narrow.present).every((p) => p!.complete));

  await owner.$disconnect();
  console.log(`\n[state-producers.db] checks=${checks} FAIL=${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
