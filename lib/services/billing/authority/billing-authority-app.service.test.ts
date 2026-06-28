/**
 * Authority app loader (run manually):
 *   npx tsx lib/services/billing/authority/billing-authority-app.service.test.ts
 */
import {
  BillingAuthorityAppStatus,
  BillingAuthorityEnvironment,
} from "@prisma/client";
import { ServiceUnavailableError } from "@/lib/errors";
import {
  assertActiveAuthorityApp,
  toAuthorityAppContext,
} from "@/lib/services/billing/authority/billing-authority-app.service";

let failed = 0;

function ok(name: string, condition: boolean) {
  if (!condition) {
    console.error("FAIL:", name);
    failed += 1;
    return;
  }
  console.log("OK:", name);
}

function expectServiceUnavailable(name: string, fn: () => unknown) {
  try {
    fn();
    console.error("FAIL:", name, "(expected ServiceUnavailableError)");
    failed += 1;
  } catch (error) {
    ok(name, error instanceof ServiceUnavailableError);
  }
}

const registeredAt = new Date("2026-06-01T12:00:00.000Z");

const activeRow = {
  id: 1,
  environment: BillingAuthorityEnvironment.SANDBOX,
  status: BillingAuthorityAppStatus.ACTIVE,
  accountingSoftwareNumber: "12345678",
  itaClientId: "sandbox-client-id",
  clientSecretEncrypted: "cipher",
  clientSecretIv: "iv",
  clientSecretTag: "tag",
  encryptionKeyId: "authority_gcm_v1",
  portalOrganizationId: "org-1",
  portalApplicationId: "app-1",
  registeredAt,
  lastValidatedAt: null,
  lastErrorCode: null,
  lastErrorMessage: null,
  createdAt: registeredAt,
  updatedAt: registeredAt,
};

const context = toAuthorityAppContext(assertActiveAuthorityApp(activeRow));

ok("active app context exposes client id", context.itaClientId === "sandbox-client-id");
ok(
  "active app context does not include secret columns",
  !("clientSecretEncrypted" in context) &&
    !("clientSecretIv" in context) &&
    !("clientSecretTag" in context)
);
ok(
  "active app context preserves portal metadata",
  context.portalOrganizationId === "org-1" &&
    context.portalApplicationId === "app-1"
);

expectServiceUnavailable("missing app row is blocked", () =>
  assertActiveAuthorityApp(null)
);

expectServiceUnavailable("disabled app is blocked", () =>
  assertActiveAuthorityApp({
    ...activeRow,
    status: BillingAuthorityAppStatus.DISABLED,
  })
);

expectServiceUnavailable("missing client id is blocked", () =>
  assertActiveAuthorityApp({
    ...activeRow,
    itaClientId: null,
  })
);

expectServiceUnavailable("blank client id is blocked", () =>
  assertActiveAuthorityApp({
    ...activeRow,
    itaClientId: "   ",
  })
);

expectServiceUnavailable("missing encrypted secret is blocked", () =>
  assertActiveAuthorityApp({
    ...activeRow,
    clientSecretEncrypted: null,
  })
);

if (failed > 0) {
  console.error(`\n${failed} test(s) failed.`);
  process.exit(1);
}

console.log("\nAll authority app service tests passed.");
