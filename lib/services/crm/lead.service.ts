/**
 * Canonical Lead service — the single source of truth for Lead create / read /
 * list / update / status / follow-up.
 *
 * Shape and discipline are copied from `customer.service.ts` on purpose:
 * exported `leadService` object, typed `Input` types, `assertBusinessId`,
 * `normalize*` helpers, `where: { id, businessId }` on every read, and
 * `updateMany` + count check on every write so a row belonging to another
 * business can never be touched by id alone.
 *
 * ARCHITECTURE — Lead sits ABOVE Customer, it does not replace it.
 * `Customer` stays the identity/contact record (WhatsApp intake already creates
 * one for every unknown sender, and Billing / Payments / Appointments /
 * Conversation all point at it). A Lead is the COMMERCIAL state on top: status,
 * source, intent, follow-up clock. Identity is resolved through the existing
 * `customerService` — this file never re-implements customer creation.
 *
 * NO new engine is introduced here: notes and attachments come from the generic
 * CRM subject engines, and every business event goes to the existing
 * `logAuditEvent` → `LearningEvent`. There is no cron, worker or queue.
 */

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  ConflictError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from "@/lib/errors";
import { logAuditEvent } from "@/lib/services/audit.service";
import { customerService } from "@/lib/services/crm/customer.service";
import { normalizeCustomerPhone } from "@/lib/services/integrations/whatsapp/phone";
import {
  CLOSED_LEAD_STATUSES,
  LEAD_FOLLOWUP_NOTE_MAX,
  LEAD_INTENT_MAX,
  LEAD_LOST_REASON_MAX,
  LEAD_NAME_MAX,
  LEAD_SOURCE_MAX,
  OPEN_LEAD_STATUSES,
  classifyLeadStatusTransition,
  endOfLeadDayUtc,
  startOfLeadDayUtc,
  isClosedLeadStatus,
  normalizeLeadEmail,
  normalizeLeadName,
  normalizeLeadOptionalText,
  parseFollowUpAt,
  parseLeadStatus,
  type LeadStatusValue,
} from "@/lib/services/crm/lead-core";

type Tx = Prisma.TransactionClient;
type TxOptions = { tx?: Tx };

const LIST_MAX_LIMIT = 100;
const LIST_DEFAULT_LIMIT = 50;

/** The unique index that enforces "one OPEN lead per phone per business". */
const OPEN_PHONE_INDEX = "Lead_open_phone_key";

/** Default source for a lead the owner typed in by hand. */
export const LEAD_SOURCE_MANUAL = "MANUAL";

/** Event vocabulary — UPPER_SNAKE, domain-prefixed, matching Billing's convention. */
export const LEAD_EVENTS = {
  CREATED: "LEAD_CREATED",
  UPDATED: "LEAD_UPDATED",
  STATUS_CHANGED: "LEAD_STATUS_CHANGED",
  FOLLOWUP_SET: "LEAD_FOLLOWUP_SET",
  FOLLOWUP_RESCHEDULED: "LEAD_FOLLOWUP_RESCHEDULED",
  FOLLOWUP_COMPLETED: "LEAD_FOLLOWUP_COMPLETED",
  WON: "LEAD_WON",
  LOST: "LEAD_LOST",
  /** W2 — a lead was created out of a conversation. */
  CREATED_FROM_CONVERSATION: "LEAD_CREATED_FROM_CONVERSATION",
  /** W2 — a conversation was attached to a lead (new or pre-existing). */
  CONVERSATION_LINKED: "LEAD_CONVERSATION_LINKED",
} as const;

const LEAD_ENTITY_TYPE = "LEAD";

/* -------------------------------------------------------------------- types */

export type CreateLeadInput = {
  businessId: number;
  name: string;
  phone?: string | null;
  email?: string | null;
  intentSnapshot?: string | null;
  sourceChannel?: string | null;
};

export type UpdateLeadInput = {
  businessId: number;
  leadId: number;
  name?: string;
  phone?: string | null;
  email?: string | null;
  intentSnapshot?: string | null;
  sourceChannel?: string | null;
};

