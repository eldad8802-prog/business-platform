/**
 * Tests for the hardened BillingAuthorityApp bootstrap.
 *   npx tsx scripts/bootstrap-billing-authority-app.test.ts
 *
 * No Production DB connection: prisma is injected as a fake. Verifies env
 * fallbacks, CLI precedence, masking, secret non-exposure, and dry-run vs apply
 * write behavior.
 */

import { BillingAuthorityEnvironment } from "@prisma/client";
import {
  buildDryRunSummary,
  maskTail,
  resolveBootstrapInputs,
  runBootstrap,
  type BootstrapPrisma,
} from "./bootstrap-billing-authority-app";

let failed = 0;
function ok(name: string, cond: boolean): void {
  if (cond) console.log(`  ok  - ${name}`);
  else {
    failed += 1;
    console.error(`FAIL  - ${name}`);
  }
}

// 32-byte hex test key (all zeros) — not a real secret.
const TEST_ENV = {
  BILLING_AUTHORITY_ENCRYPTION_KEY: "0".repeat(64),
} as NodeJS.ProcessEnv;

const SECRET = "SUPER-SECRET-DO-NOT-LEAK";
const CLIENT_ID = "client-abcd1234WXYZ";
const ASN = "998877665544";

function fakePrisma(existing: { id: number } | null) {
  const calls = { find: 0, upsert: 0 };
  const prisma: BootstrapPrisma = {
    billingAuthorityApp: {
      async findUnique() {
        calls.find += 1;
        return existing;
      },
      async upsert(args) {
        calls.upsert += 1;
        return { id: 1, environment: args.where.environment! };
      },
    },
  };
  return { prisma, calls };
}

