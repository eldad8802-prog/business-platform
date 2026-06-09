import { evaluateBillingPdfRendererPolicy } from "@/lib/services/billing/pdf/billing-pdf-renderer-policy";

export async function GET() {
  const rendererPolicy = evaluateBillingPdfRendererPolicy();
  const base: Record<string, unknown> = {
    status: rendererPolicy.valid ? "ok" : "degraded",
    time: new Date().toISOString(),
    billingPdfRendererPolicy: rendererPolicy,
  };

  // Dev-only: confirms what this Node process actually sees (Cursor terminal vs UI ≠ server env).
  if (process.env.NODE_ENV === "development") {
    base.billingPdfDebugLogEnv = process.env.BILLING_PDF_DEBUG_LOG ?? null;
    base.billingPdfSkipCacheEnv = process.env.BILLING_PDF_SKIP_CACHE ?? null;
  }

  return new Response(JSON.stringify(base), {
    status: rendererPolicy.valid ? 200 : 503,
  });
}