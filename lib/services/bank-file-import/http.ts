/**
 * The HTTP edge of bank file import (milestone B1). SERVER-ONLY.
 *
 *   - authenticated owner only (401); the business comes from the session, never from the request;
 *   - the `bank_file_import` flag: OFF ⇒ 404, as if the route did not exist;
 *   - BankImportError ⇒ its status + a stable code; anything else ⇒ 500 with no detail.
 */
import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { IMPORT_MAX_FILE_BYTES } from "@/lib/data-transfer/import/import-config";
import { PLATFORM_FEATURE_KEYS } from "@/lib/services/feature-access/platform-feature-catalog";
import { resolveFeatureAccess } from "@/lib/services/feature-access/resolve-feature-access";
import { runWithTenantContext } from "@/lib/tenant/context";
import { BANK_FIELDS, type BankMapping } from "./bank-file-core";
import { BankImportError, type BankImportInput, type SuspectDecisions } from "./bank-file-import.service";

const NO_STORE = { "Cache-Control": "private, no-store" } as const;

export type BankImportActor = { businessId: number; userId: number };

/** True when the business has bank file import. Fail-closed: any error reads as OFF. */
export async function bankFileImportEnabled(businessId: number): Promise<boolean> {
  try {
    const r = await runWithTenantContext({ businessId }, () =>
      resolveFeatureAccess(businessId, PLATFORM_FEATURE_KEYS.BANK_FILE_IMPORT)
    );
    return r.allowed === true;
  } catch {
    return false;
  }
}

/**
 * ON / OFF / UNKNOWN (the resolution failed). The old statement upload uses it to refuse when bank file import
 * is ON — and, fail-closed, when it cannot tell — so a business with B1 has no way to upload a statement
 * without an account. OFF ⇒ the old upload works exactly as before.
 */
export async function bankFileImportState(businessId: number): Promise<"ON" | "OFF" | "UNKNOWN"> {
  try {
    const r = await runWithTenantContext({ businessId }, () =>
      resolveFeatureAccess(businessId, PLATFORM_FEATURE_KEYS.BANK_FILE_IMPORT)
    );
    return r.allowed === true ? "ON" : "OFF";
  } catch {
    return "UNKNOWN";
  }
}

export async function bankImportRoute(
  req: Request,
  handler: (actor: BankImportActor) => Promise<Response>
): Promise<Response> {
  try {
    const user = await getCurrentUser(req);
    if (!user || !user.businessId) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });
    if (!(await bankFileImportEnabled(user.businessId))) {
      return NextResponse.json({ error: "Not found" }, { status: 404, headers: NO_STORE });
    }
    return await runWithTenantContext({ businessId: user.businessId }, () =>
      handler({ businessId: user.businessId, userId: user.id })
    );
  } catch (e) {
    return bankImportError(e);
  }
}

export function bankImportError(e: unknown): Response {
  if (e instanceof BankImportError) {
    return NextResponse.json(
      { error: e.code, ...(Object.keys(e.detail).length ? { details: e.detail } : {}) },
      { status: e.status, headers: NO_STORE }
    );
  }
  console.error("[bank-file-import] unexpected error", e instanceof Error ? e.name : "unknown");
  return NextResponse.json({ error: "INTERNAL" }, { status: 500, headers: NO_STORE });
}

export function json(body: unknown, status = 200): Response {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

function parseMapping(raw: FormDataEntryValue | null): BankMapping | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BankImportError("MAPPING_INVALID", 400, { problem: "MALFORMED" });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new BankImportError("MAPPING_INVALID", 400, { problem: "MALFORMED" });
  }
  const out: BankMapping = {};
  for (const field of BANK_FIELDS) {
    if (!(field in (parsed as Record<string, unknown>))) continue;
    const v = (parsed as Record<string, unknown>)[field];
    if (v === null) out[field] = undefined;
    else if (typeof v === "number" && Number.isInteger(v) && v >= 0) out[field] = v;
    else throw new BankImportError("MAPPING_INVALID", 400, { problem: "MALFORMED", field });
  }
  return out;
}

function parseDecisions(raw: FormDataEntryValue | null): SuspectDecisions | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BankImportError("DECISIONS_INVALID", 400);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new BankImportError("DECISIONS_INVALID", 400);
  const out: SuspectDecisions = {};
  for (const [row, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (!/^d+$/.test(row) || (v !== "IMPORT" && v !== "SKIP")) throw new BankImportError("DECISIONS_INVALID", 400);
    out[Number(row)] = v;
  }
  return out;
}

/** The multipart body both analyze and commit take: file, account, optional sheet and mapping (and token). */
export async function readImportForm(
  req: Request,
  actor: BankImportActor
): Promise<{ input: BankImportInput; token: FormDataEntryValue | null; decisions: SuspectDecisions | null }> {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw new BankImportError("FILE_UNREADABLE", 400, { reason: "INVALID_BODY" });
  }
  const file = form.get("file");
  if (!(file instanceof File)) throw new BankImportError("FILE_UNREADABLE", 400, { reason: "FILE_MISSING" });
  // Declared size first (cheap), then the actual bytes: `file.size` is client-reported.
  if (typeof file.size === "number" && file.size > IMPORT_MAX_FILE_BYTES) {
    throw new BankImportError("FILE_UNREADABLE", 413, { reason: "FILE_TOO_LARGE" });
  }
  const bytes = Buffer.from(await file.arrayBuffer());
  if (bytes.length > IMPORT_MAX_FILE_BYTES) throw new BankImportError("FILE_UNREADABLE", 413, { reason: "FILE_TOO_LARGE" });

  const accountRaw = form.get("accountId");
  const accountId = typeof accountRaw === "string" && /^\d+$/.test(accountRaw) ? Number(accountRaw) : null;
  const sheetRaw = form.get("sheet");
  const sheetName = typeof sheetRaw === "string" && sheetRaw.trim() !== "" ? sheetRaw.slice(0, 200) : null;

  return {
    input: {
      businessId: actor.businessId,
      userId: actor.userId,
      accountId,
      filename: file.name || "upload",
      bytes,
      sheetName,
      mapping: parseMapping(form.get("mapping")),
    },
    token: form.get("token"),
    decisions: parseDecisions(form.get("decisions")),
  };
}
