/**
 * Issuer declaration (#1081) — the declaration FLOW against a lab with both migrations: session 23's link
 * (20261126090000, via `.agl/lab.sh <db> --with-issuer`, Production auth topology) and billing's declaration
 * (20261123090000, applied after it as the owner — session 23's order (a)). Real planes: the link is requested on
 * the auth plane (app_auth), confirmed in billing's tenant transaction as app_runtime_prod (NOBYPASSRLS).
 *
 *   D3  confirm-transaction outcomes: SENT / VALID / CONFIRMED (row fields + digest) / ALREADY_DECLARED / INVALID
 *       (forged, another account) / SUPERSEDED / EXPIRED / INCOMPLETE / NEEDS_DESIGNATION / three tracks /
 *       EXISTING_CONFIRMATION, and enforcement ON in the database (last: the enforcement table is append-only).
 *   (a) the INSERT is in the same transaction as the spend: a failure after consume, and the INSERT itself failing,
 *       both roll the spend back — the same link then confirms.
 *   (b) BINDING_MISMATCH: details changed after the link was sent → no row, link unspent; a NEW link works.
 *   (c) after a declaration the identity is locked: the #1091 trigger refuses each identity column as the runtime,
 *       and the API gate (the function the profile PATCH calls) refuses too.
 *   (d) a Google-only account (password NULL) end to end → a row with reauthMethod EMAIL_LINK.
 *   E   the REAL issue chain with enforcement ON: a blocked attempt consumes no number → declare → issue (number 1)
 *       → duplicate attempt (no 2nd number) → PDF (stored, same hash) → next number 2; multi-user stays blocked;
 *       Google-only company; a document issued before the declaration keeps status/number/snapshot/PDF hash.
 *
 *   OWNER_URL=… AUTH_URL=… RUNTIME_URL=… npx tsx .issuer-declaration/declaration-flow.battery.mts
 *   NEG=non-atomic … — negative proof: the spend in its own transaction; (a) must FAIL.
 * Synthetic only. ZERO secrets. ZERO network.
 */
import { inspect } from "node:util";
import { PrismaClient } from "@prisma/client";

const OWNER_URL = process.env.OWNER_URL!;
process.env.AUTH_PLANE_ENABLED = "true";
process.env.AUTH_DATABASE_URL = process.env.AUTH_URL!;
process.env.DATABASE_URL = process.env.RUNTIME_URL!;
process.env.DIRECT_URL = process.env.RUNTIME_URL!;
process.env.AUTH_TOKEN_SECRET ??= "idc-battery-synthetic-token-secret-0123456789abcdef";
process.env.RATE_LIMIT_BACKEND = "memory";
process.env.BILLING_PDF_STORAGE_ROOT ??= `/tmp/idc-billing-pdf-${process.pid}`;

const counts: Record<string, { pass: number; fail: number }> = {};
const failures: string[] = [];
function ok(group: string, name: string, cond: boolean, detail: unknown = "") {
  counts[group] ??= { pass: 0, fail: 0 };
  if (cond) {
    counts[group].pass += 1;
    console.log(`  [PASS] ${group} ${name}`);
  } else {
    counts[group].fail += 1;
    failures.push(`${group} ${name}`);
    console.log(`  [FAIL] ${group} ${name}${detail === "" ? "" : " — " + (typeof detail === "string" ? detail : JSON.stringify(detail))}`);
  }
}
type Rows = Record<string, unknown>[];
const errText = (e: unknown) => inspect(e, { depth: 6 }).replace(/\s+/g, " ");
let seq = 0;

const ID = "000000018";
const COMPANY = "510000003";

