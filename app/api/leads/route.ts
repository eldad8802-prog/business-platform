import { NextRequest, NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { handleError } from "@/lib/handle-error";
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
function toListRow(lead: LeadRowSource, now: Date) {
  const status = lead.status as LeadStatusValue;
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

    const leads = await runWithTenantContext(
      { businessId: user.businessId },
      () =>
        withTenantTransaction((tx) =>
          leadService.listLeads(
            {
              businessId: user.businessId,
              query: searchParams.get("q"),
              status: parseStatusFilter(searchParams.get("status")),
              sourceChannel: searchParams.get("source"),
              needsAction: searchParams.get("needsAction") === "true",
              limit: parseIntParam(searchParams.get("limit"), "limit"),
              cursorId: parseIntParam(searchParams.get("cursorId"), "cursorId"),
              now,
            },
            { tx }
          )
        )
    );

    return NextResponse.json(
      { leads: leads.map((l) => toListRow(l, now)) },
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
      { lead: toListRow({ ...lead, customer: null }, now) },
      { status: 201 }
    );
  } catch (error) {
    return handleError(error);
  }
}
