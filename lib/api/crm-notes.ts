import { buildClientAuthHeaders } from "@/lib/client-session";

export type CrmSubjectType = "CUSTOMER" | "SUPPLIER";

export type CrmNoteDTO = {
  id: number;
  body: string;
  createdAt: string;
  updatedAt: string;
  author: { id: number | null; name: string | null };
  canEdit: boolean;
  canDelete: boolean;
};

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init?: RequestInit,
  timeoutMs = 15000
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new Error("הבקשה ארכה זמן רב מדי. בדקו את החיבור ונסו שוב.");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function parseError(res: Response, fallback: string): Promise<never> {
  let message = fallback;
  try {
    const data = await res.json();
    if (data?.error) message = data.error;
  } catch {
    /* ignore */
  }
  throw new Error(message);
}

function subjectBase(subjectType: CrmSubjectType, subjectId: number): string {
  return `/api/crm/subjects/${subjectType}/${subjectId}/notes`;
}

export async function getNotes(
  subjectType: CrmSubjectType,
  subjectId: number
): Promise<CrmNoteDTO[]> {
  const res = await fetchWithTimeout(subjectBase(subjectType, subjectId), {
    method: "GET",
    headers: buildClientAuthHeaders(),
    cache: "no-store",
  });
  if (res.status === 401) throw new Error("UNAUTHORIZED");
  if (!res.ok) return parseError(res, "לא הצלחנו לטעון את ההערות");
  const data = await res.json();
  return data.notes || [];
}

export async function createNote(
  subjectType: CrmSubjectType,
  subjectId: number,
  body: string
): Promise<CrmNoteDTO> {
  const res = await fetchWithTimeout(subjectBase(subjectType, subjectId), {
    method: "POST",
    headers: buildClientAuthHeaders(),
    body: JSON.stringify({ body }),
  });
  if (res.status === 401) throw new Error("UNAUTHORIZED");
  if (!res.ok) return parseError(res, "לא הצלחנו לשמור את ההערה");
  const data = await res.json();
  return data.note;
}

export async function updateNote(noteId: number, body: string): Promise<CrmNoteDTO> {
  const res = await fetchWithTimeout(`/api/crm/notes/${noteId}`, {
    method: "PATCH",
    headers: buildClientAuthHeaders(),
    body: JSON.stringify({ body }),
  });
  if (res.status === 401) throw new Error("UNAUTHORIZED");
  if (!res.ok) return parseError(res, "לא הצלחנו לעדכן את ההערה");
  const data = await res.json();
  return data.note;
}

export async function deleteNote(noteId: number): Promise<void> {
  const res = await fetchWithTimeout(`/api/crm/notes/${noteId}`, {
    method: "DELETE",
    headers: buildClientAuthHeaders(),
  });
  if (res.status === 401) throw new Error("UNAUTHORIZED");
  if (!res.ok) return parseError(res, "לא הצלחנו למחוק את ההערה");
}
