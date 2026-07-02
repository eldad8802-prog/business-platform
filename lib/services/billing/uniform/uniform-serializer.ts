/**
 * WP2.4 — Layout-driven fixed-width serializer (spec 1.31).
 *
 * Takes a record layout + a values map (keyed by field id) and produces a
 * fixed-width record STRING (without CRLF). Each field is formatted per its
 * kind; the total length is asserted against the layout. `CRLF` is appended by
 * the record-line helpers (spec §2.4.ט(2): CR(13)+LF(10) after each record,
 * NOT counted in the record length).
 */

import {
  formatAlpha,
  formatDate,
  formatNumeric,
  formatSignedAmount,
  formatTime,
  formatUnsignedAmount,
} from "@/lib/services/billing/uniform/uniform-field-format";
import type { RecordLayout } from "@/lib/services/billing/uniform/uniform-layout-1_31";

export const CRLF = "\r\n";

export type FieldValues = Record<number, string | number | null | undefined>;

/** Serialize one record to a fixed-width string (no CRLF). */
export function serializeRecord(layout: RecordLayout, values: FieldValues): string {
  let out = "";
  for (const f of layout.fields) {
    let cell: string;
    switch (f.kind.k) {
      case "CONST":
        cell = formatAlpha(f.kind.value, f.len);
        break;
      case "ALPHA":
        cell = formatAlpha(values[f.id] == null ? "" : String(values[f.id]), f.len);
        break;
      case "NUM":
        cell = formatNumeric(values[f.id], f.len);
        break;
      case "AMOUNT":
        cell = formatSignedAmount(values[f.id], f.len, f.kind.frac);
        break;
      case "UNUM":
        cell = formatUnsignedAmount(values[f.id], f.len, f.kind.frac);
        break;
      case "DATE":
        cell = formatDate(values[f.id] == null ? null : String(values[f.id]));
        break;
      case "TIME":
        cell = formatTime(values[f.id] == null ? null : String(values[f.id]));
        break;
    }
    if (cell.length !== f.len) {
      throw new Error(
        `${layout.code} field ${f.id}: formatted length ${cell.length} != ${f.len}`
      );
    }
    out += cell;
  }
  if (out.length !== layout.length) {
    throw new Error(`${layout.code}: record length ${out.length} != ${layout.length}`);
  }
  return out;
}

/** Serialize a record and append CRLF. */
export function serializeRecordLine(layout: RecordLayout, values: FieldValues): string {
  return serializeRecord(layout, values) + CRLF;
}
