/**
 * Run: npx tsx lib/services/integrations/whatsapp/webhook-event-class-boundary.test.ts
 *
 * WhatsApp webhook EVENT-CLASS BOUNDARY.
 *
 * A read-only audit found that acceptance was decided by payload SHAPE rather
 * than by event class: `change.field` was never read, so any change carrying a
 * `value.messages[]` array reached the dispatch loop — and, if it satisfied the
 * routing conditions, mutated state. Nothing rejected a non-messages field; it
 * was inert only because Meta happens not to emit messages-shaped arrays under
 * other fields. That is an assumption about the provider, not a property of
 * this code.
 *
 * The case that matters here is #4: a deliberately hostile change with a
 * NON-messages field carrying a perfectly well-formed `value.messages[]` array.
 * Before the boundary it produced a dispatchable message; after it, it produces
 * nothing. Everything else in this file exists to prove that narrowing the
 * class did not break the classes we actually support.
 *
 * Deterministic and OFFLINE — pure parser and verifier functions, no database,
 * no network, no Meta call. Routing/intake behaviour is covered by the existing
 * pr2/pr3/pr4 suites and is deliberately not duplicated.
 *
 * NOT in scope: CASA 7.2.3. No timestamp is extracted and no tolerance window
 * is enforced by this change.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { parseWhatsAppWebhookPayload } from "./webhook-parse.service";
import { verifyWebhookSignature } from "./webhook-verify.service";
import { createHmac } from "node:crypto";

let pass = 0;
const ok = (label: string, condition: boolean) => {
  assert.ok(condition, label);
  pass += 1;
};

/** Meta envelope with a caller-chosen `field` and `value`. */
function envelope(field: string, value: unknown): unknown {
  return {
    object: "whatsapp_business_account",
    entry: [{ id: "WABA_ID", changes: [{ field, value }] }],
  };
}

function messageValue(message: Record<string, unknown>): unknown {
  return {
    metadata: { phone_number_id: "123456789" },
    messages: [message],
  };
}

const TEXT_MSG = {
  from: "972501234567",
  id: "wamid.text.1",
  timestamp: "1710000000",
  type: "text",
  text: { body: "שלום" },
};
const IMAGE_MSG = {
  from: "972501234567",
  id: "wamid.image.1",
  timestamp: "1710000000",
  type: "image",
  image: { id: "media-image-1", mime_type: "image/jpeg" },
};
const DOCUMENT_MSG = {
  from: "972501234567",
  id: "wamid.doc.1",
  timestamp: "1710000000",
  type: "document",
  document: { id: "media-doc-1", mime_type: "application/pdf" },
};

