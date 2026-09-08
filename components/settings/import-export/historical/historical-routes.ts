/**
 * The two owner-facing routes of the historical fiscal flow.
 *
 * Declared once so the hub row, the import screen, the completion summary and
 * the records view all point at the same strings. A route typed out in four
 * places is a dead link waiting for the first rename.
 */

import { IMPORT_EXPORT_ROUTE } from "@/components/settings/import-export/import-export-release";

/** Upload a previous system's documents. */
export const HISTORICAL_IMPORT_ROUTE = `${IMPORT_EXPORT_ROUTE}/historical`;

/** Read what has already been taken in. Read-only, by construction. */
export const HISTORICAL_RECORDS_ROUTE = `${HISTORICAL_IMPORT_ROUTE}/records`;
