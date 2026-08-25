/**
 * D2/P7-W2-GATE Step 0 — mechanical proof of the fail-closed platform-admin
 * gate. Pure matrix over assertPlatformAdminAccess (no DB): role + allowlist
 * combinations, with the hardened rule that an empty/missing allowlist denies
 * everyone in every environment (no dev/test bypass). Also asserts that the
 * admin-semantics WhatsApp seed route goes through the canonical guard (no raw
 * role comparison bypassing the allowlist).
 *
 * Run: npx tsx lib/auth/platform-admin.test.ts
 */
import { readFileSync } from "node:fs";
import { UserRole } from "@prisma/client";
import { assertPlatformAdminAccess } from "./platform-admin";
import { ForbiddenError, UnauthorizedError } from "@/lib/errors";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`  [PASS] ${name}`);
  } else {
    fail++;
    console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`);
  }
}

function expectThrows(
  name: string,
  fn: () => void,
  errorClass: new (...args: never[]) => Error
) {
  try {
    fn();
    check(name, false, "no error thrown");
  } catch (e) {
    check(name, e instanceof errorClass, `threw ${String(e)}`);
  }
}

const ADMIN = { role: UserRole.PLATFORM_ADMIN, email: "admin@dubiz.test" };
const OTHER_ADMIN = { role: UserRole.PLATFORM_ADMIN, email: "other@dubiz.test" };
const REGULAR = { role: UserRole.USER, email: "admin@dubiz.test" };

// --- allowlisted admin -> allowed ---
process.env.PLATFORM_ADMIN_EMAILS = "admin@dubiz.test";
try {
  assertPlatformAdminAccess(ADMIN);
  check("allowlisted PLATFORM_ADMIN allowed", true);
} catch (e) {
  check("allowlisted PLATFORM_ADMIN allowed", false, String(e));
}

// --- PLATFORM_ADMIN but not allowlisted -> denied ---
expectThrows(
  "PLATFORM_ADMIN not in allowlist denied",
  () => assertPlatformAdminAccess(OTHER_ADMIN),
  ForbiddenError
);

// --- empty allowlist denies even PLATFORM_ADMIN (in every environment) ---
process.env.PLATFORM_ADMIN_EMAILS = "";
expectThrows(
  "empty allowlist denies PLATFORM_ADMIN (fail closed)",
  () => assertPlatformAdminAccess(ADMIN),
  ForbiddenError
);
delete process.env.PLATFORM_ADMIN_EMAILS;
expectThrows(
  "missing allowlist denies PLATFORM_ADMIN (fail closed)",
  () => assertPlatformAdminAccess(ADMIN),
  ForbiddenError
);

// --- explicit non-production must still deny (no dev bypass) ---
const prevNodeEnv = process.env.NODE_ENV;
(process.env as Record<string, string | undefined>).NODE_ENV = "development";
expectThrows(
  "NODE_ENV=development with empty allowlist still denied (no dev bypass)",
  () => assertPlatformAdminAccess(ADMIN),
  ForbiddenError
);
(process.env as Record<string, string | undefined>).NODE_ENV = prevNodeEnv;

// --- ordinary user denied regardless of allowlist ---
process.env.PLATFORM_ADMIN_EMAILS = "admin@dubiz.test";
expectThrows(
  "ordinary USER role denied",
  () => assertPlatformAdminAccess(REGULAR),
  ForbiddenError
);

// --- missing user -> Unauthorized ---
expectThrows(
  "missing user is Unauthorized",
  () => assertPlatformAdminAccess(null),
  UnauthorizedError
);

// --- WhatsApp seed route must use the canonical guard, not a raw role check ---
const whatsappRoute = readFileSync(
  "app/api/integrations/whatsapp/connection/route.ts",
  "utf8"
);
check(
  "whatsapp seed POST uses requirePlatformAdminOrResponse",
  whatsappRoute.includes("requirePlatformAdminOrResponse")
);
check(
  "whatsapp seed POST has no raw PLATFORM_ADMIN role comparison",
  !/role\s*[!=]==?\s*["']PLATFORM_ADMIN["']/.test(whatsappRoute)
);

// --- the guard module itself must not contain a NODE_ENV escape hatch ---
const guardSource = readFileSync("lib/auth/platform-admin.ts", "utf8");
check(
  "no NODE_ENV-based bypass remains in the guard",
  !guardSource.includes('NODE_ENV !== "production"')
);

console.log(`\nplatform-admin auth matrix: PASS=${pass} FAIL=${fail}`);
if (fail > 0) process.exit(1);
console.log("ALL CHECKS PASS");
