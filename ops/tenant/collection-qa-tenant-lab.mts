/**
 * The Collection QA tenant provisioning, rehearsed end to end on a throwaway
 * PostgreSQL — the same SQL file Production will run, twice, followed by the
 * real login route.
 *
 * WHY A REHEARSAL AND NOT A REVIEW
 *
 * Everything else about this change can be argued from reading: the guard reads
 * the SQL, the schema contract reads the models. None of that proves the
 * statement runs, that the second run is a no-op rather than a second tenant,
 * or that the account it leaves behind can actually log in. Those are claims
 * about behaviour, and the account is written by hand — there is no service
 * layer to catch a mistake, and no way to repair one without another Production
 * write. So it is rehearsed against a real database first.
 *
 *   L1  the provisioning transaction creates exactly one Business + one User
 *   L2  every column matches what registration would have produced
 *   L3  a second, identical run inserts nothing — one tenant, not two
 *   L4  a run after the business name alone exists still creates nothing
 *   L5  the verification query reports the tenant and never the hash
 *   L6  the resulting account logs in through the REAL login route
 *   L7  the session it gets is an ordinary one: token, generation, refresh row
 *   L8  tenant data written as this business is invisible to another tenant
 *
 * Synthetic only. No secrets, no Neon, no network. The password here is a
 * literal in a lab database that is destroyed with the job.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { PrismaClient } from "@prisma/client";
import bcrypt from "bcrypt";

import * as loginRoute from "../../app/api/auth/login/route";
import { BCRYPT_COST_10_SHAPE } from "../../scripts/ci/collection-qa-tenant-hash-shape.mjs";

const prisma = new PrismaClient();

/**
 * The identity is READ from the file Production will use, not restated here.
 * A rehearsal against constants of its own would keep passing while the
 * committed identity said something else — which is the one thing this file
 * exists to catch.
 */
function identity(): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of readFileSync(
    "ops/tenant/collection-qa-tenant.identity.env",
    "utf8"
  ).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    values[trimmed.slice(0, eq).trim()] = trimmed
      .slice(eq + 1)
      .replace(/^"([\s\S]*)"$/, "$1");
  }
  return values;
}

const ID = identity();
const EMAIL = ID.COLLECTION_QA_EMAIL;
const BUSINESS_NAME = ID.COLLECTION_QA_BUSINESS_NAME;
const USER_NAME = ID.COLLECTION_QA_USER_NAME;
/** Lab-only, and a literal on purpose: this database is destroyed with the job. */
const PASSWORD = "lab-only-qa-collection-password";

let pass = 0;
const failures: string[] = [];

