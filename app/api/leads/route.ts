import { NextRequest, NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { handleError } from "@/lib/handle-error";

/** Mirrors the service's own default page size. */
const DEFAULT_PAGE_SIZE = 50;
import { evaluateLeadAttention } from "@/lib/services/crm/lead-attention";
import {
  evaluateLeadPriority,
  type LeadConversationIntelligence,
} from "@/lib/services/crm/lead-intelligence";
import { ValidationError } from "@/lib/errors";
import { leadService, type LeadStatusFilter } from "@/lib/services/crm/lead.service";
import {
  LEAD_STATUSES,
  evaluateLeadFollowUp,
  leadNeedsAttention,
  type LeadStatusValue,
} from "@/lib/services/crm/lead-core";
import { runWithTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction } from "@/lib/tenant/transaction";

/** Convenience groups plus every real status. */
const STATUS_FILTERS: readonly string[] = [
  "open",
  "closed",
  "all",
  ...LEAD_STATUSES,
];

function parseStatusFilter(raw: string | null): LeadStatusFilter | undefined {
  if (raw === null || raw === "") return undefined;
  if (!STATUS_FILTERS.includes(raw)) {
    throw new ValidationError(`status must be one of: ${STATUS_FILTERS.join(", ")}`);
  }
  return raw as LeadStatusFilter;
}

function parseIntParam(raw: string | null, field: string): number | undefined {
  if (raw === null || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new ValidationError(`${field} must be a positive integer`);
  }
  return n;
}

type LeadRowSource = {
  id: number;
  customerName: string | null;
  phone: string | null;
  email: string | null;
  status: string;
  sourceChannel: string | null;
  nextFollowUpAt: Date | null;
  followUpNote: string | null;
  lastActivityAt: Date | null;
  createdAt: Date;
  customer: { id: number; name: string; phone: string | null; email: string | null } | null;
};

/**
 * Row shape for the Leads Inbox — a DTO, never a raw Prisma object. The
 * follow-up state and `needsAttention` are DERIVED here at read time; neither is
 * stored, so the list can never show a stale "overdue" badge.
 */
function toListRow(
  lead: LeadRowSource,
  now: Date,
  intelligence: LeadConversationIntelligence | null
) {
  const status = lead.status as LeadStatusValue;
  const attention = evaluateLeadAttention(
    { status, nextFollowUpAt: lead.nextFollowUpAt, createdAt: lead.createdAt },
    now
  );
  return {
    id: lead.id,
    name: lead.customerName,
    phone: lead.phone,
    email: lead.email,
    status,
    sourceChannel: lead.sourceChannel,
    followUpNote: lead.followUpNote,
    lastActivityAt: lead.lastActivityAt ? lead.lastActivityAt.toISOString() : null,
    createdAt: lead.createdAt.toISOString(),
    followUp: evaluateLeadFollowUp(lead.nextFollowUpAt, now),
    needsAttention: leadNeedsAttention(
      { status, nextFollowUpAt: lead.nextFollowUpAt },
      now
    ),
    customer: lead.customer
      ? { id: lead.customer.id, name: lead.customer.name }
      : null,
    // W3 — what the conversation says, and why the lead sits where it does.
    intelligence,
    priority: evaluateLeadPriority({ status, attention, intelligence }),
  };
}

/**
 * Leads Inbox list / search.
 * GET ?q= &status= &source= &needsAction=true &limit= &cursorId=
 *
 * Defaults to OPEN leads: the inbox is a work queue, not an archive.
 */
export async function GET(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);
    if (!user) return authRequiredResponse(req);

    const { searchParams } = new URL(req.url);
    const now = new Date();

    // ONE tenant transaction for the page and its intelligence, so the rows and
    // the conversation readings describe the same instant.
    const { leads, intelligence, overflow } = await runWithTenantContext(
      { businessId: user.businessId },
      () =>
        withTenantTransaction(async (tx) => {
          const statusFilter = parseStatusFilter(searchParams.get("status"));
          const rows = await leadService.listLeads(
            {
              businessId: user.businessId,
              query: searchParams.get("q"),
              status: statusFilter,
              sourceChannel: searchParams.get("source"),
              needsAction: searchParams.get("needsAction") === "true",
              limit: parseIntParam(searchParams.get("limit"), "limit"),
              cursorId: parseIntParam(searchParams.get("cursorId"), "cursorId"),
              now,
            },
            { tx }
          );

          // GLOBAL ORDERING (W3 closure).
          //
          // Ranking only the rows `take` happened to return cannot answer "who
          // needs me now": a waiting customer sitting 51st by `lastActivityAt`
          // is cut before anything ranks them, and since no client sends a
          // cursor there is no page 2 to find them on. So the ranked list is
          // built from the page PLUS every lead that could possibly outrank it
          // — a set defined by a single database predicate, with the proof in
          // `listUrgentCandidates`. Anything outside it scores exactly zero.
          const urgent = statusFilter === "closed"
            ? { rows: [], overflow: false }
            : await leadService.listUrgentCandidates(
                {
                  businessId: user.businessId,
                  query: searchParams.get("q"),
                  sourceChannel: searchParams.get("source"),
                  now,
                },
                { tx }
              );

          // Union by id, page first so its rows win on identity.
          const byId = new Map<number, (typeof rows)[number]>();
          for (const row of rows) byId.set(row.id, row);
          for (const row of urgent.rows) if (!byId.has(row.id)) byId.set(row.id, row);
          const merged = [...byId.values()];

          // ONE extra query for the whole set — never one per lead.
          const attached = await leadService.attachLeadIntelligence(
            {
              businessId: user.businessId,
              leadIds: merged.map((r) => r.id),
              now,
            },
            { tx }
          );

          return { leads: merged, intelligence: attached, overflow: urgent.overflow };
        })
    );

    const items = leads.map((l) =>
      toListRow(l, now, intelligence.get(l.id)?.intelligence ?? null)
    );

    // The one ordering contract, applied to the whole candidate set:
    //   priority DESC → last activity DESC → id DESC.
    // Total and deterministic: `id` is unique, so no two rows can tie all the
    // way down, and the same input always produces the same sequence.
    items.sort(
      (a, b) =>
        b.priority.score - a.priority.score ||
        new Date(b.lastActivityAt ?? b.createdAt).getTime() -
          new Date(a.lastActivityAt ?? a.createdAt).getTime() ||
        b.id - a.id
    );

    const limit = parseIntParam(searchParams.get("limit"), "limit") ?? DEFAULT_PAGE_SIZE;
    const page = items.slice(0, limit);

    return NextResponse.json(
      {
        leads: page,
        // Never a silent cap: above the candidate ceiling the ordering is a best
        // effort over the newest urgent leads, and the client is told so.
        ...(overflow ? { rankingTruncated: true } : {}),
      },
      { status: 200 }
    );
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Create a lead by hand.
 * Body: { name, phone?, email?, intentSnapshot?, sourceChannel? }
 *
 * The tenant is taken from the authenticated session and NEVER from the body —
 * a `businessId` sent by a client is ignored outright.
 */
export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);
    if (!user) return authRequiredResponse(req);

    let body: Record<string, unknown> = {};
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      body = {};
    }

    const now = new Date();
    const lead = await runWithTenantContext(
      { businessId: user.businessId },
      () =>
        withTenantTransaction((tx) =>
          leadService.createLead(
            {
              businessId: user.businessId,
              name: body.name as string,
              phone: (body.phone as string | null | undefined) ?? null,
              email: (body.email as string | null | undefined) ?? null,
              intentSnapshot:
                (body.intentSnapshot as string | null | undefined) ?? null,
              sourceChannel:
                (body.sourceChannel as string | null | undefined) ?? null,
            },
            { tx }
          )
        )
    );

    return NextResponse.json(
      // A lead created this instant has no conversation yet, so there is
      // nothing to read from one.
      { lead: toListRow({ ...lead, customer: null }, now, null) },
      { status: 201 }
    );
  } catch (error) {
    return handleError(error);
  }
}
