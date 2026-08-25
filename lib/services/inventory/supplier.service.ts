import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  InventoryNotFoundError,
  InventoryUnauthorizedError,
  InventoryValidationError,
} from "@/lib/services/inventory/inventory.errors";

type Tx = Prisma.TransactionClient;
type TxOptions = { tx?: Tx };

export type CreateSupplierInput = {
  businessId: number;
  name: string;
  phone?: string | null;
  email?: string | null;
  notes?: string | null;
  defaultLeadTimeDays?: number | null;
};

export type ListSuppliersInput = {
  businessId: number;
  // "active" (default) | "inactive" | "all"
  status?: "active" | "inactive" | "all" | null;
  query?: string | null;
  limit?: number | null;
};

export type GetSupplierInput = {
  businessId: number;
  supplierId: number;
};

export type UpdateSupplierInput = {
  businessId: number;
  supplierId: number;
  name?: string;
  phone?: string | null;
  email?: string | null;
  notes?: string | null;
  defaultLeadTimeDays?: number | null;
  isActive?: boolean;
};

export type DeactivateSupplierInput = {
  businessId: number;
  supplierId: number;
};

export type FindPossibleSupplierMatchesInput = {
  businessId: number;
  name: string;
  phone?: string | null;
  email?: string | null;
  limit?: number | null;
};

const LIST_DEFAULT_LIMIT = 50;
const LIST_MAX_LIMIT = 100;

function assertBusinessId(businessId: number) {
  if (!businessId || Number.isNaN(businessId)) {
    throw new InventoryUnauthorizedError("Invalid business id");
  }
}

function normalizeName(value: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new InventoryValidationError("Supplier name is required");
  }
  return value.trim();
}

function normalizeOptionalText(value?: string | null): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeOptionalLeadTime(
  value: number | null | undefined
): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new InventoryValidationError(
      "defaultLeadTimeDays must be a non-negative integer"
    );
  }
  return parsed;
}

function normalizeSupplierId(value: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new InventoryValidationError("Invalid supplier id");
  }
  return parsed;
}

function normalizeLimit(value?: number | null): number {
  if (value == null) return LIST_DEFAULT_LIMIT;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new InventoryValidationError("limit must be a positive integer");
  }
  return Math.min(parsed, LIST_MAX_LIMIT);
}

/**
 * Normalized form used only for soft duplicate detection (not stored, not unique).
 * Lower-cased, collapsed whitespace, common legal suffixes stripped.
 */
