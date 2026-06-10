import {
  BillingAuthorityApp,
  BillingAuthorityAppStatus,
  BillingAuthorityEnvironment,
} from "@prisma/client";
import { ServiceUnavailableError } from "@/lib/errors";
import type { AuthorityAppContext } from "@/lib/services/billing/authority/billing-authority-connection.types";
import { prisma } from "@/lib/prisma";

type ActiveAuthorityAppRow = BillingAuthorityApp & {
  status: Extract<BillingAuthorityAppStatus, "ACTIVE">;
  itaClientId: string;
};

export function toAuthorityAppContext(row: ActiveAuthorityAppRow): AuthorityAppContext {
  return {
    id: row.id,
    environment: row.environment,
    status: "ACTIVE",
    accountingSoftwareNumber: row.accountingSoftwareNumber,
    itaClientId: row.itaClientId,
    portalOrganizationId: row.portalOrganizationId,
    portalApplicationId: row.portalApplicationId,
    registeredAt: row.registeredAt,
    lastValidatedAt: row.lastValidatedAt,
  };
}

export function assertActiveAuthorityApp(
  row: BillingAuthorityApp | null
): ActiveAuthorityAppRow {
  if (!row) {
    throw new ServiceUnavailableError(
      "Tax authority platform app is not configured for this environment"
    );
  }

  if (row.status === BillingAuthorityAppStatus.DISABLED) {
    throw new ServiceUnavailableError(
      "Tax authority platform app is disabled for this environment"
    );
  }

  const clientId = row.itaClientId?.trim();
  if (!clientId) {
    throw new ServiceUnavailableError(
      "Tax authority platform app is missing ITA client id"
    );
  }

  if (
    !row.clientSecretEncrypted ||
    !row.clientSecretIv ||
    !row.clientSecretTag
  ) {
    throw new ServiceUnavailableError(
      "Tax authority platform app is missing encrypted client secret"
    );
  }

  return {
    ...row,
    status: BillingAuthorityAppStatus.ACTIVE,
    itaClientId: clientId,
  };
}

/**
 * Loads the active platform app for an authority environment.
 * Returns a safe context without secret material.
 */
export async function getActiveAuthorityApp(
  environment: BillingAuthorityEnvironment
): Promise<AuthorityAppContext> {
  const row = await prisma.billingAuthorityApp.findUnique({
    where: { environment },
  });

  return toAuthorityAppContext(assertActiveAuthorityApp(row));
}