function ok(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`  [PASS] ${name}`);
  } else {
    failures.push(name);
    console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`);
  }
}

/**
 * Runs a file exactly the way the production workflow does: the variables are
 * piped in as psql \set commands ahead of the file, never interpolated into the
 * SQL text and never passed as arguments.
 *
 * Production has a security reason for that — an argument is visible in the
 * process list, and one of these variables is a credential. There is a second
 * reason, found here: psql on Windows receives its arguments in the console
 * code page, so `--set=qa_business_name=<Hebrew>` arrives as bytes the server
 * rejects as an invalid multibyte character. Feeding UTF-8 through stdin is
 * both the safer mechanism and the portable one, and it means this rehearsal
 * exercises the same path Production will.
 */
function psql(
  file: string,
  hash: string,
  ids: { userId?: number; businessId?: number } = {}
): string {
  const preamble = [
    `\\set qa_email '${EMAIL}'`,
    `\\set qa_business_name '${BUSINESS_NAME}'`,
    `\\set qa_user_name '${USER_NAME}'`,
    `\\set qa_password_hash '${hash}'`,
    // The repair statement pins its target by id. Production binds the ids the
    // identity file records; the lab binds the ids this lab actually created,
    // which is the same statement proving the same thing against real rows.
    `\\set qa_user_id ${ids.userId ?? 0}`,
    `\\set qa_business_id ${ids.businessId ?? 0}`,
    "",
  ].join("\n");

  return execFileSync(
    "psql",
    [process.env.DATABASE_URL!, "--no-psqlrc", "--set=ON_ERROR_STOP=1", "-f", "-"],
    {
      encoding: "utf8",
      input: Buffer.from(preamble + readFileSync(file, "utf8"), "utf8"),
      env: { ...process.env, PGCLIENTENCODING: "UTF8" },
    }
  );
}

async function main() {
  const hash = await bcrypt.hash(PASSWORD, 10);
  ok("lab fixture hash has the shape the workflow enforces", BCRYPT_COST_10_SHAPE.test(hash));

  // --- L1/L2: the first run ------------------------------------------------
  const first = psql("ops/tenant/collection-qa-tenant.sql", hash);
  ok("L1 first run reports one business inserted", /\s1\s*\|\s*1\s*\|\s*0/.test(first), first.trim());

  const business = await prisma.business.findFirst({ where: { name: BUSINESS_NAME } });
  const user = await prisma.user.findUnique({ where: { email: EMAIL } });

  ok("L1 the business exists", business !== null);
  ok("L1 the user exists", user !== null);
  if (!business || !user) {
    report();
    return;
  }

  ok("L1 the user belongs to the business", user.businessId === business.id);
  ok("L2 role is the default USER", user.role === "USER");
  ok("L2 tokenVersion starts at 0", user.tokenVersion === 0);
  ok("L2 loginCount starts at 0", user.loginCount === 0);
  ok("L2 the account has never logged in", user.lastLoginAt === null);
  ok("L2 the display name is the approved one", user.name === USER_NAME);
  ok("L2 the stored credential is the hash, not the password", user.password === hash);
  ok("L2 createdAt and updatedAt were both written", Boolean(user.createdAt && user.updatedAt));
  ok("L2 the business is live, not archived or deleted",
    business.archivedAt === null && business.deletedAt === null);
  ok("L2 the tenant starts with no payment connection",
    (await prisma.businessPaymentConnection.count({ where: { businessId: business.id } })) === 0);
  ok("L2 the tenant starts with no billing identity",
    (await prisma.businessProfile.count({ where: { businessId: business.id } })) === 0);

  // --- L3: idempotency -----------------------------------------------------
  const second = psql("ops/tenant/collection-qa-tenant.sql", hash);
  ok("L3 second run reports nothing inserted", /\s0\s*\|\s*0\s*\|\s*1/.test(second), second.trim());
  ok("L3 still exactly one business",
    (await prisma.business.count({ where: { name: BUSINESS_NAME } })) === 1);
  ok("L3 still exactly one user",
    (await prisma.user.count({ where: { email: EMAIL } })) === 1);
  ok("L3 the second run did not touch the first row",
    (await prisma.user.findUnique({ where: { email: EMAIL } }))?.id === user.id);

  // --- L5: verification output --------------------------------------------
  const verify = psql("ops/tenant/collection-qa-tenant-verify.sql", hash);
  ok("L5 verification reports one user and one business", /\s1\s*\|\s*1\s*\|/.test(verify));
  ok("L5 verification confirms bcrypt cost 10", /\|\s*t\s*\|\s*60\s*\|/.test(verify), verify.trim());
  ok("L5 verification never prints the hash", !verify.includes(hash));
  ok("L5 verification never prints the password", !verify.includes(PASSWORD));

  // --- L6/L7: the real login route -----------------------------------------
  const response = await loginRoute.POST(
    new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    })
  );
  const body = (await response.json()) as Record<string, unknown>;

  ok("L6 login succeeds", response.status === 200, `status ${response.status}`);
  ok("L6 login returns this tenant", (body.user as { businessId?: number })?.businessId === business.id);
  ok("L6 login returns the business name", (body.user as { businessName?: string })?.businessName === BUSINESS_NAME);
  ok("L7 login mints an access token", typeof body.token === "string" && (body.token as string).length > 0);
  ok("L7 login sets a refresh cookie", (response.headers.get("set-cookie") ?? "").length > 0);
  ok("L7 a refresh session row exists",
    (await prisma.authSession.count({ where: { userId: user.id } })) === 1);

  const afterLogin = await prisma.user.findUnique({ where: { email: EMAIL } });
  ok("L7 the login stamp was recorded", afterLogin?.loginCount === 1 && afterLogin?.lastLoginAt !== null);
  ok("L7 the generation is unchanged by logging in", afterLogin?.tokenVersion === 0);

  const wrong = await loginRoute.POST(
    new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password: `${PASSWORD}-wrong` }),
    })
  );
  ok("L6 a wrong password is refused", wrong.status === 401);

  // --- L8: ordinary tenant isolation ---------------------------------------
  // The lab role owns the schema and is not subject to RLS, so this proves the
  // shape of the data rather than the enforcement: every row the QA tenant
  // writes carries its own businessId, which is the column every tenant policy
  // keys on. The enforcement itself is proven for all tenants by the D2/P7
  // programme, and applies to this business with nothing to configure.
  const other = await prisma.business.create({ data: { name: `lab-other-${Date.now()}` } });
  const qaCustomer = await prisma.customer.create({
    data: { businessId: business.id, name: "QA payer", phone: "0500000001" },
  });
  ok("L8 the QA tenant's row carries its own businessId", qaCustomer.businessId === business.id);
  ok("L8 it is not visible under another tenant's id",
    (await prisma.customer.count({ where: { businessId: other.id } })) === 0);

  // --- R: the password repair, on the row this lab just created ------------
  //
  // The repair exists because a credential can be written that the login FORM
  // can never submit. So the proof is not "the UPDATE ran": it is that the new
  // password logs in through the real route, the old one stops working, and
  // nothing else about the account — or about anyone else's account — moved.
  const bystander = await prisma.business.create({ data: { name: `lab-bystander-${Date.now()}` } });
  const bystanderUser = await prisma.user.create({
    data: {
      email: `lab-bystander-${Date.now()}@example.test`,
      password: await bcrypt.hash("bystander-password", 10),
      name: "Bystander",
      businessId: bystander.id,
    },
  });

  const NEW_PASSWORD = "lab-only-repaired-qa-password";
  const newHash = await bcrypt.hash(NEW_PASSWORD, 10);
  ok("R0 the replacement hash has the shape the workflow enforces", BCRYPT_COST_10_SHAPE.test(newHash));

  const repair = psql("ops/tenant/collection-qa-tenant-password.sql", newHash, {
    userId: user.id,
    businessId: business.id,
  });
  ok("R1 the repair reports exactly one updated row", /UPDATE 1/.test(repair), repair.trim());
  ok("R1 the repair returns the row it changed", /REPAIR/.test(repair));

  const repaired = await prisma.user.findUnique({ where: { email: EMAIL } });
  ok("R2 the stored credential is the new hash", repaired?.password === newHash);
  ok("R2 role is unchanged", repaired?.role === "USER");
  ok("R2 token generation is unchanged", repaired?.tokenVersion === 0);
  ok("R2 display name is unchanged", repaired?.name === USER_NAME);
  ok("R2 the tenant link is unchanged", repaired?.businessId === business.id);
  ok(
    "R2 no other account's credential moved",
    (await prisma.user.findUnique({ where: { id: bystanderUser.id } }))?.password ===
      bystanderUser.password
  );
  ok(
    "R2 the business row is untouched",
    (await prisma.business.findUnique({ where: { id: business.id } }))?.name === BUSINESS_NAME
  );

  const oldLogin = await loginRoute.POST(
    new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    })
  );
  ok("R3 the replaced password no longer logs in", oldLogin.status === 401, `status ${oldLogin.status}`);

  const newLogin = await loginRoute.POST(
    new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password: NEW_PASSWORD }),
    })
  );
  const newBody = (await newLogin.json()) as Record<string, unknown>;
  ok("R4 the new password logs in through the real route", newLogin.status === 200, `status ${newLogin.status}`);
  ok("R4 it resolves to this tenant", (newBody.user as { businessId?: number })?.businessId === business.id);
  ok("R4 it mints a token", typeof newBody.token === "string" && (newBody.token as string).length > 0);
  // The whole point of the repair: a password the FORM can submit. The form
  // disables its button while `password.trim()` is empty, which is what the
  // byte-order-mark credential fell foul of.
  ok("R4 the new password survives the form's own precondition", NEW_PASSWORD.trim().length > 0);

  // --- L4: the half-state, tested against the REAL name --------------------
  // Last, because it is destructive to the lab fixture. The dangerous state is
  // a business carrying the approved name with no user attached to it: a
  // careless idempotency guard would "helpfully" create a second owner on a
  // tenant this run did not create, or a second business alongside it. The
  // statement must do neither — it must insert nothing at all and let a human
  // look at why the halves disagree.
  //
  // Deleting the user is a LAB manipulation. Production never deletes this
  // tenant; the point is only to reach the state cheaply.
  await prisma.authSession.deleteMany({ where: { userId: user.id } });
  await prisma.user.delete({ where: { id: user.id } });
  ok("L4 lab fixture reduced to a business with no user",
    (await prisma.user.count({ where: { email: EMAIL } })) === 0 &&
      (await prisma.business.count({ where: { name: BUSINESS_NAME } })) === 1);

  const fourth = psql("ops/tenant/collection-qa-tenant.sql", hash);
  ok("L4 a run against the name-only half-state inserts nothing",
    /\s0\s*\|\s*0\s*\|\s*0/.test(fourth), fourth.trim());
  ok("L4 no second business was created",
    (await prisma.business.count({ where: { name: BUSINESS_NAME } })) === 1);
  ok("L4 no user was attached to the existing business",
    (await prisma.user.count({ where: { businessId: business.id } })) === 0);

  report();
}

function report() {
  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    for (const f of failures) console.log(`  - ${f}`);
    console.log("COLLECTION QA TENANT LAB: FAIL");
    process.exit(1);
  }
  console.log("COLLECTION QA TENANT LAB: PASS");
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
