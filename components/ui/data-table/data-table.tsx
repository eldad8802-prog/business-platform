"use client";

import { useId, type ReactNode } from "react";

/**
 * DataTable — the minimal desktop CONTENT primitive (Desktop Content System).
 *
 * PRESENTATIONAL ONLY. It renders declarative columns over consumer-supplied rows
 * as a native, dense, RTL-correct table. It owns NOTHING else: no fetching, no
 * pagination, no sorting, no filtering, no selection model, no URL/business state,
 * no responsive/breakpoint decision, no grouping. The consumer owns all of that
 * and simply hands the primitive the rows it wants shown.
 *
 * Row-open a11y (see Artifact C design lock): the `<tr>` is pointer-clickable when
 * `onRowOpen` is set, and the FIRST column's cell content is wrapped in a real
 * focusable `<button>` — the keyboard / screen-reader open path, named by that
 * cell's text (e.g. the vendor). The inner button stops propagation so a click
 * never fires open twice. No `<tr tabindex>` fake-button, no `role="grid"`.
 */

export type DataTableColumn<Row> = {
  /** Stable column id. */
  key: string;
  /** Column header content (`<th scope="col">`). */
  header: ReactNode;
  /** Cell body for a row (`<td>`). */
  render: (row: Row) => ReactNode;
  /** Logical alignment of header + cells. Default "start". Money → "end". */
  align?: "start" | "end";
  /** Optional CSS track width (e.g. "1fr", "120px"). */
  width?: string;
};

export type DataTableProps<Row> = {
  columns: DataTableColumn<Row>[];
  rows: Row[];
  /** Row identity (stable React key + a11y). */
  getRowId: (row: Row) => string;
  /** Pointer + keyboard open handler. When set, rows become interactive. */
  onRowOpen?: (row: Row) => void;
  /** Accessible name for the table. */
  ariaLabel?: string;
};

export function DataTable<Row>({
  columns,
  rows,
  getRowId,
  onRowOpen,
  ariaLabel,
}: DataTableProps<Row>) {
  const scope = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const openable = !!onRowOpen;

  const css = `
[data-dt="${scope}"] { width: 100%; border-collapse: collapse; direction: rtl; table-layout: fixed; }
[data-dt="${scope}"] thead th {
  text-align: start; padding: 10px 12px; font-size: 12px; font-weight: 600;
  color: var(--dz-text-secondary); border-bottom: 1px solid rgba(52, 60, 50, 0.1); white-space: nowrap;
  letter-spacing: 0.2px;
}
[data-dt="${scope}"] tbody td {
  padding: 11px 12px; font-size: 14px; color: var(--dz-text-primary);
  border-bottom: 1px solid rgba(52, 60, 50, 0.06); vertical-align: middle;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
[data-dt="${scope}"] tbody tr.dt-openable { cursor: pointer; }
[data-dt="${scope}"] tbody tr.dt-openable:hover { background: rgba(36,105,102,0.045); }
[data-dt="${scope}"] .dt-open {
  appearance: none; background: none; border: 0; padding: 0; margin: 0;
  font: inherit; color: inherit; text-align: inherit; cursor: pointer;
  width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
[data-dt="${scope}"] .dt-open:focus-visible { outline: 2px solid var(--dz-brand); outline-offset: 2px; border-radius: 4px; }
`;

  return (
    <table data-dt={scope} aria-label={ariaLabel}>
      <style>{css}</style>
      <colgroup>
        {columns.map((c) => (
          <col key={c.key} style={c.width ? { width: c.width } : undefined} />
        ))}
      </colgroup>
      <thead>
        <tr>
          {columns.map((c) => (
            <th key={c.key} scope="col" style={{ textAlign: c.align ?? "start" }}>
              {c.header}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const id = getRowId(row);
          return (
            <tr
              key={id}
              className={openable ? "dt-openable" : undefined}
              onClick={openable ? () => onRowOpen!(row) : undefined}
            >
              {columns.map((c, ci) => {
                const content = c.render(row);
                return (
                  <td key={c.key} style={{ textAlign: c.align ?? "start" }}>
                    {openable && ci === 0 ? (
                      <button
                        type="button"
                        className="dt-open"
                        onClick={(e) => {
                          e.stopPropagation();
                          onRowOpen!(row);
                        }}
                      >
                        {content}
                      </button>
                    ) : (
                      content
                    )}
                  </td>
                );
              })}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
