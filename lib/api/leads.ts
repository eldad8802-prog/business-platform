import { buildClientAuthHeaders } from "@/lib/client-session";
import type {
  LeadFollowUpState,
  LeadStatusValue,
} from "@/lib/services/crm/lead-core";

export type { LeadFollowUpState, LeadStatusValue };

export type LeadListRow = {
  id: number;
  name: string | null;
  phone: string | null;
  email: string | null;
  status: LeadStatusValue;
  sourceChannel: string | null;
  followUpNote: string | null;
  lastActivityAt: string | null;
  createdAt: string;
  followUp: LeadFollowUpState;
  needsAttention: boolean;
  customer: { id: number; name: string } | null;
};

export type LeadCardDTO = {
  lead: {
    id: number;
    name: string | null;
    phone: string | null;
    email: string | null;
    status: LeadStatusValue;
    sourceChannel: string | null;
    intentSnapshot: string | null;
    followUpNote: string | null;
    nextFollowUpAt: string | null;
    lastActivityAt: string | null;
    closedAt: string | null;
    lostReason: string | null;
    createdAt: string;
    updatedAt: string;
  };
  followUp: LeadFollowUpState;
  needsAttention: boolean;
  customer: {
    id: number;
    name: string;
    phone: string | null;
    email: string | null;
    city: string | null;
    isActive: boolean;
  } | null;
  conversations: {
    items: Array<{
      id: number;
      channel: string;
      status: string;
      startedAt: string;
      lastMessageAt: string | null;
    }>;
    total: number;
  };
};

/**
 * Broadcast that a lead changed, so the master list can re-read.
 *
 * On desktop the Leads Inbox and the lead card are on screen TOGETHER, and the
 * list deliberately does not re-fetch on selection (that is what keeps it from
 * remounting on every navigation). Without this signal, completing a follow-up
 * in the card would leave the row beside it still showing "מעקב באיחור" — two
 * panes disagreeing about the same lead.
 *
 * A window event rather than shared state or a router refresh: the list is
 * client-fetched, so `router.refresh()` would not touch it, and the two
 * components have no common owner short of lifting the whole list into context.
 */
export const LEAD_CHANGED_EVENT = "dubiz:lead-changed";

export function announceLeadChanged(leadId: number): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(LEAD_CHANGED_EVENT, { detail: { leadId } }));
}

export type CreateLeadInput = {
  name: string;
  phone?: string | null;
  email?: string | null;
  intentSnapshot?: string | null;
  sourceChannel?: string | null;
};

export type LeadStatusFilter = "open" | "closed" | "all" | LeadStatusValue;

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init?: RequestInit,
  timeoutMs = 15000
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new Error("הבקשה ארכה זמן רב מדי. בדקו את החיבור ונסו שוב.");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function parseError(res: Response, fallback: string): Promise<never> {
  if (res.status === 401) throw new Error("UNAUTHORIZED");
  let message = fallback;
  try {
    const data = await res.json();
    if (data?.error) message = data.error;
  } catch {
    /* keep fallback */
  }
  throw new Error(message);
}

export async function getLeads(params?: {
  query?: string;
  status?: LeadStatusFilter;
  needsAction?: boolean;
}): Promise<LeadListRow[]> {
  const qs = new URLSearchParams();
  if (params?.query?.trim()) qs.set("q", params.query.trim());
  if (params?.status) qs.set("status", params.status);
  if (params?.needsAction) qs.set("needsAction", "true");
  const suffix = qs.toString() ? `?${qs.toString()}` : "";

  const res = await fetchWithTimeout(`/api/leads${suffix}`, {
    headers: buildClientAuthHeaders(),
    cache: "no-store",
  });
  if (!res.ok) await parseError(res, "לא הצלחנו לטעון את רשימת הלידים");
  const data = await res.json();
  return Array.isArray(data?.leads) ? data.leads : [];
}

export async function createLead(input: CreateLeadInput): Promise<LeadListRow> {
  const res = await fetchWithTimeout("/api/leads", {
    method: "POST",
    headers: buildClientAuthHeaders(),
    body: JSON.stringify(input),
  });
  if (!res.ok) await parseError(res, "לא הצלחנו ליצור ליד");
  const data = await res.json();
  return data.lead as LeadListRow;
}

export async function getLeadCard(leadId: number): Promise<LeadCardDTO> {
  const res = await fetchWithTimeout(`/api/leads/${leadId}`, {
    headers: buildClientAuthHeaders(),
    cache: "no-store",
  });
  if (!res.ok) await parseError(res, "לא הצלחנו לטעון את הליד");
  return (await res.json()) as LeadCardDTO;
}

/** Every mutation returns the full card, so callers never re-fetch to refresh. */
async function patchLead(
  leadId: number,
  body: Record<string, unknown>,
  fallback: string
): Promise<LeadCardDTO> {
  const res = await fetchWithTimeout(`/api/leads/${leadId}`, {
    method: "PATCH",
    headers: buildClientAuthHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) await parseError(res, fallback);
  const card = (await res.json()) as LeadCardDTO;
  announceLeadChanged(leadId);
  return card;
}

export function updateLeadStatus(
  leadId: number,
  status: LeadStatusValue,
  lostReason?: string | null
): Promise<LeadCardDTO> {
  return patchLead(
    leadId,
    { status, ...(lostReason ? { lostReason } : {}) },
    "לא הצלחנו לעדכן את הסטטוס"
  );
}

export function setLeadFollowUp(
  leadId: number,
  followUpAt: string,
  followUpNote?: string | null
): Promise<LeadCardDTO> {
  return patchLead(
    leadId,
    { followUpAt, followUpNote: followUpNote ?? null },
    "לא הצלחנו לקבוע מעקב"
  );
}

/** Completion IS clearing the date — there is no separate reminder record. */
export function clearLeadFollowUp(leadId: number): Promise<LeadCardDTO> {
  return patchLead(leadId, { followUpAt: null }, "לא הצלחנו לסגור את המעקב");
}

export function updateLeadBasics(
  leadId: number,
  fields: Partial<Pick<CreateLeadInput, "name" | "phone" | "email" | "intentSnapshot">>
): Promise<LeadCardDTO> {
  return patchLead(leadId, fields, "לא הצלחנו לעדכן את הליד");
}
