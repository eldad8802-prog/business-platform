/**
 * Integration test — CRM subject resolver.
 * Run: npx tsx lib/services/crm/crm-subject.resolver.test.ts  (needs a dev DB).
 */
import assert from "node:assert/strict";
import { prisma } from "@/lib/prisma";
import { resolveCrmSubject } from "@/lib/services/crm/crm-subject.resolver";
import { NotFoundError, ValidationError } from "@/lib/errors";

const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

async function makeBusiness(label: string) {
  const b = await prisma.business.create({
    data: {
      name: `CRM Subj ${label} ${runId}`,
      users: {
        create: {
          email: `crm-subj-${label}-${runId}@example.test`,
          password: "x",
          name: "u",
        },
      },
    },
    include: { users: true },
  });
  return { businessId: b.id, userId: b.users[0].id };
}

async function main() {
  const a = await makeBusiness("A");
  const b = await makeBusiness("B");
  try {
    const custA = await prisma.customer.create({ data: { businessId: a.businessId, name: "Cust A" } });
    const suppA = await prisma.supplier.create({ data: { businessId: a.businessId, name: "Supp A" } });
    const custB = await prisma.customer.create({ data: { businessId: b.businessId, name: "Cust B" } });

    // existing subjects
    const r1 = await resolveCrmSubject({ businessId: a.businessId, subjectType: "CUSTOMER", subjectId: custA.id });
    assert.equal(r1.displayName, "Cust A", "resolves existing customer");
    const r2 = await resolveCrmSubject({ businessId: a.businessId, subjectType: "SUPPLIER", subjectId: suppA.id });
    assert.equal(r2.displayName, "Supp A", "resolves existing supplier");
    // lowercase type accepted
    const r3 = await resolveCrmSubject({ businessId: a.businessId, subjectType: "customer", subjectId: custA.id });
    assert.equal(r3.subjectType, "CUSTOMER", "normalizes lowercase type");

    // cross-tenant → NotFound (no leak; same as missing)
    await assert.rejects(
      () => resolveCrmSubject({ businessId: a.businessId, subjectType: "CUSTOMER", subjectId: custB.id }),
      NotFoundError,
      "cross-tenant customer → NotFound"
    );
    await assert.rejects(
      () => resolveCrmSubject({ businessId: b.businessId, subjectType: "SUPPLIER", subjectId: suppA.id }),
      NotFoundError,
      "cross-tenant supplier → NotFound"
    );
    // missing subject
    await assert.rejects(
      () => resolveCrmSubject({ businessId: a.businessId, subjectType: "CUSTOMER", subjectId: 99999999 }),
      NotFoundError,
      "missing subject → NotFound"
    );
    // unsupported type — "LEAD" used to stand in here, but LEAD became a real
    // subject in Leads W1, so the example had to move to a type that is still
    // genuinely outside the vocabulary.
    await assert.rejects(
      () => resolveCrmSubject({ businessId: a.businessId, subjectType: "PROJECT", subjectId: custA.id }),
      ValidationError,
      "unsupported subjectType → ValidationError"
    );
    // LEAD is now supported: a lead id that does not exist is NotFound (the
    // type is fine, the row is not) — proving the branch is wired, not ignored.
    await assert.rejects(
      () => resolveCrmSubject({ businessId: a.businessId, subjectType: "LEAD", subjectId: 99999999 }),
      NotFoundError,
      "LEAD is a supported subject; a missing lead → NotFound"
    );
    // invalid id
    await assert.rejects(
      () => resolveCrmSubject({ businessId: a.businessId, subjectType: "CUSTOMER", subjectId: 0 }),
      ValidationError,
      "invalid subjectId → ValidationError"
    );

    console.log("crm-subject.resolver.test.ts: ok");
  } finally {
    await prisma.customer.deleteMany({ where: { businessId: { in: [a.businessId, b.businessId] } } });
    await prisma.supplier.deleteMany({ where: { businessId: { in: [a.businessId, b.businessId] } } });
    await prisma.business.deleteMany({ where: { id: { in: [a.businessId, b.businessId] } } });
    await prisma.$disconnect();
  }
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exitCode = 1;
});
