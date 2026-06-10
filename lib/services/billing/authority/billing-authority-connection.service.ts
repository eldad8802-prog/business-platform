/**
 * `BillingAuthorityConnection` persistence layer.
 *
 * Single gateway for authority connection reads and lifecycle transitions.
 * Token columns are written as pre-encrypted ciphertext only — this module
 * never decrypts tokens and never exposes ciphertext through public APIs.
 */

import {
  BillingAuthorityConnectionStatus,
  BillingAuthorityEnvironment,
  Prisma,
} from "@prisma/client";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import {
  createBillingAuditEventTx,
  type BillingAuthorityConnectionAuditEventType,
} from "@/lib/services/billing/billing-audit.service";
import type {
  AuthorityConnectionEncryptedTokenFields,
  PublicAuthorityConnection,
} from "@/lib/services/billing/authority/billing-authority-connection.types";

const PUBLIC_SELECT = {
  businessId: true,
  environment: true,
  status: true,
  oauthAuthorizedAt: true,
  oauthAuthorizedByUserId: true,
  accessTokenExpiresAt: true,
  refreshTokenExpiresAt: true,
  lastTokenRefreshAt: true,
  lastValidatedAt: true,
  revokedAt: true,
  lastErrorCode: true,
  lastErrorMessage: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.BillingAuthorityConnectionSelect;

const CONNECTION_ROW_SELECT = {
  ...PUBLIC_SELECT,
  id: true,
  accessTokenEncrypted: true,
  accessTokenIv: true,
  accessTokenTag: true,
  refreshTokenEncrypted: true,
  refreshTokenIv: true,
  refreshTokenTag: true,
  encryptionKeyId: true,
} as const satisfies Prisma.BillingAuthorityConnectionSelect;

export type AuthorityConnectionRow = Prisma.BillingAuthorityConnectionGetPayload<{
  select: typeof CONNECTION_ROW_SELECT;
}>;

export type AuthorityConnectionTransitionResult = {
  connection: PublicAuthorityConnection;
  connectionId: number;
  fromStatus: BillingAuthorityConnectionStatus;
  toStatus: BillingAuthorityConnectionStatus;
  auditEventType: BillingAuthorityConnectionAuditEventType | null;
  auditWritten: boolean;
};

const START_AUTHORIZATION_FROM: readonly BillingAuthorityConnectionStatus[] = [
  BillingAuthorityConnectionStatus.DISCONNECTED,
  BillingAuthorityConnectionStatus.ERROR,
  BillingAuthorityConnectionStatus.REVOKED,
];

const REVOKE_FROM: readonly BillingAuthorityConnectionStatus[] = [
  BillingAuthorityConnectionStatus.CONNECTED,
  BillingAuthorityConnectionStatus.VALIDATED,
  BillingAuthorityConnectionStatus.ERROR,
  BillingAuthorityConnectionStatus.AUTHORIZATION_REQUIRED,
  BillingAuthorityConnectionStatus.REVOKED,
];

const TOKEN_FIELD_NAMES = [
  "accessTokenEncrypted",
  "accessTokenIv",
  "accessTokenTag",
  "refreshTokenEncrypted",
  "refreshTokenIv",
  "refreshTokenTag",
  "encryptionKeyId",
] as const;

function assertPositiveInteger(value: number, fieldName: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new ValidationError(`${fieldName} must be a positive integer`);
  }
}

function assertActorUserId(actorUserId: number | null | undefined): number {
  if (actorUserId == null) {
    throw new ValidationError("actorUserId is required");
  }
  assertPositiveInteger(actorUserId, "actorUserId");
  return actorUserId;
}

export function sanitizeAuthorityConnectionErrorMessage(
  message: string
): string {
  return message.trim().slice(0, 500);
}

