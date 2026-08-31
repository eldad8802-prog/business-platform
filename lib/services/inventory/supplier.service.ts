import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  InventoryNotFoundError,
  InventoryUnauthorizedError,
  InventoryValidationError,
} from "@/lib/services/inventory/inventory.errors";
import {
  isPlausibleEmail,
  isPlausiblePhone,
  isPlausibleSupplierTaxId,
  normalizeSupplierTaxId,
  parseSupplierPaymentMethod,
  parseSupplierTaxIdType,
  SUPPLIER_PAYMENT_TERMS_MAX_DAYS,
  type SupplierPaymentMethod,
  type SupplierTaxIdType,
} from "@/lib/services/inventory/supplier-profile";

type Tx = Prisma.TransactionClient;
type TxOptions = { tx?: Tx };

/**
 * The business-profile slice of a supplier. Every field is optional on both
 * create and update: a supplier must stay creatable in seconds with just a name
 * ("fast creation"), and the rest is filled in later ("complete profile").
 */
export type SupplierProfileInput = {
  legalName?: string | null;
  taxId?: string | null;
  taxIdType?: SupplierTaxIdType | null;
  category?: string | null;
  website?: string | null;
  contactName?: string | null;
  contactRole?: string | null;
  contactPhone?: string | null;
  contactEmail?: string | null;
  addressStreet?: string | null;
  addressCity?: string | null;
  addressPostalCode?: string | null;
  paymentTermsDays?: number | null;
  preferredPaymentMethod?: SupplierPaymentMethod | null;
};

export type CreateSupplierInput = SupplierProfileInput & {
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

export type UpdateSupplierInput = SupplierProfileInput & {
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
  /** Exact business identifier — by far the strongest signal when present. */
  taxId?: string | null;
  limit?: number | null;
};

/**
 * Why a candidate was flagged. The UI leads with the strongest reason, because
 * "same business number" and "similar name" deserve very different confidence.
 */
export type SupplierMatchReason = "TAX_ID" | "PHONE" | "EMAIL" | "NAME";

export type PossibleSupplierMatch = {
  id: number;
  name: string;
  isActive: boolean;
  phone: string | null;
  email: string | null;
  taxId: string | null;
  reasons: SupplierMatchReason[];
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

const TEXT_MAX = 200;

function normalizeBoundedText(
  value: string | null | undefined,
  fieldName: string,
  maxLen = TEXT_MAX
): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (!trimmed) return null;
  if (trimmed.length > maxLen) {
    throw new InventoryValidationError(
      `${fieldName} must be at most ${maxLen} characters`
    );
  }
  return trimmed;
}

/** Rejects an obviously malformed address; an empty value stays a valid "unset". */
function normalizeEmailField(
  value: string | null | undefined,
  fieldName: string
): string | null {
  const trimmed = normalizeBoundedText(value, fieldName);
  if (trimmed == null) return null;
  if (!isPlausibleEmail(trimmed)) {
    throw new InventoryValidationError(`${fieldName} is not a valid email`);
  }
  return trimmed;
}

function normalizePhoneField(
  value: string | null | undefined,
  fieldName: string
): string | null {
  const trimmed = normalizeBoundedText(value, fieldName, 32);
  if (trimmed == null) return null;
  if (!isPlausiblePhone(trimmed)) {
    throw new InventoryValidationError(`${fieldName} is not a valid phone number`);
  }
  return trimmed;
}

/**
 * Stored digits-only so that "51-234-567 8" and "512345678" are the same
 * identifier — which is the whole point of using it for duplicate detection.
 */
function normalizeTaxIdField(value: string | null | undefined): string | null {
  const trimmed = normalizeBoundedText(value, "taxId", 32);
  if (trimmed == null) return null;
  if (!isPlausibleSupplierTaxId(trimmed)) {
    throw new InventoryValidationError(
      "מספר העוסק / ח.פ. אינו תקין — נדרשות 8 או 9 ספרות"
    );
  }
  return normalizeSupplierTaxId(trimmed);
}

// Accepts the wire shape (any string) rather than the narrowed union: the value
// arrives from a JSON body, so "" and garbage are both reachable at runtime even
// though the typed callers can only produce a valid member.
function normalizeTaxIdTypeField(
  value: SupplierTaxIdType | string | null | undefined
): SupplierTaxIdType | null {
  if (value == null || value === "") return null;
  const parsed = parseSupplierTaxIdType(value);
  if (!parsed) {
    throw new InventoryValidationError("taxIdType is not a supported value");
  }
  return parsed;
}

function normalizePaymentMethodField(
  value: SupplierPaymentMethod | string | null | undefined
): SupplierPaymentMethod | null {
  if (value == null || value === "") return null;
  const parsed = parseSupplierPaymentMethod(value);
  if (!parsed) {
    throw new InventoryValidationError(
      "preferredPaymentMethod is not a supported value"
    );
  }
  return parsed;
}

function normalizePaymentTermsDays(
  value: number | null | undefined
): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  if (
    !Number.isInteger(parsed) ||
    parsed < 0 ||
    parsed > SUPPLIER_PAYMENT_TERMS_MAX_DAYS
  ) {
    throw new InventoryValidationError(
      `תנאי התשלום חייבים להיות מספר ימים שלם בין 0 ל-${SUPPLIER_PAYMENT_TERMS_MAX_DAYS}`
    );
  }
  return parsed;
}

