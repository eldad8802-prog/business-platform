/**
 * Transactional email — PR-2 application battery, against the real migration and the real roles.
 *
 *   OWNER_URL    the migration owner (fixtures and read-back only)
 *   AUTH_URL     a LOGIN member of app_auth — the signup / delivery plane (AUTH_DATABASE_URL)
 *   RUNTIME_URL  app_runtime_prod — the tenant plane (DATABASE_URL)
 *
 * It drives the REAL code: createAccount (the signup transaction), the real login route, delivery
 * and the sweep on the auth plane with an injected fake provider (no network), and erasure stage 2's
 * statement through the real tenant job / transaction on the tenant plane (the whole stage 2 runs in
 * the AD-2A battery). Synthetic data only.
 *
 * The lab is the auth-plane write lab (.authfix/auth-plane-write-battery.ts): the schema plus the
 * shipped auth-plane migrations and this one, verbatim, with LOGIN members of app_auth / app_runtime.
 *
 * Run: OWNER_URL=… AUTH_URL=… RUNTIME_URL=… npx tsx .te/app-battery.ts
 */
import { PrismaClient } from "@prisma/client";

const OWNER_URL = process.env.OWNER_URL!;
const AUTH_URL = process.env.AUTH_URL!;
const RUNTIME_URL = process.env.RUNTIME_URL!;
if (!OWNER_URL || !AUTH_URL || !RUNTIME_URL) {
  console.error("OWNER_URL, AUTH_URL and RUNTIME_URL are required");
  process.exit(2);
}
// The application's own clients, exactly as Production configures them.
process.env.AUTH_PLANE_ENABLED = "true";
process.env.AUTH_DATABASE_URL = AUTH_URL;
process.env.DATABASE_URL = RUNTIME_URL;
process.env.AUTH_TOKEN_SECRET ??= "te-app-battery-synthetic-token-secret-0123456789";
process.env.RATE_LIMIT_BACKEND = "memory";
delete process.env.TRANSACTIONAL_EMAIL_ENABLED; // OFF unless a check passes its own env

