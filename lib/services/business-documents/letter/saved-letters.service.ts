/**
 * Saved letters — on the business-documents records (migration 20261114090000). SERVER-ONLY.
 *
 * Saving renders the letter exactly like the stateless PDF route, from the parties resolved in ONE read, stores the
 * bytes create-once in the private business-docs domain, and records the letter with a snapshot of what was printed
 * (recipient name and address, the issuer's details) — so a later change or deletion of the customer / supplier never
 * changes what the saved letter says (the link column may become empty; the snapshot stays).
 * Once per server-issued key: a retry returns the first saved letter. A saved letter is never edited; the owner can
 * hide it. Physical removal is a separate function that nothing calls (retention is not approved).
 */
import { getStorageService, type StorageService } from "@/lib/storage";

import { bdTx } from "../bd-tx";
import { abandonPendingFile, commitFile, createPendingFile, sha256Hex, uploadCreateOnce } from "../files/business-docs-files";
import { attachRequestFile, claimRequest, completeRequest, releaseRequest, requestHashOf } from "../requests/business-docs-requests";
import { buildLetterHtml } from "./letter-html";
import type { LetterInput } from "./letter.contracts";
import { fontDataUri, resolveLetterPartiesTx } from "./letter.service";

export type SavedLetterView = {
  id: number;
  recipientKind: "CUSTOMER" | "SUPPLIER" | "FREE";
  recipientName: string;
  linkRemoved: boolean;
  subject: string;
  letterDate: string;
  createdAt: string;
  replay?: boolean;
};

export type SaveLetterDeps = { storage?: StorageService; render?: (html: string) => Promise<Buffer> };

const KIND = { customer: "CUSTOMER", supplier: "SUPPLIER", free: "FREE" } as const;

export async function saveLetter(input: { businessId: number; userId: number; letter: LetterInput; idempotencyKey: string }, deps: SaveLetterDeps = {}): Promise<SavedLetterView> {
  const { businessId, userId, letter, idempotencyKey } = input;
  const storage = deps.storage ?? getStorageService();
  const render = deps.render ?? (async (html: string) => (await import("./letter-pdf.service")).letterHtmlToPdf(html));
  const requestHash = requestHashOf({ op: "LETTER_SAVE", ...letter });

  const claim = await bdTx(businessId, (tx) => claimRequest(tx, businessId, "LETTER_SAVE", idempotencyKey, requestHash));
  if (claim.kind === "REPLAY") {
    const l = await bdTx(businessId, (tx) => tx.businessLetter.findFirstOrThrow({ where: { businessId, id: claim.resultId } }));
    return { ...viewOf(l), replay: true };
  }

  let fileId: number | null = null;
  try {
    const parties = await bdTx(businessId, (tx) => resolveLetterPartiesTx(tx, businessId, letter));
    const bytes = await render(buildLetterHtml({ input: letter, ...parties, fontDataUri: fontDataUri() }));
    if (!bytes || bytes.length === 0) throw new Error("the renderer produced no bytes");

    const pending = await bdTx(businessId, async (tx) => {
      const f = await createPendingFile(tx, businessId, "LETTER", claim.leaseOwner);
      await attachRequestFile(tx, claim.requestId, claim.leaseOwner, f.id);
      return f;
    });
    fileId = pending.id;
    if ((await uploadCreateOnce(businessId, pending.objectKey, bytes, storage)) !== "CREATED") throw new Error("a fresh object key was already taken");

    const saved = await bdTx(businessId, async (tx) => {
      if (!(await commitFile(tx, businessId, pending.id, claim.leaseOwner, bytes))) throw new Error("the upload lease was lost");
      const i = parties.issuer;
      const row = await tx.businessLetter.create({
        data: {
          businessId,
          recipientKind: KIND[letter.recipientKind],
          customerId: letter.recipientKind === "customer" ? letter.customerId : null,
          supplierId: letter.recipientKind === "supplier" ? letter.supplierId : null,
          recipientName: parties.recipient.name.slice(0, 200),
          recipientAddress: (parties.recipient.address ?? "").slice(0, 500),
          issuerSnapshot: { displayName: i.displayName, businessKindLabel: i.businessKindLabel, taxId: i.taxId, address: i.address, phone: i.phone, email: i.email },
          subject: letter.subject,
          body: letter.body,
          reference: letter.reference || null,
          letterDate: new Date(`${letter.date}T00:00:00.000Z`),
          signerName: letter.signerName || null,
          signerTitle: letter.signerTitle || null,
          includeSignatureImage: letter.includeSignatureImage,
          fileId: pending.id,
          sha256: sha256Hex(bytes),
          createdByUserId: userId,
        },
      });
      await completeRequest(tx, claim.requestId, claim.leaseOwner, row.id);
      return row;
    });
    return viewOf(saved);
  } catch (error) {
    await bdTx(businessId, async (tx) => {
      if (fileId !== null) await abandonPendingFile(tx, businessId, fileId);
      await releaseRequest(tx, claim.requestId, claim.leaseOwner);
    }).catch(() => undefined);
    throw error;
  }
}

function viewOf(l: { id: number; recipientKind: string; recipientName: string; customerId: number | null; supplierId: number | null; subject: string; letterDate: Date; createdAt: Date }): SavedLetterView {
  const kind = l.recipientKind as SavedLetterView["recipientKind"];
  return {
    id: l.id,
    recipientKind: kind,
    recipientName: l.recipientName,
    linkRemoved: (kind === "CUSTOMER" && l.customerId === null) || (kind === "SUPPLIER" && l.supplierId === null),
    subject: l.subject,
    letterDate: l.letterDate.toISOString().slice(0, 10),
    createdAt: l.createdAt.toISOString(),
  };
}

/** The business's saved letters that are not hidden, newest first. */
export async function listSavedLetters(businessId: number): Promise<SavedLetterView[]> {
  const rows = await bdTx(businessId, (tx) =>
    tx.businessLetter.findMany({ where: { businessId, deletedAt: null }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 200 })
  );
  return rows.map(viewOf);
}

/** Hide a saved letter (once; hiding it again is a no-op). Its record and file stay until a purge that is not active. */
export async function hideSavedLetter(businessId: number, userId: number, letterId: number): Promise<"HIDDEN" | "ALREADY_HIDDEN" | "NOT_FOUND"> {
  return bdTx(businessId, async (tx) => {
    const l = await tx.businessLetter.findFirst({ where: { businessId, id: letterId }, select: { deletedAt: true } });
    if (!l) return "NOT_FOUND";
    if (l.deletedAt) return "ALREADY_HIDDEN";
    await tx.$executeRaw`UPDATE "BusinessLetter" SET "deletedAt" = CURRENT_TIMESTAMP, "deletedByUserId" = ${userId} WHERE "businessId" = ${businessId} AND "id" = ${letterId} AND "deletedAt" IS NULL`;
    return "HIDDEN";
  });
}

/** The file id of a visible saved letter (hidden letters are not served). */
export async function savedLetterFile(businessId: number, letterId: number): Promise<{ fileId: number; subject: string } | null> {
  return bdTx(businessId, (tx) => tx.businessLetter.findFirst({ where: { businessId, id: letterId, deletedAt: null }, select: { fileId: true, subject: true } }));
}
