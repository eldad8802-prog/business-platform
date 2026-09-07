/**
 * Batch limits for Documents import, and the one place they are defined.
 *
 * The per-file rules are NOT here. They live in the ingestion service
 * (`DOCUMENT_MAX_UPLOAD_BYTES`, `isAllowedDocumentMime`, `isHeicMimeType`) so
 * that a file the upload screen would refuse cannot be accepted by the import
 * centre. What belongs here is only what a *batch* adds.
 *
 * # Why there are two ceilings and not one
 *
 * A file count alone is not a safety limit. Twenty files at the 15MB per-file
 * ceiling is 300MB, and `formData()` materialises every part in memory before
 * a handler sees it. The count is a usability number; the byte ceiling is the
 * safety number, and it is what makes the count safe to offer.
 *
 * # Where the numbers come from
 *
 * Measured against the production Documents table rather than guessed:
 *
 *   median            47 KB
 *   p95              3.2 MB
 *   largest          3.3 MB
 *   over 5MB              0
 *   over 10MB             0
 *
 * Twenty documents at the p95 size is roughly 64MB, and a realistic batch is
 * far smaller. 60MB therefore sits above what an owner actually selects while
 * capping the worst case at a fifth of the theoretical 300MB. The sample is
 * small (11 documents carry a recorded size), which is exactly why the ceiling
 * is expressed in bytes: it bounds the worst case whatever the distribution
 * turns out to be.
 */

import { createHash } from "node:crypto";

/** Most files the owner may put in one batch. */
export const DOCUMENTS_IMPORT_MAX_FILES = 20;

/** Ceiling on the whole batch, in bytes. The real safety limit. */
export const DOCUMENTS_IMPORT_MAX_BATCH_BYTES = 60 * 1024 * 1024; // 60MB

/**
 * The mapping identity for a domain that has no column mapping.
 *
 * `ImportRun` is unique on (businessId, contentHash, mappingHash, decisionsHash)
 * and every one of those is a hash. Documents have no columns to map, so there
 * is no honest mapping to hash — but leaving the field empty, or writing a bare
 * string like "NONE", would either look like a real mapping or scatter a magic
 * literal through the code.
 *
 * Instead this states the fact in words and hashes it with the same helper the
 * tabular domains use. The value means exactly one thing: *this import domain
 * intentionally has no column-mapping contract*.
 *
 * It is versioned on purpose. Bumping the version changes the execution
 * identity of every Documents batch, which is the correct behaviour if the
 * meaning of "no mapping" ever changes — a later run would not be mistaken for
 * a replay of an earlier one.
 */
export const DOCUMENTS_NO_MAPPING_SENTINEL = "documents:no-mapping:v1";

/**
 * The sentinel in the representation `mappingHash` expects: a SHA-256 hex
 * digest, produced by the same canonical hashing the tabular domains use for
 * their canonicalized mapping.
 */
export function documentsMappingHash(): string {
  return createHash("sha256").update(DOCUMENTS_NO_MAPPING_SENTINEL).digest("hex");
}

/**
 * Canonical identity of a batch: the ordered file content hashes.
 *
 * Order is part of the identity because the owner's decisions are addressed by
 * position. Re-ordering the same files is a different batch to confirm, and
 * treating it as the same one would let a decision meant for one file land on
 * another.
 */
export function documentsBatchContentHash(
  fileContentHashes: readonly string[]
): string {
  return createHash("sha256")
    .update(fileContentHashes.join("\n"))
    .digest("hex");
}
