"use client";

/**
 * The English dictionary's own client chunk. I18nProvider loads this module through `next/dynamic`
 * ONLY when the request's locale is English, so:
 *   - the dictionary ships as a content-hashed static JS file under /_next/static (immutable, cached by
 *     the browser across page loads and identical for every English user — it holds no user data),
 *     instead of being serialized into every HTML document / RSC payload as a provider prop;
 *   - Hebrew users never download it (nothing on a Hebrew page references this module);
 *   - it still renders on the server (next/dynamic SSR), so the HTML is already English and hydration
 *     sees the very same dictionary object.
 */
import type { ReactNode } from "react";

import { en } from "@/lib/i18n/messages/en";

import { buildI18nValue, I18nContext } from "./I18nProvider";

const EN = buildI18nValue("en", en);

export default function EnglishI18nProvider({ children }: { children: ReactNode }) {
  return <I18nContext.Provider value={EN}>{children}</I18nContext.Provider>;
}
