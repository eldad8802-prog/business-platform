/**
 * Authority token crypto (run manually):
 *   npx tsx lib/services/billing/authority/billing-authority-token-crypto.service.test.ts
 */
import { randomBytes } from "node:crypto";
import { BillingAuthorityEnvironment } from "@prisma/client";
import {
  BillingAuthorityTokenCryptoConfigError,
  decryptAuthorityAppSecret,
  decryptAuthorityConnectionToken,
  encryptAuthorityAppSecret,
  encryptAuthorityConnectionToken,
} from "@/lib/services/billing/authority/billing-authority-token-crypto.service";

const ENV_KEY_NAME = "BILLING_AUTHORITY_ENCRYPTION_KEY";
const TEST_KEY = randomBytes(32).toString("base64");
const ALT_KEY = randomBytes(32).toString("base64");

const originalEnv = process.env[ENV_KEY_NAME];

let failed = 0;

function ok(name: string, condition: boolean) {
  if (!condition) {
    console.error("FAIL:", name);
    failed += 1;
    return;
  }
  console.log("OK:", name);
}

function withKey(key: string | undefined, fn: () => void) {
  if (key === undefined) {
    delete process.env[ENV_KEY_NAME];
  } else {
    process.env[ENV_KEY_NAME] = key;
  }
  try {
    fn();
  } finally {
    if (originalEnv === undefined) {
      delete process.env[ENV_KEY_NAME];
    } else {
      process.env[ENV_KEY_NAME] = originalEnv;
    }
  }
}

function expectConfigError(name: string, fn: () => unknown) {
  try {
    fn();
    console.error("FAIL:", name, "(expected BillingAuthorityTokenCryptoConfigError)");
    failed += 1;
  } catch (error) {
    ok(name, error instanceof BillingAuthorityTokenCryptoConfigError);
  }
}

withKey(TEST_KEY, () => {
  const appSecret = "authority-client-secret-value";
  const sandboxStored = encryptAuthorityAppSecret(
    appSecret,
    BillingAuthorityEnvironment.SANDBOX
  );
  const productionStored = encryptAuthorityAppSecret(
    appSecret,
    BillingAuthorityEnvironment.PRODUCTION
  );

  ok(
    "app secret roundtrip SANDBOX",
    decryptAuthorityAppSecret(sandboxStored, BillingAuthorityEnvironment.SANDBOX) ===
      appSecret
  );
  ok(
    "app secret roundtrip PRODUCTION",
    decryptAuthorityAppSecret(
      productionStored,
      BillingAuthorityEnvironment.PRODUCTION
    ) === appSecret
  );
  ok(
    "app secret AAD mismatch across environments",
    decryptAuthorityAppSecret(sandboxStored, BillingAuthorityEnvironment.PRODUCTION) ===
      null
  );

  const accessToken = "sandbox-access-token-value";
  const refreshToken = "sandbox-refresh-token-value";
  const connectionStoredAccess = encryptAuthorityConnectionToken(
    accessToken,
    42,
    BillingAuthorityEnvironment.SANDBOX
  );
  const connectionStoredRefresh = encryptAuthorityConnectionToken(
    refreshToken,
    42,
    BillingAuthorityEnvironment.SANDBOX
  );

  ok(
    "connection token roundtrip access token",
    decryptAuthorityConnectionToken(
      connectionStoredAccess,
      42,
      BillingAuthorityEnvironment.SANDBOX
    ) === accessToken
  );
  ok(
    "connection token roundtrip refresh token",
    decryptAuthorityConnectionToken(
      connectionStoredRefresh,
      42,
      BillingAuthorityEnvironment.SANDBOX
    ) === refreshToken
  );
  ok(
    "connection token AAD mismatch wrong businessId",
    decryptAuthorityConnectionToken(
      connectionStoredAccess,
      99,
      BillingAuthorityEnvironment.SANDBOX
    ) === null
  );
  ok(
    "connection token AAD mismatch wrong environment",
    decryptAuthorityConnectionToken(
      connectionStoredAccess,
      42,
      BillingAuthorityEnvironment.PRODUCTION
    ) === null
  );
  ok(
    "SANDBOX and PRODUCTION ciphertexts are isolated",
    decryptAuthorityConnectionToken(
      encryptAuthorityConnectionToken(
        accessToken,
        42,
        BillingAuthorityEnvironment.SANDBOX
      ),
      42,
      BillingAuthorityEnvironment.PRODUCTION
    ) === null
  );

  const corruptEncrypted = {
    ...connectionStoredAccess,
    encrypted: connectionStoredAccess.encrypted.slice(0, -2) + "AA",
  };
  ok(
    "corrupt ciphertext returns null",
    decryptAuthorityConnectionToken(
      corruptEncrypted,
      42,
      BillingAuthorityEnvironment.SANDBOX
    ) === null
  );

  const corruptIv = {
    ...connectionStoredAccess,
    iv: Buffer.from("short").toString("base64"),
  };
  ok(
    "invalid iv length returns null",
    decryptAuthorityConnectionToken(
      corruptIv,
      42,
      BillingAuthorityEnvironment.SANDBOX
    ) === null
  );
});

withKey(TEST_KEY, () => {
  const stored = encryptAuthorityConnectionToken(
    "token-for-wrong-key-test",
    7,
    BillingAuthorityEnvironment.PRODUCTION
  );

  withKey(ALT_KEY, () => {
    ok(
      "wrong encryption key returns null on decrypt",
      decryptAuthorityConnectionToken(
        stored,
        7,
        BillingAuthorityEnvironment.PRODUCTION
      ) === null
    );
  });
});

withKey(undefined, () => {
  expectConfigError("missing env key throws on encrypt app secret", () =>
    encryptAuthorityAppSecret("secret", BillingAuthorityEnvironment.SANDBOX)
  );
  expectConfigError("missing env key throws on encrypt connection token", () =>
    encryptAuthorityConnectionToken(
      "token",
      1,
      BillingAuthorityEnvironment.SANDBOX
    )
  );
});

withKey("too-short", () => {
  expectConfigError("invalid key length throws on encrypt", () =>
    encryptAuthorityAppSecret("secret", BillingAuthorityEnvironment.SANDBOX)
  );
});

if (failed > 0) {
  console.error(`\n${failed} test(s) failed.`);
  process.exit(1);
}

console.log("\nAll authority token crypto tests passed.");
