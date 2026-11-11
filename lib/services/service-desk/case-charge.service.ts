/**
 * Service Desk — the case charge and its billing links (migration 20261126090000). SERVER-ONLY. No UI, no route logic,
 * no flag logic (the HTTP edge decides FULL / READ_ONLY / NONE before a write is called).
 *
 * Three owner commands, each a P4-style STATUS-PRESERVING record (recordCommand: one tenant transaction → the case row
 * FOR UPDATE → the P4 journal present → an earlier answer for this Idempotency-Key? → expectedVersion → work → one
 * journal event whose seq is the bumped case version; status / hold / cancel request / outcome untouched):
 *
 *   recordCharge           a new ServiceCaseCharge record (seq = last + 1, OWNER_ENTERED or NO_CHARGE) + charge.recorded
 *                          — checked against the active links and billing's facts read in the same transaction
 *                          (checkChargeChange); also after DELIVERED (a correction; the handover row is never touched)
 *   linkBillingDocument    a new ServiceCaseBillingLink row + billing.linked
 *   unlinkBillingDocument  the active link gets unlinked (time, who, why) + billing.unlinked
 *
 * The journal payload is closed (tokens, numbers, booleans); reasons live in their own columns, never in the journal.
 * Without migration 20261126090000 every command answers NOT_AVAILABLE_UNTIL_MIGRATION and writes nothing.
 * Billing is only READ (readDocumentsSettlement, #1102) — nothing in billing changes.
 *
 * The quote approval's automatic charge (APPROVED_QUOTE) is OUT of scope: quotes are not implemented yet (see the note in
 * case-charge.core.ts).
 */
import { tenantTx } from "@/lib/tenant/tenant-tx";

import { checkChargeChange, type CaseBalance, type CaseBillingLink } from "./case-balance";
import {
  currentCharge,
  decideCharge,
  decideLink,
  decideUnlink,
  linkGuardCode,
  linkPayload,
  parseChargeInput,
  parseLinkInput,
  parseUnlinkInput,
} from "./case-charge.core";
import { activeLinks, balanceOf, billingFacts, chargeSchemaReady, lastCharge } from "./case-settlement-reader";
import { ServiceDeskError } from "./service-desk-errors";
import {
  appendRecord,
  isPositiveInt,
  prepare,
  recordCommand,
  type CommandResult,
  type ServiceDeskPrincipal,
  type Tx,
  type WriteRequest,
} from "./service-case.service";

async function requireChargeSchema(tx: Tx) {
  if (!(await chargeSchemaReady(tx))) throw new ServiceDeskError("NOT_AVAILABLE_UNTIL_MIGRATION");
}

// ── Commands ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Record what the case is charged: CHARGEABLE (amountAgorot > 0, ILS) or NO_CHARGE (with a reason). A reason is required
 * for NO_CHARGE and for every change after the first record. Refused when it contradicts the linked documents.
 */
export async function recordCharge(
  p: ServiceDeskPrincipal,
  caseId: unknown,
  body: { mode?: unknown; amountAgorot?: unknown; reason?: unknown; expectedVersion?: unknown },
  req: WriteRequest,
): Promise<CommandResult> {
  if (!isPositiveInt(caseId)) throw new ServiceDeskError("NOT_FOUND");
  const parsed = parseChargeInput(body);
  if (!parsed.ok) throw new ServiceDeskError("INVALID_INPUT", { field: parsed.field });
  const input = parsed.input;
  const b = p.businessId;
  const prepared = prepare(p, req, "service-desk/cases:charge", { caseId, ...input, expectedVersion: body.expectedVersion });
  return recordCommand(p, caseId, body.expectedVersion, prepared, async (tx, { context }) => {
    await requireChargeSchema(tx);
    const previous = await lastCharge(tx, b, caseId);
    const d = decideCharge(context.status, previous, input);
    if (!d.ok) throw new ServiceDeskError("REFUSED", { violations: d.violations });
    const links = await activeLinks(tx, b, caseId);
    const facts = await billingFacts(tx, b, links);
    if (facts === null) throw new ServiceDeskError("BALANCE_UNKNOWN");
    const check = checkChargeChange(d.charge, links, facts);
    if (!check.ok) throw new ServiceDeskError(check.code);
    await tx.$executeRaw`
      INSERT INTO "ServiceCaseCharge" ("businessId", "caseId", seq, mode, "amountAgorot", source, reason, actor, "actorUserId")
      VALUES (${b}::int, ${caseId}::int, ${d.seq}::int, ${input.mode}::"ServiceChargeMode", ${input.amountAgorot}::int,
              ${d.source}::"ServiceChargeSource", ${input.reason}::text, 'OWNER_USER'::"ServiceActor", ${p.userId}::int)`;
    await appendRecord(tx, b, caseId, context, "RECORD_CHARGE", d.payload, p.userId, prepared);
  });
}

