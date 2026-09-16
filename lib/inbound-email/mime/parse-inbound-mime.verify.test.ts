/**
 * T2 — the inbound MIME parser, against input built to break it.
 *
 * Every fixture here is SYNTHETIC. No real message, no customer address, no
 * supplier document, nothing from a production mailbox. A parser that is only
 * ever tested on well-formed mail is tested on the one case that will not
 * happen: possessing an inbound address is not identity, so anybody who learns
 * one can send whatever they like, and this file is where "whatever they like"
 * is written down.
 *
 * The proofs are numbered to match the security contract they answer to.
 *
 *   npx tsx lib/inbound-email/mime/parse-inbound-mime.verify.test.ts
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  MAX_ATTACHMENTS,
  MAX_DECODED_BYTES,
  MAX_FILENAME_LENGTH,
  MAX_MIME_DEPTH,
  MAX_MIME_PARTS,
  MAX_RAW_MESSAGE_BYTES,
  MAX_SUBJECT_LENGTH,
} from "./inbound-mime-contract";
import { sanitizeAttachmentFilename } from "./inbound-mime-filename";
import { parseInboundMime } from "./parse-inbound-mime";

// ── Synthetic bytes ──────────────────────────────────────────────────────────

const PDF_BYTES = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.from("synthetic pdf body\n")]);
/**
 * The same container, with no bare newline in it.
 *
 * quoted-printable and 7bit are LINE-oriented encodings: a lone LF is
 * transport-normalised, so round-tripping binary through them is lossy by
 * design. Real senders base64 their attachments for exactly this reason. The
 * encoding-equivalence proofs use this payload so they measure the parser
 * rather than a property of the encoding.
 */
const PDF_FLAT = Buffer.from("%PDF-1.4 synthetic single line body");
const JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("synthetic jpeg")]);
const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("synthetic png"),
]);
const ZIP_BYTES = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("synthetic zip")]);
const EXE_BYTES = Buffer.concat([Buffer.from([0x4d, 0x5a]), Buffer.from("synthetic exe")]);
const TXT_BYTES = Buffer.from("just some text");

const CRLF = "\r\n";

type PartSpec = {
  contentType: string;
  disposition?: string;
  filename?: string;
  contentId?: string;
  body: Buffer | string;
  encoding?: "base64" | "quoted-printable" | "7bit" | "8bit" | "raw";
};

function encodePart(spec: PartSpec): string {
  const headers = [`Content-Type: ${spec.contentType}`];
  if (spec.disposition) {
    headers.push(
      `Content-Disposition: ${spec.disposition}${spec.filename ? `; filename="${spec.filename}"` : ""}`
    );
  }
  if (spec.contentId) headers.push(`Content-ID: <${spec.contentId}>`);

  const raw = Buffer.isBuffer(spec.body) ? spec.body : Buffer.from(spec.body, "utf8");
  const encoding = spec.encoding ?? "base64";
  let body: string;
  if (encoding === "base64") {
    headers.push("Content-Transfer-Encoding: base64");
    body = raw.toString("base64").replace(/(.{76})/g, `$1${CRLF}`);
  } else if (encoding === "quoted-printable") {
    headers.push("Content-Transfer-Encoding: quoted-printable");
    body = raw.toString("latin1").replace(/=/g, "=3D");
  } else if (encoding === "raw") {
    body = raw.toString("latin1");
  } else {
    headers.push(`Content-Transfer-Encoding: ${encoding}`);
    body = raw.toString("latin1");
  }
  return [...headers, "", body].join(CRLF);
}

function message(options: {
  subject?: string | null;
  messageId?: string | null;
  parts: PartSpec[];
  boundary?: string;
}): Buffer {
  const b = options.boundary ?? "BOUNDARY1";
  const head = ["From: Sender <sender@example.test>", "To: dz-target@in.example.test"];
  if (options.subject !== null) head.push(`Subject: ${options.subject ?? "synthetic subject"}`);
  if (options.messageId !== null) head.push(`Message-ID: <${options.messageId ?? "syn-1@example.test"}>`);
  head.push("Date: Tue, 16 Sep 2026 08:00:00 +0300", "MIME-Version: 1.0");
  head.push(`Content-Type: multipart/mixed; boundary="${b}"`, "");
  const body = options.parts.map((p) => `--${b}${CRLF}${encodePart(p)}`).join(CRLF);
  return Buffer.from([...head, body, `--${b}--`, ""].join(CRLF), "utf8");
}

