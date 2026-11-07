/**
 * The invoice PDF shows the allocation number from the data stored for the
 * document — through the real PDF service, renderer and storage.
 *
 * WHAT IS PINNED
 *
 * The allocation number arrives AFTER issuance, so the frozen snapshot holds
 * null. recordAuthorityApprovedTx writes the full confirmation number to
 * BillingDocument.allocationNumber and resets the cached PDF to PENDING;
 * getOrRenderBillingPdf overlays the 9 right-most digits (§2.2.1) for display
 * only. A0 pins the renderer given an already-overlaid snapshot; nothing pinned
 * this service path: the stored column → the PDF, the delivery block before the
 * number exists, the cache, and tenant isolation.
 *
 * Posture: every repository RLS statement replayed; NOSUPERUSER / NOBYPASSRLS;
 * no ambient tenant context. Real HTML renderer (local Chromium) and local
 * storage in a temp directory. No authority call (the approval is recorded with
 * the real transitions, as the execution path does after a stubbed answer).
 * Synthetic data only.
 *
 * Run: npx tsx lib/services/billing/billing-pdf-allocation-number.rls.integration.test.ts
 * (needs `npx playwright install chromium` once)
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BillingAuthoritySubmissionStatus,
  BillingDocumentStatus,
  BillingDocumentType,
  BillingPdfRenderStatus,
  PrismaClient,
} from "@prisma/client";
import { PDFParse } from "pdf-parse";

const prisma = new PrismaClient();

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`  [PASS] ${name}`);
  } else {
    failures.push(name);
    console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`);
  }
}
const uniq = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

const storageRoot = mkdtempSync(join(tmpdir(), "pdf-allocation-test-"));
process.env.STORAGE_PROVIDER = "local";
process.env.LOCAL_STORAGE_ROOT = storageRoot;
process.env.BILLING_PDF_STORAGE_ROOT = storageRoot;
process.env.BILLING_PDF_RENDERER = "html";
globalThis.fetch = (async () => {
  throw new Error("network disabled in this test");
}) as typeof fetch;

async function replayRepositoryRls(adminUrl: string): Promise<number> {
  const admin = new PrismaClient({ datasourceUrl: adminUrl });
  let applied = 0;
  try {
    for (const r of ["app_admin", "app_auth", "app_ctlplane", "app_runtime"]) {
      await admin.$executeRawUnsafe(
        `DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${r}') THEN
           CREATE ROLE ${r} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION;
         END IF; END $do$`
      );
    }
    for (const d of readdirSync("prisma/migrations").filter((x) => /^\d/.test(x)).sort()) {
      let sql: string;
      try {
        sql = readFileSync(`prisma/migrations/${d}/migration.sql`, "utf8");
      } catch {
        continue;
      }
      for (const st of sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n")
        .split(";").map((x) => x.trim()).filter(Boolean)) {
        if (!/ROW LEVEL SECURITY|CREATE POLICY|DROP POLICY|CREATE ROLE|DO \$\$/i.test(st)) continue;
        try {
          await admin.$executeRawUnsafe(st);
          applied++;
        } catch {
          /* already present */
        }
      }
    }
  } finally {
    await admin.$disconnect();
  }
  return applied;
}

async function pdfText(pdf: Buffer): Promise<string> {
  const parser = new PDFParse({ data: pdf });
  try {
    const t = await parser.getText();
    return t.text.replace(/\s+/g, "");
  } finally {
    await parser.destroy();
  }
}

const FULL_CONFIRMATION = "202611050000000123456789"; // stored as received
const SHOWN = "123456789"; // the 9 right-most digits printed on the invoice

