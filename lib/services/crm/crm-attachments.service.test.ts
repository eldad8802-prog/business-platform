/**
 * Integration test — CRM Attachments service + API routes.
 * Uses the LOCAL storage adapter against a throwaway temp dir.
 * Run: npx tsx lib/services/crm/crm-attachments.service.test.ts  (needs a dev DB).
 */
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { rm } from "node:fs/promises";

const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const STORAGE_ROOT = path.join(os.tmpdir(), `crm-att-${runId}`);
process.env.STORAGE_PROVIDER = "local";
process.env.LOCAL_STORAGE_ROOT = STORAGE_ROOT;
if (!process.env.AUTH_TOKEN_SECRET || !process.env.AUTH_TOKEN_SECRET.trim()) {
  process.env.AUTH_TOKEN_SECRET = "crm-phase2b-test-secret";
}

import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { resetStorageServiceForTests } from "@/lib/storage/storage.factory";
import { crmAttachmentsService } from "@/lib/services/crm/crm-attachments.service";
import { deleteAttachmentObject } from "@/lib/services/crm/crm-attachment-storage";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { signAuthToken } from "@/lib/auth-token";
import {
  GET as attGet,
  POST as attPost,
} from "@/app/api/crm/subjects/[subjectType]/[subjectId]/attachments/route";

const PDF = Buffer.from("%PDF-1.4 test attachment body");

async function makeBusiness(label: string, userCount: number) {
  const b = await prisma.business.create({ data: { name: `CRM Att ${label} ${runId}` } });
  const users: number[] = [];
  for (let i = 0; i < userCount; i++) {
    const u = await prisma.user.create({
      data: { businessId: b.id, email: `crm-att-${label}-${i}-${runId}@example.test`, password: "x", name: `U${label}${i}` },
    });
    users.push(u.id);
  }
  return { businessId: b.id, users };
}

function params(subjectType: string, subjectId: string) {
  return { params: Promise.resolve({ subjectType, subjectId }) };
}

