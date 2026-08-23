/**
 * Collection · wire shape for the awaiting-payment list.
 *
 * `Prisma.Decimal` does not survive JSON, and money that silently becomes a
 * float is money that is silently wrong. Amounts cross the wire as exact
 * strings, already formatted for display, and the screen never does arithmetic
 * on them.
 *
 * `daysAwaiting` is deliberately NOT serialized. It exists for ordering only;
 * the owner is shown a date, never a countdown (Constitution, Article 8).
 */

import { formatAmount, formatHebrewDate } from "./collection-message";
import type { AwaitingPaymentList } from "./awaiting-payment.rules";

export interface AwaitingInvoiceApi {
  readonly id: number;
  readonly documentNumber: string | null;
  /** Exact decimal string, e.g. "3400.00" — the value, for message building. */
  readonly outstanding: string;
  /** Display form, e.g. "3,400". */
  readonly outstandingFormatted: string;
  readonly currency: string;
  readonly issuedAt: string;
  readonly issuedAtFormatted: string;
  readonly isPartiallySettled: boolean;
}

export interface AwaitingCustomerApi {
  readonly customerId: number;
  readonly customerName: string;
  readonly customerPhone: string | null;
  readonly customerEmail: string | null;
  readonly totalOutstanding: string;
  readonly totalOutstandingFormatted: string;
  readonly currency: string;
  readonly awaitingSince: string;
  readonly awaitingSinceFormatted: string;
  readonly hasNoContactChannel: boolean;
  readonly invoices: readonly AwaitingInvoiceApi[];
}

export interface AwaitingPaymentListApi {
  readonly customers: readonly AwaitingCustomerApi[];
  readonly totalOutstanding: string;
  readonly totalOutstandingFormatted: string;
  readonly customerCount: number;
  readonly unassignedCount: number;
}

export function serializeAwaitingPaymentList(
  list: AwaitingPaymentList,
): AwaitingPaymentListApi {
  return {
    customers: list.customers.map((customer) => ({
      customerId: customer.customerId,
      customerName: customer.customerName,
      customerPhone: customer.customerPhone,
      customerEmail: customer.customerEmail,
      totalOutstanding: customer.totalOutstanding.toFixed(2),
      totalOutstandingFormatted: formatAmount(customer.totalOutstanding.toFixed(2)),
      currency: customer.currency,
      awaitingSince: customer.awaitingSince.toISOString(),
      awaitingSinceFormatted: formatHebrewDate(customer.awaitingSince),
      hasNoContactChannel: customer.hasNoContactChannel,
      invoices: customer.invoices.map((invoice) => ({
        id: invoice.id,
        documentNumber: invoice.documentNumber,
        outstanding: invoice.outstanding.toFixed(2),
        outstandingFormatted: formatAmount(invoice.outstanding.toFixed(2)),
        currency: invoice.currency,
        issuedAt: invoice.issuedAt.toISOString(),
        issuedAtFormatted: formatHebrewDate(invoice.issuedAt),
        isPartiallySettled: invoice.isPartiallySettled,
      })),
    })),
    totalOutstanding: list.totalOutstanding.toFixed(2),
    totalOutstandingFormatted: formatAmount(list.totalOutstanding.toFixed(2)),
    customerCount: list.customerCount,
    unassignedCount: list.unassignedCount,
  };
}
