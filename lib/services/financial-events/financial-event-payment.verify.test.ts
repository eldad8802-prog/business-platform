/**
 * Run: npx tsx lib/services/financial-events/financial-event-payment.verify.test.ts
 *
 * ensurePaymentPostedEvent — projects a verified PAID settlement into a
 * FinancialEvent(PAYMENT). Keyed on the transaction id (settlement fact, not
 * the request intent). No DB — a fake tx captures the writes.
 */
import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import { ensurePaymentPostedEvent } from "./financial-event.service";

type Row = Record<string, unknown>;

function makeFakeTx() {
  const rows: Row[] = [];
  let throwP2002Once = false;
  const match = (where: any) => {
    const k = where.businessId_sourceType_sourceKey;
    return (
      rows.find(
        (r) =>
          r.businessId === k.businessId &&
          r.sourceType === k.sourceType &&
          r.sourceKey === k.sourceKey
      ) ?? null
    );
  };
  return {
    rows,
    armRaceP2002() {
      throwP2002Once = true;
    },
    financialEvent: {
      async findUnique({ where }: any) {
        return match(where);
      },
      async create({ data }: any) {
        if (throwP2002Once) {
          throwP2002Once = false;
          rows.push({ ...data }); // a racing tx "wins" the insert
          throw new Prisma.PrismaClientKnownRequestError("unique", {
            code: "P2002",
            clientVersion: "test",
          } as any);
        }
        rows.push({ ...data });
        return { ...data };
      },
    },
  };
}

async function main() {
  // --- creates a PAYMENT income event keyed on the transaction id ---
  {
    const tx = makeFakeTx();
    await ensurePaymentPostedEvent(tx as unknown as Prisma.TransactionClient, {
      businessId: 1,
      paymentRequestId: 10,
      transactionId: 55,
      amount: "100.00",
      currency: "ILS",
      occurredAt: new Date("2026-06-30T00:00:00.000Z"),
    });
    assert.equal(tx.rows.length, 1);
    const ev = tx.rows[0]!;
    assert.equal(ev.sourceType, "PAYMENT");
    assert.equal(ev.sourceKey, "55"); // transaction id, NOT request id
    assert.equal(ev.direction, "INCOME");
    assert.equal(ev.status, "POSTED");
    assert.equal(ev.amount, "100.00");
    assert.equal(ev.category, "payment");
    assert.ok(!("billingDocumentId" in ev) || ev.billingDocumentId == null);
  }

  // --- idempotent: same transaction id never creates a second event ---
  {
    const tx = makeFakeTx();
    const input = {
      businessId: 1,
      paymentRequestId: 10,
      transactionId: 55,
      amount: "100.00",
      currency: "ILS",
      occurredAt: new Date("2026-06-30T00:00:00.000Z"),
    };
    await ensurePaymentPostedEvent(tx as unknown as Prisma.TransactionClient, input);
    await ensurePaymentPostedEvent(tx as unknown as Prisma.TransactionClient, input);
    assert.equal(tx.rows.length, 1); // no duplicate
  }

  // --- different transaction ids are distinct events ---
  {
    const tx = makeFakeTx();
    const base = {
      businessId: 1,
      paymentRequestId: 10,
      amount: "1.00",
      currency: "ILS",
      occurredAt: new Date("2026-06-30T00:00:00.000Z"),
    };
    await ensurePaymentPostedEvent(tx as unknown as Prisma.TransactionClient, { ...base, transactionId: 1 });
    await ensurePaymentPostedEvent(tx as unknown as Prisma.TransactionClient, { ...base, transactionId: 2 });
    assert.equal(tx.rows.length, 2);
  }

  // --- race: P2002 on create is treated as success after re-read ---
  {
    const tx = makeFakeTx();
    tx.armRaceP2002();
    await ensurePaymentPostedEvent(tx as unknown as Prisma.TransactionClient, {
      businessId: 1,
      paymentRequestId: 10,
      transactionId: 77,
      amount: "5.00",
      currency: "ILS",
      occurredAt: new Date("2026-06-30T00:00:00.000Z"),
    }); // resolves (winner row found), does not throw
    assert.equal(tx.rows.length, 1);
  }

  console.log("financial-event-payment tests: OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
