/**
 * D6 — platform designation of the authorized declarant (#1081; owner decision 2026-11-17) and the declaration
 * screen's field access. Pure: the plan is computed from a given context; the write is an injected writer. Plus
 * source checks on the admin route (MFA ALWAYS, OFF → 404, the business from the route, never from the body).
 *
 *   npx tsx lib/services/billing/issuer-declaration/issuer-designation.test.ts
 */
import { readFileSync } from "node:fs";

import { ConflictError, ValidationError } from "@/lib/errors";
import { issuerStatementSha256 } from "@/lib/billing/issuer-declaration/statement";
import { issuerFieldAccess } from "@/lib/services/billing/issuer-declaration/issuer-declaration.service";
import {
  designateIssuerAuthority,
  DESIGNATION_MESSAGES,
  planIssuerDesignation,
  PLATFORM_DECLARANT_CAPACITY,
  type DesignationContext,
} from "@/lib/services/billing/issuer-declaration/issuer-designation.service";

let failed = 0;
let passed = 0;
function ok(name: string, cond: boolean, got?: unknown) {
  if (!cond) {
    console.error("FAIL: D6", name, got !== undefined ? `(got: ${JSON.stringify(got)})` : "");
    failed += 1;
    return;
  }
  passed += 1;
  console.log("OK: D6", name);
}
function throwsOf(fn: () => unknown): unknown {
  try {
    fn();
    return null;
  } catch (e) {
    return e;
  }
}

const company: DesignationContext = {
  businessId: 77,
  details: {
    billingBusinessKind: "LTD_COMPANY",
    billingLegalName: "דוגמה בע״מ",
    billingTaxId: "516179157",
    billingVatNumber: "516179157",
    billingAddress: "הרצל 1, תל אביב",
    billingPhone: "0501234567",
    billingEmail: "office@example.co.il",
  },
  problems: [],
  users: [
    { id: 11, name: "דנה", email: "dana@example.co.il" },
    { id: 12, name: "יוסי", email: "yossi@example.co.il" },
  ],
  current: null,
  issuedCount: 0,
};
const admin = { id: 900, name: "מנהל בדיקה", email: "admin@dubiz.example" };
const good = { admin, businessId: 77, authorizedUserId: 12, evidenceRef: "פרוטוקול 2026-11-01", reason: "שני משתמשים — נבחרה יוסי לפי הפרוטוקול" };

// ── validation: nothing is planned (so nothing written) on any of these ─────
ok("no user chosen → refused", throwsOf(() => planIssuerDesignation({ ...good, authorizedUserId: undefined }, company)) instanceof ValidationError);
ok("self-designation → refused", (throwsOf(() => planIssuerDesignation({ ...good, authorizedUserId: 900 }, { ...company, users: [...company.users, { id: 900, name: "x", email: "a@b.c" }] })) as Error)?.message === DESIGNATION_MESSAGES.SELF);
ok("a user of another business → refused", (throwsOf(() => planIssuerDesignation({ ...good, authorizedUserId: 99 }, company)) as Error)?.message === DESIGNATION_MESSAGES.USER_NOT_IN_BUSINESS);
ok("no evidence reference → refused", (throwsOf(() => planIssuerDesignation({ ...good, evidenceRef: "  " }, company)) as Error)?.message === DESIGNATION_MESSAGES.EVIDENCE_REQUIRED);
ok("evidence over 200 chars → refused", (throwsOf(() => planIssuerDesignation({ ...good, evidenceRef: "x".repeat(201) }, company)) as Error)?.message === DESIGNATION_MESSAGES.EVIDENCE_REQUIRED);
ok("reason too short → refused", (throwsOf(() => planIssuerDesignation({ ...good, reason: "abc" }, company)) as Error)?.message === DESIGNATION_MESSAGES.REASON_REQUIRED);
ok("an admin without a name → refused", (throwsOf(() => planIssuerDesignation({ ...good, admin: { ...admin, name: null } }, company)) as Error)?.message === DESIGNATION_MESSAGES.ADMIN_NAME);
ok("incomplete issuer details → 409, no declaration",
  throwsOf(() => planIssuerDesignation(good, { ...company, problems: [{ field: "billingVatNumber", code: "MISSING", message: "x" }] })) instanceof ConflictError);