async function main() {
  const owner = new PrismaClient({ datasourceUrl: OWNER_URL });
  const q = (sql: string, ...a: unknown[]) => owner.$queryRawUnsafe(sql, ...a) as Promise<Rows>;
  const x = (sql: string, ...a: unknown[]) => owner.$executeRawUnsafe(sql, ...a);
  const svc = await import("../lib/services/billing/issuer-declaration/issuer-declaration.service");
  const gates = await import("../lib/services/billing/issuer-declaration/issuer-declaration-gates");
  const link = await import("../lib/auth/issuer-declaration-link");
  const { tenantTx } = await import("../lib/tenant/tenant-tx");
  const { renderStored } = await import("../lib/email/transactional/registry");
  const { ConflictError, ValidationError } = await import("../lib/errors");

  type Kind = "EXEMPT_DEALER" | "AUTHORIZED_DEALER" | "LTD_COMPANY";
  const account = async (tag: string, opts: { kind?: Kind; password?: boolean; vat?: string | null; users?: number; name?: string | null } = {}) => {
    const kind = opts.kind ?? "AUTHORIZED_DEALER";
    const b = Number((await q(`INSERT INTO "Business" ("name","updatedAt") VALUES ($1, now()) RETURNING id`, `idc-${tag}-${++seq}`))[0].id);
    const mk = async (i: number) =>
      Number((await q(`INSERT INTO "User" ("email","password","name","businessId","updatedAt") VALUES ($1,$2,$3,$4, now()) RETURNING id`,
        `idc-${tag}-${Date.now()}-${seq}-${i}@lab.invalid`, opts.password === false ? null : "$2b$10$" + "A".repeat(53),
        opts.name === undefined ? "דנה כהן" : opts.name, b))[0].id);
    const userId = await mk(0);
    for (let i = 1; i < (opts.users ?? 1); i += 1) await mk(i);
    const tax = kind === "LTD_COMPANY" ? COMPANY : ID;
    const vat = opts.vat !== undefined ? opts.vat : kind === "EXEMPT_DEALER" ? null : tax;
    await x(`INSERT INTO "BusinessProfile" ("businessId","billingLegalName","billingBusinessKind","billingTaxId","billingVatNumber",
               "billingAddress","billingPhone","billingEmail","updatedAt")
             VALUES ($1,'דנה כהן שירותים',$2,$3,$4,'הרצל 1, תל אביב','050-1234567','dana@example.test', now())`, b, kind, tax, vat);
    return { id: userId, businessId: b };
  };
  const tokenOf = async (emailId: number) => {
    const row = (await q(`SELECT "kind","payload" FROM "TransactionalEmail" WHERE id = $1`, emailId))[0];
    const r = renderStored(String(row.kind), row.payload, { appBaseUrl: "https://app.lab.test" });
    const m = r ? /#t=([0-9a-f-]{36}\.[A-Za-z0-9_-]{43})/.exec(r.text) : null;
    return { kind: String(row.kind), token: m ? m[1] : "" };
  };
  const request = async (u: { id: number; businessId: number }) => {
    const r = await svc.requestDeclarationLink(u, new Date());
    return r.outcome === "SENT" ? { ...r, ...(await tokenOf(r.emailId)) } : { ...r, token: "", kind: "" };
  };
  // NEGATIVE PROOF (NEG=non-atomic): spend the link in its OWN committed transaction instead of the confirm's —
  // (a) must then fail (a failure after the spend leaves the link spent).
  const nonAtomic = process.env.NEG === "non-atomic";
  const depsFor = (u: { businessId: number }) =>
    nonAtomic
      ? {
          request: link.requestIssuerDeclarationLink,
          consume: ((_tx: unknown, input: Parameters<typeof link.consumeIssuerDeclarationLink>[1]) =>
            tenantTx(u.businessId, (own) => link.consumeIssuerDeclarationLink(own, input))) as typeof link.consumeIssuerDeclarationLink,
        }
      : undefined;
  const confirm = (u: { id: number; businessId: number }, token: unknown, hooks?: Parameters<typeof svc.confirmDeclaration>[4]) =>
    svc.confirmDeclaration(u, token, new Date(), depsFor(u), hooks).then((r) => r.outcome as string).catch((e) => `ERROR ${errText(e).slice(0, 300)}`);
  const decls = async (b: number) => q(`SELECT * FROM "BusinessIssuerDeclaration" WHERE "businessId" = $1 ORDER BY version`, b);
  const tokenCount = async (u: number) => Number((await q(`SELECT count(*) n FROM "AuthEmailToken" WHERE "userId" = $1 AND purpose = 'ISSUER_DECLARATION'`, u))[0].n);

  console.log("D3 — confirm-transaction outcomes");
  {
    const u = await account("d3-main");
    const r = await request(u);
    ok("D3", "request on a complete one-user business → SENT", r.outcome === "SENT", r.outcome);
    ok("D3", "the email row is ISSUER_DECLARATION and carries a usable token", r.kind === "ISSUER_DECLARATION" && r.token.length > 40, r.kind);
    ok("D3", "check → VALID", (await link.checkIssuerDeclarationLink(r.token)) === "VALID");
    const ctx = await svc.loadIssuerDeclarationContext(u.businessId, u.id);
    const got = await confirm(u, r.token);
    ok("D3", "confirm → CONFIRMED", got === "CONFIRMED", got);
    const rows = await decls(u.businessId);
    const d = rows[0] ?? {};
    ok("D3", "exactly one declaration row, version 1, no predecessor", rows.length === 1 && Number(d.version) === 1 && d.supersedesId === null, rows.length);
    ok("D3", "row: INITIAL, AUTHORIZED_DEALER_INDIVIDUAL / INDIVIDUAL / AUTHORIZED / ISRAELI_ID",
      d.kind === "INITIAL" && d.track === "AUTHORIZED_DEALER_INDIVIDUAL" && d.legalForm === "INDIVIDUAL" && d.vatStatus === "AUTHORIZED" && d.idType === "ISRAELI_ID", d);
    ok("D3", "row: identity exactly the stored profile", d.legalName === "דנה כהן שירותים" && d.idNumber === ID && d.vatRegistrationNumber === ID && d.phone === "050-1234567");
    ok("D3", "row: SOLE_USER_VERIFIED, declared by = authorized = the signed-in user",
      d.authorityBasis === "SOLE_USER_VERIFIED" && Number(d.declaredByUserId) === u.id && Number(d.authorizedUserId) === u.id);
    ok("D3", "row: statementSha256 = the canonical digest recomputed before confirming", d.statementSha256 === ctx.statementSha256 && d.statementVersion === "issuer-declaration-he-v1", { row: d.statementSha256, ctx: ctx.statementSha256 });
    ok("D3", "row: declarant name and capacity", d.declarantName === "דנה כהן" && d.declarantCapacity === "בעל העסק");
    ok("D3", "the link is now spent (check → USED)", (await link.checkIssuerDeclarationLink(r.token)) === "USED");
    ok("D3", "confirm again → ALREADY_DECLARED, still one row", (await confirm(u, r.token)) === "ALREADY_DECLARED" && (await decls(u.businessId)).length === 1);
    const again = await request(u);
    ok("D3", "request after a declaration → ALREADY_DECLARED, no new token", again.outcome === "ALREADY_DECLARED" && (await tokenCount(u.id)) === 1, again.outcome);
  }
  {
    const u = await account("d3-forged");
    await request(u);
    const forged = `${"0".repeat(8)}-0000-4000-8000-${"0".repeat(12)}.${"A".repeat(43)}`;
    ok("D3", "a forged token → INVALID, no row", (await confirm(u, forged)) === "INVALID" && (await decls(u.businessId)).length === 0);
    ok("D3", "a missing token → INVALID, no row", (await confirm(u, undefined)) === "INVALID" && (await decls(u.businessId)).length === 0);
  }
  {
    const a = await account("d3-owner-a");
    const bAcc = await account("d3-owner-b");
    const r = await request(a);
    const got = await confirm(bAcc, r.token);
    ok("D3", "another account (its own business) confirming A's link → INVALID, nothing recorded anywhere",
      got === "INVALID" && (await decls(a.businessId)).length === 0 && (await decls(bAcc.businessId)).length === 0, got);
    ok("D3", "A's link is still VALID after B's attempt", (await link.checkIssuerDeclarationLink(r.token)) === "VALID");
  }
  {
    const u = await account("d3-superseded");
    const first = await request(u);
    const second = await request(u);
    ok("D3", "the first of two links → SUPERSEDED, no row", (await confirm(u, first.token)) === "SUPERSEDED" && (await decls(u.businessId)).length === 0);
    ok("D3", "the latest link → CONFIRMED", (await confirm(u, second.token)) === "CONFIRMED");
  }
  {
    const u = await account("d3-expired");
    const r = await request(u);
    await x(`UPDATE "AuthEmailToken" SET "expiresAt" = timezone('UTC', now()) - interval '1 minute', "createdAt" = timezone('UTC', now()) - interval '31 minutes' WHERE "userId" = $1`, u.id);
    ok("D3", "an expired link → EXPIRED, no row", (await confirm(u, r.token)) === "EXPIRED" && (await decls(u.businessId)).length === 0);
  }
  {
    const u = await account("d3-incomplete", { kind: "AUTHORIZED_DEALER", vat: null });
    const r = await request(u);
    ok("D3", "incomplete details (authorized, no VAT number) → INCOMPLETE with the problem, no token",
      r.outcome === "INCOMPLETE" && (r as { problems?: { field: string }[] }).problems?.[0]?.field === "billingVatNumber" && (await tokenCount(u.id)) === 0, r);
  }
  {
    const u = await account("d3-two-users", { users: 2 });
    const r = await request(u);
    ok("D3", "a two-user business → NEEDS_DESIGNATION, no token", r.outcome === "NEEDS_DESIGNATION" && (await tokenCount(u.id)) === 0, r.outcome);
  }
  {
    const u = await account("d3-exempt", { kind: "EXEMPT_DEALER" });
    const r = await request(u);
    const got = await confirm(u, r.token);
    const d = (await decls(u.businessId))[0] ?? {};
    ok("D3", "exempt dealer → CONFIRMED: EXEMPT_DEALER / EXEMPT / no VAT number", got === "CONFIRMED" && d.track === "EXEMPT_DEALER" && d.vatStatus === "EXEMPT" && d.vatRegistrationNumber === null, { got, d });
  }
  {
    const u = await account("d3-company", { kind: "LTD_COMPANY" });
    const r = await request(u);
    const got = await confirm(u, r.token);
    const d = (await decls(u.businessId))[0] ?? {};
    ok("D3", "company → CONFIRMED: COMPANY_AUTHORIZED_DEALER / COMPANY_NUMBER / VAT number / signatory capacity",
      got === "CONFIRMED" && d.track === "COMPANY_AUTHORIZED_DEALER" && d.idType === "COMPANY_NUMBER" && d.vatRegistrationNumber === COMPANY && d.declarantCapacity === "מורשה חתימה מטעם החברה", { got, d });
  }
  {
    const u = await account("d3-existing");
    const cust = Number((await q(`INSERT INTO "Customer" ("businessId", name, "updatedAt") VALUES ($1,'לקוח', now()) RETURNING id`, u.businessId))[0].id);
    await x(`INSERT INTO "BillingDocument" ("businessId","documentType","status","customerId","customerNameSnapshot","currency","subtotalAmount","vatAmount",
               "totalAmount","documentNumber","documentNumberFormatted","issuedAt","createdAt","updatedAt")
             VALUES ($1,'TAX_INVOICE','ISSUED',$2,'לקוח','ILS',100,18,118,1,'000001', now(), now(), now())`, u.businessId, cust);
    const r = await request(u);
    const got = await confirm(u, r.token);
    ok("D3", "a business that already issued → EXISTING_CONFIRMATION", got === "CONFIRMED" && (await decls(u.businessId))[0]?.kind === "EXISTING_CONFIRMATION", got);
  }

  console.log("(a) — the INSERT is in the spend's transaction");
  {
    const u = await account("a-atomic");
    const r = await request(u);
    const thrown = await confirm(u, r.token, { afterConsume: async () => { throw new Error("forced failure after consume"); } });
    ok("(a)", "a failure after a CONFIRMED consume → the confirm fails", thrown.startsWith("ERROR") && thrown.includes("forced failure after consume"), thrown);
    ok("(a)", "… no declaration row", (await decls(u.businessId)).length === 0);
    ok("(a)", "… the link is unspent (check → VALID)", (await link.checkIssuerDeclarationLink(r.token)) === "VALID");
    // The INSERT itself fails: the hook takes version 1 first (inside the same tx), so the real INSERT violates
    // (businessId, version) — the hook's row, the INSERT and the spend all roll back together.
    const insertFails = await confirm(u, r.token, {
      afterConsume: async (tx) => {
        await tx.$executeRawUnsafe(
          `INSERT INTO "BusinessIssuerDeclaration" ("businessId","version","kind","track","legalForm","vatStatus","legalName","idType","idNumber",
             "vatRegistrationNumber","address","phone","email","effectiveFrom","authorizedUserId","authorityBasis","declaredByUserId","declarantName",
             "declarantCapacity","statementVersion","statementSha256","reauthMethod","reauthAt")
           VALUES ($1,1,'INITIAL','AUTHORIZED_DEALER_INDIVIDUAL','INDIVIDUAL','AUTHORIZED','x','ISRAELI_ID','000000018','000000018','x','x','x@x.test',
             now(),$2,'SOLE_USER_VERIFIED',$2,'x','x','issuer-declaration-he-v1',repeat('b',64),'EMAIL_LINK',now())`, u.businessId, u.id);
      },
    });
    ok("(a)", "the declaration INSERT itself failing → the confirm fails", insertFails.startsWith("ERROR"), insertFails.slice(0, 160));
    ok("(a)", "… no declaration row (not even the hook's)", (await decls(u.businessId)).length === 0);
    ok("(a)", "… the link is still unspent (check → VALID)", (await link.checkIssuerDeclarationLink(r.token)) === "VALID");
    ok("(a)", "the same link then confirms → CONFIRMED, one row", (await confirm(u, r.token)) === "CONFIRMED" && (await decls(u.businessId)).length === 1);
  }

  console.log("(b) — BINDING_MISMATCH");
  {
    const u = await account("b-mismatch");
    const r = await request(u);
    await x(`UPDATE "BusinessProfile" SET "billingPhone" = '050-7654321' WHERE "businessId" = $1`, u.businessId);
    const got = await confirm(u, r.token);
    ok("(b)", "details changed after the link was sent → BINDING_MISMATCH", got === "BINDING_MISMATCH", got);
    ok("(b)", "… no declaration row", (await decls(u.businessId)).length === 0);
    const spent = Number((await q(`SELECT count(*) n FROM "AuthEmailToken" WHERE "userId" = $1 AND "consumedAt" IS NOT NULL`, u.id))[0].n);
    ok("(b)", "… the link is unspent (consumedAt NULL, check → VALID)", spent === 0 && (await link.checkIssuerDeclarationLink(r.token)) === "VALID");
    const fresh = await request(u);
    ok("(b)", "a NEW link for the changed details → SENT", fresh.outcome === "SENT");
    const got2 = await confirm(u, fresh.token);
    const d = (await decls(u.businessId))[0] ?? {};
    ok("(b)", "the new link → CONFIRMED with the changed details", got2 === "CONFIRMED" && d.phone === "050-7654321", { got2, phone: d.phone });
    ok("(b)", "the old link is now SUPERSEDED (closed by the new one)", (await link.checkIssuerDeclarationLink(r.token)) === "SUPERSEDED");
  }

  console.log("(c) — identity locked after a declaration");
  {
    const u = await account("c-lock");
    const r = await request(u);
    ok("(c)", "setup: declaration CONFIRMED", (await confirm(u, r.token)) === "CONFIRMED");
    const asRuntime = (set: string) =>
      tenantTx(u.businessId, (tx) => tx.$executeRawUnsafe(`UPDATE "BusinessProfile" SET ${set} WHERE "businessId" = $1`, u.businessId))
        .then(() => "OK").catch((e) => errText(e));
    for (const [col, val] of [["billingLegalName", "'שם אחר'"], ["billingTaxId", "'999999998'"], ["billingVatNumber", "'999999998'"], ["billingBusinessKind", "'LTD_COMPANY'"]]) {
      const res = await asRuntime(`"${col}" = ${val}`);
      ok("(c)", `the #1091 trigger refuses ${col} as the runtime (DZD35)`, res.includes("ISSUER_PROFILE_IDENTITY_LOCKED"), res.slice(0, 160));
    }
    ok("(c)", "re-writing the declared values is allowed", (await asRuntime(`"billingLegalName" = 'דנה כהן שירותים', "billingTaxId" = '${ID}'`)) === "OK");
    ok("(c)", "a non-identity column is not locked", (await asRuntime(`"billingPhone" = '050-1111111'`)) === "OK");
    const before = (await q(`SELECT "billingBusinessKind","billingLegalName","billingTaxId","billingVatNumber" FROM "BusinessProfile" WHERE "businessId" = $1`, u.businessId))[0] as Record<string, string | null>;
    const api = (write: Record<string, string | null>) =>
      tenantTx(u.businessId, (tx) => gates.assertIssuerIdentityEditableTx(tx, u.businessId, before, write))
        .then(() => "OK").catch((e) => (e instanceof ConflictError ? "CONFLICT" : errText(e)));
    for (const f of ["billingLegalName", "billingTaxId", "billingVatNumber", "billingBusinessKind"]) {
      const res = await api({ [f]: f === "billingBusinessKind" ? "LTD_COMPANY" : "999999998" });
      ok("(c)", `the API gate refuses ${f} (409)`, res === "CONFLICT", res);
    }
    ok("(c)", "the API gate passes a non-identity save", (await api({ billingFooterNote: "תודה" })) === "OK");
    const other = await account("c-undeclared");
    const ob = (await q(`SELECT "billingBusinessKind","billingLegalName","billingTaxId","billingVatNumber" FROM "BusinessProfile" WHERE "businessId" = $1`, other.businessId))[0] as Record<string, string | null>;
    const otherRes = await tenantTx(other.businessId, (tx) => gates.assertIssuerIdentityEditableTx(tx, other.businessId, ob, { billingTaxId: "999999998" })).then(() => "OK").catch((e) => errText(e));
    ok("(c)", "a business with no declaration can still edit its identity (draft)", otherRes === "OK", otherRes);
  }

  console.log("(d) — Google-only account (password NULL)");
  {
    const u = await account("d-google", { password: false });
    const pw = (await q(`SELECT password FROM "User" WHERE id = $1`, u.id))[0].password;
    ok("(d)", "setup: the account has no password", pw === null);
    const r = await request(u);
    ok("(d)", "request → SENT", r.outcome === "SENT", r.outcome);
    const got = await confirm(u, r.token);
    ok("(d)", "confirm → CONFIRMED", got === "CONFIRMED", got);
    const d = (await decls(u.businessId))[0] ?? {};
    ok("(d)", "a declaration row with reauthMethod EMAIL_LINK", d.reauthMethod === "EMAIL_LINK" && Number(d.declaredByUserId) === u.id, d.reauthMethod);
  }


  // ---- E: the real issue chain (issueBillingDocument → number → PDF → deliverable), no ITA call anywhere ----
  const { issueBillingDocument } = await import("../lib/services/billing/billing-issue.service");
  const { getOrRenderBillingPdf } = await import("../lib/services/billing/billing-pdf.service");
  const noIta = { executeApproval: async () => { throw new Error("LAB: the tax authority must not be called"); } };
  const mkDraft = async (b: number) => {
    const cust = Number((await q(`INSERT INTO "Customer" ("businessId", name, "updatedAt") VALUES ($1,'לקוח פרטי', now()) RETURNING id`, b))[0].id);
    const id = Number((await q(`INSERT INTO "BillingDocument" ("businessId","documentType","status","customerId","customerNameSnapshot","currency","subtotalAmount",
        "vatAmount","totalAmount","createdAt","updatedAt") VALUES ($1,'TAX_INVOICE','DRAFT',$2,'לקוח פרטי','ILS',100,18,118, now(), now()) RETURNING id`, b, cust))[0].id);
    await x(`INSERT INTO "BillingDocumentLine" ("billingDocumentId","lineIndex","description","quantity","unitPrice","vatRatePercent","lineSubtotal","vatAmount","lineTotal","updatedAt")
             VALUES ($1,0,'שירות',1,100,18,100,18,118, now())`, id);
    return id;
  };
  type IssueOut = { ok: true; n: number | null; authority: string } | { ok: false; err: string };
  const issueReal = (u: { id: number; businessId: number }, id: number): Promise<IssueOut> =>
    issueBillingDocument({ businessId: u.businessId, billingDocumentId: id, actorUserId: u.id }, noIta as never)
      .then((r): IssueOut => ({ ok: true, n: r.document.documentNumber ?? null, authority: JSON.stringify(r.authority).slice(0, 120) }))
      .catch((e): IssueOut => ({ ok: false, err: errText(e).slice(0, 300) }));
  const seqNext = async (b: number) => {
    const r = await q(`SELECT "nextNumber" FROM "BillingDocumentNumberSequence" WHERE "businessId" = $1 AND "documentType" = 'TAX_INVOICE'`, b);
    return r.length ? Number(r[0].nextNumber) : null;
  };
  const docState = async (id: number) =>
    (await q(`SELECT status::text AS status, "documentNumber" AS n, md5("issuedSnapshot"::text) AS snap, "pdfHash" FROM "BillingDocument" WHERE id = $1`, id))[0] as
      { status: string; n: number | null; snap: string | null; pdfHash: string | null };
  const pdfOf = (u: { id: number; businessId: number }, id: number) =>
    getOrRenderBillingPdf({ businessId: u.businessId, billingDocumentId: id, actorUserId: u.id })
      .then((r) => ({ ok: true as const, bytes: r.buffer.length, head: r.buffer.subarray(0, 5).toString("latin1"), hash: r.pdfHash, number: r.documentNumberFormatted }))
      .catch((e) => ({ ok: false as const, err: errText(e).slice(0, 300) }));
  const countDocs = async (b: number) => Number((await q(`SELECT count(*) n FROM "BillingDocument" WHERE "businessId" = $1 AND status = 'ISSUED'`, b))[0].n);

  console.log("E0 — before enforcement: a legacy business issues for real (its document must survive the declaration untouched)");
  const legacy = await account("e-legacy");
  const legacyDoc = await mkDraft(legacy.businessId);
  const l1 = await issueReal(legacy, legacyDoc);
  ok("E", "E0 enforcement OFF: an undeclared business issues (number 1) — today's behaviour unchanged", l1.ok && l1.n === 1, l1);
  const legacyPdf = await pdfOf(legacy, legacyDoc);
  ok("E", "E0 its PDF renders (%PDF) and is deliverable (no authority hold)", legacyPdf.ok && legacyPdf.head === "%PDF-", legacyPdf);
  const legacyBefore = await docState(legacyDoc);

  console.log("D3 — enforcement ON in the database (lab only; last, the switch is append-only)");
  {
    const undeclared = await account("d3-enf-none");
    const declared = await account("d3-enf-decl");
    const r = await request(declared);
    await confirm(declared, r.token);
    const draft = async (b: number) => {
      const cust = Number((await q(`INSERT INTO "Customer" ("businessId", name, "updatedAt") VALUES ($1,'לקוח', now()) RETURNING id`, b))[0].id);
      return Number((await q(`INSERT INTO "BillingDocument" ("businessId","documentType","status","customerId","customerNameSnapshot","currency","subtotalAmount",
          "vatAmount","totalAmount","createdAt","updatedAt") VALUES ($1,'TAX_INVOICE','DRAFT',$2,'לקוח','ILS',100,18,118, now(), now()) RETURNING id`, b, cust))[0].id);
    };
    const gate = (b: number, profile: Record<string, string | null> | null) =>
      tenantTx(b, (tx) => gates.assertIssuerDeclarationForIssueTx(tx, { businessId: b, documentType: "TAX_INVOICE", profile }))
        .then(() => "PASS").catch((e) => (e instanceof ValidationError ? "REFUSED" : errText(e)));
    const prof = async (b: number) => (await q(`SELECT "billingBusinessKind","billingLegalName","billingTaxId","billingVatNumber","billingAddress","billingPhone","billingEmail" FROM "BusinessProfile" WHERE "businessId" = $1`, b))[0] as Record<string, string | null>;
    ok("D3", "OFF: the gate passes a business with no declaration", (await gate(undeclared.businessId, await prof(undeclared.businessId))) === "PASS");
    await x(`INSERT INTO "IssuerDeclarationEnforcement" ("enforcedFrom","recordedBy") VALUES (now(), 'lab: declaration-flow battery')`);
    ok("D3", "ON: the gate refuses a business with no declaration", (await gate(undeclared.businessId, await prof(undeclared.businessId))) === "REFUSED");
    ok("D3", "ON: the gate passes a declared business with complete details", (await gate(declared.businessId, await prof(declared.businessId))) === "PASS");
    const d1 = await draft(undeclared.businessId);
    const issueRaw = (b: number, id: number) =>
      tenantTx(b, (tx) => tx.$executeRawUnsafe(`UPDATE "BillingDocument" SET status = 'ISSUED', "issuedAt" = now(), "documentNumber" = 1, "documentNumberFormatted" = '000001' WHERE id = $1`, id))
        .then(() => "OK").catch((e) => errText(e));
    const res = await issueRaw(undeclared.businessId, d1);
    ok("D3", "ON: the database backstop refuses ISSUED without a declaration (DZD34)", res.includes("ISSUER_DECLARATION_REQUIRED_TO_ISSUE"), res.slice(0, 160));
  }

  console.log("E — enforcement ON: signup kind → details → declaration → issue → number → PDF → deliverable, end to end");
  {
    // Signup collects the kind only (#1103 seeds billingBusinessKind); the details are completed on the profile.
    const u = await account("e-chain", { kind: "AUTHORIZED_DEALER" });
    const d = await mkDraft(u.businessId);
    const seq0 = await seqNext(u.businessId);
    const blocked = await issueReal(u, d);
    ok("E", "E1 no declaration → the real issue is refused", !blocked.ok && blocked.err.includes("ValidationError"), blocked);
    const afterBlock = await docState(d);
    const seqAfterBlock = await seqNext(u.businessId);
    ok("E", "E1 … the draft stays DRAFT with no number, and the sequence is untouched (a blocked attempt consumes no number)",
      afterBlock.status === "DRAFT" && afterBlock.n === null && seqAfterBlock === seq0, { afterBlock, seq0, seqAfterBlock });

    const r = await request(u);
    ok("E", "E2 request → SENT (email link bound to account + business + digest)", r.outcome === "SENT", r.outcome);
    ok("E", "E2 confirm → CONFIRMED", (await confirm(u, r.token)) === "CONFIRMED");
    ok("E", "E2 the link cannot be reused (ALREADY_DECLARED, link USED, one declaration)",
      (await confirm(u, r.token)) === "ALREADY_DECLARED" && (await decls(u.businessId)).length === 1 && (await link.checkIssuerDeclarationLink(r.token)) === "USED");

    const ok1 = await issueReal(u, d);
    ok("E", "E3 declared → the same draft issues, number 1", ok1.ok && ok1.n === 1, ok1);
    ok("E", "E3 … the sequence advanced exactly once (nextNumber 2)", (await seqNext(u.businessId)) === 2, await seqNext(u.businessId));
    const dup = await issueReal(u, d);
    ok("E", "E4 issuing the same document again: no second number, no second document",
      (await seqNext(u.businessId)) === 2 && (await countDocs(u.businessId)) === 1 && Number((await docState(d)).n) === 1, { dup, seq: await seqNext(u.businessId) });
    const p1 = await pdfOf(u, d);
    ok("E", "E5 the PDF renders (%PDF) with the issued number — delivery guard passes (NOT_REQUIRED)", p1.ok && p1.head === "%PDF-" && String(p1.ok ? p1.number : "").endsWith("1"), p1);
    const p2 = await pdfOf(u, d);
    ok("E", "E5 … a second fetch returns the stored PDF (same hash, number unchanged)",
      p1.ok && p2.ok && p1.hash === p2.hash && Number((await docState(d)).n) === 1, { p1, p2 });
    const ok2 = await issueReal(u, await mkDraft(u.businessId));
    ok("E", "E6 the next document takes number 2 (series continues, no gap)", ok2.ok && ok2.n === 2, ok2);

    // A multi-user business cannot self-declare; it stays blocked at issue (no first-user inference).
    const two = await account("e-two", { users: 2 });
    const tr = await request(two);
    const twoIssue = await issueReal(two, await mkDraft(two.businessId));
    ok("E", "E7 a multi-user business: NEEDS_DESIGNATION, and issue stays refused", tr.outcome === "NEEDS_DESIGNATION" && !twoIssue.ok, { out: tr.outcome, twoIssue });

    // Google-only company account: kind → details → declaration (EMAIL_LINK) → issue.
    const g = await account("e-google", { password: false, kind: "LTD_COMPANY" });
    const gr = await request(g);
    const gc = await confirm(g, gr.token);
    const gi = await issueReal(g, await mkDraft(g.businessId));
    ok("E", "E8 a Google-only company account: CONFIRMED with EMAIL_LINK → issues number 1",
      gc === "CONFIRMED" && gi.ok && gi.n === 1 && (await decls(g.businessId))[0]?.reauthMethod === "EMAIL_LINK", { gc, gi });

    // The legacy business declares after the fact: its old document is untouched; its series continues.
    const lr = await request(legacy);
    const lc = await confirm(legacy, lr.token);
    ok("E", "E9 the legacy business declares → EXISTING_CONFIRMATION", lc === "CONFIRMED" && (await decls(legacy.businessId))[0]?.kind === "EXISTING_CONFIRMATION", lc);
    const legacyAfter = await docState(legacyDoc);
    const legacyPdf2 = await pdfOf(legacy, legacyDoc);
    ok("E", "E9 … its old document: same status, number, snapshot and PDF hash",
      JSON.stringify(legacyAfter) === JSON.stringify(legacyBefore) && legacyPdf.ok && legacyPdf2.ok && legacyPdf.hash === legacyPdf2.hash, { legacyBefore, legacyAfter });
    const ln = await issueReal(legacy, await mkDraft(legacy.businessId));
    ok("E", "E9 … and its series continues at 2 (no reset)", ln.ok && ln.n === 2, ln);
  }

  await owner.$disconnect();
  const groups = ["D3", "(a)", "(b)", "(c)", "(d)", "E"];
  console.log("\nSUMMARY");
  for (const g of groups) console.log(`  ${g}: ${counts[g]?.pass ?? 0}/${(counts[g]?.pass ?? 0) + (counts[g]?.fail ?? 0)}`);
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
