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
        .dz-search-table { display: none; }
        .dz-search-inspector { display: none; }
        .dz-email-table { display: none; }
        .dz-email-explain { display: none; }
        .dz-email-import { display: none; }
        .dz-uniform-bottom { display: none !important; }
        .dz-upload-side { display: none; }
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
          .dz-search-page { max-width: none !important; }
          .dz-search-desk {
            display: grid;
            grid-template-columns: minmax(0, 1fr) minmax(280px, 340px);
            gap: 16px;
            align-items: start;
          }
          .dz-search-inspector {
            display: block !important;
            position: sticky;
            top: 16px;
            background: #fff;
            border: 1px solid rgba(120, 98, 64, 0.16);
            border-radius: 16px;
            padding: 16px;
          }
          .dz-search-inspector h2 { margin: 0 0 10px; font-size: 18px; }
          .dz-search-inspector p { margin: 0; color: #6f685c; line-height: 1.5; }
          .dz-search-inspector dl { margin: 0; display: grid; grid-template-columns: auto 1fr; gap: 8px 12px; }
          .dz-search-inspector dt { color: #8a8478; }
          .dz-search-inspector button {
            margin-top: 16px; width: 100%; height: 44px; border: 0; border-radius: 12px;
            background: #246966; color: #fff; font: inherit; font-weight: 600; cursor: pointer;
          }
          .dz-search-table tr.is-selected td { background: #f3efe6; }
          .dz-email-rows { display: none !important; }
          .dz-email-table {
            display: block !important;
            background: #fff;
            border: 1px solid rgba(120, 98, 64, 0.16);
            border-radius: 16px;
            overflow: auto;
          }
          .dz-email-table table { width: 100%; border-collapse: collapse; }
          .dz-email-table th, .dz-email-table td {
            text-align: start; padding: 12px 14px;
            border-bottom: 1px solid rgba(120, 98, 64, 0.12); font-size: 14px;
          }
          .dz-email-table th { font-size: 12px; font-weight: 600; color: #8a8478; background: #f7f4ed; }
          .dz-email-desk, .dz-email-connect {
            display: grid;
            grid-template-columns: minmax(280px, 340px) minmax(0, 1fr);
            gap: 16px;
            align-items: start;
          }
          .dz-email-side { position: sticky; top: 16px; }
          .dz-email-explain { display: block !important; }
          .dz-email-off { max-width: 960px !important; }
          .dz-email-import {
            display: inline-flex !important;
            align-items: center;
            height: 40px;
            padding: 0 14px;
            border: 0;
            border-radius: 12px;
            background: #246966;
            color: #fff;
            font: inherit;
            font-weight: 600;
            cursor: pointer;
            white-space: nowrap;
          }
          .dz-email-import:disabled { opacity: 0.65; cursor: not-allowed; }
          .dz-email-bottom { display: none !important; }
          .dz-report { max-width: none !important; margin-inline: auto; padding-inline: 32px !important; }
          .dz-report-layout {
            display: grid;
            grid-template-columns: minmax(280px, 340px) minmax(0, 1fr);
            gap: 16px;
            align-items: start;
          }
          .dz-report-side { position: sticky; top: 16px; align-self: start; }
          .dz-report-main { min-width: 0; display: flex; flex-direction: column; gap: 16px; }
          .dz-uniform { max-width: none !important; }
          .dz-uniform-desk {
            display: grid;
            grid-template-columns: minmax(280px, 420px) minmax(280px, 1fr);
            gap: 20px;
            align-items: start;
          }
          .dz-uniform-side { margin-top: 0 !important; position: sticky; top: 16px; }
          .dz-uniform-download { display: block !important; width: 100%; margin-top: 16px; }
          .dz-uniform-bottom { display: none !important; }
          .dz-upload { max-width: none !important; }
          .dz-upload-desk {
            display: grid;
            grid-template-columns: minmax(320px, 1.1fr) minmax(280px, 0.9fr);
            gap: 20px;
            align-items: start;
          }
          .dz-upload-span { grid-column: 1 / -1; }
          .dz-upload-side {
            display: block !important;
            position: sticky;
            top: 16px;
            background: #fff;
            border: 1px solid rgba(120, 98, 64, 0.16);
            border-radius: 16px;
            padding: 16px;
          }
          .dz-pack { max-width: 1120px !important; }
          .dz-pack-desk {
            display: grid;
            grid-template-columns: minmax(0, 1.15fr) minmax(280px, 0.85fr);
            gap: 20px;
            align-items: start;
          }
          .dz-pack-span { grid-column: 1 / -1; }
          .dz-pack-side { position: sticky; top: 16px; }
          .dz-pack-download { display: block !important; width: 100%; margin-top: 16px; }
          .dz-pack-bottom { display: none !important; }
        }
        @media (min-width: 1600px) {
          .dz-pack { max-width: none !important; }
          .dz-pack-desk { grid-template-columns: minmax(360px, 520px) minmax(360px, 1fr); }
          .dz-search-desk { grid-template-columns: minmax(0, 1fr) minmax(320px, 400px); }
          .dz-uniform-desk { grid-template-columns: minmax(360px, 480px) minmax(360px, 1fr); }
          .dz-upload-desk { grid-template-columns: minmax(420px, 640px) minmax(320px, 1fr); }
          .dz-email-desk, .dz-email-connect { grid-template-columns: minmax(320px, 380px) minmax(0, 1fr); }
        }
        .dz-uniform-side {
          margin-top: 18px;
          background: #fff;
          border: 1px solid rgba(120, 98, 64, 0.16);
          border-radius: 16px;
          padding: 16px;
        }
        .dz-uniform-side h2 { margin: 0 0 8px; font-size: 16px; }
        .dz-uniform-side ul { margin: 0; padding-inline-start: 18px; line-height: 1.7; }
        .dz-uniform-side p { margin: 12px 0 0; color: #6f685c; }
      `}</style>
      {children}
    </div>
  );
}
