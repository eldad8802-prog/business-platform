/**
 * Service Desk case charge (migration 20261126090000, DRAFT) — the database guards AS the real runtime role, on the P4
 * lab (.sd3p4/lab.sh <db> then --deploy-only) with 20261125090000 (#1096) and 20261126090000 applied by psql as the lab
 * owner. Synthetic only. The balance arithmetic itself is pure and proven in case-balance.test.ts.
 *
 *   C  charge history: gap-free seq per case; a change after the first record needs a reason; NO_CHARGE needs a reason
 *      and no amount; amount > 0, ILS only; a quote-sourced amount must be that approved version; the acting owner is a
 *      user of the business; never updated, deleted or truncated; another business's case cannot be charged.
 *   L  billing links: the document exists in THIS business (another business's id is refused); its type fits the role
 *      (CHARGE = tax invoice or tax invoice / receipt, STANDALONE_PAYMENT = an ISSUED receipt; a quote never); at most one active
 *      link per document (also across cases); a draft may be linked (the reader decides UNKNOWN, nothing is frozen);
 *      unlink once with who and why; nothing else changes; never deleted; after an unlink the document may be linked
 *      again (history kept).
 *   U  a deleted user (owner decision 2026-11-12): the user who recorded a charge / linked a document can be deleted —
 *      the FK only nulls the reference, nothing else on the row moves; no direct UPDATE (not even the table owner's)
 *      nulls or re-points who acted; a new owner charge without its user is still refused (SERVICE_CHARGE_ACTOR).
 *   I  isolation: another business reads none of it and cannot write into it.
 *   E  erasure: refused unless the business is being deleted; then who acted and the reasons are blanked in place,
 *      amounts / document ids / times kept; re-run safe; the runtime cannot imitate the scrub.
 *
 * env: OWNER_URL (lab owner — fixtures), DATABASE_URL = DIRECT_URL (app_runtime_prod), TASK_REQUEST_HMAC_KEY / _ID,
 *      AUTH_TOKEN_SECRET.
 */
import { PrismaClient } from "@prisma/client";

import { uuidV7 } from "../lib/services/tasks/task-idempotency";
import { openCase, type ServiceDeskPrincipal } from "../lib/services/service-desk/service-case.service";

const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });
const runtime = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL! });
let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); } else { failures.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}
type Rows = Record<string, unknown>[];
const q = (sql: string, ...a: unknown[]) => owner.$queryRawUnsafe(sql, ...a) as Promise<Rows>;
const x = (sql: string, ...a: unknown[]) => owner.$executeRawUnsafe(sql, ...a);
const key = () => uuidV7(new Date());
const err = (e: unknown) => (e as Error).message.replace(/\s+/g, " ").trim();
/** Runs statements AS the runtime role inside one tenant transaction; "OK" or the database's refusal. */
async function rt(b: number, ...stmts: [string, ...unknown[]][]): Promise<string> {
  try {
    await runtime.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_business_id', $1, true)`, String(b));
      for (const [sql, ...a] of stmts) await tx.$executeRawUnsafe(sql, ...a);
    });
    return "OK";
  } catch (e) { return `ERR:${err(e).slice(-260)}`; }
}
async function rtRows(b: number, sql: string, ...a: unknown[]): Promise<Rows> {
  return runtime.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('app.current_business_id', $1, true)`, String(b));
    return (await tx.$queryRawUnsafe(sql, ...a)) as Rows;
  });
}
/** Lab owner, in a tenant context (the new tables are FORCE RLS: the owner too sees only the tenant's rows). */
async function own<T = Rows>(b: number, sql: string, ...a: unknown[]): Promise<T> {
  return owner.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('app.current_business_id', $1, true)`, String(b));
    return (await tx.$queryRawUnsafe(sql, ...a)) as T;
  });
}

const t = Date.now();
async function business(tag: string) {
  const b = Number((await q(`INSERT INTO "Business" (name, "updatedAt") VALUES ($1, now()) RETURNING id`, `sdcharge-${tag}-${t}`))[0].id);
  const u = Number((await q(`INSERT INTO "User" (email, "businessId", "updatedAt") VALUES ($1, $2, now()) RETURNING id`, `sdcharge-${tag}-${t}@lab.invalid`, b))[0].id);
  const cust = Number((await q(`INSERT INTO "Customer" ("businessId", name, "updatedAt") VALUES ($1, 'לקוח סינתטי', now()) RETURNING id`, b))[0].id);
  return { b, u, cust, p: { businessId: b, userId: u } as ServiceDeskPrincipal };
}
type Biz = Awaited<ReturnType<typeof business>>;
const shopCase = async (z: Biz) =>
  (await openCase(z.p, { kind: "IN_SHOP", customerId: z.cust, problemDescription: "לא נדלק" }, { idempotencyKey: key() })).case.id;