// ── INITIAL: a multi-user business's first declaration ──────────────────────
{
  const p = planIssuerDesignation(good, company);
  ok("INITIAL when no declaration exists", p.mode === "INITIAL");
  ok("statement: the designated user is the authorized user", p.statement.authorizedUserId === 12);
  ok("statement: declared by the platform admin, in that capacity", p.statement.declarantName === "מנהל בדיקה" && p.statement.declarantCapacity === PLATFORM_DECLARANT_CAPACITY);
  ok("statement: the business's own stored identity (company track, company number, VAT number)",
    p.statement.track === "COMPANY_AUTHORIZED_DEALER" && p.statement.idType === "COMPANY_NUMBER" && p.statement.idNumber === "516179157" && p.statement.vatRegistrationNumber === "516179157");
  ok("digest = sha256 of the canonical statement", p.statementSha256 === issuerStatementSha256(p.statement) && /^[0-9a-f]{64}$/.test(p.statementSha256));
  ok("issuer JSON carries exactly the declaration's issuer columns", p.mode === "INITIAL"
    && Object.keys(p.issuer).sort().join(",") === "address,email,idNumber,idType,kind,legalForm,legalName,phone,track,tradeName,vatRegistrationNumber,vatStatus");
  ok("a business that already issued confirms its existing identity", planIssuerDesignation(good, { ...company, issuedCount: 3 }).statement.kind === "EXISTING_CONFIRMATION");
  ok("trimmed evidence and reason", p.evidenceRef === "פרוטוקול 2026-11-01" && p.reason.startsWith("שני משתמשים"));
}

// ── TRANSFER: the authority moves, the issuer does not ──────────────────────
{
  const declared: DesignationContext = {
    ...company,
    current: {
      id: 5, version: 1, kind: "INITIAL", track: "COMPANY_AUTHORIZED_DEALER", legalForm: "COMPANY", vatStatus: "AUTHORIZED",
      legalName: "דוגמה בע״מ", idType: "COMPANY_NUMBER", idNumber: "516179157", vatRegistrationNumber: "516179157",
      address: "הרצל 1, תל אביב", phone: "0501234567", email: "office@example.co.il",
      effectiveFrom: new Date("2026-11-01T10:00:00Z"), authorizedUserId: 11, createdAt: new Date("2026-11-01T10:00:00Z"),
    },
  };
  const p = planIssuerDesignation(good, declared);
  ok("TRANSFER when a declaration exists", p.mode === "TRANSFER");
  ok("TRANSFER statement copies the current issuer and supersedes its version",
    p.statement.kind === "AUTHORITY_TRANSFER" && p.statement.supersedesVersion === 1 && p.statement.legalName === "דוגמה בע״מ" && p.statement.authorizedUserId === 12);
  ok("re-designating the current authorized user → 409", throwsOf(() => planIssuerDesignation({ ...good, authorizedUserId: 11 }, declared)) instanceof ConflictError);
}