export type UpdateLeadStatusInput = {
  businessId: number;
  leadId: number;
  status: LeadStatusValue | string;
  /** Only meaningful when moving to LOST; ignored otherwise. */
  lostReason?: string | null;
};

export type SetLeadFollowUpInput = {
  businessId: number;
  leadId: number;
  /** ISO-8601 instant. */
  followUpAt: string;
  note?: string | null;
};

export type ClearLeadFollowUpInput = {
  businessId: number;
  leadId: number;
};

export type GetLeadInput = {
  businessId: number;
  leadId: number;
};

/** `open` / `closed` are convenience groups over the real statuses. */
export type LeadStatusFilter = "open" | "closed" | "all" | LeadStatusValue;

export type ListLeadsInput = {
  businessId: number;
  /** Matches name, phone or email (case-insensitive substring). */
  query?: string | null;
  status?: LeadStatusFilter | null;
  sourceChannel?: string | null;
  /** True → only open leads whose follow-up is due today or already overdue. */
  needsAction?: boolean | null;
  limit?: number | null;
  /** `id` of the last row of the previous page (keyset pagination). */
  cursorId?: number | null;
  now?: Date;
};

/* ------------------------------------------------------------------ helpers */

function assertBusinessId(businessId: number): void {
  if (!businessId || Number.isNaN(businessId)) {
    throw new UnauthorizedError("Invalid business id");
  }
}

function normalizeLeadId(value: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ValidationError("Invalid lead id");
  }
  return parsed;
}

/**
 * Canonicalize a phone for a Lead.
 *
 * Unlike `Customer`, a Lead REFUSES a phone it cannot canonicalize instead of
 * silently storing null: the owner typed something they believe is a phone
 * number, and quietly dropping it would leave a lead nobody can call. Absent is
 * fine; wrong is not.
 */
function normalizeLeadPhone(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== "string") {
    throw new ValidationError("phone must be a string or null");
  }
  if (!value.trim()) return null;
  const normalized = normalizeCustomerPhone(value);
  if (!normalized) {
    throw new ValidationError("phone is not a valid number");
  }
  return normalized;
}

function clampLimit(value?: number | null): number {
  if (value == null) return LIST_DEFAULT_LIMIT;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ValidationError("limit must be a positive integer");
  }
  return Math.min(parsed, LIST_MAX_LIMIT);
}

/** True when a Prisma error is the open-lead-per-phone collision. */
function isOpenPhoneCollision(error: unknown): boolean {
  if (
    !(error instanceof Prisma.PrismaClientKnownRequestError) ||
    error.code !== "P2002"
  ) {
    return false;
  }
  const target = error.meta?.target;
  if (typeof target === "string") return target.includes(OPEN_PHONE_INDEX);
  if (Array.isArray(target)) return target.join(",").includes(OPEN_PHONE_INDEX);
  // Postgres partial indexes are not always echoed in `meta.target`; the
  // service pre-checks the same rule, so reaching here means a genuine race on
  // that index and treating it as the collision is the correct reading.
  return true;
}

function openLeadConflict(existingLeadId: number | null): ConflictError {
  const suffix = existingLeadId === null ? "" : ` (#${existingLeadId})`;
  return new ConflictError(
    "OPEN_LEAD_EXISTS",
    `כבר קיים ליד פתוח עם מספר הטלפון הזה${suffix}.`
  );
}

/** Find the open lead already holding this phone, if any. Tenant-scoped. */
async function findOpenLeadByPhone(
  db: Tx | typeof prisma,
  businessId: number,
  phone: string,
  excludeLeadId?: number
): Promise<{ id: number } | null> {
  return db.lead.findFirst({
    where: {
      businessId,
      phone,
      status: { in: [...OPEN_LEAD_STATUSES] },
      ...(excludeLeadId ? { id: { not: excludeLeadId } } : {}),
    },
    select: { id: true },
  });
}

