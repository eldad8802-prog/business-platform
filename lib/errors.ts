export class AppError extends Error {
  statusCode: number;
  code?: string;

  constructor(message: string, statusCode: number, code?: string) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Unauthorized") {
    super(message, 401);
    this.name = "UnauthorizedError";
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "Forbidden", code?: string) {
    super(message, 403, code);
    this.name = "ForbiddenError";
  }
}

export const BUSINESS_ARCHIVED_ERROR_CODE = "BUSINESS_ARCHIVED" as const;

export const BUSINESS_ARCHIVED_MESSAGE =
  "העסק נמצא בארכיון. יש לפנות לתמיכה.";

export class BusinessArchivedError extends AppError {
  constructor(message = BUSINESS_ARCHIVED_MESSAGE) {
    super(message, 403, BUSINESS_ARCHIVED_ERROR_CODE);
    this.name = "BusinessArchivedError";
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Not Found") {
    super(message, 404);
    this.name = "NotFoundError";
  }
}

export class ValidationError extends AppError {
  constructor(message = "Validation Error") {
    super(message, 400);
    this.name = "ValidationError";
  }
}

export class ConflictError extends AppError {
  constructor(code = "NO_CHANGE", message?: string) {
    super(message ?? code, 409, code);
    this.name = "ConflictError";
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(message = "Feature access mutations are disabled") {
    super(message, 503);
    this.name = "ServiceUnavailableError";
  }
}