const ON = {
  TRANSACTIONAL_EMAIL_ENABLED: "true",
  RESEND_API_KEY: "re_synthetic_battery_key",
  TRANSACTIONAL_EMAIL_FROM: "Dubiz <sender@mail.battery.test>",
  TRANSACTIONAL_EMAIL_REPLY_TO: "reply@battery.test",
  APP_BASE_URL: "https://app.battery.test",
};

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass += 1;
    console.log(`  [PASS] ${name}`);
  } else {
    fail += 1;
    console.error(`  [FAIL] ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
async function rejects(fn: () => Promise<unknown>, re: RegExp): Promise<boolean> {
  try {
    await fn();
    return false;
  } catch (e) {
    const m = e instanceof Error ? `${e.message} ${(e as { code?: string }).code ?? ""} ${JSON.stringify((e as { meta?: unknown }).meta ?? "")}` : String(e);
    return re.test(m);
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Sent = { idempotencyKey: string; to: string; subject: string; html: string; text: string; from: string; replyTo: string | null };
function fakeProvider(script: (n: number) => Promise<import("../lib/email/transactional/provider").SendResult> | import("../lib/email/transactional/provider").SendResult) {
  const calls: Sent[] = [];
  return {
    calls,
    provider: {
      name: "fake",
      async send(m: Sent) {
        calls.push(m);
        return script(calls.length);
      },
    },
  };
}
const SENT = { outcome: "sent" as const, providerMessageId: "fake-msg" };

async function main() {
  const owner = new PrismaClient({ datasourceUrl: OWNER_URL });
  const runtime = new PrismaClient({ datasourceUrl: RUNTIME_URL });
  const { createAccount, EmailAlreadyRegisteredError } = await import("../lib/auth/signup");
  const { authDb } = await import("../lib/prisma-auth");
  const { enqueueWelcomeEmail, enqueueTransactionalEmail } = await import("../lib/email/transactional/store");
  const { deliverTransactionalEmail, CLAIM_LEASE_MS } = await import("../lib/email/transactional/delivery");
  const { runTransactionalEmailSweep } = await import("../lib/email/transactional/sweep");
  const { runTenantJob } = await import("../lib/tenant/job");
  const { withTenantTransaction } = await import("../lib/tenant/transaction");
  const { POST: loginPOST } = await import("../app/api/auth/login/route");

  const tag = `te${Date.now().toString(36)}`;
  const rowsOf = (userId: number) => owner.transactionalEmail.findMany({ where: { userId } });
  const total = () => owner.transactionalEmail.count();

  // A user who existed before this code: no backfill may ever give them a row.
  const oldBiz = await owner.business.create({ data: { name: `${tag} pre-existing` } });
  const oldUser = await owner.user.create({ data: { email: `${tag}-old@battery.test`, password: "x", name: "ותיק", businessId: oldBiz.id } });
  const before = await total();

  const signup = (n: string, name = "דנה כהן") =>
    createAccount({ email: `${tag}-${n}@battery.test`, passwordHash: "$2b$10$abcdefghijklmnopqrstuuTkV4bBuvZ4Lr1nYp0V.Qj1m3XyQnA2", name, businessName: `${tag} ${n}`, now: new Date() });

  console.log("--- signup records exactly one WELCOME, in the account transaction ---");
  const a = await signup("a");
  const aRows = await rowsOf(a.userId);
  ok("signup → exactly one WELCOME row for the new user", aRows.length === 1 && aRows[0].kind === "WELCOME");
  const r = aRows[0];
  ok("signup → createAccount returns that row's id", a.welcomeEmailId === r.id);
  ok("the row: stable dedupe key welcome:user:<id>", r.dedupeKey === `welcome:user:${a.userId}`);
  ok("the row: bound to the new business and user, addressed to the signup email",
    r.businessId === a.businessId && r.userId === a.userId && r.toEmail === `${tag}-a@battery.test`);
  ok("the row: PENDING, 0 attempts, due now, he", r.status === "PENDING" && r.attempts === 0 && r.locale === "he" && r.nextAttemptAt !== null);
  ok("the row: payload is the first name and nothing else", JSON.stringify(r.payload) === JSON.stringify({ firstName: "דנה" }));
  ok("the row: lifetime exactly 24h", r.expiresAt.getTime() - r.createdAt.getTime() === 24 * 3600_000);
  ok("the row: timestamps are UTC (createdAt within a minute of now)", Math.abs(r.createdAt.getTime() - Date.now()) < 60_000);

  console.log("--- double submit / retry ---");
  ok("a second signup with the same email → EmailAlreadyRegistered",
    await rejects(() => signup("a"), /./) && (await signup("a").catch((e) => e)) instanceof EmailAlreadyRegisteredError);
  ok("…and still exactly one WELCOME for that account", (await rowsOf(a.userId)).length === 1);
  ok("…and no second business / row was left behind", (await owner.business.count({ where: { name: `${tag} a` } })) === 1);
  const again = await authDb().$transaction((tx) => enqueueWelcomeEmail(tx, { userId: a.userId, businessId: a.businessId, toEmail: r.toEmail, name: "דנה", now: new Date() }));
  ok("re-enqueueing the same WELCOME returns the same row and writes none", again === r.id && (await rowsOf(a.userId)).length === 1);

  console.log("--- rollback leaves nothing ---");
  const n0 = await total();
  const failed = await createAccount({ email: "x", passwordHash: "h", name: "x", businessName: `${tag} rollback`, now: new Date() }).catch((e) => e);
  ok("a signup that fails in its transaction throws", failed instanceof Error);
  ok("…leaves no WELCOME row", (await total()) === n0);
  ok("…and no business, no user (the whole account rolled back)",
    (await owner.business.count({ where: { name: `${tag} rollback` } })) === 0 && (await owner.user.count({ where: { email: "x" } })) === 0);
  const b0 = await signup("b0");
  await authDb().$transaction(async (tx) => {
    await enqueueTransactionalEmail(tx, { kind: "WELCOME", dedupeKey: `${tag}:rolled`, userId: b0.userId, businessId: b0.businessId, toEmail: "r@battery.test", payload: {}, now: new Date() });
    throw new Error("abort");
  }).catch(() => undefined);
  ok("an enqueue whose transaction aborts leaves no row", (await owner.transactionalEmail.count({ where: { dedupeKey: `${tag}:rolled` } })) === 0);

  console.log("--- tenant binding (signup plane) ---");
  const b = await signup("b", "יוסי");
  ok("a row naming A's user under B's business is refused by RLS",
    await rejects(() => authDb().$transaction((tx) => enqueueTransactionalEmail(tx, {
      kind: "WELCOME", dedupeKey: `${tag}:cross`, userId: a.userId, businessId: b.businessId, toEmail: "c@battery.test", payload: {}, now: new Date(),
    })), /row-level security|42501/));
  ok("…and nothing was written", (await owner.transactionalEmail.count({ where: { dedupeKey: `${tag}:cross` } })) === 0);

  console.log("--- the tenant runtime cannot read content ---");
  ok("runtime: reading the full row (toEmail / payload) → permission denied",
    await rejects(() => runtime.transactionalEmail.findMany(), /permission denied|42501/));
  ok("runtime: reading toEmail alone → permission denied",
    await rejects(() => runtime.transactionalEmail.findMany({ select: { toEmail: true } }), /permission denied|42501/));
  const seenByA = await runtime.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_business_id', ${String(a.businessId)}, true)`;
    return tx.transactionalEmail.findMany({ select: { id: true, businessId: true } });
  });
  ok("runtime: (id, businessId) inside A's context → A's rows only", seenByA.length >= 1 && seenByA.every((x) => x.businessId === a.businessId));
  const seenNoCtx = await runtime.transactionalEmail.findMany({ select: { id: true, businessId: true } });
  ok("runtime: no tenant context → nothing", seenNoCtx.length === 0);
  ok("runtime: cannot UPDATE", await rejects(() => runtime.transactionalEmail.updateMany({ data: { status: "SENT" } }), /permission denied|42501/));

  console.log("--- flag OFF: row exists, nothing is sent ---");
  {
    const { provider, calls } = fakeProvider(() => SENT);
    const snap = await owner.transactionalEmail.findUnique({ where: { id: b.welcomeEmailId! } });
    const out = await deliverTransactionalEmail(b.welcomeEmailId!, { provider, env: {} });
    const sweep = await runTransactionalEmailSweep({ provider, env: {} });
    const after = await owner.transactionalEmail.findUnique({ where: { id: b.welcomeEmailId! } });
    ok("OFF: delivery → disabled; sweep → { enabled: false }", out === "disabled" && sweep.enabled === false);
    ok("OFF: zero provider calls", calls.length === 0);
    ok("OFF: the row is untouched (PENDING, 0 attempts, same updatedAt)",
      after!.status === "PENDING" && after!.attempts === 0 && after!.updatedAt.getTime() === snap!.updatedAt.getTime());
  }

  console.log("--- delivery: send, idempotency key, no second send ---");
  {
    const { provider, calls } = fakeProvider(() => SENT);
    const out = await deliverTransactionalEmail(a.welcomeEmailId!, { provider, env: ON });
    const row = await owner.transactionalEmail.findUnique({ where: { id: a.welcomeEmailId! } });
    ok("deliver → sent", out === "sent");
    ok("the row → SENT, 1 attempt, sentAt, provider + message id, no error",
      row!.status === "SENT" && row!.attempts === 1 && row!.sentAt !== null && row!.provider === "fake" && row!.providerMessageId === "fake-msg" && row!.lastErrorCode === null && row!.nextAttemptAt === null);
    ok("one provider call, key te:<row id>, to the signup address, configured sender",
      calls.length === 1 && calls[0].idempotencyKey === `te:${a.welcomeEmailId}` && calls[0].to === `${tag}-a@battery.test` && calls[0].from === ON.TRANSACTIONAL_EMAIL_FROM && calls[0].replyTo === ON.TRANSACTIONAL_EMAIL_REPLY_TO);
    ok("the WELCOME rendered from the stored payload", calls[0].subject === "ברוכים הבאים ל־Dubiz 👋" && calls[0].text.startsWith("היי דנה,") && calls[0].html.includes("https://app.battery.test/app"));
    const again2 = await deliverTransactionalEmail(a.welcomeEmailId!, { provider, env: ON });
    ok("a SENT row is never claimed again (no second email)", again2 === "not_claimable" && calls.length === 1);
  }

  console.log("--- retry: 503 / 429 / network, then success, same key ---");
  {
    const c = await signup("c");
    const id = c.welcomeEmailId!;
    const t0 = new Date();
    const answers = [
      { outcome: "retryable" as const, code: "provider_503", retryAfterMs: null },
      { outcome: "retryable" as const, code: "rate_limited", retryAfterMs: 10 * 60_000 },
      { outcome: "retryable" as const, code: "network", retryAfterMs: null },
      SENT,
    ];
    const { provider, calls } = fakeProvider((n) => answers[n - 1]);
    const o1 = await deliverTransactionalEmail(id, { provider, env: ON, now: t0 });
    const r1 = await owner.transactionalEmail.findUnique({ where: { id } });
    ok("503 → retry scheduled: PENDING, 1 attempt, next in 1 minute, code kept",
      o1 === "retry_scheduled" && r1!.status === "PENDING" && r1!.attempts === 1 && r1!.lastErrorCode === "provider_503" && r1!.nextAttemptAt!.getTime() - t0.getTime() === 60_000);
    const early = await deliverTransactionalEmail(id, { provider, env: ON, now: new Date(t0.getTime() + 30_000) });
    ok("not due yet → not claimed, not sent", early === "not_claimable" && calls.length === 1);
    const t1 = new Date(t0.getTime() + 61_000);
    const o2 = await deliverTransactionalEmail(id, { provider, env: ON, now: t1 });
    const r2 = await owner.transactionalEmail.findUnique({ where: { id } });
    ok("429 with Retry-After 10m → next attempt honours it", o2 === "retry_scheduled" && r2!.lastErrorCode === "rate_limited" && r2!.nextAttemptAt!.getTime() - t1.getTime() === 10 * 60_000);
    const t2 = new Date(t1.getTime() + 10 * 60_000 + 1000);
    const o3 = await deliverTransactionalEmail(id, { provider, env: ON, now: t2 });
    ok("network failure → retry scheduled", o3 === "retry_scheduled" && (await owner.transactionalEmail.findUnique({ where: { id } }))!.lastErrorCode === "network");
    const t3 = new Date(t2.getTime() + 16 * 60_000);
    const o4 = await deliverTransactionalEmail(id, { provider, env: ON, now: t3 });
    const r4 = await owner.transactionalEmail.findUnique({ where: { id } });
    ok("…then success → SENT after 4 attempts", o4 === "sent" && r4!.status === "SENT" && r4!.attempts === 4);
    ok("every attempt carried the SAME idempotency key", calls.length === 4 && calls.every((x) => x.idempotencyKey === `te:${id}`));
  }

  console.log("--- permanent 4xx ---");
  {
    const d = await signup("d");
    const { provider, calls } = fakeProvider(() => ({ outcome: "permanent", code: "rejected_422" }));
    const out = await deliverTransactionalEmail(d.welcomeEmailId!, { provider, env: ON });
    const row = await owner.transactionalEmail.findUnique({ where: { id: d.welcomeEmailId! } });
    ok("validation 4xx → FAILED, code kept, no next attempt", out === "failed" && row!.status === "FAILED" && row!.lastErrorCode === "rejected_422" && row!.nextAttemptAt === null);
    const again3 = await deliverTransactionalEmail(d.welcomeEmailId!, { provider, env: ON, now: new Date(Date.now() + 3600_000) });
    ok("a FAILED row is never retried", again3 === "not_claimable" && calls.length === 1);
  }

  console.log("--- expiry ---");
  {
    const e = await signup("e");
    await owner.transactionalEmail.update({ where: { id: e.welcomeEmailId! }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const { provider, calls } = fakeProvider(() => SENT);
    const direct = await deliverTransactionalEmail(e.welcomeEmailId!, { provider, env: ON });
    ok("an expired row cannot be claimed", direct === "not_claimable" && calls.length === 0);
    const report = await runTransactionalEmailSweep({ provider, env: ON });
    const row = await owner.transactionalEmail.findUnique({ where: { id: e.welcomeEmailId! } });
    ok("the sweep settles it EXPIRED and never sends it", row!.status === "EXPIRED" && row!.lastErrorCode === "expired" && calls.every((x) => x.idempotencyKey !== `te:${e.welcomeEmailId}`));
    ok("the sweep reports the expiry", report.enabled === true && "expired" in report && report.expired >= 1);
  }

  console.log("--- concurrent workers cannot double-send ---");
  {
    const f = await signup("f");
    const { provider, calls } = fakeProvider(async () => {
      await sleep(300);
      return SENT;
    });
    const outs = await Promise.all(Array.from({ length: 12 }, () => deliverTransactionalEmail(f.welcomeEmailId!, { provider, env: ON })));
    const row = await owner.transactionalEmail.findUnique({ where: { id: f.welcomeEmailId! } });
    ok("12 concurrent workers → exactly ONE provider call", calls.length === 1, `calls=${calls.length}`);
    ok("…one 'sent', eleven 'not_claimable'", outs.filter((o) => o === "sent").length === 1 && outs.filter((o) => o === "not_claimable").length === 11, JSON.stringify(outs));
    ok("…and the row was claimed once (1 attempt)", row!.status === "SENT" && row!.attempts === 1);
    const g = await signup("g");
    const s = fakeProvider(async () => {
      await sleep(200);
      return SENT;
    });
    await Promise.all([
      runTransactionalEmailSweep({ provider: s.provider, env: ON }),
      runTransactionalEmailSweep({ provider: s.provider, env: ON }),
      runTransactionalEmailSweep({ provider: s.provider, env: ON }),
    ]);
    const perKey = new Map<string, number>();
    for (const call of s.calls) perKey.set(call.idempotencyKey, (perKey.get(call.idempotencyKey) ?? 0) + 1);
    ok("3 concurrent sweeps → every row sent at most once", [...perKey.values()].every((n) => n === 1) && perKey.get(`te:${g.welcomeEmailId}`) === 1, JSON.stringify([...perKey]));
  }

  console.log("--- a dead worker's lease, and the fence ---");
  {
    const h = await signup("h");
    const id = h.welcomeEmailId!;
    await owner.transactionalEmail.update({ where: { id }, data: { status: "SENDING", attempts: 1, nextAttemptAt: new Date(Date.now() - 1000) } });
    const { provider, calls } = fakeProvider(() => SENT);
    const out = await deliverTransactionalEmail(id, { provider, env: ON });
    ok("a SENDING row whose lease ran out is re-claimed and sent with the SAME key",
      out === "sent" && calls[0].idempotencyKey === `te:${id}` && (await owner.transactionalEmail.findUnique({ where: { id } }))!.attempts === 2);
    const live = await signup("i");
    await owner.transactionalEmail.update({ where: { id: live.welcomeEmailId! }, data: { status: "SENDING", attempts: 1, nextAttemptAt: new Date(Date.now() + CLAIM_LEASE_MS) } });
    const held = await deliverTransactionalEmail(live.welcomeEmailId!, { provider, env: ON });
    ok("a SENDING row whose lease is live is NOT claimed", held === "not_claimable" && calls.length === 1);
    const j = await signup("j");
    const stolen = fakeProvider(async () => {
      // While this worker waits on the provider, its lease is taken over (attempt bumped).
      await owner.transactionalEmail.update({ where: { id: j.welcomeEmailId! }, data: { attempts: 9 } });
      return SENT;
    });
    const lost = await deliverTransactionalEmail(j.welcomeEmailId!, { provider: stolen.provider, env: ON });
    ok("a worker that lost its claim cannot record an outcome (fenced on the attempt)",
      lost === "lost_claim" && (await owner.transactionalEmail.findUnique({ where: { id: j.welcomeEmailId! } }))!.status === "SENDING");
  }

  console.log("--- login does not enqueue ---");
  {
    const pw = "battery-login-pw-1";
    const bcrypt = (await import("bcrypt")).default;
    const k = await createAccount({ email: `${tag}-k@battery.test`, passwordHash: await bcrypt.hash(pw, 4), name: "כ", businessName: `${tag} k`, now: new Date() });
    const n1 = await total();
    const res = await loginPOST(new Request("https://app.battery.test/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.7" },
      body: JSON.stringify({ email: `${tag}-k@battery.test`, password: pw }),
    }));
    ok("a real login succeeds", res.status === 200, String(res.status));
    ok("…and writes no transactional email", (await total()) === n1 && (await rowsOf(k.userId)).length === 1);
  }

  console.log("--- account erasure: same tenant only ---");
  {
    const bRowsBefore = await owner.transactionalEmail.count({ where: { businessId: b.businessId } });
    const aRowsBefore = await owner.transactionalEmail.count({ where: { businessId: a.businessId } });
    ok("fixture: A and B both have rows", aRowsBefore >= 1 && bRowsBefore >= 1);
    // Cross-tenant: inside B's context, a delete aimed at A's rows reaches nothing.
    const crossDeleted = await runtime.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_business_id', ${String(b.businessId)}, true)`;
      return tx.transactionalEmail.deleteMany({ where: { businessId: a.businessId } });
    });
    ok("runtime inside B's context deleting A's rows → 0 rows", crossDeleted.count === 0 && (await owner.transactionalEmail.count({ where: { businessId: a.businessId } })) === aRowsBefore);
    const noCtx = await runtime.transactionalEmail.deleteMany({ where: { businessId: a.businessId } });
    ok("runtime with no tenant context → 0 rows", noCtx.count === 0);
    // Erasure stage 2's statement, verbatim, through the real tenant job and transaction.
    const erased = await runTenantJob(
      { businessId: a.businessId },
      () => withTenantTransaction((tx) => tx.transactionalEmail.deleteMany({ where: { businessId: a.businessId } })),
      { checkLifecycle: async () => undefined }
    );
    ok("erasure stage 2 (tenant job, A's context) removes A's transactional email",
      erased.count === aRowsBefore && (await owner.transactionalEmail.count({ where: { businessId: a.businessId } })) === 0);
    ok("…and leaves B's untouched", (await owner.transactionalEmail.count({ where: { businessId: b.businessId } })) === bRowsBefore);
    ok("…and no row anywhere still carries A's address", (await owner.transactionalEmail.count({ where: { toEmail: `${tag}-a@battery.test` } })) === 0);
  }

  console.log("--- no backfill ---");
  ok("a user who existed before has no transactional email", (await owner.transactionalEmail.count({ where: { userId: oldUser.id } })) === 0);
  const signups = await owner.user.count({ where: { email: { startsWith: `${tag}-` }, NOT: { id: oldUser.id } } });
  ok("every row in the table came from a signup in this run (one per account)",
    (await owner.transactionalEmail.count({ where: { createdAt: { gte: new Date(Date.now() - 3600_000) }, kind: "WELCOME" } })) <= signups + before);

  await owner.$disconnect();
  await runtime.$disconnect();
  await authDb().$disconnect();
  console.log(`\n[transactional-email app battery] PASS=${pass} FAIL=${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