// ── the write: the injected writer gets the business and the admin; DB refusals become 409 ──
(async () => {
  let seen: { businessId: number; adminUserId: number } | null = null;
  const r = await designateIssuerAuthority(good, {
    load: async () => company,
    write: async (_plan, ctx) => {
      seen = ctx;
      return 4242;
    },
  });
  ok("write: called with the route's business and the admin's own id", r.declarationId === 4242 && r.mode === "INITIAL" && JSON.stringify(seen) === JSON.stringify({ businessId: 77, adminUserId: 900 }));
  let wrote = false;
  const refused = await designateIssuerAuthority({ ...good, authorizedUserId: 900 }, { load: async () => company, write: async () => { wrote = true; return 1; } }).catch((e) => e);
  ok("write: never called when the plan is refused", refused instanceof ValidationError && !wrote);
  const dbRefused = await designateIssuerAuthority(good, {
    load: async () => company,
    write: async () => { throw new Error('ERROR: ISSUER_DESIGNATION_REQUIRES_PLATFORM_ADMIN (SQLSTATE DZD33)'); },
  }).catch((e) => e);
  ok("write: a database refusal is a 409 with a Hebrew message", dbRefused instanceof ConflictError && (dbRefused as Error).message === DESIGNATION_MESSAGES.DB_REFUSED);

// ── the declaration screen's field access ───────────────────────────────────
{
  const problems = [
    { field: "billingVatNumber" as const, code: "MISSING" as const, message: "" },
    { field: "billingPhone" as const, code: "FORMAT" as const, message: "" },
    { field: "billingTaxId" as const, code: "CHECK_DIGIT" as const, message: "" },
  ];
  const a = issuerFieldAccess({ problems, legalIdentityConfirmed: true, declared: false });
  ok("confirmed signup identity: kind/name/number locked; VAT and phone completable",
    a.lockedFields.sort().join(",") === "billingBusinessKind,billingLegalName,billingTaxId" && a.editableFields.join(",") === "billingVatNumber,billingPhone", a);
  const b = issuerFieldAccess({ problems, legalIdentityConfirmed: false, declared: false });
  ok("unconfirmed (older) business: the number is still completable here", b.editableFields.includes("billingTaxId") && b.lockedFields.length === 0, b);
  const c = issuerFieldAccess({ problems, legalIdentityConfirmed: true, declared: true });
  ok("declared: the VAT number is locked too; only contact details stay completable",
    c.lockedFields.includes("billingVatNumber") && c.editableFields.join(",") === "billingPhone", c);
  const d = issuerFieldAccess({ problems: [{ field: "billingBusinessKind", code: "MISSING", message: "" }], legalIdentityConfirmed: false, declared: false });
  ok("the business kind is never chosen on the declaration screen", d.editableFields.length === 0);
}

// ── the admin route ─────────────────────────────────────────────────────────
{
  const src = readFileSync("app/api/platform-admin/businesses/[id]/issuer-designation/route.ts", "utf8");
  ok("route: MFA elevation verified on every call, independent of the global switch",
    src.includes("verifyAdminElevation(readAdminElevationHeader(req), admin.id)") && !src.includes("isPlatformAdminMfaRequired"));
  ok("route: platform-admin identity first", src.indexOf("requirePlatformAdminOrResponse(req)") > 0 && src.indexOf("requirePlatformAdminOrResponse(req)") < src.indexOf("verifyAdminElevation("));
  ok("route: OFF → 404 before anything is read", (src.match(/if \(!isIssuerDeclarationEnabled\(\)\) return NextResponse\.json\(\{ error: "Not found" \}, \{ status: 404/g) ?? []).length === 2);
  ok("route: the business comes from the route, never the body", src.includes("parseBusinessId((await context.params).id)") && !/businessId:\s*body\./.test(src));
  ok("route: the admin is the session's (id/name), never the body's", src.includes("admin: { id: admin.id, name: admin.name, email: admin.email }"));
  const svc = readFileSync("lib/services/billing/issuer-declaration/issuer-designation.service.ts", "utf8");
  ok("service: the only write is the migration's definer functions", /issuer_designate_initial\(/.test(svc) && /issuer_designate_authorized_user\(/.test(svc)
    && !/businessIssuerDeclaration\.(create|update|upsert|delete)/.test(svc));
}

console.log(failed ? `\nD6: ${passed} passed, ${failed} FAILED` : `\nD6: ${passed}/${passed} passed`);
if (failed) process.exit(1);
})();
