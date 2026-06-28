/**
 * Authority connection validation runtime (D.2.6).
 *
 * Decrypts access tokens, executes the ITA validation probe, and transitions
 * connections to VALIDATED on success or ERROR on auth failure. Network failures
 * do not mutate connection state.
 */

import {
  BillingAuthorityConnectionStatus,
  BillingAuthorityEnvironment,
  Prisma,
} from "@prisma/client";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import {
  markAuthorityAuthFailure,
  markAuthorityValidated,
  sanitizeAuthorityConnectionErrorMessage,
} from "@/lib/services/billing/authority/billing-authority-connection.service";
import type { AuthorityEnvConfig } from "@/lib/services/billing/authority/billing-authority-connection.types";
import {
  buildAuthorityApiBaseUrl,
  resolveAuthorityEnvConfig,
} from "@/lib/services/billing/authority/billing-authority-env.service";
import { decryptAuthorityConnectionToken } from "@/lib/services/billing/authority/billing-authority-token-crypto.service";

export const AUTHORITY_VALIDATION_ERROR_CODES = {
  NOT_VALIDATABLE: "AUTHORITY_CONNECTION_NOT_VALIDATABLE",
  TOKEN_DECRYPT_FAILED: "TOKEN_DECRYPT_FAILED",
  AUTH_REJECTED: "ITA_AUTH_REJECTED",
  UPSTREAM_ERROR: "ITA_UPSTREAM_ERROR",
  PROBE_TIMEOUT: "ITA_PROBE_TIMEOUT",
  CONFIGURATION_ERROR: "AUTHORITY_VALIDATION_CONFIG_ERROR",
} as const;

export const AUTHORITY_VALIDATION_PROBE_CONFIRMATION_NUMBER = "000000000" as const;
export const AUTHORITY_VALIDATION_PROBE_VAT_SENTINEL = "000000000" as const;

export const AUTHORITY_VALIDATION_PROBE_PATH =
  "/invoice-information/v1/details" as const;

export const DEFAULT_AUTHORITY_VALIDATION_PROBE_TIMEOUT_MS = 15_000;

export type AuthorityValidationOutcome =
  | "VALID"
  | "AUTH_FAILURE"
  | "NETWORK_FAILURE"
  | "CONFIGURATION_FAILURE";

export type AuthorityValidationProbePayload = {
  customer_vat_number: string;
  confirmation_number: string;
};

export type ValidateAuthorityConnectionInput = {
  businessId: number;
  environment: BillingAuthorityEnvironment;
  actorUserId?: number | null;
  fetchImpl?: typeof fetch;
  probeTimeoutMs?: number;
};

export type ValidateAuthorityConnectionResult = {
  ok: boolean;
  validated: boolean;
  validationTimestamp: Date;
  outcome: AuthorityValidationOutcome;
  errorCode?: string;
  errorMessage?: string;
};

const CONNECTION_SELECT = {
  id: true,
  businessId: true,
  environment: true,
  status: true,
  accessTokenEncrypted: true,
  accessTokenIv: true,
  accessTokenTag: true,
  refreshTokenEncrypted: true,
  refreshTokenIv: true,
  refreshTokenTag: true,
  encryptionKeyId: true,
  lastValidatedAt: true,
} as const satisfies Prisma.BillingAuthorityConnectionSelect;

type ValidatableConnectionRow = Prisma.BillingAuthorityConnectionGetPayload<{
  select: typeof CONNECTION_SELECT;
}>;

function assertPositiveInteger(value: number, fieldName: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new ValidationError(`${fieldName} must be a positive integer`);
  }
}

export function buildAuthorityValidationProbeUrl(config: AuthorityEnvConfig): string {
  return `${buildAuthorityApiBaseUrl(config)}${AUTHORITY_VALIDATION_PROBE_PATH}`;
}

export function buildAuthorityValidationProbePayload(input?: {
  customerVatNumber?: string | null;
}): AuthorityValidationProbePayload {
  const vat = input?.customerVatNumber?.trim();
  return {
    customer_vat_number:
      vat && vat.length > 0 ? vat : AUTHORITY_VALIDATION_PROBE_VAT_SENTINEL,
    confirmation_number: AUTHORITY_VALIDATION_PROBE_CONFIRMATION_NUMBER,
  };
}

export function classifyAuthorityValidationHttpStatus(
  status: number
): AuthorityValidationOutcome {
  if (status === 401 || status === 403) {
    return "AUTH_FAILURE";
  }
  if (status >= 500) {
    return "NETWORK_FAILURE";
  }
  if (status === 200 || status === 400 || status === 422) {
    return "VALID";
  }
  if (status >= 400 && status < 500) {
    return "VALID";
  }
  return "NETWORK_FAILURE";
}

