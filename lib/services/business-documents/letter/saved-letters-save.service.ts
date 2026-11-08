/**
 * Saving a letter — the only saved-letters module that reaches the serverless browser (the POST letters route is in
 * next.config.ts outputFileTracingIncludes). See saved-letters.service.ts for what a saved letter is. SERVER-ONLY.
 */
import { getStorageService, type StorageService } from "@/lib/storage";

import { bdTx } from "../bd-tx";
import { abandonPendingFile, commitFile, createPendingFile, sha256Hex, uploadCreateOnce } from "../files/business-docs-files";
import { attachRequestFile, claimRequest, completeRequest, releaseRequest, requestHashOf } from "../requests/business-docs-requests";
import { buildLetterHtml } from "./letter-html";
import { letterHtmlToPdf } from "./letter-pdf.service";
import type { LetterInput } from "./letter.contracts";
import { fontDataUri, resolveLetterPartiesTx } from "./letter.service";
import { viewOf, type SavedLetterView } from "./saved-letters.service";

export type SaveLetterDeps = { storage?: StorageService; render?: (html: string) => Promise<Buffer> };

const KIND = { customer: "CUSTOMER", supplier: "SUPPLIER", free: "FREE" } as const;

export async function saveLetter(input: { businessId: number; userId: number; letter: LetterInput; idempotencyKey: string }, deps: SaveLetterDeps = {}): Promise<SavedLetterView> {
  const { businessId, userId, letter, idempotencyKey } = input;
  const storage = deps.storage ?? getStorageService();
  const render = deps.render ?? letterHtmlToPdf;
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

