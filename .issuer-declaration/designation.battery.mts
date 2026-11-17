/**
 * D7 — platform designation of the authorized declarant (#1081; owner decision 2026-11-17) against the lab with the
 * declaration migration applied. Proves the APPLICATION's designation (lib/services/billing/issuer-declaration/
 * issuer-designation.service.ts) end to end: the context is read as the runtime inside the business's tenant
 * transaction; the plan's statement and issuer JSON are accepted by the migration's definer function exactly as sent;
 * the recorded row is the binding record (who, when, evidence, reason, digest); the database's own refusals hold.
 *
 * The writer runs on the lab's table-owner connection: the lab has no separate platform-admin login, and the
 * function is the same SECURITY DEFINER either way (the role check is the function's PLATFORM_ADMIN test, run here).
 *
 *   OWNER_URL=… RUNTIME_URL=… npx tsx .issuer-declaration/designation.battery.mts
 * Synthetic only. ZERO secrets. ZERO network.
 */
import { inspect } from "node:util";
import { PrismaClient } from "@prisma/client";

const OWNER_URL = process.env.OWNER_URL!;
process.env.DATABASE_URL = process.env.RUNTIME_URL!;
process.env.DIRECT_URL = process.env.RUNTIME_URL!;

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail: unknown = "") {
  if (cond) {
    pass += 1;
    console.log(`  [PASS] D7 ${name}`);
  } else {
    failures.push(name);
    console.log(`  [FAIL] D7 ${name}${detail === "" ? "" : " — " + (typeof detail === "string" ? detail : JSON.stringify(detail))}`);
  }
}
type Rows = Record<string, unknown>[];
const errText = (e: unknown) => inspect(e, { depth: 6 }).replace(/\s+/g, " ");
let seq = 0;