/**
 * Link a billing document of this business to the case: CHARGE (a tax invoice or a tax invoice / receipt) or
 * STANDALONE_PAYMENT (an ISSUED receipt attributed to no invoice). A document is actively linked to at most one case.
 */
export async function linkBillingDocument(
  p: ServiceDeskPrincipal,
  caseId: unknown,
  body: { billingDocumentId?: unknown; role?: unknown; expectedVersion?: unknown },
  req: WriteRequest,
): Promise<CommandResult> {
  if (!isPositiveInt(caseId)) throw new ServiceDeskError("NOT_FOUND");
  const parsed = parseLinkInput(body);
  if (!parsed.ok) throw new ServiceDeskError("INVALID_INPUT", { field: parsed.field });
  const link: CaseBillingLink = { billingDocumentId: parsed.billingDocumentId, role: parsed.role };
  const b = p.businessId;
  const prepared = prepare(p, req, "service-desk/cases:billing-link", { caseId, ...link, expectedVersion: body.expectedVersion });
  return recordCommand(p, caseId, body.expectedVersion, prepared, async (tx, { context }) => {
    await requireChargeSchema(tx);
    const d = decideLink(context.status, currentCharge(await lastCharge(tx, b, caseId)), parsed.role);
    if (!d.ok) {
      if (d.violations.length === 1 && d.violations[0] === "NO_CHARGE_WITH_DOCUMENTS") throw new ServiceDeskError("NO_CHARGE_WITH_DOCUMENTS");
      throw new ServiceDeskError("REFUSED", { violations: d.violations });
    }
    // Already active somewhere in this business? (Same business only — RLS; the partial UNIQUE re-checks a race.)
    const active = (await tx.$queryRaw<{ caseId: number }[]>`
      SELECT "caseId" FROM "ServiceCaseBillingLink"
       WHERE "businessId" = ${b}::int AND "billingDocumentId" = ${link.billingDocumentId}::int AND "unlinkedAt" IS NULL`)[0];
    if (active) throw new ServiceDeskError("BILLING_DOCUMENT_ALREADY_LINKED", { sameCase: Number(active.caseId) === caseId });
    try {
      await tx.$executeRaw`
        INSERT INTO "ServiceCaseBillingLink" ("businessId", "caseId", "billingDocumentId", role, "linkedByUserId")
        VALUES (${b}::int, ${caseId}::int, ${link.billingDocumentId}::int, ${link.role}::"ServiceBillingLinkRole", ${p.userId}::int)`;
    } catch (e) {
      const code = linkGuardCode(e);
      if (code) throw new ServiceDeskError(code);
      throw e;
    }
    await appendRecord(tx, b, caseId, context, "LINK_BILLING_DOCUMENT", linkPayload(link), p.userId, prepared);
  });
}

/** Unlink the ACTIVE link of a document from this case, with the owner's reason. The row stays (history). */
export async function unlinkBillingDocument(
  p: ServiceDeskPrincipal,
  caseId: unknown,
  body: { billingDocumentId?: unknown; reason?: unknown; expectedVersion?: unknown },
  req: WriteRequest,
): Promise<CommandResult> {
  if (!isPositiveInt(caseId)) throw new ServiceDeskError("NOT_FOUND");
  const parsed = parseUnlinkInput(body);
  if (!parsed.ok) throw new ServiceDeskError("INVALID_INPUT", { field: parsed.field });
  const b = p.businessId;
  const prepared = prepare(p, req, "service-desk/cases:billing-unlink", { caseId, billingDocumentId: parsed.billingDocumentId, reason: parsed.reason, expectedVersion: body.expectedVersion });
  return recordCommand(p, caseId, body.expectedVersion, prepared, async (tx, { context }) => {
    await requireChargeSchema(tx);
    const d = decideUnlink(context.status);
    if (!d.ok) throw new ServiceDeskError("REFUSED", { violations: d.violations });
    const row = (await tx.$queryRaw<{ id: number; role: string }[]>`
      SELECT id, role::text AS role FROM "ServiceCaseBillingLink"
       WHERE "businessId" = ${b}::int AND "caseId" = ${caseId}::int AND "billingDocumentId" = ${parsed.billingDocumentId}::int AND "unlinkedAt" IS NULL
       FOR UPDATE`)[0];
    if (!row) throw new ServiceDeskError("LINK_NOT_FOUND");
    await tx.$executeRaw`
      UPDATE "ServiceCaseBillingLink" SET "unlinkedAt" = now(), "unlinkedByUserId" = ${p.userId}::int, "unlinkReason" = ${parsed.reason}::text
       WHERE id = ${Number(row.id)}::int AND "businessId" = ${b}::int AND "unlinkedAt" IS NULL`;
    await appendRecord(tx, b, caseId, context, "UNLINK_BILLING_DOCUMENT",
      linkPayload({ billingDocumentId: parsed.billingDocumentId, role: row.role as CaseBillingLink["role"] }), p.userId, prepared);
  });
}

