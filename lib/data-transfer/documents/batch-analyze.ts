/**
 * Batch triage for Documents import. Reads only — nothing here writes.
 *
 * # Why this is triage and not a preview of contents
 *
 * For the tabular domains a preview can show the owner the actual values,
 * because the file is parsed in memory. Documents cannot work that way: OCR and
 * extraction need a persisted `documentId`, so showing the vendor and amount
 * before confirmation would mean creating documents and deleting the rejected
 * ones — writing to the business account during something called "preview".
 *
 * So the owner is shown what is honestly knowable without writing: the file, its
 * type, its size, whether Dubiz already has it, and what will happen if they
 * confirm. The wording has to say so plainly rather than implying the contents
 * were understood.
 *
 * # Duplicates reuse the existing engine
 *
 * The rule is the one the upload screen already applies: same business, same
 * SHA-256 of the bytes, ignoring documents whose processing failed. No second
 * duplicate engine, no fuzzy matching on vendor or amount.
 */

import { runWithTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction } from "@/lib/tenant/transaction";
import { createHash } from "node:crypto";
import {
  DOCUMENT_MAX_UPLOAD_BYTES,
  isAllowedDocumentMime,
  isHeicMimeType,
} from "@/lib/services/documents/document-ingestion.service";
import { verifyFileSignature } from "@/lib/services/documents/file-signature";

/**
 * What the owner will be asked to confirm for one file.
 *
 * # Why "create anyway" is its own word rather than a CREATE on a duplicate
 *
 * I-7B had two words, and CREATE meant either "take this new file" or "take it
 * even though you already have it", depending on what the analysis had said at
 * the time. Execution cannot rely on that, because the analysis is re-derived
 * at execute time and can legitimately have changed: a file that was new when
 * the owner looked may exist by the time they confirm.
 *
 * With two words, execute would have to ask "is this a duplicate NOW?" to
 * decide what the owner meant — and would then read a CREATE on a
 * newly-appeared duplicate as an override the owner never gave. That is exactly
 * the silent re-decision the drift rule forbids.
 *
 * With three, the owner's intent is carried in the decision itself, is covered
 * by the signed decisions digest, and execute never has to infer it:
 *
 *   CREATE         take this file, which was NOT already held
 *   CREATE_ANYWAY  take it even though Dubiz already holds these exact bytes
 *   SKIP           do not take it
 *
 * The execution ledger still records CREATE_ANYWAY as a CREATE — what the
 * ledger stores is the action performed, and the action performed is a create.
 */
export type DocumentFileAction = "CREATE" | "CREATE_ANYWAY" | "SKIP";

export type DocumentFileStatus =
  /** Accepted and not already held. Defaults to CREATE. */
  | "NEW"
  /** Dubiz already holds a file with these exact bytes. Defaults to SKIP. */
  | "DUPLICATE"
  /** The same bytes appear earlier in this very batch. Defaults to SKIP. */
  | "IN_FILE_DUPLICATE"
  /** Refused: type, size, or contents that do not match the declared type. */
  | "UNSUPPORTED";

export type AnalyzedFile = {
  /** Position in the batch as submitted. How decisions are addressed. */
  index: number;
  /** The owner's filename, for display only. Never used for storage. */
  filename: string;
  sizeBytes: number;
  /** The accepted type, normalised. */
  mimeType: string;
  status: DocumentFileStatus;
  action: DocumentFileAction;
  /** Owner-facing explanation in Hebrew. Empty when there is nothing to say. */
  reason: string;
  /** True when the owner may deliberately override SKIP into CREATE_ANYWAY. */
  overridable: boolean;
};

export type AnalyzedBatch = {
  files: AnalyzedFile[];
  /** Per-file content hashes in batch order. The batch's identity. */
  contentHashes: string[];
  summary: {
    total: number;
    willCreate: number;
    willSkip: number;
    unsupported: number;
    duplicates: number;
    inFileDuplicates: number;
    totalBytes: number;
  };
};

export type IncomingFile = {
  filename: string;
  mimeType: string;
  buffer: Buffer;
};