/** Synthetic billing document fixture (the lab owner writes it; billing code is not involved). */
async function billingDoc(z: Biz, type: string, status: "DRAFT" | "ISSUED", total: number): Promise<number> {
  const rows = await own(z.b, `INSERT INTO "BillingDocument" ("businessId", "documentType", status, "totalAmount", currency, "issuedAt", "updatedAt")
    VALUES ($1, $2::"BillingDocumentType", $3::"BillingDocumentStatus", $4, 'ILS', CASE WHEN $3 = 'ISSUED' THEN now() END, now()) RETURNING id`, z.b, type, status, total);
  return Number(rows[0].id);
}
const charge = (z: Biz, caseId: number, seq: number, mode: string, amount: number | null, source: string | null, reason: string | null, extra = ""): [string, ...unknown[]] =>
  [`INSERT INTO "ServiceCaseCharge" ("businessId", "caseId", seq, mode, "amountAgorot", source, reason, actor, "actorUserId"${extra ? ", " + extra.split("=")[0] : ""})
    VALUES ($1, $2, $3, $4::"ServiceChargeMode", $5, $6::"ServiceChargeSource", $7, 'OWNER_USER', $8${extra ? ", " + extra.split("=")[1] : ""})`,
   z.b, caseId, seq, mode, amount, source, reason, z.u];
const link = (z: Biz, caseId: number, doc: number, role: string, by = z.u): [string, ...unknown[]] =>
  [`INSERT INTO "ServiceCaseBillingLink" ("businessId", "caseId", "billingDocumentId", role, "linkedByUserId") VALUES ($1, $2, $3, $4::"ServiceBillingLinkRole", $5)`,
   z.b, caseId, doc, role, by];

