/**
 * i18n area: api (server-produced text). Hebrew (source) + English. Registered in ../he.ts and ../en.ts.
 */
import type { Widen } from "../types";

export const apiHe = {} as const;

export const apiEn: Widen<typeof apiHe> = {};
