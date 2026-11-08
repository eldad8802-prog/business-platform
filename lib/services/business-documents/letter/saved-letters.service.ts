/**
 * Saved letters — reading, hiding and serving (no renderer here; saving is saved-letters-save.service.ts, the only
 * module of saved letters that reaches the serverless browser). On the records of migration 20261114090000. SERVER-ONLY.
 *
 * Saving renders the letter exactly like the stateless PDF route, from the parties resolved in ONE read, stores the
 * bytes create-once in the private business-docs domain, and records the letter with a snapshot of what was printed
 * (recipient name and address, the issuer's details) — so a later change or deletion of the customer / supplier never
 * changes what the saved letter says (the link column may become empty; the snapshot stays).
 * Once per server-issued key: a retry returns the first saved letter. A saved letter is never edited; the owner can
 * hide it. Physical removal is a separate function that nothing calls (retention is not approved).
 */
import { bdTx } from "../bd-tx";

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

export function viewOf(l: { id: number; recipientKind: string; recipientName: string; customerId: number | null; supplierId: number | null; subject: string; letterDate: Date; createdAt: Date }): SavedLetterView {
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
