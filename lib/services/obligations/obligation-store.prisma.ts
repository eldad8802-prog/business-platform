/**
 * Prisma-backed implementation of the `ObligationStore` port.
 *
 * This is the only obligations file that touches Prisma. It maps between the
 * domain string-literal unions and the stored string columns (identical values
 * by construction) and serializes the Decimal amount as a string. Every read
 * and write is scoped by `businessId` for tenant isolation.
 */

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type {
  CreateObligationRow,
  ListObligationsOptions,
  ObligationLifecycleState,
  ObligationPatch,
  ObligationRecord,
  ObligationSource,
  ObligationStore,
  OrientationRecord,
  RecurrenceCadence,
  SettlementAssertedBy,
} from "./obligations.types";

type ObligationDbRow = {
  id: number;
  businessId: number;
  obligeeName: string;
  amount: Prisma.Decimal;
  currency: string;
  dueAt: Date;
  state: string;
  source: string;
  recurrence: string;
  recurrenceSeriesId: string | null;
  note: string | null;
  followUpAt: Date | null;
  settlementAssertedBy: string | null;
  metAt: Date | null;
  releasedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

function toRecord(row: ObligationDbRow): ObligationRecord {
  return {
    id: row.id,
    businessId: row.businessId,
    obligeeName: row.obligeeName,
    amount: row.amount.toString(),
    currency: row.currency,
    dueAt: row.dueAt,
    state: row.state as ObligationLifecycleState,
    source: row.source as ObligationSource,
    recurrence: row.recurrence as RecurrenceCadence,
    recurrenceSeriesId: row.recurrenceSeriesId,
    note: row.note,
    followUpAt: row.followUpAt,
    settlementAssertedBy:
      row.settlementAssertedBy as SettlementAssertedBy | null,
    metAt: row.metAt,
    releasedAt: row.releasedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function createObligationPrismaStore(): ObligationStore {
  return {
    async createObligation(row: CreateObligationRow) {
      const created = await prisma.businessObligation.create({
        data: {
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
        },
      });
      return toRecord(created);
    },

    async updateObligation(
      businessId: number,
      id: number,
      patch: ObligationPatch
    ) {
      // businessId-scoped update: updateMany guarantees we never mutate another
      // tenant's row, then re-read for the mapped record.
      const result = await prisma.businessObligation.updateMany({
        where: { id, businessId },
        data: {
          obligeeName: patch.obligeeName,
          amount: patch.amount,
          currency: patch.currency,
          dueAt: patch.dueAt,
          state: patch.state,
          recurrence: patch.recurrence,
          note: patch.note,
          followUpAt: patch.followUpAt,
          settlementAssertedBy: patch.settlementAssertedBy,
          metAt: patch.metAt,
          releasedAt: patch.releasedAt,
        },
      });
      if (result.count === 0) {
        throw new Error(
          `BusinessObligation ${id} not found for business ${businessId}`
        );
      }
      const row = await prisma.businessObligation.findUnique({ where: { id } });
      return toRecord(row as ObligationDbRow);
    },

    async findObligationById(businessId: number, id: number) {
      const row = await prisma.businessObligation.findFirst({
        where: { id, businessId },
      });
      return row ? toRecord(row) : null;
    },

    async listObligations(
      businessId: number,
      options?: ListObligationsOptions
    ) {
      const rows = await prisma.businessObligation.findMany({
        where: {
          businessId,
          ...(options?.states && options.states.length > 0
            ? { state: { in: options.states } }
            : {}),
        },
        orderBy: [{ dueAt: "asc" }, { id: "asc" }],
        take: options?.limit ?? 500,
      });
      return rows.map(toRecord);
    },

    async getOrientation(businessId: number): Promise<OrientationRecord> {
      const row = await prisma.businessObligationOrientation.findUnique({
        where: { businessId },
      });
      if (!row) {
        return { businessId, oriented: false, orientedAt: null };
      }
      return {
        businessId: row.businessId,
        oriented: row.oriented,
        orientedAt: row.orientedAt,
      };
    },

    async setOriented(
      businessId: number,
      orientedAt: Date
    ): Promise<OrientationRecord> {
      const row = await prisma.businessObligationOrientation.upsert({
        where: { businessId },
        create: { businessId, oriented: true, orientedAt },
        update: { oriented: true, orientedAt },
      });
      return {
        businessId: row.businessId,
        oriented: row.oriented,
        orientedAt: row.orientedAt,
      };
    },
  };
}
