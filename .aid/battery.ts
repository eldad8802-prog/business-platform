/**
 * Issuer-declaration link battery — migration 20261126090000_auth_issuer_declaration_link against the real
 * Production role topology (.agl/lab.sh <db> --with-issuer): the definer functions driven as the roles that
 * will call them in Production.
 *
 *   OWNER_URL    lab_owner (fixtures and read-back only)
 *   AUTH_URL     te_auth_login, a LOGIN member of app_auth — issues the link
 *   RUNTIME_URL  app_runtime_prod, a LOGIN member of app_runtime — spends it inside a tenant transaction
 *
 *   T4  issue: only for the account's own business, never a business in deletion; 30 minutes; the digest is
 *       stored; at most 3 per account and hour; a new one closes the earlier open ones; the existing
 *       auth_email_token_check reads its status.
 *   T5  consume: CONFIRMED once, then USED; refused (INVALID) for another account, another business's tenant
 *       transaction, no tenant context, a changed address, a business in deletion, a token of another purpose,
 *       a wrong secret; EXPIRED; SUPERSEDED; BINDING_MISMATCH leaves the link unspent; a transaction that fails
 *       after the consume rolls it back (the link stays unspent); ten concurrent consumes → exactly one.
 *   T6  an account without a password (Google-only) issues and consumes like any other.
 *   T7  privileges: app_runtime cannot issue, app_auth cannot consume, PUBLIC neither; app_runtime still
 *       cannot read the new column; app_auth still holds nothing on the table.
 *
 * Synthetic only. ZERO secrets. ZERO network.
 *   OWNER_URL=… AUTH_URL=… RUNTIME_URL=… npx tsx .aid/battery.ts
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { PrismaClient, type Prisma } from "@prisma/client";

const withPool = (url: string, n: number) => `${url}${url.includes("?") ? "&" : "?"}connection_limit=${n}&pool_timeout=60`;
const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });
const auth = new PrismaClient({ datasourceUrl: process.env.AUTH_URL! });
const runtime = new PrismaClient({ datasourceUrl: process.env.RUNTIME_URL! });
const runtimePool = new PrismaClient({ datasourceUrl: withPool(process.env.RUNTIME_URL!, 12) });

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { failures.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}
type Rows = Record<string, unknown>[];
type Tx = Prisma.TransactionClient;
const TX_OPTS = { timeout: 60_000, maxWait: 60_000 };
const DENIED = /permission denied|42501/i;

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const newSecret = () => randomBytes(32).toString("base64url");
const digest = (label: string) => sha(`declaration:${label}:${randomUUID()}`);
let seq = 0;

type Account = { userId: number; businessId: number; email: string };
async function account(tag: string, opts: { password?: boolean; deleting?: boolean } = {}): Promise<Account> {
  const b = (await owner.$queryRawUnsafe(
    `INSERT INTO "Business" ("name","updatedAt","deletionRequestedAt") VALUES ($1, now(), $2) RETURNING id`,
    `aid-biz-${tag}-${++seq}`, opts.deleting ? new Date() : null)) as Rows;
  const businessId = Number(b[0].id);
  const email = `aid-${tag}-${Date.now()}-${++seq}@lab.invalid`;
  const u = (await owner.$queryRawUnsafe(
    `INSERT INTO "User" ("email","password","name","businessId","updatedAt") VALUES ($1,$2,'דנה',$3, now()) RETURNING id`,
    email, opts.password === false ? null : "$2b$10$" + "A".repeat(53), businessId)) as Rows;
  return { userId: Number(u[0].id), businessId, email };
}

type Link = { tokenId: string; secret: string; binding: string };
async function issue(a: Account, businessId = a.businessId, binding = digest("x")): Promise<Link | null | string> {
  const tokenId = randomUUID();
  const secret = newSecret();
  try {
    const r = (await auth.$queryRawUnsafe(
      `SELECT token_id, business_id, email, expires_at FROM public.auth_issuer_declaration_issue($1::int, $2::int, $3, $4::uuid, $5)`,
      a.userId, businessId, binding, tokenId, sha(secret))) as Rows;
    return r.length === 1 ? { tokenId, secret, binding } : null;
  } catch (e) {
    return (e as Error).message;
  }
}

/** Spend inside a tenant transaction of `ctx` (null = no tenant context); `after` runs in the same tx. */
async function consume(l: Link, userId: number, ctx: number | null, binding = l.binding, after?: (tx: Tx) => Promise<void>, client = runtime): Promise<string> {
  return client.$transaction(async (tx) => {
    if (ctx !== null) await tx.$executeRawUnsafe(`SELECT set_config('app.current_business_id', $1, true)`, String(ctx));
    const r = (await tx.$queryRawUnsafe(
      `SELECT public.auth_issuer_declaration_consume($1::uuid, $2, $3::int, $4) AS s`, l.tokenId, l.secret, userId, binding)) as Rows;
    if (after) await after(tx);
    return String(r[0].s);
  }, TX_OPTS).catch((e: Error) => `ERROR: ${e.message}`);
}
const tokenRow = async (id: string) =>
  ((await owner.$queryRawUnsafe(
    `SELECT "consumedAt", "invalidatedAt", "expiresAt", "createdAt", "bindingSha256", "purpose" FROM "AuthEmailToken" WHERE id = $1::uuid`, id)) as Rows)[0];
