/**
 * In-memory `ObligationStore` for tests. Mirrors the Prisma store's contract
 * (businessId isolation, string-union mapping already native here) so services
 * can be exercised without a database.
 */

import type {
  CreateObligationRow,
  ListObligationsOptions,
  ObligationPatch,
  ObligationRecord,
  ObligationStore,
  OrientationRecord,
} from "./obligations.types";

export function createInMemoryObligationStore(
  now: () => Date = () => new Date()
): ObligationStore {
  const rows = new Map<number, ObligationRecord>();
  const orientation = new Map<number, OrientationRecord>();
  let nextId = 1;

  return {
    async createObligation(row: CreateObligationRow) {
      const id = nextId++;
      const t = now();
      const record: ObligationRecord = {
        id,
        businessId: row.businessId,
        obligeeName: row.obligeeName,
        amount: row.amount,
        currency: row.currency,
        dueAt: row.dueAt,
        state: row.state,
        source: row.source,
        recurrence: row.recurrence,
        recurrenceSeriesId: row.recurrenceSeriesId,
        note: row.note,
        followUpAt: row.followUpAt,
        settlementAssertedBy: null,
        metAt: null,
        releasedAt: null,
        createdAt: t,
        updatedAt: t,
      };
      rows.set(id, record);
      return { ...record };
    },

    async updateObligation(
      businessId: number,
      id: number,
      patch: ObligationPatch
    ) {
      const current = rows.get(id);
      if (!current || current.businessId !== businessId) {
        throw new Error(
          `BusinessObligation ${id} not found for business ${businessId}`
        );
      }
      const updated: ObligationRecord = {
        ...current,
        ...(patch.obligeeName !== undefined
          ? { obligeeName: patch.obligeeName }
          : {}),
        ...(patch.amount !== undefined ? { amount: patch.amount } : {}),
        ...(patch.currency !== undefined ? { currency: patch.currency } : {}),
        ...(patch.dueAt !== undefined ? { dueAt: patch.dueAt } : {}),
        ...(patch.state !== undefined ? { state: patch.state } : {}),
        ...(patch.recurrence !== undefined
          ? { recurrence: patch.recurrence }
          : {}),
        ...(patch.note !== undefined ? { note: patch.note } : {}),
        ...(patch.followUpAt !== undefined
          ? { followUpAt: patch.followUpAt }
          : {}),
        ...(patch.settlementAssertedBy !== undefined
          ? { settlementAssertedBy: patch.settlementAssertedBy }
          : {}),
        ...(patch.metAt !== undefined ? { metAt: patch.metAt } : {}),
        ...(patch.releasedAt !== undefined
          ? { releasedAt: patch.releasedAt }
          : {}),
        updatedAt: now(),
      };
      rows.set(id, updated);
      return { ...updated };
    },

    async findObligationById(businessId: number, id: number) {
      const row = rows.get(id);
      if (!row || row.businessId !== businessId) return null;
      return { ...row };
    },

    async listObligations(
      businessId: number,
      options?: ListObligationsOptions
    ) {
      let list = [...rows.values()].filter((r) => r.businessId === businessId);
      if (options?.states && options.states.length > 0) {
        const set = new Set(options.states);
        list = list.filter((r) => set.has(r.state));
      }
      list.sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime() || a.id - b.id);
      if (options?.limit != null) list = list.slice(0, options.limit);
      return list.map((r) => ({ ...r }));
    },

    async getOrientation(businessId: number): Promise<OrientationRecord> {
      return (
        orientation.get(businessId) ?? {
          businessId,
          oriented: false,
          orientedAt: null,
        }
      );
    },

    async setOriented(
      businessId: number,
      orientedAt: Date
    ): Promise<OrientationRecord> {
      const record: OrientationRecord = {
        businessId,
        oriented: true,
        orientedAt,
      };
      orientation.set(businessId, record);
      return record;
    },
  };
}
