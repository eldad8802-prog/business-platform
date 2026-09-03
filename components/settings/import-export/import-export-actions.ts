/**
 * The two actions on the Import/Export hub.
 *
 * # Why the hub shows two rows and not six
 *
 * The owner's question on arrival is "which direction am I going?", not "which
 * of six datasets do I want?". Asking the second question first puts a
 * six-item grid in front of someone who has not yet said whether they are
 * moving in or copying out — and the answer changes what every one of those six
 * rows would even mean. Domain selection therefore belongs to the NEXT step of
 * each flow, where the direction is already known.
 *
 * The six domains live in `lib/data-transfer/domains.ts` and are consumed there.
 *
 * # Wording
 *
 * Both lines say what the owner GETS, in their words. Not "CSV/XLSX", not
 * "bulk import", not "data migration" — a business owner does not think in file
 * formats, and a Settings screen that opens with one has already lost them.
 *
 * # Icons
 *
 * The first pair tried was 📥 / 📤. Rendered at the Settings row size they are
 * two near-identical trays differing only in a small arrow, which defeats the
 * one job this screen has — letting the owner see the direction at a glance.
 * Replaced with glyphs that differ in overall SHAPE, and that match the Hebrew
 * verb each row already uses: a folder for "העבר מידע" (the files you already
 * have) and a download arrow for "הורד עותק".
 *
 * # `available`
 *
 * Import is planned but not built. It stays VISIBLE — the Center supports both
 * directions and hiding half of it would misrepresent the product — but it is
 * rendered as a non-interactive row with a "בקרוב" pill, never as a link to a
 * route that does not exist. See `ImportExportPendingRow`.
 */

import { IMPORT_EXPORT_ROUTE } from "./import-export-release";

export type ImportExportAction = {
  key: "import" | "templates" | "export";
  href: string;
  title: string;
  description: string;
  icon: string;
  /** False while the flow is planned but not yet usable. */
  available: boolean;
};

export const IMPORT_EXPORT_ACTIONS: readonly ImportExportAction[] = [
  {
    key: "import",
    href: `${IMPORT_EXPORT_ROUTE}/import`,
    title: "ייבוא",
    // I-6 made it a transfer, so the wording became one. It still leads with
    // the check, because that is what the owner does first and it is the part
    // that makes the rest safe.
    description: "העלו קובץ ממערכת אחרת, בדקו, ואשרו קליטה",
    icon: "📂",
    available: true,
  },
  {
    // Sits directly under the pending Import row because it belongs to that
    // journey: the one useful thing an owner CAN do about importing today is
    // get their data into the right shape. Its own screen leads with the fact
    // that importing is not live yet, so this row cannot imply otherwise.
    key: "templates",
    href: `${IMPORT_EXPORT_ROUTE}/templates`,
    title: "תבניות לייבוא",
    description: "הורידו קובץ לדוגמה והכינו את המידע מראש",
    icon: "📋",
    available: true,
  },
  {
    key: "export",
    href: `${IMPORT_EXPORT_ROUTE}/export`,
    title: "ייצוא",
    description: "הורד עותק של הנתונים והמסמכים שלך",
    icon: "⬇️",
    available: true,
  },
] as const;