/**
 * Normalizes the profile slice once, so create and update cannot disagree about
 * what a valid supplier looks like.
 */
function normalizeSupplierProfile(input: SupplierProfileInput) {
  return {
    legalName: normalizeBoundedText(input.legalName, "legalName"),
    taxId: normalizeTaxIdField(input.taxId),
    taxIdType: normalizeTaxIdTypeField(input.taxIdType),
    category: normalizeBoundedText(input.category, "category", 80),
    website: normalizeBoundedText(input.website, "website"),
    contactName: normalizeBoundedText(input.contactName, "contactName"),
    contactRole: normalizeBoundedText(input.contactRole, "contactRole", 80),
    contactPhone: normalizePhoneField(input.contactPhone, "contactPhone"),
    contactEmail: normalizeEmailField(input.contactEmail, "contactEmail"),
    addressStreet: normalizeBoundedText(input.addressStreet, "addressStreet"),
    addressCity: normalizeBoundedText(input.addressCity, "addressCity", 80),
    addressPostalCode: normalizeBoundedText(
      input.addressPostalCode,
      "addressPostalCode",
      20
    ),
    paymentTermsDays: normalizePaymentTermsDays(input.paymentTermsDays),
    preferredPaymentMethod: normalizePaymentMethodField(
      input.preferredPaymentMethod
    ),
  };
}

const SUPPLIER_PROFILE_KEYS = [
  "legalName",
  "taxId",
  "taxIdType",
  "category",
  "website",
  "contactName",
  "contactRole",
  "contactPhone",
  "contactEmail",
  "addressStreet",
  "addressCity",
  "addressPostalCode",
  "paymentTermsDays",
  "preferredPaymentMethod",
] as const;

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
      phone: normalizePhoneField(input.phone, "phone"),
      email: normalizeEmailField(input.email, "email"),
      notes: normalizeOptionalText(input.notes),
      defaultLeadTimeDays: normalizeOptionalLeadTime(input.defaultLeadTimeDays),
      ...normalizeSupplierProfile(input),
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
      data.phone = normalizePhoneField(input.phone, "phone");
    if (input.email !== undefined)
      data.email = normalizeEmailField(input.email, "email");

    // Only fields the caller actually sent are touched — a PATCH that omits a
    // field must never blank it. Normalization still runs on everything present,
    // so an update can no more store a malformed value than a create can.
    const normalizedProfile = normalizeSupplierProfile(input);
    for (const key of SUPPLIER_PROFILE_KEYS) {
      if (input[key] !== undefined) {
        (data as Record<string, unknown>)[key] = normalizedProfile[key];
      }
    }

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
   * Soft duplicate detection. Returns likely existing matches by business
   * identifier / phone / email / normalized name. Never blocks and never merges
   * — purely advisory, and it reports WHY each candidate matched so the caller
   * can be confident about an identifier and merely suggestive about a name.
   *
   * An exact business identifier is the strongest available signal: two rows
   * carrying the same ח.פ. are the same legal entity, whereas two rows with
   * similar names may well be two genuinely different businesses.
   */
  async findPossibleMatches(
    input: FindPossibleSupplierMatchesInput,
    options?: TxOptions
  ): Promise<PossibleSupplierMatch[]> {
    const db = options?.tx ?? prisma;
    assertBusinessId(input.businessId);

    const name = normalizeName(input.name);
    const phone = normalizeOptionalText(input.phone);
    const email = normalizeOptionalText(input.email);
    // Never throws here: duplicate detection is advisory, so an identifier we
    // cannot parse simply stops being a signal instead of failing the lookup.
    const rawTaxId = normalizeOptionalText(input.taxId);
    const taxId =
      rawTaxId && isPlausibleSupplierTaxId(rawTaxId)
        ? normalizeSupplierTaxId(rawTaxId)
        : null;
    const normalizedName = normalizeForMatch(name);
    // Use the longest normalized token so "Strauss Ltd" still retrieves "Strauss".
    const anchorToken = normalizedName
      .split(" ")
      .filter(Boolean)
      .sort((a, b) => b.length - a.length)[0];

    const or: Prisma.SupplierWhereInput[] = [];
    if (taxId) or.push({ taxId });
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
      select: {
        id: true,
        name: true,
        isActive: true,
        phone: true,
        email: true,
        taxId: true,
      },
    });

    const matches: PossibleSupplierMatch[] = [];

    for (const candidate of candidates) {
      const reasons: SupplierMatchReason[] = [];

      if (taxId && candidate.taxId === taxId) reasons.push("TAX_ID");
      if (phone && candidate.phone === phone) reasons.push("PHONE");
      if (email && candidate.email?.toLowerCase() === email.toLowerCase()) {
        reasons.push("EMAIL");
      }
      if (normalizeForMatch(candidate.name) === normalizedName) {
        reasons.push("NAME");
      }

      if (reasons.length > 0) matches.push({ ...candidate, reasons });
    }

    // Strongest evidence first, so the UI's first row is the one most likely to
    // actually be the same supplier.
    const rank = (m: PossibleSupplierMatch) =>
      m.reasons.includes("TAX_ID")
        ? 0
        : m.reasons.includes("PHONE")
          ? 1
          : m.reasons.includes("EMAIL")
            ? 2
            : 3;

    return matches.sort((a, b) => rank(a) - rank(b) || a.id - b.id);
  },
};
