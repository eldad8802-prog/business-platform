/**
 * Document ↔ supplier link service — on a real PostgreSQL with migration 20261103090000 applied, through the
 * application's own tenant transactions, as the RUNTIME role (NOSUPERUSER NOBYPASSRLS, FORCE RLS).
 *
 *   1. suggestions: same valid tax id = STRONG, same name only = WEAK, inactive flagged, the business's own
 *      name never suggested, an income document gets none, a dismissed supplier never comes back;
 *   2. isolation: another business's document or supplier is "not found" from every entry point;
 *   3. link / relink / unlink keep the supplier file in step (the document shows under exactly one supplier);
 *   4. a stale version is refused; an accepted suggestion must still be suggested, for that reason;
 *   5. idempotency: a repeated key replays, the same key on another document is refused;
 *   6. concurrency: ten simultaneous first links — exactly one wins, one trail row;
 *   7. reprocessing rewrites the reading and leaves the decision alone; the approval's update shape leaves the
 *      reading alone.
 *
 * env: DATABASE_URL = the runtime role on a lab database (e.g. .dsl/lab.sh … --with-dsl), OWNER_URL = the
 * migration role (seeding only). Synthetic data only. ZERO network.
 *
 * Run: DATABASE_URL=… OWNER_URL=… npx tsx lib/services/documents/supplier-link/supplier-link.db.test.ts
 */
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";

import { authoritativeTaxId } from "@/lib/identity/tax-id";
import { runWithTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction } from "@/lib/tenant/transaction";
import {
  DocumentSupplierLinkError,
  dismissSuggestion,
  getDocumentSupplierLinkState,
  linkDocumentToSupplier,
  listSupplierDocuments,
  unlinkDocument,
} from "./supplier-link.service";

const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });

