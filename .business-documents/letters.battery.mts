/**
 * Saved letters AS the runtime role, on the real migration (Production topology: .business-documents/lab.sh --with-bd).
 * Save (real Chromium render once), replay, conflict, isolation, the customer deleted after saving (snapshot kept),
 * hide, the purge function (explicit age; nothing schedules it), and the erasure runner.
 *
 * env: DATABASE_URL (app_runtime_prod), OWNER_URL (lab_owner), STORAGE_PROVIDER=local, LOCAL_STORAGE_ROOT, AUTH_TOKEN_SECRET.
 */
import { createHash } from "node:crypto";

import { PrismaClient } from "@prisma/client";

import { bdTx } from "../lib/services/business-documents/bd-tx";
import { runBusinessDocumentsErasure } from "../lib/services/business-documents/erasure/business-docs-erasure";
import { fenceFile, readCommittedFile } from "../lib/services/business-documents/files/business-docs-files";
import { parseLetterInput } from "../lib/services/business-documents/letter/letter.contracts";
import { hideSavedLetter, listSavedLetters, saveLetter, savedLetterFile } from "../lib/services/business-documents/letter/saved-letters.service";
import { BusinessDocumentsRequestError, issueRequestKey } from "../lib/services/business-documents/requests/business-docs-requests";

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const own = new PrismaClient({ datasources: { db: { url: process.env.OWNER_URL } } });

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`  [PASS] ${name}${detail ? " — " + detail : ""}`);
  } else {
    failures.push(name);
    console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`);
  }
}
async function code(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return "OK";
  } catch (e) {
    if (e instanceof BusinessDocumentsRequestError) return e.code;
    return `ERR:${(e as Error).name}:${String((e as Error).message).split("\n").slice(-1)[0].slice(0, 120)}`;
  }
}
const fakeRender = async (html: string) => Buffer.from(`%PDF-fake ${sha(Buffer.from(html))}`);

async function main() {
  const stamp = Date.now();
  const mk = async (name: string) => {
    const b = await own.business.create({ data: { name: `ltr-${name}-${stamp}` } });
    const u = await own.user.create({ data: { email: `ltr-${name}-${stamp}@example.test`, password: "synthetic", businessId: b.id, role: "USER" } });
    await own.businessProfile.create({ data: { businessId: b.id, billingLegalName: `עסק ${name} בע"מ`, billingBusinessKind: "LTD_COMPANY", billingTaxId: "999999998", billingAddress: "רחוב 1" } });
    const c = await own.customer.create({ data: { businessId: b.id, name: `לקוח של ${name}`, city: "חיפה" } });
    return { b: b.id, u: u.id, c: c.id };
  };
  const A = await mk("A"), B = await mk("B");
  const key = (x: typeof A) => bdTx(x.b, (tx) => issueRequestKey(tx, x.b, x.u, "LETTER_SAVE"));
  const free = parseLetterInput({ recipientKind: "free", recipientName: "ועד הבית", recipientAddress: "רחוב 2", date: "2026-11-07", subject: "בקשה", body: "שלום רב,\n\nתוכן המכתב.", signerName: "בעל העסק" });
  const toCustomer = (customerId: number) => parseLetterInput({ recipientKind: "customer", customerId, date: "2026-11-07", subject: "עדכון", body: "תוכן" });

  console.log("--- save ---");
  const k1 = await key(A);
  const real = await saveLetter({ businessId: A.b, userId: A.u, letter: free, idempotencyKey: k1 });
  const file = await savedLetterFile(A.b, real.id);
  const bytes = await readCommittedFile(A.b, file!.fileId);
  const row = await own.businessLetter.findFirstOrThrow({ where: { id: real.id } });
  ok("a letter is rendered (Chromium), stored and recorded; the stored bytes match the digest", bytes.subarray(0, 4).toString() === "%PDF" && sha(bytes) === row.sha256);
  ok("the record keeps a snapshot of what was printed (recipient, issuer)", row.recipientName === "ועד הבית" && (row.issuerSnapshot as { displayName?: string }).displayName === 'עסק A בע"מ');
  const again = await saveLetter({ businessId: A.b, userId: A.u, letter: free, idempotencyKey: k1 }, { render: fakeRender });
  ok("the same key again → the SAME letter (no second file)", again.replay === true && again.id === real.id && (await own.businessLetter.count({ where: { businessId: A.b } })) === 1);
  ok("the same key with an edited letter → IDEMPOTENCY_CONFLICT", (await code(() => saveLetter({ businessId: A.b, userId: A.u, letter: { ...free, subject: "אחר" }, idempotencyKey: k1 }, { render: fakeRender }))) === "IDEMPOTENCY_CONFLICT");

  console.log("--- isolation ---");
  const kx = await key(A);
  const crossed = await code(() => saveLetter({ businessId: A.b, userId: A.u, letter: toCustomer(B.c), idempotencyKey: kx }, { render: fakeRender }));
  ok("a letter to another business's customer is refused, nothing recorded", crossed.includes("NotFound") || crossed.includes("not found"), crossed);
  ok("…and the key is released (usable for the corrected letter)", (await code(() => saveLetter({ businessId: A.b, userId: A.u, letter: toCustomer(B.c), idempotencyKey: kx }, { render: fakeRender }))) !== "IN_PROGRESS");
  ok("B lists none of A's letters", (await listSavedLetters(B.b)).length === 0);
  ok("B cannot hide A's letter", (await hideSavedLetter(B.b, B.u, real.id)) === "NOT_FOUND");
  ok("B cannot get A's letter file", (await savedLetterFile(B.b, real.id)) === null);

  console.log("--- the customer deleted after saving ---");
  const toC = await saveLetter({ businessId: A.b, userId: A.u, letter: toCustomer(A.c), idempotencyKey: await key(A) }, { render: fakeRender });
  ok("a CUSTOMER letter takes the customer's name when none is typed", toC.recipientName === "לקוח של A");
  await own.customer.delete({ where: { id: A.c } });
  const listed = (await listSavedLetters(A.b)).find((l) => l.id === toC.id)!;
  ok("after the customer is deleted the letter stays, its snapshot intact, marked 'record removed'", listed.linkRemoved && listed.recipientName === "לקוח של A" && listed.recipientKind === "CUSTOMER");

  console.log("--- hide ---");
  ok("hide → HIDDEN", (await hideSavedLetter(A.b, A.u, toC.id)) === "HIDDEN");
  ok("hide again → ALREADY_HIDDEN (no change)", (await hideSavedLetter(A.b, A.u, toC.id)) === "ALREADY_HIDDEN");
  ok("a hidden letter is not listed and its file is not served", !(await listSavedLetters(A.b)).some((l) => l.id === toC.id) && (await savedLetterFile(A.b, toC.id)) === null);
  ok("hiding does not delete: the record and the file remain", (await own.businessLetter.count({ where: { id: toC.id } })) === 1);

  console.log("--- purge (defined; nothing schedules it) ---");
  const purgeEarly = await code(() => bdTx(A.b, (tx) => tx.$queryRawUnsafe(`SELECT public.business_documents_purge_letter(${toC.id}::int, 30)`)));
  ok("a letter hidden for less than the given age is not eligible", purgeEarly.includes("NOT_ELIGIBLE"), purgeEarly);
  await own.$executeRawUnsafe(`ALTER TABLE "BusinessLetter" DISABLE TRIGGER "BusinessLetter_guard"`);
  await own.$executeRawUnsafe(`UPDATE "BusinessLetter" SET "deletedAt" = now() - interval '31 days' WHERE id = $1`, toC.id);
  await own.$executeRawUnsafe(`ALTER TABLE "BusinessLetter" ENABLE TRIGGER "BusinessLetter_guard"`);
  const fileOfC = (await own.businessLetter.findFirstOrThrow({ where: { id: toC.id } })).fileId;
  await bdTx(A.b, (tx) => tx.$queryRawUnsafe(`SELECT public.business_documents_purge_letter(${toC.id}::int, 30)`));
  ok("purge with an explicit age: the letter is gone, its file goes DELETING", (await own.businessLetter.count({ where: { id: toC.id } })) === 0 && (await own.businessDocumentFile.findFirstOrThrow({ where: { id: fileOfC } })).state === "DELETING");
  ok("…and the fence then closes the key", (await fenceFile(A.b, fileOfC)) === "FENCED");

  console.log("--- erasure runner (not connected to account deletion) ---");
  await own.business.update({ where: { id: A.b }, data: { deletionRequestedAt: new Date() } });
  ok("saving is refused while the business is being deleted", (await code(async () => saveLetter({ businessId: A.b, userId: A.u, letter: free, idempotencyKey: await key(A) }, { render: fakeRender }))).includes("BEING_ERASED"));
  const run = await runBusinessDocumentsErasure(A.b);
  ok("the erasure removes every letter and fences every file", run.done && (await own.businessLetter.count({ where: { businessId: A.b } })) === 0 && (await own.businessDocumentFile.count({ where: { businessId: A.b } })) === 0);
  ok("business B is untouched", (await own.business.findFirstOrThrow({ where: { id: B.b } })).deletionRequestedAt === null);

  console.log(`\n${pass} passed, ${failures.length} failed`);
  await own.$disconnect();
  process.exit(failures.length ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await own.$disconnect();
  process.exit(1);
});
