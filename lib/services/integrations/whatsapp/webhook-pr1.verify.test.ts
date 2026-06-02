/**
 * PR1 validation: run with
 *   WHATSAPP_WEBHOOK_VERIFY_TOKEN=test-verify-token WHATSAPP_APP_SECRET=test-app-secret npx tsx lib/services/integrations/whatsapp/webhook-pr1.verify.test.ts
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { parseWhatsAppWebhookPayload } from "./webhook-parse.service";
import {
  verifySubscribeChallenge,
  verifyWebhookSignature,
} from "./webhook-verify.service";

process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = "test-verify-token";
process.env.WHATSAPP_APP_SECRET = "test-app-secret";

// --- GET verification ---
const okChallenge = verifySubscribeChallenge({
  mode: "subscribe",
  verifyToken: "test-verify-token",
  challenge: "challenge-12345",
});
assert.equal(okChallenge.ok, true);
if (okChallenge.ok) {
  assert.equal(okChallenge.challenge, "challenge-12345");
}

const badToken = verifySubscribeChallenge({
  mode: "subscribe",
  verifyToken: "wrong",
  challenge: "challenge-12345",
});
assert.equal(badToken.ok, false);
if (!badToken.ok) assert.equal(badToken.reason, "invalid_token");

// --- POST signature ---
const payload = JSON.stringify({
  object: "whatsapp_business_account",
  entry: [
    {
      id: "WABA_ID",
      changes: [
        {
          field: "messages",
          value: {
            metadata: { phone_number_id: "123456789" },
            messages: [
              {
                from: "972501234567",
                id: "wamid.HBgLMTIz",
                timestamp: "1710000000",
                type: "image",
                image: { id: "media-image-abc", mime_type: "image/jpeg" },
              },
            ],
          },
        },
      ],
    },
  ],
});

const sig = `sha256=${createHmac("sha256", "test-app-secret").update(payload, "utf8").digest("hex")}`;

const okSig = verifyWebhookSignature({ rawBody: payload, signatureHeader: sig });
assert.equal(okSig.ok, true);

const badSig = verifyWebhookSignature({
  rawBody: payload,
  signatureHeader: "sha256=0000000000000000000000000000000000000000000000000000000000000000",
});
assert.equal(badSig.ok, false);

// --- Parser ---
const parsed = parseWhatsAppWebhookPayload(JSON.parse(payload));
assert.equal(parsed.object, "whatsapp_business_account");
assert.equal(parsed.entryCount, 1);
assert.equal(parsed.changeCount, 1);
assert.equal(parsed.messages.length, 1);
assert.equal(parsed.messages[0]?.type, "image");
assert.equal(parsed.messages[0]?.mediaId, "media-image-abc");
assert.equal(parsed.messages[0]?.wamid, "wamid.HBgLMTIz");
assert.equal(parsed.messages[0]?.from, "972501234567");
assert.equal(parsed.messages[0]?.phoneNumberId, "123456789");

const docPayload = parseWhatsAppWebhookPayload({
  object: "whatsapp_business_account",
  entry: [
    {
      changes: [
        {
          value: {
            metadata: { phone_number_id: "999" },
            messages: [
              {
                from: "1",
                id: "wamid.doc",
                type: "document",
                document: { id: "media-doc-xyz", filename: "receipt.pdf" },
              },
            ],
          },
        },
      ],
    },
  ],
});
assert.equal(docPayload.messages[0]?.type, "document");
assert.equal(docPayload.messages[0]?.mediaId, "media-doc-xyz");

console.log("whatsapp webhook PR1 tests: OK");
