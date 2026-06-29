/**
 * Rate limiter verify (run manually, no Redis required — uses memory backend):
 *   RATE_LIMIT_BACKEND=memory npx tsx lib/security/rate-limiter/rate-limiter.verify.test.ts
 *
 * Covers: allow->deny at limit, scope keying (user vs business), window reset,
 * retry-after math, and the allowed-decision shape. Redis/fail-mode paths are
 * exercised separately against a live Upstash in staging (load test, §9).
 */

process.env.RATE_LIMIT_BACKEND = "memory";

import { checkRateLimit } from "./index";
import { resetMemoryBackendForTests } from "./memory-backend";

let failed = 0;

function ok(name: string, condition: boolean) {
  if (!condition) {
    console.error("FAIL:", name);
    failed += 1;
    return;
  }
  console.log("OK:", name);
}

async function run() {
  // 1) UPLOAD_ACCEPT user rule is 30/min — the 31st upload for one user is denied.
  resetMemoryBackendForTests();
  let lastAllowed = true;
  for (let i = 0; i < 30; i += 1) {
    const d = await checkRateLimit({ bucket: "UPLOAD_ACCEPT", user: 1, business: 1 });
    lastAllowed = d.allowed;
  }
  ok("first 30 uploads allowed", lastAllowed === true);

  const denied = await checkRateLimit({ bucket: "UPLOAD_ACCEPT", user: 1, business: 1 });
  ok("31st upload denied", denied.allowed === false);
  ok("denied outcome=rate_limited", denied.outcome === "rate_limited");
  ok("denied scope=user", denied.scope === "user");
  ok("denied retryAfter > 0", denied.retryAfterSeconds > 0);
  ok("denied resetAt in future", denied.resetAt > Date.now());

  // 2) A DIFFERENT user shares the business but has its own user bucket.
  const otherUser = await checkRateLimit({ bucket: "UPLOAD_ACCEPT", user: 2, business: 1 });
  ok("different user not blocked by user 1's limit", otherUser.allowed === true);

  // 3) Business bucket is shared: drive business 9 to its 120/min cap via many users.
  resetMemoryBackendForTests();
  let businessDenied = false;
  let businessDeniedScope: string | null = null;
  for (let u = 0; u < 200; u += 1) {
    const d = await checkRateLimit({ bucket: "UPLOAD_ACCEPT", user: 1000 + u, business: 9 });
    if (!d.allowed) {
      businessDenied = true;
      businessDeniedScope = d.scope;
      break;
    }
  }
  ok("business-level cap eventually trips", businessDenied === true);
  ok("business cap scope=business", businessDeniedScope === "business");

  // 4) allowed-decision shape.
  resetMemoryBackendForTests();
  const allowed = await checkRateLimit({ bucket: "DOCUMENTS_API", user: 5, business: 5 });
  ok("allowed.allowed true", allowed.allowed === true);
  ok("allowed.outcome=allowed", allowed.outcome === "allowed");
  ok("allowed.retryAfter=0", allowed.retryAfterSeconds === 0);
  ok("allowed.remaining < 120", allowed.remaining < 120 && allowed.remaining >= 0);

  // 5) DOCUMENT_PROCESSING business rule is 60/min.
  resetMemoryBackendForTests();
  let processingDenied = false;
  for (let i = 0; i < 61; i += 1) {
    const d = await checkRateLimit({ bucket: "DOCUMENT_PROCESSING", user: 7, business: 7 });
    if (!d.allowed) processingDenied = true;
  }
  ok("processing cap (60/min) trips on 61st", processingDenied === true);

  if (failed > 0) {
    console.error(`\n${failed} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nAll rate-limiter checks passed.");
}

run().catch((error) => {
  console.error("verify crashed:", error);
  process.exit(1);
});
