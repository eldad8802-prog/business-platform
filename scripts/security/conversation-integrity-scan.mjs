/**
 * D2 / ACCOUNT-DELETION-2A — Conversation-graph cross-tenant integrity scanner.
 *
 * STRICTLY READ-ONLY. Every statement is a SELECT; there is no INSERT, UPDATE,
 * DELETE, TRUNCATE or DDL anywhere in this file, and CI asserts that.
 *
 * WHY IT EXISTS. Deleting a Conversation cascades to its Messages and, through them,
 * to MessageAnalysis and ReplySuggestion. PostgreSQL executes those cascades through
 * internal system triggers that are NOT subject to row-level security and NOT subject
 * to the invoking role's table privileges. So the safety of that cascade rests
 * entirely on one assumption: every row it reaches belongs to the same business as
 * the Conversation being deleted.
 *
 * That assumption is NOT enforced by the schema. There is no composite foreign key on
 * (businessId, id) and no CHECK constraint anywhere on the graph — a Message row
 * carries its own businessId INDEPENDENTLY of the Conversation it points at. Nothing
 * but application code has ever guaranteed the two agree.
 *
 * This scanner measures whether that has always held. It is a PREREQUISITE for
 * ACCOUNT-DELETION-2B: no DELETE capability may be granted on this graph until the
 * scan is clean, because a single historical mismatch turns a legitimate tenant
 * deletion into a cross-tenant one.
 *
 * NOTE ON MessageAnalysis: it has no businessId of its own (ownership is purely
 * `messageId`, which is @unique), so there is no coherence edge to check for it — its
 * ownership cannot disagree with anything. The AD-1 recon listed it as an edge; that
 * was wrong and is corrected here.
 *
 * Usage:  DIRECT_URL=... node scripts/security/conversation-integrity-scan.mjs
 * Exit 0 = clean, exit 1 = mismatches found (or the scan could not run).
 */
import { PrismaClient } from "@prisma/client";

/**
 * Every edge on which a child's own businessId can disagree with the business of the
 * row it points at. Each query returns the offending ids so a finding is actionable,
 * never just a number.
 */
const EDGES = [
  {
    name: "Message.businessId <> Conversation.businessId",
    sql: `SELECT m."id" AS child_id, m."businessId" AS child_business, c."businessId" AS parent_business
          FROM "Message" m JOIN "Conversation" c ON c."id" = m."conversationId"
          WHERE m."businessId" <> c."businessId"`,
  },
  {
    name: "Conversation.businessId <> Customer.businessId",
    sql: `SELECT c."id", c."businessId", cu."businessId"
          FROM "Conversation" c JOIN "Customer" cu ON cu."id" = c."customerId"
          WHERE c."businessId" <> cu."businessId"`,
  },
  {
    name: "Conversation.businessId <> Lead.businessId",
    sql: `SELECT c."id", c."businessId", l."businessId"
          FROM "Conversation" c JOIN "Lead" l ON l."id" = c."leadId"
          WHERE c."businessId" <> l."businessId"`,
  },
  {
    name: "Message.businessId <> Customer.businessId",
    sql: `SELECT m."id", m."businessId", cu."businessId"
          FROM "Message" m JOIN "Customer" cu ON cu."id" = m."customerId"
          WHERE m."businessId" <> cu."businessId"`,
  },
  {
    name: "Message.businessId <> generatedFromSuggestion.businessId",
    sql: `SELECT m."id", m."businessId", r."businessId"
          FROM "Message" m JOIN "ReplySuggestion" r ON r."id" = m."generatedFromSuggestionId"
          WHERE m."businessId" <> r."businessId"`,
  },
  {
    name: "ReplySuggestion.businessId <> Conversation.businessId",
    sql: `SELECT r."id", r."businessId", c."businessId"
          FROM "ReplySuggestion" r JOIN "Conversation" c ON c."id" = r."conversationId"
          WHERE r."businessId" <> c."businessId"`,
  },
  {
    name: "ReplySuggestion.businessId <> sourceMessage.businessId",
    sql: `SELECT r."id", r."businessId", m."businessId"
          FROM "ReplySuggestion" r JOIN "Message" m ON m."id" = r."messageId"
          WHERE r."businessId" <> m."businessId"`,
  },
  {
    name: "ReplySuggestion.businessId <> sentMessage.businessId",
    sql: `SELECT r."id", r."businessId", m."businessId"
          FROM "ReplySuggestion" r JOIN "Message" m ON m."id" = r."sentMessageId"
          WHERE r."businessId" <> m."businessId"`,
  },
  {
    name: "Appointment.businessId <> sourceConversation.businessId",
    sql: `SELECT a."id", a."businessId", c."businessId"
          FROM "Appointment" a JOIN "Conversation" c ON c."id" = a."sourceConversationId"
          WHERE a."businessId" <> c."businessId"`,
  },
  {
    name: "Appointment.businessId <> sourceMessage.businessId",
    sql: `SELECT a."id", a."businessId", m."businessId"
          FROM "Appointment" a JOIN "Message" m ON m."id" = a."sourceMessageId"
          WHERE a."businessId" <> m."businessId"`,
  },
  {
    name: "Appointment.businessId <> Customer.businessId",
    sql: `SELECT a."id", a."businessId", cu."businessId"
          FROM "Appointment" a JOIN "Customer" cu ON cu."id" = a."customerId"
          WHERE a."businessId" <> cu."businessId"`,
  },
  {
    name: "Appointment.businessId <> Lead.businessId",
    sql: `SELECT a."id", a."businessId", l."businessId"
          FROM "Appointment" a JOIN "Lead" l ON l."id" = a."leadId"
          WHERE a."businessId" <> l."businessId"`,
  },
];

/** Endpoints this scan must never be pointed at. */
const DENY_ENDPOINTS = ["ep-flat-brook-am4bhq1y", "ep-winter-bread-ami5o8p5"];

export async function scanConversationIntegrity(client) {
  const findings = [];
  for (const edge of EDGES) {
    const rows = await client.$queryRawUnsafe(edge.sql);
    findings.push({ edge: edge.name, count: rows.length, rows: rows.slice(0, 20) });
  }
  return findings;
}

async function main() {
  const url = process.env.DIRECT_URL;
  if (!url) {
    console.error("[integrity-scan] DIRECT_URL missing");
    process.exit(1);
  }
  for (const bad of DENY_ENDPOINTS) {
    if (url.includes(bad)) {
      console.error(`[integrity-scan] DENY: forbidden endpoint (${bad})`);
      process.exit(1);
    }
  }

  const client = new PrismaClient({ datasourceUrl: url });
  try {
    const findings = await scanConversationIntegrity(client);
    let bad = 0;
    for (const f of findings) {
      if (f.count === 0) {
        console.log(`  [CLEAN] ${f.edge}`);
      } else {
        bad += f.count;
        console.log(`  [MISMATCH x${f.count}] ${f.edge}`);
        console.log(`           ${JSON.stringify(f.rows)}`);
      }
    }
    console.log(
      `\n[integrity-scan] edges=${EDGES.length} mismatches=${bad} verdict=${bad === 0 ? "PASS" : "FAIL"}`
    );
    process.exit(bad === 0 ? 0 : 1);
  } finally {
    await client.$disconnect();
  }
}

if (process.argv[1] && process.argv[1].endsWith("conversation-integrity-scan.mjs")) {
  main().catch((e) => {
    console.error("[integrity-scan] FATAL:", e);
    process.exit(1);
  });
}
