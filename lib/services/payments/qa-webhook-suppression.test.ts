/**
 * Run: npx tsx lib/services/payments/qa-webhook-suppression.test.ts
 *
 * The M1 Production-proof switch can only ever affect the ONE QA tenant, and
 * only while the flag holds its exact value. Everything else is untouched.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  COLLECTION_QA_BUSINESS_ID,
  QA_WEBHOOK_SINK_PATH,
  QA_WEBHOOK_SUPPRESSION_FLAG,
  QA_WEBHOOK_SUPPRESSION_VALUE,
  isQaWebhookSuppressed,
} from "./qa-webhook-suppression";
import { createPaymentRequest } from "./payment-request.service";
import { createInMemoryPaymentStore } from "./payment-store.memory";
import { createCardComProvider, type CardComHttpClient } from "./providers/cardcom/cardcom.provider";

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`OK: ${name}`);
  } else {
    failures.push(name);
    console.log(`FAIL: ${name}${detail ? " — " + detail : ""}`);
  }
}

const ON = { [QA_WEBHOOK_SUPPRESSION_FLAG]: QA_WEBHOOK_SUPPRESSION_VALUE };

async function createFor(businessId: number) {
  const bodies: Record<string, unknown>[] = [];
  const fetchImpl: CardComHttpClient = async (_url, init) => {
    bodies.push(JSON.parse(init.body) as Record<string, unknown>);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ResponseCode: 0,
        Url: "https://secure.cardcom.test/pay",
        LowProfileId: "11111111-2222-4333-8444-555555555555",
      }),
    };
  };
  const adapter = createCardComProvider({
    fetchImpl,
    baseUrl: "https://test.cardcom",
    publicBaseUrl: "https://app.example",
  });
  const store = createInMemoryPaymentStore();
  store.seedConnection({ businessId, provider: "CARDCOM", isActive: true, merchantId: "1000" });
  const res = await createPaymentRequest(
    { businessId, amount: "5.00", currency: "ILS" },
    {
      store,
      resolveProvider: () => adapter,
      decryptConnectionCredential: () => JSON.stringify({ apiName: "a", apiPassword: "p" }),
    }
  );
  return { res, store, webHookUrl: String(bodies[0]?.WebHookUrl ?? "") };
}

async function main() {
  // The gates.
  ok("off by default, even for the QA tenant", isQaWebhookSuppressed(COLLECTION_QA_BUSINESS_ID, {}) === false);
  ok("on only for the QA tenant", isQaWebhookSuppressed(COLLECTION_QA_BUSINESS_ID, ON) === true);
  for (const other of [1, 37, 39, 380, 3]) {
    ok(`never for business ${other}, even with the flag on`, isQaWebhookSuppressed(other, ON) === false);
  }
  for (const wrong of ["1", "true", "collection-qa", "collection-qa-39", ""]) {
    ok(`not for flag value ${JSON.stringify(wrong)}`, isQaWebhookSuppressed(COLLECTION_QA_BUSINESS_ID, { [QA_WEBHOOK_SUPPRESSION_FLAG]: wrong }) === false);
  }

  // The pinned id IS the reviewed QA tenant.
  const identity = readFileSync(join(process.cwd(), "ops/tenant/collection-qa-tenant.identity.env"), "utf8");
  const pinned = /^COLLECTION_QA_BUSINESS_ID="(\d+)"/m.exec(identity)?.[1];
  ok("the pinned id equals COLLECTION_QA_BUSINESS_ID in the reviewed identity file", pinned === String(COLLECTION_QA_BUSINESS_ID), String(pinned));

  // The sink: a route of its own, outside /api/payments/webhook/* (so the
  // dynamic [provider] webhook route can never catch it).
  const sinkFile = join(process.cwd(), "app", ...QA_WEBHOOK_SINK_PATH.split("/").filter(Boolean), "route.ts");
  ok("the sink route exists", existsSync(sinkFile));
  ok("the sink path is outside /api/payments/webhook/*", !QA_WEBHOOK_SINK_PATH.startsWith("/api/payments/webhook/"));

  // Static isolation: the sink can reach nothing that processes a payment. Its
  // ONLY imports are next/server and this module's constants.
  const sinkSource = readFileSync(sinkFile, "utf8");
  const imports = [...sinkSource.matchAll(/^\s*import[\s\S]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
  ok(
    "the sink imports only next/server and the QA constants",
    imports.length === 2 &&
      imports.includes("next/server") &&
      imports.includes("@/lib/services/payments/qa-webhook-suppression"),
    JSON.stringify(imports)
  );
  for (const forbidden of [
    /processPaymentWebhook|handleProviderWebhook|payment-webhook/,
    /getPaymentStatus|GetLpResult|resolvePaymentAuthoritatively|runPaymentReconciliation/,
    /prisma|createPaymentPrismaStore|payment-store|\$queryRaw|\$executeRaw/i,
    /req(uest)?\.(json|text|formData|arrayBuffer|body|headers|nextUrl|url)\b/,
    /require\(|import\(/,
  ]) {
    ok(`the sink source has no ${forbidden.source.slice(0, 40)}…`, !forbidden.test(sinkSource.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "")));
  }
  ok("the sink exposes POST only", /export async function POST\(\)/.test(sinkSource) && !/export (async )?function (GET|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/.test(sinkSource));
  ok("the sink handler takes no request argument (cannot read it)", !/export async function POST\([^)]+\)/.test(sinkSource));

  // Behaviour, through the real handler.
  const sinkRoute = await import("../../../app/api/payments/qa-webhook-sink/route");
  const callbackBody = JSON.stringify({ LowProfileId: "11111111-2222-4333-8444-555555555555", ReturnValue: "7", TranzactionId: 424242, CardOwnerEmail: "someone@example.test" });
  const flagBefore = process.env[QA_WEBHOOK_SUPPRESSION_FLAG];
  try {
    for (const value of [undefined, "", "1", "true", "collection-qa-39", "collection-qa-38x"]) {
      if (value === undefined) delete process.env[QA_WEBHOOK_SUPPRESSION_FLAG];
      else process.env[QA_WEBHOOK_SUPPRESSION_FLAG] = value;
      const res = await sinkRoute.POST();
      ok(`flag ${JSON.stringify(value)}: the sink answers 404`, res.status === 404, String(res.status));
    }
    process.env[QA_WEBHOOK_SUPPRESSION_FLAG] = QA_WEBHOOK_SUPPRESSION_VALUE;
    const res = await sinkRoute.POST();
    const text = await res.text();
    ok("flag on: the sink answers 200", res.status === 200, String(res.status));
    ok("flag on: the body is empty JSON", text === "{}", text);
    ok("flag on: nothing of the callback is echoed", !/LowProfile|424242|someone@|ReturnValue/.test(text) && callbackBody.length > 0);
  } finally {
    if (flagBefore === undefined) delete process.env[QA_WEBHOOK_SUPPRESSION_FLAG];
    else process.env[QA_WEBHOOK_SUPPRESSION_FLAG] = flagBefore;
  }

  // End to end through request creation and the real CardCom adapter.
  const prev = process.env[QA_WEBHOOK_SUPPRESSION_FLAG];
  try {
    delete process.env[QA_WEBHOOK_SUPPRESSION_FLAG];
    const normal = await createFor(COLLECTION_QA_BUSINESS_ID);
    ok("flag off: the QA tenant's checkout notifies the real webhook", normal.webHookUrl === "https://app.example/api/payments/webhook/cardcom", normal.webHookUrl);

    process.env[QA_WEBHOOK_SUPPRESSION_FLAG] = QA_WEBHOOK_SUPPRESSION_VALUE;
    const other = await createFor(7);
    ok("flag on: another business still notifies the real webhook", other.webHookUrl === "https://app.example/api/payments/webhook/cardcom", other.webHookUrl);
    ok("flag on: another business records no suppression", other.store.auditEvents.every((e) => e.eventType !== "PAYMENT_REQUEST_QA_WEBHOOK_SUPPRESSED"));

    const qa = await createFor(COLLECTION_QA_BUSINESS_ID);
    ok("flag on: the QA tenant's checkout notifies the sink", qa.webHookUrl === `https://app.example${QA_WEBHOOK_SINK_PATH}`, qa.webHookUrl);
    ok(
      "flag on: the suppression is audited on the request",
      qa.store.auditEvents.some((e) => e.eventType === "PAYMENT_REQUEST_QA_WEBHOOK_SUPPRESSED" && e.paymentRequestId === qa.res.paymentRequest.id)
    );
    ok("the request itself is a normal PENDING request", qa.res.paymentRequest.status === "PENDING");
  } finally {
    if (prev === undefined) delete process.env[QA_WEBHOOK_SUPPRESSION_FLAG];
    else process.env[QA_WEBHOOK_SUPPRESSION_FLAG] = prev;
  }

  console.log(
    failures.length === 0
      ? `qa-webhook-suppression: ${pass} passed, 0 failed`
      : `qa-webhook-suppression: ${failures.length} FAILED`
  );
  if (failures.length > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
