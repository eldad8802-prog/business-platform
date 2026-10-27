/**
 * Public booking page — the four doors it talks to (segment 1, already live and closed by default). No session,
 * no cookie: every call is anonymous; the server answers 404 for anything that is not open.
 */
import type { JerusalemDayKey } from "@/lib/utils/jerusalem-day";

import type { ManageWire, ProfileWire, SlotsWire, SubmitWire } from "./public-booking-model";

export type Answer<T> = { ok: true; status: number; data: T } | { ok: false; status: number; code?: string; message?: string; details?: unknown };

async function call<T>(path: string, init?: RequestInit): Promise<Answer<T>> {
  let res: Response;
  try {
    res = await fetch(path, { ...init, cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer" });
  } catch {
    return { ok: false, status: 0, code: "NETWORK" };
  }
  let body: Record<string, unknown> | null = null;
  try { body = await res.json(); } catch { body = null; }
  if (res.ok && body) return { ok: true, status: res.status, data: body as T };
  // Two shapes: the booking doors answer { error: CODE, message: Hebrew }; the rate limiter { error: Hebrew, code }.
  const err = typeof body?.error === "string" ? body.error : undefined;
  const hebrew = (v: string | undefined) => (v && /[֐-׿]/.test(v) ? v : undefined);
  return {
    ok: false,
    status: res.status,
    code: typeof body?.code === "string" ? body.code : hebrew(err) ? undefined : err,
    message: typeof body?.message === "string" ? body.message : hebrew(err),
    details: body?.details,
  };
}

const base = (publicId: string) => `/api/public/booking/${encodeURIComponent(publicId)}`;

export const getProfile = (publicId: string) => call<ProfileWire>(base(publicId));

export function getSlots(publicId: string, q: { serviceId: number; staffId: number | null; fromDay: JerusalemDayKey; toDay: JerusalemDayKey }) {
  const p = new URLSearchParams({ serviceId: String(q.serviceId), fromDay: q.fromDay, toDay: q.toDay });
  if (q.staffId !== null) p.set("staffId", String(q.staffId));
  return call<SlotsWire>(`${base(publicId)}/slots?${p.toString()}`);
}

export type SubmitBody = { serviceId: number; staffId?: number; startsAt: string; name: string; phone: string; note?: string; website: string };

export function submitRequest(publicId: string, key: string, body: SubmitBody) {
  return call<SubmitWire>(`${base(publicId)}/requests`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify(body),
  });
}

export function manage(token: string, action: "view" | "cancel") {
  return call<ManageWire>("/api/public/booking/manage", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, action }),
  });
}
