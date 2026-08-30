/**
 * Business Memory IMPL-2 · ExtractionSnapshot → Engine-Belief Evidence MAPPER + context reader.
 *
 * A DELIBERATELY SEPARATE API from the owner-decision path (IMPL-2 §13). `ExtractionSnapshot` is the
 * engine's belief at extraction time — NON-AUTHORITATIVE. It is exposed only as context/explanation;
 * it can never enter the owner-decision evidence list, and the type system enforces that (its
 * `authority` is `"engine-belief"`, a different type from OwnerDecisionEvidence).
 *
 * THE SINGLE PLACE that knows `ExtractionSnapshot` physically. Pure mapper + injectable-source reader
 * (default binds Prisma), same pattern as the owner-decision reader. INERT: no product consumer.
 */
import { prisma } from "@/lib/prisma";
import { getTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction } from "@/lib/tenant/transaction";

// D2/P7-W4D: ctx-aware short tenant tx per DB step (no global fallback under
// an established context; direct reads only for context-less unit tests).
async function dbStep<T>(fn: (db: typeof prisma) => Promise<T>): Promise<T> {
  if (getTenantContext() !== undefined) {
    return withTenantTransaction((tx) => fn(tx as unknown as typeof prisma));
  }
  return fn(prisma);
}
import type { EngineBeliefEvidence, EngineBeliefEvidenceReader, EvidenceRef } from "./evidence-contract";

/** Minimal structural shape of an `ExtractionSnapshot` row (engine belief — raw, un-normalized). */
export interface ExtractionSnapshotRow {
  id: number;
  businessId: number;
  occurredAt: Date | string;
  vendorName: string | null;
  category: string | null;
  direction: string | null;
}

function toIso(occurredAt: Date | string): string {
  return occurredAt instanceof Date ? occurredAt.toISOString() : new Date(occurredAt).toISOString();
}

/** Map one ExtractionSnapshot row to a NON-AUTHORITATIVE engine-belief evidence item. */
export function mapExtractionSnapshot(row: ExtractionSnapshotRow): EngineBeliefEvidence {
  const ref: EvidenceRef = { kind: "extraction-snapshot", businessId: row.businessId, recordId: row.id };
  return {
    authority: "engine-belief",
    ref,
    businessId: row.businessId,
    occurredAt: toIso(row.occurredAt),
    ordinal: row.id,
    belief: { vendor: row.vendorName, category: row.category, direction: row.direction },
  };
}

/** Fetches raw ExtractionSnapshot rows for ONE tenant + document. Injectable for DB-free tests. */
export type ExtractionSnapshotRowSource = (
  businessId: number,
  documentId: number,
) => Promise<ExtractionSnapshotRow[]>;

const prismaRowSource: ExtractionSnapshotRowSource = async (businessId, documentId) => {
  const rows = await dbStep((db) => db.extractionSnapshot.findMany({
    where: { businessId, documentId },
    select: { id: true, businessId: true, occurredAt: true, vendorName: true, category: true, direction: true },
  }));
  return rows as ExtractionSnapshotRow[];
};

/** Construct the separate, NON-AUTHORITATIVE engine-belief context reader (IMPL-2 §13). */
export function createExtractionSnapshotBeliefReader(
  rowSource: ExtractionSnapshotRowSource = prismaRowSource,
): EngineBeliefEvidenceReader {
  return {
    async readEngineBeliefContext(businessId, documentId) {
      const rows = await rowSource(businessId, documentId);
      return rows.map(mapExtractionSnapshot);
    },
  };
}
