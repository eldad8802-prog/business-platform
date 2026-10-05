/**
 * Synthetic tenants for the Profile + Settings v2 visual evidence.
 *
 * LOCAL THROWAWAY DATABASE ONLY. Refuses to run unless DATABASE_URL points at
 * localhost / 127.0.0.1. Every value is synthetic; nothing here may ever be
 * pointed at a shared, preview or production database.
 *
 *   "full"  — a set-up business: details filled except the logo (the evidence
 *             run uploads one through the real camera button), customers,
 *             issued documents, quotes in every state, three live connections.
 *   "empty" — a business that has just signed up: no profile, no data.
 *
 * Prints {"full": {token}, "empty": {token}} for the screenshot run.
 *
 * Run: npx tsx qa-evidence/profile-settings-v2/seed-local.ts
 */
import { Prisma, PrismaClient } from "@prisma/client";

import { signAuthToken } from "../../lib/auth-token";
import { jerusalemDayKey } from "../../lib/utils/jerusalem-day";

const url = process.env.DATABASE_URL ?? "";
if (!/@(localhost|127\.0\.0\.1)(:\d+)?\//.test(url)) {
  console.error("seed-local: refusing — DATABASE_URL is not a localhost database");
  process.exit(1);
}

const prisma = new PrismaClient();
const D = (v: string) => new Prisma.Decimal(v);
const day = (offset: number) =>
  new Date(`${jerusalemDayKey(new Date(Date.now() + offset * 86_400_000))}T00:00:00.000Z`);
const tag = Date.now().toString(36);

// A small synthetic signature stamp (1×1 PNG) — the signature only has to exist.
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

let n = 1;
function doc(businessId: number, documentType: string, status: string, extra: Record<string, unknown> = {}) {
  return {
    businessId,
    documentType,
    status,
    documentNumber: n++,
    customerNameSnapshot: "לקוח לדוגמה",
    subtotalAmount: D("100.00"),
    vatAmount: D("0"),
    totalAmount: D("100.00"),
    currency: "ILS",
    ...(status === "ISSUED" ? { issuedAt: new Date() } : {}),
    ...extra,
  } as Prisma.BillingDocumentUncheckedCreateInput;
}

async function main() {
  const full = await prisma.business.create({ data: { name: "מאפיית השקמה" } });
  const fullUser = await prisma.user.create({
    data: { email: `owner-${tag}@example.test`, password: "x", name: "נועה כהן", businessId: full.id },
  });
  await prisma.businessProfile.create({
    data: {
      businessId: full.id,
      category: "Food",
      subCategory: "Bakery",
      billingLegalName: "מאפיית השקמה בע״מ",
      billingBusinessKind: "LTD_COMPANY",
      billingTaxId: "000000000",
      billingAddress: "רחוב השקמה 12, חיפה",
      billingPhone: "04-0000000",
      billingEmail: "hello@example.test",
      billingSignatureDataUrl: PNG,
    },
  });
  for (let i = 0; i < 37; i++) {
    await prisma.customer.create({ data: { businessId: full.id, name: `לקוח ${i + 1}`, phone: `05400${tag.slice(-3)}${String(i).padStart(2, "0")}` } });
  }
  await prisma.customer.create({ data: { businessId: full.id, name: "לקוח לא פעיל", isActive: false } });
  for (let i = 0; i < 10; i++) await prisma.billingDocument.create({ data: doc(full.id, "TAX_INVOICE", "ISSUED") });
  for (let i = 0; i < 2; i++) await prisma.billingDocument.create({ data: doc(full.id, "RECEIPT", "ISSUED", { unappliedAmount: D("0") }) });
  await prisma.billingDocument.create({ data: doc(full.id, "TAX_INVOICE", "DRAFT") });
  await prisma.billingDocument.create({ data: doc(full.id, "QUOTE", "DRAFT") });
  await prisma.billingDocument.create({ data: doc(full.id, "QUOTE", "DRAFT", { validUntil: day(0) }) });
  await prisma.billingDocument.create({ data: doc(full.id, "QUOTE", "DRAFT", { validUntil: day(14) }) });
  await prisma.billingDocument.create({ data: doc(full.id, "QUOTE", "PENDING_REVIEW", { validUntil: day(30) }) });
  await prisma.billingDocument.create({ data: doc(full.id, "QUOTE", "DRAFT", { validUntil: day(-3) }) });
  await prisma.emailConnection.create({
    data: { businessId: full.id, provider: "gmail", emailAddress: "inbox@example.test", providerAccountId: `pa-${tag}`, scopes: "x", status: "connected" },
  });
  await prisma.businessPaymentConnection.create({ data: { businessId: full.id, provider: "CARDCOM", isActive: true } });
  await prisma.whatsAppConnection.create({
    data: {
      businessId: full.id,
      phoneNumberId: `pn-${tag}`,
      displayPhoneNumber: "+972000000000",
      wabaId: "waba-synthetic",
      accessTokenEncrypted: "synthetic",
      accessTokenIv: "synthetic",
      accessTokenTag: "synthetic",
      status: "CONNECTED",
    },
  });

  const empty = await prisma.business.create({ data: { name: "סטודיו חדש" } });
  const emptyUser = await prisma.user.create({
    data: { email: `new-${tag}@example.test`, password: "x", businessId: empty.id },
  });

  console.log(
    JSON.stringify({
      full: { token: signAuthToken(fullUser.id, 0), businessId: full.id },
      empty: { token: signAuthToken(emptyUser.id, 0), businessId: empty.id },
    })
  );
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
