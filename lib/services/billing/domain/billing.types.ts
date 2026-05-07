import { Prisma, BillingDocumentStatus } from "@prisma/client";

export type Decimal = Prisma.Decimal;

export type BillingLineInputRaw = {
  description: unknown;
  quantity: unknown;
  unitPrice: unknown;
  vatRatePercent: unknown;
  lineIndex?: unknown;
};

export type BillingLineParsed = {
  description: string;
  quantity: Decimal;
  unitPrice: Decimal;
  vatRatePercent: Decimal;
  lineIndex: number;
};

export type BillingLineComputed = BillingLineParsed & {
  lineSubtotal: Decimal;
  vatAmount: Decimal;
  lineTotal: Decimal;
};

export type BillingHeaderTotals = {
  subtotalAmount: Decimal;
  vatAmount: Decimal;
  totalAmount: Decimal;
};

export type BillingDraftHeaderInputRaw = {
  customerId?: unknown;
  customerNameSnapshot?: unknown;
};

export type BillingDraftHeaderInputParsed = {
  customerId: number | null;
  customerNameSnapshot: string | null;
};

export { BillingDocumentStatus };
