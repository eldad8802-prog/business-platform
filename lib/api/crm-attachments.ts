import { buildClientAuthHeaders, getClientAuthToken } from "@/lib/client-session";

export type CrmSubjectType = "CUSTOMER" | "SUPPLIER";

export type CrmAttachmentDTO = {
  id: number;
  originalFileName: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
  uploader: { id: number | null; name: string | null };
  canDelete: boolean;
};

/** MIME types the picker offers — must mirror the server allowlist. */
export const ATTACHMENT_ACCEPT = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain",
  "text/csv",
].join(",");

function base(subjectType: CrmSubjectType, subjectId: number): string {
  return `/api/crm/subjects/${subjectType}/${subjectId}/attachments`;
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

export async function getAttachments(
  subjectType: CrmSubjectType,
  subjectId: number
): Promise<CrmAttachmentDTO[]> {
  const res = await fetch(base(subjectType, subjectId), {
    method: "GET",
    headers: buildClientAuthHeaders(),
    cache: "no-store",
  });
  if (res.status === 401) throw new Error("UNAUTHORIZED");
  if (!res.ok) return parseError(res, "לא הצלחנו לטעון את הקבצים");
  const data = await res.json();
  return data.attachments || [];
}

/**
 * Upload via XMLHttpRequest so we can report REAL upload progress (fetch cannot).
 * `onProgress` receives 0..100 when the length is computable.
 */
export function uploadAttachment(
  subjectType: CrmSubjectType,
  subjectId: number,
  file: File,
  onProgress?: (percent: number | null) => void
): Promise<CrmAttachmentDTO> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", base(subjectType, subjectId));
    const token = getClientAuthToken();
    if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    // Do NOT set Content-Type — the browser adds the multipart boundary.

    xhr.upload.onprogress = (e) => {
      if (!onProgress) return;
      onProgress(e.lengthComputable ? Math.round((e.loaded / e.total) * 100) : null);
    };
    xhr.onload = () => {
      if (xhr.status === 401) return reject(new Error("UNAUTHORIZED"));
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText).attachment as CrmAttachmentDTO);
        } catch {
          reject(new Error("תגובת שרת לא תקינה"));
        }
        return;
      }
      let message = "לא הצלחנו להעלות את הקובץ";
      try {
        const j = JSON.parse(xhr.responseText);
        if (j?.error) message = j.error;
      } catch {
        /* ignore */
      }
      reject(new Error(message));
    };
    xhr.onerror = () => reject(new Error("שגיאת רשת בהעלאת הקובץ"));

    const fd = new FormData();
    fd.append("file", file);
    xhr.send(fd);
  });
}

export async function deleteAttachment(attachmentId: number): Promise<void> {
  const res = await fetch(`/api/crm/attachments/${attachmentId}`, {
    method: "DELETE",
    headers: buildClientAuthHeaders(),
  });
  if (res.status === 401) throw new Error("UNAUTHORIZED");
  if (!res.ok) return parseError(res, "לא הצלחנו למחוק את הקובץ");
}

/** Authenticated download → blob → browser save (the file route needs the Bearer token). */
export async function downloadAttachment(
  attachmentId: number,
  fileName: string
): Promise<void> {
  const res = await fetch(`/api/crm/attachments/${attachmentId}/file`, {
    method: "GET",
    headers: buildClientAuthHeaders(),
    cache: "no-store",
  });
  if (res.status === 401) throw new Error("UNAUTHORIZED");
  if (!res.ok) return parseError(res, "לא הצלחנו להוריד את הקובץ");
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName || "file";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
