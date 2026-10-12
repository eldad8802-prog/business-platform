/**
 * "This browser has signed in to this account before" — a signed, httpOnly cookie issued on a
 * SUCCESSFUL sign-in, sent only to /api/auth/login. It is NOT a credential: it authenticates nothing
 * and skips no check. Its one effect is to give that browser its OWN failed-sign-in ledger
 * (lib/auth/account-rate-key.ts), so a stranger hammering an address cannot lock the owner out of a
 * device the owner already uses. Without it, anyone who knows an address could keep it locked forever.
 *
 * Value: `<nonce>.<expiresAtSeconds>.<sig>`, sig = HMAC over the account digest, nonce and expiry under
 * a key derived from AUTH_TOKEN_SECRET (domain-separated). The address is not in the cookie; a cookie
 * minted for one account does not verify for another, cannot be forged, and expires after 90 days.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import type { NextResponse } from "next/server";

import { accountDigest } from "@/lib/auth/account-rate-key";

export const LOGIN_DEVICE_COOKIE = "dubiz_ld";
const PATH = "/api/auth/login";
const MAX_AGE_SECONDS = 90 * 24 * 60 * 60;

function key(): Buffer | null {
  const raw = process.env.AUTH_TOKEN_SECRET?.trim();
  return raw ? createHmac("sha256", raw).update("dubiz:login-device:v1").digest() : null;
}

function sign(k: Buffer, digest: string, nonce: string, exp: number): string {
  return createHmac("sha256", k).update(`${digest}.${nonce}.${exp}`).digest("base64url");
}

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/** The device nonce when the request carries a valid, unexpired cookie for THIS address; else null. */
export function readLoginDevice(req: Request, normalizedEmail: string, nowMs = Date.now()): string | null {
  const k = key();
  const value = readCookie(req, LOGIN_DEVICE_COOKIE);
  if (!k || !value || value.length > 200) return null;
  const [nonce, expRaw, sig] = value.split(".");
  if (!nonce || !expRaw || !sig || !/^[A-Za-z0-9_-]{22}$/.test(nonce) || !/^\d{1,12}$/.test(expRaw)) return null;
  const exp = Number(expRaw);
  if (exp * 1000 <= nowMs) return null;
  const expected = Buffer.from(sign(k, accountDigest(normalizedEmail), nonce, exp));
  const given = Buffer.from(sig);
  return expected.length === given.length && timingSafeEqual(expected, given) ? nonce : null;
}

/** On a successful sign-in: keep this browser's nonce (or mint one) and extend the cookie. */
export function setLoginDevice(res: NextResponse, normalizedEmail: string, nonce: string | null, nowMs = Date.now()): void {
  const k = key();
  if (!k) return;
  const n = nonce ?? randomBytes(16).toString("base64url");
  const exp = Math.floor(nowMs / 1000) + MAX_AGE_SECONDS;
  res.cookies.set({
    name: LOGIN_DEVICE_COOKIE,
    value: `${n}.${exp}.${sign(k, accountDigest(normalizedEmail), n, exp)}`,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: PATH,
    maxAge: MAX_AGE_SECONDS,
  });
}
