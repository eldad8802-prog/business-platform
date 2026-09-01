export function getClientAuthToken(): string | null {
  if (typeof window === "undefined") return null;

  try {
    return localStorage.getItem("token");
  } catch {
    return null;
  }
}

export function clearClientSession(): void {
  if (typeof window === "undefined") return;

  try {
    localStorage.removeItem("token");
    localStorage.removeItem("user");
  } catch {
    /* ignore */
  }
}

export function redirectToLogin(): void {
  if (typeof window === "undefined") return;

  clearClientSession();

  try {
    window.location.replace(`${window.location.origin}/login`);
  } catch {
    /* ignore */
  }
}

export function buildClientAuthHeaders(
  extra?: Record<string, string>
): Record<string, string> {
  const token = getClientAuthToken();

  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...extra,
  };
}

export function isUnauthorizedError(error: unknown): boolean {
  return error instanceof Error && error.message === "UNAUTHORIZED";
}