const check = async (l: Link) =>
  String(((await auth.$queryRawUnsafe(`SELECT public.auth_email_token_check($1::uuid, $2, 'ISSUER_DECLARATION') AS s`, l.tokenId, l.secret)) as Rows)[0].s);

async function main() {
  console.log("── T4 issue ──");
  const A = await account("a");
  const B = await account("b");
  const bindA = digest("A");
  const lA = await issue(A, A.businessId, bindA);
  ok("app_auth issues a link for the account's own business", typeof lA === "object" && lA !== null, String(lA));
  const link = lA as Link;
  const row = await tokenRow(link.tokenId);
  ok("…purpose ISSUER_DECLARATION, the digest stored as given", row?.purpose === "ISSUER_DECLARATION" && row?.bindingSha256 === bindA);
  ok("…lives exactly 30 minutes", (row?.expiresAt as Date).getTime() - (row?.createdAt as Date).getTime() === 30 * 60_000);
  ok("the existing check function reads it: VALID", (await check(link)) === "VALID");
  ok("another business than the account's → nothing issued", (await issue(A, B.businessId)) === null);
  const D = await account("deleting", { deleting: true });
  ok("a business in deletion → nothing issued", (await issue(D)) === null);
  ok("a malformed digest → refused (22023)", typeof (await issue(A, A.businessId, "not-hex")) === "string");
  const R = await account("rate");
  const r1 = (await issue(R)) as Link;
  const r2 = (await issue(R)) as Link;
  const r3 = (await issue(R)) as Link;
  ok("a new link closes the account's earlier open ones (only the latest works)",
    (await tokenRow(r1.tokenId))?.invalidatedAt instanceof Date && (await tokenRow(r2.tokenId))?.invalidatedAt instanceof Date &&
      (await tokenRow(r3.tokenId))?.invalidatedAt === null);
  ok("a 4th link within the hour → nothing issued (3 per account and hour)", (await issue(R)) === null);
  ok("…and the 3rd is still the open one", (await tokenRow(r3.tokenId))?.invalidatedAt === null);

  console.log("── T5 consume ──");
  ok("another account's id → INVALID", (await consume(link, B.userId, A.businessId)) === "INVALID");
  ok("another business's tenant transaction → INVALID", (await consume(link, A.userId, B.businessId)) === "INVALID");
  ok("no tenant context → INVALID", (await consume(link, A.userId, null)) === "INVALID");
  ok("a wrong secret → INVALID", (await consume({ ...link, secret: newSecret() }, A.userId, A.businessId)) === "INVALID");
  ok("a different digest → BINDING_MISMATCH", (await consume(link, A.userId, A.businessId, digest("other"))) === "BINDING_MISMATCH");
  ok("…and the link stays unspent", (await tokenRow(link.tokenId))?.consumedAt === null);
  const failing = await consume(link, A.userId, A.businessId, bindA, async () => { throw new Error("declaration insert failed"); });
  ok("a transaction that fails after the consume rolls it back…", failing.startsWith("ERROR") && (await tokenRow(link.tokenId))?.consumedAt === null, failing);
  ok("the right account, business and digest → CONFIRMED", (await consume(link, A.userId, A.businessId)) === "CONFIRMED");
  ok("…the link is spent", (await tokenRow(link.tokenId))?.consumedAt instanceof Date);
  ok("…a second consume → USED", (await consume(link, A.userId, A.businessId)) === "USED");
  ok("…the check function now says USED", (await check(link)) === "USED");
  ok("a superseded link → SUPERSEDED", (await consume(r1, R.userId, R.businessId)) === "SUPERSEDED");

  const E = await account("expired");
  const lE = (await issue(E)) as Link;
  await owner.$executeRawUnsafe(
    `UPDATE "AuthEmailToken" SET "createdAt" = "createdAt" - interval '31 minutes', "expiresAt" = "expiresAt" - interval '31 minutes' WHERE id = $1::uuid`, lE.tokenId);
  ok("an expired link → EXPIRED, unspent", (await consume(lE, E.userId, E.businessId)) === "EXPIRED" && (await tokenRow(lE.tokenId))?.consumedAt === null);

  const M = await account("mail");
  const lM = (await issue(M)) as Link;
  await owner.$executeRawUnsafe(`UPDATE "User" SET "email" = $1 WHERE id = $2`, `changed-${Date.now()}@lab.invalid`, M.userId);
  ok("the account's address changed since → INVALID", (await consume(lM, M.userId, M.businessId)) === "INVALID");

  const G = await account("gone");
  const lG = (await issue(G)) as Link;
  await owner.$executeRawUnsafe(`UPDATE "Business" SET "deletionRequestedAt" = now() WHERE id = $1`, G.businessId);
  ok("the business entered deletion since → INVALID", (await consume(lG, G.userId, G.businessId)) === "INVALID");

  const P = await account("purpose");
  const reset = randomUUID();
  const resetSecret = newSecret();
  await auth.$queryRawUnsafe(`SELECT * FROM public.auth_email_token_issue($1::int, 'PASSWORD_RESET', $2::uuid, $3)`, P.userId, reset, sha(resetSecret));
  ok("a token of another purpose (PASSWORD_RESET) → INVALID",
    (await consume({ tokenId: reset, secret: resetSecret, binding: digest("p") }, P.userId, P.businessId)) === "INVALID");

  const C = await account("race");
  const lC = (await issue(C)) as Link;
  const results = await Promise.all(Array.from({ length: 10 }, () => consume(lC, C.userId, C.businessId, lC.binding, undefined, runtimePool)));
  ok("ten concurrent consumes → exactly one CONFIRMED, the rest USED",
    results.filter((s) => s === "CONFIRMED").length === 1 && results.filter((s) => s === "USED").length === 9, JSON.stringify(results));

  console.log("── T6 an account without a password (Google-only) ──");
  const N = await account("google-only", { password: false });
  const lN = await issue(N);
  ok("issues a link", typeof lN === "object" && lN !== null, String(lN));
  ok("…and consumes it", typeof lN === "object" && lN !== null && (await consume(lN, N.userId, N.businessId)) === "CONFIRMED");

  console.log("── T7 privileges ──");
  const asRuntimeIssue = await runtime.$queryRawUnsafe(
    `SELECT * FROM public.auth_issuer_declaration_issue($1::int, $2::int, $3, $4::uuid, $5)`, A.userId, A.businessId, digest("r"), randomUUID(), sha("s"))
    .then(() => "ran").catch((e: Error) => e.message);
  ok("app_runtime cannot issue", DENIED.test(asRuntimeIssue), asRuntimeIssue);
  const asAuthConsume = await auth.$queryRawUnsafe(
    `SELECT public.auth_issuer_declaration_consume($1::uuid, 'x', $2::int, $3)`, randomUUID(), A.userId, digest("a"))
    .then(() => "ran").catch((e: Error) => e.message);
  ok("app_auth cannot consume", DENIED.test(asAuthConsume), asAuthConsume);
  const pub = (await owner.$queryRawUnsafe(
    `SELECT has_function_privilege('public', 'public.auth_issuer_declaration_issue(integer, integer, text, uuid, text)', 'EXECUTE') AS i,
            has_function_privilege('public', 'public.auth_issuer_declaration_consume(uuid, text, integer, text)', 'EXECUTE') AS c`)) as Rows;
  ok("PUBLIC can execute neither", pub[0].i === false && pub[0].c === false);
  const col = await runtime.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('app.current_business_id', $1, true)`, String(A.businessId));
    return tx.$queryRawUnsafe(`SELECT "bindingSha256" FROM "AuthEmailToken" LIMIT 1`);
  }).then(() => "read").catch((e: Error) => e.message);
  ok("app_runtime still cannot read the new column", DENIED.test(col), col);
  const table = await auth.$queryRawUnsafe(`SELECT id FROM "AuthEmailToken" LIMIT 1`).then(() => "read").catch((e: Error) => e.message);
  ok("app_auth still holds nothing on the table", DENIED.test(table), table);

  await Promise.all([owner.$disconnect(), auth.$disconnect(), runtime.$disconnect(), runtimePool.$disconnect()]);
  console.log(`\n[issuer-declaration battery] PASS=${pass} FAIL=${failures.length}`);
  if (failures.length) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
