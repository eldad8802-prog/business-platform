/**
 * Run: npx tsx lib/services/service-desk/case-charge-core.test.ts
 *
 * Service Desk — the case charge and its billing links (migration 20261126090000), the pure rules and the real
 * settlement reader's mapping (no database: the reader runs over a fake transaction):
 *   P  input parsing: modes, positive integer agorot, reasons (1..1000 characters, trimmed), link roles, unlink reason;
 *   D  decisions: final statuses refused, NO_CHARGE / any change needs a reason, an identical record is NO_CHANGE, seq is
 *      last + 1, the source is OWNER_ENTERED (never APPROVED_QUOTE here), the payload is closed (no reason text);
 *      linking to a NO_CHARGE case is refused; a correction after DELIVERED is allowed;
 *   G  the link guard's refusals and the one-active-link UNIQUE map to stable codes; anything else is not named;
 *   R  the reader: no migration → UNKNOWN / NOT_LINKED (as before); no charge → UNKNOWN / NO_CHARGE_DECISION; NO_CHARGE →
 *      0; a charge with nothing documented → CHARGE_NOT_DOCUMENTED; an issued standalone receipt (billing's real facts
 *      shape) settles it; a billing read that throws → UNKNOWN / READ_ERROR; the handover shape drops the detail.
 */
import { Prisma } from "@prisma/client";

import {
  currentCharge,
  decideCharge,
  decideLink,
  decideUnlink,
  linkGuardCode,
  linkPayload,
  parseChargeInput,
  parseLinkInput,
  parseReason,
  parseUnlinkInput,
  REASON_MAX,
} from "./case-charge.core";
import { readCaseBalance, readCaseSettlement, settlementOf } from "./case-settlement-reader";

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`OK: ${name}`); } else { failures.push(name); console.log(`FAIL: ${name}${detail ? " — " + detail : ""}`); }
}
const j = (v: unknown) => JSON.stringify(v);

type FakeOpts = { ready?: boolean; charge?: { seq: number; mode: string; amountAgorot: number | null } | null; links?: { billingDocumentId: number; role: string }[];
  docs?: Record<string, unknown>[]; throwOnBilling?: boolean };
function fakeTx(o: FakeOpts) {
  return {
    $queryRaw: async (strings: TemplateStringsArray) => {
      const sql = strings.join("?");
      if (sql.includes("to_regclass")) return [{ ok: o.ready !== false }];
      if (sql.includes('FROM "ServiceCaseCharge"')) return o.charge ? [o.charge] : [];
      if (sql.includes('FROM "ServiceCaseBillingLink"')) return o.links ?? [];
      throw new Error(`unexpected query ${sql}`);
    },
    billingDocument: { findMany: async () => { if (o.throwOnBilling) throw new Error("db down"); return o.docs ?? []; } },
    billingPaymentAllocation: { findMany: async () => [] },
  } as never;
}