const SNAPSHOT = {
  schemaVersion: 1, issuedAt: "2026-11-05T10:00:00.000Z",
  document: { id: 42, type: "TAX_INVOICE", status: "ISSUED", number: 7, numberFormatted: "000007", currency: "ILS", allocationNumber: null, referenceDocumentId: null },
  issuer: { id: 3, name: "Synthetic Ltd", legalName: "Synthetic Ltd", taxId: "515000123", vatRegistration: "515000123", address: "1 Synthetic St", phone: "0500000000", email: "a@example.test", logoUrl: null, bankDetails: null },
  customer: { id: 7, name: "Synthetic Customer", legalName: null, taxId: "515000131", phone: null, email: null, city: null, address: null },
  lines: [{ lineIndex: 0, description: "Synthetic service", quantity: "1.0000", unitPrice: "6000.0000", vatRatePercent: "18.00", lineSubtotal: "6000.00", vatAmount: "1080.00", lineTotal: "7080.00" }],
  totals: { subtotal: "6000.00", vat: "1080.00", total: "7080.00" },
  tax: { currency: "ILS", defaultVatRate: null, vatMode: "EXCLUSIVE" },
  metadata: { locale: "he-IL", timezone: "Asia/Jerusalem", actorUserId: 1, source: "manual" },
  pdfTemplateStyle: "CLASSIC", extensions: {},
};

