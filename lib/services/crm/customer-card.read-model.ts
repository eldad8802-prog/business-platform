/**
 * Customer Card read-model — a single, tenant-scoped aggregation of the REAL
 * relations a customer already has. It invents nothing: every field maps to an
 * existing row. No financial rollups, no aging, no fabricated status — those are
 * later engines. All queries are double-scoped by `businessId` AND `customerId`.
 *
 * Decimals are serialized to strings and Dates to ISO so the DTO is stable and
 * directly testable.
 */

import { prisma } from "@/lib/prisma";
import { NotFoundError, UnauthorizedError, ValidationError } from "@/lib/errors";

const RELATION_TAKE = 20;

export type CustomerCardCustomer = {
  id: number;
  name: string;
  phone: string | null;
  email: string | null;
  city: string | null;
  legalName: string | null;
  taxId: string | null;
  taxIdType: string | null;
  notes: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

export type CustomerCardBillingDocument = {
  id: number;
  documentType: string;
  status: string;
  documentNumberFormatted: string | null;
  totalAmount: string;
  currency: string;
  issuedAt: string | null;
  createdAt: string;
};

export type CustomerCardPaymentRequest = {
  id: number;
  provider: string;
  status: string;
  amount: string;
  currency: string;
  paymentUrl: string | null;
  billingDocumentId: number | null;
  createdAt: string;
  paidAt: string | null;
};

export type CustomerCardConversation = {
  id: number;
  channel: string;
  status: string;
  startedAt: string;
  lastMessageAt: string | null;
  closedAt: string | null;
};

export type CustomerCardAppointment = {
  id: number;
  status: string;
  title: string | null;
  startsAt: string | null;
  createdAt: string;
};

export type CustomerCardSection<T> = {
  items: T[];
  total: number;
};

export type CustomerCard = {
  customer: CustomerCardCustomer;
  billingDocuments: CustomerCardSection<CustomerCardBillingDocument>;
  paymentRequests: CustomerCardSection<CustomerCardPaymentRequest>;
  conversations: CustomerCardSection<CustomerCardConversation>;
  appointments: CustomerCardSection<CustomerCardAppointment>;
  activity: {
    lastActivityAt: string | null;
    hasAnyActivity: boolean;
  };
};

export type GetCustomerCardInput = {
  businessId: number;
  customerId: number;
};

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function maxDate(dates: Array<Date | null | undefined>): Date | null {
  let max: Date | null = null;
  for (const d of dates) {
    if (d && (!max || d.getTime() > max.getTime())) max = d;
  }
  return max;
}

export async function getCustomerCard(
  input: GetCustomerCardInput
): Promise<CustomerCard> {
  if (!input.businessId || Number.isNaN(input.businessId)) {
    throw new UnauthorizedError("Invalid business id");
  }
  const customerId = Number(input.customerId);
  if (!Number.isInteger(customerId) || customerId <= 0) {
    throw new ValidationError("Invalid customer id");
  }
  const businessId = input.businessId;
  const scope = { businessId, customerId };

  const customer = await prisma.customer.findFirst({
    where: { id: customerId, businessId },
  });
  if (!customer) {
    throw new NotFoundError("Customer not found");
  }

  const [
    billingDocuments,
    billingDocumentsTotal,
    paymentRequests,
    paymentRequestsTotal,
    conversations,
    conversationsTotal,
    appointments,
    appointmentsTotal,
  ] = await Promise.all([
    prisma.billingDocument.findMany({
      where: scope,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: RELATION_TAKE,
      select: {
        id: true,
        documentType: true,
        status: true,
        documentNumberFormatted: true,
        totalAmount: true,
        currency: true,
        issuedAt: true,
        createdAt: true,
      },
    }),
    prisma.billingDocument.count({ where: scope }),
    prisma.paymentRequest.findMany({
      where: scope,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: RELATION_TAKE,
      select: {
        id: true,
        provider: true,
        status: true,
        amount: true,
        currency: true,
        paymentUrl: true,
        billingDocumentId: true,
        createdAt: true,
        paidAt: true,
      },
    }),
    prisma.paymentRequest.count({ where: scope }),
    prisma.conversation.findMany({
      where: scope,
      orderBy: [{ lastMessageAt: "desc" }, { startedAt: "desc" }, { id: "desc" }],
      take: RELATION_TAKE,
      select: {
        id: true,
        channel: true,
        status: true,
        startedAt: true,
        lastMessageAt: true,
        closedAt: true,
      },
    }),
    prisma.conversation.count({ where: scope }),
    prisma.appointment.findMany({
      where: scope,
      orderBy: [{ startsAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
      take: RELATION_TAKE,
      select: {
        id: true,
        status: true,
        title: true,
        startsAt: true,
        createdAt: true,
      },
    }),
    prisma.appointment.count({ where: scope }),
  ]);

  const lastActivity = maxDate([
    billingDocuments[0]?.issuedAt ?? billingDocuments[0]?.createdAt ?? null,
    paymentRequests[0]?.createdAt ?? null,
    conversations[0]?.lastMessageAt ?? conversations[0]?.startedAt ?? null,
    // Appointments are ordered by startsAt (future-first) for display, but
    // "last activity" must reflect an event that already happened — so an
    // appointment contributes its createdAt (when it was scheduled), never its
    // future startsAt. startsAt stays the source of truth for the section date.
    ...appointments.map((a) => a.createdAt),
  ]);

  const hasAnyActivity =
    billingDocumentsTotal +
      paymentRequestsTotal +
      conversationsTotal +
      appointmentsTotal >
    0;

  return {
    customer: {
      id: customer.id,
      name: customer.name,
      phone: customer.phone,
      email: customer.email,
      city: customer.city,
      legalName: customer.legalName,
      taxId: customer.taxId,
      taxIdType: customer.taxIdType,
      notes: customer.notes,
      isActive: customer.isActive,
      createdAt: customer.createdAt.toISOString(),
      updatedAt: customer.updatedAt.toISOString(),
    },
    billingDocuments: {
      total: billingDocumentsTotal,
      items: billingDocuments.map((d) => ({
        id: d.id,
        documentType: d.documentType,
        status: d.status,
        documentNumberFormatted: d.documentNumberFormatted,
        totalAmount: d.totalAmount.toString(),
        currency: d.currency,
        issuedAt: iso(d.issuedAt),
        createdAt: d.createdAt.toISOString(),
      })),
    },
    paymentRequests: {
      total: paymentRequestsTotal,
      items: paymentRequests.map((p) => ({
        id: p.id,
        provider: p.provider,
        status: p.status,
        amount: p.amount.toString(),
        currency: p.currency,
        paymentUrl: p.paymentUrl,
        billingDocumentId: p.billingDocumentId,
        createdAt: p.createdAt.toISOString(),
        paidAt: iso(p.paidAt),
      })),
    },
    conversations: {
      total: conversationsTotal,
      items: conversations.map((c) => ({
        id: c.id,
        channel: c.channel,
        status: c.status,
        startedAt: c.startedAt.toISOString(),
        lastMessageAt: iso(c.lastMessageAt),
        closedAt: iso(c.closedAt),
      })),
    },
    appointments: {
      total: appointmentsTotal,
      items: appointments.map((a) => ({
        id: a.id,
        status: a.status,
        title: a.title,
        startsAt: iso(a.startsAt),
        createdAt: a.createdAt.toISOString(),
      })),
    },
    activity: {
      lastActivityAt: iso(lastActivity),
      hasAnyActivity,
    },
  };
}
