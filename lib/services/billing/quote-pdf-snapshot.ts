import type {
  BillingDocument,
  BillingDocumentLine,
  BillingDocumentStatus,
} from "@prisma/client";
import { BillingDocumentType, Prisma } from "@prisma/client";
import type { BillingIssuedSnapshotV1 } from "@/lib/services/billing/pdf/billing-pdf-template";
import { parseBillingPdfTemplateStyle } from "@/lib/billing/billing-pdf-template-style";

type BusinessProfileForQuote = {
  billingLegalName: string | null;
  billingTaxId: string | null;
  billingVatNumber: string | null;
  billingPhone: string | null;
  billingEmail: string | null;
  billingAddress: string | null;
  billingPaymentNote: string | null;
  billingFooterNote: string | null;
  billingLogoDataUrl: string | null;
  billingPdfTemplateStyle?: string | null;
} | null;

const SNAPSHOT_SCHEMA_VERSION = 1;
const DEFAULT_LOCALE = "he-IL";
const DEFAULT_TIMEZONE = "Asia/Jerusalem";
const DEFAULT_VAT_MODE = "EXCLUSIVE";
const DEFAULT_SOURCE = "quote";

function isValidBillingLogoDataUrl(value: string | null | undefined): boolean {
  if (!value || typeof value !== "string") return false;
  const t = value.trim();
  if (t.length > 500_000) return false;
  return /^data:image\/(png|jpe?g|webp);base64,[a-z0-9+/=\s]+$/i.test(t);
}

function formatMoneyDec(value: Prisma.Decimal): string {
  return value.toFixed(2);
}

function formatQuantityLike(value: Prisma.Decimal): string {
  return value.toFixed(4);
}

function formatPercent(value: Prisma.Decimal): string {
  return value.toFixed(2);
}

export function buildQuotePdfSnapshot(args: {
  document: BillingDocument;
  lines: BillingDocumentLine[];
  business: { id: number; name: string; profile: BusinessProfileForQuote };
  customer: {
    id: number;
    name: string;
    phone: string | null;
    email: string | null;
    city: string | null;
  } | null;
  documentNumber: number;
  documentNumberFormatted: string;
  snapshotDate: Date;
  actorUserId: number;
  totals: {
    subtotalAmount: Prisma.Decimal;
    vatAmount: Prisma.Decimal;
    totalAmount: Prisma.Decimal;
  };
}): BillingIssuedSnapshotV1 {
  const {
    document,
    lines,
    business,
    customer,
    documentNumber,
    documentNumberFormatted,
    snapshotDate,
    actorUserId,
    totals,
  } = args;

  if (document.documentType !== BillingDocumentType.QUOTE) {
    throw new Error("buildQuotePdfSnapshot expects documentType QUOTE");
  }

  const profile = business.profile;
  const displayName = (profile?.billingLegalName ?? "").trim() || business.name;
  const taxId = (profile?.billingTaxId ?? "").trim() || null;
  const vatReg = (profile?.billingVatNumber ?? "").trim() || null;
  const phone = (profile?.billingPhone ?? "").trim() || null;
  const email = (profile?.billingEmail ?? "").trim() || null;
  const addressRaw = (profile?.billingAddress ?? "").trim() || null;
  const paymentNote = (profile?.billingPaymentNote ?? "").trim() || null;
  const footerNote = (profile?.billingFooterNote ?? "").trim() || null;
  const logoUrl =
    profile && isValidBillingLogoDataUrl(profile.billingLogoDataUrl)
      ? profile.billingLogoDataUrl!.trim()
      : null;

  const pdfTemplateStyle = parseBillingPdfTemplateStyle(
    profile?.billingPdfTemplateStyle
  );

  const customerNameSnapshot = (document.customerNameSnapshot ?? "").trim();

  const customerSnapshot = {
    id: customer?.id ?? null,
    name: customerNameSnapshot,
    legalName: null,
    taxId: null,
    phone: customer?.phone ?? null,
    email: customer?.email ?? null,
    city: customer?.city ?? null,
    address: null,
  };

  const issuerSnapshot = {
    id: business.id,
    name: displayName,
    legalName: (profile?.billingLegalName ?? "").trim() || null,
    taxId,
    vatRegistration: vatReg,
    address: addressRaw,
    phone,
    email,
    logoUrl,
    bankDetails: paymentNote,
  };

  const lineSnapshots = lines.map((line) => ({
    lineIndex: line.lineIndex,
    description: line.description,
    quantity: formatQuantityLike(line.quantity),
    unitPrice: formatQuantityLike(line.unitPrice),
    vatRatePercent: formatPercent(line.vatRatePercent),
    lineSubtotal: formatMoneyDec(line.lineSubtotal),
    vatAmount: formatMoneyDec(line.vatAmount),
    lineTotal: formatMoneyDec(line.lineTotal),
  }));

  const validUntilIso =
    document.validUntil != null ? document.validUntil.toISOString() : null;

  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    issuedAt: snapshotDate.toISOString(),
    document: {
      id: document.id,
      type: BillingDocumentType.QUOTE,
      status: document.status as BillingDocumentStatus,
      number: documentNumber,
      numberFormatted: documentNumberFormatted,
      currency: document.currency,
      allocationNumber: null,
      referenceDocumentId: null,
    },
    issuer: issuerSnapshot,
    customer: customerSnapshot,
    lines: lineSnapshots,
    totals: {
      subtotal: formatMoneyDec(totals.subtotalAmount),
      vat: formatMoneyDec(totals.vatAmount),
      total: formatMoneyDec(totals.totalAmount),
    },
    tax: {
      currency: document.currency,
      defaultVatRate: null,
      vatMode: DEFAULT_VAT_MODE,
    },
    metadata: {
      locale: DEFAULT_LOCALE,
      timezone: DEFAULT_TIMEZONE,
      actorUserId,
      source: DEFAULT_SOURCE,
    },
    pdfTemplateStyle,
    extensions: {
      billingFooterNote: footerNote,
      quoteValidUntil: validUntilIso,
    },
  };
}