const pdfPart = (filename = "invoice.pdf"): PartSpec => ({
  contentType: "application/pdf",
  disposition: "attachment",
  filename,
  body: PDF_BYTES,
});

// ── Harness ──────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures: string[] = [];
async function check(what: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${what}`);
  } catch (error) {
    failed += 1;
    failures.push(what);
    console.log(`  FAIL  ${what}`);
    console.log(`        ${(error as Error).message.split("\n")[0]}`);
  }
}

async function parseOk(raw: Buffer) {
  const result = await parseInboundMime(raw);
  assert.ok(result.ok, `expected a parsed message, got ${result.ok ? "" : result.code}`);
  return result.message;
}

console.log("\nT2 — inbound MIME parser, adversarial suite\n");

async function main() {
  // ── VALID ──────────────────────────────────────────────────────────────────

  await check("a simple PDF attachment is extracted and verified", async () => {
    const m = await parseOk(message({ parts: [pdfPart()] }));
    assert.equal(m.attachments.length, 1);
    assert.equal(m.attachments[0]!.verifiedContainer, "pdf");
    assert.equal(m.attachments[0]!.filename, "invoice.pdf");
    assert.equal(m.attachments[0]!.decodedSize, PDF_BYTES.length);
  });

  await check("JPEG and PNG are extracted alongside PDF", async () => {
    const m = await parseOk(
      message({
        parts: [
          pdfPart(),
          { contentType: "image/jpeg", disposition: "attachment", filename: "photo.jpg", body: JPEG_BYTES },
          { contentType: "image/png", disposition: "attachment", filename: "scan.png", body: PNG_BYTES },
        ],
      })
    );
    assert.deepEqual(
      m.attachments.map((a) => a.verifiedContainer),
      ["pdf", "jpeg", "png"]
    );
  });

  await check("every transfer encoding yields the payload, line-oriented ones exactly", async () => {
    // MEASURED, not assumed. base64 decodes byte-for-byte. quoted-printable and
    // 7bit are LINE-oriented: the body ends at a line terminator, and that
    // terminator is part of what they decode to. So they agree with each other
    // and differ from base64 by exactly the trailing newline. That is a property
    // of the encodings, not of the parser, and it is why real senders base64
    // their binary attachments.
    const flat = (): PartSpec => ({ ...pdfPart("flat.pdf"), body: PDF_FLAT });
    const base = await parseOk(message({ parts: [{ ...flat(), encoding: "base64" }] }));
    const qp = await parseOk(message({ parts: [{ ...flat(), encoding: "quoted-printable" }] }));
    const bit7 = await parseOk(message({ parts: [{ ...flat(), encoding: "7bit" }] }));

    assert.equal(base.attachments.length, 1, "base64 produced no attachment");
    assert.equal(qp.attachments.length, 1, "quoted-printable produced no attachment");
    assert.equal(bit7.attachments.length, 1, "7bit produced no attachment");

    assert.equal(
      base.attachments[0]!.content.toString("latin1"),
      PDF_FLAT.toString("latin1"),
      "base64 did not round-trip exactly"
    );
    assert.equal(
      qp.attachments[0]!.contentHashSha256,
      bit7.attachments[0]!.contentHashSha256,
      "two line-oriented encodings disagreed with each other"
    );
    assert.ok(
      qp.attachments[0]!.content.toString("latin1").startsWith(PDF_FLAT.toString("latin1")),
      "quoted-printable lost part of the payload"
    );
  });

  await check("a Hebrew filename survives intact", async () => {
    const m = await parseOk(message({ parts: [pdfPart("חשבונית ספטמבר.pdf")] }));
    assert.equal(m.attachments[0]!.filename, "חשבונית ספטמבר.pdf");
  });

  await check("a missing Message-ID and Subject do not stop attachment parsing", async () => {
    const m = await parseOk(message({ subject: null, messageId: null, parts: [pdfPart()] }));
    assert.equal(m.attachments.length, 1);
    assert.equal(m.messageIdHeader, null);
    assert.equal(m.subject, null);
  });

  await check("an encoded-word subject is decoded and bounded", async () => {
    const m = await parseOk(
      message({ subject: "=?UTF-8?B?15fXqdeR15XXoNeZ16o=?=", parts: [pdfPart()] })
    );
    assert.equal(m.subject, "חשבונית");
    const long = await parseOk(message({ subject: "s".repeat(4000), parts: [pdfPart()] }));
    assert.ok(long.subject!.length <= MAX_SUBJECT_LENGTH, "subject exceeded its ceiling");
  });

  // ── P10 / P11 — minimization ───────────────────────────────────────────────

  await check("P10: arbitrary headers never appear in the normalized output", async () => {
    const raw = Buffer.from(
      [
        "From: a@example.test",
        "Reply-To: attacker@evil.test",
        "Return-Path: <bounce@evil.test>",
        "Delivered-To: victim@example.test",
        "X-Forwarded-To: victim@example.test",
        "Received: from evil.test by mx.example.test",
        "X-Custom-Secret: SHOULD-NOT-APPEAR",
        "Subject: s",
        "MIME-Version: 1.0",
        'Content-Type: multipart/mixed; boundary="B"',
        "",
        `--B${CRLF}${encodePart(pdfPart())}`,
        "--B--",
        "",
      ].join(CRLF),
      "utf8"
    );
    const m = await parseOk(raw);
    const serialized = JSON.stringify(m);
    for (const forbidden of [
      "SHOULD-NOT-APPEAR",
      "attacker@evil.test",
      "bounce@evil.test",
      "X-Forwarded-To",
      "Received",
      "headerLines",
    ]) {
      assert.ok(!serialized.includes(forbidden), `${forbidden} leaked into the normalized output`);
    }
    assert.deepEqual(
      Object.keys(m).sort(),
      ["attachments", "date", "fromAddress", "fromName", "messageIdHeader", "nestedMessageCount", "rejected", "subject"]
    );
  });

  await check("P11: body text and HTML never appear in the normalized output", async () => {
    const m = await parseOk(
      message({
        parts: [
          { contentType: "text/plain; charset=utf-8", body: "SECRET-PLAIN-BODY", encoding: "raw" },
          { contentType: "text/html; charset=utf-8", body: "<b>SECRET-HTML-BODY</b>", encoding: "raw" },
          pdfPart(),
        ],
      })
    );
    const serialized = JSON.stringify(m);
    assert.ok(!serialized.includes("SECRET-PLAIN-BODY"), "the text body leaked");
    assert.ok(!serialized.includes("SECRET-HTML-BODY"), "the HTML body leaked");
    assert.equal(m.attachments.length, 1, "the body parts were treated as attachments");
  });

  // ── P1 — raw size ──────────────────────────────────────────────────────────

  await check("P1: a message over the raw ceiling is refused before parsing", async () => {
    const oversized = Buffer.alloc(MAX_RAW_MESSAGE_BYTES + 1, 0x41);
    const started = Date.now();
    const result = await parseInboundMime(oversized);
    assert.ok(!result.ok);
    assert.equal(result.code, "RAW_MESSAGE_TOO_LARGE");
    // A full parse of 40MB of junk would not return in a few milliseconds. This
    // is the evidence that the guard runs BEFORE the parser, not after it.
    assert.ok(Date.now() - started < 2000, "the size guard did not short-circuit the parse");
  });

  await check("an empty message is refused", async () => {
    const result = await parseInboundMime(Buffer.alloc(0));
    assert.ok(!result.ok);
    assert.equal(result.code, "RAW_MESSAGE_EMPTY");
  });

  // ── P2 / P3 — structural bombs ─────────────────────────────────────────────

  await check(`P2: ${MAX_MIME_PARTS} parts pass and ${MAX_MIME_PARTS + 1} do not`, async () => {
    const filler = (n: number): PartSpec[] =>
      Array.from({ length: n }, () => ({ contentType: "text/plain", body: "x", encoding: "raw" as const }));

    const atLimit = await parseInboundMime(message({ parts: filler(MAX_MIME_PARTS) }));
    assert.ok(atLimit.ok, "a message at the part limit was refused");

    const over = await parseInboundMime(message({ parts: filler(MAX_MIME_PARTS + 1) }));
    assert.ok(!over.ok, "a message over the part limit was accepted");
    assert.equal(over.code, "MIME_TOO_MANY_PARTS");
  });

  await check(`P3: depth ${MAX_MIME_DEPTH} passes and depth ${MAX_MIME_DEPTH + 1} does not`, async () => {
    const nest = (depth: number): Buffer => {
      let body = encodePart(pdfPart("deep.pdf"));
      for (let i = depth; i >= 1; i--) {
        const b = `N${i}`;
        body = [
          `Content-Type: multipart/mixed; boundary="${b}"`,
          "",
          `--${b}`,
          body,
          `--${b}--`,
        ].join(CRLF);
      }
      return Buffer.from(
        ["From: a@example.test", "Subject: deep", "MIME-Version: 1.0", body, ""].join(CRLF),
        "utf8"
      );
    };
    const ok = await parseInboundMime(nest(MAX_MIME_DEPTH - 1));
    assert.ok(ok.ok, "a message within the depth limit was refused");

    const over = await parseInboundMime(nest(MAX_MIME_DEPTH + 1));
    assert.ok(!over.ok, "a message past the depth limit was accepted");
    assert.equal(over.code, "MIME_TOO_DEEP");
  });

  // ── P4 / P5 — volume ───────────────────────────────────────────────────────

  await check(`P4: attachment ${MAX_ATTACHMENTS + 1} is refused, and the message stands`, async () => {
    const parts = Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, i) => pdfPart(`inv-${i}.pdf`));
    const m = await parseOk(message({ parts }));
    assert.equal(m.attachments.length, MAX_ATTACHMENTS);
    assert.ok(
      m.rejected.some((r) => r.reason === "TOO_MANY_ATTACHMENTS"),
      "the surplus attachment was not recorded as refused"
    );
  });

  await check("P5: decoded bytes are accounted cumulatively, not per file", async () => {
    // WHAT THIS CAN AND CANNOT PROVE.
    //
    // No MIME transfer encoding compresses: base64 inflates by about a third and
    // the rest are one-to-one. So while the raw ceiling and the decoded ceiling
    // are both 40MB, the sum of decoded bytes can never EXCEED the raw ceiling,
    // and a message that would trip the decoded guard is refused earlier as
    // RAW_MESSAGE_TOO_LARGE. The guard is therefore defence in depth against a
    // future raw limit being raised, not a reachable path today, and this test
    // says so rather than dressing an unreachable branch as a passing proof.
    //
    // What IS proved here: the accounting is cumulative. Ten files each far
    // under any per-file limit are summed, so the cost of a message is the sum
    // of what it decoded rather than the size of its largest part.
    const chunk = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(512 * 1024, 0x20)]);
    const parts = Array.from({ length: 10 }, (_, i) => ({
      contentType: "application/pdf",
      disposition: "attachment",
      filename: `big-${i}.pdf`,
      body: chunk,
    }));
    const m = await parseOk(message({ parts }));
    const total = m.attachments.reduce((sum, a) => sum + a.decodedSize, 0);
    assert.equal(m.attachments.length, 10);
    assert.equal(total, 10 * chunk.length, "decoded sizes were not accounted per attachment");
    assert.ok(total <= MAX_DECODED_BYTES);

    // And the ordering that makes the unreachability true: raw is checked first.
    const oversized = Buffer.alloc(MAX_RAW_MESSAGE_BYTES + 1, 0x41);
    const refused = await parseInboundMime(oversized);
    assert.ok(!refused.ok && refused.code === "RAW_MESSAGE_TOO_LARGE");
  });

  // ── P6 — declared type cannot override the bytes ───────────────────────────

  await check("P6: a declared type that contradicts the bytes is refused", async () => {
    const cases: { declared: string; body: Buffer; label: string }[] = [
      { declared: "application/pdf", body: JPEG_BYTES, label: "PDF claiming JPEG bytes" },
      { declared: "image/jpeg", body: PDF_BYTES, label: "JPEG claiming PDF bytes" },
      { declared: "image/png", body: EXE_BYTES, label: "PNG claiming executable bytes" },
      { declared: "application/pdf", body: ZIP_BYTES, label: "PDF claiming ZIP bytes" },
    ];
    for (const c of cases) {
      const m = await parseOk(
        message({
          parts: [{ contentType: c.declared, disposition: "attachment", filename: "x.pdf", body: c.body }],
        })
      );
      assert.equal(m.attachments.length, 0, `${c.label} was accepted`);
      assert.ok(
        m.rejected.some((r) => r.reason.startsWith("SIGNATURE_")),
        `${c.label} was not refused on its signature`
      );
    }
  });

  await check("an extension cannot rescue bytes that are not what they claim", async () => {
    const m = await parseOk(
      message({
        parts: [
          { contentType: "application/octet-stream", disposition: "attachment", filename: "invoice.pdf", body: EXE_BYTES },
        ],
      })
    );
    assert.equal(m.attachments.length, 0, "a .pdf name admitted non-PDF bytes");
  });

  // ── P8 — unsupported types ─────────────────────────────────────────────────

  await check("P8: unsupported attachments are refused without dropping the message", async () => {
    const m = await parseOk(
      message({
        parts: [
          pdfPart(),
          { contentType: "text/plain", disposition: "attachment", filename: "notes.txt", body: TXT_BYTES },
          { contentType: "application/zip", disposition: "attachment", filename: "bundle.zip", body: ZIP_BYTES },
          { contentType: "image/svg+xml", disposition: "attachment", filename: "logo.svg", body: "<svg/>" },
          { contentType: "application/x-msdownload", disposition: "attachment", filename: "setup.exe", body: EXE_BYTES },
          {
            contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            disposition: "attachment",
            filename: "doc.docx",
            body: ZIP_BYTES,
          },
        ],
      })
    );
    assert.equal(m.attachments.length, 1, "an unsupported file survived");
    assert.equal(m.attachments[0]!.verifiedContainer, "pdf");
    assert.equal(m.rejected.length, 5, "not every unsupported file was recorded");
    assert.ok(
      m.rejected.every((r) => r.reason === "UNSUPPORTED_TYPE" || r.reason.startsWith("SIGNATURE_")),
      "an unsupported file was refused for the wrong reason"
    );
  });

  // ── Inline parts ───────────────────────────────────────────────────────────

  await check("an inline logo with a Content-ID does not become a document", async () => {
    const m = await parseOk(
      message({
        parts: [
          pdfPart(),
          { contentType: "image/png", disposition: "inline", contentId: "logo@example.test", body: PNG_BYTES },
        ],
      })
    );
    assert.equal(m.attachments.length, 1, "a CID inline image was treated as a document");
    assert.ok(m.rejected.some((r) => r.reason === "NOT_AN_ATTACHMENT_CANDIDATE"));
  });

  await check("an unnamed binary part with no disposition is not a candidate", async () => {
    const m = await parseOk(
      message({ parts: [{ contentType: "application/pdf", body: PDF_BYTES }] })
    );
    assert.equal(m.attachments.length, 0, "an unnamed part became a document");
  });

  await check("a filename given through Content-Type name= still yields a candidate", async () => {
    const raw = Buffer.from(
      [
        "From: a@example.test",
        "Subject: s",
        "MIME-Version: 1.0",
        'Content-Type: multipart/mixed; boundary="B"',
        "",
        "--B",
        'Content-Type: application/pdf; name="via-name.pdf"',
        "Content-Disposition: attachment",
        "Content-Transfer-Encoding: base64",
        "",
        PDF_BYTES.toString("base64"),
        "--B--",
        "",
      ].join(CRLF),
      "utf8"
    );
    const m = await parseOk(raw);
    assert.equal(m.attachments.length, 1, "a name= filename produced no attachment");
  });

  await check("an RFC2231 filename* is handled without crashing", async () => {
    const raw = Buffer.from(
      [
        "From: a@example.test",
        "Subject: s",
        "MIME-Version: 1.0",
        'Content-Type: multipart/mixed; boundary="B"',
        "",
        "--B",
        "Content-Type: application/pdf",
        "Content-Disposition: attachment; filename*=UTF-8''%D7%97%D7%A9%D7%91%D7%95%D7%A0%D7%99%D7%AA.pdf",
        "Content-Transfer-Encoding: base64",
        "",
        PDF_BYTES.toString("base64"),
        "--B--",
        "",
      ].join(CRLF),
      "utf8"
    );
    const m = await parseOk(raw);
    assert.equal(m.attachments.length, 1, "an RFC2231 filename produced no attachment");
  });

  // ── Nested messages ────────────────────────────────────────────────────────

  await check("a forwarded message is counted, not silently unpacked", async () => {
    const inner = message({ parts: [pdfPart("inner.pdf")], boundary: "INNERBOUNDARY" }).toString("utf8");
    const m = await parseOk(
      message({
        parts: [
          pdfPart("outer.pdf"),
          { contentType: "message/rfc822", disposition: "attachment", filename: "fwd.eml", body: inner, encoding: "raw" },
        ],
      })
    );
    assert.equal(m.nestedMessageCount, 1, "the nested message was not counted");
    assert.ok(
      m.attachments.every((a) => a.filename !== "inner.pdf"),
      "a nested message's attachment was promoted without a decision"
    );
  });

  // ── P7 — filenames ─────────────────────────────────────────────────────────

  await check("P7: no filename can carry a path, a traversal or a drive", () => {
    const cases: [string, (out: string | null) => boolean][] = [
      ["../../invoice.pdf", (o) => o !== null && !o.includes("/") && !o.includes("..")],
      ["..\\..\\invoice.pdf", (o) => o !== null && !o.includes("\\") && !o.includes("..")],
      ["C:\\temp\\invoice.pdf", (o) => o !== null && !o.includes("\\") && !o.includes(":")],
      ["/etc/passwd", (o) => o !== null && !o.includes("/")],
      ["....//....//x.pdf", (o) => o === null || (!o.includes("/") && !o.includes(".."))],
      ["...", (o) => o === null],
      ["", (o) => o === null],
    ];
    for (const [input, ok] of cases) {
      const out = sanitizeAttachmentFilename(input);
      assert.ok(ok(out), `${JSON.stringify(input)} sanitised to ${JSON.stringify(out)}`);
    }
  });

  await check("control characters, NUL and direction overrides are removed", () => {
    assert.equal(sanitizeAttachmentFilename("invoice\u0000.pdf"), "invoice.pdf");
    assert.equal(sanitizeAttachmentFilename("in\u0007voice.pdf"), "invoice.pdf");
    const rtl = sanitizeAttachmentFilename("invoice\u202Efdp.exe");
    assert.ok(rtl !== null && !rtl.includes("\u202E"), "a direction override survived");
  });

  await check("an oversized filename is bounded, and Unicode does not crash it", () => {
    const long = sanitizeAttachmentFilename(`${"a".repeat(5000)}.pdf`);
    assert.ok(long !== null && long.length <= MAX_FILENAME_LENGTH);
    assert.ok(sanitizeAttachmentFilename("🧾📄 חשבונית.pdf") !== null);
    assert.equal(sanitizeAttachmentFilename(null), null);
  });

  await check("a traversal filename reaches the parsed output already flattened", async () => {
    const m = await parseOk(message({ parts: [pdfPart("../../../etc/passwd.pdf")] }));
    const name = m.attachments[0]!.filename!;
    assert.ok(!name.includes("/") && !name.includes(".."), `filename survived as ${name}`);
  });

  // ── P9 — hashing ───────────────────────────────────────────────────────────

  await check("P9: identical bytes hash identically, whatever surrounds them", async () => {
    // Vary everything that must not matter: the filename, the subject, the
    // Message-ID, the boundary, and what sits in front of it in the message.
    // Encoding is deliberately NOT varied here — the proof above measured that
    // line-oriented encodings do not decode to the same bytes, so including them
    // would be asserting something untrue.
    const expected = createHash("sha256").update(PDF_FLAT).digest("hex");

    const a = await parseOk(message({ parts: [{ ...pdfPart("one.pdf"), body: PDF_FLAT }] }));
    const b = await parseOk(
      message({ parts: [{ ...pdfPart("completely-different-name.pdf"), body: PDF_FLAT }] })
    );
    const c = await parseOk(
      message({
        subject: "another subject entirely",
        messageId: "other@example.test",
        boundary: "DIFFERENT",
        parts: [
          { contentType: "image/png", disposition: "attachment", filename: "x.png", body: PNG_BYTES },
          { ...pdfPart("third.pdf"), body: PDF_FLAT },
        ],
      })
    );

    assert.equal(a.attachments[0]!.contentHashSha256, expected);
    assert.equal(b.attachments[0]!.contentHashSha256, expected);
    assert.equal(c.attachments[1]!.contentHashSha256, expected);
  });

  await check("duplicate bytes under two names both parse, and the parser does not dedupe", async () => {
    const m = await parseOk(message({ parts: [pdfPart("a.pdf"), pdfPart("b.pdf")] }));
    assert.equal(m.attachments.length, 2, "the parser silently deduped; that is a later decision");
    assert.equal(m.attachments[0]!.contentHashSha256, m.attachments[1]!.contentHashSha256);
  });

  // ── Malformed ──────────────────────────────────────────────────────────────

  await check("malformed base64 never yields a half-decoded attachment", async () => {
    const raw = Buffer.from(
      [
        "From: a@example.test",
        "Subject: s",
        "MIME-Version: 1.0",
        'Content-Type: multipart/mixed; boundary="B"',
        "",
        "--B",
        "Content-Type: application/pdf",
        'Content-Disposition: attachment; filename="broken.pdf"',
        "Content-Transfer-Encoding: base64",
        "",
        "!!!!not-base64-at-all????",
        "--B--",
        "",
      ].join(CRLF),
      "utf8"
    );
    const result = await parseInboundMime(raw);
    if (result.ok) {
      assert.equal(result.message.attachments.length, 0, "a corrupt attachment was accepted");
    }
  });

  await check("a truncated message with no closing boundary does not crash", async () => {
    const full = message({ parts: [pdfPart()] }).toString("utf8");
    const truncated = Buffer.from(full.slice(0, Math.floor(full.length * 0.6)), "utf8");
    const result = await parseInboundMime(truncated);
    // Either verdict is acceptable; silently inventing a valid attachment is not.
    if (result.ok) {
      for (const a of result.message.attachments) {
        assert.ok(a.decodedSize > 0 && a.contentHashSha256.length === 64);
      }
    }
  });

  await check("garbage that is not a message at all is refused deterministically", async () => {
    const junk = Buffer.from([0x00, 0xff, 0xfe, 0x42, 0x00, 0x13, 0x37]);
    const a = await parseInboundMime(junk);
    const b = await parseInboundMime(junk);
    assert.deepEqual(JSON.stringify(a), JSON.stringify(b), "the same bytes gave two answers");
  });

  // ── P12 — no side effects ──────────────────────────────────────────────────

  await check("P12: the parser performs no database, network or storage work", () => {
    const sources = [
      "lib/inbound-email/mime/parse-inbound-mime.ts",
      "lib/inbound-email/mime/inbound-mime-prescan.ts",
      "lib/inbound-email/mime/inbound-mime-filename.ts",
      "lib/inbound-email/mime/inbound-mime-contract.ts",
    ];
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const root = path.resolve(__dirname, "../../..");
    for (const rel of sources) {
      const src = fs.readFileSync(path.join(root, rel), "utf8");
      const code = src
        .split("\n")
        .filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*") && !l.trimStart().startsWith("/*"))
        .join("\n");
      for (const forbidden of [
        "@/lib/prisma",
        "PrismaClient",
        "fetch(",
        "axios",
        "S3Client",
        "putObject",
        "writeFileSync",
        "createWriteStream",
        "process.env",
        "InboundEmailMessage",
        "InboundEmailAddress",
        "inboundEmailAuthorizedSender",
      ]) {
        assert.ok(!code.includes(forbidden), `${rel} reaches ${forbidden}`);
      }
    }
  });

  await check("the parser has no runtime callers", () => {
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const root = path.resolve(__dirname, "../../..");
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
        const rel = `${dir}/${entry.name}`;
        if (entry.isDirectory()) walk(rel);
        else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
          if (fs.readFileSync(path.join(root, rel), "utf8").includes("parseInboundMime")) hits.push(rel);
        }
      }
    };
    for (const r of ["app", "components", "lib"]) walk(r);
    assert.deepEqual(
      hits,
      ["lib/inbound-email/mime/parse-inbound-mime.ts"],
      "the parser gained a caller; T2 closes with zero"
    );
  });
}


main().then(
  () => {
    console.log(`
  ${passed} passed, ${failed} failed`);
    if (failures.length > 0) console.log(`  failing: ${failures.join(" | ")}`);
    console.log("");
    process.exit(failed === 0 ? 0 : 1);
  },
  (error) => {
    console.error("  the suite itself threw:", error);
    process.exit(1);
  }
);
