import type {
  WhatsAppWebhookMessageSummary,
  WhatsAppWebhookParseResult,
} from "./types";

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v : null;
}

function mediaIdFromMessage(msg: Record<string, unknown>): string | null {
  const type = asString(msg.type);
  if (!type) return null;

  const block = asRecord(msg[type]);
  if (block) {
    const id = asString(block.id);
    if (id) return id;
  }

  return null;
}

/**
 * Extract the user-typed body for a Meta `type=text` message.
 *
 * Meta payload shape:
 *   { "type": "text", "text": { "body": "<user message>" }, ... }
 *
 * Returns null for non-text types and for empty/whitespace bodies so the
 * downstream router can STOP rather than route an empty conversation.
 */
function textBodyFromMessage(msg: Record<string, unknown>): string | null {
  const type = asString(msg.type);
  if (!type || type !== "text") return null;
  const block = asRecord(msg.text);
  if (!block) return null;
  const body = asString(block.body);
  if (!body) return null;
  const trimmed = body.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseMessage(
  msg: unknown,
  phoneNumberId: string | null
): WhatsAppWebhookMessageSummary | null {
  const record = asRecord(msg);
  if (!record) return null;

  return {
    phoneNumberId,
    from: asString(record.from),
    wamid: asString(record.id),
    type: asString(record.type),
    mediaId: mediaIdFromMessage(record),
    textBody: textBodyFromMessage(record),
  };
}

/**
 * The ONLY WhatsApp webhook event class this application supports.
 *
 * Meta delivers every subscribed event through the same envelope
 * (`entry[].changes[]`), distinguished by `change.field`. Before this check,
 * acceptance was decided purely by whether a change happened to carry a
 * `value.messages[]` array — a SHAPE, not an event class. That made the
 * boundary depend on Meta continuing not to emit a messages-shaped array under
 * some other field, which is an assumption about the provider rather than a
 * property of this code.
 *
 * Restricting to `field === "messages"` states the contract explicitly. It can
 * only narrow what is accepted: the parser, routing gate and both intakes are
 * built exclusively around this field's payload shape
 * (`value.messages[]` + `value.metadata.phone_number_id`).
 */
const SUPPORTED_CHANGE_FIELD = "messages";

/**
 * Extracts a minimal, safe structure from a Meta WhatsApp Cloud API webhook body.
 * Does not validate signature or process messages.
 *
 * Only changes whose `field` is the supported event class contribute messages.
 * Anything else — delivery/read `statuses`, template or account events, or any
 * future subscription — is counted and dropped here, before the caller's
 * dispatch loop, so it can never reach tenant resolution, an external Meta
 * call, storage, or the database.
 */
export function parseWhatsAppWebhookPayload(body: unknown): WhatsAppWebhookParseResult {
  const root = asRecord(body);
  const object = root ? asString(root.object) : null;

  const entries = root && Array.isArray(root.entry) ? root.entry : [];
  const messages: WhatsAppWebhookMessageSummary[] = [];
  let changeCount = 0;
  let unsupportedChangeCount = 0;

  for (const entry of entries) {
    const entryRec = asRecord(entry);
    const changes =
      entryRec && Array.isArray(entryRec.changes) ? entryRec.changes : [];

    for (const change of changes) {
      changeCount += 1;
      const changeRec = asRecord(change);

      // ── event-class boundary ──────────────────────────────────────────
      // Checked BEFORE `value` is read, so an unsupported class is never
      // inspected for a messages array at all.
      if (asString(changeRec?.field ?? null) !== SUPPORTED_CHANGE_FIELD) {
        unsupportedChangeCount += 1;
        continue;
      }

      const value = changeRec ? asRecord(changeRec.value) : null;
      if (!value) continue;

      const metadata = asRecord(value.metadata);
      const phoneNumberId = metadata ? asString(metadata.phone_number_id) : null;

      const msgList = Array.isArray(value.messages) ? value.messages : [];
      for (const msg of msgList) {
        const parsed = parseMessage(msg, phoneNumberId);
        if (parsed) messages.push(parsed);
      }
    }
  }

  return {
    object,
    entryCount: entries.length,
    changeCount,
    unsupportedChangeCount,
    messages,
  };
}
