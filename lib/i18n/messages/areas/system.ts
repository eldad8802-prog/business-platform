/**
 * i18n area: system (server-produced text). Hebrew (source) + English. Registered in ../he.ts and ../en.ts.
 */
import type { Widen } from "../types";

export const systemHe = {} as const;

export const systemEn: Widen<typeof systemHe> = {};
