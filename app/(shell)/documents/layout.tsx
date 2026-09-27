import type { Metadata } from "next";
import { ReactNode } from "react";
import { layout } from "./ui";

// Server layout (pure presentational wrapper — no client APIs) so it can carry
// the section title. Heebo is loaded globally (app/layout.tsx exposes
// --font-heebo app-wide), so the Documents feature simply inherits it — no
// scoped font loader here. The `layout` style re-asserts the Heebo stack and
// the font-synthesis guard.
export const metadata: Metadata = { title: "מסמכים" };

export default function DocumentsLayout({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <div style={layout}>
      <style>{`
        @media (min-width: 1200px) {
          .dz-doc-wide { max-width: none !important; padding-inline: 32px !important; }
          .dz-search-cards { display: none !important; }
          .dz-search-table {
            display: block !important;
            margin-top: 16px;
            background: #fff;
            border: 1px solid rgba(120, 98, 64, 0.16);
            border-radius: 16px;
            overflow: auto;
          }
          .dz-search-table table { width: 100%; border-collapse: collapse; }
          .dz-search-table th,
          .dz-search-table td {
            text-align: start;
            padding: 12px 14px;
            border-bottom: 1px solid rgba(120, 98, 64, 0.12);
            font-size: 14px;
          }
          .dz-search-table th {
            font-size: 12px;
            font-weight: 600;
            color: #8a8478;
            background: #f7f4ed;
          }
          .dz-search-table tbody tr:hover td { background: #f7f4ed; }
          .dz-email-rows {
            display: grid !important;
            grid-template-columns: repeat(2, minmax(0, 1fr));
            gap: 12px;
            align-items: start;
          }
          .dz-report { max-width: 1120px !important; margin-inline: auto; padding-inline: 32px !important; }
          .dz-report-grid {
            display: grid;
            grid-template-columns: minmax(0, 1.15fr) minmax(280px, 0.85fr);
            gap: 16px;
            align-items: start;
          }
          .dz-report-span { grid-column: 1 / -1; }
        }
        .dz-search-table { display: none; }
      `}</style>
      {children}
    </div>
  );
}
