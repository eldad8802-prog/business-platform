/**
 * P3-A — what migrations 20261008090000_p3a_identity_enum_values + 20261008090100_p3a_trust_claims
 * do, measured with the real tenant runtime login (app_runtime_prod: NOSUPERUSER, NOBYPASSRLS) on a
 * Production-shaped database (lab: .p3a/lab.sh <db> --with-p3a).
 *
 *   1. tenant isolation: A cannot read, change, approve, retire or re-point B's claims; no tenant
 *      context fails closed; no DELETE, no TRUNCATE;
 *   2. authority: a claim enters ACTIVE and NOT public; public use is a separate act; the content of
 *      a claim (kind, class, parameters, wording, evidence condition, confirmation, expiry, tenant)
 *      is immutable for the runtime; a RETIRED claim is frozen history;
 *   3. the CHECK constraints: kind ↔ class, PROHIBITED unreachable, wording ↔ hash, evidence shape,
 *      verification shape, public-without-document refused, one ACTIVE claim per kind + scope;
 *   4. the P2 extensions: CONVERSION_DECLARATION is coded and never public; channel only on
 *      objectives; PUBLIC_WHATSAPP bound to its canonical source field and to nothing else; the
 *      fact vocabulary gains exactly that one label (no public shop-link authority exists);
 *   5. Business deletion cascades.
 *
 * env: OWNER_URL, RUNTIME_URL. Synthetic only. ZERO network. Raw SQL only: the PR ships no
 * schema.prisma change (migration-first), so the generated client knows nothing of P3-A.
 */
import { PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";

const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });
const runtime = new PrismaClient({ datasourceUrl: process.env.RUNTIME_URL! });

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { failures.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}
type Rows = Record<string, unknown>[];
async function rt(guc: number | null, sql: string, ...args: unknown[]): Promise<Rows | string> {
  return runtime.$transaction(async (tx) => {
    if (guc !== null) await tx.$executeRawUnsafe(`SELECT set_config('app.current_business_id', '${guc}', true)`);
    return tx.$queryRawUnsafe(sql, ...args) as Promise<Rows>;
  }).catch((e: Error) => e.message);
}
const n = (r: Rows | string) => (typeof r === "string" ? -1 : r.length);
const refused = (r: Rows | string, re: RegExp) => typeof r === "string" && re.test(r);
const RLS = /row-level security/i;
const DENIED = /permission denied/i;
/** Prisma words a 23505 from a raw query as "Unique constraint failed"; psql as "duplicate key". */
const UNIQUE = /Unique constraint|duplicate key|23505/i;
const ownerErr = (sql: string, ...args: unknown[]) => owner.$executeRawUnsafe(sql, ...args).then(() => "ok", (e: Error) => e.message);
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const firstId = (r: Rows | string) => (typeof r === "string" ? -1 : Number(r[0]?.id));

const T = `"BusinessTrustClaim"`;
/** An owner-asserted claim (FOUNDED_YEAR), the simplest valid row. */
const INS_FOUNDED = `INSERT INTO ${T} ("businessId","claimKind","claimClass","params","wording","wordingHash","confirmedByUserId","updatedAt")
  VALUES ($1,'FOUNDED_YEAR','OWNER_ASSERTED',$2::jsonb,$3,$4,$5,now()) RETURNING id`;
const founded = (business: number, user: number, wording = "מאז 1998") =>
  [business, JSON.stringify({ foundedYear: 1998 }), wording, sha(wording), user] as const;

