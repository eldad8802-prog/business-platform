import { NextResponse } from "next/server";
import { AppError } from "@/lib/errors";
import { reportError } from "@/lib/observability/report-error";

export function handleError(error: unknown) {
  if (error instanceof AppError) {
    return NextResponse.json(
      {
        error: error.message,
        ...(error.code ? { code: error.code } : {}),
      },
      { status: error.statusCode }
    );
  }

  // SEC-F: scrubbed (no tokens, cookies, emails, phones, IBAN/card/ID-like
  // numbers) and routed through the reporter adapter — console by default.
  reportError(error, { source: "handleError" });

  return NextResponse.json(
    {
      error: "Internal Server Error",
    },
    { status: 500 }
  );
}