async function main() {
  const A = await business("a");
  const B = await business("b");
  const a1 = await shopCase(A);
  const a2 = await shopCase(A);
  const b1 = await shopCase(B);

  console.log("C — the charge history");
  ok("C1 the first charge (CHARGEABLE 50000, entered by the owner, no reason needed) is written by the runtime role",
    (await rt(A.b, charge(A, a1, 1, "CHARGEABLE", 50000, "OWNER_ENTERED", null))) === "OK");
  ok("C2 a gap in seq (3 after 1) → SERVICE_CHARGE_SEQ", (await rt(A.b, charge(A, a1, 3, "CHARGEABLE", 60000, "OWNER_ENTERED", "תוספת"))).includes("SERVICE_CHARGE_SEQ"));
  ok("C3 seq 1 again → refused (one record per place)", (await rt(A.b, charge(A, a1, 1, "CHARGEABLE", 60000, "OWNER_ENTERED", "x"))) !== "OK");
  ok("C4 a change without a reason → refused (ServiceCaseCharge_reason_required) — no silent change",
    (await rt(A.b, charge(A, a1, 2, "CHARGEABLE", 60000, "OWNER_ENTERED", null))).includes("reason_required"));
  ok("C5 a change with a reason → seq 2 written", (await rt(A.b, charge(A, a1, 2, "CHARGEABLE", 60000, "OWNER_ENTERED", "הוחלף חלק נוסף"))) === "OK");
  ok("C6 NO_CHARGE without a reason → refused; with an amount → refused",
    (await rt(A.b, charge(A, a2, 1, "NO_CHARGE", null, null, null))).includes("reason_required")
      && (await rt(A.b, charge(A, a2, 1, "NO_CHARGE", 100, null, "שירות ללא חיוב"))).includes("ServiceCaseCharge_mode"));
  ok("C7 NO_CHARGE with a reason → written (seq 1 of another case)", (await rt(A.b, charge(A, a2, 1, "NO_CHARGE", null, null, "תיקון באחריות החנות"))) === "OK");
  ok("C8 amount 0 → refused (free of charge is NO_CHARGE); a non-ILS currency → refused",
    (await rt(A.b, charge(A, a1, 3, "CHARGEABLE", 0, "OWNER_ENTERED", "x"))).includes("ServiceCaseCharge_mode")
      && (await rt(A.b, charge(A, a1, 3, "CHARGEABLE", 100, "OWNER_ENTERED", "x", `currency='USD'`))).includes("ServiceCaseCharge_currency"));
  ok("C9 an amount 'from a quote' that is no approved quote version of the case → refused",
    (await rt(A.b, charge(A, a1, 3, "CHARGEABLE", 60000, "APPROVED_QUOTE", null, `"quoteVersion"=7`))) !== "OK");
  ok("C10 the acting owner must be a user of the business (another business's user → refused); OWNER_USER without a user → refused",
    (await rt(A.b, [charge(A, a1, 3, "CHARGEABLE", 70000, "OWNER_ENTERED", "x")[0], A.b, a1, 3, "CHARGEABLE", 70000, "OWNER_ENTERED", "x", B.u])) !== "OK"
      && (await rt(A.b, [charge(A, a1, 3, "CHARGEABLE", 70000, "OWNER_ENTERED", "x")[0], A.b, a1, 3, "CHARGEABLE", 70000, "OWNER_ENTERED", "x", null])).includes("SERVICE_CHARGE_ACTOR"));
  ok("C11 a charge record is never updated or deleted by the runtime role (SERVICE_CHARGE_APPEND_ONLY / no privilege)",
    (await rt(A.b, [`UPDATE "ServiceCaseCharge" SET "amountAgorot" = 1 WHERE "caseId" = $1`, a1])) !== "OK"
      && (await rt(A.b, [`DELETE FROM "ServiceCaseCharge" WHERE "caseId" = $1`, a1])) !== "OK");
  let ownerUpd = "OK";
  try { await own(A.b, `UPDATE "ServiceCaseCharge" SET "amountAgorot" = 1 WHERE "caseId" = $1 RETURNING id`, a1); } catch (e) { ownerUpd = err(e); }
  let ownerTrunc = "OK";
  try { await x(`TRUNCATE "ServiceCaseCharge"`); } catch (e) { ownerTrunc = err(e); }
  ok("C12 … not even by the table owner (the guard), and never truncated", ownerUpd.includes("SERVICE_CHARGE_APPEND_ONLY") && ownerTrunc !== "OK", `${ownerUpd} / ${ownerTrunc}`);
  ok("C13 another business cannot charge A's case: B's context with A's case → refused; A's business id under B's context → refused (the case is invisible there: SERVICE_CHARGE_CASE, or RLS)",
    (await rt(B.b, [charge(B, a1, 1, "CHARGEABLE", 100, "OWNER_ENTERED", null)[0], B.b, a1, 1, "CHARGEABLE", 100, "OWNER_ENTERED", null, B.u])) !== "OK"
      && /SERVICE_CHARGE_CASE|row-level security/.test(await rt(B.b, charge(A, a1, 3, "CHARGEABLE", 70000, "OWNER_ENTERED", "x"))));
  const hist = await own(A.b, `SELECT seq, mode::text m, "amountAgorot" a, reason r FROM "ServiceCaseCharge" WHERE "caseId" = $1 ORDER BY seq`, a1);
  ok("C14 the history is intact: 50000 → 60000 (with its reason), nothing else",
    hist.length === 2 && Number(hist[0].a) === 50000 && Number(hist[1].a) === 60000 && hist[1].r === "הוחלף חלק נוסף", JSON.stringify(hist));

  console.log("L — billing links");
  const inv1 = await billingDoc(A, "TAX_INVOICE", "ISSUED", 600);
  const tir = await billingDoc(A, "TAX_INVOICE_RECEIPT", "ISSUED", 100);
  const rc1 = await billingDoc(A, "RECEIPT", "ISSUED", 200);
  const quote = await billingDoc(A, "QUOTE", "ISSUED", 600);
  const draft = await billingDoc(A, "TAX_INVOICE", "DRAFT", 50);
  const invB = await billingDoc(B, "TAX_INVOICE", "ISSUED", 999);
  const rc2 = await billingDoc(A, "RECEIPT", "ISSUED", 300);
  const rcDraft = await billingDoc(A, "RECEIPT", "DRAFT", 300);
  const cn = await billingDoc(A, "CREDIT_NOTE", "ISSUED", 100);
  const cnDraft = await billingDoc(A, "CREDIT_NOTE", "DRAFT", 100);
  ok("L1 CHARGE → A's issued tax invoice; CHARGE → a tax invoice / receipt; STANDALONE_PAYMENT → a receipt: all written",
    (await rt(A.b, link(A, a1, inv1, "CHARGE"))) === "OK" && (await rt(A.b, link(A, a1, tir, "CHARGE"))) === "OK" && (await rt(A.b, link(A, a1, rc1, "STANDALONE_PAYMENT"))) === "OK");
  ok("L2 another business's document id → SERVICE_BILLING_LINK_DOCUMENT (it does not exist in this business)",
    (await rt(A.b, link(A, a2, invB, "CHARGE"))).includes("SERVICE_BILLING_LINK_DOCUMENT"));
  ok("L3 the same document actively linked twice — to another case, or to the same one → refused (partial UNIQUE: 23505)",
    (await rt(A.b, link(A, a2, inv1, "CHARGE"))).includes("23505") && (await rt(A.b, link(A, a1, inv1, "CHARGE"))).includes("23505"));
  ok("L4 the role must fit the type: CHARGE → receipt, STANDALONE_PAYMENT → invoice, anything → quote: all SERVICE_BILLING_LINK_ROLE",
    (await rt(A.b, link(A, a2, rc1, "CHARGE"))).includes("SERVICE_BILLING_LINK_ROLE")
      && (await rt(A.b, link(A, a2, draft, "STANDALONE_PAYMENT"))).includes("SERVICE_BILLING_LINK_ROLE")
      && (await rt(A.b, link(A, a2, quote, "CHARGE"))).includes("SERVICE_BILLING_LINK_ROLE"));
  ok("L5 a draft invoice may be linked (status is not frozen here — the balance reader answers UNKNOWN / DRAFT_PENDING)",
    (await rt(A.b, link(A, a2, draft, "CHARGE"))) === "OK");
  ok("L5b a receipt is linked as a payment only once issued (a draft receipt → SERVICE_BILLING_LINK_RECEIPT_NOT_ISSUED)",
    (await rt(A.b, link(A, a2, rcDraft, "STANDALONE_PAYMENT"))).includes("SERVICE_BILLING_LINK_RECEIPT_NOT_ISSUED"));
  ok("L5c an issued credit note is linked as AFTER_SALE_CREDIT (T7 evidence); a draft one is refused; a credit note can never be a CHARGE",
    (await rt(A.b, link(A, a2, cn, "AFTER_SALE_CREDIT"))) === "OK"
      && (await rt(A.b, link(A, a2, cnDraft, "AFTER_SALE_CREDIT"))).includes("SERVICE_BILLING_LINK_CREDIT_NOT_ISSUED")
      && (await rt(A.b, link(A, a1, cnDraft, "CHARGE"))).includes("SERVICE_BILLING_LINK_ROLE"));
  ok("L6 a new link must record who linked it (no user → SERVICE_BILLING_LINK_NEW)",
    (await rt(A.b, [link(A, a2, rc2, "STANDALONE_PAYMENT")[0], A.b, a2, rc2, "STANDALONE_PAYMENT", null])).includes("SERVICE_BILLING_LINK_NEW"));
  ok("L7 unlink without a reason → refused; with who and why → done",
    (await rt(A.b, [`UPDATE "ServiceCaseBillingLink" SET "unlinkedAt" = now(), "unlinkedByUserId" = $2 WHERE "billingDocumentId" = $1`, inv1, A.u])) !== "OK"
      && (await rt(A.b, [`UPDATE "ServiceCaseBillingLink" SET "unlinkedAt" = now(), "unlinkedByUserId" = $2, "unlinkReason" = 'קושר לתיק הלא נכון' WHERE "billingDocumentId" = $1`, inv1, A.u])) === "OK");
  ok("L8 a second unlink, or moving a link to another document / case, or re-activating it → SERVICE_BILLING_LINK_KEPT",
    (await rt(A.b, [`UPDATE "ServiceCaseBillingLink" SET "unlinkReason" = 'אחר' WHERE "billingDocumentId" = $1`, inv1])).includes("SERVICE_BILLING_LINK_KEPT")
      && (await rt(A.b, [`UPDATE "ServiceCaseBillingLink" SET "billingDocumentId" = $2 WHERE "billingDocumentId" = $1`, rc1, tir])).includes("SERVICE_BILLING_LINK_KEPT")
      && (await rt(A.b, [`UPDATE "ServiceCaseBillingLink" SET "caseId" = $2 WHERE "billingDocumentId" = $1`, rc1, a2])).includes("SERVICE_BILLING_LINK_KEPT")
      && (await rt(A.b, [`UPDATE "ServiceCaseBillingLink" SET "unlinkedAt" = NULL, "unlinkedByUserId" = NULL, "unlinkReason" = NULL WHERE "billingDocumentId" = $1`, inv1])) !== "OK");
  ok("L9 after the unlink the document may be linked to the right case; both rows stay (history)",
    (await rt(A.b, link(A, a2, inv1, "CHARGE"))) === "OK"
      && Number((await own(A.b, `SELECT count(*)::int n FROM "ServiceCaseBillingLink" WHERE "billingDocumentId" = $1`, inv1))[0].n) === 2);
  ok("L10 a link is never deleted by the runtime role", (await rt(A.b, [`DELETE FROM "ServiceCaseBillingLink" WHERE "billingDocumentId" = $1`, rc1])) !== "OK");

  console.log("U — a deleted user (owner decision 2026-11-12: deleting a user nulls the references, never fails by mistake)");
  // its own business, so the counts of E stay A's
  const Z = await business("u");
  const zu2 = Number((await q(`INSERT INTO "User" (email, "businessId", "updatedAt") VALUES ($1, $2, now()) RETURNING id`, `sdcharge-u2-${t}@lab.invalid`, Z.b))[0].id);
  const z1 = await shopCase(Z);
  const zInv = await billingDoc(Z, "TAX_INVOICE", "ISSUED", 400);
  ok("U1 a second owner user of the business records a charge and links a document",
    (await rt(Z.b, [charge(Z, z1, 1, "CHARGEABLE", 40000, "OWNER_ENTERED", null)[0], Z.b, z1, 1, "CHARGEABLE", 40000, "OWNER_ENTERED", null, zu2])) === "OK"
      && (await rt(Z.b, link(Z, z1, zInv, "CHARGE", zu2))) === "OK");
  const zSnap = async () => (await own(Z.b, `SELECT (SELECT to_jsonb(c) - 'actorUserId' FROM "ServiceCaseCharge" c WHERE "caseId" = $1)::text c,
      (SELECT "actorUserId" FROM "ServiceCaseCharge" WHERE "caseId" = $1) cu,
      (SELECT to_jsonb(l) - 'linkedByUserId' FROM "ServiceCaseBillingLink" l WHERE "caseId" = $1)::text l,
      (SELECT "linkedByUserId" FROM "ServiceCaseBillingLink" WHERE "caseId" = $1) lu`, z1))[0];
  const before = await zSnap();
  const ownUpd = async (sql: string, ...a: unknown[]) => { try { await own(Z.b, sql, ...a); return "OK"; } catch (e) { return err(e); } };
  const nullActor = await ownUpd(`UPDATE "ServiceCaseCharge" SET "actorUserId" = NULL WHERE "caseId" = $1 RETURNING id`, z1);
  const repointActor = await ownUpd(`UPDATE "ServiceCaseCharge" SET "actorUserId" = $2 WHERE "caseId" = $1 RETURNING id`, z1, Z.u);
  const nullLinker = await ownUpd(`UPDATE "ServiceCaseBillingLink" SET "linkedByUserId" = NULL WHERE "caseId" = $1 RETURNING id`, z1);
  const repointLinker = await ownUpd(`UPDATE "ServiceCaseBillingLink" SET "linkedByUserId" = $2 WHERE "caseId" = $1 RETURNING id`, z1, Z.u);
  ok("U2 no direct UPDATE nulls or re-points who acted — not even the table owner's (SERVICE_CHARGE_APPEND_ONLY / SERVICE_BILLING_LINK_KEPT); the runtime role neither",
    nullActor.includes("SERVICE_CHARGE_APPEND_ONLY") && repointActor.includes("SERVICE_CHARGE_APPEND_ONLY")
      && nullLinker.includes("SERVICE_BILLING_LINK_KEPT") && repointLinker.includes("SERVICE_BILLING_LINK_KEPT")
      && (await rt(Z.b, [`UPDATE "ServiceCaseCharge" SET "actorUserId" = NULL WHERE "caseId" = $1`, z1])) !== "OK"
      && (await rt(Z.b, [`UPDATE "ServiceCaseBillingLink" SET "linkedByUserId" = $2 WHERE "caseId" = $1`, z1, Z.u])) !== "OK",
    [nullActor, repointActor, nullLinker, repointLinker].join(" | "));
  let zDel = "OK";
  try { await x(`DELETE FROM "User" WHERE id = $1`, zu2); } catch (e) { zDel = err(e); }
  const afterZ = await zSnap();
  ok("U3 the user who recorded a charge and linked a document can be deleted: the FK sets actorUserId / linkedByUserId to NULL and nothing else on either row changes",
    zDel === "OK" && Number(before.cu) === zu2 && Number(before.lu) === zu2 && afterZ.cu === null && afterZ.lu === null
      && afterZ.c === before.c && afterZ.l === before.l, `${zDel} ${JSON.stringify(before)} → ${JSON.stringify(afterZ)}`);
  ok("U4 a new owner charge without its user is still refused after that (SERVICE_CHARGE_ACTOR); with the user → written",
    (await rt(Z.b, [charge(Z, z1, 2, "CHARGEABLE", 45000, "OWNER_ENTERED", "תוספת")[0], Z.b, z1, 2, "CHARGEABLE", 45000, "OWNER_ENTERED", "תוספת", null])).includes("SERVICE_CHARGE_ACTOR")
      && (await rt(Z.b, charge(Z, z1, 2, "CHARGEABLE", 45000, "OWNER_ENTERED", "תוספת"))) === "OK");

  console.log("I — isolation");
  // the runtime role is NOBYPASSRLS: these counts are what B can see
  const seenByB = await rtRows(B.b, `SELECT (SELECT count(*) FROM "ServiceCaseCharge" WHERE "businessId" = $1)::int c, (SELECT count(*) FROM "ServiceCaseBillingLink" WHERE "businessId" = $1)::int l`, A.b);
  ok("I1 business B reads none of A's charges or links", Number(seenByB[0].c) === 0 && Number(seenByB[0].l) === 0, JSON.stringify(seenByB));
  ok("I2 B cannot link its own invoice to A's case, nor A's invoice to its case",
    (await rt(B.b, [link(B, a1, invB, "CHARGE")[0], B.b, a1, invB, "CHARGE", B.u])) !== "OK"
      && (await rt(B.b, [link(B, b1, rc1, "STANDALONE_PAYMENT")[0], B.b, b1, rc1, "STANDALONE_PAYMENT", B.u])).includes("SERVICE_BILLING_LINK_DOCUMENT"));

  console.log("E — erasure");
  const early = await rt(A.b, [`SELECT public.service_case_charge_erase_business()`]);
  ok("E1 erasure is refused while the business is not being deleted", early.includes("SERVICE_CHARGE_ERASURE_NOT_DELETING"), early);
  const imitate = await rt(A.b, [`SELECT set_config('dubiz.service_charge_erasure', 'on', true)`],
    [`UPDATE "ServiceCaseCharge" SET reason = NULL, "actorUserId" = NULL, "erasedAt" = now() WHERE "caseId" = $1`, a1]);
  ok("E2 the runtime cannot imitate the scrub by setting the marker itself", imitate !== "OK", imitate);
  await x(`UPDATE "Business" SET "deletionRequestedAt" = now() WHERE id = $1`, A.b);
  let erased = -1;
  try { erased = Number((await rtRows(A.b, `SELECT public.service_case_charge_erase_business() AS n`))[0].n); } catch (e) { console.log(err(e)); }
  const after = await own(A.b, `SELECT (SELECT count(*) FROM "ServiceCaseCharge" WHERE "businessId" = $1 AND (reason IS NOT NULL OR "actorUserId" IS NOT NULL))::int left_c,
      (SELECT count(*) FROM "ServiceCaseBillingLink" WHERE "businessId" = $1 AND ("linkedByUserId" IS NOT NULL OR "unlinkReason" IS NOT NULL OR "unlinkedByUserId" IS NOT NULL))::int left_l,
      (SELECT sum("amountAgorot") FROM "ServiceCaseCharge" WHERE "businessId" = $1)::int amounts, (SELECT count(*) FROM "ServiceCaseBillingLink" WHERE "businessId" = $1)::int links`, A.b);
  ok("E3 while deleting: who acted and every reason blanked; amounts (50000 + 60000) and the 6 link rows kept",
    erased > 0 && Number(after[0].left_c) === 0 && Number(after[0].left_l) === 0 && Number(after[0].amounts) === 110000 && Number(after[0].links) === 6, `${erased} ${JSON.stringify(after)}`);
  const again = Number((await rtRows(A.b, `SELECT public.service_case_charge_erase_business() AS n`))[0].n);
  ok("E4 re-run safe (0 rows the second time)", again === 0);
  ok("E5 nothing new is written for a business being deleted", (await rt(A.b, charge(A, a1, 3, "CHARGEABLE", 1, "OWNER_ENTERED", "x"))).includes("SERVICE_UI_BUSINESS_DELETING"));

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length > 0) process.exitCode = 1;
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(async () => { await owner.$disconnect(); await runtime.$disconnect(); });
