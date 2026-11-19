/**
 * Issuer-declaration link — the LIBRARY against the migrated lab (.agl/lab.sh <db> --with-issuer), as the real
 * planes: lib/auth/issuer-declaration-link.ts on the auth plane (app_auth) and inside a real tenant transaction
 * (lib/tenant/tenant-tx.ts, app_runtime) — the way billing will call it.
 *
 *   request → SENT; the ISSUER_DECLARATION email row carries exactly { tokenId, firstName, legalName,
 *   legalForm }, renders a link whose token the library accepts; check → VALID;
 *   consume in tenantTx → CONFIRMED, then USED; BINDING_MISMATCH leaves it unspent; a tenant transaction that
 *   fails after the consume rolls it back; another business → NOT_ISSUED; a forged token → INVALID;
 *   a Google-only account (no password) end to end.
 *
 *   OWNER_URL=… AUTH_URL=… RUNTIME_URL=… npx tsx .aid/library-battery.ts
 */
import { createHash, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";

const OWNER_URL = process.env.OWNER_URL!;
process.env.AUTH_PLANE_ENABLED = "true";
process.env.AUTH_DATABASE_URL = process.env.AUTH_URL!;
process.env.DATABASE_URL = process.env.RUNTIME_URL!;
process.env.AUTH_TOKEN_SECRET ??= "aid-library-battery-synthetic-token-secret-0123456789abcdef";
process.env.RATE_LIMIT_BACKEND = "memory";

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { failures.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}
type Rows = Record<string, unknown>[];
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
let seq = 0;

async function main() {
  const owner = new PrismaClient({ datasourceUrl: OWNER_URL });
  const lib = await import("../lib/auth/issuer-declaration-link");
  const { tenantTx } = await import("../lib/tenant/tenant-tx");
  const { renderStored } = await import("../lib/email/transactional/registry");

  const account = async (tag: string, password = true) => {
    const b = (await owner.$queryRawUnsafe(`INSERT INTO "Business" ("name","updatedAt") VALUES ($1, now()) RETURNING id`, `aid-lib-${tag}-${++seq}`)) as Rows;
    const businessId = Number(b[0].id);
    const u = (await owner.$queryRawUnsafe(
      `INSERT INTO "User" ("email","password","name","businessId","updatedAt") VALUES ($1,$2,'דנה כהן',$3, now()) RETURNING id`,
      `aid-lib-${tag}-${Date.now()}-${seq}@lab.invalid`, password ? "$2b$10$" + "A".repeat(53) : null, businessId)) as Rows;
    return { userId: Number(u[0].id), businessId };
  };
  const tokenOf = async (emailId: number) => {
    const row = ((await owner.$queryRawUnsafe(`SELECT "kind", "payload" FROM "TransactionalEmail" WHERE id = $1`, emailId)) as Rows)[0];
    const r = renderStored(String(row.kind), row.payload, { appBaseUrl: "https://app.lab.test" });
    const m = r ? /#t=([0-9a-f-]{36}\.[A-Za-z0-9_-]{43})/.exec(r.text) : null;
    return { payload: row.payload as Record<string, unknown>, token: m ? m[1] : "" };
  };
  const spend = (businessId: number, input: { token: unknown; userId: number; statementSha256: string }, fail = false) =>
    tenantTx(businessId, async (tx) => {
      const s = await lib.consumeIssuerDeclarationLink(tx, input);
      if (fail) throw new Error("declaration insert failed");
      return s;
    }).catch((e: Error) => `ERROR: ${e.message}`);

  console.log("── request / check / consume through the library ──");
  const A = await account("a");
  const digest = sha(`statement:${randomUUID()}`);
  const sent = await lib.requestIssuerDeclarationLink({ userId: A.userId, businessId: A.businessId, statementSha256: digest, legalName: "מאפיית דנה", legalForm: "AUTHORIZED_DEALER", now: new Date() });
  ok("request → SENT, for the account's business", sent.status === "SENT" && sent.businessId === A.businessId, JSON.stringify(sent));
  if (sent.status !== "SENT") throw new Error("cannot continue");
  const { payload, token } = await tokenOf(sent.emailId);
  ok("the email row carries exactly tokenId, firstName, legalName, legalForm", Object.keys(payload).sort().join(",") === "firstName,legalForm,legalName,tokenId", JSON.stringify(payload));
  ok("…and renders a link the library accepts", token.length > 0 && (await lib.checkIssuerDeclarationLink(token)) === "VALID");
  ok("a different digest → BINDING_MISMATCH", (await spend(A.businessId, { token, userId: A.userId, statementSha256: sha("other") })) === "BINDING_MISMATCH");
  ok("…the link is still VALID", (await lib.checkIssuerDeclarationLink(token)) === "VALID");
  const rolled = await spend(A.businessId, { token, userId: A.userId, statementSha256: digest }, true);
  ok("a tenant transaction failing after the consume rolls it back", rolled.startsWith("ERROR") && (await lib.checkIssuerDeclarationLink(token)) === "VALID", rolled);
  ok("consume in the business's tenant transaction → CONFIRMED", (await spend(A.businessId, { token, userId: A.userId, statementSha256: digest })) === "CONFIRMED");
  ok("…then USED, and check says USED", (await spend(A.businessId, { token, userId: A.userId, statementSha256: digest })) === "USED" && (await lib.checkIssuerDeclarationLink(token)) === "USED");

  console.log("── refusals ──");
  const B = await account("b");
  ok("another business than the account's → NOT_ISSUED",
    (await lib.requestIssuerDeclarationLink({ userId: A.userId, businessId: B.businessId, statementSha256: digest, legalName: "x", legalForm: "LTD_COMPANY", now: new Date() })).status === "NOT_ISSUED");
  const sentB = await lib.requestIssuerDeclarationLink({ userId: B.userId, businessId: B.businessId, statementSha256: digest, legalName: "עסק ב", legalForm: "LTD_COMPANY", now: new Date() });
  const tB = sentB.status === "SENT" ? (await tokenOf(sentB.emailId)).token : "";
  ok("B's link spent in A's tenant transaction → INVALID", (await spend(A.businessId, { token: tB, userId: B.userId, statementSha256: digest })) === "INVALID");
  ok("B's link spent as A → INVALID", (await spend(B.businessId, { token: tB, userId: A.userId, statementSha256: digest })) === "INVALID");
  ok("a forged token → INVALID", (await spend(B.businessId, { token: `${randomUUID()}.${"A".repeat(43)}`, userId: B.userId, statementSha256: digest })) === "INVALID");

  console.log("── a Google-only account ──");
  const G = await account("google", false);
  const sentG = await lib.requestIssuerDeclarationLink({ userId: G.userId, businessId: G.businessId, statementSha256: digest, legalName: "עסק גוגל", legalForm: "EXEMPT_DEALER", now: new Date() });
  const tG = sentG.status === "SENT" ? (await tokenOf(sentG.emailId)).token : "";
  ok("request → SENT and consume → CONFIRMED with no password on the account",
    sentG.status === "SENT" && (await spend(G.businessId, { token: tG, userId: G.userId, statementSha256: digest })) === "CONFIRMED");

  await owner.$disconnect();
  console.log(`\n[issuer-declaration library battery] PASS=${pass} FAIL=${failures.length}`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
