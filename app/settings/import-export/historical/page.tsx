import { notFound } from "next/navigation";

import { SettingsSubPageHeader } from "@/components/settings/SettingsSubPageHeader";
import {
  HistoricalImportScreen,
  type HistoricalFieldOption,
  type HistoricalHeaderMap,
} from "@/components/settings/import-export/historical/HistoricalImportScreen";
import { HISTORICAL_RECORDS_ROUTE } from "@/components/settings/import-export/historical/historical-routes";
import {
  IMPORT_EXPORT_RELEASED,
  IMPORT_EXPORT_ROUTE,
} from "@/components/settings/import-export/import-export-release";
import { HISTORICAL_FIELDS } from "@/lib/data-transfer/historical/historical-fields";

/**
 * הגדרות → ייבוא וייצוא → היסטוריה ממערכת קודמת.
 *
 * # Why the field contract is derived here and passed down
 *
 * Same reason the other Import/Export pages filter their domain list on the
 * server: `HISTORICAL_FIELDS` is the one contract the template, the analyzer
 * and the writer all read, and deriving the owner-facing shape of it here keeps
 * the engine — and everything it imports — out of the client bundle. The screen
 * receives plain strings and knows nothing about how they were produced.
 *
 * It also means the column names in the picker cannot drift from the column
 * names the server maps against: there is no second list.
 */
export default function HistoricalImportPage() {
  if (!IMPORT_EXPORT_RELEASED) {
    notFound();
  }

  const fields: HistoricalFieldOption[] = HISTORICAL_FIELDS.map((field) => ({
    field: field.header,
    requirement:
      field.required === true
        ? "required"
        : field.conditional === true
          ? "conditional"
          : "optional",
    help: field.help ?? null,
  }));

  // target -> header, so the screen can find "the document number" in a row's
  // values without hardcoding Hebrew keys that must match the contract exactly.
  const headerFor = (target: string): string =>
    HISTORICAL_FIELDS.find((f) => f.target === target)?.header ?? "";

  const headers: HistoricalHeaderMap = {
    documentTypeCode: headerFor("documentTypeCode"),
    originalDocumentNumber: headerFor("originalDocumentNumber"),
    originalIssueDate: headerFor("originalIssueDate"),
    totalAmount: headerFor("totalAmount"),
    currency: headerFor("currency"),
    customerNameSnapshot: headerFor("customerNameSnapshot"),
    sourceSystemCode: headerFor("sourceSystemCode"),
    reversesOriginalNumberRaw: headerFor("reversesOriginalNumberRaw"),
  };

  return (
    <>
      <SettingsSubPageHeader
        title="היסטוריה ממערכת קודמת"
        subtitle="מסמכים שהופקו במערכת אחרת"
        backHref={IMPORT_EXPORT_ROUTE}
      />
      <HistoricalImportScreen
        fields={fields}
        headers={headers}
        recordsHref={HISTORICAL_RECORDS_ROUTE}
      />
    </>
  );
}
