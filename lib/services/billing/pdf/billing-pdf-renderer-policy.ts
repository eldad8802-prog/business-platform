import {
  BILLING_PDF_RENDERER_POLICY_MESSAGE,
  BillingPdfRendererPolicyError,
} from "@/lib/errors";

export type BillingPdfRendererName = "html" | "pdfmake";

export type BillingPdfRendererPolicyStatus = {
  valid: boolean;
  effectiveRenderer: BillingPdfRendererName;
  configuredRenderer: string | null;
  productionLocked: boolean;
  violation: boolean;
  message: string | null;
};

function normalizedRendererEnv(): string | null {
  const raw = process.env.BILLING_PDF_RENDERER?.trim();
  if (!raw) {
    return null;
  }
  return raw.toLowerCase();
}

export function isNodeProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

export function isProductionPdfmakeRendererBlocked(): boolean {
  return isNodeProduction() && normalizedRendererEnv() === "pdfmake";
}

export function assertBillingPdfRendererPolicy(): void {
  if (isProductionPdfmakeRendererBlocked()) {
    throw new BillingPdfRendererPolicyError();
  }
}

export function shouldUseHtmlBillingPdfRenderer(): boolean {
  assertBillingPdfRendererPolicy();
  return normalizedRendererEnv() !== "pdfmake";
}

export function billingPdfRendererName(): BillingPdfRendererName {
  assertBillingPdfRendererPolicy();
  return shouldUseHtmlBillingPdfRenderer() ? "html" : "pdfmake";
}

export function evaluateBillingPdfRendererPolicy(): BillingPdfRendererPolicyStatus {
  const configuredRenderer = process.env.BILLING_PDF_RENDERER ?? null;
  const violation = isProductionPdfmakeRendererBlocked();
  const effectiveRenderer: BillingPdfRendererName = violation
    ? "html"
    : normalizedRendererEnv() === "pdfmake"
      ? "pdfmake"
      : "html";

  return {
    valid: !violation,
    effectiveRenderer,
    configuredRenderer,
    productionLocked: isNodeProduction(),
    violation,
    message: violation ? BILLING_PDF_RENDERER_POLICY_MESSAGE : null,
  };
}