/**
 * Resolve the contact behind a lead to a `Customer`, reusing the canonical
 * service. Never a parallel customer implementation.
 *
 * With a phone: look up `(businessId, phone)` — the existing unique key — and
 * reuse the row when it is there. Without a phone there is no identity to match
 * on, so a fresh contact is created; two same-named walk-ins genuinely ARE two
 * contacts, and merging them would be a fabrication.
 */
async function resolveCustomerForLead(
  db: Tx,
  input: {
    businessId: number;
    name: string;
    phone: string | null;
    email: string | null;
  }
): Promise<number> {
  if (input.phone) {
    const existing = await db.customer.findFirst({
      where: { businessId: input.businessId, phone: input.phone },
      select: { id: true },
    });
    if (existing) return existing.id;
  }

  const created = await customerService.createCustomer(
    {
      businessId: input.businessId,
      name: input.name,
      phone: input.phone,
      email: input.email,
    },
    { tx: db }
  );
  return created.id;
}

/* ------------------------------------------------------------------ service */

export const leadService = {
  /**
   * Create a lead by hand.
   *
   * Order inside ONE transaction: validate → resolve/create the Customer →
   * pre-check the open-lead rule → insert → emit `LEAD_CREATED`. The pre-check
   * exists for a friendly 409 that names the existing lead; the partial unique
   * index behind it is what actually makes the rule race-proof.
   */
  async createLead(input: CreateLeadInput, options?: TxOptions) {
    assertBusinessId(input.businessId);

    const name = normalizeLeadName(input.name);
    const phone = normalizeLeadPhone(input.phone);
    const email = normalizeLeadEmail(input.email);
    const intentSnapshot = normalizeLeadOptionalText(
      input.intentSnapshot,
      "intentSnapshot",
      LEAD_INTENT_MAX
    );
    const sourceChannel =
      normalizeLeadOptionalText(
        input.sourceChannel,
        "sourceChannel",
        LEAD_SOURCE_MAX
      ) ?? LEAD_SOURCE_MANUAL;

    const run = async (tx: Tx) => {
      if (phone) {
        const clash = await findOpenLeadByPhone(tx, input.businessId, phone);
        if (clash) throw openLeadConflict(clash.id);
      }

      const customerId = await resolveCustomerForLead(tx, {
        businessId: input.businessId,
        name,
        phone,
        email,
      });

      const now = new Date();
      let lead;
      try {
        lead = await tx.lead.create({
          data: {
            businessId: input.businessId,
            customerName: name,
            phone,
            email,
            intentSnapshot,
            sourceChannel,
            customerId,
            status: "NEW",
            lastActivityAt: now,
          },
        });
      } catch (error) {
        if (isOpenPhoneCollision(error)) {
          throw openLeadConflict(null);
        }
        throw error;
      }

      await logAuditEvent(
        {
          businessId: input.businessId,
          eventType: LEAD_EVENTS.CREATED,
          entityType: LEAD_ENTITY_TYPE,
          entityId: lead.id,
          payload: {
            sourceChannel,
            hasPhone: phone !== null,
            hasEmail: email !== null,
            customerId,
          },
        },
        { tx }
      );

      return lead;
    };

    if (options?.tx) return run(options.tx);
    throw new ValidationError(
      "createLead must run inside a tenant transaction (pass options.tx)"
    );
  },

  /** Fetch one lead, tenant-scoped. Cross-tenant behaves exactly like missing. */
  async getLead(input: GetLeadInput, options?: TxOptions) {
    assertBusinessId(input.businessId);
    const leadId = normalizeLeadId(input.leadId);

    const db = options?.tx ?? prisma;
    const lead = await db.lead.findFirst({
      where: { id: leadId, businessId: input.businessId },
    });
    if (!lead) throw new NotFoundError("Lead not found");
    return lead;
  },

  /**
   * List / search leads.
   *
   * `needsAction` is resolved in SQL against the end of TODAY in Israel
   * (`endOfLeadDayUtc`), not by over-fetching and filtering in JS — otherwise
   * `limit` would silently drop due leads off the end of the page.
   */
  async listLeads(input: ListLeadsInput, options?: TxOptions) {
    assertBusinessId(input.businessId);

    const where: Prisma.LeadWhereInput = { businessId: input.businessId };

    const q = typeof input.query === "string" ? input.query.trim() : "";
    if (q.length > 0) {
      where.OR = [
        { customerName: { contains: q, mode: "insensitive" } },
        { phone: { contains: q, mode: "insensitive" } },
        { email: { contains: q, mode: "insensitive" } },
      ];
    }

    const status = input.status ?? "open";
    if (status === "open") {
      where.status = { in: [...OPEN_LEAD_STATUSES] };
    } else if (status === "closed") {
      where.status = { in: [...CLOSED_LEAD_STATUSES] };
    } else if (status !== "all") {
      where.status = parseLeadStatus(status);
    }

    const source = normalizeLeadOptionalText(
      input.sourceChannel,
      "sourceChannel",
      LEAD_SOURCE_MAX
    );
    if (source) where.sourceChannel = source;

    if (input.needsAction) {
      // The SQL mirror of `evaluateLeadAttention` (W2). Expressed as a database
      // predicate — not filtered in JS after a `take` — so `limit` can never
      // silently drop a lead that needs the owner off the end of the page.
      //
      //   open AND ( follow-up already due  OR  untouched new lead from before today )
      const now = input.now ?? new Date();
      where.status = { in: [...OPEN_LEAD_STATUSES] };
      where.OR = [
        ...(where.OR ?? []),
        { nextFollowUpAt: { lte: endOfLeadDayUtc(now) } },
        {
          status: "NEW",
          nextFollowUpAt: null,
          createdAt: { lt: startOfLeadDayUtc(now) },
        },
      ];
      // A text query and the attention predicate are both OR-shaped; combining
      // them in one `OR` would widen rather than narrow. Nest them so the two
      // stay ANDed.
      if (q.length > 0) {
        where.AND = [
          {
            OR: [
              { customerName: { contains: q, mode: "insensitive" } },
              { phone: { contains: q, mode: "insensitive" } },
              { email: { contains: q, mode: "insensitive" } },
            ],
          },
          {
            OR: [
              { nextFollowUpAt: { lte: endOfLeadDayUtc(now) } },
              {
                status: "NEW",
                nextFollowUpAt: null,
                createdAt: { lt: startOfLeadDayUtc(now) },
              },
            ],
          },
        ];
        delete where.OR;
      }
    }

    const take = clampLimit(input.limit);
    const db = options?.tx ?? prisma;

    return db.lead.findMany({
      where,
      // Deterministic and index-friendly: newest activity first, `id` breaks
      // ties so keyset pagination can never repeat or skip a row.
      orderBy: [{ lastActivityAt: "desc" }, { id: "desc" }],
      take,
      ...(input.cursorId
        ? { cursor: { id: normalizeLeadId(input.cursorId) }, skip: 1 }
        : {}),
      include: {
        customer: {
          select: { id: true, name: true, phone: true, email: true },
        },
      },
    });
  },

  /**
   * Update basic lead fields. Only provided keys are touched.
   *
   * Identity is bound at creation and deliberately NOT re-resolved here: silently
   * re-pointing a lead at a different `Customer` because someone corrected a
   * digit is a surprise the owner never asked for. Re-linking belongs to the
   * conversation-link work (W3), where it is an explicit action.
   */
  async updateLead(input: UpdateLeadInput, options?: TxOptions) {
    assertBusinessId(input.businessId);
    const leadId = normalizeLeadId(input.leadId);

    const data: Prisma.LeadUpdateInput = {};
    if (input.name !== undefined) data.customerName = normalizeLeadName(input.name);
    if (input.phone !== undefined) data.phone = normalizeLeadPhone(input.phone);
    if (input.email !== undefined) data.email = normalizeLeadEmail(input.email);
    if (input.intentSnapshot !== undefined) {
      data.intentSnapshot = normalizeLeadOptionalText(
        input.intentSnapshot,
        "intentSnapshot",
        LEAD_INTENT_MAX
      );
    }
    if (input.sourceChannel !== undefined) {
      data.sourceChannel = normalizeLeadOptionalText(
        input.sourceChannel,
        "sourceChannel",
        LEAD_SOURCE_MAX
      );
    }

    if (Object.keys(data).length === 0) {
      throw new ValidationError("No updatable fields provided");
    }
    data.lastActivityAt = new Date();

    const run = async (tx: Tx) => {
      if (typeof data.phone === "string") {
        const clash = await findOpenLeadByPhone(
          tx,
          input.businessId,
          data.phone,
          leadId
        );
        if (clash) throw openLeadConflict(clash.id);
      }

      try {
        const updated = await tx.lead.updateMany({
          where: { id: leadId, businessId: input.businessId },
          data,
        });
        if (updated.count !== 1) throw new NotFoundError("Lead not found");
      } catch (error) {
        if (isOpenPhoneCollision(error)) throw openLeadConflict(null);
        throw error;
      }

      await logAuditEvent(
        {
          businessId: input.businessId,
          eventType: LEAD_EVENTS.UPDATED,
          entityType: LEAD_ENTITY_TYPE,
          entityId: leadId,
          payload: { fields: Object.keys(data).filter((k) => k !== "lastActivityAt") },
        },
        { tx }
      );

      return tx.lead.findFirstOrThrow({
        where: { id: leadId, businessId: input.businessId },
      });
    };

    if (options?.tx) return run(options.tx);
    throw new ValidationError(
      "updateLead must run inside a tenant transaction (pass options.tx)"
    );
  },

  /**
   * Move a lead to another status.
   *
   * A separate contract from `updateLead` on purpose — the same split Customer
   * already makes between lifecycle and basics, so each write path stays atomic
   * and independently auditable.
   *
   * `closedAt` is stamped on the way into a terminal status and cleared on the
   * way out, so no lead can ever be simultaneously open and closed. Repeating a
   * status is a no-op: it returns the lead unchanged and emits NO event, which
   * keeps a double-tap from polluting the history.
   */
  async updateLeadStatus(input: UpdateLeadStatusInput, options?: TxOptions) {
    assertBusinessId(input.businessId);
    const leadId = normalizeLeadId(input.leadId);
    const nextStatus = parseLeadStatus(input.status);
    const lostReason = normalizeLeadOptionalText(
      input.lostReason,
      "lostReason",
      LEAD_LOST_REASON_MAX
    );

    const run = async (tx: Tx) => {
      const current = await tx.lead.findFirst({
        where: { id: leadId, businessId: input.businessId },
        select: { id: true, status: true, phone: true },
      });
      if (!current) throw new NotFoundError("Lead not found");

      const transition = classifyLeadStatusTransition(
        current.status as LeadStatusValue,
        nextStatus
      );
      if (transition.noop) {
        return tx.lead.findFirstOrThrow({
          where: { id: leadId, businessId: input.businessId },
        });
      }

      // Reopening can collide with the open-lead-per-phone rule if another lead
      // took that phone while this one was closed. Check before writing so the
      // owner gets a clear 409 instead of a raw constraint error.
      if (transition.reopening && current.phone) {
        const clash = await findOpenLeadByPhone(
          tx,
          input.businessId,
          current.phone,
          leadId
        );
        if (clash) throw openLeadConflict(clash.id);
      }

      const now = new Date();
      const data: Prisma.LeadUpdateInput = {
        status: nextStatus,
        lastActivityAt: now,
      };
      if (transition.closing) {
        data.closedAt = now;
        // A closed lead needs no chasing — drop the open follow-up so it can
        // never surface as "overdue" after the deal is already decided.
        data.nextFollowUpAt = null;
      }
      if (transition.reopening) {
        data.closedAt = null;
      }
      if (nextStatus === "LOST") {
        data.lostReason = lostReason;
      } else if (isClosedLeadStatus(nextStatus)) {
        data.lostReason = null;
      }

      try {
        const updated = await tx.lead.updateMany({
          where: { id: leadId, businessId: input.businessId },
          data,
        });
        if (updated.count !== 1) throw new NotFoundError("Lead not found");
      } catch (error) {
        if (isOpenPhoneCollision(error)) throw openLeadConflict(null);
        throw error;
      }

      await logAuditEvent(
        {
          businessId: input.businessId,
          eventType: LEAD_EVENTS.STATUS_CHANGED,
          entityType: LEAD_ENTITY_TYPE,
          entityId: leadId,
          payload: { from: current.status, to: nextStatus },
        },
        { tx }
      );

      if (nextStatus === "WON" || nextStatus === "LOST") {
        await logAuditEvent(
          {
            businessId: input.businessId,
            eventType:
              nextStatus === "WON" ? LEAD_EVENTS.WON : LEAD_EVENTS.LOST,
            entityType: LEAD_ENTITY_TYPE,
            entityId: leadId,
            payload: { from: current.status, lostReason: lostReason ?? null },
          },
          { tx }
        );
      }

      return tx.lead.findFirstOrThrow({
        where: { id: leadId, businessId: input.businessId },
      });
    };

    if (options?.tx) return run(options.tx);
    throw new ValidationError(
      "updateLeadStatus must run inside a tenant transaction (pass options.tx)"
    );
  },

  /**
   * Set or reschedule THE follow-up. There is at most one open follow-up per
   * lead — rescheduling overwrites the timestamp rather than queueing a second
   * one, which is why a duplicate reminder is structurally impossible.
   */
  async setFollowUp(input: SetLeadFollowUpInput, options?: TxOptions) {
    assertBusinessId(input.businessId);
    const leadId = normalizeLeadId(input.leadId);
    const now = new Date();
    const followUpAt = parseFollowUpAt(input.followUpAt, now);
    const note = normalizeLeadOptionalText(
      input.note,
      "note",
      LEAD_FOLLOWUP_NOTE_MAX
    );

    const run = async (tx: Tx) => {
      const current = await tx.lead.findFirst({
        where: { id: leadId, businessId: input.businessId },
        select: { status: true, nextFollowUpAt: true },
      });
      if (!current) throw new NotFoundError("Lead not found");

      if (isClosedLeadStatus(current.status as LeadStatusValue)) {
        throw new ValidationError(
          "Cannot schedule a follow-up on a closed lead"
        );
      }

      const updated = await tx.lead.updateMany({
        where: { id: leadId, businessId: input.businessId },
        data: {
          nextFollowUpAt: followUpAt,
          followUpNote: note,
          lastActivityAt: now,
        },
      });
      if (updated.count !== 1) throw new NotFoundError("Lead not found");

      await logAuditEvent(
        {
          businessId: input.businessId,
          eventType: LEAD_EVENTS.FOLLOWUP_SET,
          entityType: LEAD_ENTITY_TYPE,
          entityId: leadId,
          payload: {
            followUpAt: followUpAt.toISOString(),
            rescheduled: current.nextFollowUpAt !== null,
          },
        },
        { tx }
      );

      // A reschedule is a distinct business act from setting the first
      // follow-up — the owner moved a promise they had already made — so it
      // gets its own event rather than a boolean buried in a payload.
      if (current.nextFollowUpAt !== null) {
        await logAuditEvent(
          {
            businessId: input.businessId,
            eventType: LEAD_EVENTS.FOLLOWUP_RESCHEDULED,
            entityType: LEAD_ENTITY_TYPE,
            entityId: leadId,
            payload: {
              from: current.nextFollowUpAt.toISOString(),
              to: followUpAt.toISOString(),
            },
          },
          { tx }
        );
      }

      return tx.lead.findFirstOrThrow({
        where: { id: leadId, businessId: input.businessId },
      });
    };

    if (options?.tx) return run(options.tx);
    throw new ValidationError(
      "setFollowUp must run inside a tenant transaction (pass options.tx)"
    );
  },

  /**
   * Mark the follow-up done. Clearing the timestamp IS completion — there is no
   * separate reminder row to close, so this cannot double-fire or leave a
   * dangling job behind.
   */
  async clearFollowUp(input: ClearLeadFollowUpInput, options?: TxOptions) {
    assertBusinessId(input.businessId);
    const leadId = normalizeLeadId(input.leadId);

    const run = async (tx: Tx) => {
      const current = await tx.lead.findFirst({
        where: { id: leadId, businessId: input.businessId },
        select: { nextFollowUpAt: true },
      });
      if (!current) throw new NotFoundError("Lead not found");

      const updated = await tx.lead.updateMany({
        where: { id: leadId, businessId: input.businessId },
        data: {
          nextFollowUpAt: null,
          followUpNote: null,
          lastActivityAt: new Date(),
        },
      });
      if (updated.count !== 1) throw new NotFoundError("Lead not found");

      // Only an actual follow-up can be completed; clearing an empty one is a
      // no-op and must not invent a completion in the history.
      if (current.nextFollowUpAt !== null) {
        await logAuditEvent(
          {
            businessId: input.businessId,
            eventType: LEAD_EVENTS.FOLLOWUP_COMPLETED,
            entityType: LEAD_ENTITY_TYPE,
            entityId: leadId,
            payload: { wasDueAt: current.nextFollowUpAt.toISOString() },
          },
          { tx }
        );
      }

      return tx.lead.findFirstOrThrow({
        where: { id: leadId, businessId: input.businessId },
      });
    };

    if (options?.tx) return run(options.tx);
    throw new ValidationError(
      "clearFollowUp must run inside a tenant transaction (pass options.tx)"
    );
  },

  /**
   * How many open leads want the owner right now.
   *
   * The SQL mirror of `evaluateLeadAttention`, kept next to `listLeads` so the
   * count and the list can never tell different stories. Home renders this;
   * clicking through lands on exactly these rows.
   */
  async countNeedingAttention(
    input: { businessId: number; now?: Date },
    options?: TxOptions
  ): Promise<number> {
    assertBusinessId(input.businessId);
    const now = input.now ?? new Date();
    const db = options?.tx ?? prisma;

    return db.lead.count({
      where: {
        businessId: input.businessId,
        status: { in: [...OPEN_LEAD_STATUSES] },
        OR: [
          { nextFollowUpAt: { lte: endOfLeadDayUtc(now) } },
          {
            status: "NEW",
            nextFollowUpAt: null,
            createdAt: { lt: startOfLeadDayUtc(now) },
          },
        ],
      },
    });
  },

  /**
   * Create a lead FROM a conversation, or return the one that already covers it.
   *
   * This is the action the audit found was only pasting text into the composer.
   * It is idempotent by construction, in three layers, because an owner will
   * absolutely tap it twice:
   *
   *   1. The conversation already points at a lead  -> return that lead.
   *   2. The conversation's customer already has an OPEN lead -> link to it.
   *   3. Otherwise create one, and link.
   *
   * CONTEXT, NOT COPIES: the conversation stays the source of truth for what was
   * said. The lead takes a relation plus ONE snapshot — the first thing the
   * customer asked — so the owner can tell what it is about without opening the
   * thread. No message history is duplicated into the lead.
   */
  async createFromConversation(
    input: {
      businessId: number;
      conversationId: number;
      /** Overrides the derived name when the owner typed one. */
      name?: string | null;
    },
    options?: TxOptions
  ) {
    assertBusinessId(input.businessId);
    const conversationId = normalizeLeadId(input.conversationId);

    const run = async (tx: Tx) => {
      // Tenant-scoped load. A conversation from another business behaves exactly
      // like one that does not exist.
      const conversation = await tx.conversation.findFirst({
        where: { id: conversationId, businessId: input.businessId },
        select: {
          id: true,
          leadId: true,
          customerId: true,
          channel: true,
          customer: { select: { id: true, name: true, phone: true, email: true } },
        },
      });
      if (!conversation) throw new NotFoundError("Conversation not found");

      // (1) Already linked — return what is there. No second lead, no event.
      if (conversation.leadId !== null) {
        const existing = await tx.lead.findFirst({
          where: { id: conversation.leadId, businessId: input.businessId },
        });
        if (existing) return { lead: existing, outcome: "already_linked" as const };
        // The link points at nothing reachable (deleted business data); fall
        // through and re-establish it rather than failing the owner's action.
      }

      // (2) The contact already has an open lead — attach to it instead of
      //     opening a competing one. This is also what the partial unique index
      //     would enforce a moment later, surfaced as a helpful outcome rather
      //     than a 409.
      let lead = null;
      if (conversation.customerId !== null) {
        lead = await tx.lead.findFirst({
          where: {
            businessId: input.businessId,
            customerId: conversation.customerId,
            status: { in: [...OPEN_LEAD_STATUSES] },
          },
          orderBy: [{ lastActivityAt: "desc" }, { id: "desc" }],
        });
      }

      let outcome: "already_linked" | "linked_existing" | "created" = "linked_existing";

      if (!lead) {
        // (3) Create. The first inbound customer message is the intent snapshot.
        const firstInbound = await tx.message.findFirst({
          where: {
            conversationId,
            businessId: input.businessId,
            direction: "INBOUND",
            senderType: "CUSTOMER",
          },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          select: { contentText: true },
        });

        const derivedName =
          normalizeLeadOptionalText(input.name, "name", LEAD_NAME_MAX) ??
          conversation.customer?.name?.trim() ??
          null;
        if (!derivedName) {
          throw new ValidationError(
            "Cannot derive a name for the lead — pass one explicitly"
          );
        }

        const now = new Date();
        try {
          lead = await tx.lead.create({
            data: {
              businessId: input.businessId,
              customerId: conversation.customerId,
              customerName: derivedName,
              phone: conversation.customer?.phone ?? null,
              email: conversation.customer?.email ?? null,
              // Channel-derived, reusing the existing ConversationChannel
              // vocabulary rather than inventing a source taxonomy.
              sourceChannel: conversation.channel,
              intentSnapshot: normalizeLeadOptionalText(
                firstInbound?.contentText ?? null,
                "intentSnapshot",
                LEAD_INTENT_MAX
              ),
              status: "NEW",
              lastActivityAt: now,
            },
          });
        } catch (error) {
          if (isOpenPhoneCollision(error)) {
            // Another open lead grabbed this phone between the check and the
            // insert. Adopt it — the owner asked for "a lead for this thread",
            // and there already is one.
            const raced = conversation.customer?.phone
              ? await findOpenLeadByPhone(tx, input.businessId, conversation.customer.phone)
              : null;
            if (!raced) throw openLeadConflict(null);
            lead = await tx.lead.findFirstOrThrow({
              where: { id: raced.id, businessId: input.businessId },
            });
          } else {
            throw error;
          }
        }
        // The `already_linked` branch returned earlier, so reaching here always
        // means this call is the one that created the lead.
        outcome = "created";
      }

      // Link the conversation — tenant-guarded, and only when it is not already
      // pointing somewhere, so re-running never rewrites an existing link.
      const linked = await tx.conversation.updateMany({
        where: { id: conversationId, businessId: input.businessId, leadId: null },
        data: { leadId: lead.id },
      });

      if (outcome === "created") {
        await logAuditEvent(
          {
            businessId: input.businessId,
            eventType: LEAD_EVENTS.CREATED_FROM_CONVERSATION,
            entityType: LEAD_ENTITY_TYPE,
            entityId: lead.id,
            payload: { conversationId, channel: conversation.channel },
          },
          { tx }
        );
      }
      if (linked.count === 1) {
        await logAuditEvent(
          {
            businessId: input.businessId,
            eventType: LEAD_EVENTS.CONVERSATION_LINKED,
            entityType: LEAD_ENTITY_TYPE,
            entityId: lead.id,
            payload: { conversationId, outcome },
          },
          { tx }
        );
      }

      return { lead, outcome };
    };

    if (options?.tx) return run(options.tx);
    throw new ValidationError(
      "createFromConversation must run inside a tenant transaction (pass options.tx)"
    );
  },
};
