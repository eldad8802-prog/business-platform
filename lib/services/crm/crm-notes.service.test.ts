/**
 * Integration test — CRM Notes service + API routes.
 * Run: npx tsx lib/services/crm/crm-notes.service.test.ts  (needs a dev DB).
 */
import assert from "node:assert/strict";

if (!process.env.AUTH_TOKEN_SECRET || !process.env.AUTH_TOKEN_SECRET.trim()) {
  process.env.AUTH_TOKEN_SECRET = "crm-phase2a-test-secret";
}

import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { crmNotesService, NOTE_BODY_MAX } from "@/lib/services/crm/crm-notes.service";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { signAuthToken } from "@/lib/auth-token";
import {
  GET as notesGet,
  POST as notesPost,
} from "@/app/api/crm/subjects/[subjectType]/[subjectId]/notes/route";

const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

async function makeBusinessWithUsers(label: string, userCount: number) {
  const b = await prisma.business.create({ data: { name: `CRM Notes ${label} ${runId}` } });
  const users: number[] = [];
  for (let i = 0; i < userCount; i++) {
    const u = await prisma.user.create({
      data: { businessId: b.id, email: `crm-notes-${label}-${i}-${runId}@example.test`, password: "x", name: `User ${label}${i}` },
    });
    users.push(u.id);
  }
  return { businessId: b.id, users };
}

