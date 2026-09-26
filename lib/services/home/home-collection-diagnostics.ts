import { Prisma } from "@prisma/client";
import type { NextResponse } from "next/server";

import { AppError } from "@/lib/errors";
import { handleError } from "@/lib/handle-error";

/**
 * DIAGNOSTICS for GET /api/home/collection — observability only.
 *
 * A real phone showed "נתוני הגבייה לא נטענו כרגע" and there was no server-side
 * evidence to say why. This makes the next genuine failure of the route
 * diagnosable: one structured line, `home_collection_failed`, carrying the
 * Prisma error CODE when there is one (P2028, P2024, anything else) — and
 * nothing that identifies a business, a person or an amount.
 *
 * It changes no behaviour. The route's work runs exactly as before; on failure
 * the SAME error goes to the SAME `handleError`, so the status, the body and the
 * client's FAILED state are unchanged. Nothing is retried, swallowed or
 * defaulted, and success emits nothing.
 *
 * SAFETY — an explicit allowlist. Every field below is built here from a
 * constrained value; the error object itself, its message, its `meta`, its
 * stack and the request are never serialised. (`handleError` still writes its
 * own pre-existing line for unhandled errors; this module does not touch it.)
 */

export const HOME_COLLECTION_FAILED_EVENT = "home_collection_failed" as const;
export const HOME_COLLECTION_ROUTE = "/api/home/collection" as const;

export type HomeCollectionFailureCategory =
  | "prisma_known_request" // has a Pxxxx code: P2028, P2024, ...
  | "prisma_unknown_request"
  | "prisma_initialization"
  | "prisma_rust_panic"
  | "prisma_validation"
  | "tenant_context"
  | "app_error"
  | "other";

export type HomeCollectionFailureEvent = {
  event: typeof HOME_COLLECTION_FAILED_EVENT;
  route: typeof HOME_COLLECTION_ROUTE;
  /** The period the service resolved — the same normalisation it applies. */
  period: "today" | "yesterday" | "week";
  durationMs: number;
  /** The status `handleError` will answer with for this error. */
  httpStatus: number;
  category: HomeCollectionFailureCategory;
  errorClass: string;
  /** Prisma's own code (`Pxxxx`) when it gives one; null otherwise — never guessed. */
  errorCode: string | null;
  /** Vercel's request id, for matching this line to the platform request log. */
  requestId: string | null;
  region: string | null;
};

const PRISMA_CODE = /^P\d{4}$/;
const SAFE_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
// x-vercel-id looks like "fra1::iad1::abcde-1700000000000-0123456789ab".
const SAFE_REQUEST_ID = /^[A-Za-z0-9:_-]{1,128}$/;
const SAFE_REGION = /^[a-z]{2,4}\d{1,2}$/;

function periodOf(url: string): HomeCollectionFailureEvent["period"] {
  try {
    const raw = new URL(url).searchParams.get("period");
    return raw === "yesterday" || raw === "week" ? raw : "today";
  } catch {
    return "today";
  }
}

function safe(value: unknown, pattern: RegExp): string | null {
  return typeof value === "string" && pattern.test(value) ? value : null;
}

/** The class and code of an error, and nothing else about it. */
export function classifyHomeCollectionError(error: unknown): {
  category: HomeCollectionFailureCategory;
  errorClass: string;
  errorCode: string | null;
  httpStatus: number;
} {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return {
      category: "prisma_known_request",
      errorClass: "PrismaClientKnownRequestError",
      errorCode: safe(error.code, PRISMA_CODE),
      httpStatus: 500,
    };
  }
  if (error instanceof Prisma.PrismaClientUnknownRequestError) {
    return { category: "prisma_unknown_request", errorClass: "PrismaClientUnknownRequestError", errorCode: null, httpStatus: 500 };
  }
  if (error instanceof Prisma.PrismaClientInitializationError) {
    return {
      category: "prisma_initialization",
      errorClass: "PrismaClientInitializationError",
      errorCode: safe(error.errorCode, PRISMA_CODE),
      httpStatus: 500,
    };
  }
  if (error instanceof Prisma.PrismaClientRustPanicError) {
    return { category: "prisma_rust_panic", errorClass: "PrismaClientRustPanicError", errorCode: null, httpStatus: 500 };
  }
  if (error instanceof Prisma.PrismaClientValidationError) {
    return { category: "prisma_validation", errorClass: "PrismaClientValidationError", errorCode: null, httpStatus: 500 };
  }
  // Mirrors handleError: an AppError answers with its own status, anything else is a 500.
  if (error instanceof AppError) {
    return {
      category: "app_error",
      errorClass: safe(error.name, SAFE_NAME) ?? "AppError",
      errorCode: null,
      httpStatus: error.statusCode,
    };
  }
  const name = error instanceof Error ? safe(error.name, SAFE_NAME) : null;
  return {
    category: name === "TenantContextError" ? "tenant_context" : "other",
    errorClass: name ?? (error instanceof Error ? "Error" : typeof error),
    errorCode: null,
    httpStatus: 500,
  };
}

export function buildHomeCollectionFailureEvent(
  error: unknown,
  ctx: { url: string; requestId: string | null; region: string | null; durationMs: number }
): HomeCollectionFailureEvent {
  return {
    event: HOME_COLLECTION_FAILED_EVENT,
    route: HOME_COLLECTION_ROUTE,
    period: periodOf(ctx.url),
    durationMs: Math.max(0, Math.round(ctx.durationMs)),
    ...classifyHomeCollectionError(error),
    requestId: safe(ctx.requestId, SAFE_REQUEST_ID),
    region: safe(ctx.region, SAFE_REGION),
  };
}

type Emit = (line: string) => void;
const emitToLog: Emit = (line) => console.error(line);

/**
 * Runs the route's work; on a failure the server answers with a 5xx, records one
 * safe line, then hands the SAME error to the SAME `handleError`.
 *
 * Expected client errors (401/403/400 — an AppError below 500) are not
 * recorded here: they are not collection failures, and the platform request
 * log already carries their status.
 */
export async function withHomeCollectionDiagnostics(
  req: { url: string; headers: { get(name: string): string | null } },
  work: () => Promise<NextResponse>,
  emit: Emit = emitToLog
): Promise<NextResponse> {
  const startedAt = Date.now();
  try {
    return await work();
  } catch (error) {
    try {
      const event = buildHomeCollectionFailureEvent(error, {
        url: req.url,
        requestId: req.headers.get("x-vercel-id"),
        region: process.env.VERCEL_REGION ?? null,
        durationMs: Date.now() - startedAt,
      });
      if (event.httpStatus >= 500) emit(JSON.stringify(event));
    } catch {
      // Diagnostics must never change the answer. The original error wins.
    }
    return handleError(error);
  }
}