function normalizeForMatch(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[.,'"`]/g, "")
    .replace(/\b(bv|ltd|inc|llc)\b/g, "")
    .replace(/בע["׳'']?מ/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export const supplierService = {
  async createSupplier(input: CreateSupplierInput, options?: TxOptions) {
    assertBusinessId(input.businessId);

    const data = {
      businessId: input.businessId,
      name: normalizeName(input.name),
      phone: normalizeOptionalText(input.phone),
      email: normalizeOptionalText(input.email),
      notes: normalizeOptionalText(input.notes),
      defaultLeadTimeDays: normalizeOptionalLeadTime(input.defaultLeadTimeDays),
    };

    const run = (tx: Tx | typeof prisma) =>
      tx.supplier.create({ data });

    // Duplicate strategy: never block, never auto-merge. Creation always allowed.
    if (options?.tx) return run(options.tx);
    return run(prisma);
  },

  async listSuppliers(input: ListSuppliersInput, options?: TxOptions) {
    const db = options?.tx ?? prisma;
    assertBusinessId(input.businessId);

    const status = input.status ?? "active";
    const query = normalizeOptionalText(input.query);

    const where: Prisma.SupplierWhereInput = {
      businessId: input.businessId,
    };

    if (status === "active") where.isActive = true;
    else if (status === "inactive") where.isActive = false;

    if (query) {
      where.name = { contains: query, mode: "insensitive" };
    }

    return db.supplier.findMany({
      where,
      orderBy: [{ name: "asc" }, { id: "asc" }],
      take: normalizeLimit(input.limit),
    });
  },

  async getSupplier(input: GetSupplierInput, options?: TxOptions) {
    const db = options?.tx ?? prisma;
    assertBusinessId(input.businessId);
    const supplierId = normalizeSupplierId(input.supplierId);

    const supplier = await db.supplier.findFirst({
      where: { id: supplierId, businessId: input.businessId },
    });

    if (!supplier) {
      throw new InventoryNotFoundError("Supplier not found");
    }

    return supplier;
  },

  async updateSupplier(input: UpdateSupplierInput, options?: TxOptions) {
    assertBusinessId(input.businessId);
    const supplierId = normalizeSupplierId(input.supplierId);

    const data: Prisma.SupplierUpdateInput = {};

    if (input.name !== undefined) data.name = normalizeName(input.name);
    if (input.phone !== undefined)
      data.phone = normalizeOptionalText(input.phone);
    if (input.email !== undefined)
      data.email = normalizeOptionalText(input.email);
    if (input.notes !== undefined)
      data.notes = normalizeOptionalText(input.notes);
    if (input.defaultLeadTimeDays !== undefined)
      data.defaultLeadTimeDays = normalizeOptionalLeadTime(
        input.defaultLeadTimeDays
      );
    if (input.isActive !== undefined) {
      if (typeof input.isActive !== "boolean") {
        throw new InventoryValidationError("isActive must be a boolean");
      }
      data.isActive = input.isActive;
    }

    const run = async (tx: Tx | typeof prisma) => {
      // Tenant guard: only update a row that belongs to this business.
      const updated = await tx.supplier.updateMany({
        where: { id: supplierId, businessId: input.businessId },
        data,
      });

      if (updated.count !== 1) {
        throw new InventoryNotFoundError("Supplier not found");
      }

      return tx.supplier.findFirstOrThrow({
        where: { id: supplierId, businessId: input.businessId },
      });
    };

    if (options?.tx) return run(options.tx);
    return run(prisma);
  },

  async deactivateSupplier(input: DeactivateSupplierInput, options?: TxOptions) {
    return this.updateSupplier(
      {
        businessId: input.businessId,
        supplierId: input.supplierId,
        isActive: false,
      },
      options
    );
  },

  /**
   * Soft duplicate detection. Returns likely existing matches by normalized
   * name / phone / email. Never blocks and never merges — purely advisory.
   */
  async findPossibleMatches(input: FindPossibleSupplierMatchesInput, options?: TxOptions) {
    const db = options?.tx ?? prisma;
    assertBusinessId(input.businessId);

    const name = normalizeName(input.name);
    const phone = normalizeOptionalText(input.phone);
    const email = normalizeOptionalText(input.email);
    const normalizedName = normalizeForMatch(name);
    // Use the longest normalized token so "Strauss Ltd" still retrieves "Strauss".
    const anchorToken = normalizedName
      .split(" ")
      .filter(Boolean)
      .sort((a, b) => b.length - a.length)[0];

    const or: Prisma.SupplierWhereInput[] = [];
    if (anchorToken) {
      or.push({ name: { contains: anchorToken, mode: "insensitive" } });
    }
    if (phone) or.push({ phone });
    if (email) or.push({ email: { equals: email, mode: "insensitive" } });

    if (or.length === 0) return [];

    const candidates = await db.supplier.findMany({
      where: { businessId: input.businessId, OR: or },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      take: normalizeLimit(input.limit),
    });

    return candidates.filter((candidate) => {
      const sameNormalizedName =
        normalizeForMatch(candidate.name) === normalizedName;
      const samePhone = Boolean(phone && candidate.phone === phone);
      const sameEmail = Boolean(
        email && candidate.email?.toLowerCase() === email.toLowerCase()
      );
      return sameNormalizedName || samePhone || sameEmail;
    });
  },
};
