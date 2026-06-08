import { NextResponse } from "next/server";
import { businessArchivedResponse } from "@/lib/auth";
import {
  AppError,
  BUSINESS_ARCHIVED_ERROR_CODE,
  BusinessArchivedError,
} from "@/lib/errors";

export function handleError(error: unknown) {
  if (error instanceof BusinessArchivedError) {
    return businessArchivedResponse();
  }

  if (error instanceof AppError) {
    if (error.code === BUSINESS_ARCHIVED_ERROR_CODE) {
      return businessArchivedResponse();
    }

    return NextResponse.json(
      {
        error: error.message,
        ...(error.code ? { code: error.code } : {}),
      },
      { status: error.statusCode }
    );
  }

  console.error("Unhandled error:", error);

  return NextResponse.json(
    {
      error: "Internal Server Error",
    },
    { status: 500 }
  );
}