async function main() {
  // ---- maskTail ------------------------------------------------------------
  ok("maskTail masks to ***last4", maskTail("abcdef1234") === "***1234");
  ok("maskTail empty -> empty", maskTail("") === "" && maskTail(undefined) === "");
  ok("maskTail never reveals head", !maskTail("client-abcd1234WXYZ").includes("client"));

  // ---- resolveBootstrapInputs ---------------------------------------------
  {
    const env = {
      ...TEST_ENV,
      BILLING_AUTHORITY_ACCOUNTING_SOFTWARE_NUMBER: ASN,
      BILLING_AUTHORITY_ITA_CLIENT_ID: CLIENT_ID,
      BILLING_AUTHORITY_CLIENT_SECRET: SECRET,
    } as NodeJS.ProcessEnv;
    const r = resolveBootstrapInputs(["--environment", "PRODUCTION"], env);
    ok("ASN read from env", r.ok && r.inputs.accountingSoftwareNumber === ASN);
    ok("client id read from env", r.ok && r.inputs.itaClientId === CLIENT_ID);
    ok("secret read from env", r.ok && r.inputs.clientSecret === SECRET);
    ok("environment parsed PRODUCTION", r.ok && r.inputs.environment === BillingAuthorityEnvironment.PRODUCTION);
  }
  {
    // CLI takes precedence over env for accounting number.
    const env = {
      ...TEST_ENV,
      BILLING_AUTHORITY_ACCOUNTING_SOFTWARE_NUMBER: "1111",
      BILLING_AUTHORITY_ITA_CLIENT_ID: CLIENT_ID,
      BILLING_AUTHORITY_CLIENT_SECRET: SECRET,
    } as NodeJS.ProcessEnv;
    const r = resolveBootstrapInputs(
      ["--environment", "PRODUCTION", "--accounting-software-number", "2222"],
      env
    );
    ok("CLI overrides env for ASN", r.ok && r.inputs.accountingSoftwareNumber === "2222");
  }
  {
    const env = {
      ...TEST_ENV,
      BILLING_AUTHORITY_ITA_CLIENT_ID: CLIENT_ID,
      BILLING_AUTHORITY_CLIENT_SECRET: SECRET,
    } as NodeJS.ProcessEnv; // no ASN anywhere
    const r = resolveBootstrapInputs(["--environment", "PRODUCTION"], env);
    ok("missing ASN -> error", !r.ok && r.errorField === "accountingSoftwareNumber");
  }
  {
    const r = resolveBootstrapInputs(["--environment", "MARS"], TEST_ENV);
    ok("bad environment -> error", !r.ok && r.errorField === "--environment");
  }

  // ---- masking in dry-run summary -----------------------------------------
  {
    const env = {
      ...TEST_ENV,
      BILLING_AUTHORITY_ACCOUNTING_SOFTWARE_NUMBER: ASN,
      BILLING_AUTHORITY_ITA_CLIENT_ID: CLIENT_ID,
      BILLING_AUTHORITY_CLIENT_SECRET: SECRET,
    } as NodeJS.ProcessEnv;
    const r = resolveBootstrapInputs(["--environment", "PRODUCTION"], env);
    if (r.ok) {
      const s = buildDryRunSummary(r.inputs);
      ok("client id masked", s.itaClientIdMasked === maskTail(CLIENT_ID) && s.itaClientIdMasked === "***WXYZ");
      ok("ASN masked", s.accountingSoftwareNumberMasked === "***5544");
      const serialized = JSON.stringify(s);
      ok("dry-run summary has no full client id", !serialized.includes(CLIENT_ID));
      ok("dry-run summary has no full ASN", !serialized.includes(ASN));
      ok("dry-run summary has no secret", !serialized.includes(SECRET));
      ok("dry-run databaseWritePerformed false", s.databaseWritePerformed === false);
    } else ok("resolve ok for summary", false);
  }

  // ---- runBootstrap: dry-run does NOT touch the DB ------------------------
  {
    const env = {
      ...TEST_ENV,
      BILLING_AUTHORITY_ACCOUNTING_SOFTWARE_NUMBER: ASN,
      BILLING_AUTHORITY_ITA_CLIENT_ID: CLIENT_ID,
      BILLING_AUTHORITY_CLIENT_SECRET: SECRET,
    } as NodeJS.ProcessEnv;
    const { prisma, calls } = fakePrisma(null);
    const lines: string[] = [];
    const res = await runBootstrap({
      argv: ["--environment", "PRODUCTION"],
      env,
      prisma,
      log: (l) => lines.push(l),
    });
    ok("dry-run result", res.ok && res.mode === "dry-run");
    ok("dry-run performs NO findUnique", calls.find === 0);
    ok("dry-run performs NO upsert", calls.upsert === 0);
    ok("dry-run output never contains secret", !lines.join("\n").includes(SECRET));
  }

  // ---- runBootstrap: apply upserts exactly once (created) -----------------
  {
    const env = {
      ...TEST_ENV,
      BILLING_AUTHORITY_ACCOUNTING_SOFTWARE_NUMBER: ASN,
      BILLING_AUTHORITY_ITA_CLIENT_ID: CLIENT_ID,
      BILLING_AUTHORITY_CLIENT_SECRET: SECRET,
    } as NodeJS.ProcessEnv;
    const { prisma, calls } = fakePrisma(null); // no existing row
    const lines: string[] = [];
    const res = await runBootstrap({
      argv: ["--environment", "PRODUCTION", "--apply"],
      env,
      prisma,
      log: (l) => lines.push(l),
    });
    ok("apply result created", res.ok && res.mode === "apply" && res.operation === "created");
    ok("apply upserts exactly once", calls.upsert === 1);
    ok("apply reads existence once", calls.find === 1);
    const out = lines.join("\n");
    ok("apply output has databaseWritePerformed true", out.includes('"databaseWritePerformed": true'));
    ok("apply output never contains secret", !out.includes(SECRET));
    ok("apply output never contains full client id", !out.includes(CLIENT_ID));
    ok("apply output never contains full ASN", !out.includes(ASN));
  }

  // ---- runBootstrap: apply on existing row -> updated ---------------------
  {
    const env = {
      ...TEST_ENV,
      BILLING_AUTHORITY_ACCOUNTING_SOFTWARE_NUMBER: ASN,
      BILLING_AUTHORITY_ITA_CLIENT_ID: CLIENT_ID,
      BILLING_AUTHORITY_CLIENT_SECRET: SECRET,
    } as NodeJS.ProcessEnv;
    const { prisma, calls } = fakePrisma({ id: 7 }); // existing row
    const res = await runBootstrap({
      argv: ["--environment", "PRODUCTION", "--apply"],
      env,
      prisma,
      log: () => {},
    });
    ok("apply result updated", res.ok && res.mode === "apply" && res.operation === "updated");
    ok("apply (existing) upserts exactly once", calls.upsert === 1);
  }

  console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
