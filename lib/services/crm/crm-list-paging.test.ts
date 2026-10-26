/**
 * Paged supplier list, notes and files — the limits fix.
 *
 * Proves, against a real database:
 *   - the supplier list reports the size of the WHOLE list (not the loaded page), pages without
 *     repeating or skipping a row, and keeps every page inside the caller's business;
 *   - notes / files report their real total beyond the 100-row page, and the `before` cursor
 *     continues strictly after the last row shown — a note added meanwhile at the top neither
 *     repeats nor shifts anything;
 *   - a cursor id from ANOTHER subject or ANOTHER business yields an empty page, never its rows.
 *
 * Run (needs a seeded DATABASE_URL): npx tsx lib/services/crm/crm-list-paging.test.ts
 */
import assert from "node:assert/strict";
import { prisma } from "@/lib/prisma";
import { supplierService } from "@/lib/services/inventory/supplier.service";
import { crmNotesService, NOTES_LIST_LIMIT } from "@/lib/services/crm/crm-notes.service";
import { crmAttachmentsService, ATTACHMENTS_LIST_LIMIT } from "@/lib/services/crm/crm-attachments.service";
import { runWithTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction } from "@/lib/tenant/transaction";

// The paged reads require the tenant transaction (no bare-client fallback): call them the way the routes do.
const suppliersPage = (input: Parameters<typeof supplierService.listSuppliersPage>[0]) =>
  runWithTenantContext({ businessId: input.businessId }, () =>
    withTenantTransaction((tx) => supplierService.listSuppliersPage(input, { tx })));
const notesPage = (input: Parameters<typeof crmNotesService.listNotesPage>[0]) =>
  runWithTenantContext({ businessId: input.businessId }, () =>
    withTenantTransaction((tx) => crmNotesService.listNotesPage(input, { tx })));
const attachmentsPage = (input: Parameters<typeof crmAttachmentsService.listAttachmentsPage>[0]) =>
  runWithTenantContext({ businessId: input.businessId }, () =>
    withTenantTransaction((tx) => crmAttachmentsService.listAttachmentsPage(input, { tx })));


const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

async function createBusiness(label: string) {
  const business = await prisma.business.create({
    data: {
      name: `Paging ${label} ${runId}`,
      users: { create: { email: `paging-${label}-${runId}@example.test`, password: "x", name: "Paging" } },
    },
    include: { users: true },
  });
  return { businessId: business.id, userId: business.users[0].id };
}

