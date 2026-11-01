/**
 * Webhook reliability A+B — the pure half (in-memory store, stub provider; no DB, no network, no crypto key).
 *   npx tsx lib/services/payments/payment-webhook-reliability.test.ts
 *
 *   A  Database unavailable when the callback arrives → 503, nothing stored, and the SAME 503 for a real and a
 *      made-up request (no oracle); a callback refused before any lookup is still 200 even then.
 *   B  Database fails mid-processing (event row stored, then a write fails) → 503; the redelivery after recovery
 *      records the payment exactly once.
 *   C  Provider verification API unavailable (VERIFICATION_ERROR, swallowed inside the service) → 503; event FAILED;
 *      redelivery → PAID once.
 *   D  Redelivery of the same event, sequential and concurrent → one PaymentTransaction, one accounting settlement,
 *      settlement asked for that one transaction only.
 *   E  Unauthenticated / unknown / mismatched callbacks → 200 { ok: true } (unchanged), indistinguishable.
 *   F  A non-infrastructure error (a bug) → 200, as before — no retry storm on a defect.
 *   G  No infrastructure detail leaves: bodies are fixed, and no log line carries the host, user or password.
 *   H  The routes: every webhook route answers through webhookResponse / webhookRouteFailure, logs no
 *      `error.message`, and a route-level infrastructure failure is a 503 with Retry-After.
 *   I  Classification: Prisma / driver / wording → transient; validation, unique violation, TypeError → not.
 *   J  Reconciliation batch: signalled first, then fresh, and a fair share that is ALWAYS reserved; no starvation
 *      over many runs; tenants with signalled requests interleaved, never exclusive; caps and isolation hold.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { handleProviderWebhook } from "./payment-webhook-handler";
import { createInMemoryPaymentStore } from "./payment-store.memory";
import { createStubProvider } from "./providers/stub/stub.provider";
import type { ProcessWebhookDeps } from "./payment-webhook.service";
import type { PaymentProviderAdapter } from "./providers/payment-provider.types";
import type { PaymentRequestRecord, PaymentStore } from "./payments.types";
import {
  answerForError,
  isTransientInfrastructureError,
  RETRY_LATER,
} from "./payment-webhook-failure";
import { webhookResponse, webhookRouteFailure } from "./payment-webhook-response";
import {
  FAIR_SHARE_RATIO,
  orderBusinesses,
  runPaymentReconciliation,
  selectReconciliationBatch,
} from "./payment-reconciliation.service";

const out = (line: string) => process.stdout.write(`${line}\n`);
let passed = 0;
async function ok(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed += 1;
  out(`  ✓ ${name}`);
}

// ── fixtures ────────────────────────────────────────────────────────────────────────────────────────────────────
const SECRET_HOST = "ep-secret-host-998877.c-2.us-east-1.aws.neon.tech";
const SECRET_PW = "SuperSecretDbPassword";
function dbDown(): Error {
  const e = new Error(`Can't reach database server at \`${SECRET_HOST}:5432\` postgresql://app_runtime_prod:${SECRET_PW}@${SECRET_HOST}`) as Error & { errorCode?: string };
  e.name = "PrismaClientInitializationError";
  e.errorCode = "P1001";
  return e;
}
function connectionClosed(): Error {
  const e = new Error(`Server has closed the connection. ${SECRET_HOST}`) as Error & { code?: string };
  e.name = "PrismaClientKnownRequestError";
  e.code = "P1017";
  return e;
}

/** A store whose named methods throw `err()` while `down.on` is true. */
function faulty(store: PaymentStore, methods: string[], err: () => Error) {
  const down = { on: true };
  const proxy = new Proxy(store, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (typeof prop === "string" && methods.includes(prop) && typeof v === "function") {
        return (...args: unknown[]) => {
          if (down.on) return Promise.reject(err());
          return (v as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
  return { store: proxy as PaymentStore, down };
}

async function seed(store: ReturnType<typeof createInMemoryPaymentStore>, providerRequestId = "req-1", amount = "100.00") {
  store.seedConnection({ businessId: 1, provider: "CARDCOM", isActive: true });
  const created = await store.createPaymentRequest({
    businessId: 1, customerId: null, billingDocumentId: null, provider: "CARDCOM",
    amount, currency: "ILS", description: null, status: "PENDING", expiresAt: null,
  });
  await store.updatePaymentRequest(created.id, { providerRequestId });
  return created;
}

const paidStub = () =>
  createStubProvider({ verifiedStatus: { outcome: "PAID", providerTransactionId: "t1", verifiedAmount: "100.00", verifiedCurrency: "ILS" } });

/** The stub, but its status API fails while `api.down` is true. */
function flakyProvider(api: { down: boolean }): PaymentProviderAdapter {
  const base = paidStub();
  return {
    ...base,
    async getPaymentStatus(input) {
      if (api.down) throw Object.assign(new Error(`connect ETIMEDOUT secure.cardcom.solutions ${SECRET_HOST}`), { code: "ETIMEDOUT" });
      return base.getPaymentStatus!(input);
    },
  };
}

const body = (o: Record<string, unknown>) => JSON.stringify({ eventId: "e1", providerRequestId: "req-1", providerTransactionId: "t1", outcome: "PAID", ...o });

const logged: string[] = [];
for (const k of ["info", "warn", "error", "log"] as const) {
  const orig = console[k].bind(console);
  console[k] = (...args: unknown[]) => {
    logged.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    if (process.env.VERBOSE) orig(...args);
  };
}
const noLeakInLogs = () => {
  const text = logged.join("\n");
  for (const s of [SECRET_HOST, SECRET_PW, "postgresql://", "app_runtime_prod", "reach database"]) {
    assert.ok(!text.includes(s), `a log line leaks ${s}`);
  }
};

async function main() {
  out("A  database unavailable at arrival");
  await ok("routing lookup fails (P1001) → 503 temporarily_unavailable, no event row, no money", async () => {
    const mem = createInMemoryPaymentStore();
    await seed(mem);
    const { store } = faulty(mem, ["findPaymentRequestByProviderRequestId"], dbDown);
    const res = await handleProviderWebhook({ provider: "CARDCOM", rawBody: body({}) }, { store, resolveProvider: paidStub });
    assert.equal(res.status, 503);
    assert.deepEqual(res.body, { ok: false, error: "temporarily_unavailable" });
    assert.equal(res.retryAfterSeconds, RETRY_LATER.status === 503 ? 60 : undefined);
    assert.equal(mem.webhookEvents.length, 0);
    assert.equal(mem.transactions.length, 0);
  });
  await ok("…the same 503 for a real and a made-up request (the answer never depends on the identifiers)", async () => {
    const mem = createInMemoryPaymentStore();
    await seed(mem);
    const { store } = faulty(mem, ["findPaymentRequestByProviderRequestId"], dbDown);
    const real = await handleProviderWebhook({ provider: "CARDCOM", rawBody: body({}) }, { store, resolveProvider: paidStub });
    const fake = await handleProviderWebhook({ provider: "CARDCOM", rawBody: body({ providerRequestId: "nope-404" }) }, { store, resolveProvider: paidStub });
    assert.deepEqual([real.status, real.body], [fake.status, fake.body]);
  });
  await ok("…a callback refused BEFORE any lookup (no request id / garbage) is still 200 while the DB is down", async () => {
    const mem = createInMemoryPaymentStore();
    const { store } = faulty(mem, ["findPaymentRequestByProviderRequestId", "insertWebhookEventIfNew"], dbDown);
    for (const raw of ["not-json", JSON.stringify({ eventId: "x", outcome: "PAID" }), JSON.stringify({ outcome: "WHATEVER" })]) {
      const res = await handleProviderWebhook({ provider: "CARDCOM", rawBody: raw }, { store, resolveProvider: paidStub });
      assert.equal(res.status, 200, raw);
      assert.deepEqual(res.body, { ok: true });
    }
  });

  out("B  database fails mid-processing");
  await ok("event stored, then the connection drops (P1017) → 503; event left unconsumed; redelivery → PAID once", async () => {
    const mem = createInMemoryPaymentStore();
    const req = await seed(mem);
    const { store, down } = faulty(mem, ["findActiveConnection"], connectionClosed);
    const deps: ProcessWebhookDeps = { store, resolveProvider: paidStub };
    const first = await handleProviderWebhook({ provider: "CARDCOM", rawBody: body({}) }, deps);
    assert.equal(first.status, 503);
    assert.equal(mem.webhookEvents.length, 1);
    assert.notEqual(mem.webhookEvents[0]?.processingStatus, "PROCESSED");
    assert.equal(mem.transactions.length, 0);
    down.on = false;
    const again = await handleProviderWebhook({ provider: "CARDCOM", rawBody: body({}) }, deps);
    assert.equal(again.status, 200);
    assert.equal(mem.webhookEvents.length, 1, "redelivery reuses the stored event");
    assert.equal(mem.webhookEvents[0]?.processingStatus, "PROCESSED");
    assert.equal(mem.requests.find((r) => r.id === req.id)?.status, "PAID");
    assert.equal(mem.transactions.filter((t) => Number(t.amount) > 0).length, 1);
  });
  await ok("the event-status write itself failing (after the money) → 503, and the redelivery adds no second payment", async () => {
    const mem = createInMemoryPaymentStore();
    await seed(mem);
    const { store, down } = faulty(mem, ["updateWebhookEvent"], connectionClosed);
    const deps: ProcessWebhookDeps = { store, resolveProvider: paidStub };
    assert.equal((await handleProviderWebhook({ provider: "CARDCOM", rawBody: body({}) }, deps)).status, 503);
    assert.equal(mem.transactions.filter((t) => Number(t.amount) > 0).length, 1, "the money was recorded once");
    down.on = false;
    assert.equal((await handleProviderWebhook({ provider: "CARDCOM", rawBody: body({}) }, deps)).status, 200);
    assert.equal(mem.transactions.filter((t) => Number(t.amount) > 0).length, 1, "still one after the redelivery");
    assert.equal(mem.webhookEvents[0]?.processingStatus, "PROCESSED");
  });

  out("C  provider verification API unavailable (swallowed inside the service)");
  await ok("getPaymentStatus times out → 503; event FAILED; nothing recorded; redelivery after recovery → PAID once", async () => {
    const mem = createInMemoryPaymentStore();
    const req = await seed(mem);
    const api = { down: true };
    const deps: ProcessWebhookDeps = { store: mem, resolveProvider: () => flakyProvider(api) };
    const first = await handleProviderWebhook({ provider: "CARDCOM", rawBody: body({}) }, deps);
    assert.equal(first.status, 503);
    assert.equal(mem.webhookEvents[0]?.processingStatus, "FAILED");
    assert.equal(mem.transactions.length, 0);
    api.down = false;
    const again = await handleProviderWebhook({ provider: "CARDCOM", rawBody: body({}) }, deps);
    assert.equal(again.status, 200);
    assert.equal(mem.requests.find((r) => r.id === req.id)?.status, "PAID");
    assert.equal(mem.transactions.filter((t) => Number(t.amount) > 0).length, 1);
  });
  await ok("no active connection (a configuration fact, not an outage) stays 200 — retrying cannot change it", async () => {
    const mem = createInMemoryPaymentStore();
    const created = await mem.createPaymentRequest({ businessId: 1, customerId: null, billingDocumentId: null, provider: "CARDCOM", amount: "100.00", currency: "ILS", description: null, status: "PENDING", expiresAt: null });
    await mem.updatePaymentRequest(created.id, { providerRequestId: "req-1" });
    const res = await handleProviderWebhook({ provider: "CARDCOM", rawBody: body({}) }, { store: mem, resolveProvider: paidStub });
    assert.equal(res.status, 200);
  });

  out("D  redelivery never pays or settles twice");
  await ok("sequential redeliveries (3×) → one transaction, one settlement, settle asked for that one transaction only", async () => {
    const mem = createInMemoryPaymentStore();
    await seed(mem);
    const settled: number[] = [];
    const deps: ProcessWebhookDeps = { store: mem, resolveProvider: paidStub, settleAccounting: async (e) => { settled.push(e.paymentTransactionId); } };
    for (let i = 0; i < 3; i++) assert.equal((await handleProviderWebhook({ provider: "CARDCOM", rawBody: body({}) }, deps)).status, 200);
    const money = mem.transactions.filter((t) => Number(t.amount) > 0);
    assert.equal(money.length, 1);
    assert.equal(mem.accountingSettlements.filter((a) => a.paymentTransactionId === money[0]!.id).length, 1);
    assert.ok(settled.length >= 1 && settled.every((id) => id === money[0]!.id));
  });
  await ok("concurrent redeliveries (4 at once, after a 503) → still one transaction and one settlement", async () => {
    const mem = createInMemoryPaymentStore();
    await seed(mem);
    const api = { down: true };
    const deps: ProcessWebhookDeps = { store: mem, resolveProvider: () => flakyProvider(api) };
    assert.equal((await handleProviderWebhook({ provider: "CARDCOM", rawBody: body({}) }, deps)).status, 503);
    api.down = false;
    const all = await Promise.all(Array.from({ length: 4 }, () => handleProviderWebhook({ provider: "CARDCOM", rawBody: body({}) }, deps)));
    assert.ok(all.every((r) => r.status === 200));
    const money = mem.transactions.filter((t) => Number(t.amount) > 0);
    assert.equal(money.length, 1);
    assert.equal(mem.accountingSettlements.filter((a) => a.paymentTransactionId === money[0]!.id).length, 1);
  });
  await ok("a different event id for the same payment (provider resends under a new id) → still one transaction", async () => {
    const mem = createInMemoryPaymentStore();
    await seed(mem);
    const deps: ProcessWebhookDeps = { store: mem, resolveProvider: paidStub };
    await handleProviderWebhook({ provider: "CARDCOM", rawBody: body({ eventId: "e1" }) }, deps);
    await handleProviderWebhook({ provider: "CARDCOM", rawBody: body({ eventId: "e2" }) }, deps);
    assert.equal(mem.transactions.filter((t) => Number(t.amount) > 0).length, 1);
  });

  out("E  unauthenticated / unknown callbacks are unchanged");
  await ok("unmatched id, wrong correlation, wrong amount, wrong currency, failed signature → 200 { ok: true }, no row", async () => {
    const mem = createInMemoryPaymentStore();
    const req = await seed(mem);
    const cases: Array<[string, ProcessWebhookDeps]> = [
      [body({ providerRequestId: "nope" }), { store: mem, resolveProvider: paidStub }],
      [body({ amount: "1.00" }), { store: mem, resolveProvider: paidStub }],
      [body({ currency: "USD" }), { store: mem, resolveProvider: paidStub }],
      [body({}), { store: mem, resolveProvider: () => createStubProvider({ requiredSecret: "s3cret" }) }],
    ];
    for (const [raw, deps] of cases) {
      const res = await handleProviderWebhook({ provider: "CARDCOM", rawBody: raw }, deps);
      assert.equal(res.status, 200, raw);
      assert.deepEqual(res.body, { ok: true });
    }
    assert.equal(mem.webhookEvents.length, 0);
    assert.equal(mem.requests.find((r) => r.id === req.id)?.status, "PENDING");
  });
  await ok("a verifier that throws is a refusal (200), never a retry", async () => {
    const mem = createInMemoryPaymentStore();
    await seed(mem);
    const res = await handleProviderWebhook({ provider: "CARDCOM", rawBody: body({}) }, { store: mem, resolveProvider: () => createStubProvider({ verifyThrows: dbDown() }) });
    assert.equal(res.status, 200);
  });
  await ok("a disabled provider is still 404 before anything (unchanged)", async () => {
    const res = await handleProviderWebhook({ provider: "TRANZILA", rawBody: body({}) }, { store: createInMemoryPaymentStore(), resolveProvider: paidStub });
    assert.equal(res.status, 404);
  });

  out("F  a defect is not an outage");
  await ok("TypeError / plain Error / unique violation inside processing → 200 (no retry storm on a bug)", async () => {
    for (const err of [() => new TypeError("x is undefined"), () => new Error("db down"), () => Object.assign(new Error("Unique constraint failed"), { name: "PrismaClientKnownRequestError", code: "P2002" })]) {
      const mem = createInMemoryPaymentStore();
      await seed(mem);
      const { store } = faulty(mem, ["insertWebhookEventIfNew"], err);
      const res = await handleProviderWebhook({ provider: "CARDCOM", rawBody: body({}) }, { store, resolveProvider: paidStub });
      assert.equal(res.status, 200);
    }
  });

  out("G  no infrastructure detail leaves");
  await ok("every answer body is one of three fixed shapes; no log line carries host, user, password or URL", () => {
    noLeakInLogs();
    assert.ok(logged.some((l) => l.includes("PrismaClientInitializationError") && l.includes("P1001")), "the log keeps class + code");
    assert.ok(logged.some((l) => l.includes('"transient":true')));
  });

  out("H  the routes");
  const ROUTES = [
    "app/api/payments/webhook/cardcom/route.ts",
    "app/api/payments/webhook/paypal/route.ts",
    "app/api/payments/webhook/tranzila/route.ts",
    "app/api/payments/webhook/[provider]/route.ts",
    "app/api/payments/webhook/sumit/[secret]/route.ts",
  ];
  await ok("every webhook route answers through webhookResponse and catches through webhookRouteFailure", () => {
    for (const r of ROUTES) {
      const src = fs.readFileSync(path.join(process.cwd(), r), "utf8");
      assert.match(src, /return webhookResponse\(result\);/, r);
      assert.match(src, /return webhookRouteFailure\("payments-webhook-route[^"]*", error\);/, r);
      assert.ok(!/error\.message/.test(src), `${r} logs error.message`);
    }
    const handler = fs.readFileSync(path.join(process.cwd(), "lib/services/payments/payment-webhook-handler.ts"), "utf8");
    assert.ok(!/error\.message/.test(handler.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")));
  });
  await ok("a route-level infrastructure failure → 503 + Retry-After + no-store; anything else → 200", async () => {
    const r503 = webhookRouteFailure("payments-webhook-route", dbDown());
    assert.equal(r503.status, 503);
    assert.equal(r503.headers.get("retry-after"), "60");
    assert.equal(r503.headers.get("cache-control"), "no-store");
    assert.deepEqual(await r503.json(), { ok: false, error: "temporarily_unavailable" });
    const r200 = webhookRouteFailure("payments-webhook-route", new TypeError("boom"));
    assert.equal(r200.status, 200);
    assert.deepEqual(await r200.json(), { ok: true });
    assert.equal(webhookResponse({ status: 200, body: { ok: true } }).headers.get("retry-after"), null);
    noLeakInLogs();
  });

  out("I  classification");
  await ok("transient: Prisma init / P1001 P1002 P1008 P1017 P2024 P2028 P2034, driver codes, known wording", () => {
    for (const code of ["P1001", "P1002", "P1008", "P1017", "P2024", "P2028", "P2034"]) {
      assert.ok(isTransientInfrastructureError(Object.assign(new Error("x"), { name: "PrismaClientKnownRequestError", code })), code);
    }
    for (const code of ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "57P01", "53300", "08006"]) {
      assert.ok(isTransientInfrastructureError(Object.assign(new Error("x"), { code })), code);
    }
    assert.ok(isTransientInfrastructureError(Object.assign(new Error("anything"), { name: "PrismaClientInitializationError" })));
    assert.ok(isTransientInfrastructureError(new Error("Your account or project has exceeded the quota")));
  });
  await ok("not transient: P2002, P2025, validation, TypeError, a plain message, a non-Error", () => {
    for (const e of [
      Object.assign(new Error("x"), { name: "PrismaClientKnownRequestError", code: "P2002" }),
      Object.assign(new Error("x"), { name: "PrismaClientKnownRequestError", code: "P2025" }),
      Object.assign(new Error("Invalid value"), { name: "PrismaClientValidationError" }),
      new TypeError("boom"),
      new Error("db down"),
      "string",
      null,
    ]) {
      assert.equal(isTransientInfrastructureError(e), false, String(e));
      assert.equal(answerForError(e).status, 200);
    }
  });

  out("J  reconciliation: priority without starvation");
  const AT = new Date("2026-11-01T12:00:00Z");
  const H = 60 * 60_000;
  let seq = 0;
  const mk = (o: Partial<PaymentRequestRecord> & { ageH: number }): PaymentRequestRecord =>
    ({
      id: ++seq, businessId: 1, provider: "CARDCOM", status: "PENDING", amount: "10.00", currency: "ILS",
      providerRequestId: `r${seq}`, paymentUrl: null, createdAt: new Date(AT.getTime() - o.ageH * H), ...o,
    }) as unknown as PaymentRequestRecord;
  let s = 42;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);

  await ok(`a batch of 10: signalled first, then fresh, and the fair share (>= ${Math.floor(10 * FAIR_SHARE_RATIO)}) always reserved`, () => {
    const old = Array.from({ length: 40 }, () => mk({ ageH: 24 * 20 }));
    const fresh = Array.from({ length: 20 }, () => mk({ ageH: 5 }));
    const sig = Array.from({ length: 30 }, () => mk({ ageH: 30 }));
    const sigIds = new Set(sig.map((r) => r.id));
    const batch = selectReconciliationBatch([...old, ...fresh, ...sig], { max: 10, isSignalled: (r) => sigIds.has(r.id), at: AT, random: rnd });
    const tiers = batch.map((b) => b.tier);
    assert.equal(batch.length, 10);
    assert.equal(tiers.filter((t) => t === "signalled").length, 5);
    assert.equal(tiers.filter((t) => t === "fresh").length, 2);
    assert.equal(tiers.filter((t) => t === "fairShare").length, 3);
    assert.equal(new Set(batch.map((b) => b.request.id)).size, 10, "no duplicates");
  });
  await ok("unused priority slots go to the fair share (no signal, no fresh → 10 fair-share picks)", () => {
    const old = Array.from({ length: 40 }, () => mk({ ageH: 24 * 20 }));
    const batch = selectReconciliationBatch(old, { max: 10, isSignalled: () => false, at: AT, random: rnd });
    assert.equal(batch.filter((b) => b.tier === "fairShare").length, 10);
  });
  await ok("starvation: 500 old + 100 fresh + 100 signalled, 1500 runs → every old request asked at least once", () => {
    const old = Array.from({ length: 500 }, () => mk({ ageH: 24 * 25 }));
    const fresh = Array.from({ length: 100 }, () => mk({ ageH: 2 }));
    const sig = Array.from({ length: 100 }, () => mk({ ageH: 10, status: "FAILED" }));
    const sigIds = new Set(sig.map((r) => r.id));
    const all = [...old, ...fresh, ...sig];
    const seen = new Map<number, number>();
    for (let run = 0; run < 1500; run++) {
      for (const b of selectReconciliationBatch(all, { max: 10, isSignalled: (r) => sigIds.has(r.id), at: AT, random: rnd })) {
        seen.set(b.request.id, (seen.get(b.request.id) ?? 0) + 1);
      }
    }
    const neverAsked = old.filter((r) => !seen.has(r.id)).length;
    assert.equal(neverAsked, 0, `${neverAsked} old requests never asked`);
  });
  await ok("stale non-PENDING requests are never 'fresh'; old PENDING are not 'fresh' either", () => {
    const cands = [mk({ ageH: 1, status: "EXPIRED" }), mk({ ageH: 1, status: "CANCELLED" }), mk({ ageH: 24 * 10 })];
    const batch = selectReconciliationBatch(cands, { max: 10, isSignalled: () => false, at: AT, random: rnd });
    assert.equal(batch.filter((b) => b.tier === "fresh").length, 0);
  });
  await ok("tenants: signalled tenants interleaved one-for-one with the others — never exclusive, none dropped", () => {
    const ids = Array.from({ length: 12 }, (_, i) => i + 1);
    const pri = new Set([2, 4, 6, 8, 10]);
    const order = orderBusinesses(ids, pri, rnd);
    assert.deepEqual([...order].sort((a, b) => a - b), ids);
    for (let i = 0; i < 10; i += 2) {
      assert.ok(pri.has(order[i]!), `slot ${i} is a priority tenant`);
      assert.ok(!pri.has(order[i + 1]!), `slot ${i + 1} is another tenant`);
    }
  });
  await ok("end-to-end: a FAILED webhook event raises its request and tenant; per-tenant isolation and caps hold", async () => {
    const mem = createInMemoryPaymentStore();
    for (const b of [1, 2, 3]) mem.seedConnection({ businessId: b, provider: "CARDCOM", isActive: true });
    const reqs: Record<number, PaymentRequestRecord[]> = { 1: [], 2: [], 3: [] };
    for (const b of [1, 2, 3]) {
      for (let i = 0; i < 15; i++) {
        const r = await mem.createPaymentRequest({ businessId: b, customerId: null, billingDocumentId: null, provider: "CARDCOM", amount: "10.00", currency: "ILS", description: null, status: "PENDING", expiresAt: null });
        await mem.updatePaymentRequest(r.id, { providerRequestId: `b${b}-r${i}` });
        reqs[b]!.push(r);
      }
    }
    // A callback for b3-r7 arrived and failed (provider API down) → FAILED event row.
    const api = { down: true };
    await handleProviderWebhook({ provider: "CARDCOM", rawBody: JSON.stringify({ eventId: "ev-b3", providerRequestId: "b3-r7", outcome: "PAID", providerTransactionId: "t-b3" }) }, { store: mem, resolveProvider: () => flakyProvider(api) });
    assert.equal(mem.webhookEvents[0]?.processingStatus, "FAILED");

    const askedFor: number[] = [];
    const watching: PaymentProviderAdapter = {
      ...createStubProvider({ verifiedStatus: { outcome: "PENDING" } as never }),
      async getPaymentStatus(input) {
        askedFor.push(Number(input.correlationValue));
        return { outcome: "PENDING" } as never;
      },
    };
    const report = await runPaymentReconciliation(
      { store: mem, resolveProvider: () => watching, listBusinessIds: async () => [1, 2, 3] },
      { minAgeMs: 0, maxChecks: 12, maxPerBusiness: 6, random: rnd }
    );
    assert.equal(report.prioritized.priorityBusinesses, 1);
    assert.ok(report.prioritized.signalled >= 1);
    const target = mem.requests.find((r) => r.businessId === 3 && r.providerRequestId === "b3-r7")!;
    assert.ok(askedFor.includes(target.id), "the signalled request was asked");
    assert.ok(report.checked <= 12, "global cap");
    const perTenant = (b: number) => askedFor.filter((id) => reqs[b]!.some((r) => r.id === id)).length;
    for (const b of [1, 2, 3]) assert.ok(perTenant(b) <= 6, `per-tenant cap for ${b}`);
    assert.ok(perTenant(1) + perTenant(2) > 0, "another tenant was still served in the same run");
    assert.equal(report.prioritized.signalled + report.prioritized.fresh + report.prioritized.fairShare, report.checked);
  });
  await ok("the signal is optional and non-fatal: a store without it samples as before; a failing read only counts as failed", async () => {
    const mem = createInMemoryPaymentStore();
    await seed(mem);
    const noSignal = new Proxy(mem, { get: (t, p, r) => (p === "listUnconsumedWebhookEvents" ? undefined : Reflect.get(t, p, r)) }) as PaymentStore;
    const r1 = await runPaymentReconciliation({ store: noSignal, resolveProvider: paidStub, listBusinessIds: async () => [1] }, { minAgeMs: 0, random: rnd });
    assert.equal(r1.checked, 1);
    const mem2 = createInMemoryPaymentStore();
    await seed(mem2, "req-2");
    const r2 = await runPaymentReconciliation({ store: faulty(mem2, ["listUnconsumedWebhookEvents"], dbDown).store, resolveProvider: paidStub, listBusinessIds: async () => [1] }, { minAgeMs: 0, random: rnd });
    assert.ok(r2.failed >= 1 && r2.checked === 1 && r2.healthy === false);
  });

  noLeakInLogs();
  out(`\npayment-webhook-reliability: ${passed} passed, 0 failed`);
}

main().catch((e) => {
  process.stderr.write(`${String(e instanceof Error ? e.stack : e)}\n`);
  process.exit(1);
});
