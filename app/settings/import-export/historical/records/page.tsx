import { notFound } from "next/navigation";

import { SettingsSubPageHeader } from "@/components/settings/SettingsSubPageHeader";
import { HistoricalRecordsScreen } from "@/components/settings/import-export/historical/HistoricalRecordsScreen";
import {
  HISTORICAL_IMPORT_ROUTE,
  HISTORICAL_RECORDS_ROUTE,
} from "@/components/settings/import-export/historical/historical-routes";
import { IMPORT_EXPORT_RELEASED } from "@/components/settings/import-export/import-export-release";
import {
  HISTORICAL_DOCUMENT_TYPES,
  HISTORICAL_TYPE_LABELS,
} from "@/lib/data-transfer/historical/historical-vocabulary";

/**
 * הגדרות → ייבוא וייצוא → היסטוריה ממערכת קודמת → המסמכים שנקלטו.
 *
 * The document types come from the closed vocabulary the importer validates
 * against, derived on the server, so the filter can never offer a type the
 * engine would not recognise — and there is no second list to drift.
 */
export default function HistoricalRecordsPage() {
  if (!IMPORT_EXPORT_RELEASED) {
    notFound();
  }

  const documentTypes = HISTORICAL_DOCUMENT_TYPES.map((code) => ({
    code,
    label: HISTORICAL_TYPE_LABELS[code],
  }));

  return (
    <>
      <SettingsSubPageHeader
        title="מסמכים היסטוריים"
        subtitle="הופקו במערכת אחרת, נשמרים לצפייה"
        backHref={HISTORICAL_IMPORT_ROUTE}
      />
      <HistoricalRecordsScreen
        documentTypes={documentTypes}
        importHref={HISTORICAL_IMPORT_ROUTE}
        recordsBase={HISTORICAL_RECORDS_ROUTE}
      />
    </>
  );
}
