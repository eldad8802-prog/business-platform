import { ValidationError } from "@/lib/errors";

export const CUSTOMER_TAX_ID_TYPE_VALUES = [
  "AUTHORIZED_DEALER",
  "EXEMPT_DEALER",
  "LTD_COMPANY",
  "PRIVATE_ID",
  "OTHER",
] as const;

export type CustomerTaxIdType = (typeof CUSTOMER_TAX_ID_TYPE_VALUES)[number];

export const CUSTOMER_TAX_ID_TYPE_LABELS: Record<CustomerTaxIdType, string> = {
  AUTHORIZED_DEALER: "עוסק מורשה",
  EXEMPT_DEALER: "עוסק פטור",
  LTD_COMPANY: 'חברה בע"מ',
  PRIVATE_ID: "ת.ז.",
  OTHER: "אחר",
};

const LEGAL_NAME_MAX = 200;
const TAX_ID_MAX = 32;

export const CUSTOMER_BILLING_IDENTITY_SELECT = {
  id: true,
  name: true,
  phone: true,
  email: true,
  city: true,
  legalName: true,
  taxId: true,
  taxIdType: true,
} as const;

export type CustomerBillingIdentityRow = {
  id: number;
  name: string;
  phone: string | null;
  email: string | null;
  city: string | null;
  legalName: string | null;
  taxId: string | null;
  taxIdType: CustomerTaxIdType | null;
};

export type BillingCustomerSnapshotSlice = {
  id: number | null;
  name: string;
  legalName: string | null;
  taxId: string | null;
  taxIdType: string | null;
  phone: string | null;
  email: string | null;
  city: string | null;
  address: unknown | null;
};

export function parseCustomerTaxIdType(
  raw: string | null | undefined
): CustomerTaxIdType | null {
  if (raw == null || typeof raw !== "string") return null;
  const t = raw.trim();
  if (!t) return null;
  return CUSTOMER_TAX_ID_TYPE_VALUES.includes(t as CustomerTaxIdType)
    ? (t as CustomerTaxIdType)
    : null;
}

function normalizeOptionalString(
  raw: unknown,
  fieldName: string,
  maxLen: number
): string | null {
  if (raw === null) return null;
  if (typeof raw !== "string") {
    throw new ValidationError(`${fieldName} must be a string or null`);
  }
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.length > maxLen) {
    throw new ValidationError(`${fieldName} must be at most ${maxLen} characters`);
  }
  return trimmed;
}

export type ParsedCustomerIdentityPayload = {
  legalName?: string | null;
  taxId?: string | null;
  taxIdType?: CustomerTaxIdType | null;
};

export function parseCustomerIdentityPayload(
  body: Record<string, unknown>
): ParsedCustomerIdentityPayload {
  const out: ParsedCustomerIdentityPayload = {};

  if (Object.prototype.hasOwnProperty.call(body, "legalName")) {
    out.legalName = normalizeOptionalString(
      body.legalName,
      "legalName",
      LEGAL_NAME_MAX
    );
  }
  if (Object.prototype.hasOwnProperty.call(body, "taxId")) {
    out.taxId = normalizeOptionalString(body.taxId, "taxId", TAX_ID_MAX);
  }
  if (Object.prototype.hasOwnProperty.call(body, "taxIdType")) {
    const raw = body.taxIdType;
    if (raw === null || raw === "") {
      out.taxIdType = null;
    } else if (typeof raw === "string") {
      const parsed = parseCustomerTaxIdType(raw);
      if (!parsed) {
        throw new ValidationError(
          `taxIdType must be one of: ${CUSTOMER_TAX_ID_TYPE_VALUES.join(", ")}`
        );
      }
      out.taxIdType = parsed;
    } else {
      throw new ValidationError("taxIdType must be a string or null");
    }
  }

  return out;
}

export function buildBillingCustomerSnapshot(args: {
  customerNameSnapshot: string;
  customer: CustomerBillingIdentityRow | null;
}): BillingCustomerSnapshotSlice {
  const name = args.customerNameSnapshot.trim();
  const c = args.customer;

  const legalName = (c?.legalName ?? "").trim() || null;
  const taxId = (c?.taxId ?? "").trim() || null;
  const taxIdType = c?.taxIdType ?? null;

  return {
    id: c?.id ?? null,
    name,
    legalName,
    taxId,
    taxIdType,
    phone: c?.phone ?? null,
    email: c?.email ?? null,
    city: c?.city ?? null,
    address: null,
  };
}