async function main() {
  resetStorageServiceForTests();
  const a = await makeBusiness("A", 2);
  const b = await makeBusiness("B", 1);
  const [u1, u2] = a.users;
  const [u3] = b.users;

  try {
    const cust = await prisma.customer.create({ data: { businessId: a.businessId, name: "Cust A" } });
    const supp = await prisma.supplier.create({ data: { businessId: a.businessId, name: "Supp A" } });

    // ===== UPLOAD (customer + supplier) =====
    const up1 = await crmAttachmentsService.uploadAttachment({
      businessId: a.businessId, subjectType: "CUSTOMER", subjectId: cust.id,
      uploadedByUserId: u1, buffer: PDF, originalFileName: "חוזה.pdf", mimeType: "application/pdf",
    });
    assert.equal(up1.originalFileName, "חוזה.pdf", "display name kept");
    assert.equal(up1.mimeType, "application/pdf", "mime stored");
    assert.equal(up1.sizeBytes, PDF.length, "size = real byte length");
    assert.ok(!("storageKey" in up1) && !("businessId" in up1), "DTO hides storageKey/businessId");
    assert.equal(up1.canDelete, true, "uploader can delete");

    await crmAttachmentsService.uploadAttachment({
      businessId: a.businessId, subjectType: "SUPPLIER", subjectId: supp.id,
      uploadedByUserId: u1, buffer: PDF, originalFileName: "quote.pdf", mimeType: "application/pdf",
    });

    // ===== LIST + tenant/permission =====
    const listU1 = await crmAttachmentsService.listAttachments({ businessId: a.businessId, subjectType: "CUSTOMER", subjectId: cust.id, actingUserId: u1 });
    assert.equal(listU1.length, 1, "customer has 1 attachment (supplier excluded)");
    const listU2 = await crmAttachmentsService.listAttachments({ businessId: a.businessId, subjectType: "CUSTOMER", subjectId: cust.id, actingUserId: u2 });
    assert.equal(listU2[0].canDelete, false, "non-uploader cannot delete");
    await assert.rejects(() => crmAttachmentsService.listAttachments({ businessId: b.businessId, subjectType: "CUSTOMER", subjectId: cust.id, actingUserId: u3 }), NotFoundError, "cross-tenant subject list blocked");

    // ===== DOWNLOAD (bytes + tenant) =====
    const dl = await crmAttachmentsService.getAttachmentForDownload({ businessId: a.businessId, attachmentId: up1.id });
    assert.ok(dl.body.equals(PDF), "download returns original bytes");
    assert.equal(dl.displayFileName, "חוזה.pdf", "download uses display name");
    await assert.rejects(() => crmAttachmentsService.getAttachmentForDownload({ businessId: b.businessId, attachmentId: up1.id }), NotFoundError, "cross-tenant download blocked");

    // ===== traversal-safe key + storageKey never derived from filename =====
    const evil = await crmAttachmentsService.uploadAttachment({
      businessId: a.businessId, subjectType: "CUSTOMER", subjectId: cust.id,
      uploadedByUserId: u1, buffer: PDF, originalFileName: "../../../evil.pdf", mimeType: "application/pdf",
    });
    assert.equal(evil.originalFileName, "evil.pdf", "path stripped from display name");
    const evilRow = await prisma.crmAttachment.findUniqueOrThrow({ where: { id: evil.id } });
    assert.match(evilRow.storageKey, /^biz\/\d+\/crm\/CUSTOMER\/\d+\/att-\d+-[a-f0-9]+\.pdf$/, "server-generated safe key");

    // ===== VALIDATION via service =====
    await assert.rejects(() => crmAttachmentsService.uploadAttachment({ businessId: a.businessId, subjectType: "CUSTOMER", subjectId: cust.id, uploadedByUserId: u1, buffer: PDF, originalFileName: "x.zip", mimeType: "application/zip" }), ValidationError, "unapproved mime rejected");
    await assert.rejects(() => crmAttachmentsService.uploadAttachment({ businessId: a.businessId, subjectType: "CUSTOMER", subjectId: cust.id, uploadedByUserId: u1, buffer: PDF, originalFileName: "x.txt", mimeType: "application/pdf" }), ValidationError, "extension mismatch rejected");
    await assert.rejects(() => crmAttachmentsService.uploadAttachment({ businessId: a.businessId, subjectType: "CUSTOMER", subjectId: 99999999, uploadedByUserId: u1, buffer: PDF, originalFileName: "x.pdf", mimeType: "application/pdf" }), NotFoundError, "missing subject rejected");

    // ===== DELETE semantics =====
    await assert.rejects(() => crmAttachmentsService.deleteAttachment({ businessId: a.businessId, attachmentId: up1.id, actingUserId: u2 }), ForbiddenError, "non-uploader cannot delete");
    // null uploader → read-only
    await prisma.crmAttachment.update({ where: { id: evil.id }, data: { uploadedByUserId: null } });
    await assert.rejects(() => crmAttachmentsService.deleteAttachment({ businessId: a.businessId, attachmentId: evil.id, actingUserId: u1 }), ForbiddenError, "null-uploader read-only");
    // object-missing during delete → idempotent (metadata still removed)
    const missKey = evilRow.storageKey;
    await prisma.crmAttachment.update({ where: { id: evil.id }, data: { uploadedByUserId: u1 } });
    await deleteAttachmentObject(missKey); // remove the object out-of-band
    const delMiss = await crmAttachmentsService.deleteAttachment({ businessId: a.businessId, attachmentId: evil.id, actingUserId: u1 });
    assert.equal(delMiss.id, evil.id, "delete succeeds when object already gone (idempotent)");
    assert.equal(await prisma.crmAttachment.count({ where: { id: evil.id } }), 0, "metadata removed");
    // author delete (happy) removes metadata + object
    await crmAttachmentsService.deleteAttachment({ businessId: a.businessId, attachmentId: up1.id, actingUserId: u1 });
    await assert.rejects(() => crmAttachmentsService.getAttachmentForDownload({ businessId: a.businessId, attachmentId: up1.id }), NotFoundError, "deleted attachment gone");

    // ===== API routes =====
    const unauth = await attGet(new NextRequest("http://localhost/api/crm/subjects/CUSTOMER/1/attachments", { method: "GET" }), params("CUSTOMER", "1"));
    assert.equal(unauth.status, 401, "GET no auth → 401");
    const postUnauth = await attPost(new NextRequest("http://localhost/api/crm/subjects/CUSTOMER/1/attachments", { method: "POST" }), params("CUSTOMER", "1"));
    assert.equal(postUnauth.status, 401, "POST no auth → 401");

    const tokenA = signAuthToken(u1);
    const authHdr = { authorization: `Bearer ${tokenA}` };
    // no file
    const noFile = await attPost(new NextRequest(`http://localhost/api/crm/subjects/CUSTOMER/${cust.id}/attachments`, { method: "POST", headers: authHdr, body: new FormData() }), params("CUSTOMER", String(cust.id)));
    assert.equal(noFile.status, 400, "POST no file → 400");
    // >1 file
    const multi = new FormData();
    multi.append("file", new File([PDF], "a.pdf", { type: "application/pdf" }));
    multi.append("file", new File([PDF], "b.pdf", { type: "application/pdf" }));
    const multiRes = await attPost(new NextRequest(`http://localhost/api/crm/subjects/CUSTOMER/${cust.id}/attachments`, { method: "POST", headers: authHdr, body: multi }), params("CUSTOMER", String(cust.id)));
    assert.equal(multiRes.status, 400, "POST >1 file → 400");
    // happy
    const fd = new FormData();
    fd.append("file", new File([PDF], "api.pdf", { type: "application/pdf" }));
    const okRes = await attPost(new NextRequest(`http://localhost/api/crm/subjects/CUSTOMER/${cust.id}/attachments`, { method: "POST", headers: authHdr, body: fd }), params("CUSTOMER", String(cust.id)));
    assert.equal(okRes.status, 201, "POST happy → 201");
    const okJson = await okRes.json();
    assert.ok(!("storageKey" in okJson.attachment) && !("businessId" in okJson.attachment), "API DTO hides storageKey/businessId");
    // cross-tenant POST
    const tokenB = signAuthToken(u3);
    const crossRes = await attPost(new NextRequest(`http://localhost/api/crm/subjects/CUSTOMER/${cust.id}/attachments`, { method: "POST", headers: { authorization: `Bearer ${tokenB}` }, body: (() => { const f = new FormData(); f.append("file", new File([PDF], "x.pdf", { type: "application/pdf" })); return f; })() }), params("CUSTOMER", String(cust.id)));
    assert.equal(crossRes.status, 404, "cross-tenant POST → 404 (no leak)");

    console.log("crm-attachments.service.test.ts: ok");
  } finally {
    await prisma.crmAttachment.deleteMany({ where: { businessId: { in: [a.businessId, b.businessId] } } });
    await prisma.customer.deleteMany({ where: { businessId: { in: [a.businessId, b.businessId] } } });
    await prisma.supplier.deleteMany({ where: { businessId: { in: [a.businessId, b.businessId] } } });
    await prisma.business.deleteMany({ where: { id: { in: [a.businessId, b.businessId] } } });
    await prisma.$disconnect();
    await rm(STORAGE_ROOT, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exitCode = 1; });
