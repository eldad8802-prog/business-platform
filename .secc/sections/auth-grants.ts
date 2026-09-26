/**
 * sec(C) — auth-plane and runtime grant contracts that the shipped migrations must
 * carry on their own (no reliance on out-of-repo default privileges):
 *   - signup (`createAccount`) on the ACTIVE auth plane succeeds with exactly the
 *     migration-granted column privileges (PR #526 finding: INSERT "createdAt");
 *   - the runtime holds NO privilege on PlatformAdminMfa unless a grant ships.
 * Fresh lab, auth identity = NEW LOGIN member of app_auth, NOSUPERUSER NOBYPASSRLS.
 */
import { newLab, dropLab, q } from "../lab.mjs";
import { ok, section, client, sqlError } from "../common";

void section("auth-grants", async () => {
  const lab = await newLab("authgr");
  Object.assign(process.env, {
    DATABASE_URL: lab.rtUrl,
    DIRECT_URL: lab.rtUrl,
    AUTH_PLANE_ENABLED: "true",
    AUTH_DATABASE_URL: lab.authUrl,
    AUTH_TOKEN_SECRET: "secc_ci_synthetic_auth_token_secret_0123456789",
  });
  const { createAccount } = await import("@/lib/auth/signup");
  let res: unknown;
  let err: { code?: string; message?: string } | null = null;
  try {
    res = await createAccount({ email: `signup-${lab.db}@secc.invalid`, passwordHash: "$2a$04$x", name: "Lab", businessName: "Lab biz" } as never);
  } catch (e) {
    err = { code: (e as { code?: string }).code, message: String((e as Error).message).split("\n").slice(-2).join(" ") };
  }
  ok("AUTH signup on the active auth plane succeeds with the migration-shipped grants", err === null && !!res, err);
  const u = q(lab.ownerUrl, `SELECT count(*) FROM "User" WHERE email = 'signup-${lab.db}@secc.invalid'`);
  ok("AUTH signup wrote exactly one User", u === "1", u);

  const rt = client(lab.rtUrl);
  const mfa = await sqlError(rt.$queryRawUnsafe(`SELECT count(*) FROM "PlatformAdminMfa"`));
  ok("RUNTIME holds no SELECT on PlatformAdminMfa from the shipped migrations/grants (42501)", mfa?.code === "42501", mfa);
  const auth = client(lab.authUrl);
  const authMfa = await sqlError(auth.$queryRawUnsafe(`SELECT count(*) FROM "PlatformAdminMfa"`));
  ok("AUTH plane may read/write PlatformAdminMfa (T-04 target identity, shipped by migration)", authMfa === null, authMfa);
  await auth.$disconnect();
  await rt.$disconnect();
  dropLab(lab);
});
