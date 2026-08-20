/**
 * Canonical Customer service — the single source of truth for Customer
 * create / update / read / list / search.
 *
 * Both legacy endpoints (`/api/customer`, `/api/billing/customers`) and the new
 * canonical `/api/customers` delegate here, so phone normalization and
 * validation are identical no matter which route a caller uses. Every query is
 * tenant-scoped by `businessId`; every write is guarded so a row belonging to
 * another business can never be touched.
 *
 * This service holds NO financial rollups and NO cross-entity aggregation —
 * that lives in the read-model / summary layers (later phases).
 */

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  ValidationError,
  UnauthorizedError,
  NotFoundError,
  ConflictError,
} from "@/lib/errors";
import { normalizeCustomerPhone } from "@/lib/services/integrations/whatsapp/phone";

const NAME_MAX = 200;
const EMAIL_MAX = 200;
const CITY_MAX = 120;
const NOTES_MAX = 5000;
const LIST_MAX_LIMIT = 100;

type Tx = Prisma.TransactionClient;
type TxOptions = { tx?: Tx };

/** `recent` = updatedAt desc (billing UX). `id-asc` = legacy `/api/customer` order. */
export type CustomerSort = "recent" | "id-asc";

/**
 * Lifecycle list filter. Default (undefined) = "all" — this is deliberate: the
 * canonical service is shared by Billing (`/api/billing/customers`, invoice picker)
 * and the legacy `/api/customer`, which must keep seeing every customer. Only the
 * CRM list opts into "active" explicitly (via its client), so no existing caller
 * changes behavior.
 */
export type CustomerLifecycleFilter = "active" | "inactive" | "all";

export type CreateCustomerInput = {
  businessId: number;
  name: string;
  phone?: string | null;
  email?: string | null;
  city?: string | null;
  notes?: string | null;
};

export type UpdateCustomerBasicsInput = {
  businessId: number;
  customerId: number;
  name?: string;
  phone?: string | null;
  email?: string | null;
  city?: string | null;
  notes?: string | null;
};

/** Lifecycle is a distinct business action — its own contract, separate from basics. */
export type SetCustomerActiveStatusInput = {
  businessId: number;
  customerId: number;
  isActive: boolean;
};

export type ListCustomersInput = {
  businessId: number;
  query?: string | null;
  /** Omit/undefined = unbounded (legacy `/api/customer` GET). A number caps + clamps to 100. */
  limit?: number | null;
  sort?: CustomerSort;
  /** Lifecycle filter. Omit/undefined = "all" (backward compatible for non-CRM callers). */
  status?: CustomerLifecycleFilter;
};

export type GetCustomerInput = {
  businessId: number;
  customerId: number;
};

function assertBusinessId(businessId: number): void {
  if (!businessId || Number.isNaN(businessId)) {
    throw new UnauthorizedError("Invalid business id");
  }
}

function normalizeName(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ValidationError("name is required");
  }
  const trimmed = value.trim();
  if (trimmed.length > NAME_MAX) {
    throw new ValidationError(`name must be at most ${NAME_MAX} characters`);
  }
  return trimmed;
}

function normalizeOptionalText(
  value: unknown,
  field: string,
  max: number
): string | null {
  if (value == null) return null;
  if (typeof value !== "string") {
    throw new ValidationError(`${field} must be a string or null`);
  }
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > max) {
    throw new ValidationError(`${field} must be at most ${max} characters`);
  }
  return trimmed;
}

function normalizeCustomerId(value: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ValidationError("Invalid customer id");
  }
  return parsed;
}

function clampLimit(value?: number | null): number | undefined {
  if (value == null) return undefined; // unbounded — preserves legacy `/api/customer` GET
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ValidationError("limit must be a positive integer");
  }
  return Math.min(parsed, LIST_MAX_LIMIT);
}

function buildOrderBy(
  sort: CustomerSort | undefined
): Prisma.CustomerOrderByWithRelationInput[] {
  if (sort === "id-asc") return [{ id: "asc" }];
  return [{ updatedAt: "desc" }, { id: "desc" }];
}

