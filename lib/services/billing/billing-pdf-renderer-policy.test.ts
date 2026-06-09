/**
 * H2c billing PDF renderer policy (run manually):
 *   npx tsx lib/services/billing/billing-pdf-renderer-policy.test.ts
 */
import assert from "node:assert/strict";
import { BillingPdfRendererPolicyError } from "@/lib/errors";
import {
  assertBillingPdfRendererPolicy,
  evaluateBillingPdfRendererPolicy,
  shouldUseHtmlBillingPdfRenderer,
} from "@/lib/services/billing/pdf/billing-pdf-renderer-policy";

let failed = 0;

function ok(name: string, condition: boolean) {
  if (!condition) {
    console.error("FAIL:", name);
    failed += 1;
    return;
  }
  console.log("OK:", name);
}

function withEnv(
  vars: Record<string, string | undefined>,
  fn: () => void
): void {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) {
    previous[key] = process.env[key];
    const value = vars[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

withEnv(
  { NODE_ENV: "development", BILLING_PDF_RENDERER: "pdfmake" },
  () => {
    assert.doesNotThrow(() => assertBillingPdfRendererPolicy());
    ok(
      "A: development + pdfmake allowed",
      shouldUseHtmlBillingPdfRenderer() === false
    );
    ok(
      "A: development + pdfmake policy valid",
      evaluateBillingPdfRendererPolicy().valid === true
    );
  }
);

withEnv(
  { NODE_ENV: "development", BILLING_PDF_RENDERER: "html" },
  () => {
    assert.doesNotThrow(() => assertBillingPdfRendererPolicy());
    ok(
      "B: development + html allowed",
      shouldUseHtmlBillingPdfRenderer() === true
    );
    ok(
      "B: development + html policy valid",
      evaluateBillingPdfRendererPolicy().valid === true
    );
  }
);

withEnv(
  { NODE_ENV: "production", BILLING_PDF_RENDERER: "html" },
  () => {
    assert.doesNotThrow(() => assertBillingPdfRendererPolicy());
    ok(
      "C: production + html allowed",
      shouldUseHtmlBillingPdfRenderer() === true
    );
    ok(
      "C: production + html policy valid",
      evaluateBillingPdfRendererPolicy().valid === true
    );
  }
);

withEnv(
  { NODE_ENV: "production", BILLING_PDF_RENDERER: "pdfmake" },
  () => {
    assert.throws(
      () => assertBillingPdfRendererPolicy(),
      (error: unknown) => error instanceof BillingPdfRendererPolicyError
    );
    const policy = evaluateBillingPdfRendererPolicy();
    ok("D: production + pdfmake blocked", policy.valid === false);
    ok("D: production + pdfmake violation flagged", policy.violation === true);
    ok(
      "D: production + pdfmake exposes operator message",
      typeof policy.message === "string" && policy.message.length > 0
    );
  }
);

if (failed > 0) {
  console.error(`billing-pdf-renderer-policy.test: ${failed} failed`);
  process.exitCode = 1;
} else {
  console.log("billing-pdf-renderer-policy.test: all assertions passed");
}
