/**
 * Verify — GET /api/home/collection failure diagnostics (observability only).
 * Run: npx tsx lib/services/home/home-collection-diagnostics.verify.test.ts
 *
 * What it defends:
 *   - a real failure leaves ONE safe line that names the Prisma code when there
 *     is one, and invents none when there is not;
 *   - nothing identifying (tenant, user, email, amount, ids, credentials,
 *     connection strings, the error's message or metadata) ever reaches it;
 *   - the answer is exactly what handleError gives without diagnostics, even if
 *     emitting the line throws;
 *   - success and expected client errors emit nothing.
 */
import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";

import { ForbiddenError, UnauthorizedError } from "@/lib/errors";
import { handleError } from "@/lib/handle-error";
import {
  buildHomeCollectionFailureEvent,
  HOME_COLLECTION_FAILED_EVENT,
  withHomeCollectionDiagnostics,
} from "@/lib/services/home/home-collection-diagnostics";
import { TenantContextError } from "@/lib/tenant/context";

let checks = 0;
function eq<T>(label: string, actual: T, expected: T) {
  assert.deepEqual(actual, expected, label);
  checks += 1;
}
function ok(label: string, condition: boolean) {
  assert.ok(condition, label);
  checks += 1;
}

// Values that must never surface in a diagnostic line.
const SECRETS = [
  "postgresql://owner:hunter2@db.example.neon.tech/neondb",
  "hunter2",
  "Bearer eyJhbGciOiJIUzI1NiJ9.secret-token",
  "session=abc123cookie",
  "owner@example.com",
  "businessId=4242",
  "userId=777",
  "4242",
  "1250.00",
  "pt_9f8e7d",
  "pr_1a2b3c",
  'SELECT "amount" FROM "PaymentTransaction"',
];

function prismaKnown(code: string) {
  return new Prisma.PrismaClientKnownRequestError(
    `Transaction failed for businessId=4242 userId=777 owner@example.com amount 1250.00 via postgresql://owner:hunter2@db.example.neon.tech/neondb SELECT "amount" FROM "PaymentTransaction"`,
    {
      code,
      clientVersion: "test",
      meta: { businessId: 4242, paymentTransactionId: "pt_9f8e7d", paymentRequestId: "pr_1a2b3c", amount: "1250.00" },
    }
  );
}

function request(period: string | null, extraHeaders: Record<string, string> = {}) {
  const url = `https://promaxgroup.co.il/api/home/collection${period === null ? "" : `?period=${period}`}`;
  const headers = new Headers({
    authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.secret-token",
    cookie: "session=abc123cookie",
    "x-vercel-id": "fra1::iad1::abcde-1700000000000-0123456789ab",
    ...extraHeaders,
  });
  return { url, headers };
}

function assertClean(label: string, line: string) {
  for (const secret of SECRETS) ok(`${label}: does not contain ${JSON.stringify(secret)}`, !line.includes(secret));
  const parsed = JSON.parse(line) as Record<string, unknown>;
  eq(`${label}: only allowlisted keys`, Object.keys(parsed).sort(), [
    "category", "durationMs", "errorClass", "errorCode", "event", "httpStatus", "period", "region", "requestId", "route",
  ]);
}

async function bodyOf(res: Response) {
  return { status: res.status, body: await res.json() };
}

// Silence handleError's own pre-existing console.error during the run.
const realConsoleError = console.error;
console.error = () => {};