function hasEncryptedAccessToken(row: ValidatableConnectionRow): boolean {
  return (
    typeof row.accessTokenEncrypted === "string" &&
    row.accessTokenEncrypted.length > 0 &&
    typeof row.accessTokenIv === "string" &&
    row.accessTokenIv.length > 0 &&
    typeof row.accessTokenTag === "string" &&
    row.accessTokenTag.length > 0
  );
}

function isValidatableConnectionStatus(
  status: BillingAuthorityConnectionStatus
): boolean {
  return (
    status === BillingAuthorityConnectionStatus.CONNECTED ||
    status === BillingAuthorityConnectionStatus.VALIDATED
  );
}

export function assessAuthorityConnectionValidatability(
  row: ValidatableConnectionRow | null
):
  | { ok: true; connection: ValidatableConnectionRow }
  | {
      ok: false;
      errorCode: string;
      errorMessage: string;
    } {
  if (!row) {
    return {
      ok: false,
      errorCode: AUTHORITY_VALIDATION_ERROR_CODES.NOT_VALIDATABLE,
      errorMessage: "Authority connection not found",
    };
  }

  if (!isValidatableConnectionStatus(row.status)) {
    return {
      ok: false,
      errorCode: AUTHORITY_VALIDATION_ERROR_CODES.NOT_VALIDATABLE,
      errorMessage: `Authority connection status ${row.status} is not validatable`,
    };
  }

  if (!hasEncryptedAccessToken(row)) {
    return {
      ok: false,
      errorCode: AUTHORITY_VALIDATION_ERROR_CODES.NOT_VALIDATABLE,
      errorMessage: "Authority connection is missing encrypted access token",
    };
  }

  return { ok: true, connection: row };
}

async function loadValidatableAuthorityConnection(
  businessId: number,
  environment: BillingAuthorityEnvironment
): Promise<ValidatableConnectionRow | null> {
  return prisma.billingAuthorityConnection.findUnique({
    where: {
      businessId_environment: { businessId, environment },
    },
    select: CONNECTION_SELECT,
  });
}

async function resolveProbeCustomerVatNumber(
  businessId: number
): Promise<string | null> {
  const profile = await prisma.businessProfile.findUnique({
    where: { businessId },
    select: {
      billingVatNumber: true,
      billingTaxId: true,
    },
  });

  const vat = profile?.billingVatNumber?.trim();
  if (vat) return vat;

  const taxId = profile?.billingTaxId?.trim();
  return taxId || null;
}

function configurationFailureResult(
  validationTimestamp: Date,
  errorCode: string,
  errorMessage: string
): ValidateAuthorityConnectionResult {
  return {
    ok: false,
    validated: false,
    validationTimestamp,
    outcome: "CONFIGURATION_FAILURE",
    errorCode,
    errorMessage: sanitizeAuthorityConnectionErrorMessage(errorMessage),
  };
}

function networkFailureResult(
  validationTimestamp: Date,
  errorCode: string,
  errorMessage: string
): ValidateAuthorityConnectionResult {
  return {
    ok: false,
    validated: false,
    validationTimestamp,
    outcome: "NETWORK_FAILURE",
    errorCode,
    errorMessage: sanitizeAuthorityConnectionErrorMessage(errorMessage),
  };
}