export const customerService = {
  /**
   * Create a customer. Phone is always canonicalized via `normalizeCustomerPhone`
   * (null when missing/invalid) so the `(businessId, phone)` unique constraint
   * stays meaningful — this is the behavior both legacy endpoints now share.
   */
  async createCustomer(input: CreateCustomerInput, options?: TxOptions) {
    assertBusinessId(input.businessId);

    const data: Prisma.CustomerUncheckedCreateInput = {
      businessId: input.businessId,
      name: normalizeName(input.name),
      phone: normalizeCustomerPhone(input.phone ?? null),
      email: normalizeOptionalText(input.email, "email", EMAIL_MAX),
      city: normalizeOptionalText(input.city, "city", CITY_MAX),
      notes: normalizeOptionalText(input.notes, "notes", NOTES_MAX),
    };

    const run = (tx: Tx | typeof prisma) => tx.customer.create({ data });
    return options?.tx ? run(options.tx) : run(prisma);
  },

  /**
   * Update basic customer fields. Only provided keys are touched. Tenant-guarded:
   * a customer from another business cannot be updated (updateMany count === 1).
   * Tax-identity fields stay owned by the existing billing PATCH — not here.
   */
  async updateCustomerBasics(
    input: UpdateCustomerBasicsInput,
    options?: TxOptions
  ) {
    assertBusinessId(input.businessId);
    const customerId = normalizeCustomerId(input.customerId);

    const data: Prisma.CustomerUpdateInput = {};
    if (input.name !== undefined) data.name = normalizeName(input.name);
    if (input.phone !== undefined)
      data.phone = normalizeCustomerPhone(input.phone ?? null);
    if (input.email !== undefined)
      data.email = normalizeOptionalText(input.email, "email", EMAIL_MAX);
    if (input.city !== undefined)
      data.city = normalizeOptionalText(input.city, "city", CITY_MAX);
    if (input.notes !== undefined)
      data.notes = normalizeOptionalText(input.notes, "notes", NOTES_MAX);

    const run = async (tx: Tx | typeof prisma) => {
      try {
        // Atomic tenant-guarded update: a row of another business never matches,
        // so count !== 1 → NotFound (no cross-tenant existence disclosure). A
        // unique-phone collision aborts the whole statement — nothing is written
        // partially.
        const updated = await tx.customer.updateMany({
          where: { id: customerId, businessId: input.businessId },
          data,
        });
        if (updated.count !== 1) {
          throw new NotFoundError("Customer not found");
        }
        return await tx.customer.findFirstOrThrow({
          where: { id: customerId, businessId: input.businessId },
        });
      } catch (error) {
        // Surface the existing (businessId, phone) unique constraint as a friendly
        // CRM conflict instead of a raw Prisma error / 500. Not a new duplicate
        // mechanism — just correct handling of the constraint that already exists.
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002"
        ) {
          throw new ConflictError(
            "PHONE_TAKEN",
            "מספר הטלפון כבר משויך ללקוח אחר בעסק."
          );
        }
        throw error;
      }
    };

    return options?.tx ? run(options.tx) : run(prisma);
  },

  /**
   * Lifecycle: activate / deactivate a customer. Flips ONLY `isActive` — never
   * deletes the customer and never touches its relations (billing documents,
   * payments, conversations, appointments, notes, attachments) or its identity.
   * Tenant-guarded: another business's customer behaves exactly like not-found.
   */
  async setCustomerActiveStatus(
    input: SetCustomerActiveStatusInput,
    options?: TxOptions
  ) {
    assertBusinessId(input.businessId);
    const customerId = normalizeCustomerId(input.customerId);
    if (typeof input.isActive !== "boolean") {
      throw new ValidationError("isActive must be a boolean");
    }

    const run = async (tx: Tx | typeof prisma) => {
      const updated = await tx.customer.updateMany({
        where: { id: customerId, businessId: input.businessId },
        data: { isActive: input.isActive },
      });
      if (updated.count !== 1) {
        throw new NotFoundError("Customer not found");
      }
      return tx.customer.findFirstOrThrow({
        where: { id: customerId, businessId: input.businessId },
      });
    };

    return options?.tx ? run(options.tx) : run(prisma);
  },

  /** Fetch one customer, tenant-scoped. Throws NotFound across businesses. */
  async getCustomer(input: GetCustomerInput, options?: TxOptions) {
    assertBusinessId(input.businessId);
    const customerId = normalizeCustomerId(input.customerId);

    const run = async (tx: Tx | typeof prisma) => {
      const customer = await tx.customer.findFirst({
        where: { id: customerId, businessId: input.businessId },
      });
      if (!customer) {
        throw new NotFoundError("Customer not found");
      }
      return customer;
    };
    return options?.tx ? run(options.tx) : run(prisma);
  },

  /**
   * List / search customers for a business. Returns full Customer rows; callers
   * project the shape they expose. `query` matches name or phone (case-insensitive),
   * matching the legacy billing search behavior.
   */
  async listCustomers(input: ListCustomersInput, options?: TxOptions) {
    assertBusinessId(input.businessId);

    const q = typeof input.query === "string" ? input.query.trim() : "";
    const where: Prisma.CustomerWhereInput = { businessId: input.businessId };
    if (q.length > 0) {
      where.OR = [
        { name: { contains: q, mode: "insensitive" } },
        { phone: { contains: q, mode: "insensitive" } },
      ];
    }
    // Lifecycle filter. Default (undefined) = "all" so Billing / legacy callers are
    // unaffected; only the CRM list passes "active"/"inactive" explicitly.
    const status = input.status ?? "all";
    if (status === "active") where.isActive = true;
    else if (status === "inactive") where.isActive = false;

    const take = clampLimit(input.limit);
    const run = (tx: Tx | typeof prisma) =>
      tx.customer.findMany({
        where,
        orderBy: buildOrderBy(input.sort),
        ...(take !== undefined ? { take } : {}),
      });
    return options?.tx ? run(options.tx) : run(prisma);
  },

  /** Convenience alias — search is list with a query + recent sort + a cap. */
  async searchCustomers(input: {
    businessId: number;
    query?: string | null;
    limit?: number | null;
  }) {
    return this.listCustomers({
      businessId: input.businessId,
      query: input.query,
      limit: input.limit ?? 50,
      sort: "recent",
    });
  },
};