// ── Read model (FULL and READ_ONLY) ─────────────────────────────────────────────────────────────────────────

export type CaseChargeRecord = {
  seq: number; mode: "CHARGEABLE" | "NO_CHARGE"; amountAgorot: number | null; currency: string; source: "APPROVED_QUOTE" | "OWNER_ENTERED" | null;
  quoteVersion: number | null; reason: string | null; actor: string; actorUserId: number | null; createdAt: string;
};

export type CaseBillingLinkView = {
  id: number; billingDocumentId: number; role: "CHARGE" | "STANDALONE_PAYMENT" | "AFTER_SALE_CREDIT"; active: boolean;
  linkedAt: string; linkedByUserId: number | null; unlinkedAt: string | null; unlinkedByUserId: number | null; unlinkReason: string | null;
  /** billing's facts for an ACTIVE link (null for history): type, status, ILS total, and why it cannot be counted */
  document: { type: string | null; status: string | null; currency: string | null; totalAgorot: number | null; flag: string | null } | null;
};

export type CaseChargesView = {
  caseId: number; version: number; status: string;
  charges: CaseChargeRecord[];
  current: CaseChargeRecord | null;
  links: CaseBillingLinkView[];
  balance: CaseBalance;
};

/** The charge history, every link (active first, then history), and the balance computed now — for the case screen. */
export async function getCaseCharges(businessId: number, caseId: unknown): Promise<CaseChargesView> {
  if (!isPositiveInt(caseId)) throw new ServiceDeskError("NOT_FOUND");
  return tenantTx(businessId, async (tx) => {
    const c = (await tx.$queryRaw<{ version: number; status: string }[]>`
      SELECT version, status::text AS status FROM "ServiceCase" WHERE id = ${caseId}::int AND "businessId" = ${businessId}::int`)[0];
    if (!c) throw new ServiceDeskError("NOT_FOUND");
    await requireChargeSchema(tx);
    const chargeRows = await tx.$queryRaw<Record<string, unknown>[]>`
      SELECT seq, mode::text AS mode, "amountAgorot", currency, source::text AS source, "quoteVersion", reason, actor::text AS actor, "actorUserId",
             to_char("createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt"
        FROM "ServiceCaseCharge" WHERE "businessId" = ${businessId}::int AND "caseId" = ${caseId}::int ORDER BY seq`;
    const linkRows = await tx.$queryRaw<Record<string, unknown>[]>`
      SELECT id, "billingDocumentId", role::text AS role, "unlinkedAt" IS NULL AS active, "linkedByUserId", "unlinkedByUserId", "unlinkReason",
             to_char("linkedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "linkedAt",
             to_char("unlinkedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "unlinkedAt"
        FROM "ServiceCaseBillingLink" WHERE "businessId" = ${businessId}::int AND "caseId" = ${caseId}::int
       ORDER BY ("unlinkedAt" IS NULL) DESC, id`;
    const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
    const charges: CaseChargeRecord[] = chargeRows.map((r) => ({
      seq: Number(r.seq), mode: r.mode as CaseChargeRecord["mode"], amountAgorot: num(r.amountAgorot), currency: String(r.currency).trim(),
      source: (r.source as CaseChargeRecord["source"]) ?? null, quoteVersion: num(r.quoteVersion), reason: (r.reason as string) ?? null,
      actor: String(r.actor), actorUserId: num(r.actorUserId), createdAt: String(r.createdAt),
    }));
    const current = charges.at(-1) ?? null;
    const active: CaseBillingLink[] = linkRows.filter((r) => r.active === true)
      .map((r) => ({ billingDocumentId: Number(r.billingDocumentId), role: r.role as CaseBillingLink["role"] }));
    // the billing read comes LAST: a failure there leaves nothing else to read in this transaction
    const facts = await billingFacts(tx, businessId, active);
    const charge = currentCharge(current ? { seq: current.seq, mode: current.mode, amountAgorot: current.amountAgorot } : null);
    const links: CaseBillingLinkView[] = linkRows.map((r) => {
      const isActive = r.active === true;
      const doc = isActive ? facts?.documents.find((d) => d.id === Number(r.billingDocumentId)) : undefined;
      return {
        id: Number(r.id), billingDocumentId: Number(r.billingDocumentId), role: r.role as CaseBillingLinkView["role"], active: isActive,
        linkedAt: String(r.linkedAt), linkedByUserId: num(r.linkedByUserId), unlinkedAt: (r.unlinkedAt as string) ?? null,
        unlinkedByUserId: num(r.unlinkedByUserId), unlinkReason: (r.unlinkReason as string) ?? null,
        document: doc ? { type: doc.type, status: doc.status, currency: doc.currency, totalAgorot: doc.totalAgorot, flag: doc.flag } : null,
      };
    });
    return { caseId, version: Number(c.version), status: c.status, charges, current, links, balance: balanceOf(charge, active, facts) };
  });
}
