/**
 * Owner decision 26 (2026-11-24) — generous abuse ceilings on the four request paths that had no rate limit.
 * Infrastructure abuse protection, NOT subscription quota enforcement: same numbers for every account, testers too.
 *
 *   npx tsx lib/security/rate-limiter/abuse-four-paths.verify.test.ts
 *
 * Pins:
 *  A. The four buckets: exact rules and fail modes.
 *  B. Behaviour on the memory backend: per-user ceiling, a business cannot pass its ceiling with more users,
 *     other users / businesses unaffected.
 *  C. Limiter backend down: GMAIL_IMPORT + CONTENT_GENERATE refuse (503); LETTER_PREVIEW + REPORTS_EXPORT_ZIP allow.
 *  D. The denial is the shared response (429 + Retry-After + RateLimit-* headers, same body as every bucket call site).
 *  E. Each route calls checkRateLimit with ITS bucket after auth and before the expensive work, and returns the
 *     shared response on refusal.
 */

process.env.RATE_LIMIT_BACKEND = "memory";

import assert from "node:assert/strict";
import fs from "node:fs";

import { BUCKETS } from "./buckets";
import { checkRateLimit, configureRateLimiterForTests } from "./index";
import { buildRateLimitResponse } from "./http";
import { resetMemoryBackendForTests } from "./memory-backend";
import { RateLimiterBackendError } from "./errors";
import type { BucketName, RateLimitBackend } from "./types";

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed += 1;
  console.log(`OK  : ${name}`);
}
const read = (p: string) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const MIN = 60;
const HOUR = 60 * 60;
const DAY = 24 * 60 * 60;

async function drive(bucket: BucketName, n: number, ids: { user?: number; business?: number }) {
  let last = await checkRateLimit({ bucket, ...ids });
  for (let i = 1; i < n; i += 1) last = await checkRateLimit({ bucket, ...ids });
  return last;
}

