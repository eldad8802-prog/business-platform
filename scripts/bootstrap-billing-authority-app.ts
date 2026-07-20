/**
 * Bootstrap / update BillingAuthorityApp for ITA OAuth (confidential client).
 *
 * DRY-RUN (default) — no DB write:
 *   npx tsx scripts/bootstrap-billing-authority-app.ts --environment SANDBOX
 *
 * APPLY — writes the row:
 *   npx tsx scripts/bootstrap-billing-authority-app.ts --environment SANDBOX --apply
 *
 * Sensitive inputs are read from environment variables (never CLI args, never
 * printed):
 *   BILLING_AUTHORITY_ITA_CLIENT_ID
 *   BILLING_AUTHORITY_CLIENT_SECRET
 *   BILLING_AUTHORITY_ACCOUNTING_SOFTWARE_NUMBER   (fallback for --accounting-software-number)
 *   BILLING_AUTHORITY_ENCRYPTION_KEY               (32-byte hex or base64)
 *
 * CLI args, where provided, take precedence over env. The client secret is never
 * echoed (not even partially); client id and accounting number are only ever
 * shown masked (***<last4>). Idempotent: upserts on unique `environment`.
 */

import {
  BillingAuthorityAppStatus,
  BillingAuthorityEnvironment,
  Prisma,
} from "@prisma/client";
import { createCipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm" as const;
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const ENCRYPTION_KEY_ENV = "BILLING_AUTHORITY_ENCRYPTION_KEY";
const ENCRYPTION_KEY_ID = "authority_gcm_v1";

type EncryptedSecret = { encrypted: string; iv: string; tag: string };

/** Masks a value to `***<last4>`; empty stays empty. Never reveals the head. */
export function maskTail(value: string | undefined | null): string {
  const v = (value ?? "").trim();
  if (v.length === 0) return "";
  return `***${v.slice(-4)}`;
}

function getFlag(argv: string[], name: string): boolean {
  return argv.includes(name);
}

function getValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

export function parseEnvironmentStrict(
  raw: string | undefined
): BillingAuthorityEnvironment | null {
  const n = raw?.trim().toUpperCase();
  if (n === "SANDBOX") return BillingAuthorityEnvironment.SANDBOX;
  if (n === "PRODUCTION") return BillingAuthorityEnvironment.PRODUCTION;
  return null;
}

export type BootstrapInputs = {
  apply: boolean;
  environment: BillingAuthorityEnvironment;
  accountingSoftwareNumber: string;
  itaClientId: string;
  clientSecret: string;
  portalOrganizationId?: string;
  portalApplicationId?: string;
};

export type ResolveResult =
  | { ok: true; inputs: BootstrapInputs }
  | { ok: false; errorField: string };

/**
 * Resolves inputs from argv + env. CLI takes precedence over env for each value.
 * Returns an explicit error field name instead of throwing/exiting, so callers
 * (and tests) can handle it without process-level side effects.
 */
export function resolveBootstrapInputs(
  argv: string[],
  env: NodeJS.ProcessEnv
): ResolveResult {
  const environment = parseEnvironmentStrict(
    getValue(argv, "--environment") ?? "SANDBOX"
  );
  if (!environment) return { ok: false, errorField: "--environment" };

  const accountingSoftwareNumber =
    getValue(argv, "--accounting-software-number")?.trim() ??
    env.BILLING_AUTHORITY_ACCOUNTING_SOFTWARE_NUMBER?.trim() ??
    "";
  const itaClientId =
    getValue(argv, "--ita-client-id")?.trim() ??
    env.BILLING_AUTHORITY_ITA_CLIENT_ID?.trim() ??
    "";
  const clientSecret =
    getValue(argv, "--client-secret")?.trim() ??
    env.BILLING_AUTHORITY_CLIENT_SECRET?.trim() ??
    "";
  const portalOrganizationId = getValue(argv, "--portal-organization-id")?.trim();
  const portalApplicationId = getValue(argv, "--portal-application-id")?.trim();

  if (!accountingSoftwareNumber)
    return { ok: false, errorField: "accountingSoftwareNumber" };
  if (!itaClientId) return { ok: false, errorField: "itaClientId" };
  if (!clientSecret) return { ok: false, errorField: "clientSecret" };

  return {
    ok: true,
    inputs: {
      apply: getFlag(argv, "--apply"),
      environment,
      accountingSoftwareNumber,
      itaClientId,
      clientSecret,
      portalOrganizationId,
      portalApplicationId,
    },
  };
}

/** Sanitized dry-run summary. Never contains the secret; ids are masked. */
export function buildDryRunSummary(inputs: BootstrapInputs) {
  return {
    mode: "dry-run" as const,
    databaseWritePerformed: false,
    environment: inputs.environment,
    itaClientIdPresent: inputs.itaClientId.length > 0,
    itaClientIdMasked: maskTail(inputs.itaClientId),
    accountingSoftwareNumberPresent: inputs.accountingSoftwareNumber.length > 0,
    accountingSoftwareNumberMasked: maskTail(inputs.accountingSoftwareNumber),
    portalOrganizationIdPresent: !!inputs.portalOrganizationId,
    portalApplicationIdPresent: !!inputs.portalApplicationId,
  };
}

/** Sanitized apply summary. Never contains ids in full or the secret. */
export function buildApplySummary(
  inputs: BootstrapInputs,
  operation: "created" | "updated"
) {
  return {
    mode: "apply" as const,
    databaseWritePerformed: true,
    operation,
    environment: inputs.environment,
    status: BillingAuthorityAppStatus.ACTIVE,
  };
}

function loadEncryptionKey(env: NodeJS.ProcessEnv): Buffer {
  const raw = env[ENCRYPTION_KEY_ENV];
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new Error(`Missing ${ENCRYPTION_KEY_ENV}`);
  }
  const trimmed = raw.trim();
  const key = /^[0-9a-fA-F]{64}$/.test(trimmed)
    ? Buffer.from(trimmed, "hex")
    : Buffer.from(trimmed, "base64");
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `${ENCRYPTION_KEY_ENV} must decode to exactly ${KEY_BYTES} bytes`
    );
  }
  return key;
}

