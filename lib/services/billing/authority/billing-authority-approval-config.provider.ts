/**
 * AuthorityApprovalConfigProvider — pure config resolution for the Approval
 * runtime.
 *
 * Produces ONLY what the Approval HTTP call needs: apiBaseUrl, apiVersion,
 * timeoutMs. Per the frozen Runtime Contract, `scope` is NOT part of this
 * config (it is an OAuth-layer concern, never consumed by the HTTP send path).
 *
 * Pure: no Prisma, no DB, no tokens, no connections, no secrets. Fail-closed
 * with a sanitized Result (never leaks env values).
 */

import { BillingAuthorityEnvironment } from "@prisma/client";
import {
  buildAuthorityApiBaseUrl,
  resolveAuthorityEnvConfig,
} from "@/lib/services/billing/authority/billing-authority-env.service";

/** Approval HTTP config (frozen Runtime Context shape — no scope). */
export type ApprovalRuntimeConfig = {
  apiBaseUrl: string;
  apiVersion: string;
  timeoutMs: number;
};

export type ApprovalConfigErrorCode =
  | "ENVIRONMENT_NOT_CONFIGURED"
  | "API_CONFIG_MISSING";

export type ApprovalConfigResult =
  | { ok: true; config: ApprovalRuntimeConfig }
  | { ok: false; code: ApprovalConfigErrorCode; message: string };

/**
 * ITA "Invoices in Israel" allocation API version (contract path
 * /Invoices/v2/Approval). Documented internal constant — no new env var.
 */
export const APPROVAL_API_VERSION = "v2" as const;

/** Default Approval request timeout. Single documented constant — no new env var. */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 15_000;

export function resolveApprovalConfig(input: {
  environment: BillingAuthorityEnvironment;
}): ApprovalConfigResult {
  let apiBaseUrl: string;
  try {
    apiBaseUrl = buildAuthorityApiBaseUrl(
      resolveAuthorityEnvConfig(input.environment)
    );
  } catch {
    // env.service throws when the environment's OAuth/API base or redirect
    // vars are unset. Never propagate its message (it may name env vars).
    return {
      ok: false,
      code: "ENVIRONMENT_NOT_CONFIGURED",
      message: "Authority environment is not configured",
    };
  }

  if (!/^https?:\/\/.+/.test(apiBaseUrl)) {
    return {
      ok: false,
      code: "API_CONFIG_MISSING",
      message: "Authority API base URL is missing or invalid",
    };
  }

  return {
    ok: true,
    config: {
      apiBaseUrl,
      apiVersion: APPROVAL_API_VERSION,
      timeoutMs: DEFAULT_APPROVAL_TIMEOUT_MS,
    },
  };
}