function sha256Hex(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

/**
 * Which of these hashes does the business already hold?
 *
 * One query for the whole batch rather than one per file, and tenant-scoped in
 * the predicate. `failed` documents are excluded for the same reason the upload
 * screen excludes them: a document whose processing failed is not evidence that
 * the owner already has this expense.
 *
 * Only the SET of matching hashes is returned. The document ids stay on the
 * server: the owner is told "Dubiz already has this file", which is the useful
 * fact, without handing an internal identifier to the client.
 */
export async function findExistingHashes(
  businessId: number,
  hashes: readonly string[]
): Promise<Set<string>> {
  if (hashes.length === 0) return new Set();
  const rows = await runWithTenantContext({ businessId }, () =>
    withTenantTransaction((tx) =>
      tx.document.findMany({
        where: {
          businessId,
          contentHashSha256: { in: [...new Set(hashes)] },
          status: { not: "failed" },
        },
        select: { contentHashSha256: true },
      })
    )
  );
  const found = new Set<string>();
  for (const row of rows) {
    if (row.contentHashSha256) found.add(row.contentHashSha256);
  }
  return found;
}

/** A file after per-file checks, before anything about the tenant is known. */
export type StagedFile = Pick<
  AnalyzedFile,
  "index" | "filename" | "sizeBytes" | "mimeType"
> & { status: DocumentFileStatus; reason: string; hash: string };

/**
 * Turn staged files plus "what the business already holds" into final verdicts.
 *
 * Split out from the orchestration on purpose. This is the part that decides
 * what the owner is offered, and it is pure — so it can be tested for real
 * rather than through a hand-built fixture that might drift away from it. That
 * drift is not hypothetical: a planted defect flipping the in-file duplicate to
 * overridable went unnoticed while only the predicate had tests.
 */
export function classifyStagedFiles(
  staged: readonly StagedFile[],
  existingHashes: ReadonlySet<string>
): AnalyzedFile[] {
  // In-file collisions resolve by first occurrence in batch order: the first
  // copy imports, and every later copy says which one won. Skipping all of them
  // would import none, which the owner would rightly call broken.
  const firstSeen = new Map<string, number>();

  return staged.map((f) => {
    if (f.status === "UNSUPPORTED") {
      return { ...f, action: "SKIP" as const, overridable: false };
    }
    if (existingHashes.has(f.hash)) {
      return {
        ...f,
        status: "DUPLICATE" as const,
        action: "SKIP" as const,
        reason: "הקובץ הזה כבר קיים בדוביז.",
        // The upload screen lets the owner upload a duplicate deliberately, so
        // the same choice is offered here rather than silently being stricter.
        overridable: true,
      };
    }
    const winner = firstSeen.get(f.hash);
    if (winner === undefined) {
      firstSeen.set(f.hash, f.index);
      return {
        ...f,
        status: "NEW" as const,
        action: "CREATE" as const,
        overridable: false,
        reason: "",
      };
    }
    return {
      ...f,
      status: "IN_FILE_DUPLICATE" as const,
      action: "SKIP" as const,
      reason: `אותו קובץ נבחר כבר (${winner + 1}). ייקלט פעם אחת בלבד.`,
      // Deliberately NOT overridable: the owner's own selection contradicts
      // itself, and the fix is to choose different files.
      overridable: false,
    };
  });
}

/** Refuse a file, with the reason the owner needs to act on it. */
function reject(reason: string): { status: "UNSUPPORTED"; reason: string } {
  return { status: "UNSUPPORTED", reason };
}

/**
 * The per-file acceptance pass: type, size, contents, hash. PURE.
 *
 * Nothing here touches the database or the tenant, which is what lets Execute
 * re-run the identical checks on the re-uploaded bytes before it writes
 * anything — and lets a test prove Analyze and Execute cannot drift apart,
 * because there is one function and not two.
 *
 * The declared MIME is checked here rather than assumed to be pinned by the
 * batch hash. It is NOT part of the content hash: the same bytes can be
 * re-submitted under a different declared type, so the type must be re-verified
 * against the signature at execute time and not merely at preview.
 *
 * Order of checks mirrors the upload screen: type before size before contents,
 * so the owner gets the most actionable message rather than the first failure.
 */
export function stageDocumentFiles(files: readonly IncomingFile[]): {
  staged: StagedFile[];
  contentHashes: string[];
} {
  const contentHashes: string[] = [];
  const staged: StagedFile[] = [];

  for (const [index, file] of files.entries()) {
    const hash = sha256Hex(file.buffer);
    contentHashes.push(hash);
    const mimeType = String(file.mimeType || "").toLowerCase().trim();
    const base = {
      index,
      filename: file.filename,
      sizeBytes: file.buffer.length,
      mimeType,
      hash,
    };

    if (isHeicMimeType(mimeType)) {
      staged.push({
        ...base,
        ...reject(
          "פורמט HEIC אינו נתמך. צלמו מחדש או המירו את התמונה ל-JPG."
        ),
      });
      continue;
    }
    if (!isAllowedDocumentMime(mimeType)) {
      staged.push({ ...base, ...reject("סוג קובץ שאינו נתמך. נדרש PDF או תמונה.") });
      continue;
    }
    if (file.buffer.length === 0) {
      staged.push({ ...base, ...reject("הקובץ ריק.") });
      continue;
    }
    if (file.buffer.length > DOCUMENT_MAX_UPLOAD_BYTES) {
      staged.push({ ...base, ...reject("הקובץ גדול מדי (עד 15MB).") });
      continue;
    }

    // The declared type is a claim by the browser. Check the bytes agree with
    // it, so a renamed file is caught here and not after it is stored.
    const signature = verifyFileSignature(file.buffer, mimeType);
    if (!signature.ok) {
      staged.push({
        ...base,
        ...reject(
          signature.reason === "MISMATCH"
            ? "תוכן הקובץ אינו תואם לסוג שלו. ייתכן ששם הקובץ שונה."
            : "לא ניתן לזהות את תוכן הקובץ."
        ),
      });
      continue;
    }

    staged.push({ ...base, status: "NEW", reason: "" });
  }

  return { staged, contentHashes };
}

/**
 * Decide each file's fate, without writing anything.
 *
 * Staging (pure) then one tenant-scoped duplicate query then classification.
 */
export async function analyzeDocumentBatch(input: {
  businessId: number;
  files: readonly IncomingFile[];
}): Promise<AnalyzedBatch> {
  const { staged, contentHashes } = stageDocumentFiles(input.files);

  // One tenant-scoped query for every accepted file's hash.
  const acceptedHashes = staged
    .filter((f) => f.status === "NEW")
    .map((f) => f.hash);
  const existing = await findExistingHashes(input.businessId, acceptedHashes);

  const files = classifyStagedFiles(staged, existing);

  return {
    files,
    contentHashes,
    summary: {
      total: files.length,
      willCreate: files.filter((f) => isCreateAction(f.action)).length,
      willSkip: files.filter((f) => f.action === "SKIP").length,
      unsupported: files.filter((f) => f.status === "UNSUPPORTED").length,
      duplicates: files.filter((f) => f.status === "DUPLICATE").length,
      inFileDuplicates: files.filter((f) => f.status === "IN_FILE_DUPLICATE").length,
      totalBytes: files.reduce((sum, f) => sum + f.sizeBytes, 0),
    },
  };
}

/** Both create words. The one predicate anything asking "does this write?" uses. */
export function isCreateAction(action: DocumentFileAction): boolean {
  return action === "CREATE" || action === "CREATE_ANYWAY";
}

/** sourceRowNumber-equivalent keyed decisions: batch index -> action. */
export type DocumentDecisions = Record<number, DocumentFileAction>;

/**
 * Is this decision one the server would actually offer for this file?
 *
 * A signature proves a decision was not altered in transit; it does not prove
 * the decision was ever legitimate. SKIP is always allowed — declining to
 * import is never invalid. CREATE is allowed only where the analysis said so.
 */
export function isDecisionPermitted(
  file: AnalyzedFile,
  action: DocumentFileAction
): boolean {
  // Declining to import is never invalid, whatever the file turned out to be.
  if (action === "SKIP") return true;
  // A plain CREATE asserts the file was not already held. Only a NEW file
  // supports that assertion — a duplicate needs the explicit override word.
  if (action === "CREATE") return file.status === "NEW";
  // CREATE_ANYWAY is the override, and only where an override was offered.
  return file.overridable;
}

/** Server defaults for the whole batch. */
export function defaultDocumentDecisions(
  files: readonly AnalyzedFile[]
): DocumentDecisions {
  const out: DocumentDecisions = {};
  for (const f of files) out[f.index] = f.action;
  return out;
}

/** Canonical, order-independent serialization — same discipline as I-6. */
export function documentDecisionsHash(decisions: DocumentDecisions): string {
  const canonical = Object.keys(decisions)
    .map(Number)
    .filter((n) => Number.isInteger(n))
    .sort((a, b) => a - b)
    .map((n) => `${n}=${decisions[n]}`)
    .join("\n");
  return createHash("sha256").update(canonical).digest("hex");
}