export function encryptClientSecret(
  plaintext: string,
  environment: BillingAuthorityEnvironment,
  env: NodeJS.ProcessEnv
): EncryptedSecret {
  if (!plaintext) throw new Error("Client secret must be a non-empty string");
  const key = loadEncryptionKey(env);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(Buffer.from(environment, "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  if (tag.length !== TAG_BYTES) {
    throw new Error(`Unexpected GCM tag length: ${tag.length}`);
  }
  return {
    encrypted: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
  };
}

/** Minimal Prisma surface the bootstrap needs — keeps runBootstrap testable. */
export type BootstrapPrisma = {
  billingAuthorityApp: {
    findUnique: (args: {
      where: { environment: BillingAuthorityEnvironment };
    }) => Promise<{ id: number } | null>;
    upsert: (args: Prisma.BillingAuthorityAppUpsertArgs) => Promise<{
      id: number;
      environment: BillingAuthorityEnvironment;
    }>;
  };
};

export type RunBootstrapDeps = {
  argv: string[];
  env: NodeJS.ProcessEnv;
  prisma: BootstrapPrisma;
  log?: (line: string) => void;
  now?: () => Date;
};

export type RunBootstrapResult =
  | { ok: true; mode: "dry-run" }
  | { ok: true; mode: "apply"; operation: "created" | "updated" }
  | { ok: false; errorField: string };

/**
 * Core bootstrap. On dry-run performs NO DB access at all. On apply, reads
 * existence once (to report created|updated) then upserts exactly once. Prints
 * only sanitized summaries.
 */
export async function runBootstrap(
  deps: RunBootstrapDeps
): Promise<RunBootstrapResult> {
  const log = deps.log ?? ((l: string) => console.log(l));
  const now = deps.now ?? (() => new Date());

  const resolved = resolveBootstrapInputs(deps.argv, deps.env);
  if (!resolved.ok) {
    log(JSON.stringify({ error: "missing_or_invalid", field: resolved.errorField }));
    return { ok: false, errorField: resolved.errorField };
  }
  const inputs = resolved.inputs;

  if (!inputs.apply) {
    log(JSON.stringify(buildDryRunSummary(inputs), null, 2));
    return { ok: true, mode: "dry-run" };
  }

  // apply: encrypt (in memory), determine operation, upsert once.
  const encrypted = encryptClientSecret(
    inputs.clientSecret,
    inputs.environment,
    deps.env
  );
  const existing = await deps.prisma.billingAuthorityApp.findUnique({
    where: { environment: inputs.environment },
  });
  const operation: "created" | "updated" = existing ? "updated" : "created";
  const ts = now();

  const shared = {
    status: BillingAuthorityAppStatus.ACTIVE,
    accountingSoftwareNumber: inputs.accountingSoftwareNumber,
    itaClientId: inputs.itaClientId,
    clientSecretEncrypted: encrypted.encrypted,
    clientSecretIv: encrypted.iv,
    clientSecretTag: encrypted.tag,
    encryptionKeyId: ENCRYPTION_KEY_ID,
    portalOrganizationId: inputs.portalOrganizationId ?? null,
    portalApplicationId: inputs.portalApplicationId ?? null,
    registeredAt: ts,
    lastErrorCode: null,
    lastErrorMessage: null,
  };

  await deps.prisma.billingAuthorityApp.upsert({
    where: { environment: inputs.environment },
    create: { environment: inputs.environment, lastValidatedAt: null, ...shared },
    update: { ...shared, updatedAt: ts },
  });

  log(JSON.stringify(buildApplySummary(inputs, operation), null, 2));
  return { ok: true, mode: "apply", operation };
}

async function main() {
  const { prisma } = await import("@/lib/prisma");
  try {
    const result = await runBootstrap({
      argv: process.argv,
      env: process.env,
      prisma: prisma as unknown as BootstrapPrisma,
    });
    if (!result.ok) {
      process.exitCode = 1;
    } else if (result.mode === "dry-run") {
      console.log("\nDry-run complete. Re-run with --apply to persist.");
    }
  } finally {
    await prisma.$disconnect();
  }
}

// Only auto-run when executed directly (not when imported by tests).
if (
  process.argv[1] &&
  /bootstrap-billing-authority-app(\.ts|\.js)?$/.test(process.argv[1])
) {
  void main().catch((error) => {
    console.error(
      "bootstrap-billing-authority-app failed:",
      error instanceof Error ? error.name : "UnknownError"
    );
    process.exit(1);
  });
}
