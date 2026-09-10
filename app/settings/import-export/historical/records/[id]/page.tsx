import { notFound } from "next/navigation";

import { SettingsSubPageHeader } from "@/components/settings/SettingsSubPageHeader";
import { HistoricalRecordDetail } from "@/components/settings/import-export/historical/HistoricalRecordDetail";
import { HISTORICAL_RECORDS_ROUTE } from "@/components/settings/import-export/historical/historical-routes";
import { IMPORT_EXPORT_RELEASED } from "@/components/settings/import-export/import-export-release";

/**
 * One historical fiscal record.
 *
 * The id in the path is a handle, not information: it is never rendered, and
 * the record it addresses is scoped to the session's business by the read
 * service and by row-level security. A malformed id is refused here rather
 * than travelling to an endpoint as a non-number.
 */
export default async function HistoricalRecordPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  if (!IMPORT_EXPORT_RELEASED) {
    notFound();
  }

  const { id } = await params;
  const recordId = Number(id);
  if (!Number.isInteger(recordId) || recordId <= 0) {
    notFound();
  }

  return (
    <>
      <SettingsSubPageHeader
        title="מסמך היסטורי"
        subtitle="הופק במערכת אחרת"
        backHref={HISTORICAL_RECORDS_ROUTE}
      />
      <HistoricalRecordDetail
        recordId={recordId}
        recordsBase={HISTORICAL_RECORDS_ROUTE}
      />
    </>
  );
}
