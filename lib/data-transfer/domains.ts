/**
 * The SEVEN approved Import/Export domains — one registry, owner-facing.
 *
 * This is the closed list ratified for the Import & Export Center. Nothing
 * outside it is transferable: not learning state, not AI internals, not system
 * settings, logs, telemetry or notifications. Adding an entry is a product
 * decision, not a refactor, so the verifier asserts the exact set.
 *
 * `title` / `description` are what the BUSINESS OWNER reads. They are never
 * internal model names — a screen that says "InventoryItem" or "BillingDocument"
 * has failed, however correct it is.
 *
 * # Why `kind` exists from day one
 *
 * The kinds do not merely look different, they OBEY DIFFERENT RULES, and
 * encoding that here stops a later increment from treating them alike:
 *
 *  - `tabular`    — rows the owner can hand-edit. Round-trips through a
 *                   spreadsheet (XLSX by default, CSV optional).
 *  - `files`      — the original artefacts the business received. These move as
 *                   files through the EXISTING Documents pipeline; there is no
 *                   second ingestion path.
 *  - `fiscal`     — documents Dubiz ISSUED. Immutable once issued, numbered by a
 *                   legal sequence, and reported to the tax authority. Export
 *                   only.
 *  - `historical` — fiscal documents ANOTHER system issued, kept as history.
 *
 * # Why `historical` is its own kind and not more `fiscal`
 *
 * The two carry opposite claims about who produced the document, and that is
 * the whole point of the separation. `fiscal` means Dubiz issued it: a number
 * from Dubiz's own sequence, an issuance snapshot and legal hash, a
 * Dubiz-rendered PDF, and inclusion in the uniform (מבנה אחיד) file filed with
 * the Israeli Tax Authority. `historical` means somebody else issued it and the
 * business is keeping the record.
 *
 * Widening `fiscal` to cover both would have put one word over two opposite
 * meanings, and every rule written against that word would then apply to the
 * wrong half. A record in the historical domain must never be written as an
 * issued Dubiz document, never draw a Dubiz number, and never reach the
 * authority path. Those records live in their own persistence model with its
 * own firewall, deliberately not named here — this registry describes owner
 * flows, and it is not the place a later increment should learn how to reach a
 * fiscal table.
 *
 * # Registration is not capability
 *
 * A domain listed here is a name and a set of rules, nothing more. The
 * `historical` domain deliberately has NO writer, NO export descriptor and NO
 * import template, so every route that takes a domain refuses it and every
 * screen that lists domains filters it out. Analyze, Preview and Execute for it
 * are separate increments (I-8B.1 onward), each with its own review.
 */

export type DataTransferDomainId =
  | "customers"
  | "suppliers"
  | "leads"
  | "inventory"
  | "documents"
  | "issued-documents"
  | "historical-documents";

/** What kind of thing moves, which decides the rules that apply to it. */
export type DataTransferDomainKind = "tabular" | "files" | "fiscal" | "historical";

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
  {
    // The wording carries the distinction the whole domain exists for. It says
    // where the documents came FROM and when — "before Dubiz" — so an owner
    // reading the two rows together cannot mistake one for the other.
    id: "historical-documents",
    title: "היסטוריה ממערכת קודמת",
    description: "חשבוניות וקבלות שהופקו במערכת אחרת, לפני דוביז",
    icon: "🗄️",
    kind: "historical",
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
