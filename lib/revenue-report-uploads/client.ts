/**
 * Revenue report uploads — the browser side of /api/money/revenue-reports. CLIENT-ONLY.
 *
 * Like bank file import (lib/bank-file-import/bank-import-client.ts): API calls carry the session's Bearer token
 * (there is no auth cookie); multipart bodies get only the Authorization header — never a Content-Type, which would
 * break the boundary. The server's Hebrew `message` is kept so the screen shows exactly what the server said.
 */
import { getClientAuthToken } from "@/lib/client-session";

export type ReportKind = "z" | "settlement";
export type ConflictDecision = "SKIP" | "SUPERSEDE" | "ADD";

export function reportAuthHeaders(): Record<string, string> {
  const token = getClientAuthToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export class ReportRequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly serverMessage: string | null
  ) {
    super(code || `HTTP_${status}`);
    this.name = "ReportRequestError";
  }
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}

function fail(res: Response, body: Record<string, unknown>): never {
  throw new ReportRequestError(
    res.status,
    typeof body.error === "string" ? body.error : "",
    typeof body.message === "string" ? body.message : null
  );
}

/** GET the list (and which kinds are open). 404 ⇒ neither kind is open for this business. */
export async function fetchRevenueReports<T>(): Promise<T> {
  const res = await fetch("/api/money/revenue-reports", { cache: "no-store", headers: reportAuthHeaders() });
  const body = await readJson(res);
  if (!res.ok) fail(res, body);
  return body as T;
}

export function buildReportForm(input: {
  file: Blob & { name?: string };
  token?: string | null;
  decisions?: Record<number, ConflictDecision> | null;
}): FormData {
  const body = new FormData();
  body.set("file", input.file, input.file.name ?? "report");
  if (input.token) body.set("token", input.token);
  if (input.decisions && Object.keys(input.decisions).length) body.set("decisions", JSON.stringify(input.decisions));
  return body;
}

/** POST analyze or commit for one kind. Resolves to the JSON body; rejects with status, code and Hebrew message. */
export async function postReport<T>(kind: ReportKind, step: "analyze" | "commit", body: FormData): Promise<T> {
  const res = await fetch(`/api/money/revenue-reports/${kind}/${step}`, { method: "POST", body, headers: reportAuthHeaders() });
  const json = await readJson(res);
  if (!res.ok) fail(res, json);
  return json as T;
}