async function main() {
  const tag = `p3a-${Date.now()}`;
  const [{ id: A }] = (await owner.$queryRawUnsafe(`INSERT INTO "Business" (name, "updatedAt") VALUES ($1, now()) RETURNING id`, `${tag}-A`)) as Array<{ id: number }>;
  const [{ id: B }] = (await owner.$queryRawUnsafe(`INSERT INTO "Business" (name, "updatedAt") VALUES ($1, now()) RETURNING id`, `${tag}-B`)) as Array<{ id: number }>;
  const userA = 101, userB = 202;

  const [role] = (await runtime.$queryRawUnsafe(`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`)) as Array<{ rolsuper: boolean; rolbypassrls: boolean }>;
  ok("the runtime login is NOSUPERUSER NOBYPASSRLS", !role.rolsuper && !role.rolbypassrls, JSON.stringify(role));

  console.log("\n-- 1. tenant isolation --");
  const a1 = await rt(A, INS_FOUNDED, ...founded(A, userA));
  ok("GUC = A: the runtime confirms A's claim", n(a1) === 1, String(a1));
  const claimA = firstId(a1);
  ok("GUC = A: a claim for B is refused (WITH CHECK)", refused(await rt(A, INS_FOUNDED, ...founded(B, userA)), RLS));
  ok("no tenant context: confirming anything is refused", refused(await rt(null, INS_FOUNDED, ...founded(A, userA)), RLS));
  const b1 = await rt(B, INS_FOUNDED, ...founded(B, userB));
  const claimB = firstId(b1);
  ok("GUC = B: B confirms its own claim", claimB > 0, String(b1));
  ok("GUC = A sees only A's claim", n(await rt(A, `SELECT id FROM ${T}`)) === 1);
  ok("no tenant context sees nothing (fails closed)", n(await rt(null, `SELECT id FROM ${T}`)) === 0);
  ok("A cannot read B's claim by id", n(await rt(A, `SELECT id FROM ${T} WHERE id = $1`, claimB)) === 0);
  ok("A cannot approve B's claim (0 rows)",
    n(await rt(A, `UPDATE ${T} SET "publicUseApproved" = true, "publicUseApprovedAt" = now(), "publicUseApprovedByUserId" = $2 WHERE id = $1 RETURNING id`, claimB, userA)) === 0);
  ok("A cannot retire B's claim (0 rows)",
    n(await rt(A, `UPDATE ${T} SET "status" = 'RETIRED', "retiredAt" = now(), "retiredByUserId" = $2 WHERE id = $1 RETURNING id`, claimB, userA)) === 0);
  ok("A cannot re-point its claim to B (tenant column is not updatable)",
    refused(await rt(A, `UPDATE ${T} SET "businessId" = $1 WHERE id = $2 RETURNING id`, B, claimA), DENIED));
  ok("the runtime cannot DELETE a claim (history is never erased)", refused(await rt(A, `DELETE FROM ${T} WHERE id = $1 RETURNING id`, claimA), DENIED));
  ok("the runtime cannot TRUNCATE claims", refused(await rt(A, `TRUNCATE ${T}`), DENIED));
  const [bRow] = (await owner.$queryRawUnsafe(`SELECT status::text, "publicUseApproved" FROM ${T} WHERE id = $1`, claimB)) as Array<{ status: string; publicUseApproved: boolean }>;
  ok("owner view: B's claim is untouched (ACTIVE, not public)", bRow.status === "ACTIVE" && !bRow.publicUseApproved, JSON.stringify(bRow));

  console.log("\n-- 2. authority --");
  const autoPublic = `INSERT INTO ${T} ("businessId","claimKind","claimClass","params","wording","wordingHash","confirmedByUserId","publicUseApproved","publicUseApprovedAt","publicUseApprovedByUserId","scopeKey","updatedAt")
    VALUES ($1,'GUARANTEE','OWNER_ASSERTED','{"coverage":"x","duration":"12m","conditions":"y"}'::jsonb,'אחריות 12 חודשים',$2,$3,true,now(),$3,'auto',now()) RETURNING id`;
  ok("a claim cannot be CREATED already public (public use is a separate act)", refused(await rt(A, autoPublic, A, sha("אחריות 12 חודשים"), userA), RLS));
  const retiredIns = `INSERT INTO ${T} ("businessId","claimKind","claimClass","params","wording","wordingHash","confirmedByUserId","status","retiredAt","retiredByUserId","scopeKey","updatedAt")
    VALUES ($1,'FOUNDED_YEAR','OWNER_ASSERTED','{}'::jsonb,'w',$2,$3,'RETIRED',now(),$3,'r',now()) RETURNING id`;
  ok("a claim cannot be created RETIRED", refused(await rt(A, retiredIns, A, sha("w"), userA), RLS));
  ok("the owner approves public use as a second act",
    n(await rt(A, `UPDATE ${T} SET "publicUseApproved" = true, "publicUseApprovedAt" = now(), "publicUseApprovedByUserId" = $2, "updatedAt" = now() WHERE id = $1 RETURNING id`, claimA, userA)) === 1);
  for (const [col, val] of [["wording", "'מאז 1990'"], ["wordingHash", `'${sha("x")}'`], ["params", `'{"foundedYear":1990}'::jsonb`],
    ["claimKind", "'GUARANTEE'"], ["claimClass", "'SAFE_FACTUAL'"], ["evidenceCondition", `'{"gte":1}'::jsonb`], ["confirmedAt", "now()"],
    ["confirmedByUserId", "999"], ["validUntil", "now() + interval '1 year'"], ["scopeKey", "'other'"], ["createdAt", "now()"]] as const) {
    ok(`the runtime cannot change "${col}" of a claim (a change is a new claim)`,
      refused(await rt(A, `UPDATE ${T} SET "${col}" = ${val} WHERE id = $1 RETURNING id`, claimA), DENIED));
  }
  ok("withdrawing public use is allowed",
    n(await rt(A, `UPDATE ${T} SET "publicUseApproved" = false, "publicUseApprovedAt" = NULL, "publicUseApprovedByUserId" = NULL WHERE id = $1 RETURNING id`, claimA)) === 1);
  ok("retirement records who and when",
    n(await rt(A, `UPDATE ${T} SET "status" = 'RETIRED', "retiredAt" = now(), "retiredByUserId" = $2 WHERE id = $1 RETURNING id`, claimA, userA)) === 1);
  ok("a RETIRED claim is frozen: it cannot be re-approved (0 rows)",
    n(await rt(A, `UPDATE ${T} SET "publicUseApproved" = true, "publicUseApprovedAt" = now(), "publicUseApprovedByUserId" = $2 WHERE id = $1 RETURNING id`, claimA, userA)) === 0);
  ok("a RETIRED claim is frozen: it cannot be revived (0 rows)",
    n(await rt(A, `UPDATE ${T} SET "status" = 'ACTIVE', "retiredAt" = NULL, "retiredByUserId" = NULL WHERE id = $1 RETURNING id`, claimA)) === 0);
  ok("retirement without who is refused",
    /retired_shape/.test(await ownerErr(`UPDATE ${T} SET "status" = 'RETIRED', "retiredAt" = now() WHERE id = $1`, claimB)));
  const a2 = await rt(A, INS_FOUNDED, ...founded(A, userA, "מאז 1999"));
  ok("after retirement, a new ACTIVE claim of that kind may be confirmed", n(a2) === 1, String(a2));

  console.log("\n-- 3. constraints --");
  const insert = (cols: string, vals: string, ...args: unknown[]) =>
    ownerErr(`INSERT INTO ${T} ("businessId","confirmedByUserId","updatedAt",${cols}) VALUES (${A}, ${userA}, now(), ${vals})`, ...args);
  const base = (kind: string, cls: string, wording: string, scope: string) =>
    `'${kind}','${cls}','{}'::jsonb,'${wording}','${sha(wording)}','${scope}'`;
  const COLS = `"claimKind","claimClass","params","wording","wordingHash","scopeKey"`;
  ok("one ACTIVE claim per kind + scope", refused(await rt(A, INS_FOUNDED, ...founded(A, userA, "מאז 2000")), UNIQUE));
  ok("the class is fixed by the kind (FOUNDED_YEAR cannot be SAFE_FACTUAL, even with an evidence condition)",
    /kind_class/.test(await insert(`${COLS},"evidenceRuleId","evidenceRuleVersion","evidenceCondition"`,
      `${base("FOUNDED_YEAR", "SAFE_FACTUAL", "w", "k1")},'p3.founded','p3.evidence.v1','{}'::jsonb`)));
  ok("LICENSED cannot be OWNER_ASSERTED", /kind_class/.test(await insert(COLS, base("LICENSED", "OWNER_ASSERTED", "w", "k2"))));
  ok("no kind can be PROHIBITED", /kind_class/.test(await insert(COLS, base("GUARANTEE", "PROHIBITED", "w", "k3"))));
  ok("wording and hash must agree (the database recomputes it)",
    /wording_hash/.test(await insert(COLS, `'GUARANTEE','OWNER_ASSERTED','{}'::jsonb,'w','${sha("other")}','k4'`)));
  ok("blank wording is refused", /wording/.test(await insert(COLS, `'GUARANTEE','OWNER_ASSERTED','{}'::jsonb,'   ','${sha("   ")}','k5'`)));
  ok("params must be an object", /params/.test(await insert(COLS, `'GUARANTEE','OWNER_ASSERTED','[1]'::jsonb,'w','${sha("w")}','k6'`)));
  ok("a malformed scope key is refused", /scope_key/.test(await insert(COLS, base("CERTIFIED", "VERIFICATION_REQUIRED", "w", "Bad Scope"))));
  ok("SERVED_CUSTOMERS without an evidence condition is refused", /evidence_shape/.test(await insert(COLS, base("SERVED_CUSTOMERS", "SAFE_FACTUAL", "w", "k7"))));
  const SF = `${COLS},"evidenceRuleId","evidenceRuleVersion","evidenceCondition"`;
  ok("SERVED_CUSTOMERS with a P3 rule + condition is accepted",
    (await insert(SF, `${base("SERVED_CUSTOMERS", "SAFE_FACTUAL", "שירתנו מעל 500 לקוחות", "default")},'p3.served_customers','p3.evidence.v1','{"metric":"served_customers","gte":500}'::jsonb`)) === "ok");
  ok("an evidence rule outside p3.evidence.vN is refused",
    /evidence_shape/.test(await insert(SF, `${base("SERVED_CUSTOMERS", "SAFE_FACTUAL", "w", "k8")},'p3.served_customers','m2.knowledge.v1','{}'::jsonb`)));
  ok("an owner-asserted claim cannot pretend to have evidence",
    /evidence_shape/.test(await insert(SF, `${base("GUARANTEE", "OWNER_ASSERTED", "w", "k9")},'p3.x','p3.evidence.v1','{}'::jsonb`)));
  const VF = `${COLS},"verificationMethod","verificationAttachmentKey","verificationAttachmentSha256","verificationAttachmentMimeType","verifiedAt"`;
  const doc = (key: string, mime = "application/pdf") => `'OWNER_DOCUMENT','${key}','${sha("doc")}','${mime}',now()`;
  ok("a licence with its private document is accepted",
    (await insert(VF, `${base("LICENSED", "VERIFICATION_REQUIRED", "חשמלאי מוסמך", "elec")},${doc("trust/1/licence-a.pdf")}`)) === "ok");
  ok("verification on an owner-asserted claim is refused",
    /verification_shape/.test(await insert(VF, `${base("GUARANTEE", "OWNER_ASSERTED", "w", "k10")},${doc("trust/1/x.pdf")}`)));
  ok("a half-written verification is refused",
    /verification_shape/.test(await insert(`${COLS},"verificationMethod"`, `${base("CERTIFIED", "VERIFICATION_REQUIRED", "w", "k11")},'OWNER_DOCUMENT'`)));
  ok("a URL is not an attachment key", /verification_shape/.test(await insert(VF, `${base("CERTIFIED", "VERIFICATION_REQUIRED", "w", "k12")},${doc("https://x.example/a.pdf")}`)));
  ok("a path-traversing key is refused", /verification_shape/.test(await insert(VF, `${base("CERTIFIED", "VERIFICATION_REQUIRED", "w", "k13")},${doc("trust/../../etc/passwd")}`)));
  ok("an unsupported document type is refused", /verification_shape/.test(await insert(VF, `${base("CERTIFIED", "VERIFICATION_REQUIRED", "w", "k14")},${doc("trust/1/a.exe", "application/x-msdownload")}`)));
  const cert = await rt(A, `INSERT INTO ${T} ("businessId","claimKind","claimClass","params","wording","wordingHash","confirmedByUserId","scopeKey","updatedAt")
    VALUES ($1,'CERTIFIED','VERIFICATION_REQUIRED','{"name":"כשרות","issuer":"רבנות"}'::jsonb,'תעודת כשרות',$2,$3,'kosher',now()) RETURNING id`, A, sha("תעודת כשרות"), userA);
  const certId = firstId(cert);
  ok("a certification may be confirmed before its document exists (internal only)", certId > 0, String(cert));
  ok("…but cannot be approved for public use without the owner-provided document",
    refused(await rt(A, `UPDATE ${T} SET "publicUseApproved" = true, "publicUseApprovedAt" = now(), "publicUseApprovedByUserId" = $2 WHERE id = $1 RETURNING id`, certId, userA), /public_needs_verification/));
  ok("the owner attaches the private document",
    n(await rt(A, `UPDATE ${T} SET "verificationMethod" = 'OWNER_DOCUMENT', "verificationAttachmentKey" = 'trust/a/kosher.pdf', "verificationAttachmentSha256" = $2, "verificationAttachmentMimeType" = 'application/pdf', "verifiedAt" = now() WHERE id = $1 RETURNING id`, certId, sha("pdf"))) === 1);
  ok("…and then may approve it for public use",
    n(await rt(A, `UPDATE ${T} SET "publicUseApproved" = true, "publicUseApprovedAt" = now(), "publicUseApprovedByUserId" = $2 WHERE id = $1 RETURNING id`, certId, userA)) === 1);
  ok("a second certification is its own scope",
    (await insert(COLS, base("CERTIFIED", "VERIFICATION_REQUIRED", "הסמכה מקצועית", "pro-cert"))) === "ok");
  ok("approval with a time but without who is refused (a NULL can never satisfy a CHECK branch)",
    /public_use/.test(await ownerErr(`UPDATE ${T} SET "publicUseApproved" = true, "publicUseApprovedAt" = now() WHERE id = $1`, firstId(a2))));
  ok("SERVED_CUSTOMERS with a rule but no version or condition is refused",
    /evidence_shape/.test(await insert(`${COLS},"evidenceRuleId"`, `${base("SERVED_CUSTOMERS", "SAFE_FACTUAL", "w", "k16")},'p3.served_customers'`)));
  ok("a verification with method and time but no document is refused",
    /verification_shape/.test(await insert(`${COLS},"verificationMethod","verifiedAt"`, `${base("LICENSED", "VERIFICATION_REQUIRED", "w", "k17")},'OWNER_DOCUMENT',now()`)));
  ok("approval without who/when is refused",
    /public_use/.test(await ownerErr(`UPDATE ${T} SET "publicUseApproved" = true WHERE id = $1`, firstId(a2))));
  ok("an expiry before the confirmation is refused",
    /valid_until/.test(await insert(`${COLS},"validUntil"`, `${base("CERTIFIED", "VERIFICATION_REQUIRED", "w", "k15")},now() - interval '1 day'`)));

  console.log("\n-- 4. P2 extensions (as the runtime, under A) --");
  const S = `"BusinessIdentityStatement"`;
  const st = (dimension: string, code: string | null, text: string | null, channel: string | null, extra = "") =>
    rt(A, `INSERT INTO ${S} ("businessId","dimension","code","text","channel","source","updatedAt"${extra ? "," + extra.split("=")[0] : ""})
           VALUES ($1,'${dimension}',$2,$3,${channel ? `'${channel}'` : "NULL"},'OWNER_INPUT',now()${extra ? "," + extra.split("=")[1] : ""}) RETURNING id`, A, code, text);
  ok("a CONVERSION_DECLARATION is a coded owner statement", n(await st("CONVERSION_DECLARATION", "ACCEPTS_VISITS", null, null)) === 1);
  ok("a second declaration code is allowed", n(await st("CONVERSION_DECLARATION", "WHATSAPP_ON_PUBLIC_PHONE", null, null)) === 1);
  ok("the same declaration cannot be ACTIVE twice", refused(await st("CONVERSION_DECLARATION", "ACCEPTS_VISITS", null, null), UNIQUE));
  ok("a declaration with free text is refused", refused(await st("CONVERSION_DECLARATION", null, "we accept visits", null), /value_shape/));
  ok("a declaration can never be approved for public use",
    refused(await st("CONVERSION_DECLARATION", "EXTERNAL_SHOP", null, null, `"publicUseApproved","publicUseApprovedAt"=true,now()`), /public_use/));
  ok("an objective may name its channel (REQUEST_QUOTE via WHATSAPP_CLOUD)", n(await st("PRIMARY_OBJECTIVE", "REQUEST_QUOTE", null, "WHATSAPP_CLOUD")) === 1);
  ok("an objective without a channel stays valid", n(await st("SECONDARY_OBJECTIVE", "CALL", null, null)) === 1);
  ok("a discovery objective has no channel", refused(await st("SECONDARY_OBJECTIVE", "DISCOVER_SERVICES", null, "PHONE"), /channel_shape/));
  ok("a channel on a non-objective dimension is refused", refused(await st("TONE", "WARM", null, "PHONE"), /channel_shape/));
  const F = `"BusinessIdentityFactAuthority"`;
  const fact = (f: string, source: string) => rt(A, `INSERT INTO ${F} ("businessId","fact","sourceField","valueHash","confirmedByUserId","updatedAt")
    VALUES ($1,'${f}','${source}',$2,$3,now()) RETURNING id`, A, sha(f), userA);
  ok("PUBLIC_WHATSAPP authority is bound to WhatsAppConnection.displayPhoneNumber", n(await fact("PUBLIC_WHATSAPP", "WhatsAppConnection.displayPhoneNumber")) === 1);
  ok("PUBLIC_WHATSAPP cannot claim another source (e.g. the billing phone)", refused(await fact("PUBLIC_WHATSAPP", "BusinessProfile.billingPhone"), /source_field/));
  const [factLabels] = (await owner.$queryRawUnsafe(`SELECT count(*)::int AS n FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'BusinessIdentityFact'`)) as Array<{ n: number }>;
  ok("the fact vocabulary gains exactly one label (6 P2 facts + PUBLIC_WHATSAPP; no shop-link fact)", factLabels.n === 7, String(factLabels.n));
  ok("no fact may claim the bot product link as its source", refused(await fact("PUBLIC_WHATSAPP", "BusinessBotSettings.productLinkUrl"), /source_field/));
  ok("PUBLIC_PHONE keeps its P2 source and only it", refused(await fact("PUBLIC_PHONE", "WhatsAppConnection.displayPhoneNumber"), /source_field/));
  ok("B sees none of A's statements or fact authorities",
    n(await rt(B, `SELECT id FROM ${S} WHERE "businessId" = $1 UNION ALL SELECT id FROM ${F} WHERE "businessId" = $1`, A)) === 0);

  console.log("\n-- 5. erasure follows the business --");
  await owner.$executeRawUnsafe(`DELETE FROM "Business" WHERE id = $1`, B);
  const [left] = (await owner.$queryRawUnsafe(`SELECT count(*)::int AS n FROM ${T} WHERE "businessId" = $1`, B)) as Array<{ n: number }>;
  ok("deleting a business removes its claims (cascade)", left.n === 0);

  await owner.$executeRawUnsafe(`DELETE FROM "Business" WHERE id = $1`, A);
  console.log(`\nP3-A battery: ${pass} passed, ${failures.length} failed`);
  await owner.$disconnect();
  await runtime.$disconnect();
  if (failures.length) process.exit(1);
}

main().catch(async (e) => {
  console.error(e);
  await owner.$disconnect();
  await runtime.$disconnect();
  process.exit(1);
});
