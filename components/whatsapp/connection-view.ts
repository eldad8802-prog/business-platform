/**
 * Pure decisions behind the WhatsApp connection surfaces — kept out of React so
 * they are unit-tested (`connection-view.test.ts`).
 *
 *  - {@link connectionStateFromResponse}: the read-only status response →
 *    the hook's state. A failed read is `error`, never "not connected".
 *  - {@link settingsViewFor}: that state → what /settings/whatsapp shows.
 *
 * Display only. Which statuses still RECEIVE messages is the server's rule
 * (M2 `connectionAcceptsInbound`); nothing here changes it.
 */
import type { WhatsAppConnectionState, WhatsAppPublicConnection } from "./use-whatsapp-connection";

function toPublicConnection(conn: Record<string, unknown>): WhatsAppPublicConnection {
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const isoOrNull = (v: unknown) => (typeof v === "string" ? v : null);
  return {
    status: str(conn.status),
    displayPhoneNumber: str(conn.displayPhoneNumber),
    phoneNumberId: str(conn.phoneNumberId),
    wabaId: str(conn.wabaId),
    lastVerifiedAt: isoOrNull(conn.lastVerifiedAt),
    updatedAt: isoOrNull(conn.updatedAt),
  };
}

/** `httpStatus` null = the request itself failed (network). */
export function connectionStateFromResponse(
  httpStatus: number | null,
  data: unknown
): WhatsAppConnectionState {
  if (httpStatus === null || httpStatus < 200 || httpStatus >= 300) {
    return { phase: "error", httpStatus };
  }
  const raw = (data as { connection?: unknown } | null)?.connection;
  if (raw === undefined) {
    // A 2xx without the expected shape is not proof of "no connection".
    return { phase: "error", httpStatus };
  }
  if (!raw || typeof raw !== "object") {
    return { phase: "disconnected", previousStatus: null, displayPhoneNumber: null, connection: null };
  }
  const conn = toPublicConnection(raw as Record<string, unknown>);
  if (conn.status === "CONNECTED") {
    return { phase: "connected", connection: conn };
  }
  return {
    phase: "disconnected",
    previousStatus: conn.status || null,
    displayPhoneNumber: conn.displayPhoneNumber || null,
    connection: conn,
  };
}

/** Rows that still receive customer messages but need the owner's attention. */
export const ATTENTION_STATUSES = ["REVOKED_BY_META", "ERROR"] as const;

export type SettingsView =
  | { kind: "loading" }
  | { kind: "load_error"; httpStatus: number | null }
  | { kind: "none" }
  | { kind: "connected"; connection: WhatsAppPublicConnection }
  | { kind: "attention"; connection: WhatsAppPublicConnection }
  | { kind: "disconnected"; connection: WhatsAppPublicConnection };

export function settingsViewFor(state: WhatsAppConnectionState): SettingsView {
  switch (state.phase) {
    case "loading":
      return { kind: "loading" };
    case "error":
      return { kind: "load_error", httpStatus: state.httpStatus };
    case "connected":
      return { kind: "connected", connection: state.connection };
    case "disconnected": {
      const conn = state.connection;
      if (!conn) return { kind: "none" };
      if ((ATTENTION_STATUSES as readonly string[]).includes(conn.status)) {
        return { kind: "attention", connection: conn };
      }
      return { kind: "disconnected", connection: conn };
    }
  }
}
