/**
 * i18n area: documents. Hebrew (source) + English for this product area only — each area owns its own
 * file so areas can be translated independently. Registered in ../he.ts and ../en.ts.
 */
import type { Widen } from "../types";

export const documentsHe = {} as const;

export const documentsEn: Widen<typeof documentsHe> = {};
