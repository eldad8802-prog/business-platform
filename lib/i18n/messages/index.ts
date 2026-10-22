import type { Locale } from "../config";
import { en } from "./en";
import { he } from "./he";
import type { Messages } from "./types";

const DICTIONARIES: Readonly<Record<Locale, Messages>> = { he, en };

export function getMessages(locale: Locale): Messages {
  return DICTIONARIES[locale];
}

export type { Messages };
