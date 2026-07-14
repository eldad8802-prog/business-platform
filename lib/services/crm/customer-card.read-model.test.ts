/**
 * Integration test — Customer Card read-model.
 * Run: npx tsx lib/services/crm/customer-card.read-model.test.ts  (needs a dev DB).
 *
 * Verifies the card aggregates ONLY the customer's real, tenant-scoped relations.
 */
import assert from "node:assert/strict";
import { prisma } from "@/lib/prisma";
import { getCustomerCard } from "@/lib/services/crm/customer-card.read-model";
import { NotFoundError } from "@/lib/errors";

const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

async function createBusinessWithUser(label: string) {
  const business = await prisma.business.create({
    data: {
      name: `CRM Card ${label} ${runId}`,
      users: {
        create: {
          email: `crm-card-${label}-${runId}@example.test`,
          password: "test-password",
          name: "CRM Card User",
        },
      },
    },
    include: { users: true },
  });
  return { businessId: business.id, userId: business.users[0].id };
}

async function main() {
  const a = await createBusinessWithUser("A");
  const b = await createBusinessWithUser("B");

  try {
    const customer = await prisma.customer.create({
      data: { businessId: a.businessId, name: "Card Customer", city: "חיפה", notes: "הערת בדיקה" },
    });
    // A SECOND customer in the same business — its rows must NOT leak into the card.
    const otherCustomer = await prisma.customer.create({
      data: { businessId: a.businessId, name: "Other Customer" },
    });

    // Real related rows for the target customer.
    await prisma.billingDocument.create({
      data: {
        businessId: a.businessId,
        customerId: customer.id,
        documentType: "TAX_INVOICE",
        totalAmount: "250.50",
        currency: "ILS",
      },
    });
    await prisma.paymentRequest.create({
      data: {
        businessId: a.businessId,
        customerId: customer.id,
        provider: "TRANZILA",
        amount: "100",
        currency: "ILS",
      },
    });
    await prisma.conversation.create({
      data: { businessId: a.businessId, customerId: customer.id, channel: "WHATSAPP" },
    });
    await prisma.appointment.create({
      data: {
        businessId: a.businessId,
        customerId: customer.id,
        createdByActor: "OWNER",
        sourceChannel: "INBOX_WEB",
        createdByUserId: a.userId,
        title: "פגישת בדיקה",
      },
    });

    // Noise that must be excluded: a doc for the OTHER customer in the same business.
    await prisma.billingDocument.create({
      data: {
        businessId: a.businessId,
        customerId: otherCustomer.id,
        documentType: "QUOTE",
        totalAmount: "999",
      },
    });

    // ===== 1. AGGREGATION =====
    const card = await getCustomerCard({
      businessId: a.businessId,
      customerId: customer.id,
    });

    assert.equal(card.customer.id, customer.id, "card is for the target customer");
    assert.equal(card.customer.notes, "הערת בדיקה", "notes surfaced");
    assert.equal(typeof card.customer.createdAt, "string", "dates serialized to ISO strings");

    assert.equal(card.billingDocuments.total, 1, "only the customer's billing doc counted");
    assert.equal(card.billingDocuments.items.length, 1, "billing doc item present");
    assert.equal(typeof card.billingDocuments.items[0].totalAmount, "string", "decimal → string");
    assert.equal(Number(card.billingDocuments.items[0].totalAmount), 250.5, "decimal value intact");

    assert.equal(card.paymentRequests.total, 1, "payment request surfaced");
    assert.equal(Number(card.paymentRequests.items[0].amount), 100, "payment amount intact");

    assert.equal(card.conversations.total, 1, "conversation surfaced");
    assert.equal(card.appointments.total, 1, "appointment surfaced");
    assert.equal(card.appointments.items[0].title, "פגישת בדיקה", "appointment title surfaced");

    assert.equal(card.activity.hasAnyActivity, true, "activity flagged true");
    assert.ok(card.activity.lastActivityAt, "last activity derived from a real source");
    // B1: the seeded appointment starts 5 days in the FUTURE. Last activity must
    // never surface a future date — it reflects createdAt, which is ~now.
    assert.ok(
      new Date(card.activity.lastActivityAt).getTime() <= Date.now() + 5000,
      "last activity is not a future date despite a future appointment"
    );

    // ===== 2. TENANT ISOLATION =====
    await assert.rejects(
      () => getCustomerCard({ businessId: b.businessId, customerId: customer.id }),
      NotFoundError,
      "cannot open another business's customer card"
    );

    // ===== 3. EMPTY CUSTOMER — real-relations-only, no fabrication =====
    const emptyCard = await getCustomerCard({
      businessId: a.businessId,
      customerId: otherCustomer.id,
    });
    assert.equal(emptyCard.billingDocuments.total, 1, "other customer sees only its own doc");
    assert.equal(emptyCard.paymentRequests.total, 0, "no payment requests fabricated");
    assert.equal(emptyCard.conversations.total, 0, "no conversations fabricated");
    assert.equal(emptyCard.appointments.total, 0, "no appointments fabricated");

    console.log("customer-card.read-model.test.ts: ok");
  } finally {
    await prisma.billingDocument.deleteMany({
      where: { businessId: { in: [a.businessId, b.businessId] } },
    });
    await prisma.paymentRequest.deleteMany({
      where: { businessId: { in: [a.businessId, b.businessId] } },
    });
    await prisma.appointment.deleteMany({
      where: { businessId: { in: [a.businessId, b.businessId] } },
    });
    await prisma.conversation.deleteMany({
      where: { businessId: { in: [a.businessId, b.businessId] } },
    });
    await prisma.customer.deleteMany({
      where: { businessId: { in: [a.businessId, b.businessId] } },
    });
    await prisma.business.deleteMany({
      where: { id: { in: [a.businessId, b.businessId] } },
    });
    await prisma.$disconnect();
  }
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exitCode = 1;
});
