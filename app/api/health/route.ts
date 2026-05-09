export async function GET() {
  const base: Record<string, unknown> = {
    status: "ok",
    time: new Date().toISOString(),
  };

  // Dev-only: confirms what this Node process actually sees (Cursor terminal vs UI ≠ server env).
  if (process.env.NODE_ENV === "development") {
    base.billingPdfRendererEnv = process.env.BILLING_PDF_RENDERER ?? null;
    base.billingPdfDebugLogEnv = process.env.BILLING_PDF_DEBUG_LOG ?? null;
    base.billingPdfSkipCacheEnv = process.env.BILLING_PDF_SKIP_CACHE ?? null;
  }

  return new Response(JSON.stringify(base), { status: 200 });
}