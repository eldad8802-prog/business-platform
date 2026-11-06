/**
 * ר2 — render a letter (HTML for preview, PDF for download / share).
 *
 * Stateless: reads the business's own details and, when chosen, one customer or
 * supplier — always scoped by the session's businessId inside a tenant
 * transaction — and returns bytes. Nothing is written: no row, no file, no
 * number. A customer / supplier id of another business is "not found".
 */
import type { Prisma } from "@prisma/client";

import { NotFoundError } from "@/lib/errors";
import { hebrewFontVfs } from "@/lib/pdf/hebrew-font-vfs";
import { tenantTx } from "@/lib/tenant/tenant-tx";

import { buildLetterHtml, type LetterIssuer, type LetterRecipient } from "./letter-html";
import type { LetterInput } from "./letter.contracts";

const BUSINESS_KIND_LABEL: Record<string, string> = {
  EXEMPT_DEALER: "עוסק פטור",
  AUTHORIZED_DEALER: "עוסק מורשה",
  LTD_COMPANY: "ח.פ.",
};

export function fontDataUri(): string {
  return `data:font/ttf;base64,${hebrewFontVfs["NotoSansHebrew-Regular.ttf"]}`;
}

type Resolved = { issuer: LetterIssuer; recipient: LetterRecipient };

export async function resolveLetterPartiesTx(tx: Prisma.TransactionClient, businessId: number, input: LetterInput): Promise<Resolved> {
  const business = await tx.business.findFirst({
    where: { id: businessId },
    select: {
      name: true,
      profile: {
        select: {
          billingLegalName: true,
          billingBusinessKind: true,
          billingTaxId: true,
          billingAddress: true,
          billingPhone: true,
          billingEmail: true,
          billingLogoDataUrl: true,
          billingSignatureDataUrl: true,
        },
      },
    },
  });
  if (!business) throw new NotFoundError("Business not found");
  const p = business.profile;
  const issuer: LetterIssuer = {
    displayName: (p?.billingLegalName ?? "").trim() || business.name,
    businessKindLabel: p?.billingBusinessKind ? (BUSINESS_KIND_LABEL[p.billingBusinessKind] ?? null) : null,
    taxId: (p?.billingTaxId ?? "").trim() || null,
    address: (p?.billingAddress ?? "").trim() || null,
    phone: (p?.billingPhone ?? "").trim() || null,
    email: (p?.billingEmail ?? "").trim() || null,
    logoDataUrl: p?.billingLogoDataUrl ?? null,
    signatureDataUrl: p?.billingSignatureDataUrl ?? null,
  };

  let recipient: LetterRecipient = { name: input.recipientName, address: input.recipientAddress };
  if (input.recipientKind === "customer" && input.customerId) {
    const c = await tx.customer.findFirst({ where: { id: input.customerId, businessId }, select: { name: true, legalName: true, city: true } });
    if (!c) throw new NotFoundError("Customer not found");
    recipient = {
      name: input.recipientName || (c.legalName ?? "").trim() || c.name,
      address: input.recipientAddress || (c.city ?? "").trim(),
    };
  } else if (input.recipientKind === "supplier" && input.supplierId) {
    const s = await tx.supplier.findFirst({
      where: { id: input.supplierId, businessId },
      select: { name: true, legalName: true, addressStreet: true, addressCity: true, addressPostalCode: true },
    });
    if (!s) throw new NotFoundError("Supplier not found");
    const addr = [s.addressStreet, [s.addressCity, s.addressPostalCode].filter(Boolean).join(" ")].filter((x) => x && String(x).trim()).join("\n");
    recipient = { name: input.recipientName || (s.legalName ?? "").trim() || s.name, address: input.recipientAddress || addr };
  }
  return { issuer, recipient };
}

export async function renderLetterHtml(businessId: number, input: LetterInput): Promise<string> {
  const parties = await tenantTx(businessId, (tx) => resolveLetterPartiesTx(tx, businessId, input));
  return buildLetterHtml({ input, ...parties, fontDataUri: fontDataUri() });
}