export function toPublicAuthorityConnection(
  row: Prisma.BillingAuthorityConnectionGetPayload<{
    select: typeof PUBLIC_SELECT;
  }>
): PublicAuthorityConnection {
  return {
    businessId: row.businessId,
    environment: row.environment,
    status: row.status,
    oauthAuthorizedAt: row.oauthAuthorizedAt,
    oauthAuthorizedByUserId: row.oauthAuthorizedByUserId,
    accessTokenExpiresAt: row.accessTokenExpiresAt,
    refreshTokenExpiresAt: row.refreshTokenExpiresAt,
    lastTokenRefreshAt: row.lastTokenRefreshAt,
    lastValidatedAt: row.lastValidatedAt,
    revokedAt: row.revokedAt,
    lastErrorCode: row.lastErrorCode,
    lastErrorMessage: row.lastErrorMessage,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function connectionScopeWhere(
  businessId: number,
  environment: BillingAuthorityEnvironment
): Prisma.BillingAuthorityConnectionWhereUniqueInput {
  return {
    businessId_environment: { businessId, environment },
  };
}

function assertTransitionAllowed(
  from: BillingAuthorityConnectionStatus,
  allowedFrom: readonly BillingAuthorityConnectionStatus[],
  to: BillingAuthorityConnectionStatus,
  operation: string
): void {
  if (!allowedFrom.includes(from)) {
    throw new ForbiddenError(
      `${operation} is not allowed from status ${from} to ${to}`
    );
  }
}

const FORBIDDEN_AUDIT_METADATA_KEYS = new Set<string>([
  ...TOKEN_FIELD_NAMES,
  "clientSecretEncrypted",
  "clientSecretIv",
  "clientSecretTag",
  "accessToken",
  "refreshToken",
  "authorizationCode",
  "plaintext",
]);

function assertAuditMetadataSafe(metadata: Record<string, unknown>): void {
  for (const key of Object.keys(metadata)) {
    if (FORBIDDEN_AUDIT_METADATA_KEYS.has(key)) {
      throw new ValidationError(`Audit metadata must not include ${key}`);
    }
    const value = metadata[key];
    if (typeof value === "string" && value.length > 500) {
      throw new ValidationError(`Audit metadata value for ${key} is too long`);
    }
  }
}

async function loadConnectionRowTx(
  tx: Prisma.TransactionClient,
  businessId: number,
  environment: BillingAuthorityEnvironment
): Promise<AuthorityConnectionRow | null> {
  return tx.billingAuthorityConnection.findUnique({
    where: connectionScopeWhere(businessId, environment),
    select: CONNECTION_ROW_SELECT,
  });
}

async function writeConnectionAuditTx(
  tx: Prisma.TransactionClient,
  input: {
    businessId: number;
    actorUserId?: number | null;
    eventType: BillingAuthorityConnectionAuditEventType;
    summary: string;
    metadata: Record<string, unknown>;
    occurredAt?: Date;
    source?: "USER" | "SYSTEM" | "API";
  }
): Promise<void> {
  assertAuditMetadataSafe(input.metadata);
  await createBillingAuditEventTx(tx, {
    businessId: input.businessId,
    actorUserId: input.actorUserId ?? null,
    eventType: input.eventType,
    source: input.source ?? (input.actorUserId != null ? "USER" : "SYSTEM"),
    summary: input.summary,
    metadata: input.metadata,
    occurredAt: input.occurredAt,
  });
}

async function executeConnectionTransitionTx(
  tx: Prisma.TransactionClient,
  input: {
    businessId: number;
    environment: BillingAuthorityEnvironment;
    requireCurrentStatus: BillingAuthorityConnectionStatus;
    toStatus: BillingAuthorityConnectionStatus;
    operation: string;
    auditEventType: BillingAuthorityConnectionAuditEventType;
    auditSummary: string;
    actorUserId?: number | null;
    metadata?: Record<string, unknown>;
    occurredAt?: Date;
    connectionUpdate: Prisma.BillingAuthorityConnectionUpdateInput;
    skipAudit?: boolean;
  }
): Promise<AuthorityConnectionTransitionResult> {
  const row = await loadConnectionRowTx(tx, input.businessId, input.environment);
  if (!row) {
    throw new NotFoundError("Authority connection not found");
  }

  if (row.status !== input.requireCurrentStatus) {
    throw new ForbiddenError(
      `${input.operation} requires status ${input.requireCurrentStatus} (got ${row.status})`
    );
  }

  const updated = await tx.billingAuthorityConnection.update({
    where: { id: row.id },
    data: {
      ...input.connectionUpdate,
      status: input.toStatus,
    },
    select: CONNECTION_ROW_SELECT,
  });

  let auditWritten = false;
  if (!input.skipAudit) {
    const metadata = {
      connectionId: row.id,
      environment: input.environment,
      previousStatus: row.status,
      nextStatus: input.toStatus,
      ...input.metadata,
    };
    await writeConnectionAuditTx(tx, {
      businessId: input.businessId,
      actorUserId: input.actorUserId,
      eventType: input.auditEventType,
      summary: input.auditSummary,
      metadata,
      occurredAt: input.occurredAt,
    });
    auditWritten = true;
  }

  return {
    connection: toPublicAuthorityConnection(updated),
    connectionId: row.id,
    fromStatus: row.status,
    toStatus: input.toStatus,
    auditEventType: input.skipAudit ? null : input.auditEventType,
    auditWritten,
  };
}

export async function findPublicAuthorityConnection(
  businessId: number,
  environment: BillingAuthorityEnvironment
): Promise<PublicAuthorityConnection | null> {
  assertPositiveInteger(businessId, "businessId");
  const row = await prisma.billingAuthorityConnection.findUnique({
    where: connectionScopeWhere(businessId, environment),
    select: PUBLIC_SELECT,
  });
  return row ? toPublicAuthorityConnection(row) : null;
}

export async function ensureAuthorityConnectionTx(
  tx: Prisma.TransactionClient,
  input: {
    businessId: number;
    environment: BillingAuthorityEnvironment;
  }
): Promise<AuthorityConnectionRow> {
  assertPositiveInteger(input.businessId, "businessId");

  return tx.billingAuthorityConnection.upsert({
    where: connectionScopeWhere(input.businessId, input.environment),
    create: {
      businessId: input.businessId,
      environment: input.environment,
      status: BillingAuthorityConnectionStatus.DISCONNECTED,
    },
    update: {},
    select: CONNECTION_ROW_SELECT,
  });
}

export async function startAuthorityAuthorizationTx(
  tx: Prisma.TransactionClient,
  input: {
    businessId: number;
    environment: BillingAuthorityEnvironment;
    actorUserId: number;
    occurredAt?: Date;
  }
): Promise<AuthorityConnectionTransitionResult> {
  const actorUserId = assertActorUserId(input.actorUserId);
  assertPositiveInteger(input.businessId, "businessId");

  const row = await ensureAuthorityConnectionTx(tx, {
    businessId: input.businessId,
    environment: input.environment,
  });

  if (row.status === BillingAuthorityConnectionStatus.AUTHORIZATION_REQUIRED) {
    return {
      connection: toPublicAuthorityConnection(row),
      connectionId: row.id,
      fromStatus: row.status,
      toStatus: row.status,
      auditEventType: null,
      auditWritten: false,
    };
  }

  assertTransitionAllowed(
    row.status,
    START_AUTHORIZATION_FROM,
    BillingAuthorityConnectionStatus.AUTHORIZATION_REQUIRED,
    "startAuthorityAuthorization"
  );

  return executeConnectionTransitionTx(tx, {
    businessId: input.businessId,
    environment: input.environment,
    requireCurrentStatus: row.status,
    toStatus: BillingAuthorityConnectionStatus.AUTHORIZATION_REQUIRED,
    operation: "startAuthorityAuthorization",
    auditEventType: "BILLING_AUTHORITY_OAUTH_STARTED",
    auditSummary: "התחברות לרשות המסים החלה",
    actorUserId,
    occurredAt: input.occurredAt,
    connectionUpdate: {
      lastErrorCode: null,
      lastErrorMessage: null,
      revokedAt: null,
    },
  });
}

function assertEncryptedTokenFields(
  tokens: AuthorityConnectionEncryptedTokenFields
): void {
  const required: (keyof AuthorityConnectionEncryptedTokenFields)[] = [
    "accessTokenEncrypted",
    "accessTokenIv",
    "accessTokenTag",
    "refreshTokenEncrypted",
    "refreshTokenIv",
    "refreshTokenTag",
    "encryptionKeyId",
  ];
  for (const field of required) {
    const value = tokens[field];
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new ValidationError(`${field} is required`);
    }
  }
}

export async function markAuthorityConnectedTx(
  tx: Prisma.TransactionClient,
  input: {
    businessId: number;
    environment: BillingAuthorityEnvironment;
    actorUserId: number;
    tokens: AuthorityConnectionEncryptedTokenFields;
    accessTokenExpiresAt?: Date | null;
    refreshTokenExpiresAt?: Date | null;
    oauthAuthorizedAt?: Date;
    occurredAt?: Date;
  }
): Promise<AuthorityConnectionTransitionResult> {
  const actorUserId = assertActorUserId(input.actorUserId);
  assertPositiveInteger(input.businessId, "businessId");
  assertEncryptedTokenFields(input.tokens);

  const oauthAuthorizedAt = input.oauthAuthorizedAt ?? new Date();
  if (Number.isNaN(oauthAuthorizedAt.getTime())) {
    throw new ValidationError("oauthAuthorizedAt must be a valid Date");
  }

  return executeConnectionTransitionTx(tx, {
    businessId: input.businessId,
    environment: input.environment,
    requireCurrentStatus: BillingAuthorityConnectionStatus.AUTHORIZATION_REQUIRED,
    toStatus: BillingAuthorityConnectionStatus.CONNECTED,
    operation: "markAuthorityConnected",
    auditEventType: "BILLING_AUTHORITY_OAUTH_COMPLETED",
    auditSummary: "התחברות לרשות המסים הושלמה",
    actorUserId,
    occurredAt: input.occurredAt,
    metadata: {
      oauthAuthorizedAt: oauthAuthorizedAt.toISOString(),
      hasRefreshToken: true,
      accessTokenExpiresAt: input.accessTokenExpiresAt?.toISOString() ?? null,
      refreshTokenExpiresAt: input.refreshTokenExpiresAt?.toISOString() ?? null,
    },
    connectionUpdate: {
      accessTokenEncrypted: input.tokens.accessTokenEncrypted,
      accessTokenIv: input.tokens.accessTokenIv,
      accessTokenTag: input.tokens.accessTokenTag,
      refreshTokenEncrypted: input.tokens.refreshTokenEncrypted,
      refreshTokenIv: input.tokens.refreshTokenIv,
      refreshTokenTag: input.tokens.refreshTokenTag,
      encryptionKeyId: input.tokens.encryptionKeyId,
      accessTokenExpiresAt: input.accessTokenExpiresAt ?? null,
      refreshTokenExpiresAt: input.refreshTokenExpiresAt ?? null,
      oauthAuthorizedAt,
      oauthAuthorizedByUserId: actorUserId,
      lastErrorCode: null,
      lastErrorMessage: null,
      revokedAt: null,
    },
  });
}

export async function markAuthorityOAuthFailedTx(
  tx: Prisma.TransactionClient,
  input: {
    businessId: number;
    environment: BillingAuthorityEnvironment;
    actorUserId?: number | null;
    errorCode: string;
    errorMessage: string;
    occurredAt?: Date;
  }
): Promise<AuthorityConnectionTransitionResult> {
  assertPositiveInteger(input.businessId, "businessId");
  const errorCode = input.errorCode.trim();
  const errorMessage = sanitizeAuthorityConnectionErrorMessage(input.errorMessage);
  if (!errorCode) {
    throw new ValidationError("errorCode is required");
  }
  if (!errorMessage) {
    throw new ValidationError("errorMessage is required");
  }

  return executeConnectionTransitionTx(tx, {
    businessId: input.businessId,
    environment: input.environment,
    requireCurrentStatus: BillingAuthorityConnectionStatus.AUTHORIZATION_REQUIRED,
    toStatus: BillingAuthorityConnectionStatus.ERROR,
    operation: "markAuthorityOAuthFailed",
    auditEventType: "BILLING_AUTHORITY_OAUTH_FAILED",
    auditSummary: "התחברות לרשות המסים נכשלה",
    actorUserId: input.actorUserId ?? null,
    occurredAt: input.occurredAt,
    metadata: {
      errorCode,
      errorMessage,
    },
    connectionUpdate: {
      lastErrorCode: errorCode.slice(0, 64),
      lastErrorMessage: errorMessage,
    },
  });
}

export async function markAuthorityValidatedTx(
  tx: Prisma.TransactionClient,
  input: {
    businessId: number;
    environment: BillingAuthorityEnvironment;
    validatedAt?: Date;
    occurredAt?: Date;
  }
): Promise<AuthorityConnectionTransitionResult> {
  assertPositiveInteger(input.businessId, "businessId");
  const validatedAt = input.validatedAt ?? new Date();
  if (Number.isNaN(validatedAt.getTime())) {
    throw new ValidationError("validatedAt must be a valid Date");
  }

  const row = await loadConnectionRowTx(tx, input.businessId, input.environment);
  if (!row) {
    throw new NotFoundError("Authority connection not found");
  }

  if (row.status === BillingAuthorityConnectionStatus.VALIDATED) {
    return {
      connection: toPublicAuthorityConnection(row),
      connectionId: row.id,
      fromStatus: row.status,
      toStatus: row.status,
      auditEventType: null,
      auditWritten: false,
    };
  }

  if (
    row.status !== BillingAuthorityConnectionStatus.CONNECTED ||
    !row.accessTokenEncrypted ||
    !row.refreshTokenEncrypted
  ) {
    throw new ForbiddenError(
      "markAuthorityValidated requires a connected row with encrypted tokens"
    );
  }

  return executeConnectionTransitionTx(tx, {
    businessId: input.businessId,
    environment: input.environment,
    requireCurrentStatus: BillingAuthorityConnectionStatus.CONNECTED,
    toStatus: BillingAuthorityConnectionStatus.VALIDATED,
    operation: "markAuthorityValidated",
    auditEventType: "BILLING_AUTHORITY_CONNECTION_VALIDATED",
    auditSummary: "חיבור רשות המסים אומת",
    occurredAt: input.occurredAt,
    metadata: {
      lastValidatedAt: validatedAt.toISOString(),
    },
    connectionUpdate: {
      lastValidatedAt: validatedAt,
      lastErrorCode: null,
      lastErrorMessage: null,
    },
  });
}

export async function markAuthorityAuthFailureTx(
  tx: Prisma.TransactionClient,
  input: {
    businessId: number;
    environment: BillingAuthorityEnvironment;
    errorCode: string;
    errorMessage: string;
    occurredAt?: Date;
  }
): Promise<AuthorityConnectionTransitionResult> {
  assertPositiveInteger(input.businessId, "businessId");
  const errorCode = input.errorCode.trim();
  const errorMessage = sanitizeAuthorityConnectionErrorMessage(input.errorMessage);
  if (!errorCode) {
    throw new ValidationError("errorCode is required");
  }
  if (!errorMessage) {
    throw new ValidationError("errorMessage is required");
  }

  const row = await loadConnectionRowTx(tx, input.businessId, input.environment);
  if (!row) {
    throw new NotFoundError("Authority connection not found");
  }

  if (
    row.status !== BillingAuthorityConnectionStatus.CONNECTED &&
    row.status !== BillingAuthorityConnectionStatus.VALIDATED
  ) {
    throw new ForbiddenError(
      `markAuthorityAuthFailure is not allowed from status ${row.status}`
    );
  }

  return executeConnectionTransitionTx(tx, {
    businessId: input.businessId,
    environment: input.environment,
    requireCurrentStatus: row.status,
    toStatus: BillingAuthorityConnectionStatus.ERROR,
    operation: "markAuthorityAuthFailure",
    auditEventType: "BILLING_AUTHORITY_AUTH_FAILURE",
    auditSummary: "אימות רשות המסים נכשל",
    occurredAt: input.occurredAt,
    metadata: {
      errorCode,
      errorMessage,
    },
    connectionUpdate: {
      lastErrorCode: errorCode.slice(0, 64),
      lastErrorMessage: errorMessage,
    },
  });
}

export async function markAuthorityTokenRefreshedTx(
  tx: Prisma.TransactionClient,
  input: {
    businessId: number;
    environment: BillingAuthorityEnvironment;
    actorUserId?: number | null;
    tokens: AuthorityConnectionEncryptedTokenFields;
    refreshedAt?: Date;
    accessTokenExpiresAt?: Date | null;
    refreshTokenExpiresAt?: Date | null;
    refreshTokenRotated: boolean;
    occurredAt?: Date;
  }
): Promise<AuthorityConnectionTransitionResult> {
  assertPositiveInteger(input.businessId, "businessId");
  assertEncryptedTokenFields(input.tokens);

  const refreshedAt = input.refreshedAt ?? new Date();
  if (Number.isNaN(refreshedAt.getTime())) {
    throw new ValidationError("refreshedAt must be a valid Date");
  }

  const row = await loadConnectionRowTx(tx, input.businessId, input.environment);
  if (!row) {
    throw new NotFoundError("Authority connection not found");
  }

  if (
    row.status !== BillingAuthorityConnectionStatus.CONNECTED &&
    row.status !== BillingAuthorityConnectionStatus.VALIDATED
  ) {
    throw new ForbiddenError(
      `markAuthorityTokenRefreshed is not allowed from status ${row.status}`
    );
  }

  return executeConnectionTransitionTx(tx, {
    businessId: input.businessId,
    environment: input.environment,
    requireCurrentStatus: row.status,
    toStatus: row.status,
    operation: "markAuthorityTokenRefreshed",
    auditEventType: "BILLING_AUTHORITY_TOKEN_REFRESHED",
    auditSummary: "אסימון רשות המסים רוענן",
    actorUserId: input.actorUserId ?? null,
    occurredAt: input.occurredAt,
    metadata: {
      lastTokenRefreshAt: refreshedAt.toISOString(),
      accessTokenExpiresAt: input.accessTokenExpiresAt?.toISOString() ?? null,
      refreshTokenExpiresAt: input.refreshTokenExpiresAt?.toISOString() ?? null,
      refreshTokenRotated: input.refreshTokenRotated,
    },
    connectionUpdate: {
      accessTokenEncrypted: input.tokens.accessTokenEncrypted,
      accessTokenIv: input.tokens.accessTokenIv,
      accessTokenTag: input.tokens.accessTokenTag,
      refreshTokenEncrypted: input.tokens.refreshTokenEncrypted,
      refreshTokenIv: input.tokens.refreshTokenIv,
      refreshTokenTag: input.tokens.refreshTokenTag,
      encryptionKeyId: input.tokens.encryptionKeyId,
      accessTokenExpiresAt: input.accessTokenExpiresAt ?? null,
      refreshTokenExpiresAt: input.refreshTokenExpiresAt ?? null,
      lastTokenRefreshAt: refreshedAt,
      lastErrorCode: null,
      lastErrorMessage: null,
    },
  });
}

export async function markAuthorityTokenRefreshFailedTx(
  tx: Prisma.TransactionClient,
  input: {
    businessId: number;
    environment: BillingAuthorityEnvironment;
    actorUserId?: number | null;
    errorCode: string;
    errorMessage: string;
    refreshAttemptAt?: Date;
    occurredAt?: Date;
  }
): Promise<AuthorityConnectionTransitionResult> {
  assertPositiveInteger(input.businessId, "businessId");
  const errorCode = input.errorCode.trim();
  const errorMessage = sanitizeAuthorityConnectionErrorMessage(input.errorMessage);
  if (!errorCode) {
    throw new ValidationError("errorCode is required");
  }
  if (!errorMessage) {
    throw new ValidationError("errorMessage is required");
  }

  const refreshAttemptAt = input.refreshAttemptAt ?? new Date();
  if (Number.isNaN(refreshAttemptAt.getTime())) {
    throw new ValidationError("refreshAttemptAt must be a valid Date");
  }

  const row = await loadConnectionRowTx(tx, input.businessId, input.environment);
  if (!row) {
    throw new NotFoundError("Authority connection not found");
  }

  if (
    row.status !== BillingAuthorityConnectionStatus.CONNECTED &&
    row.status !== BillingAuthorityConnectionStatus.VALIDATED
  ) {
    throw new ForbiddenError(
      `markAuthorityTokenRefreshFailed is not allowed from status ${row.status}`
    );
  }

  return executeConnectionTransitionTx(tx, {
    businessId: input.businessId,
    environment: input.environment,
    requireCurrentStatus: row.status,
    toStatus: BillingAuthorityConnectionStatus.AUTHORIZATION_REQUIRED,
    operation: "markAuthorityTokenRefreshFailed",
    auditEventType: "BILLING_AUTHORITY_TOKEN_REFRESH_FAILED",
    auditSummary: "רענון אסימון נכשל",
    actorUserId: input.actorUserId ?? null,
    occurredAt: input.occurredAt,
    metadata: {
      errorCode,
      errorMessage,
      refreshAttemptAt: refreshAttemptAt.toISOString(),
    },
    connectionUpdate: {
      lastErrorCode: errorCode.slice(0, 64),
      lastErrorMessage: errorMessage,
    },
  });
}

export async function revokeAuthorityConnectionTx(
  tx: Prisma.TransactionClient,
  input: {
    businessId: number;
    environment: BillingAuthorityEnvironment;
    actorUserId: number;
    reason?: string | null;
    occurredAt?: Date;
  }
): Promise<AuthorityConnectionTransitionResult> {
  const actorUserId = assertActorUserId(input.actorUserId);
  assertPositiveInteger(input.businessId, "businessId");

  const row = await loadConnectionRowTx(tx, input.businessId, input.environment);
  if (!row) {
    throw new NotFoundError("Authority connection not found");
  }

  if (row.status === BillingAuthorityConnectionStatus.REVOKED) {
    return {
      connection: toPublicAuthorityConnection(row),
      connectionId: row.id,
      fromStatus: row.status,
      toStatus: row.status,
      auditEventType: null,
      auditWritten: false,
    };
  }

  assertTransitionAllowed(
    row.status,
    REVOKE_FROM.filter((status) => status !== BillingAuthorityConnectionStatus.REVOKED),
    BillingAuthorityConnectionStatus.REVOKED,
    "revokeAuthorityConnection"
  );

  const revokedAt = input.occurredAt ?? new Date();
  const sanitizedReason =
    input.reason != null
      ? sanitizeAuthorityConnectionErrorMessage(input.reason)
      : null;

  return executeConnectionTransitionTx(tx, {
    businessId: input.businessId,
    environment: input.environment,
    requireCurrentStatus: row.status,
    toStatus: BillingAuthorityConnectionStatus.REVOKED,
    operation: "revokeAuthorityConnection",
    auditEventType: "BILLING_AUTHORITY_CONNECTION_REVOKED",
    auditSummary: "חיבור רשות המסים בוטל",
    actorUserId,
    occurredAt: revokedAt,
    metadata: {
      revokedAt: revokedAt.toISOString(),
      reason: sanitizedReason,
    },
    connectionUpdate: {
      accessTokenEncrypted: null,
      accessTokenIv: null,
      accessTokenTag: null,
      refreshTokenEncrypted: null,
      refreshTokenIv: null,
      refreshTokenTag: null,
      encryptionKeyId: null,
      accessTokenExpiresAt: null,
      refreshTokenExpiresAt: null,
      oauthAuthorizedAt: null,
      oauthAuthorizedByUserId: null,
      lastTokenRefreshAt: null,
      lastValidatedAt: null,
      revokedAt,
      lastErrorCode: null,
      lastErrorMessage: sanitizedReason,
    },
  });
}

export async function startAuthorityAuthorization(
  input: Parameters<typeof startAuthorityAuthorizationTx>[1]
): Promise<AuthorityConnectionTransitionResult> {
  return prisma.$transaction((tx) => startAuthorityAuthorizationTx(tx, input));
}

export async function markAuthorityConnected(
  input: Parameters<typeof markAuthorityConnectedTx>[1]
): Promise<AuthorityConnectionTransitionResult> {
  return prisma.$transaction((tx) => markAuthorityConnectedTx(tx, input));
}

export async function markAuthorityOAuthFailed(
  input: Parameters<typeof markAuthorityOAuthFailedTx>[1]
): Promise<AuthorityConnectionTransitionResult> {
  return prisma.$transaction((tx) => markAuthorityOAuthFailedTx(tx, input));
}

export async function markAuthorityValidated(
  input: Parameters<typeof markAuthorityValidatedTx>[1]
): Promise<AuthorityConnectionTransitionResult> {
  return prisma.$transaction((tx) => markAuthorityValidatedTx(tx, input));
}

export async function markAuthorityAuthFailure(
  input: Parameters<typeof markAuthorityAuthFailureTx>[1]
): Promise<AuthorityConnectionTransitionResult> {
  return prisma.$transaction((tx) => markAuthorityAuthFailureTx(tx, input));
}

export async function markAuthorityTokenRefreshed(
  input: Parameters<typeof markAuthorityTokenRefreshedTx>[1]
): Promise<AuthorityConnectionTransitionResult> {
  return prisma.$transaction((tx) => markAuthorityTokenRefreshedTx(tx, input));
}

export async function markAuthorityTokenRefreshFailed(
  input: Parameters<typeof markAuthorityTokenRefreshFailedTx>[1]
): Promise<AuthorityConnectionTransitionResult> {
  return prisma.$transaction((tx) =>
    markAuthorityTokenRefreshFailedTx(tx, input)
  );
}

export async function revokeAuthorityConnection(
  input: Parameters<typeof revokeAuthorityConnectionTx>[1]
): Promise<AuthorityConnectionTransitionResult> {
  return prisma.$transaction((tx) => revokeAuthorityConnectionTx(tx, input));
}