let passed = 0;
async function check(label: string, fn: () => Promise<void>) {
  await fn();
  passed += 1;
  console.log(`OK: ${label}`);
}
async function rejects(p: Promise<unknown>, code: DocumentSupplierLinkError["code"]) {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof DocumentSupplierLinkError, `expected ${code}, got ${String(e)}`);
    assert.equal(e.code, code);
    return;
  }
  assert.fail(`expected ${code}, it succeeded`);
}
function validId(eight: string): string {
  for (let d = 0; d <= 9; d += 1) {
    const v = authoritativeTaxId(`${eight}${d}`);
    if (v) return v;
  }
  throw new Error("no check digit");
}
const key = () => `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
const one = async (sql: string, ...args: unknown[]) =>
  Number(((await owner.$queryRawUnsafe(sql, ...args)) as { n: number }[])[0].n);

const ALPHA_ID = validId("51234567");
const OWN_ID = validId("51600000");

async function seed(tag: string) {
  const run = `${tag}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const b = await one(`INSERT INTO "Business" ("name", "updatedAt") VALUES ($1, now()) RETURNING "id" AS n`, `נגריית הדוגמה ${tag}`);
  await owner.$executeRawUnsafe(
    `INSERT INTO "BusinessProfile" ("businessId", "billingLegalName", "billingTaxId", "updatedAt") VALUES ($1, $2, $3, now())`,
    b, `נגריית הדוגמה ${tag} בע"מ`, OWN_ID
  );
  const u = await one(
    `INSERT INTO "User" ("email", "password", "businessId", "name", "updatedAt") VALUES ($1, 'x', $2, 'DSL', now()) RETURNING "id" AS n`,
    `dsl-svc-${run}@example.test`, b
  );
  const sup = async (name: string, taxId: string | null, active = true) =>
    one(`INSERT INTO "Supplier" ("businessId", "name", "taxId", "isActive", "updatedAt") VALUES ($1, $2, $3, $4, now()) RETURNING "id" AS n`, b, name, taxId, active);
  const alphaByTax = await sup("אלפא ציוד", `${ALPHA_ID.slice(0, 2)}-${ALPHA_ID.slice(2, 8)}-${ALPHA_ID.slice(8)}`);
  const alphaByName = await sup('אלפא ציוד משרדי בע"מ', null, false);
  const beta = await sup("בטא שירותי דפוס", null);
  const doc = async (i: number, extracted: Record<string, unknown> | null) => {
    const d = await one(
      `INSERT INTO "Document" ("businessId", "fileUrl", "source", "mimeType", "status", "originalFilename") VALUES ($1, $2, 'file', 'application/pdf', 'needs_review', $3) RETURNING "id" AS n`,
      b, `dsl-svc/${run}/${i}.pdf`, `חשבונית ${i}.pdf`
    );
    if (extracted) {
      await owner.$executeRawUnsafe(
        `INSERT INTO "ExtractedData" ("documentId", "vendorName", "direction", "issuerTaxId", "issuerTaxIdSource", "issuerTaxIdValid", "issuerCheck", "ownBusinessExcluded") VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        d, extracted.vendorName ?? null, extracted.direction ?? "expense", extracted.issuerTaxId ?? null,
        extracted.issuerTaxId ? "HEADER" : null, extracted.issuerTaxId ? true : null, extracted.issuerCheck ?? null,
        extracted.ownBusinessExcluded ?? false
      );
    }
    return d;
  };
  const docs = {
    alpha: await doc(1, { vendorName: "אלפא ציוד משרדי", issuerTaxId: ALPHA_ID, issuerCheck: "OK", ownBusinessExcluded: true }),
    ownName: await doc(2, { vendorName: `נגריית הדוגמה ${tag} בע"מ`, issuerCheck: "OWN_BUSINESS_ONLY" }),
    income: await doc(3, { vendorName: "אלפא ציוד משרדי", direction: "income", issuerCheck: "NO_TAX_ID" }),
    plain: await doc(4, null),
    race: await doc(5, null),
    idem: await doc(6, null),
  };
  return { b, u, alphaByTax, alphaByName, beta, docs };
}

async function main() {
  const A = await seed("A");
  const B = await seed("B");
  const linkA = (documentId: number, supplierId: number, expectedVersion: number, extra: Partial<Parameters<typeof linkDocumentToSupplier>[0]> = {}) =>
    linkDocumentToSupplier({ businessId: A.b, userId: A.u, documentId, supplierId, method: "MANUAL_PICK", expectedVersion, idempotencyKey: key(), ...extra });
  const events = (documentId: number) =>
    one(`SELECT count(*)::int AS n FROM "DocumentSupplierLinkEvent" WHERE "documentId" = $1`, documentId);

  await check("suggestions: same valid tax id = STRONG first; same name only = WEAK; inactive flagged", async () => {
    const s = await getDocumentSupplierLinkState(A.b, A.docs.alpha);
    assert.equal(s.version, 0);
    assert.equal(s.link, null);
    assert.deepEqual(s.suggestions.map((x) => [x.supplierId, x.reason, x.strength, x.isActive]), [
      [A.alphaByTax, "TAX_ID", "STRONG", true],
      [A.alphaByName, "NAME", "WEAK", false],
    ]);
    assert.equal(s.reading?.ownBusinessExcluded, true);
    assert.equal(s.reading?.vendorIdentified, true, "a distinctive supplier name is presented as identified");
  });

  await check("the business's own name is never suggested (a reading from before the guard)", async () => {
    const s = await getDocumentSupplierLinkState(A.b, A.docs.ownName);
    assert.equal(s.suggestions.length, 0);
    assert.ok(s.notes.includes("OWN_BUSINESS_NAME"));
    assert.equal(s.reading?.vendorIdentified, false, "the business itself is never presented as the identified supplier");
  });

  await check("an income document gets no supplier suggestion; no reading ⇒ none either", async () => {
    const inc = await getDocumentSupplierLinkState(A.b, A.docs.income);
    assert.equal(inc.suggestions.length, 0);
    assert.deepEqual(inc.notes, ["INCOME_DOCUMENT"]);
    const none = await getDocumentSupplierLinkState(A.b, A.docs.plain);
    assert.deepEqual(none.notes, ["NO_READING"]);
  });

  await check("isolation: another business's document / supplier is not found from every entry point", async () => {
    await rejects(getDocumentSupplierLinkState(B.b, A.docs.alpha), "DOCUMENT_NOT_FOUND");
    await rejects(linkA(A.docs.alpha, B.beta, 0), "SUPPLIER_NOT_FOUND");
    await rejects(
      linkDocumentToSupplier({ businessId: B.b, userId: B.u, documentId: A.docs.alpha, supplierId: B.beta, method: "MANUAL_PICK", expectedVersion: 0 }),
      "DOCUMENT_NOT_FOUND"
    );
    await rejects(listSupplierDocuments({ businessId: A.b, supplierId: B.beta }), "SUPPLIER_NOT_FOUND");
    await rejects(dismissSuggestion({ businessId: A.b, userId: A.u, documentId: A.docs.alpha, supplierId: B.beta }), "SUPPLIER_NOT_FOUND");
    assert.equal(await events(A.docs.alpha), 0, "nothing was written");
  });

  await check("an accepted suggestion must still be suggested, for that reason", async () => {
    await rejects(
      linkA(A.docs.alpha, A.beta, 0, { method: "SUGGESTION_ACCEPTED", suggestionReason: "TAX_ID" }),
      "SUGGESTION_STALE"
    );
    await rejects(
      linkA(A.docs.alpha, A.alphaByName, 0, { method: "SUGGESTION_ACCEPTED", suggestionReason: "TAX_ID" }),
      "SUGGESTION_STALE"
    );
  });

  await check("link → the document shows in exactly that supplier's file; a stale version is refused", async () => {
    const s = await linkA(A.docs.alpha, A.alphaByTax, 0, { method: "SUGGESTION_ACCEPTED", suggestionReason: "TAX_ID" });
    assert.equal(s.version, 1);
    assert.equal(s.link?.supplierId, A.alphaByTax);
    assert.equal(s.link?.method, "SUGGESTION_ACCEPTED");
    assert.ok(!s.suggestions.some((x) => x.supplierId === A.alphaByTax), "the linked supplier is not re-suggested");
    const file = await listSupplierDocuments({ businessId: A.b, supplierId: A.alphaByTax });
    assert.deepEqual(file.rows.map((r) => r.documentId), [A.docs.alpha]);
    assert.equal(file.total, 1);
    assert.equal(file.rows[0].approved, null, "no amount without an approved record");
    await rejects(linkA(A.docs.alpha, A.beta, 0), "STALE_VERSION");
  });

  await check("relink: moves to the other supplier's file; unlink: in no file; the trail has all three", async () => {
    const r = await linkA(A.docs.alpha, A.beta, 1);
    assert.equal(r.version, 2);
    assert.equal((await listSupplierDocuments({ businessId: A.b, supplierId: A.alphaByTax })).total, 0);
    assert.equal((await listSupplierDocuments({ businessId: A.b, supplierId: A.beta })).total, 1);
    const u = await unlinkDocument({ businessId: A.b, userId: A.u, documentId: A.docs.alpha, expectedVersion: 2, idempotencyKey: key() });
    assert.equal(u.link, null);
    assert.equal(u.version, 3);
    assert.equal((await listSupplierDocuments({ businessId: A.b, supplierId: A.beta })).total, 0);
    const actions = (await owner.$queryRawUnsafe(
      `SELECT "action", "supplierId", "previousSupplierId" FROM "DocumentSupplierLinkEvent" WHERE "documentId" = $1 ORDER BY "id"`,
      A.docs.alpha
    )) as { action: string; supplierId: number | null; previousSupplierId: number | null }[];
    assert.deepEqual(actions.map((a) => [a.action, a.supplierId, a.previousSupplierId]), [
      ["LINKED", A.alphaByTax, null],
      ["RELINKED", A.beta, A.alphaByTax],
      ["UNLINKED", null, A.beta],
    ]);
    await rejects(unlinkDocument({ businessId: A.b, userId: A.u, documentId: A.docs.alpha, expectedVersion: 3 }), "NOT_LINKED");
    const again = await linkA(A.docs.alpha, A.alphaByTax, 3);
    assert.equal(again.version, 4);
  });

  await check("dismiss: the supplier is never suggested again for this document; twice = one trail row", async () => {
    await unlinkDocument({ businessId: A.b, userId: A.u, documentId: A.docs.alpha, expectedVersion: 4 });
    const before = await events(A.docs.alpha);
    await dismissSuggestion({ businessId: A.b, userId: A.u, documentId: A.docs.alpha, supplierId: A.alphaByName });
    const s = await dismissSuggestion({ businessId: A.b, userId: A.u, documentId: A.docs.alpha, supplierId: A.alphaByName });
    assert.ok(!s.suggestions.some((x) => x.supplierId === A.alphaByName));
    assert.ok(s.suggestions.some((x) => x.supplierId === A.alphaByTax));
    assert.equal(await events(A.docs.alpha), before + 1);
  });

  await check("idempotency: a repeated key replays without a second row; the same key on another document is refused", async () => {
    const k = key();
    const first = await linkA(A.docs.idem, A.beta, 0, { idempotencyKey: k });
    const replay = await linkA(A.docs.idem, A.beta, 0, { idempotencyKey: k });
    assert.equal(replay.replayed, true);
    assert.equal(replay.version, first.version);
    assert.equal(await events(A.docs.idem), 1);
    await rejects(linkA(A.docs.plain, A.beta, 0, { idempotencyKey: k }), "IDEMPOTENCY_KEY_REUSED");
  });

  await check("concurrency: ten simultaneous first links — exactly one wins, one trail row", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) => linkA(A.docs.race, i % 2 ? A.beta : A.alphaByTax, 0))
    );
    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    assert.equal(won.length, 1, `winners: ${won.length}`);
    assert.ok(lost.every((r) => r.reason instanceof DocumentSupplierLinkError && r.reason.code === "STALE_VERSION"));
    assert.equal(await events(A.docs.race), 1);
    assert.equal(
      await one(`SELECT count(*)::int AS n FROM "DocumentSupplierLink" WHERE "documentId" = $1`, A.docs.race),
      1
    );
  });

  await check("concurrency with ONE key (a double-click): every call returns the same state, one trail row", async () => {
    const k = key();
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => linkA(A.docs.plain, A.beta, 0, { idempotencyKey: k })));
    assert.ok(results.every((r) => r.status === "fulfilled"), JSON.stringify(results.map((r) => r.status)));
    assert.equal(await events(A.docs.plain), 1);
  });

  await check("reprocessing rewrites the reading and leaves the decision; the approval's update leaves the reading", async () => {
    const before = await getDocumentSupplierLinkState(A.b, A.docs.race);
    await runWithTenantContext({ businessId: A.b }, () =>
      withTenantTransaction(async (tx) => {
        // The pipeline's upsert shape (process-document-pipeline): extracted fields + the issuer columns.
        await tx.extractedData.upsert({
          where: { documentId: A.docs.race },
          create: { documentId: A.docs.race, vendorName: "בטא שירותי דפוס", issuerCheck: "NO_TAX_ID", ownBusinessExcluded: false },
          update: { vendorName: "בטא שירותי דפוס", issuerCheck: "NO_TAX_ID", ownBusinessExcluded: false },
        });
        // The approval's update shape (app/api/documents/[id]/approve): it never names the issuer columns.
        await tx.extractedData.update({
          where: { documentId: A.docs.race },
          data: { amount: 117, vendorName: "בטא", category: "general", direction: "expense" },
        });
      })
    );
    const after = await getDocumentSupplierLinkState(A.b, A.docs.race);
    assert.deepEqual(after.link, before.link);
    assert.equal(after.version, before.version);
    assert.equal(after.reading?.issuerCheck, "NO_TAX_ID");
  });

  console.log(`\nsupplier link service: ${passed} passed ✔`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await owner.$disconnect();
    const { prisma } = await import("@/lib/prisma");
    await prisma.$disconnect();
  });
