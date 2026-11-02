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
    public readonly code: string,
    public readonly details: Record<string, string | number> = {}
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
  /** Commit only: the account shown on the preview that the owner confirmed. */
  confirmAccountId?: number | null;
  /** Commit only: how many lines already held under another account the owner confirmed. */
  confirmCrossAccount?: number | null;
}): FormData {
  const body = new FormData();
  body.set("file", input.file, input.file.name ?? "statement");
  body.set("accountId", String(input.accountId));
  if (input.mapping) body.set("mapping", JSON.stringify(input.mapping));
  if (input.token) body.set("token", input.token);
  if (input.decisions && Object.keys(input.decisions).length) body.set("decisions", JSON.stringify(input.decisions));
  if (typeof input.confirmAccountId === "number") body.set("confirmAccountId", String(input.confirmAccountId));
  if (typeof input.confirmCrossAccount === "number" && input.confirmCrossAccount > 0) body.set("confirmCrossAccount", String(input.confirmCrossAccount));
  return body;
}

/** POST analyze or commit. Resolves to the JSON body; rejects with the HTTP status and the server's error code. */
export async function postBankImport<T>(step: "analyze" | "commit", body: FormData): Promise<T> {
  const res = await fetch(`/api/payables/bank-import/${step}`, { method: "POST", body, headers: bankImportAuthHeaders() });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const details = json.details && typeof json.details === "object" && !Array.isArray(json.details) ? (json.details as Record<string, string | number>) : {};
    throw new BankImportRequestError(res.status, typeof json.error === "string" ? json.error : "", details);
  }
  return json as T;
}

/** What the file's own account number said about the chosen account (preview.account.numberCheck). */
export type BankAccountNumberCheck = "VERIFIED_FULL" | "PARTIAL_MATCH" | "NOT_IN_FILE";

/**
 * The preview's sentence about the target account. Only VERIFIED_FULL — the full account (bank, branch,
 * account) printed in the file compared with the chosen one — may say "verified" (אומת). A last-four match
 * says plainly that the account is NOT verified; a file without a number says it cannot identify the account.
 * The owner confirms the account in every case.
 */
export function accountCheckText(check: BankAccountNumberCheck): string {
  if (check === "VERIFIED_FULL") return "החשבון אומת: מספר החשבון המלא שמופיע בקובץ (בנק, סניף וחשבון) הוא של החשבון הזה.";
  if (check === "PARTIAL_MATCH") {
    return "החשבון לא אומת. רק 4 הספרות האחרונות של מספר החשבון בקובץ תואמות לחשבון הזה, וזה לא מספיק כדי לדעת שזה אותו חשבון. ודאו בעצמכם שבחרתם את החשבון הנכון.";
  }
  return "הקובץ לא מאפשר לזהות את החשבון: לא מופיע בו מספר חשבון שאפשר לבדוק. ודאו בעצמכם שבחרתם את החשבון הנכון.";
}