async function run() {
  // ============================================================ A. definitions
  await check("A1 GMAIL_IMPORT: fail-closed; user 60/min + 600/h; business 120/min + 2000/day", () => {
    assert.equal(BUCKETS.GMAIL_IMPORT.failMode, "closed");
    assert.deepEqual(BUCKETS.GMAIL_IMPORT.rules, [
      { scope: "user", limit: 60, windowSeconds: MIN },
      { scope: "user", limit: 600, windowSeconds: HOUR },
      { scope: "business", limit: 120, windowSeconds: MIN },
      { scope: "business", limit: 2000, windowSeconds: DAY },
    ]);
  });
  await check("A2 CONTENT_GENERATE: fail-closed; user 10/min + 60/h; business 200/day; global 2000/h", () => {
    assert.equal(BUCKETS.CONTENT_GENERATE.failMode, "closed");
    assert.deepEqual(BUCKETS.CONTENT_GENERATE.rules, [
      { scope: "user", limit: 10, windowSeconds: MIN },
      { scope: "user", limit: 60, windowSeconds: HOUR },
      { scope: "business", limit: 200, windowSeconds: DAY },
      { scope: "global", limit: 2000, windowSeconds: HOUR },
    ]);
  });
  await check("A3 LETTER_PREVIEW: fail-OPEN; user 30/min + 300/h; business 1000/day", () => {
    assert.equal(BUCKETS.LETTER_PREVIEW.failMode, "open");
    assert.deepEqual(BUCKETS.LETTER_PREVIEW.rules, [
      { scope: "user", limit: 30, windowSeconds: MIN },
      { scope: "user", limit: 300, windowSeconds: HOUR },
      { scope: "business", limit: 1000, windowSeconds: DAY },
    ]);
  });
  await check("A4 REPORTS_EXPORT_ZIP: fail-OPEN; user 10/min + 60/h; business 200/day", () => {
    assert.equal(BUCKETS.REPORTS_EXPORT_ZIP.failMode, "open");
    assert.deepEqual(BUCKETS.REPORTS_EXPORT_ZIP.rules, [
      { scope: "user", limit: 10, windowSeconds: MIN },
      { scope: "user", limit: 60, windowSeconds: HOUR },
      { scope: "business", limit: 200, windowSeconds: DAY },
    ]);
  });

  // ============================================================ B. behaviour
  const perUserMinute: Array<[BucketName, number]> = [
    ["GMAIL_IMPORT", 60],
    ["CONTENT_GENERATE", 10],
    ["LETTER_PREVIEW", 30],
    ["REPORTS_EXPORT_ZIP", 10],
  ];
  for (const [bucket, limit] of perUserMinute) {
    await check(`B1 ${bucket}: ${limit} a minute pass for one user; the next is refused (scope user); others unaffected`, async () => {
      resetMemoryBackendForTests();
      assert.equal((await drive(bucket, limit, { user: 1, business: 9 })).allowed, true);
      const denied = await checkRateLimit({ bucket, user: 1, business: 9 });
      assert.equal(denied.allowed, false);
      assert.equal(denied.outcome, "rate_limited");
      assert.equal(denied.scope, "user");
      assert.ok(denied.retryAfterSeconds > 0 && denied.retryAfterSeconds <= 60);
      assert.equal((await checkRateLimit({ bucket, user: 2, business: 9 })).allowed, true, "another user of the business");
      assert.equal((await checkRateLimit({ bucket, user: 3, business: 38 })).allowed, true, "another business");
    });
  }

  await check("B2 GMAIL_IMPORT: a business cannot pass 120/min by using more users", async () => {
    resetMemoryBackendForTests();
    for (let u = 0; u < 120; u += 1) {
      assert.equal((await checkRateLimit({ bucket: "GMAIL_IMPORT", user: 100 + u, business: 9 })).allowed, true, `user ${u}`);
    }
    const next = await checkRateLimit({ bucket: "GMAIL_IMPORT", user: 999, business: 9 });
    assert.equal(next.allowed, false);
    assert.equal(next.scope, "business");
    assert.equal((await checkRateLimit({ bucket: "GMAIL_IMPORT", user: 1, business: 38 })).allowed, true);
  });

  await check("B3 CONTENT_GENERATE: business 200/day holds across users", async () => {
    resetMemoryBackendForTests();
    for (let u = 0; u < 200; u += 1) {
      assert.equal((await checkRateLimit({ bucket: "CONTENT_GENERATE", user: 100 + u, business: 9 })).allowed, true, `user ${u}`);
    }
    const next = await checkRateLimit({ bucket: "CONTENT_GENERATE", user: 999, business: 9 });
    assert.equal(next.allowed, false);
    assert.equal(next.scope, "business");
  });

  // ============================================================ C. fail modes
  const downBackend: RateLimitBackend = {
    name: "redis",
    async evaluate() { throw new RateLimiterBackendError("simulated outage"); },
    async reserveAttempt() { throw new RateLimiterBackendError("simulated outage"); },
    async clearAttempts() { throw new RateLimiterBackendError("simulated outage"); },
    async lockAttempts() { throw new RateLimiterBackendError("simulated outage"); },
  };
  await check("C1 backend down: Gmail import + AI generate refuse (503); letter PDF + export ZIP still allowed", async () => {
    const errors = console.error;
    console.error = () => {};
    try {
      configureRateLimiterForTests({ backend: downBackend });
      for (const bucket of ["GMAIL_IMPORT", "CONTENT_GENERATE"] as const) {
        const d = await checkRateLimit({ bucket, user: 7, business: 77 });
        assert.equal(d.allowed, false, bucket);
        assert.equal(d.outcome, "backend_unavailable", bucket);
        assert.equal(buildRateLimitResponse(d).status, 503, bucket);
      }
      for (const bucket of ["LETTER_PREVIEW", "REPORTS_EXPORT_ZIP"] as const) {
        const d = await checkRateLimit({ bucket, user: 7, business: 77 });
        assert.equal(d.allowed, true, bucket);
        assert.equal(d.degraded, true, bucket);
      }
    } finally {
      configureRateLimiterForTests({ backend: null });
      console.error = errors;
    }
  });

  // ============================================================ D. the shared 429
  await check("D1 a refusal is the shared 429: Retry-After + RateLimit-* headers; code/bucket/scope/retryAfterSeconds", async () => {
    resetMemoryBackendForTests();
    await drive("REPORTS_EXPORT_ZIP", 10, { user: 4, business: 4 });
    const d = await checkRateLimit({ bucket: "REPORTS_EXPORT_ZIP", user: 4, business: 4 });
    const res = buildRateLimitResponse(d);
    assert.equal(res.status, 429);
    assert.equal(res.headers.get("Retry-After"), String(d.retryAfterSeconds));
    assert.equal(res.headers.get("RateLimit-Limit"), "10");
    assert.equal(res.headers.get("RateLimit-Remaining"), "0");
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.code, "rate_limited");
    assert.equal(body.bucket, "REPORTS_EXPORT_ZIP");
    assert.equal(body.scope, "user");
    assert.equal(body.retryAfterSeconds, d.retryAfterSeconds);
    assert.equal(typeof body.error, "string");
  });

  // ============================================================ E. route wiring
  const routes: Array<{ file: string; bucket: BucketName; ids: string; before: string[]; after: string[] }> = [
    {
      file: "app/api/integrations/gmail/import/route.ts",
      bucket: "GMAIL_IMPORT",
      ids: "user: user.id, business: user.businessId",
      before: ["const user = await getCurrentUser(req);", "if (!user) {", "if (!preDedup.ok) {"],
      after: [
        "await getGmailAccessTokenForBusiness({",
        "await fetchGmailAttachmentDescriptor({",
        "await fetchGmailAttachmentBytes({",
        "await runGoogleVisionOCR(",
        "await putDocumentObject({",
        "await createDocumentFromOcrText({",
      ],
    },
    {
      file: "app/api/content/generate/route.ts",
      bucket: "CONTENT_GENERATE",
      ids: "user: user.id, business: user.businessId",
      before: ["const user = await getCurrentUser(req);", "if (!user) {"],
      after: ["await generateAIContent("],
    },
    {
      file: "app/api/business-documents/letters/pdf/route.ts",
      bucket: "LETTER_PREVIEW",
      ids: "user: userId, business: businessId",
      before: ["businessDocumentsRoute(req, async ({ businessId, userId }) => {"],
      after: ["await renderLetterPdf(businessId, input)"],
    },
    {
      file: "app/api/reports/export-zip/route.ts",
      bucket: "REPORTS_EXPORT_ZIP",
      ids: "user: user.id, business: user.businessId",
      before: ["const user = await getCurrentUser(req);", "if (!user) {"],
      after: ["buildAccountantPackZipBuffer(user.businessId, body)", "await recordSensor({"],
    },
  ];
  for (const r of routes) {
    await check(`E ${r.file}: auth → checkRateLimit(${r.bucket}) → shared refusal → expensive work`, () => {
      const src = read(r.file);
      const call = `const rateDecision = await checkRateLimit({ bucket: "${r.bucket}", ${r.ids} });`;
      const refuse = "if (!rateDecision.allowed) return buildRateLimitResponse(rateDecision);";
      assert.equal(src.split(call).length - 1, 1, "exactly one limiter call with the real user + business");
      assert.equal((src.match(/checkRateLimit\(/g) ?? []).length, 1, "no other limiter call");
      assert.ok(src.includes('import { checkRateLimit } from "@/lib/security/rate-limiter";'));
      assert.ok(src.includes('import { buildRateLimitResponse } from "@/lib/security/rate-limiter/http";'));
      const at = src.indexOf(call);
      assert.ok(src.indexOf(refuse) > at && /^\s*$/.test(src.slice(at + call.length, src.indexOf(refuse))), "the shared refusal is the very next statement");
      for (const b of r.before) {
        const i = src.indexOf(b);
        assert.ok(i >= 0 && i < at, `before the limiter: ${b}`);
      }
      for (const a of r.after) {
        const i = src.indexOf(a);
        assert.ok(i > at, `after the limiter: ${a}`);
      }
    });
  }

  console.log(`\nabuse four paths verify: ${passed} checks passed`);
}

run().catch((error) => {
  console.error("FAIL:", error);
  process.exit(1);
});
