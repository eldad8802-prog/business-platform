/**
 * T3 — the sender authorization evaluator, against evidence built to fool it.
 *
 * Every address here is synthetic. The question each fixture asks is the same
 * one: can an attacker who controls what they write into a message make Dubiz
 * believe they are somebody the business trusts.
 *
 * Proof numbers match the security contract.
 *
 *   npx tsx lib/inbound-email/sender-auth/evaluate-sender-authorization.verify.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { evaluateSenderAuthorization } from "./evaluate-sender-authorization";
import {
  PRIVATE_CONTROL_ESTABLISHABLE,
  classifySenderDomain,
} from "./sender-domain-classification";
import type {
  SenderAuthorizationInput,
  SenderAuthorizationResult,
  SenderDomainClassification,
  SesAuthVerdict,
} from "./sender-authorization-contract";

const CONFIGURED = "billing@supplier.example";
const ATTACKER = "attacker@evil.test";

function input(over: Partial<SenderAuthorizationInput> = {}): SenderAuthorizationInput {
  return {
    configuredSender: { normalizedEmail: CONFIGURED, status: "VERIFIED" },
    envelopeMailFrom: null,
    headerFrom: null,
    spfVerdict: "UNKNOWN",
    dkimVerdict: "UNKNOWN",
    dmarcVerdict: "UNKNOWN",
    headerFromDomainClassification: "UNKNOWN",
    ...over,
  };
}

const NON_PASS: SesAuthVerdict[] = ["FAIL", "GRAY", "PROCESSING_FAILED", "UNKNOWN"];
const ALL_VERDICTS: SesAuthVerdict[] = ["PASS", ...NON_PASS];

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(what: string, fn: () => void) {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${what}`);
  } catch (error) {
    failed += 1;
    failures.push(what);
    console.log(`  FAIL  ${what}`);
    console.log(`        ${(error as Error).message.split("\n")[0]}`);
  }
}

const assertResult = (
  got: SenderAuthorizationResult,
  want: Omit<SenderAuthorizationResult, "headerFromMatchedEnvelope">,
  message?: string
) => {
  assert.equal(got.decision, want.decision, `${message ?? ""} decision`);
  assert.equal(got.assurance, want.assurance, `${message ?? ""} assurance`);
  assert.equal(got.reason, want.reason, `${message ?? ""} reason`);
};

console.log("\nT3 — inbound sender authorization\n");

// ── P3 / P4 — the STRONG path, bound to the authenticated envelope ───────────

check("P3: verified sender + matching envelope + SPF PASS authorizes STRONG", () => {
  const r = evaluateSenderAuthorization(
    input({ envelopeMailFrom: CONFIGURED, headerFrom: CONFIGURED, spfVerdict: "PASS" })
  );
  assertResult(r, {
    decision: "AUTHORIZED",
    assurance: "STRONG",
    reason: "AUTHORIZED_ENVELOPE_SPF",
  });
});

check("P4: a forged header From cannot defeat a genuine authenticated envelope", () => {
  const r = evaluateSenderAuthorization(
    input({ envelopeMailFrom: CONFIGURED, headerFrom: ATTACKER, spfVerdict: "PASS" })
  );
  assertResult(r, {
    decision: "AUTHORIZED",
    assurance: "STRONG",
    reason: "AUTHORIZED_ENVELOPE_SPF",
  });
  // The disagreement is still observable, without an address travelling with it.
  assert.equal(r.headerFromMatchedEnvelope, false, "the mismatch was not reported");
  assert.ok(
    !JSON.stringify(r).includes("@"),
    "an address leaked into the result; reasons must stay address-free"
  );
});

check("case matters not at all, and surrounding whitespace matters not at all", () => {
  const r = evaluateSenderAuthorization(
    input({ envelopeMailFrom: "  BILLING@Supplier.Example  ", spfVerdict: "PASS" })
  );
  assert.equal(r.decision, "AUTHORIZED");
});

check("a plus tag is a DIFFERENT identity and does not inherit authorization", () => {
  const r = evaluateSenderAuthorization(
    input({ envelopeMailFrom: "billing+anything@supplier.example", spfVerdict: "PASS" })
  );
  assert.equal(r.decision, "UNAUTHORIZED", "a tagged address was treated as the configured one");
  assert.equal(r.reason, "AUTHENTICATED_DIFFERENT_ENVELOPE_SENDER");
});

// ── P1 / P2 — the two spoofing shapes ───────────────────────────────────────

check("P1: an exact header From, with no trusted evidence, never authorizes", () => {
  for (const spf of NON_PASS) {
    for (const dkim of NON_PASS) {
      const r = evaluateSenderAuthorization(
        input({ headerFrom: CONFIGURED, spfVerdict: spf, dkimVerdict: dkim })
      );
      assert.notEqual(r.decision, "AUTHORIZED", `header-From alone authorized on ${spf}/${dkim}`);
      assert.equal(r.reason, "HEADER_FROM_ONLY");
      assert.equal(r.assurance, "NONE");
    }
  }
});

check("P2: SPF PASS for a different envelope sender is a contradiction, not a maybe", () => {
  const r = evaluateSenderAuthorization(
    input({ envelopeMailFrom: ATTACKER, headerFrom: CONFIGURED, spfVerdict: "PASS" })
  );
  assertResult(r, {
    decision: "UNAUTHORIZED",
    assurance: "NONE",
    reason: "AUTHENTICATED_DIFFERENT_ENVELOPE_SENDER",
  });
});

check("a lookalike or suffix-confused envelope domain is a different sender", () => {
  for (const impostor of [
    "billing@supplier.example.attacker.test",
    "billing@supplier-example.test",
    "billing@evil-supplier.example",
    "billing@xsupplier.example",
  ]) {
    const r = evaluateSenderAuthorization(
      input({ envelopeMailFrom: impostor, headerFrom: CONFIGURED, spfVerdict: "PASS" })
    );
    assert.notEqual(r.decision, "AUTHORIZED", `${impostor} authorized`);
    assert.equal(r.reason, "AUTHENTICATED_DIFFERENT_ENVELOPE_SENDER");
  }
});

// ── P5 / P6 / P7 / P8 — the narrow DKIM path ────────────────────────────────

check("P5: DKIM PASS on its own, with a different header From, does not authorize", () => {
  const r = evaluateSenderAuthorization(
    input({
      headerFrom: ATTACKER,
      dkimVerdict: "PASS",
      headerFromDomainClassification: "PRIVATE_CONTROLLED",
    })
  );
  assert.notEqual(r.decision, "AUTHORIZED");
  assert.equal(r.reason, "INSUFFICIENT_AUTHENTICATION");
});

check("P6: DKIM PASS + exact configured From + private domain authorizes MEDIUM", () => {
  const r = evaluateSenderAuthorization(
    input({
      headerFrom: CONFIGURED,
      dkimVerdict: "PASS",
      headerFromDomainClassification: "PRIVATE_CONTROLLED",
    })
  );
  assertResult(r, {
    decision: "AUTHORIZED",
    assurance: "MEDIUM",
    reason: "AUTHORIZED_SES_DKIM_PRIVATE_DOMAIN",
  });
});

check("MEDIUM is bound to the mailbox, not the domain", () => {
  // A colleague at the same company, signed by the same private domain, is not
  // the sender this business configured.
  const r = evaluateSenderAuthorization(
    input({
      configuredSender: { normalizedEmail: "ceo@supplier.example", status: "VERIFIED" },
      headerFrom: CONFIGURED,
      dkimVerdict: "PASS",
      headerFromDomainClassification: "PRIVATE_CONTROLLED",
    })
  );
  assert.notEqual(r.decision, "AUTHORIZED", "a different mailbox on the same domain authorized");
});

check("P7: a shared consumer domain cannot auto-authorize on DKIM", () => {
  for (const address of [
    "supplier@gmail.com",
    "supplier@outlook.com",
    "supplier@hotmail.com",
    "supplier@yahoo.com",
  ]) {
    const classification = classifySenderDomain(address);
    assert.equal(classification, "SHARED_CONSUMER", `${address} was not classified as shared`);
    const r = evaluateSenderAuthorization(
      input({
        configuredSender: { normalizedEmail: address, status: "VERIFIED" },
        headerFrom: address,
        dkimVerdict: "PASS",
        headerFromDomainClassification: classification,
      })
    );
    assertResult(
      r,
      { decision: "INDETERMINATE", assurance: "NONE", reason: "SHARED_DOMAIN_DKIM_ONLY" },
      address
    );
  }
});

check("P8: an unclassified domain cannot auto-authorize on DKIM", () => {
  const r = evaluateSenderAuthorization(
    input({
      headerFrom: CONFIGURED,
      dkimVerdict: "PASS",
      headerFromDomainClassification: "UNKNOWN",
    })
  );
  assertResult(r, {
    decision: "INDETERMINATE",
    assurance: "NONE",
    reason: "UNKNOWN_DOMAIN_CLASSIFICATION",
  });
});

check("the classifier never invents private control, and says so", () => {
  // The security property that matters most in this file: absence from the
  // shared list is NOT evidence of private control.
  assert.equal(
    PRIVATE_CONTROL_ESTABLISHABLE,
    false,
    "private control is claimed establishable; the MEDIUM gate must be re-reviewed"
  );
  for (const address of [
    "billing@supplier.example",
    "a@some-company.co.il",
    "b@never-heard-of-this.test",
    "c@gmail.com.attacker.test",
    "d@evil-gmail.com",
  ]) {
    const c = classifySenderDomain(address);
    assert.notEqual(c, "PRIVATE_CONTROLLED", `${address} was classified private`);
  }
});

check("P13-adjacent: lookalike consumer domains are not classified as consumer either", () => {
  // Neither direction may be fooled by a chosen name: exact equality only.
  assert.equal(classifySenderDomain("x@gmail.com.attacker.test"), "UNKNOWN");
  assert.equal(classifySenderDomain("x@evil-gmail.com"), "UNKNOWN");
  assert.equal(classifySenderDomain("x@notgmail.com"), "UNKNOWN");
  assert.equal(classifySenderDomain("x@gmail.com"), "SHARED_CONSUMER");
});

// ── P9 / P10 — configuration outranks evidence ──────────────────────────────

check("P9: a revoked sender is refused even with perfect authentication", () => {
  const r = evaluateSenderAuthorization(
    input({
      configuredSender: { normalizedEmail: CONFIGURED, status: "REVOKED" },
      envelopeMailFrom: CONFIGURED,
      headerFrom: CONFIGURED,
      spfVerdict: "PASS",
      dkimVerdict: "PASS",
      dmarcVerdict: "PASS",
      headerFromDomainClassification: "PRIVATE_CONTROLLED",
    })
  );
  assertResult(r, { decision: "UNAUTHORIZED", assurance: "NONE", reason: "SENDER_REVOKED" });
});

check("P10: an unverified sender is refused even with perfect authentication", () => {
  const r = evaluateSenderAuthorization(
    input({
      configuredSender: { normalizedEmail: CONFIGURED, status: "PENDING_VERIFICATION" },
      envelopeMailFrom: CONFIGURED,
      headerFrom: CONFIGURED,
      spfVerdict: "PASS",
      dkimVerdict: "PASS",
      headerFromDomainClassification: "PRIVATE_CONTROLLED",
    })
  );
  assertResult(r, {
    decision: "UNAUTHORIZED",
    assurance: "NONE",
    reason: "SENDER_PENDING_VERIFICATION",
  });
});

// ── P11 / P12 — DMARC and monotonicity ──────────────────────────────────────

check("P11: DMARC never changes the answer, in either direction", () => {
  for (const dmarc of ALL_VERDICTS) {
    const strong = evaluateSenderAuthorization(
      input({ envelopeMailFrom: CONFIGURED, spfVerdict: "PASS", dmarcVerdict: dmarc })
    );
    assertResult(
      strong,
      { decision: "AUTHORIZED", assurance: "STRONG", reason: "AUTHORIZED_ENVELOPE_SPF" },
      `STRONG with DMARC ${dmarc}`
    );

    // And a DMARC PASS cannot manufacture authorization out of nothing.
    const nothing = evaluateSenderAuthorization(
      input({ headerFrom: CONFIGURED, dmarcVerdict: dmarc })
    );
    assert.notEqual(nothing.decision, "AUTHORIZED", `DMARC ${dmarc} authorized on its own`);
  }
});

check("P12: adding weaker evidence can never upgrade a NONE result", () => {
  const base = evaluateSenderAuthorization(input({ headerFrom: CONFIGURED }));
  assert.equal(base.assurance, "NONE");
  for (const dkim of NON_PASS) {
    for (const dmarc of ALL_VERDICTS) {
      const r = evaluateSenderAuthorization(
        input({ headerFrom: CONFIGURED, dkimVerdict: dkim, dmarcVerdict: dmarc })
      );
      assert.equal(r.assurance, "NONE", `${dkim}/${dmarc} upgraded a NONE result`);
      assert.notEqual(r.decision, "AUTHORIZED");
    }
  }
});

check("a STRONG result stays STRONG whatever else is attached to it", () => {
  for (const dkim of ALL_VERDICTS) {
    for (const dmarc of ALL_VERDICTS) {
      const r = evaluateSenderAuthorization(
        input({
          envelopeMailFrom: CONFIGURED,
          headerFrom: ATTACKER,
          spfVerdict: "PASS",
          dkimVerdict: dkim,
          dmarcVerdict: dmarc,
          headerFromDomainClassification: "SHARED_CONSUMER",
        })
      );
      assertResult(
        r,
        { decision: "AUTHORIZED", assurance: "STRONG", reason: "AUTHORIZED_ENVELOPE_SPF" },
        `dkim=${dkim} dmarc=${dmarc}`
      );
    }
  }
});

// ── P13 / P14 — identities and determinism ──────────────────────────────────

check("P13: an unusable identity can never authorize", () => {
  const broken = [
    "",
    "   ",
    "no-at-sign",
    "two@@at.test",
    "a@b@c.test",
    "@nolocal.test",
    "nodomain@",
    "with space@x.test",
    "new\nline@x.test",
    "nul byte@x.test",
    "tab\there@x.test",
  ];
  for (const bad of broken) {
    // As the envelope, with a passing SPF: must not authorize.
    const asEnvelope = evaluateSenderAuthorization(
      input({ envelopeMailFrom: bad, spfVerdict: "PASS" })
    );
    assert.notEqual(asEnvelope.decision, "AUTHORIZED", `${JSON.stringify(bad)} authorized`);

    // As the configured identity: nothing can match it.
    const asConfigured = evaluateSenderAuthorization(
      input({
        configuredSender: { normalizedEmail: bad, status: "VERIFIED" },
        envelopeMailFrom: bad,
        spfVerdict: "PASS",
      })
    );
    assert.notEqual(asConfigured.decision, "AUTHORIZED", `${JSON.stringify(bad)} configured`);
    assert.equal(asConfigured.reason, "INVALID_CONFIGURED_IDENTITY");
  }
});

check("an SPF pass that cannot be bound to an identity proves nothing", () => {
  const r = evaluateSenderAuthorization(input({ envelopeMailFrom: null, spfVerdict: "PASS" }));
  assertResult(r, {
    decision: "INDETERMINATE",
    assurance: "NONE",
    reason: "INVALID_ENVELOPE_IDENTITY",
  });
});

check("a DKIM pass with an unusable header From proves nothing", () => {
  const r = evaluateSenderAuthorization(
    input({ headerFrom: "not-an-address", dkimVerdict: "PASS" })
  );
  assertResult(r, {
    decision: "INDETERMINATE",
    assurance: "NONE",
    reason: "INVALID_HEADER_FROM_IDENTITY",
  });
});

check("P14: the same input always produces the same result", () => {
  const classifications: SenderDomainClassification[] = [
    "PRIVATE_CONTROLLED",
    "SHARED_CONSUMER",
    "UNKNOWN",
  ];
  let combinations = 0;
  for (const spf of ALL_VERDICTS) {
    for (const dkim of ALL_VERDICTS) {
      for (const cls of classifications) {
        for (const envelope of [CONFIGURED, ATTACKER, null]) {
          const shape = input({
            envelopeMailFrom: envelope,
            headerFrom: CONFIGURED,
            spfVerdict: spf,
            dkimVerdict: dkim,
            headerFromDomainClassification: cls,
          });
          const a = JSON.stringify(evaluateSenderAuthorization(shape));
          const b = JSON.stringify(evaluateSenderAuthorization(shape));
          assert.equal(a, b, `non-deterministic for ${spf}/${dkim}/${cls}`);
          combinations += 1;
        }
      }
    }
  }
  assert.ok(combinations >= 200, `only ${combinations} combinations exercised`);
});

check("no reachable combination authorizes without SPF PASS or DKIM PASS", () => {
  // The blanket statement, swept rather than argued.
  const classifications: SenderDomainClassification[] = [
    "PRIVATE_CONTROLLED",
    "SHARED_CONSUMER",
    "UNKNOWN",
  ];
  for (const spf of NON_PASS) {
    for (const dkim of NON_PASS) {
      for (const dmarc of ALL_VERDICTS) {
        for (const cls of classifications) {
          for (const envelope of [CONFIGURED, ATTACKER, null]) {
            for (const from of [CONFIGURED, ATTACKER, null]) {
              const r = evaluateSenderAuthorization(
                input({
                  envelopeMailFrom: envelope,
                  headerFrom: from,
                  spfVerdict: spf,
                  dkimVerdict: dkim,
                  dmarcVerdict: dmarc,
                  headerFromDomainClassification: cls,
                })
              );
              assert.notEqual(r.decision, "AUTHORIZED", `authorized on ${spf}/${dkim}`);
              assert.equal(r.assurance, "NONE");
            }
          }
        }
      }
    }
  }
});

// ── P15 / P16 — purity and the forbidden inputs ─────────────────────────────

const SOURCES = [
  "lib/inbound-email/sender-auth/evaluate-sender-authorization.ts",
  "lib/inbound-email/sender-auth/sender-authorization-contract.ts",
  "lib/inbound-email/sender-auth/sender-domain-classification.ts",
];

function codeOf(rel: string): string {
  const root = path.resolve(__dirname, "../../..");
  return fs
    .readFileSync(path.join(root, rel), "utf8")
    .split("\n")
    .filter(
      (l) =>
        !l.trimStart().startsWith("//") &&
        !l.trimStart().startsWith("*") &&
        !l.trimStart().startsWith("/*")
    )
    .join("\n");
}

check("P15: the evaluator performs no database, network or storage work", () => {
  for (const rel of SOURCES) {
    const code = codeOf(rel);
    for (const forbidden of [
      "@/lib/prisma",
      "PrismaClient",
      "fetch(",
      "axios",
      "dns",
      "resolveTxt",
      "resolveMx",
      "S3Client",
      "writeFileSync",
      "process.env",
      "Date.now",
      "Math.random",
      "console.",
    ]) {
      assert.ok(!code.includes(forbidden), `${rel} reaches ${forbidden}`);
    }
  }
});

check("P16: no message-supplied authentication header is an input", () => {
  for (const rel of SOURCES) {
    const code = codeOf(rel);
    for (const forbidden of [
      "Authentication-Results",
      "authenticationResults",
      "authservId",
      "Received-SPF",
      "receivedSpf",
      "DKIM-Signature",
      "signingDomain",
      "returnPath",
      "Return-Path",
      "deliveredTo",
      "Delivered-To",
      "X-Forwarded",
      "replyTo",
    ]) {
      assert.ok(!code.includes(forbidden), `${rel} uses ${forbidden} as authorization input`);
    }
  }
});

check("the evaluator has no runtime callers", () => {
  const root = path.resolve(__dirname, "../../..");
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        if (fs.readFileSync(path.join(root, rel), "utf8").includes("evaluateSenderAuthorization")) {
          hits.push(rel);
        }
      }
    }
  };
  for (const r of ["app", "components", "lib"]) walk(r);
  assert.deepEqual(
    hits,
    ["lib/inbound-email/sender-auth/evaluate-sender-authorization.ts"],
    "the evaluator gained a caller; T3 closes with zero"
  );
});

check("the evaluator never returns the database's NOT_EVALUATED default", () => {
  const classifications: SenderDomainClassification[] = [
    "PRIVATE_CONTROLLED",
    "SHARED_CONSUMER",
    "UNKNOWN",
  ];
  for (const spf of ALL_VERDICTS) {
    for (const dkim of ALL_VERDICTS) {
      for (const cls of classifications) {
        const r = evaluateSenderAuthorization(
          input({
            envelopeMailFrom: CONFIGURED,
            headerFrom: CONFIGURED,
            spfVerdict: spf,
            dkimVerdict: dkim,
            headerFromDomainClassification: cls,
          })
        );
        assert.ok(
          ["AUTHORIZED", "UNAUTHORIZED", "INDETERMINATE"].includes(r.decision),
          `returned ${r.decision}`
        );
      }
    }
  }
});

console.log(`\n  ${passed} passed, ${failed} failed`);
if (failures.length > 0) console.log(`  failing: ${failures.join(" | ")}`);
console.log("");
process.exit(failed === 0 ? 0 : 1);
