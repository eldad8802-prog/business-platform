/**
 * Service Desk case charge — the COMMANDS end to end AS the real runtime role (app_runtime_prod, NOBYPASSRLS), on the P4
 * lab with 20261125090000 (#1096) and 20261126090000 applied (the same lab as .sdcharge/battery.ts, run after it).
 * Synthetic only. Billing documents / allocations are fixtures written by the lab owner in a tenant context — billing
 * code is not called to write; billing's readDocumentsSettlement is what the service reads.
 *
 *   U  no charge record → DELIVER refused (BALANCE_UNKNOWN), nothing written
 *   C  recordCharge: journaled (charge.recorded, status kept, version bumped, closed payload, reason only in its column);
 *      reasons required; NO_CHANGE; replay; key reuse; stale version
 *   N  NO_CHARGE → DELIVER with chargeBasis NO_CHARGE; no document may be linked to it
 *   X  exempt dealer: 50000 + a linked ISSUED standalone receipt 50000 → SETTLED → DELIVER without override
 *   O  50000 + a linked ISSUED TAX_INVOICE 50000, no allocation → OPEN → DELIVER refused without debtOverride, allowed with
 *   A  invoice + allocated receipt → SETTLED, the allocated receipt never counted twice
 *   V  overpayment → SETTLED, overpaidAgorot in the DELIVER journal
 *   L  links: role mismatch, draft receipt, duplicate (other case / same case), missing id, replay; unlink needs a reason,
 *      once, replay, history kept; a draft invoice → UNKNOWN (and DELIVER refused)
 *   D  charge lowered below documented → refused; NO_CHARGE with documents → refused
 *   K  correction after DELIVERED allowed; the handover row byte-identical
 *   I  another business cannot record, link, unlink or read; another business's document reads as not found
 *   J  every charge / link journal payload is tokens / numbers / booleans — no reason text
 *
 * env: OWNER_URL (lab owner — fixtures), DATABASE_URL = DIRECT_URL (app_runtime_prod), TASK_REQUEST_HMAC_KEY / _ID,
 *      AUTH_TOKEN_SECRET.
 */
import { PrismaClient } from "@prisma/client";

import { uuidV7 } from "../lib/services/tasks/task-idempotency";
import { ServiceDeskError } from "../lib/services/service-desk/service-desk-errors";
import { openCase, recordIntake, runCaseAction, type ServiceDeskPrincipal } from "../lib/services/service-desk/service-case.service";
import { getCaseCharges, linkBillingDocument, recordCharge, unlinkBillingDocument } from "../lib/services/service-desk/case-charge.service";

