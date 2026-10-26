/**
 * Bank file import (B1) — the browser side of /api/payables/bank-import. CLIENT-ONLY.
 *
 * The app authenticates API calls with a Bearer token kept in localStorage (lib/client-session); there is no
 * auth cookie. Every request here carries it. The upload is multipart, so only the Authorization header is
 * added — never a Content-Type (buildClientAuthHeaders would force application/json and break the boundary).
 */
import { getClientAuthToken } from "@/lib/client-session";

export type BankImportDecision = "IMPORT" | "SKIP";

/** The Authorization header for the current session, or nothing when signed out. */
export function bankImportAuthHeaders(): Record<string, string> {
  const token = getClientAuthToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export class BankImportRequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string
  ) {
    super(code || `HTTP_${status}`);
    this.name = "BankImportRequestError";
  }
}

/** True when bank file import is open for this business (the status route answers 404 while the flag is OFF). */
export async function fetchBankImportOpen(): Promise<boolean> {
  try {
    const res = await fetch("/api/payables/bank-import", { headers: bankImportAuthHeaders() });
    return res.ok;
  } catch {
    return false;
  }
}

/** The multipart body analyze and commit take. Decisions are keyed by row number. */
export function buildBankImportForm(input: {
  file: Blob & { name?: string };
  accountId: number;
  mapping?: Record<string, number | null> | null;
  token?: string | null;
  decisions?: Record<number, BankImportDecision> | null;
}): FormData {
  const body = new FormData();
  body.set("file", input.file, input.file.name ?? "statement");
  body.set("accountId", String(input.accountId));
  if (input.mapping) body.set("mapping", JSON.stringify(input.mapping));
  if (input.token) body.set("token", input.token);
  if (input.decisions && Object.keys(input.decisions).length) body.set("decisions", JSON.stringify(input.decisions));
  return body;
}

/** POST analyze or commit. Resolves to the JSON body; rejects with the HTTP status and the server's error code. */
export async function postBankImport<T>(step: "analyze" | "commit", body: FormData): Promise<T> {
  const res = await fetch(`/api/payables/bank-import/${step}`, { method: "POST", body, headers: bankImportAuthHeaders() });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new BankImportRequestError(res.status, typeof json.error === "string" ? json.error : "");
  return json as T;
}
