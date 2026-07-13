/**
 * AuthorityApprovalRuntimeContextProvider — composition layer.
 *
 * Composes the config provider, the BillingAuthorityApp resolution, and the
 * access-token provider into a single ready Runtime Context. The (future)
 * Execution Service consumes this and stays ignorant of env, Prisma, tokens,
 * decrypt, and refresh.
 *
 * Order: Config → App → Token (fail fast; do not decrypt/refresh if config or
 * app failed). Never throws in the normal flow; a missing encryption key is
 * surfaced as a Result (pre-flight failure) via the token provider.
 *
 * `scope` is intentionally absent from the Runtime Context.
 * Refresh-once-after-401 is NOT implemented here — it is the Execution
 * Service's responsibility (via forceRefresh).
 */

import { BillingAuthorityEnvironment } from "@prisma/client";
import { ServiceUnavailableError } from "@/lib/errors";
import { getActiveAuthorityApp } from "@/lib/services/billing/authority/billing-authority-app.service";
import {
  resolveApprovalConfig,
  type ApprovalConfigErrorCode,
  type ApprovalRuntimeConfig,
} from "@/lib/services/billing/authority/billing-authority-approval-config.provider";
import {
  defaultAccessTokenProviderDeps,
  resolveAccessToken,
  type AccessTokenErrorCode,
  type AccessTokenProviderDeps,
  type AccessTokenResult,
} from "@/lib/services/billing/authority/billing-authority-approval-token.provider";

export type AppErrorCode =
  | "APP_NOT_REGISTERED"
  | "ACCOUNTING_SOFTWARE_NUMBER_MISSING";

export type RuntimeContextErrorCode =
  | ApprovalConfigErrorCode
  | AppErrorCode
  | AccessTokenErrorCode;

/** Exactly the frozen Runtime Context — no scope, no secrets beyond the token. */
export type ApprovalRuntimeContext = {
  accessToken: string;
  approvalConfig: ApprovalRuntimeConfig;
  accountingSoftwareNumber: string;
  connectionId: number;
  environment: BillingAuthorityEnvironment;
};

export type RuntimeContextResult =
  | { ok: true; context: ApprovalRuntimeContext }
  | { ok: false; code: RuntimeContextErrorCode; message: string };

type AccountingSoftwareNumberResult =
  | { ok: true; value: string }
  | { ok: false; code: AppErrorCode; message: string };

export type RuntimeContextProviderDeps = {
  resolveConfig: typeof resolveApprovalConfig;
  resolveAccountingSoftwareNumber: (
    environment: BillingAuthorityEnvironment
  ) => Promise<AccountingSoftwareNumberResult>;
  resolveToken: (
    input: {
      businessId: number;
      environment: BillingAuthorityEnvironment;
      forceRefresh?: boolean;
    },
    deps?: AccessTokenProviderDeps
  ) => Promise<AccessTokenResult>;
  tokenDeps: AccessTokenProviderDeps;
};

async function defaultResolveAccountingSoftwareNumber(
  environment: BillingAuthorityEnvironment
): Promise<AccountingSoftwareNumberResult> {
  try {
    const app = await getActiveAuthorityApp(environment);
    const value = (app.accountingSoftwareNumber ?? "").trim();
    if (value.length === 0) {
      return {
        ok: false,
        code: "ACCOUNTING_SOFTWARE_NUMBER_MISSING",
        message: "Authority software registration number is missing",
      };
    }
    return { ok: true, value };
  } catch (error) {
    if (error instanceof ServiceUnavailableError) {
      return {
        ok: false,
        code: "APP_NOT_REGISTERED",
        message: "Authority platform app is not registered",
      };
    }
    throw error;
  }
}

export const defaultRuntimeContextProviderDeps: RuntimeContextProviderDeps = {
  resolveConfig: resolveApprovalConfig,
  resolveAccountingSoftwareNumber: defaultResolveAccountingSoftwareNumber,
  resolveToken: resolveAccessToken,
  tokenDeps: defaultAccessTokenProviderDeps,
};

export async function resolveApprovalRuntimeContext(
  input: {
    businessId: number;
    environment: BillingAuthorityEnvironment;
    forceRefresh?: boolean;
  },
  deps: RuntimeContextProviderDeps = defaultRuntimeContextProviderDeps
): Promise<RuntimeContextResult> {
  // 1. Config (pure).
  const config = deps.resolveConfig({ environment: input.environment });
  if (!config.ok) {
    return { ok: false, code: config.code, message: config.message };
  }

  // 2. App (accountingSoftwareNumber). No token work if this fails.
  const app = await deps.resolveAccountingSoftwareNumber(input.environment);
  if (!app.ok) {
    return { ok: false, code: app.code, message: app.message };
  }

  // 3. Token (decrypt / refresh-before-use). Last, so nothing sensitive runs
  //    when config/app already failed.
  const token = await deps.resolveToken(
    {
      businessId: input.businessId,
      environment: input.environment,
      forceRefresh: input.forceRefresh,
    },
    deps.tokenDeps
  );
  if (!token.ok) {
    return { ok: false, code: token.code, message: token.message };
  }

  return {
    ok: true,
    context: {
      accessToken: token.accessToken,
      approvalConfig: config.config,
      accountingSoftwareNumber: app.value,
      connectionId: token.connectionId,
      environment: input.environment,
    },
  };
}