const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });
const runtime = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL! });
let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); } else { failures.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}
type Rows = Record<string, unknown>[];
const q = (sql: string, ...a: unknown[]) => owner.$queryRawUnsafe(sql, ...a) as Promise<Rows>;
const n = async (sql: string, ...a: unknown[]) => Number((await q(sql, ...a))[0]?.n);
const key = () => uuidV7(new Date());
async function code(fn: () => Promise<unknown>): Promise<string> {
  try { await fn(); return "OK"; } catch (e) {
    if (e instanceof ServiceDeskError) return `${e.code}${e.details && Object.keys(e.details).length ? ":" + JSON.stringify(e.details) : ""}`;
    return `ERR:${(e as Error).message.replace(/\s+/g, " ").trim().slice(-300)}`;
  }
}
/** Lab owner in a tenant context (billing tables and the new tables are under RLS). */
async function own<T = Rows>(b: number, sql: string, ...a: unknown[]): Promise<T> {
  return owner.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('app.current_business_id', $1, true)`, String(b));
    return (await tx.$queryRawUnsafe(sql, ...a)) as T;
  });
}

const t = Date.now();
async function business(tag: string) {
  const b = Number((await q(`INSERT INTO "Business" (name, "updatedAt") VALUES ($1, now()) RETURNING id`, `sdchargecmd-${tag}-${t}`))[0].id);
  const u = Number((await q(`INSERT INTO "User" (email, "businessId", "updatedAt") VALUES ($1, $2, now()) RETURNING id`, `sdchargecmd-${tag}-${t}@lab.invalid`, b))[0].id);
  const cust = Number((await q(`INSERT INTO "Customer" ("businessId", name, "updatedAt") VALUES ($1, 'לקוח סינתטי', now()) RETURNING id`, b))[0].id);
  return { b, u, cust, p: { businessId: b, userId: u } as ServiceDeskPrincipal };
}
type Biz = Awaited<ReturnType<typeof business>>;
/** A billing document fixture; total in shekels (Decimal(18,2)) — 500 = 50000 agorot. */
async function billingDoc(z: Biz, type: string, status: "DRAFT" | "ISSUED", total: number): Promise<number> {
  const rows = await own(z.b, `INSERT INTO "BillingDocument" ("businessId", "documentType", status, "totalAmount", currency, "issuedAt", "updatedAt")
    VALUES ($1, $2::"BillingDocumentType", $3::"BillingDocumentStatus", $4, 'ILS', CASE WHEN $3 = 'ISSUED' THEN now() END, now()) RETURNING id`, z.b, type, status, total);
  return Number(rows[0].id);
}
async function allocate(z: Biz, receipt: number, invoice: number, amount: number) {
  await own(z.b, `INSERT INTO "BillingPaymentAllocation" ("businessId", "receiptDocumentId", "invoiceDocumentId", "allocatedAmount", currency) VALUES ($1, $2, $3, $4, 'ILS') RETURNING id`, z.b, receipt, invoice, amount);
}
const version = async (id: number) => n(`SELECT version::int AS n FROM "ServiceCase" WHERE id = $1`, id);
const statusOf = async (id: number) => String((await q(`SELECT status::text s FROM "ServiceCase" WHERE id = $1`, id))[0].s);
const handovers = (id: number) => n(`SELECT count(*)::int AS n FROM "ServiceHandover" WHERE "caseId" = $1`, id);
/** jsonb keeps its own key order: compare payloads as sorted entries. */
const same = (a: unknown, b: Record<string, unknown>) => JSON.stringify(Object.entries(a as Record<string, unknown>).sort()) === JSON.stringify(Object.entries(b).sort());
const lastEvent = async (id: number) => (await q(`SELECT seq, "eventType"::text et, action::text ac, "fromStatus"::text f, "toStatus"::text t, actor::text actor, "actorUserId" a, payload FROM "ServiceCaseEvent" WHERE "caseId" = $1 ORDER BY seq DESC LIMIT 1`, id))[0];

async function main() {
  const who = String((await runtime.$queryRawUnsafe<{ u: string }[]>(`SELECT current_user AS u`))[0].u);
  const bypass = (await runtime.$queryRawUnsafe<{ r: boolean }[]>(`SELECT rolbypassrls AS r FROM pg_roles WHERE rolname = current_user`))[0].r;
  ok("R0 the service runs AS app_runtime_prod (NOBYPASSRLS)", who === "app_runtime_prod" && bypass === false, `${who} bypass=${bypass}`);

  const A = await business("a");
  const B = await business("b");
  const shopCase = async (z: Biz) => (await openCase(z.p, { kind: "IN_SHOP", customerId: z.cust, problemDescription: "לא נדלק" }, { idempotencyKey: key() })).case.id;
  /** The .sd13b H-section path: recordIntake → CHECK_IN intakeConfirmed → START_DIAGNOSIS → MARK_NOT_REPAIRABLE. */
  const toReady = async (z: Biz = A) => {
    const id = await shopCase(z);
    await recordIntake(z.p, id, { conditionNote: "סדק", accessoriesNote: null, conditionRecorded: true, accessoriesRecorded: true, expectedVersion: await version(id) }, { idempotencyKey: key() });
    for (const action of [{ type: "CHECK_IN", intakeConfirmed: true }, { type: "START_DIAGNOSIS" }, { type: "MARK_NOT_REPAIRABLE" }]) {
      await runCaseAction(z.p, id, { action, expectedVersion: await version(id) }, { idempotencyKey: key() });
    }
    return id;
  };
  const deliver = async (id: number, extra: Record<string, unknown> = {}, z = A) =>
    runCaseAction(z.p, id, { action: { type: "DELIVER", receipt: { handoverConfirmed: true }, ...extra }, expectedVersion: await version(id) }, { idempotencyKey: key() });
  const charge = async (id: number, body: Record<string, unknown>, z = A, k = key(), v?: number) =>
    recordCharge(z.p, id, { ...body, expectedVersion: v ?? (await version(id)) }, { idempotencyKey: k });
  const link = async (id: number, doc: number, role: string, z = A, k = key(), v?: number) =>
    linkBillingDocument(z.p, id, { billingDocumentId: doc, role, expectedVersion: v ?? (await version(id)) }, { idempotencyKey: k });
  const unlink = async (id: number, doc: number, reason: unknown, z = A, k = key(), v?: number) =>
    unlinkBillingDocument(z.p, id, { billingDocumentId: doc, reason, expectedVersion: v ?? (await version(id)) }, { idempotencyKey: k });

  console.log("U — no charge record");
  const c0 = await toReady();
  ok("U0 the case reached READY through owner actions only", (await statusOf(c0)) === "READY");
  const u1 = await code(() => deliver(c0));
  ok("U1 DELIVER with no charge record → BALANCE_UNKNOWN (the real reader); no handover", u1.includes("BALANCE_UNKNOWN") && (await handovers(c0)) === 0, u1);
  ok("U2 the read model says UNKNOWN / NO_CHARGE_DECISION, no charges, no links",
    (await getCaseCharges(A.b, c0).then((v) => v.balance.state === "UNKNOWN" && (v.balance as { reason?: string }).reason === "NO_CHARGE_DECISION" && v.charges.length === 0 && v.links.length === 0)));

  console.log("C / N — recordCharge, NO_CHARGE");
  const c1 = await toReady();
  ok("C1 NO_CHARGE without a reason → REFUSED REASON_REQUIRED; with an amount → INVALID_INPUT amountAgorot",
    (await code(() => charge(c1, { mode: "NO_CHARGE" }))).includes("REASON_REQUIRED") && (await code(() => charge(c1, { mode: "NO_CHARGE", amountAgorot: 5, reason: "x" }))).includes("amountAgorot"));
  const v1 = await version(c1);
  const k1 = key();
  const r1 = await charge(c1, { mode: "NO_CHARGE", reason: "תיקון באחריות החנות" }, A, k1, v1);
  const e1 = await lastEvent(c1);
  const row1 = (await own(A.b, `SELECT seq, mode::text m, "amountAgorot" a, source::text s, reason r, actor::text ac, "actorUserId" u FROM "ServiceCaseCharge" WHERE "caseId" = $1`, c1))[0];
  ok("C2 NO_CHARGE with a reason → one record (seq 1, no amount / source, the reason in its column, the acting user)",
    r1.replayed === false && row1.seq === 1 && row1.m === "NO_CHARGE" && row1.a === null && row1.s === null && row1.r === "תיקון באחריות החנות" && row1.ac === "OWNER_USER" && Number(row1.u) === A.u, JSON.stringify(row1));
  ok("C3 the journal: charge.recorded / RECORD_CHARGE, READY → READY, OWNER_USER = this user, seq = the new version, payload { mode, amountAgorot null, chargeSeq 1 }",
    e1.et === "charge.recorded" && e1.ac === "RECORD_CHARGE" && e1.f === "READY" && e1.t === "READY" && e1.actor === "OWNER_USER" && Number(e1.a) === A.u
      && Number(e1.seq) === v1 + 1 && r1.case.version === v1 + 1 && same(e1.payload, { mode: "NO_CHARGE", amountAgorot: null, chargeSeq: 1 }), JSON.stringify(e1));
  const rp1 = await charge(c1, { mode: "NO_CHARGE", reason: "תיקון באחריות החנות" }, A, k1, v1);
  ok("C4 the same request again → replayed, still one record and one event", rp1.replayed === true && rp1.event.seq === v1 + 1
    && (await n(`SELECT count(*)::int n FROM "ServiceCaseEvent" WHERE "caseId" = $1 AND action::text = 'RECORD_CHARGE'`, c1)) === 1);
  ok("C5 the same key with another body → IDEMPOTENCY_KEY_REUSED", (await code(() => charge(c1, { mode: "NO_CHARGE", reason: "אחר" }, A, k1, v1))).startsWith("IDEMPOTENCY_KEY_REUSED"));
  ok("C6 a stale expectedVersion → VERSION_CONFLICT", (await code(() => charge(c1, { mode: "CHARGEABLE", amountAgorot: 100, reason: "x" }, A, key(), v1))).startsWith("VERSION_CONFLICT"));
  ok("C7 the same decision again → REFUSED NO_CHANGE", (await code(() => charge(c1, { mode: "NO_CHARGE", reason: "שוב" }))).includes("NO_CHANGE"));
  const docForNoCharge = await billingDoc(A, "TAX_INVOICE", "ISSUED", 100);
  ok("N1 a document cannot be linked to a case marked free of charge → NO_CHARGE_WITH_DOCUMENTS", (await code(() => link(c1, docForNoCharge, "CHARGE"))).startsWith("NO_CHARGE_WITH_DOCUMENTS"));
  const d1 = await deliver(c1);
  const de1 = await lastEvent(c1);
  ok("N2 NO_CHARGE → DELIVER without override → DELIVERED; journal chargeBasis NO_CHARGE, balance 0",
    d1.case.status === "DELIVERED" && (de1.payload as Record<string, unknown>).chargeBasis === "NO_CHARGE" && (de1.payload as Record<string, unknown>).openBalanceAgorot === 0, JSON.stringify(de1.payload));

  console.log("X — exempt dealer");
  const c2 = await toReady();
  await charge(c2, { mode: "CHARGEABLE", amountAgorot: 50000 });
  const rc2 = await billingDoc(A, "RECEIPT", "ISSUED", 500);
  const kl = key(), vl = await version(c2);
  const l2 = await link(c2, rc2, "STANDALONE_PAYMENT", A, kl, vl);
  const le2 = await lastEvent(c2);
  ok("X1 link an issued standalone receipt → billing.linked, payload { role, billingDocumentId } only",
    l2.replayed === false && le2.et === "billing.linked" && le2.ac === "LINK_BILLING_DOCUMENT" && same(le2.payload, { role: "STANDALONE_PAYMENT", billingDocumentId: rc2 }));
  const lr2 = await link(c2, rc2, "STANDALONE_PAYMENT", A, kl, vl);
  ok("X2 the same link request again → replayed, one link row", lr2.replayed === true && (await own<Rows>(A.b, `SELECT count(*)::int n FROM "ServiceCaseBillingLink" WHERE "billingDocumentId" = $1`, rc2))[0].n === 1);
  const g2 = await getCaseCharges(A.b, c2);
  ok("X3 the read model: SETTLED 0; detail charge 50000 / paid 50000; the link shows billing's facts (RECEIPT, ISSUED, 50000)",
    g2.balance.state === "SETTLED" && g2.balance.detail.chargeAgorot === 50000 && g2.balance.detail.paidAgorot === 50000 && g2.links[0]?.document?.type === "RECEIPT" && g2.links[0]?.document?.totalAgorot === 50000 && g2.links[0].active,
    JSON.stringify(g2.balance));
  const d2 = await deliver(c2);
  const h2 = (await q(`SELECT "openBalanceAgorot" ob, "debtOverrideReason" dr FROM "ServiceHandover" WHERE "caseId" = $1`, c2))[0];
  ok("X4 DELIVER without override → DELIVERED (basis DOCUMENTED), handover balance 0, no override reason",
    d2.case.status === "DELIVERED" && Number(h2.ob) === 0 && h2.dr === null && ((await lastEvent(c2)).payload as Record<string, unknown>).chargeBasis === "DOCUMENTED");

  console.log("O — invoice, no allocation");
  const c3 = await toReady();
  await charge(c3, { mode: "CHARGEABLE", amountAgorot: 50000 });
  const inv3 = await billingDoc(A, "TAX_INVOICE", "ISSUED", 500);
  await link(c3, inv3, "CHARGE");
  const g3 = await getCaseCharges(A.b, c3);
  ok("O1 an issued tax invoice of the whole charge, nothing paid → OPEN 50000", g3.balance.state === "OPEN" && g3.balance.openBalanceAgorot === 50000, JSON.stringify(g3.balance));
  const o2 = await code(() => deliver(c3));
  ok("O2 DELIVER without the owner's reason → OPEN_BALANCE_NEEDS_OWNER_DECISION; nothing written", o2.includes("OPEN_BALANCE_NEEDS_OWNER_DECISION") && (await handovers(c3)) === 0, o2);
  await deliver(c3, { debtOverride: { reason: "הלקוח ישלם בהעברה" } });
  const h3 = (await q(`SELECT "openBalanceAgorot" ob, "debtOverrideReason" dr FROM "ServiceHandover" WHERE "caseId" = $1`, c3))[0];
  ok("O3 … with the owner's reason → DELIVERED; handover balance 50000 and the reason in its column", (await statusOf(c3)) === "DELIVERED" && Number(h3.ob) === 50000 && h3.dr === "הלקוח ישלם בהעברה");

  console.log("D — charge changes against documents");
  ok("D1 lowering the charge below the documented 50000 → CHARGE_BELOW_DOCUMENTED (a credit note first)",
    (await code(() => charge(c3, { mode: "CHARGEABLE", amountAgorot: 30000, reason: "הנחה" }))).startsWith("CHARGE_BELOW_DOCUMENTED"));
  ok("D2 NO_CHARGE while documents are linked → NO_CHARGE_WITH_DOCUMENTS", (await code(() => charge(c3, { mode: "NO_CHARGE", reason: "ויתור" }))).startsWith("NO_CHARGE_WITH_DOCUMENTS"));
  ok("D3 nothing was written by the refusals (still one charge record)", (await own<Rows>(A.b, `SELECT count(*)::int n FROM "ServiceCaseCharge" WHERE "caseId" = $1`, c3))[0].n === 1);

  console.log("A — invoice + allocated receipt");
  const c4 = await toReady();
  await charge(c4, { mode: "CHARGEABLE", amountAgorot: 50000 });
  const inv4 = await billingDoc(A, "TAX_INVOICE", "ISSUED", 500);
  const rc4 = await billingDoc(A, "RECEIPT", "ISSUED", 500);
  await allocate(A, rc4, inv4, 500);
  await link(c4, inv4, "CHARGE");
  const g4 = await getCaseCharges(A.b, c4);
  ok("A1 the invoice is paid by an allocated receipt → SETTLED, no overpayment", g4.balance.state === "SETTLED" && g4.balance.detail.overpaidAgorot === 0, JSON.stringify(g4.balance));
  await link(c4, rc4, "STANDALONE_PAYMENT");
  const g4b = await getCaseCharges(A.b, c4);
  ok("A2 linking the allocated receipt too never counts it twice (still SETTLED, paid 50000, overpaid 0)",
    g4b.balance.state === "SETTLED" && g4b.balance.detail.paidAgorot === 50000 && g4b.balance.detail.overpaidAgorot === 0, JSON.stringify(g4b.balance));

  console.log("V — overpayment");
  const c5 = await toReady();
  await charge(c5, { mode: "CHARGEABLE", amountAgorot: 40000 });
  const rc5 = await billingDoc(A, "RECEIPT", "ISSUED", 500);
  await link(c5, rc5, "STANDALONE_PAYMENT");
  const g5 = await getCaseCharges(A.b, c5);
  ok("V1 40000 charged, 50000 received → SETTLED with overpaidAgorot 10000 (shown, never zeroed)",
    g5.balance.state === "SETTLED" && (g5.balance as { overpaidAgorot?: number }).overpaidAgorot === 10000 && g5.balance.detail.overpaidAgorot === 10000);
  await deliver(c5);
  ok("V2 the DELIVER journal carries overpaidAgorot 10000", ((await lastEvent(c5)).payload as Record<string, unknown>).overpaidAgorot === 10000);

  console.log("L — links");
  const c6 = await toReady();
  await charge(c6, { mode: "CHARGEABLE", amountAgorot: 90000 });
  const rc6 = await billingDoc(A, "RECEIPT", "ISSUED", 100);
  const rcDraft = await billingDoc(A, "RECEIPT", "DRAFT", 100);
  const quote = await billingDoc(A, "QUOTE", "ISSUED", 100);
  ok("L1 a receipt as CHARGE / a quote as CHARGE → BILLING_DOCUMENT_ROLE_MISMATCH",
    (await code(() => link(c6, rc6, "CHARGE"))).startsWith("BILLING_DOCUMENT_ROLE_MISMATCH") && (await code(() => link(c6, quote, "CHARGE"))).startsWith("BILLING_DOCUMENT_ROLE_MISMATCH"));
  ok("L2 a draft receipt as a payment → RECEIPT_NOT_ISSUED", (await code(() => link(c6, rcDraft, "STANDALONE_PAYMENT"))).startsWith("RECEIPT_NOT_ISSUED"));
  ok("L3 a document id that does not exist → BILLING_DOCUMENT_NOT_FOUND", (await code(() => link(c6, 2147483000, "CHARGE"))).startsWith("BILLING_DOCUMENT_NOT_FOUND"));
  const dupOther = await code(() => link(c6, inv3, "CHARGE"));
  ok("L4 a document actively linked to another case → BILLING_DOCUMENT_ALREADY_LINKED (sameCase false)", dupOther.startsWith("BILLING_DOCUMENT_ALREADY_LINKED") && dupOther.includes('"sameCase":false'), dupOther);
  await link(c6, rc6, "STANDALONE_PAYMENT");
  const dupSame = await code(() => link(c6, rc6, "STANDALONE_PAYMENT"));
  ok("L5 … or to this case already (a new request) → BILLING_DOCUMENT_ALREADY_LINKED (sameCase true)", dupSame.startsWith("BILLING_DOCUMENT_ALREADY_LINKED") && dupSame.includes('"sameCase":true'), dupSame);
  ok("L6 unlink without a reason → INVALID_INPUT reason (nothing written)", (await code(() => unlink(c6, rc6, undefined))).includes('"field":"reason"') && (await code(() => unlink(c6, rc6, "  "))).includes('"field":"reason"'));
  const ku = key(), vu = await version(c6);
  const u6 = await unlink(c6, rc6, "קושר לתיק הלא נכון", A, ku, vu);
  const ue6 = await lastEvent(c6);
  const lrow = (await own(A.b, `SELECT "unlinkedAt" IS NOT NULL un, "unlinkedByUserId" u, "unlinkReason" r FROM "ServiceCaseBillingLink" WHERE "billingDocumentId" = $1`, rc6))[0];
  ok("L7 unlink with a reason → the row unlinked (who, why, in its columns); billing.unlinked, payload { role, billingDocumentId } — never the reason",
    u6.replayed === false && lrow.un === true && Number(lrow.u) === A.u && lrow.r === "קושר לתיק הלא נכון" && ue6.et === "billing.unlinked" && ue6.ac === "UNLINK_BILLING_DOCUMENT"
      && same(ue6.payload, { role: "STANDALONE_PAYMENT", billingDocumentId: rc6 }));
  const ur6 = await unlink(c6, rc6, "קושר לתיק הלא נכון", A, ku, vu);
  ok("L8 the same unlink request again → replayed; a new one → LINK_NOT_FOUND", ur6.replayed === true && (await code(() => unlink(c6, rc6, "שוב"))).startsWith("LINK_NOT_FOUND"));
  await link(c6, rc6, "STANDALONE_PAYMENT");
  const g6 = await getCaseCharges(A.b, c6);
  ok("L9 linked again afterwards: history kept (2 rows, one active first, the unlinked one with its reason)",
    g6.links.length === 2 && g6.links[0].active && !g6.links[1].active && g6.links[1].unlinkReason === "קושר לתיק הלא נכון" && g6.links[1].document === null);
  const draftInv = await billingDoc(A, "TAX_INVOICE", "DRAFT", 900);
  await link(c6, draftInv, "CHARGE");
  const g6b = await getCaseCharges(A.b, c6);
  ok("L10 a linked draft invoice → UNKNOWN / DRAFT_PENDING; DELIVER refused (BALANCE_UNKNOWN); a charge change → BALANCE_UNKNOWN",
    g6b.balance.state === "UNKNOWN" && (g6b.balance as { reason?: string }).reason === "DRAFT_PENDING"
      && (await code(() => deliver(c6))).includes("BALANCE_UNKNOWN") && (await code(() => charge(c6, { mode: "CHARGEABLE", amountAgorot: 95000, reason: "עדכון" }))).startsWith("BALANCE_UNKNOWN"));

  console.log("K — correction after DELIVERED");
  const before = (await q(`SELECT to_jsonb(h)::text j FROM "ServiceHandover" h WHERE "caseId" = $1`, c2))[0].j;
  ok("K1 a change after DELIVERED without a reason → REASON_REQUIRED", (await code(() => charge(c2, { mode: "CHARGEABLE", amountAgorot: 60000 }))).includes("REASON_REQUIRED"));
  const k2 = await charge(c2, { mode: "CHARGEABLE", amountAgorot: 60000, reason: "נוסף חלק אחרי המסירה" });
  const after = (await q(`SELECT to_jsonb(h)::text j FROM "ServiceHandover" h WHERE "caseId" = $1`, c2))[0].j;
  const g2b = await getCaseCharges(A.b, c2);
  ok("K2 with a reason → recorded (seq 2), status still DELIVERED, the handover row byte-identical; the balance now CHARGE_NOT_DOCUMENTED 10000",
    k2.case.status === "DELIVERED" && g2b.charges.length === 2 && g2b.current?.seq === 2 && g2b.current.reason === "נוסף חלק אחרי המסירה" && before === after
      && g2b.balance.state === "CHARGE_NOT_DOCUMENTED" && g2b.balance.openBalanceAgorot === 10000, JSON.stringify(g2b.balance));

  console.log("I — isolation");
  const bCase = await shopCase(B);
  const iso = await Promise.all([
    code(() => recordCharge(B.p, c6, { mode: "CHARGEABLE", amountAgorot: 1, expectedVersion: 1 }, { idempotencyKey: key() })),
    code(() => linkBillingDocument(B.p, c6, { billingDocumentId: rc6, role: "STANDALONE_PAYMENT", expectedVersion: 1 }, { idempotencyKey: key() })),
    code(() => unlinkBillingDocument(B.p, c6, { billingDocumentId: rc6, reason: "x", expectedVersion: 1 }, { idempotencyKey: key() })),
    code(() => getCaseCharges(B.b, c6)),
  ]);
  ok("I1 business B: record / link / unlink / read on A's case → NOT_FOUND every time", iso.every((c) => c.startsWith("NOT_FOUND")), iso.join(" | "));
  const crossDoc = await code(() => link(bCase, inv4, "CHARGE", B));
  ok("I2 B linking A's document to B's own case → BILLING_DOCUMENT_NOT_FOUND (exactly like a missing id)", crossDoc === "BILLING_DOCUMENT_NOT_FOUND", crossDoc);

  console.log("J — journal payloads");
  const payloads = (await q(`SELECT payload::text p FROM "ServiceCaseEvent" WHERE "businessId" = $1 AND action::text IN ('RECORD_CHARGE', 'LINK_BILLING_DOCUMENT', 'UNLINK_BILLING_DOCUMENT')`, A.b)).map((r) => String(r.p));
  ok("J1 every charge / link payload holds tokens / numbers / booleans only — no Hebrew, no reason text", payloads.length >= 15 && payloads.every((p) => !/[֐-׿]/.test(p) && !/reason/i.test(p)), String(payloads.length));
  const kept = await q(`SELECT count(*)::int n FROM "ServiceCaseEvent" WHERE "businessId" = $1 AND action::text IN ('RECORD_CHARGE', 'LINK_BILLING_DOCUMENT', 'UNLINK_BILLING_DOCUMENT') AND ("fromStatus" <> "toStatus" OR actor::text <> 'OWNER_USER')`, A.b);
  ok("J2 every charge / link record kept the status and was the owner's", Number(kept[0].n) === 0);

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length > 0) process.exitCode = 1;
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(async () => { await owner.$disconnect(); await runtime.$disconnect(); });