async function main() {
  const adminUrl = process.env.RLS_ADMIN_URL;
  if (!adminUrl) {
    console.log("  [FAIL] RLS_ADMIN_URL is not set");
    process.exit(1);
  }
  const { getTenantContext } = await import("@/lib/tenant/context");
  const { tenantTx } = await import("@/lib/tenant/tenant-tx");
  const { getOrRenderBillingPdf } = await import("@/lib/services/billing/billing-pdf.service");
  const { recordAuthoritySubmissionAttemptTx, recordAuthorityApprovedTx } = await import(
    "@/lib/services/billing/authority/billing-authority-transition.service"
  );
  const { AUTHORITY_NOT_DELIVERABLE_CODE } = await import("@/lib/services/billing/authority/billing-authority-delivery.rules");

  const [who] = (await prisma.$queryRawUnsafe(
    `SELECT current_user::text AS who, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
  )) as Array<{ who: string; rolsuper: boolean; rolbypassrls: boolean }>;
  console.log(`  connected as: ${who?.who} (superuser=${who?.rolsuper}, bypassrls=${who?.rolbypassrls})`);
  if (!who || who.rolsuper || who.rolbypassrls) {
    console.log("  [FAIL] this role bypasses RLS — nothing below would prove anything");
    process.exit(1);
  }
  const applied = await replayRepositoryRls(adminUrl);
  ok(`replayed ${applied} RLS/role statements from the repository`, applied > 50);
  ok("no ambient tenant context", getTenantContext() === undefined);

  const owner = new PrismaClient({ datasourceUrl: adminUrl });
  async function tenant(label: string) {
    const business = await owner.business.create({ data: { name: `pdf-alloc-${label}-${uniq()}` } });
    const user = await owner.user.create({
      data: { email: `pdf-alloc-${label}-${uniq()}@example.test`, password: "x", businessId: business.id, role: "USER" },
    });
    return { businessId: business.id, userId: user.id };
  }
  const a = await tenant("a");
  const b = await tenant("b");

  /** An ISSUED tax invoice requiring an allocation (READY), snapshot frozen with allocationNumber null. */
  const docId = await tenantTx(a.businessId, async (tx) => {
    const doc = await tx.billingDocument.create({
      data: {
        businessId: a.businessId, documentType: BillingDocumentType.TAX_INVOICE, status: BillingDocumentStatus.ISSUED,
        customerNameSnapshot: "Synthetic Customer", currency: "ILS", subtotalAmount: "6000.00", vatAmount: "1080.00", totalAmount: "7080.00",
        documentNumber: 7, documentNumberFormatted: "000007", issuedAt: new Date(), lockedAt: new Date(),
        legalSnapshotHash: "synthetic-hash", issuedSnapshot: SNAPSHOT as never, pdfRenderStatus: BillingPdfRenderStatus.PENDING,
      },
      select: { id: true },
    });
    await tx.billingAuthoritySubmission.create({
      data: { businessId: a.businessId, billingDocumentId: doc.id, status: BillingAuthoritySubmissionStatus.READY, legalSnapshotHash: "synthetic-hash" },
    });
    return doc.id;
  });
  const pdf = (t: { businessId: number; userId: number }) =>
    getOrRenderBillingPdf({ businessId: t.businessId, billingDocumentId: docId, actorUserId: t.userId });

  // ------------------------------------------- before the number exists (D) ---
  let blocked = "";
  try {
    await pdf(a);
    blocked = "RENDERED";
  } catch (error) {
    blocked = (error as { code?: string }).code ?? (error as Error).message;
  }
  ok("D1 before the allocation number exists, the final PDF is not delivered", blocked === AUTHORITY_NOT_DELIVERABLE_CODE, blocked);

  // ---------------------------- the number arrives (real transitions) ---
  await tenantTx(a.businessId, (tx) => recordAuthoritySubmissionAttemptTx(tx, { businessId: a.businessId, billingDocumentId: docId, actorUserId: a.userId }));
  await tenantTx(a.businessId, (tx) =>
    recordAuthorityApprovedTx(tx, { businessId: a.businessId, billingDocumentId: docId, allocationNumber: FULL_CONFIRMATION, approvedAt: new Date(), actorUserId: a.userId })
  );
  const stored = await tenantTx(a.businessId, (tx) =>
    tx.billingDocument.findUnique({ where: { id: docId }, select: { allocationNumber: true, pdfRenderStatus: true, issuedSnapshot: true } })
  );
  ok("A1 the full confirmation number is stored on the document; the PDF cache is PENDING",
    stored?.allocationNumber === FULL_CONFIRMATION && stored.pdfRenderStatus === BillingPdfRenderStatus.PENDING, JSON.stringify({ ...stored, issuedSnapshot: undefined }));

  // -------------------------------------------- rendered from storage (P) ---
  const first = await pdf(a);
  const text1 = await pdfText(first.buffer);
  ok("P1 the rendered invoice shows the 9 right-most digits of the stored number", first.renderedNow && text1.includes(SHOWN), `renderedNow=${first.renderedNow} hasShown=${text1.includes(SHOWN)}`);
  ok("P2 it does not print the full stored confirmation number", !text1.includes(FULL_CONFIRMATION));
  const afterRender = await tenantTx(a.businessId, (tx) =>
    tx.billingDocument.findUnique({ where: { id: docId }, select: { pdfRenderStatus: true, issuedSnapshot: true } })
  );
  ok("P3 display only: the frozen snapshot still holds allocationNumber null",
    (afterRender?.issuedSnapshot as { document?: { allocationNumber?: unknown } } | null)?.document?.allocationNumber === null);
  ok("P4 the render was stored (RENDERED)", afterRender?.pdfRenderStatus === BillingPdfRenderStatus.RENDERED, String(afterRender?.pdfRenderStatus));
  const second = await pdf(a);
  ok("P5 a second request is served from storage and still shows the number",
    second.renderedNow === false && (await pdfText(second.buffer)).includes(SHOWN), `renderedNow=${second.renderedNow}`);

  // ------------------------------------------------------- isolation (T) ---
  let cross = "";
  try {
    await pdf(b);
    cross = "SERVED";
  } catch (error) {
    cross = (error as Error).name;
  }
  ok("T1 another tenant cannot get this PDF", cross !== "SERVED", cross);
  ok("T2 no tenant context leaks out", getTenantContext() === undefined);

  await owner.$disconnect();
  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    for (const f of failures) console.log(`  - ${f}`);
    console.log("PDF ALLOCATION NUMBER: FAIL");
    process.exit(1);
  }
  console.log("PDF ALLOCATION NUMBER: PASS");
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    rmSync(storageRoot, { recursive: true, force: true });
  });
