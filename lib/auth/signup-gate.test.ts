/**
 * Public-signup gate semantics (run manually):
 *   npx tsx lib/auth/signup-gate.test.ts
 *
 * Locks the flag contract: CLOSED unless PUBLIC_SIGNUP_ENABLED is exactly
 * "true". Anything else — unset, empty, "TRUE", "1", "yes", "false" — keeps
 * registration closed, so a typo or a missing env var can never re-open public
 * signup by accident.
 */

import {
  SIGNUP_DISABLED_CODE,
  SIGNUP_DISABLED_STATUS,
  getPublicSignupDiagnostics,
  isPublicSignupEnabled,
  signupDisabledBody,
} from "@/lib/auth/signup-gate";

let failed = 0;
function ok(name: string, cond: boolean): void {
  if (cond) {
    console.log(`  ok  - ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL  - ${name}`);
  }
}

function withFlag<T>(value: string | undefined, fn: () => T): T {
  const prev = process.env.PUBLIC_SIGNUP_ENABLED;
  if (value === undefined) delete process.env.PUBLIC_SIGNUP_ENABLED;
  else process.env.PUBLIC_SIGNUP_ENABLED = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.PUBLIC_SIGNUP_ENABLED;
    else process.env.PUBLIC_SIGNUP_ENABLED = prev;
  }
}

function main() {
  ok(
    'unset -> closed (fail-closed default)',
    withFlag(undefined, () => isPublicSignupEnabled()) === false
  );

  for (const bad of ["", " ", "false", "0", "no", "TRUE", "True", "1", "yes", "true "]) {
    ok(
      `${JSON.stringify(bad)} -> closed`,
      withFlag(bad, () => isPublicSignupEnabled()) === false
    );
  }

  ok('"true" -> open', withFlag("true", () => isPublicSignupEnabled()) === true);

  // Diagnostics never leak the reason to the client, but must explain locally.
  const diag = withFlag("nope", () => getPublicSignupDiagnostics());
  ok("diagnostics report disabled", diag.enabled === false);
  ok("diagnostics name the flag", diag.reasonIfDisabled.includes("PUBLIC_SIGNUP_ENABLED"));
  ok("diagnostics echo the raw value", diag.reasonIfDisabled.includes('"nope"'));
  ok(
    "diagnostics ok when enabled",
    withFlag("true", () => getPublicSignupDiagnostics()).reasonIfDisabled === "ok"
  );

  // The blocked response contract: stable code, 403, Hebrew message, no 500.
  const body = signupDisabledBody();
  ok("code is SIGNUP_DISABLED", body.code === SIGNUP_DISABLED_CODE);
  ok("error field carries the same code", body.error === SIGNUP_DISABLED_CODE);
  ok("status is 403, never 500", SIGNUP_DISABLED_STATUS === 403);
  ok("message is Hebrew, user-facing", /[\u0590-\u05FF]/.test(body.message));

  console.log(failed === 0 ? "\nPASS" : `\nFAIL (${failed})`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
