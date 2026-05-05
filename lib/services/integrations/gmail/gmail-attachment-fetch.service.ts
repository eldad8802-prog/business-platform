function base64UrlToBuffer(input: string): Buffer {
  const b64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const padLen = (4 - (b64.length % 4)) % 4;
  const padded = b64 + "=".repeat(padLen);
  return Buffer.from(padded, "base64");
}

type GmailAttachmentResponse = {
  data?: string; // base64url
  size?: number;
};

async function gmailFetchJson<T>(url: string, accessToken: string): Promise<T> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Gmail API failed (${res.status}): ${text || res.statusText}`
    );
  }

  return (await res.json()) as T;
}

export async function fetchGmailAttachmentBytes(params: {
  accessToken: string;
  messageId: string;
  attachmentId: string;
}): Promise<{ bytes: Buffer; sizeBytes: number | null }> {
  const url = new URL(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(
      params.messageId
    )}/attachments/${encodeURIComponent(params.attachmentId)}`
  );

  const json = await gmailFetchJson<GmailAttachmentResponse>(
    url.toString(),
    params.accessToken
  );

  const data = String(json.data || "");
  if (!data) {
    return { bytes: Buffer.from([]), sizeBytes: json.size ?? null };
  }

  const bytes = base64UrlToBuffer(data);
  return { bytes, sizeBytes: json.size ?? bytes.length };
}

