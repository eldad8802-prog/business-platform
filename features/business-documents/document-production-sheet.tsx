"use client";

/**
 * "הפקת מסמך" — the entry the invoices screen opens. The list itself (document-production-panel.tsx, with its own
 * stylesheet) loads only when it is opened: it renders after a tap, so its code and CSS stay out of the invoices
 * page's first load and server HTML. Same props, same component.
 */
import dynamic from "next/dynamic";

export const DocumentProductionSheet = dynamic(
  () => import("./document-production-panel").then((m) => m.DocumentProductionPanel),
  { ssr: false }
);