async function main() {
  const a = await createBusiness("a");
  const b = await createBusiness("b");
  try {
    // ── Suppliers: 123 in A (113 active, 10 inactive), 5 in B ─────────────────────────────
    const names = Array.from({ length: 123 }, (_, i) => `ספק ${String(i).padStart(3, "0")}`);
    await prisma.supplier.createMany({
      data: names.map((name, i) => ({ businessId: a.businessId, name, isActive: i >= 10 })),
    });
    await prisma.supplier.createMany({
      data: Array.from({ length: 5 }, (_, i) => ({ businessId: b.businessId, name: `ספק ${i}` })),
    });

    const p1 = await suppliersPage({ businessId: a.businessId, status: "active" });
    assert.equal(p1.total, 113, "total = every ACTIVE supplier in A, not the page length");
    assert.equal(p1.rows.length, 50, "first page = 50");
    assert.equal(p1.hasMore, true, "more pages exist");
    const p2 = await suppliersPage({ businessId: a.businessId, status: "active", offset: 50 });
    const p3 = await suppliersPage({ businessId: a.businessId, status: "active", offset: 100 });
    assert.equal(p3.rows.length, 13, "last page holds the remainder");
    assert.equal(p3.hasMore, false, "no page after the last");
    const ids = [...p1.rows, ...p2.rows, ...p3.rows].map((s) => s.id);
    assert.equal(new Set(ids).size, 113, "three pages = 113 distinct suppliers, nothing repeated or skipped");
    assert.ok([...p1.rows, ...p2.rows, ...p3.rows].every((s) => s.businessId === a.businessId), "no row from B");

    const all = await suppliersPage({ businessId: a.businessId, status: "all" });
    assert.equal(all.total, 123, "status=all counts inactive too");
    const inactive = await suppliersPage({ businessId: a.businessId, status: "inactive" });
    assert.equal(inactive.total, 10, "status=inactive");
    const search = await suppliersPage({ businessId: a.businessId, status: "all", query: "ספק 10" });
    assert.equal(search.total, search.rows.length, "a filtered total matches the filtered rows");
    assert.equal(search.total, 10, "search filter applies to the count too (ספק 100–109)");
    const bPage = await suppliersPage({ businessId: b.businessId });
    assert.equal(bPage.total, 5, "B sees only its own 5");
    await assert.rejects(
      suppliersPage({ businessId: a.businessId, offset: -1 }),
      /offset must be a non-negative integer/,
      "a negative offset is refused",
    );

    // ── Notes: 130 on one supplier of A; 3 on another; 2 on a supplier of B ──────────────
    const [s1, s2] = await prisma.supplier.findMany({ where: { businessId: a.businessId }, orderBy: { id: "asc" }, take: 2 });
    const sB = await prisma.supplier.findFirstOrThrow({ where: { businessId: b.businessId } });
    const base = Date.UTC(2026, 0, 1);
    await prisma.crmNote.createMany({
      data: Array.from({ length: 130 }, (_, i) => ({
        businessId: a.businessId, subjectType: "SUPPLIER" as const, subjectId: s1.id, body: `note ${i}`,
        createdByUserId: a.userId, createdAt: new Date(base + i * 60_000),
      })),
    });
    await prisma.crmNote.createMany({
      data: Array.from({ length: 3 }, (_, i) => ({ businessId: a.businessId, subjectType: "SUPPLIER" as const, subjectId: s2.id, body: `other ${i}`, createdByUserId: a.userId })),
    });
    await prisma.crmNote.createMany({
      data: Array.from({ length: 2 }, (_, i) => ({ businessId: b.businessId, subjectType: "SUPPLIER" as const, subjectId: sB.id, body: `b ${i}`, createdByUserId: b.userId })),
    });
    const scopeA = { businessId: a.businessId, subjectType: "SUPPLIER", subjectId: s1.id, actingUserId: a.userId };

    const n1 = await notesPage(scopeA);
    assert.equal(n1.total, 130, "notes total beyond the 100 page");
    assert.equal(n1.notes.length, NOTES_LIST_LIMIT, "first page = the limit");
    assert.equal(n1.hasMore, true, "older notes exist");
    assert.equal(n1.notes[0].body, "note 129", "newest first");

    // A note added at the top between pages must not repeat or shift the next page.
    await prisma.crmNote.create({
      data: { businessId: a.businessId, subjectType: "SUPPLIER", subjectId: s1.id, body: "added meanwhile", createdByUserId: a.userId },
    });
    const n2 = await notesPage({ ...scopeA, before: n1.notes.at(-1)!.id });
    assert.equal(n2.notes.length, 30, "second page = the 30 older notes");
    assert.equal(n2.hasMore, false, "nothing after the second page");
    assert.equal(n2.total, 131, "total counts the note added meanwhile");
    const seen = new Set(n1.notes.map((n) => n.id));
    assert.ok(n2.notes.every((n) => !seen.has(n.id)), "no note repeats across pages");
    assert.equal(n2.notes[0].body, "note 29", "page 2 continues exactly after page 1");
    assert.equal(n2.notes.at(-1)!.body, "note 0", "…down to the oldest");

    const otherSubjectNote = await prisma.crmNote.findFirstOrThrow({ where: { subjectId: s2.id, businessId: a.businessId } });
    const foreignNote = await prisma.crmNote.findFirstOrThrow({ where: { businessId: b.businessId } });
    const viaOther = await notesPage({ ...scopeA, before: otherSubjectNote.id });
    assert.equal(viaOther.notes.length, 0, "a cursor from another subject → empty page");
    const viaForeign = await notesPage({ ...scopeA, before: foreignNote.id });
    assert.equal(viaForeign.notes.length, 0, "a cursor from another business → empty page");
    await assert.rejects(
      notesPage({ businessId: a.businessId, subjectType: "SUPPLIER", subjectId: sB.id, actingUserId: a.userId }),
      undefined,
      "A cannot page B's supplier at all (subject resolver refuses)",
    );

    // ── Files: 104 on one supplier ─────────────────────────────────────────────────────────
    await prisma.crmAttachment.createMany({
      data: Array.from({ length: 104 }, (_, i) => ({
        businessId: a.businessId, subjectType: "SUPPLIER" as const, subjectId: s1.id,
        storageKey: `paging/${runId}/${i}`, originalFileName: `f${i}.pdf`, mimeType: "application/pdf",
        sizeBytes: 10, uploadedByUserId: a.userId, createdAt: new Date(base + i * 60_000),
      })),
    });
    const f1 = await attachmentsPage(scopeA);
    assert.equal(f1.total, 104, "files total beyond the 100 page");
    assert.equal(f1.attachments.length, ATTACHMENTS_LIST_LIMIT, "first page = the limit");
    assert.equal(f1.hasMore, true, "older files exist");
    const f2 = await attachmentsPage({ ...scopeA, before: f1.attachments.at(-1)!.id });
    assert.equal(f2.attachments.length, 4, "second page = the 4 older files");
    assert.equal(f2.hasMore, false, "nothing after");
    assert.equal(new Set([...f1.attachments, ...f2.attachments].map((x) => x.id)).size, 104, "no file repeats");

    console.log("crm-list-paging.test.ts: ok");
  } finally {
    for (const id of [a.businessId, b.businessId]) {
      await prisma.crmAttachment.deleteMany({ where: { businessId: id } });
      await prisma.crmNote.deleteMany({ where: { businessId: id } });
      await prisma.supplier.deleteMany({ where: { businessId: id } });
      await prisma.user.deleteMany({ where: { businessId: id } });
      await prisma.business.deleteMany({ where: { id } });
    }
    await prisma.$disconnect();
  }
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exitCode = 1;
});
