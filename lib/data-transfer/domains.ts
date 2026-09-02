/**
 * The SIX approved Import/Export domains — one registry, owner-facing.
 *
 * This is the closed list ratified for the Import & Export Center. Nothing
 * outside it is transferable: not learning state, not AI internals, not system
 * settings, logs, telemetry or notifications. Adding a seventh entry is a
 * product decision, not a refactor, so the verifier asserts the exact set.
 *
 * `title` / `description` are what the BUSINESS OWNER reads. They are never
 * internal model names — a screen that says "InventoryItem" or "BillingDocument"
 * has failed, however correct it is.
 *
 * # Why `kind` exists from day one
 *
 * The three kinds do not merely look different, they OBEY DIFFERENT RULES, and
 * encoding that here stops a later increment from treating them alike:
 *
 *  - `tabular`  — rows the owner can hand-edit. Round-trips through a
 *                 spreadsheet (XLSX by default, CSV optional).
 *  - `files`    — the original artefacts the business received. These move as
 *                 files through the EXISTING Documents pipeline; there is no
 *                 second ingestion path.
 *  - `fiscal`   — documents Dubiz ISSUED. Immutable once issued, numbered by a
 *                 legal sequence, and reported to the tax authority. Export
 *                 only. Importing a historical fiscal document from another
 *                 system is DEFERRED (I-9) and, when it happens, must never be
 *                 written as an issued Dubiz document.
 */

export type DataTransferDomainId =
  | "customers"
  | "suppliers"
  | "leads"
  | "inventory"
  | "documents"
  | "issued-documents";

/** What kind of thing moves, which decides the rules that apply to it. */
export type DataTransferDomainKind = "tabular" | "files" | "fiscal";

export type DataTransferDomain = {
  id: DataTransferDomainId;
  /** Owner-facing Hebrew name. */
  title: string;
  /** One short line, in the owner's words — what this actually contains. */
  description: string;
  icon: string;
  kind: DataTransferDomainKind;
};

export const DATA_TRANSFER_DOMAINS: readonly DataTransferDomain[] = [
  {
    id: "customers",
    title: "לקוחות",
    description: "שמות, טלפונים ופרטי קשר",
    icon: "👥",
    kind: "tabular",
  },
  {
    id: "suppliers",
    title: "ספקים",
    description: "ספקים, אנשי קשר ותנאי תשלום",
    icon: "🚚",
    kind: "tabular",
  },
  {
    id: "leads",
    title: "לידים",
    description: "פניות שהתקבלו והמעקב אחריהן",
    icon: "🎯",
    kind: "tabular",
  },
  {
    id: "inventory",
    title: "מלאי",
    description: "פריטים, מק״טים, כמויות ומחירים",
    icon: "📦",
    kind: "tabular",
  },
  {
    id: "documents",
    title: "מסמכים",
    description: "חשבוניות וקבלות שקיבלת, והקבצים המקוריים",
    icon: "📄",
    kind: "files",
  },
  {
    id: "issued-documents",
    title: "מסמכים שהפקת",
    description: "חשבוניות, קבלות והצעות מחיר שהפקת בדוביז",
    icon: "🧾",
    kind: "fiscal",
  },
] as const;

/** Ordered ids — the canonical presentation order for every later screen. */
export const DATA_TRANSFER_DOMAIN_IDS: readonly DataTransferDomainId[] =
  DATA_TRANSFER_DOMAINS.map((d) => d.id);

export function getDataTransferDomain(
  id: DataTransferDomainId
): DataTransferDomain {
  const found = DATA_TRANSFER_DOMAINS.find((d) => d.id === id);
  if (!found) {
    // Unreachable through the exported type; guards a cast at a call site.
    throw new Error(`Unknown data-transfer domain: ${id}`);
  }
  return found;
}
