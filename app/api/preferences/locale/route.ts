/**
 * POST /api/preferences/locale — sets the interface language for this browser.
 *
 * Writes only the `dz_locale` cookie: no tenant data, no amounts, no permissions are touched, so it
 * needs no session (the login screen can switch language too). Unknown values are refused, never
 * coerced. While the i18n release flag is off the endpoint does not exist (404) and the app keeps
 * rendering Hebrew.
 */
import { NextResponse } from "next/server";

import { isI18nEnabled, isLocale, LOCALE_COOKIE, LOCALE_COOKIE_MAX_AGE_SECONDS } from "@/lib/i18n/config";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!isI18nEnabled()) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });

  let locale: unknown;
  try {
    locale = ((await req.json()) as { locale?: unknown } | null)?.locale;
  } catch {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }
  if (!isLocale(locale)) return NextResponse.json({ error: "UNSUPPORTED_LOCALE" }, { status: 400 });

  const res = NextResponse.json({ locale });
  res.cookies.set(LOCALE_COOKIE, locale, {
    path: "/",
    maxAge: LOCALE_COOKIE_MAX_AGE_SECONDS,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    httpOnly: false,
  });
  return res;
}