async function main() {
  const owner = new PrismaClient({ datasourceUrl: OWNER_URL });
  const q = (sql: string, ...a: unknown[]) => owner.$queryRawUnsafe(sql, ...a) as Promise<Rows>;
  const x = (sql: string, ...a: unknown[]) => owner.$executeRawUnsafe(sql, ...a);
  const des = await import("../lib/services/billing/issuer-declaration/issuer-designation.service");
  const { tenantTx } = await import("../lib/tenant/tenant-tx");
  const { ConflictError } = await import("../lib/errors");

  const business = async (tag: string, users: number) => {
    const b = Number((await q(`INSERT INTO "Business" ("name","updatedAt") VALUES ($1, now()) RETURNING id`, `d7-${tag}-${++seq}`))[0].id);
    const ids: number[] = [];
    for (let i = 0; i < users; i += 1) {
      ids.push(Number((await q(`INSERT INTO "User" ("email","password","name","businessId","updatedAt") VALUES ($1,$2,$3,$4, now()) RETURNING id`,
        `d7-${tag}-${Date.now()}-${seq}-${i}@lab.invalid`, "$2b$10$" + "A".repeat(53), `משתמש ${i + 1}`, b))[0].id));
    }
    await x(`INSERT INTO "BusinessProfile" ("businessId","billingLegalName","billingBusinessKind","billingTaxId","billingVatNumber",
               "billingAddress","billingPhone","billingEmail","updatedAt")
             VALUES ($1,'דוגמה בע״מ','LTD_COMPANY','510000003','510000003','הרצל 1, תל אביב','0501234567','office@example.test', now())`, b);
    return { businessId: b, users: ids };
  };
  const adminBiz = await business("admin-home", 1);
  const adminId = adminBiz.users[0];
  await x(`UPDATE "User" SET "role" = 'PLATFORM_ADMIN', "name" = 'מנהל בדיקה' WHERE id = $1`, adminId);
  const notAdminId = (await business("not-admin", 1)).users[0];

  const ownerWriter = des.designationWriterFor(() => owner);
  const load = (businessId: number) => tenantTx(businessId, (tx) => des.loadIssuerDesignationContextTx(tx, businessId));
  const decls = (b: number) => q(`SELECT * FROM "BusinessIssuerDeclaration" WHERE "businessId" = $1 ORDER BY version`, b);

  // the context, read as the runtime inside the tenant transaction
  const two = await business("two-users", 2);
  const ctx = await load(two.businessId);
  ok("context: read as the runtime under the tenant — both users, complete company details, no declaration",
    ctx.users.length === 2 && ctx.problems.length === 0 && ctx.current === null && ctx.details.billingTaxId === "510000003", ctx);

  // INITIAL — the application's plan, the function's write
  const input = { admin: { id: adminId, name: "מנהל בדיקה", email: "a@lab.invalid" }, businessId: two.businessId,
    authorizedUserId: two.users[1], evidenceRef: "פרוטוקול דירקטוריון 2026-11-01", reason: "שני משתמשים; המורשה לפי הפרוטוקול" };
  const r1 = await des.designateIssuerAuthority(input, { load, write: ownerWriter });
  const rows1 = await decls(two.businessId);
  const plan1 = des.planIssuerDesignation(input, ctx);
  ok("INITIAL: one declaration row, version 1", r1.mode === "INITIAL" && rows1.length === 1 && Number(rows1[0].version) === 1, rows1);
  const d1 = rows1[0] ?? {};
  ok("INITIAL: the designated user is authorized; declared by the platform admin",
    Number(d1.authorizedUserId) === two.users[1] && Number(d1.declaredByUserId) === adminId && d1.authorityBasis === "PLATFORM_DESIGNATED"
      && d1.reauthMethod === "PLATFORM_ADMIN_ELEVATION" && d1.declarantCapacity === "מנהל פלטפורמה", d1);
  ok("INITIAL: the binding record — evidence, reason and the application's digest, exactly as sent",
    d1.authorityEvidenceRef === input.evidenceRef && d1.reason === input.reason && d1.statementSha256 === plan1.statementSha256, d1);
  ok("INITIAL: the issuer fields are the business's own (company track, company number, VAT number)",
    d1.track === "COMPANY_AUTHORIZED_DEALER" && d1.idType === "COMPANY_NUMBER" && d1.idNumber === "510000003" && d1.vatRegistrationNumber === "510000003"
      && d1.legalName === "דוגמה בע״מ", d1);

  // TRANSFER — the authority moves to the other user; the issuer does not change
  const r2 = await des.designateIssuerAuthority({ ...input, authorizedUserId: two.users[0], evidenceRef: "ייפוי כוח 2026-11-10" }, { load, write: ownerWriter });
  const rows2 = await decls(two.businessId);
  const d2 = rows2[1] ?? {};
  ok("TRANSFER: version 2 supersedes version 1, kind AUTHORITY_TRANSFER, the issuer unchanged",
    r2.mode === "TRANSFER" && rows2.length === 2 && d2.kind === "AUTHORITY_TRANSFER" && Number(d2.supersedesId) === Number(d1.id)
      && d2.idNumber === d1.idNumber && d2.legalName === d1.legalName && Number(d2.authorizedUserId) === two.users[0], d2);

  // the database's own refusals hold, through the application path
  const three = await business("not-admin-try", 2);
  const notAdmin = await des.designateIssuerAuthority({ ...input, admin: { id: notAdminId, name: "לא מנהל", email: "x@lab.invalid" }, businessId: three.businessId, authorizedUserId: three.users[0] },
    { load, write: ownerWriter }).catch((e) => e);
  ok("a non-admin user id is refused by the database (409), nothing written",
    notAdmin instanceof ConflictError && (await decls(three.businessId)).length === 0, errText(notAdmin));
  const outsider = await des.designateIssuerAuthority({ ...input, businessId: three.businessId, authorizedUserId: two.users[0] }, { load, write: ownerWriter }).catch((e) => e);
  ok("a user of another business is refused before any write", outsider instanceof Error && (await decls(three.businessId)).length === 0, errText(outsider));
  const forged = await q(`SELECT 1`).then(async () => {
    try {
      await tenantTx(three.businessId, (tx) => tx.$executeRawUnsafe(
        `INSERT INTO "BusinessIssuerDeclaration" ("businessId","version","kind","track","legalForm","vatStatus","legalName","idType","idNumber",
           "vatRegistrationNumber","address","phone","email","effectiveFrom","authorizedUserId","authorityBasis","authorityEvidenceRef",
           "declaredByUserId","declarantName","declarantCapacity","statementVersion","statementSha256","reauthMethod","reauthAt")
         VALUES ($1,1,'INITIAL','COMPANY_AUTHORIZED_DEALER','COMPANY','AUTHORIZED','x','COMPANY_NUMBER','510000003','510000003','a','050','e@x.y',
           now(),$2,'PLATFORM_DESIGNATED','case',$3,'x','x','v1',repeat('a',64),'PLATFORM_ADMIN_ELEVATION',now())`,
        three.businessId, three.users[0], adminId));
      return "INSERTED";
    } catch (e) {
      return errText(e);
    }
  });
  ok("the runtime cannot write a designation directly (designation-origin trigger)", forged !== "INSERTED" && /DZD33|ISSUER_DESIGNATION_ONLY_BY_PLATFORM_FUNCTION|permission denied/.test(forged), forged);

  await owner.$disconnect();
  console.log(`\nSUMMARY\n  D7: ${pass}/${pass + failures.length}`);
  if (failures.length) {
    console.log(`FAILED (${failures.length}): ${failures.join(" | ")}`);
    process.exit(1);
  }
  console.log("ALL PASS");
  process.exit(0);
}

main().catch((e) => {
  console.error(errText(e));
  process.exit(1);
});
