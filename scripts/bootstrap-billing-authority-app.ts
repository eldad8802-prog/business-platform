/**
 * Bootstrap / update BillingAuthorityApp for ITA OAuth (confidential client).
 *
 * DRY-RUN (default):
 *   npx tsx scripts/bootstrap-billing-authority-app.ts \
 *     --environment SANDBOX \
 *     --accounting-software-number 12345678 \
 *     --ita-client-id <client-id> \
 *     --client-secret <secret>
 *
 * APPLY:
 *   npx tsx scripts/bootstrap-billing-authority-app.ts --apply ...same args...
 *
 * Secrets may also be supplied via env:
 *   BILLING_AUTHORITY_ITA_CLIENT_ID
 *   BILLING_AUTHORITY_CLIENT_SECRET
 *
 * Requires:
 *   BILLING_AUTHORITY_ENCRYPTION_KEY (32-byte hex or base64)
 *
 * Idempotent: upserts on unique `environment`.
 *
 * Client-secret encryption follows the WhatsApp AES-256-GCM pattern and will
 * move to billing-authority-token-crypto.service.ts in D.2.2.
 */

import {
  BillingAuthorityAppStatus,
  BillingAuthorityEnvironment,
  Prisma,
} from "@prisma/client";
import {
  createCipheriv,
  randomBytes,
} from "node:crypto";
import { prisma } from "@/lib/prisma";

const ALGORITHM = "aes-256-gcm" as const;
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const ENCRYPTION_KEY_ENV = "BILLING_AUTHORITY_ENCRYPTION_KEY";
const ENCRYPTION_KEY_ID = "authority_gcm_v1";

type EncryptedSecret = {
  encrypted: string;
  iv: string;
  tag: string;
};

function getFlag(name: string): boolean {
  return process.argv.includes(name);
}

function getValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 && index + 1 < process.argv.length
    ? process.argv[index + 1]
    : undefined;
}

function parseEnvironment(raw: string | undefined): BillingAuthorityEnvironment {
  const normalized = raw?.trim().toUpperCase();
  if (normalized === "SANDBOX") return BillingAuthorityEnvironment.SANDBOX;
  if (normalized === "PRODUCTION") return BillingAuthorityEnvironment.PRODUCTION;
  console.error("--environment must be SANDBOX or PRODUCTION");
  process.exit(1);
}

function loadEncryptionKey(): Buffer {
  const raw = process.env[ENCRYPTION_KEY_ENV];
  if (typeof raw !== "string" || raw.trim().length === 0) {
    console.error(`Missing ${ENCRYPTION_KEY_ENV}`);
    process.exit(1);
  }

  const trimmed = raw.trim();
  let key: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    key = Buffer.from(trimmed, "hex");
  } else {
    try {
      key = Buffer.from(trimmed, "base64");
    } catch {
      console.error(`${ENCRYPTION_KEY_ENV} is not valid base64`);
      process.exit(1);
    }
  }

  if (key.length !== KEY_BYTES) {
    console.error(
      `${ENCRYPTION_KEY_ENV} must decode to exactly ${KEY_BYTES} bytes (got ${key.length})`
    );
    process.exit(1);
  }

  return key;
}

function encryptClientSecret(
  plaintext: string,
  environment: BillingAuthorityEnvironment
): EncryptedSecret {
  if (!plaintext) {
    console.error("Client secret must be a non-empty string");
    process.exit(1);
  }

  const key = loadEncryptionKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(Buffer.from(environment, "utf8"));

  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  if (tag.length !== TAG_BYTES) {
    console.error(`Unexpected GCM tag length: ${tag.length}`);
    process.exit(1);
  }

  return {
    encrypted: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
  };
}

async function main() {
  const apply = getFlag("--apply");
  const environment = parseEnvironment(getValue("--environment") ?? "SANDBOX");
  const accountingSoftwareNumber =
    getValue("--accounting-software-number")?.trim() ?? "";
  const itaClientId =
    getValue("--ita-client-id")?.trim() ??
    process.env.BILLING_AUTHORITY_ITA_CLIENT_ID?.trim() ??
    "";
  const clientSecret =
    getValue("--client-secret")?.trim() ??
    process.env.BILLING_AUTHORITY_CLIENT_SECRET?.trim() ??
    "";
  const portalOrganizationId = getValue("--portal-organization-id")?.trim();
  const portalApplicationId = getValue("--portal-application-id")?.trim();

  if (!accountingSoftwareNumber) {
    console.error("--accounting-software-number is required");
    process.exit(1);
  }
  if (!itaClientId) {
    console.error("--ita-client-id or BILLING_AUTHORITY_ITA_CLIENT_ID is required");
    process.exit(1);
  }
  if (!clientSecret) {
    console.error(
      "--client-secret or BILLING_AUTHORITY_CLIENT_SECRET is required"
    );
    process.exit(1);
  }

  const encrypted = encryptClientSecret(clientSecret, environment);
  const now = new Date();

  const payload: Prisma.BillingAuthorityAppUpsertArgs["create"] = {
    environment,
    status: BillingAuthorityAppStatus.ACTIVE,
    accountingSoftwareNumber,
    itaClientId,
    clientSecretEncrypted: encrypted.encrypted,
    clientSecretIv: encrypted.iv,
    clientSecretTag: encrypted.tag,
    encryptionKeyId: ENCRYPTION_KEY_ID,
    portalOrganizationId: portalOrganizationId ?? null,
    portalApplicationId: portalApplicationId ?? null,
    registeredAt: now,
    lastValidatedAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
  };

  console.log(
    JSON.stringify(
      {
        mode: apply ? "apply" : "dry-run",
        environment,
        accountingSoftwareNumber,
        itaClientId,
        encryptionKeyId: ENCRYPTION_KEY_ID,
        portalOrganizationId: payload.portalOrganizationId,
        portalApplicationId: payload.portalApplicationId,
        hasEncryptedSecret: true,
      },
      null,
      2
    )
  );

  if (!apply) {
    console.log("\nDry-run complete. Re-run with --apply to persist.");
    return;
  }

  const row = await prisma.billingAuthorityApp.upsert({
    where: { environment },
    create: payload,
    update: {
      status: BillingAuthorityAppStatus.ACTIVE,
      accountingSoftwareNumber,
      itaClientId,
      clientSecretEncrypted: encrypted.encrypted,
      clientSecretIv: encrypted.iv,
      clientSecretTag: encrypted.tag,
      encryptionKeyId: ENCRYPTION_KEY_ID,
      portalOrganizationId: portalOrganizationId ?? null,
      portalApplicationId: portalApplicationId ?? null,
      registeredAt: now,
      lastErrorCode: null,
      lastErrorMessage: null,
      updatedAt: now,
    },
  });

  console.log(
    `\nBillingAuthorityApp upserted: id=${row.id} environment=${row.environment}`
  );
}

main()
  .catch((error) => {
    console.error("bootstrap-billing-authority-app failed:", error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