function main() {
  // ── 1-3. the supported class still reaches dispatch, unchanged ───────────
  for (const [label, msg, expectedType] of [
    ["text", TEXT_MSG, "text"],
    ["image", IMAGE_MSG, "image"],
    ["document", DOCUMENT_MSG, "document"],
  ] as const) {
    const parsed = parseWhatsAppWebhookPayload(
      envelope("messages", messageValue(msg))
    );
    ok(`${label}: contributes exactly one message`, parsed.messages.length === 1);
    ok(`${label}: type preserved`, parsed.messages[0].type === expectedType);
    ok(`${label}: wamid preserved`, parsed.messages[0].wamid === msg.id);
    ok(
      `${label}: phoneNumberId resolved from metadata`,
      parsed.messages[0].phoneNumberId === "123456789"
    );
    ok(`${label}: not counted as unsupported`, parsed.unsupportedChangeCount === 0);
  }

  // ── 4. ADVERSARIAL — the whole point of this suite ───────────────────────
  // A non-messages field carrying a fully valid messages[] array. Before the
  // boundary this dispatched; it must now contribute nothing.
  for (const field of [
    "statuses",
    "message_template_status_update",
    "account_update",
    "smb_message_echoes",
    "phone_number_quality_update",
    "",
  ]) {
    const parsed = parseWhatsAppWebhookPayload(
      envelope(field, messageValue(TEXT_MSG))
    );
    ok(
      `hostile field "${field || "(empty)"}" with a crafted messages[] contributes NOTHING`,
      parsed.messages.length === 0
    );
    ok(
      `hostile field "${field || "(empty)"}" is counted as unsupported`,
      parsed.unsupportedChangeCount === 1
    );
    ok(
      `hostile field "${field || "(empty)"}" still counted as a change received`,
      parsed.changeCount === 1
    );
  }

  // A missing `field` key entirely — must not fall through to acceptance.
  {
    const parsed = parseWhatsAppWebhookPayload({
      object: "whatsapp_business_account",
      entry: [{ id: "W", changes: [{ value: messageValue(TEXT_MSG) }] }],
    });
    ok("absent field contributes nothing", parsed.messages.length === 0);
    ok("absent field counted as unsupported", parsed.unsupportedChangeCount === 1);
  }

  // A non-string `field` must not coerce its way past the check.
  for (const bogus of [123, true, null, {}, ["messages"]]) {
    const parsed = parseWhatsAppWebhookPayload({
      object: "whatsapp_business_account",
      entry: [
        { id: "W", changes: [{ field: bogus, value: messageValue(TEXT_MSG) }] },
      ],
    });
    ok(
      `non-string field ${JSON.stringify(bogus)} contributes nothing`,
      parsed.messages.length === 0
    );
  }

  // ── 5. statuses[] without messages[] remains inert ───────────────────────
  {
    const parsed = parseWhatsAppWebhookPayload(
      envelope("statuses", {
        metadata: { phone_number_id: "123456789" },
        statuses: [
          { id: "wamid.text.1", status: "delivered", timestamp: "1710000000" },
        ],
      })
    );
    ok("statuses: no messages contributed", parsed.messages.length === 0);
    ok("statuses: counted as unsupported", parsed.unsupportedChangeCount === 1);
  }

  // Even under the SUPPORTED field, a statuses-only value contributes nothing —
  // delivery/read receipts are still not a supported feature.
  {
    const parsed = parseWhatsAppWebhookPayload(
      envelope("messages", {
        metadata: { phone_number_id: "123456789" },
        statuses: [{ id: "wamid.text.1", status: "read" }],
      })
    );
    ok(
      "statuses under the supported field still contribute nothing",
      parsed.messages.length === 0
    );
    ok(
      "statuses under the supported field are not 'unsupported class'",
      parsed.unsupportedChangeCount === 0
    );
  }

  // ── 6. unsupported message types stay inert at the routing layer ─────────
  // The parser deliberately summarises every message; STOP happens downstream.
  // Asserted here only so a future parser-level filter change is visible.
  for (const type of ["audio", "video", "sticker", "location", "reaction"]) {
    const parsed = parseWhatsAppWebhookPayload(
      envelope(
        "messages",
        messageValue({ from: "972501234567", id: `wamid.${type}`, type })
      )
    );
    ok(
      `${type}: summarised by the parser (routing gate STOPs it — see pr2)`,
      parsed.messages.length === 1 && parsed.messages[0].type === type
    );
    ok(`${type}: carries no mediaId, so intake cannot start`, parsed.messages[0].mediaId === null);
  }

  // ── 7. signature still fails before anything is parsed ───────────────────
  {
    const secret = "unit-test-app-secret";
    const prev = process.env.WHATSAPP_APP_SECRET;
    process.env.WHATSAPP_APP_SECRET = secret;
    try {
      const body = JSON.stringify(envelope("messages", messageValue(TEXT_MSG)));
      const good =
        "sha256=" + createHmac("sha256", secret).update(body, "utf8").digest("hex");

      ok(
        "valid signature accepted",
        verifyWebhookSignature({ rawBody: body, signatureHeader: good }).ok
      );
      ok(
        "tampered body rejected",
        !verifyWebhookSignature({ rawBody: body + " ", signatureHeader: good }).ok
      );
      ok(
        "missing header rejected",
        !verifyWebhookSignature({ rawBody: body, signatureHeader: null }).ok
      );
      ok(
        "wrong prefix rejected",
        !verifyWebhookSignature({ rawBody: body, signatureHeader: "sha1=deadbeef" }).ok
      );
    } finally {
      if (prev === undefined) delete process.env.WHATSAPP_APP_SECRET;
      else process.env.WHATSAPP_APP_SECRET = prev;
    }
  }

  // ── 8. root.object — NOT enforced, and that is recorded, not hidden ──────
  // The only local evidence for the expected literal is this repository's own
  // fixtures. That is not a provider contract, so no literal was invented. This
  // case pins today's behaviour so the gap stays visible and a future change is
  // deliberate.
  {
    const parsed = parseWhatsAppWebhookPayload(
      envelope("messages", messageValue(TEXT_MSG))
    );
    ok("object is echoed", parsed.object === "whatsapp_business_account");

    const wrongObject = parseWhatsAppWebhookPayload({
      object: "not_a_whatsapp_object",
      entry: [
        { id: "W", changes: [{ field: "messages", value: messageValue(TEXT_MSG) }] },
      ],
    });
    ok(
      "object is NOT validated today — unresolved, deliberately not invented",
      wrongObject.messages.length === 1
    );
  }

  // ── 9. structural guard — dispatch still reads only parsed.messages ──────
  // The parser-level assertions above prove "no dispatch" only while the route
  // dispatches solely from parsed.messages. Pin that so the proof cannot rot.
  {
    const route = fs.readFileSync(
      "app/api/integrations/whatsapp/webhook/route.ts",
      "utf8"
    );
    ok(
      "route dispatches only from parsed.messages",
      /for\s*\(\s*const\s+message\s+of\s+parsed\.messages\s*\)/.test(route)
    );
    ok(
      "route has exactly one dispatch loop",
      (route.match(/routeInboundWhatsAppMessage\(/g) ?? []).length === 1
    );
    const parser = fs.readFileSync(
      "lib/services/integrations/whatsapp/webhook-parse.service.ts",
      "utf8"
    );
    ok(
      "the boundary is checked before value is read",
      parser.indexOf("SUPPORTED_CHANGE_FIELD)") <
        parser.indexOf("asRecord(changeRec.value)")
    );
    ok(
      "signature verification precedes JSON.parse in the route",
      route.indexOf("verifyWebhookSignature({") < route.indexOf("JSON.parse(rawBody)")
    );
  }

  console.log(
    `WhatsApp webhook event-class boundary: OK — ${pass}/${pass}`
  );
}

main();
