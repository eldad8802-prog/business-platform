/**
 * Service Desk 1.3b-C — the intake screen's calls. Same edge and errors as the 1.3a client (ServiceDeskApiError, the
 * session headers, one Idempotency-Key per user action, kept across a retry of that same action). Images and the slip are
 * read as blobs (the session travels in a header, so a bare <img src> could not carry it); the screen shows them through
 * object URLs it revokes.
 */
import { buildClientAuthHeaders } from "@/lib/client-session";

import { keyFor, settleKey } from "@/lib/tasks/tasks-client";

import { ServiceDeskApiError } from "./service-desk-client";

export type IntakeAllowed = { recordData: boolean; addPhoto: boolean; presentTerms: boolean; sign: boolean; createSlip: boolean };
export type IntakeView = {
  intake: {
    conditionNote: string | null; accessoriesNote: string | null; conditionRecorded: boolean; accessoriesRecorded: boolean;
    signed: boolean; signedAt: string | null; termsVersion: string | null; hasSignature: boolean; hasSlip: boolean;
  } | null;
  terms: { presentedAt: string; termsVersion: number; statutoryVersion: number; termsSha256: string; statutorySha256: string; termsBody: string; statutoryBody: string } | null;
  activeTerms: { termsVersion: number | null; statutoryVersion: number | null; approved: boolean };
  photos: { id: number; sha256: string; mimeType: string; byteSize: number; createdAt: string }[];
  history: { seq: number; step: string | null; occurredAt: string }[];
  case: { caseNumber: number; kind: string; status: string; version: number };
  allowed: IntakeAllowed;
};
type CommandAnswer = { case: { version: number }; replayed: boolean };

const base = (caseId: number) => `/api/service-desk/cases/${caseId}/intake`;

async function send(method: "GET" | "PUT" | "POST", url: string, body?: BodyInit, contentType?: string, key?: string, timeoutMs = 30000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      cache: "no-store",
      signal: controller.signal,
      headers: buildClientAuthHeaders({ ...(contentType ? { "Content-Type": contentType } : {}), ...(key ? { "Idempotency-Key": key } : {}) }),
      ...(body !== undefined ? { body } : {}),
    });
  } catch {
    throw new ServiceDeskApiError(null, null);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const details = data.details && typeof data.details === "object" ? (data.details as Record<string, unknown>) : null;
    throw new ServiceDeskApiError(res.status, typeof data.error === "string" ? data.error : null, details);
  }
  return res;
}
const asJson = async <T>(r: Promise<Response>) => (await (await r).json()) as T;

export const getIntake = (caseId: number) => asJson<IntakeView>(send("GET", base(caseId)));

/**
 * One key per intent (same pattern as the 1.3a settings save): a second tap or a retry after a lost answer sends the same
 * key and gets the stored answer; the key is released once the server answered (success or a definite refusal).
 */
async function once<T>(intent: string, run: (key: string) => Promise<T>): Promise<T> {
  const key = keyFor(intent);
  try {
    const r = await run(key);
    settleKey(intent);
    return r;
  } catch (e) {
    if (e instanceof ServiceDeskApiError && e.status !== null) settleKey(intent);
    throw e;
  }
}

export type IntakeDataBody = { conditionNote: string | null; accessoriesNote: string | null; conditionRecorded: boolean; accessoriesRecorded: boolean; expectedVersion: number };

export const saveIntakeData = (caseId: number, body: IntakeDataBody) =>
  once(`service-desk/intake:${caseId}:data:${JSON.stringify(body)}`, (key) => asJson<CommandAnswer>(send("PUT", base(caseId), JSON.stringify(body), "application/json", key)));

export const presentTerms = (caseId: number, expectedVersion: number) =>
  once(`service-desk/intake:${caseId}:terms:${expectedVersion}`, (key) => asJson<CommandAnswer>(send("POST", `${base(caseId)}/terms`, JSON.stringify({ expectedVersion }), "application/json", key)));

/** `photoId` names the picked file (its size + time), so a retry of the same pick reuses the key. */
export const uploadPhoto = (caseId: number, blob: Blob, expectedVersion: number, photoId: string) =>
  once(`service-desk/intake:${caseId}:photo:${photoId}`, (key) => asJson<CommandAnswer>(send("POST", `${base(caseId)}/photos?expectedVersion=${expectedVersion}`, blob, blob.type, key, 60000)));

export const signIntake = (caseId: number, signaturePngBase64: string, expectedVersion: number) =>
  once(`service-desk/intake:${caseId}:sign:${signaturePngBase64.length}:${signaturePngBase64.slice(-32)}`, (key) =>
    asJson<CommandAnswer>(send("POST", `${base(caseId)}/sign`, JSON.stringify({ signaturePngBase64, expectedVersion }), "application/json", key)));

export const createSlip = (caseId: number, expectedVersion: number) =>
  once(`service-desk/intake:${caseId}:slip`, (key) => asJson<CommandAnswer>(send("POST", `${base(caseId)}/slip`, JSON.stringify({ expectedVersion }), "application/json", key, 60000)));

/** A stored photo, the signature or the slip, as a blob (the screen turns it into an object URL and revokes it). */
export async function fetchIntakeBlob(caseId: number, what: { kind: "photo"; id: number } | { kind: "signature" } | { kind: "slip" }): Promise<Blob> {
  const url = what.kind === "photo" ? `${base(caseId)}/photos/${what.id}` : what.kind === "signature" ? `${base(caseId)}/signature` : `${base(caseId)}/slip`;
  return (await send("GET", url)).blob();
}
