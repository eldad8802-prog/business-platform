/**
 * Server-side log for an unexpected route failure (L-12).
 *
 * Logs the error's class name and, for Prisma, its code — never the message,
 * stack or the error object: those carry query parameters, customer text,
 * phone numbers and connection details. The HTTP response never carries any
 * of it either; callers return a generic body.
 */
export function logRouteError(label: string, error: unknown): void {
  const name = error instanceof Error ? error.name : typeof error;
  const code =
    error && typeof error === "object" && "code" in error && typeof (error as { code: unknown }).code === "string"
      ? (error as { code: string }).code.slice(0, 16)
      : undefined;
  console.error(JSON.stringify({ event: "route_error", route: label, name, ...(code ? { code } : {}) }));
}
