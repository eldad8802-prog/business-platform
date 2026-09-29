import type {
  WhatsAppReferralSummary,
  WhatsAppWebhookMessageSummary,
  WhatsAppWebhookParseResult,
  WhatsAppWebhookStatusSummary,
} from "./types";

/** Upper bound for any string copied out of the payload into a summary. */
const FIELD_MAX = 500;

function bounded(v: string | null, max = FIELD_MAX): string | null {
  return v === null ? null : v.slice(0, max);
}

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

/**
 * `value.contacts[]` → wa_id → profile name. Meta sends the sender's profile
 * alongside the messages it describes; matched on wa_id, never by position.
 */
function profileNamesFromContacts(value: Record<string, unknown>): Map<string, string> {
  const names = new Map<string, string>();
  const contacts = Array.isArray(value.contacts) ? value.contacts : [];
  for (const c of contacts) {
    const rec = asRecord(c);
    if (!rec) continue;
    const waId = asString(rec.wa_id);
    const profile = asRecord(rec.profile);
    const name = profile ? asString(profile.name) : null;
    if (waId && name) names.set(waId, name.slice(0, FIELD_MAX));
  }
  return names;
}

/**
 * Click-to-WhatsApp referral. Only the ad-side identifiers survive: body text,
 * media urls and thumbnails are dropped — they are the ad's creative, not
 * attribution, and some can be large.
 */
function referralFromMessage(msg: Record<string, unknown>): WhatsAppReferralSummary | null {
  const ref = asRecord(msg.referral);
  if (!ref) return null;
  const summary: WhatsAppReferralSummary = {
    sourceType: bounded(asString(ref.source_type), 50),
    sourceId: bounded(asString(ref.source_id), 200),
    sourceUrl: bounded(asString(ref.source_url)),
    headline: bounded(asString(ref.headline), 300),
    ctwaClid: bounded(asString(ref.ctwa_clid), 300),
  };
  return Object.values(summary).some((v) => v !== null) ? summary : null;
}

function parseMessage(
  msg: unknown,
  phoneNumberId: string | null,
  profileNames: Map<string, string>
): WhatsAppWebhookMessageSummary | null {
  const record = asRecord(msg);
  if (!record) return null;

  const from = asString(record.from);
  return {
    phoneNumberId,
    from,
    wamid: asString(record.id),
    type: asString(record.type),
    mediaId: mediaIdFromMessage(record),
    textBody: textBodyFromMessage(record),
    timestamp: bounded(asString(record.timestamp), 20),
    profileName: from ? (profileNames.get(from) ?? null) : null,
    referral: referralFromMessage(record),
  };
}

/** A delivery / read / failed receipt. The recipient's number is not copied. */
function parseStatus(
  s: unknown,
  phoneNumberId: string | null
): WhatsAppWebhookStatusSummary | null {
  const record = asRecord(s);
  if (!record) return null;
  const errors = Array.isArray(record.errors) ? record.errors : [];
  const firstError = asRecord(errors[0]);
  const code = firstError ? firstError.code : null;
  return {
    phoneNumberId,
    wamid: bounded(asString(record.id), 200),
    status: bounded(asString(record.status)?.toLowerCase() ?? null, 20),
    timestamp: bounded(asString(record.timestamp), 20),
    errorCode:
      typeof code === "number" || typeof code === "string" ? String(code).slice(0, 20) : null,
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
 * Only changes whose `field` is the supported event class contribute anything.
 * Every other field — template or account events, any future subscription — is
 * counted and dropped here, before the caller's dispatch loop, so it can never
 * reach tenant resolution, an external Meta call, storage, or the database.
 *
 * Within the supported field, Meta delivers two different things:
 *   - `value.messages[]` — what a customer sent → `messages`;
 *   - `value.statuses[]` — receipts for what the BUSINESS sent → `statuses`.
 * They are kept in separate lists on purpose (M2): a receipt describes an
 * outbound message and can never be dispatched as a customer message.
 */
export function parseWhatsAppWebhookPayload(body: unknown): WhatsAppWebhookParseResult {
  const root = asRecord(body);
  const object = root ? asString(root.object) : null;

  const entries = root && Array.isArray(root.entry) ? root.entry : [];
  const messages: WhatsAppWebhookMessageSummary[] = [];
  const statuses: WhatsAppWebhookStatusSummary[] = [];
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

      const profileNames = profileNamesFromContacts(value);
      const msgList = Array.isArray(value.messages) ? value.messages : [];
      for (const msg of msgList) {
        const parsed = parseMessage(msg, phoneNumberId, profileNames);
        if (parsed) messages.push(parsed);
      }

      const statusList = Array.isArray(value.statuses) ? value.statuses : [];
      for (const s of statusList) {
        const parsed = parseStatus(s, phoneNumberId);
        if (parsed) statuses.push(parsed);
      }
    }
  }

  return {
    object,
    entryCount: entries.length,
    changeCount,
    unsupportedChangeCount,
    messages,
    statuses,
  };
}