export async function executeAuthorityValidationProbe(input: {
  probeUrl: string;
  accessToken: string;
  payload: AuthorityValidationProbePayload;
  fetchImpl?: typeof fetch;
  probeTimeoutMs?: number;
}): Promise<{
  outcome: AuthorityValidationOutcome;
  httpStatus?: number;
  errorCode?: string;
  errorMessage?: string;
}> {
  const fetchFn = input.fetchImpl ?? fetch;
  const timeoutMs =
    input.probeTimeoutMs ?? DEFAULT_AUTHORITY_VALIDATION_PROBE_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchFn(input.probeUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(input.payload),
      signal: controller.signal,
    });

    const outcome = classifyAuthorityValidationHttpStatus(response.status);
    if (outcome === "AUTH_FAILURE") {
      return {
        outcome,
        httpStatus: response.status,
        errorCode: AUTHORITY_VALIDATION_ERROR_CODES.AUTH_REJECTED,
        errorMessage:
          response.status === 403
            ? "Authority validation probe rejected the access token"
            : "Authority validation probe unauthorized",
      };
    }

    if (outcome === "NETWORK_FAILURE") {
      return {
        outcome,
        httpStatus: response.status,
        errorCode: AUTHORITY_VALIDATION_ERROR_CODES.UPSTREAM_ERROR,
        errorMessage: "Authority validation probe upstream error",
      };
    }

    return { outcome: "VALID", httpStatus: response.status };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return {
        outcome: "NETWORK_FAILURE",
        errorCode: AUTHORITY_VALIDATION_ERROR_CODES.PROBE_TIMEOUT,
        errorMessage: "Authority validation probe timed out",
      };
    }

    return {
      outcome: "NETWORK_FAILURE",
      errorCode: AUTHORITY_VALIDATION_ERROR_CODES.UPSTREAM_ERROR,
      errorMessage: sanitizeAuthorityConnectionErrorMessage(
        error instanceof Error ? error.message : "Authority validation probe failed"
      ),
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Validates an authority connection by executing the ITA probe and applying
 * lifecycle transitions through the D.2.3 connection service.
 */
export async function validateAuthorityConnection(
  input: ValidateAuthorityConnectionInput
): Promise<ValidateAuthorityConnectionResult> {
  assertPositiveInteger(input.businessId, "businessId");

  const validationTimestamp = new Date();

  const row = await loadValidatableAuthorityConnection(
    input.businessId,
    input.environment
  );
  const validatability = assessAuthorityConnectionValidatability(row);
  if (!validatability.ok) {
    return configurationFailureResult(
      validationTimestamp,
      validatability.errorCode,
      validatability.errorMessage
    );
  }

  const accessToken = decryptAuthorityConnectionToken(
    {
      encrypted: validatability.connection.accessTokenEncrypted!,
      iv: validatability.connection.accessTokenIv!,
      tag: validatability.connection.accessTokenTag!,
    },
    input.businessId,
    input.environment
  );

  if (!accessToken) {
    return configurationFailureResult(
      validationTimestamp,
      AUTHORITY_VALIDATION_ERROR_CODES.TOKEN_DECRYPT_FAILED,
      "Authority access token could not be decrypted"
    );
  }

  let probeUrl: string;
  let probePayload: AuthorityValidationProbePayload;
  try {
    const envConfig = resolveAuthorityEnvConfig(input.environment);
    probeUrl = buildAuthorityValidationProbeUrl(envConfig);
    const customerVatNumber = await resolveProbeCustomerVatNumber(input.businessId);
    probePayload = buildAuthorityValidationProbePayload({ customerVatNumber });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Authority validation configuration is unavailable";
    return configurationFailureResult(
      validationTimestamp,
      AUTHORITY_VALIDATION_ERROR_CODES.CONFIGURATION_ERROR,
      message
    );
  }

  const probeResult = await executeAuthorityValidationProbe({
    probeUrl,
    accessToken,
    payload: probePayload,
    fetchImpl: input.fetchImpl,
    probeTimeoutMs: input.probeTimeoutMs,
  });

  if (probeResult.outcome === "NETWORK_FAILURE") {
    return networkFailureResult(
      validationTimestamp,
      probeResult.errorCode ?? AUTHORITY_VALIDATION_ERROR_CODES.UPSTREAM_ERROR,
      probeResult.errorMessage ?? "Authority validation probe failed"
    );
  }

  if (probeResult.outcome === "AUTH_FAILURE") {
    try {
      await markAuthorityAuthFailure({
        businessId: input.businessId,
        environment: input.environment,
        errorCode: (
          probeResult.errorCode ?? AUTHORITY_VALIDATION_ERROR_CODES.AUTH_REJECTED
        ).slice(0, 64),
        errorMessage:
          probeResult.errorMessage ??
          "Authority validation probe rejected the access token",
      });
    } catch (error) {
      if (error instanceof NotFoundError) {
        return configurationFailureResult(
          validationTimestamp,
          AUTHORITY_VALIDATION_ERROR_CODES.NOT_VALIDATABLE,
          error.message
        );
      }
      throw error;
    }

    return {
      ok: false,
      validated: false,
      validationTimestamp,
      outcome: "AUTH_FAILURE",
      errorCode: probeResult.errorCode,
      errorMessage: probeResult.errorMessage,
    };
  }

  const validated = await markAuthorityValidated({
    businessId: input.businessId,
    environment: input.environment,
    validatedAt: validationTimestamp,
  });

  return {
    ok: true,
    validated: validated.toStatus === BillingAuthorityConnectionStatus.VALIDATED,
    validationTimestamp,
    outcome: "VALID",
  };
}