async function main() {
  const a = await makeBusinessWithUsers("A", 2); // U1 author, U2 same-business non-author
  const b = await makeBusinessWithUsers("B", 1);
  const [u1, u2] = a.users;
  const [u3] = b.users;

  try {
    const custA = await prisma.customer.create({
      data: { businessId: a.businessId, name: "Cust A", notes: "general summary note" },
    });
    const suppA = await prisma.supplier.create({ data: { businessId: a.businessId, name: "Supp A" } });

    // ===== CREATE (customer + supplier) =====
    const n1 = await crmNotesService.createNote({
      businessId: a.businessId, subjectType: "CUSTOMER", subjectId: custA.id, body: "  first note  ", createdByUserId: u1,
    });
    assert.equal(n1.body, "first note", "body trimmed");
    assert.equal(n1.author.id, u1, "author is creator");
    assert.equal(n1.canEdit && n1.canDelete, true, "creator can edit+delete");

    const n2 = await crmNotesService.createNote({
      businessId: a.businessId, subjectType: "CUSTOMER", subjectId: custA.id, body: "second note", createdByUserId: u1,
    });
    await crmNotesService.createNote({
      businessId: a.businessId, subjectType: "SUPPLIER", subjectId: suppA.id, body: "supplier note", createdByUserId: u1,
    });

    // ===== LIST (newest-first, subject-scoped) =====
    const listU1 = await crmNotesService.listNotes({
      businessId: a.businessId, subjectType: "CUSTOMER", subjectId: custA.id, actingUserId: u1,
    });
    assert.equal(listU1.length, 2, "customer has 2 notes (supplier note excluded)");
    assert.equal(listU1[0].id, n2.id, "newest first");
    assert.equal(listU1[0].canEdit, true, "author can edit in list");

    // same-business non-author can READ but not modify
    const listU2 = await crmNotesService.listNotes({
      businessId: a.businessId, subjectType: "CUSTOMER", subjectId: custA.id, actingUserId: u2,
    });
    assert.equal(listU2.length, 2, "same-business user reads notes");
    assert.equal(listU2[0].canEdit || listU2[0].canDelete, false, "non-author cannot edit/delete");

    // ===== TENANT ISOLATION =====
    await assert.rejects(
      () => crmNotesService.listNotes({ businessId: b.businessId, subjectType: "CUSTOMER", subjectId: custA.id, actingUserId: u3 }),
      NotFoundError,
      "other business cannot list A's subject notes"
    );

    // ===== UPDATE / DELETE ownership =====
    const upd = await crmNotesService.updateNote({ businessId: a.businessId, noteId: n1.id, actingUserId: u1, body: "edited" });
    assert.equal(upd.body, "edited", "author edits");
    await assert.rejects(
      () => crmNotesService.updateNote({ businessId: a.businessId, noteId: n2.id, actingUserId: u2, body: "hijack" }),
      ForbiddenError,
      "non-author cannot edit"
    );
    await assert.rejects(
      () => crmNotesService.deleteNote({ businessId: a.businessId, noteId: n2.id, actingUserId: u2 }),
      ForbiddenError,
      "non-author cannot delete"
    );

    // ===== AUTHOR NULL → read-only =====
    await prisma.crmNote.update({ where: { id: n2.id }, data: { createdByUserId: null } });
    await assert.rejects(
      () => crmNotesService.updateNote({ businessId: a.businessId, noteId: n2.id, actingUserId: u1, body: "x" }),
      ForbiddenError,
      "null-author note is read-only (edit)"
    );
    await assert.rejects(
      () => crmNotesService.deleteNote({ businessId: a.businessId, noteId: n2.id, actingUserId: u1 }),
      ForbiddenError,
      "null-author note is read-only (delete)"
    );

    // ===== VALIDATION =====
    await assert.rejects(
      () => crmNotesService.createNote({ businessId: a.businessId, subjectType: "CUSTOMER", subjectId: custA.id, body: "   ", createdByUserId: u1 }),
      ValidationError, "empty body rejected"
    );
    await assert.rejects(
      () => crmNotesService.createNote({ businessId: a.businessId, subjectType: "CUSTOMER", subjectId: custA.id, body: "x".repeat(NOTE_BODY_MAX + 1), createdByUserId: u1 }),
      ValidationError, "too-long body rejected"
    );
    await assert.rejects(
      () => crmNotesService.createNote({ businessId: a.businessId, subjectType: "CUSTOMER", subjectId: 99999999, body: "hi", createdByUserId: u1 }),
      NotFoundError, "missing subject rejected"
    );
    await assert.rejects(
      () => crmNotesService.createNote({ businessId: a.businessId, subjectType: "LEAD", subjectId: custA.id, body: "hi", createdByUserId: u1 }),
      ValidationError, "unsupported subjectType rejected"
    );

    // ===== Customer.notes untouched =====
    const custAfter = await prisma.customer.findUniqueOrThrow({ where: { id: custA.id } });
    assert.equal(custAfter.notes, "general summary note", "scalar Customer.notes unchanged");

    // ===== API: 401, DTO shape, cross-tenant no leak =====
    const params = (subjectType: string, subjectId: string) => ({ params: Promise.resolve({ subjectType, subjectId }) });

    const unauth = await notesGet(
      new NextRequest(`http://localhost/api/crm/subjects/CUSTOMER/${custA.id}/notes`, { method: "GET" }),
      params("CUSTOMER", String(custA.id))
    );
    assert.equal(unauth.status, 401, "GET without auth → 401");

    const tokenA = signAuthToken(u1);
    const created = await notesPost(
      new NextRequest(`http://localhost/api/crm/subjects/CUSTOMER/${custA.id}/notes`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${tokenA}` },
        body: JSON.stringify({ body: "via api" }),
      }),
      params("CUSTOMER", String(custA.id))
    );
    assert.equal(created.status, 201, "POST authed → 201");
    const createdJson = await created.json();
    assert.ok(!("businessId" in createdJson.note), "note DTO does not expose businessId");
    assert.ok(!("subjectId" in createdJson.note), "note DTO does not expose subjectId");

    // cross-tenant POST (user B → A's customer) → 404, no leak
    const tokenB = signAuthToken(u3);
    const crossTenant = await notesPost(
      new NextRequest(`http://localhost/api/crm/subjects/CUSTOMER/${custA.id}/notes`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${tokenB}` },
        body: JSON.stringify({ body: "leak?" }),
      }),
      params("CUSTOMER", String(custA.id))
    );
    assert.equal(crossTenant.status, 404, "cross-tenant POST → 404 (no leak)");

    console.log("crm-notes.service.test.ts: ok");
  } finally {
    await prisma.crmNote.deleteMany({ where: { businessId: { in: [a.businessId, b.businessId] } } });
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