async function main() {
  console.log("P — parsing");
  ok("P1 CHARGEABLE 50000 → parsed, no reason needed at parse time", j(parseChargeInput({ mode: "CHARGEABLE", amountAgorot: 50000 })) === j({ ok: true, input: { mode: "CHARGEABLE", amountAgorot: 50000, reason: null } }));
  ok("P2 CHARGEABLE needs a positive integer amount ≤ int4 (0, -1, 1.5, '500', 2^31, missing → amountAgorot)",
    [0, -1, 1.5, "500", 2 ** 31, undefined, null].every((a) => j(parseChargeInput({ mode: "CHARGEABLE", amountAgorot: a })) === j({ ok: false, field: "amountAgorot" })));
  ok("P3 NO_CHARGE carries no amount (an amount → amountAgorot); null / missing fine",
    j(parseChargeInput({ mode: "NO_CHARGE", amountAgorot: 100, reason: "x" })) === j({ ok: false, field: "amountAgorot" })
      && parseChargeInput({ mode: "NO_CHARGE", amountAgorot: null, reason: "x" }).ok && parseChargeInput({ mode: "NO_CHARGE", reason: "x" }).ok);
  ok("P4 an unknown mode → mode", j(parseChargeInput({ mode: "FREE", amountAgorot: 1 })) === j({ ok: false, field: "mode" }));
  ok("P5 reasons: trimmed; blank → none; > 1000 characters (code points) → invalid; non-string → invalid",
    j(parseReason("  תיקון באחריות  ")) === j({ ok: true, reason: "תיקון באחריות" }) && j(parseReason("   ")) === j({ ok: true, reason: null })
      && parseReason("א".repeat(REASON_MAX)).ok && !parseReason("א".repeat(REASON_MAX + 1)).ok && !parseReason(5).ok
      && parseReason("😀".repeat(REASON_MAX)).ok);
  ok("P6 link: a positive document id and a known role", j(parseLinkInput({ billingDocumentId: 7, role: "CHARGE" })) === j({ ok: true, billingDocumentId: 7, role: "CHARGE" })
    && j(parseLinkInput({ billingDocumentId: "7", role: "CHARGE" })) === j({ ok: false, field: "billingDocumentId" })
    && j(parseLinkInput({ billingDocumentId: 7, role: "PAYMENT" })) === j({ ok: false, field: "role" }));
  ok("P7 unlink: the reason is required (missing / blank → reason)",
    j(parseUnlinkInput({ billingDocumentId: 7 })) === j({ ok: false, field: "reason" }) && j(parseUnlinkInput({ billingDocumentId: 7, reason: " " })) === j({ ok: false, field: "reason" })
      && j(parseUnlinkInput({ billingDocumentId: 7, reason: " קושר בטעות " })) === j({ ok: true, billingDocumentId: 7, reason: "קושר בטעות" }));

  console.log("D — decisions");
  const first = decideCharge("READY", null, { mode: "CHARGEABLE", amountAgorot: 50000, reason: null });
  ok("D1 the first CHARGEABLE record: seq 1, OWNER_ENTERED, payload { mode, amountAgorot, chargeSeq } only",
    first.ok && first.seq === 1 && first.source === "OWNER_ENTERED" && j(first.payload) === j({ mode: "CHARGEABLE", amountAgorot: 50000, chargeSeq: 1 }));
  ok("D2 NO_CHARGE without a reason → REASON_REQUIRED; with one → seq 1, no source, payload amount null and no reason text",
    j(decideCharge("CHECKED_IN", null, { mode: "NO_CHARGE", amountAgorot: null, reason: null })) === j({ ok: false, violations: ["REASON_REQUIRED"] })
      && (() => { const d = decideCharge("CHECKED_IN", null, { mode: "NO_CHARGE", amountAgorot: null, reason: "אחריות החנות" }); return d.ok && d.source === null && j(d.payload) === j({ mode: "NO_CHARGE", amountAgorot: null, chargeSeq: 1 }) && !j(d.payload).includes("אחריות"); })());
  const prev = { seq: 2, mode: "CHARGEABLE" as const, amountAgorot: 50000 };
  ok("D3 a change after a record needs a reason; with it → seq 3",
    j(decideCharge("IN_REPAIR", prev, { mode: "CHARGEABLE", amountAgorot: 60000, reason: null })) === j({ ok: false, violations: ["REASON_REQUIRED"] })
      && (() => { const d = decideCharge("IN_REPAIR", prev, { mode: "CHARGEABLE", amountAgorot: 60000, reason: "חלק נוסף" }); return d.ok && d.seq === 3; })());
  ok("D4 the same mode and amount again → NO_CHANGE", j(decideCharge("READY", prev, { mode: "CHARGEABLE", amountAgorot: 50000, reason: "שוב" })) === j({ ok: false, violations: ["NO_CHANGE"] }));
  ok("D5 CLOSED / CANCELLED → TERMINAL_STATUS (record, link, unlink); DELIVERED and ABANDONED → allowed (a correction after the handover)",
    (["CLOSED", "CANCELLED"] as const).every((s) => !decideCharge(s, null, { mode: "CHARGEABLE", amountAgorot: 1, reason: null }).ok && !decideLink(s, null).ok && !decideUnlink(s).ok)
      && decideCharge("DELIVERED", prev, { mode: "CHARGEABLE", amountAgorot: 70000, reason: "תיקון אחרי מסירה" }).ok
      && decideCharge("ABANDONED", null, { mode: "CHARGEABLE", amountAgorot: 1, reason: null }).ok && decideLink("DELIVERED", null).ok && decideUnlink("DELIVERED").ok);
  ok("D6 linking a document to a case marked free of charge → NO_CHARGE_WITH_DOCUMENTS; with no charge yet or CHARGEABLE → allowed",
    j(decideLink("READY", { mode: "NO_CHARGE" })) === j({ ok: false, violations: ["NO_CHARGE_WITH_DOCUMENTS"] }) && decideLink("READY", null).ok && decideLink("READY", { mode: "CHARGEABLE", amountAgorot: 5 }).ok
      && decideLink("READY", { mode: "NO_CHARGE" }, "AFTER_SALE_CREDIT").ok && !decideLink("READY", { mode: "NO_CHARGE" }, "STANDALONE_PAYMENT").ok);
  ok("D7 currentCharge maps the last record (null → null)", currentCharge(null) === null && j(currentCharge(prev)) === j({ mode: "CHARGEABLE", amountAgorot: 50000 })
    && j(currentCharge({ seq: 1, mode: "NO_CHARGE", amountAgorot: null })) === j({ mode: "NO_CHARGE" }));
  ok("D8 the link payload is the role token and the document id only", j(linkPayload({ billingDocumentId: 9, role: "STANDALONE_PAYMENT" })) === j({ role: "STANDALONE_PAYMENT", billingDocumentId: 9 }));

  console.log("G — guard refusals");
  const pg = (m: string, code?: string) => Object.assign(new Error(m), code ? { code } : {});
  ok("G1 SERVICE_BILLING_LINK_DOCUMENT (missing, or another business's) → BILLING_DOCUMENT_NOT_FOUND", linkGuardCode(pg("ERROR: SERVICE_BILLING_LINK_DOCUMENT: no such billing document in this business")) === "BILLING_DOCUMENT_NOT_FOUND");
  ok("G2 SERVICE_BILLING_LINK_ROLE → BILLING_DOCUMENT_ROLE_MISMATCH", linkGuardCode(pg("SERVICE_BILLING_LINK_ROLE: CHARGE links a tax invoice")) === "BILLING_DOCUMENT_ROLE_MISMATCH");
  ok("G3 SERVICE_BILLING_LINK_RECEIPT_NOT_ISSUED → RECEIPT_NOT_ISSUED (not mistaken for the document refusal)", linkGuardCode(pg("SERVICE_BILLING_LINK_RECEIPT_NOT_ISSUED: only an issued receipt")) === "RECEIPT_NOT_ISSUED");
  ok("G4 the one-active-link UNIQUE (23505 / P2002 / index name) → BILLING_DOCUMENT_ALREADY_LINKED",
    linkGuardCode(pg("duplicate key", "23505")) === "BILLING_DOCUMENT_ALREADY_LINKED" && linkGuardCode(pg("x", "P2002")) === "BILLING_DOCUMENT_ALREADY_LINKED"
      && linkGuardCode(pg('duplicate key value violates unique constraint "ServiceCaseBillingLink_one_active_per_document"')) === "BILLING_DOCUMENT_ALREADY_LINKED");
  ok("G5 anything else (another guard, a network error) → not named here", linkGuardCode(pg("SERVICE_UI_BUSINESS_DELETING: x")) === null && linkGuardCode(pg("connection reset")) === null);

  console.log("R — the real settlement reader");
  ok("R1 no migration → UNKNOWN / NOT_LINKED (the reader it replaces)", j(await readCaseSettlement(fakeTx({ ready: false }), 1, 1)) === j({ state: "UNKNOWN", openBalanceAgorot: null, reason: "NOT_LINKED" }));
  ok("R2 no charge record → UNKNOWN / NO_CHARGE_DECISION (the absence of a document is never 'no debt')",
    j(await readCaseSettlement(fakeTx({ charge: null }), 1, 1)) === j({ state: "UNKNOWN", openBalanceAgorot: null, reason: "NO_CHARGE_DECISION" }));
  ok("R3 NO_CHARGE, no link → NO_CHARGE 0", j(await readCaseSettlement(fakeTx({ charge: { seq: 1, mode: "NO_CHARGE", amountAgorot: null } }), 1, 1)) === j({ state: "NO_CHARGE", openBalanceAgorot: 0 }));
  ok("R4 CHARGEABLE 50000, nothing linked → CHARGE_NOT_DOCUMENTED 50000 (a debt)",
    j(await readCaseSettlement(fakeTx({ charge: { seq: 1, mode: "CHARGEABLE", amountAgorot: 50000 } }), 1, 1)) === j({ state: "CHARGE_NOT_DOCUMENTED", openBalanceAgorot: 50000 }));
  const receipt = { id: 7, documentType: "RECEIPT", status: "ISSUED", currency: "ILS", totalAmount: new Prisma.Decimal("500.00"), issuedAt: new Date(0), unappliedAmount: new Prisma.Decimal(0), sourcePaymentTransactionId: null };
  const exempt = fakeTx({ charge: { seq: 1, mode: "CHARGEABLE", amountAgorot: 50000 }, links: [{ billingDocumentId: 7, role: "STANDALONE_PAYMENT" }], docs: [receipt] });
  ok("R5 exempt dealer: 50000 + an issued standalone receipt of 500.00 (billing's real reader over the fake rows) → SETTLED 0",
    j(await readCaseSettlement(exempt, 1, 1)) === j({ state: "SETTLED", openBalanceAgorot: 0 }));
  const over = fakeTx({ charge: { seq: 1, mode: "CHARGEABLE", amountAgorot: 40000 }, links: [{ billingDocumentId: 7, role: "STANDALONE_PAYMENT" }], docs: [receipt] });
  const ob = await readCaseBalance(over, 1, 1);
  ok("R6 overpaid by 10000 → SETTLED with overpaidAgorot (never silently 0); the detail explains it; the handover shape drops the detail",
    ob.state === "SETTLED" && (ob as { overpaidAgorot?: number }).overpaidAgorot === 10000 && ob.detail.overpaidAgorot === 10000 && ob.detail.paidAgorot === 50000
      && j(settlementOf(ob)) === j({ state: "SETTLED", openBalanceAgorot: 0, overpaidAgorot: 10000 }));
  const broken = fakeTx({ charge: { seq: 1, mode: "CHARGEABLE", amountAgorot: 50000 }, links: [{ billingDocumentId: 7, role: "STANDALONE_PAYMENT" }], throwOnBilling: true });
  ok("R7 a billing read that throws → UNKNOWN / READ_ERROR (the charge kept in the detail)",
    j(await readCaseSettlement(broken, 1, 1)) === j({ state: "UNKNOWN", openBalanceAgorot: null, reason: "READ_ERROR" }) && (await readCaseBalance(broken, 1, 1)).detail.chargeAgorot === 50000);
  const draft = fakeTx({ charge: { seq: 1, mode: "CHARGEABLE", amountAgorot: 50000 }, links: [{ billingDocumentId: 8, role: "CHARGE" }], docs: [{ ...receipt, id: 8, documentType: "TAX_INVOICE", status: "DRAFT" }] });
  ok("R8 a linked draft invoice → UNKNOWN / DRAFT_PENDING", j(await readCaseSettlement(draft, 1, 1)) === j({ state: "UNKNOWN", openBalanceAgorot: null, reason: "DRAFT_PENDING" }));
  const vanished = fakeTx({ charge: { seq: 1, mode: "CHARGEABLE", amountAgorot: 50000 }, links: [{ billingDocumentId: 9, role: "CHARGE" }], docs: [] });
  ok("R9 a linked document billing does not return (another business / gone) → UNKNOWN / CONFLICT", j(await readCaseSettlement(vanished, 1, 1)) === j({ state: "UNKNOWN", openBalanceAgorot: null, reason: "CONFLICT" }));

  console.log(`\ncase-charge-core: ${pass} passed, ${failures.length} failed`);
  if (failures.length > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
