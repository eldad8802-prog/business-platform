import type { Metadata } from "next";
import { getServerI18n } from "@/lib/i18n/server";
import { ReactNode } from "react";
import { Heebo } from "next/font/google";
import { layout } from "./ui";

// The approved documents language sets screen titles heavier than the app-wide
// Heebo (300–600). This one weight is loaded here, so it is preloaded on the
// /documents routes only, and applied to h1 titles inside the documents scope.
const heeboDisplay = Heebo({
  subsets: ["hebrew", "latin"],
  weight: "800",
  display: "swap",
  variable: "--font-docs-display",
});

// Server layout (pure presentational wrapper — no client APIs) so it can carry
// the section title. Heebo 300–600 is loaded globally (app/layout.tsx exposes
// --font-heebo app-wide); the one extra title weight (800) is loaded below for
// the documents routes only. The `layout` style re-asserts the Heebo stack and
// the font-synthesis guard.
// Tab title in the interface language (Hebrew source "מסמכים": lib/i18n/messages/he.ts → meta.titles.documents).
export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerI18n();
  return { title: t("meta.titles.documents") };
}

export default function DocumentsLayout({
  children,
}: {
  children: ReactNode;
}) {
  return (
    // data-dz-docs scopes the documents palette (app/dubiz-mist.css) to this subtree.
    <div style={layout} data-dz-docs="1" className={heeboDisplay.variable}>
      <style>{`
        .dz-docs-back {
          display: inline-flex; align-items: center; gap: 4px;
          min-height: 44px; padding: 0 6px; margin-inline-start: -6px;
          border: 0; border-radius: 12px; background: none;
          color: var(--dz-text-primary); font: inherit; font-size: 17px; font-weight: 500;
          white-space: nowrap; cursor: pointer; -webkit-tap-highlight-color: transparent;
        }
        .dz-docs-back:hover { background: var(--dz-surface-muted); }
        .dz-docs-back:focus-visible { outline: 3px solid var(--dz-focus-ring-color); outline-offset: 2px; }
        .dz-docs-back:dir(ltr) .dz-docs-back__chev { transform: scaleX(-1); }
        [data-dz-docs="1"] h1 {
          font-family: var(--font-docs-display), var(--font-heebo), "Heebo", system-ui, sans-serif !important;
          font-weight: 800 !important;
          letter-spacing: -0.4px;
        }
        .dz-search-table { display: none; }
        .dz-search-inspector { display: none; }
        .dz-email-table { display: none; }
        .dz-email-import { display: none; }
        /* Gmail extended scan (B3-b): the import bar sits ABOVE the shell's phone navigation
           (components/navigation/bottom-bar.tsx: 84px + safe area, below 768px), and the page
           keeps room under the last card for both. */
        .dz-email-import-row { display: none; }
        .dz-email-bottom { bottom: 0; z-index: 90; }
        .dz-email-page { padding-bottom: 130px; }
        @media (max-width: 767px) {
          .dz-email-bottom { bottom: calc(84px + env(safe-area-inset-bottom, 0px)); }
          .dz-email-page { padding-bottom: calc(84px + 150px + env(safe-area-inset-bottom, 0px)); }
        }
        .dz-uniform-bottom { display: none !important; }
        .dz-upload-side { display: none; }
        @media (min-width: 1200px) {
          .dz-doc-wide { max-width: none !important; padding-inline: 32px !important; }
          .dz-search-cards { display: none !important; }
          .dz-search-table {
            display: block !important;
            margin-top: 16px;
            background: var(--dz-surface-flat);
            border: 1px solid var(--dz-border);
            border-radius: 16px;
            overflow: auto;
          }
          .dz-search-table table { width: 100%; border-collapse: collapse; }
          .dz-search-table th,
          .dz-search-table td {
            text-align: start;
            padding: 12px 14px;
            border-bottom: 1px solid var(--dz-border-subtle);
            font-size: 14px;
          }
          .dz-search-table th {
            font-size: 12px;
            font-weight: 600;
            color: var(--dz-text-muted);
            background: var(--dz-surface-muted);
          }
          .dz-search-table tbody tr:hover td { background: var(--dz-surface-muted); }
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
            background: var(--dz-surface-flat);
            border: 1px solid var(--dz-border);
            border-radius: 16px;
            padding: 16px;
          }
          .dz-search-inspector h2 { margin: 0 0 10px; font-size: 18px; }
          .dz-search-inspector p { margin: 0; color: var(--dz-text-secondary); line-height: 1.5; }
          .dz-search-inspector dl { margin: 0; display: grid; grid-template-columns: auto 1fr; gap: 8px 12px; }
          .dz-search-inspector dt { color: var(--dz-text-muted); }
          .dz-search-inspector button {
            margin-top: 16px; width: 100%; height: 44px; border: 0; border-radius: 12px;
            background: var(--dz-action-primary); color: var(--dz-text-on-brand); font: inherit; font-weight: 600; cursor: pointer;
          }
          .dz-search-table tr.is-selected td { background: var(--dz-brand-soft); }
          .dz-email-rows { display: none !important; }
          .dz-email-table {
            display: block !important;
            background: var(--dz-surface-flat);
            border: 1px solid var(--dz-border);
            border-radius: 16px;
            overflow: auto;
          }
          .dz-email-table table { width: 100%; border-collapse: collapse; }
          .dz-email-table th, .dz-email-table td {
            text-align: start; padding: 12px 14px;
            border-bottom: 1px solid var(--dz-border-subtle); font-size: 14px;
          }
          .dz-email-table th { font-size: 12px; font-weight: 600; color: var(--dz-text-muted); background: var(--dz-surface-muted); }
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
            background: var(--dz-action-primary);
            color: var(--dz-text-on-brand);
            font: inherit;
            font-weight: 600;
            cursor: pointer;
            white-space: nowrap;
          }
          .dz-email-import:disabled { opacity: 0.65; cursor: not-allowed; }
          .dz-email-bottom { display: none !important; }
          .dz-email-page { padding-bottom: 40px; }
          .dz-email-import-row { display: block; margin-top: 16px; }
          .dz-email-import-row .dz-email-import-controls { width: auto !important; margin: 0 !important; max-width: 420px; }
          .dz-email-table td:nth-child(2) { min-width: 220px; }
          .dz-email-table td:nth-child(3), .dz-email-table th:nth-child(3),
          .dz-email-table td:nth-child(4) { white-space: nowrap; width: 1%; }
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
            background: var(--dz-surface-flat);
            border: 1px solid var(--dz-border);
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
          background: var(--dz-surface-flat);
          border: 1px solid var(--dz-border);
          border-radius: 16px;
          padding: 16px;
        }
        .dz-uniform-side h2 { margin: 0 0 8px; font-size: 16px; }
        .dz-uniform-side ul { margin: 0; padding-inline-start: 18px; line-height: 1.7; }
        .dz-uniform-side p { margin: 12px 0 0; color: var(--dz-text-secondary); }
      `}</style>
      {children}
    </div>
  );
}