async function main() {
  // A. P2028
  {
    const lines: string[] = [];
    await withHomeCollectionDiagnostics(request("week"), async () => { throw prismaKnown("P2028"); }, (l) => lines.push(l));
    eq("A: one line", lines.length, 1);
    const e = JSON.parse(lines[0]);
    eq("A: event", e.event, HOME_COLLECTION_FAILED_EVENT);
    eq("A: class", e.errorClass, "PrismaClientKnownRequestError");
    eq("A: code", e.errorCode, "P2028");
    eq("A: category", e.category, "prisma_known_request");
    eq("A: period", e.period, "week");
    eq("A: status", e.httpStatus, 500);
    ok("A: duration is a non-negative integer", Number.isInteger(e.durationMs) && e.durationMs >= 0);
    eq("A: request id kept for log correlation", e.requestId, "fra1::iad1::abcde-1700000000000-0123456789ab");
    assertClean("A", lines[0]);
  }

  // B. P2024
  {
    const lines: string[] = [];
    await withHomeCollectionDiagnostics(request("today"), async () => { throw prismaKnown("P2024"); }, (l) => lines.push(l));
    const e = JSON.parse(lines[0]);
    eq("B: code", e.errorCode, "P2024");
    eq("B: class", e.errorClass, "PrismaClientKnownRequestError");
    assertClean("B", lines[0]);
  }

  // B2. Some other Prisma code is reported as itself, not coerced into the hypothesis.
  {
    const e = buildHomeCollectionFailureEvent(prismaKnown("P1001"), { url: request(null).url, requestId: null, region: "iad1", durationMs: 12.6 });
    eq("B2: other code kept", e.errorCode, "P1001");
    eq("B2: missing period normalises to today", e.period, "today");
    eq("B2: duration rounded", e.durationMs, 13);
    eq("B2: region", e.region, "iad1");
  }

  // C. Non-Prisma errors: an event, and no invented code.
  {
    const lines: string[] = [];
    await withHomeCollectionDiagnostics(request("yesterday"), async () => {
      throw new Error("boom for owner@example.com businessId=4242 amount 1250.00");
    }, (l) => lines.push(l));
    const e = JSON.parse(lines[0]);
    eq("C: class", e.errorClass, "Error");
    eq("C: no Prisma code", e.errorCode, null);
    eq("C: category", e.category, "other");
    eq("C: period", e.period, "yesterday");
    assertClean("C", lines[0]);

    const t = buildHomeCollectionFailureEvent(new TenantContextError("no tenant context in scope"), { url: request("today").url, requestId: null, region: null, durationMs: 1 });
    eq("C: tenant context classified", [t.category, t.errorClass, t.errorCode, t.httpStatus], ["tenant_context", "TenantContextError", null, 500]);

    const s = buildHomeCollectionFailureEvent("a thrown string with owner@example.com", { url: request("today").url, requestId: null, region: null, durationMs: 1 });
    eq("C: non-Error throw", [s.errorClass, s.errorCode], ["string", null]);
    ok("C: thrown value not echoed", !JSON.stringify(s).includes("owner@example.com"));
  }

  // D. Sensitive request-derived fields are rejected, not passed through.
  {
    const hostile = buildHomeCollectionFailureEvent(prismaKnown("P2028"), {
      url: "https://x/api/home/collection?period=owner@example.com",
      requestId: "Bearer eyJhbGciOiJIUzI1NiJ9.secret-token",
      region: "postgresql://owner:hunter2@db",
      durationMs: 5,
    });
    eq("D: hostile period normalised", hostile.period, "today");
    eq("D: token-shaped request id dropped", hostile.requestId, null);
    eq("D: url-shaped region dropped", hostile.region, null);
    assertClean("D", JSON.stringify(hostile));

    const forgedCode = prismaKnown("P2028");
    (forgedCode as unknown as { code: string }).code = "P2028; owner@example.com";
    eq("D: malformed code dropped", buildHomeCollectionFailureEvent(forgedCode, { url: request("today").url, requestId: null, region: null, durationMs: 1 }).errorCode, null);
  }

  // E. The original error continues through the existing handleError, unchanged.
  {
    for (const make of [() => prismaKnown("P2028"), () => new Error("boom"), () => new UnauthorizedError(), () => new ForbiddenError("No business context for payment action")]) {
      const direct = await bodyOf(handleError(make()));
      const wrapped = await bodyOf(await withHomeCollectionDiagnostics(request("today"), async () => { throw make(); }, () => {}));
      eq(`E: same answer as handleError (${direct.status})`, wrapped, direct);
    }
    // Even when emitting the line itself throws.
    const direct = await bodyOf(handleError(prismaKnown("P2024")));
    const wrapped = await bodyOf(await withHomeCollectionDiagnostics(request("today"), async () => { throw prismaKnown("P2024"); }, () => { throw new Error("logger down"); }));
    eq("E: a failing logger never changes the answer", wrapped, direct);

    // Expected client errors are not collection failures: no line.
    const lines: string[] = [];
    const unauth = await withHomeCollectionDiagnostics(request("today"), async () => { throw new UnauthorizedError(); }, (l) => lines.push(l));
    eq("E: 401 still 401", unauth.status, 401);
    eq("E: 401 emits nothing", lines.length, 0);
  }

  // F. Success emits nothing and returns the work's own response.
  {
    const lines: string[] = [];
    const response = NextResponse.json({ total: 620 }, { status: 200 });
    const result = await withHomeCollectionDiagnostics(request("today"), async () => response, (l) => lines.push(l));
    ok("F: same response object", result === response);
    eq("F: no line on success", lines.length, 0);
  }

  console.error = realConsoleError;
  console.log(`home-collection-diagnostics.verify.test.ts: ok (${checks} checks)`);
}

main().catch((error) => {
  console.error = realConsoleError;
  console.error(error);
  process.exit(1);
});
