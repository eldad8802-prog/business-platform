/**
 * TEMPORARY ITA PRODUCTION app registration — service. Run manually:
 *   npx tsx lib/services/billing/authority/billing-authority-production-app-registration.verify.test.ts
 *
 * Pure: in-memory DB double, a throw-away encryption key generated here. No DB,
 * no network (DATABASE_URL points at a closed loopback port, so a stray real
 * client call fails locally instead of reaching anything).
 *
 * Proves: dry-run never writes; apply creates exactly one PRODUCTION / ACTIVE /
 * authority_gcm_v1 row and never overwrites (existing row or a racing P2002 →
 * APP_ALREADY_REGISTERED); invalid input (incl. a whitespace-wrapped secret) is
 * refused with typed codes before any key or DB work; a missing/bad key →
 * ENCRYPTION_KEY_UNAVAILABLE; the stored ciphertext decrypts to the secret
 * under the PRODUCTION AAD only; the secret and the key never appear in any
 * result, error code or log line.
 */
process.env.DATABASE_URL = "postgresql://registration-test@127.0.0.1:1/none";

import { randomBytes } from "node:crypto";
import { BillingAuthorityEnvironment } from "@prisma/client";
import {
  AUTHORITY_APP_REGISTRATION_CODES as C,
  maskTail,
  registerProductionAuthorityApp,
  type AuthorityAppRegistrationDb,
  type AuthorityAppRegistrationRow,
} from "@/lib/services/billing/authority/billing-authority-production-app-registration.service";
import { decryptAuthorityAppSecret } from "@/lib/services/billing/authority/billing-authority-token-crypto.service";

const KEY = randomBytes(32).toString("base64");
process.env.BILLING_AUTHORITY_ENCRYPTION_KEY = KEY;

const SECRET = "Sx9-prod-secret-VALUE-7f3a2b1c9d";
const CLIENT_ID = "abcd-client-id-98765";
const SOFTWARE = "270901";
const PORTAL = "16650";

let failures = 0;
function ok(name: string, cond: unknown) {
  if (cond) {
    console.log(`OK: ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL: ${name}`);
  }
}

// Capture everything the service logs so it can be searched for leaks.
const logged: string[] = [];
const origError = console.error;
console.error = (...args: unknown[]) => {
  logged.push(args.map((a) => String(a)).join(" "));
  origError(...args);
};

type FakeDb = AuthorityAppRegistrationDb & {
  rows: AuthorityAppRegistrationRow[];
  finds: number;
  creates: number;
};

function fakeDb(opts: { existing?: boolean; createError?: unknown; findError?: unknown } = {}): FakeDb {
  const db: FakeDb = {
    rows: [],
    finds: 0,
    creates: 0,
    billingAuthorityApp: {
      findUnique: async ({ where }) => {
        db.finds += 1;
        if (opts.findError) throw opts.findError;
        if (opts.existing) return { id: 1 };
        return db.rows.some((r) => r.environment === where.environment) ? { id: 2 } : null;
      },
      createMany: async ({ data }) => {
        db.creates += 1;
        if (opts.createError) throw opts.createError;
        if (db.rows.some((r) => r.environment === data.environment)) {
          throw Object.assign(new Error(`Unique constraint failed ${data.itaClientId}`), { code: "P2002" });
        }
        db.rows.push(data);
        return { count: 1 };
      },
    },
  };
  return db;
}

const NOW = new Date("2026-11-02T10:00:00.000Z");
const base = {
  itaClientId: CLIENT_ID,
  clientSecret: SECRET,
  accountingSoftwareNumber: SOFTWARE,
  portalApplicationId: PORTAL,
};
const observed: string[] = [];
const see = (v: unknown) => {
  observed.push(JSON.stringify(v));
  return v;
};

async function main() {
  // ---------------- dry-run ----------------
  {
    const db = fakeDb();
    const r = see(await registerProductionAuthorityApp({ mode: "dry-run", ...base }, { db, now: () => NOW })) as Awaited<
      ReturnType<typeof registerProductionAuthorityApp>
    >;
    ok("dry-run succeeds", r.ok);
    ok("dry-run performs no write", db.creates === 0 && db.rows.length === 0);
    ok("dry-run checks for an existing row", db.finds === 1);
    if (r.ok) {
      ok("dry-run summary: mode dry-run, PRODUCTION, keyCheck OK, created false",
        r.summary.mode === "dry-run" && r.summary.environment === "PRODUCTION" && r.summary.keyCheck === "OK" && r.summary.created === false);
      ok("dry-run summary masks client id and software number",
        r.summary.itaClientId === "***8765" && r.summary.accountingSoftwareNumber === "***0901");
      ok("dry-run summary keeps portal application id", r.summary.portalApplicationId === PORTAL);
    }
  }

  // ---------------- apply: creates once ----------------
  const db = fakeDb();
  {
    const r = see(await registerProductionAuthorityApp({ mode: "apply", ...base }, { db, now: () => NOW })) as Awaited<
      ReturnType<typeof registerProductionAuthorityApp>
    >;
    ok("apply succeeds", r.ok && r.summary.created === true && r.summary.mode === "apply");
    ok("apply writes exactly one row", db.creates === 1 && db.rows.length === 1);
    const row = db.rows[0]!;
    ok("row environment is PRODUCTION", row.environment === BillingAuthorityEnvironment.PRODUCTION);
    ok("row status ACTIVE", row.status === "ACTIVE");
    ok("row encryptionKeyId authority_gcm_v1", row.encryptionKeyId === "authority_gcm_v1");
    ok("row registeredAt = now", row.registeredAt.getTime() === NOW.getTime());
    ok("row portalOrganizationId null, portalApplicationId set", row.portalOrganizationId === null && row.portalApplicationId === PORTAL);
    ok("row lastValidatedAt/lastErrorCode/lastErrorMessage null",
      row.lastValidatedAt === null && row.lastErrorCode === null && row.lastErrorMessage === null);
    ok("row stores client id and software number in full", row.itaClientId === CLIENT_ID && row.accountingSoftwareNumber === SOFTWARE);
    ok("row never stores the plaintext secret", !JSON.stringify(row).includes(SECRET));
    const material = { encrypted: row.clientSecretEncrypted, iv: row.clientSecretIv, tag: row.clientSecretTag };
    ok("stored ciphertext decrypts to the secret under PRODUCTION",
      decryptAuthorityAppSecret(material, BillingAuthorityEnvironment.PRODUCTION) === SECRET);
    ok("stored ciphertext does NOT decrypt under SANDBOX",
      decryptAuthorityAppSecret(material, BillingAuthorityEnvironment.SANDBOX) === null);
  }

  // ---------------- second apply / dry-run refused ----------------
  {
    const r = see(await registerProductionAuthorityApp({ mode: "apply", ...base, itaClientId: "other-id" }, { db, now: () => NOW }));
    ok("second apply → APP_ALREADY_REGISTERED", !(r as { ok: boolean }).ok && (r as { code: string }).code === C.APP_ALREADY_REGISTERED);
    ok("second apply performs no write", db.creates === 1 && db.rows.length === 1 && db.rows[0]!.itaClientId === CLIENT_ID);
    const d = see(await registerProductionAuthorityApp({ mode: "dry-run", ...base }, { db }));
    ok("dry-run after registration also reports APP_ALREADY_REGISTERED", (d as { code?: string }).code === C.APP_ALREADY_REGISTERED);
  }

  // ---------------- racing insert (P2002) ----------------
  {
    const race = fakeDb({ createError: Object.assign(new Error(`dup ${CLIENT_ID}`), { code: "P2002" }) });
    const r = see(await registerProductionAuthorityApp({ mode: "apply", ...base }, { db: race }));
    ok("P2002 on create → APP_ALREADY_REGISTERED", (r as { code?: string }).code === C.APP_ALREADY_REGISTERED);
  }
  {
    const broken = fakeDb({ createError: Object.assign(new Error(`boom ${SECRET} ${CLIENT_ID}`), { code: "P1001" }) });
    const r = see(await registerProductionAuthorityApp({ mode: "apply", ...base }, { db: broken }));
    ok("other write error → WRITE_FAILED", (r as { code?: string }).code === C.WRITE_FAILED);
    const readBroken = fakeDb({ findError: new Error(`read ${SECRET}`) });
    const r2 = see(await registerProductionAuthorityApp({ mode: "dry-run", ...base }, { db: readBroken }));
    ok("read error → READ_FAILED", (r2 as { code?: string }).code === C.READ_FAILED);
  }

  // ---------------- input validation ----------------
  const invalid: Array<[string, Record<string, unknown>, string]> = [
    ["empty client id", { itaClientId: "   " }, C.INVALID_CLIENT_ID],
    ["client id with inner whitespace", { itaClientId: "abc def" }, C.INVALID_CLIENT_ID],
    ["client id > 200", { itaClientId: "a".repeat(201) }, C.INVALID_CLIENT_ID],
    ["empty secret", { clientSecret: "" }, C.INVALID_CLIENT_SECRET],
    ["whitespace-only secret", { clientSecret: "   " }, C.INVALID_CLIENT_SECRET],
    ["secret > 1000", { clientSecret: "s".repeat(1001) }, C.INVALID_CLIENT_SECRET],
    ["secret with leading space", { clientSecret: ` ${SECRET}` }, C.CLIENT_SECRET_SURROUNDING_WHITESPACE],
    ["secret with trailing space", { clientSecret: `${SECRET} ` }, C.CLIENT_SECRET_SURROUNDING_WHITESPACE],
    ["secret with trailing newline", { clientSecret: `${SECRET}\n` }, C.CLIENT_SECRET_SURROUNDING_WHITESPACE],
    ["software number non-digit", { accountingSoftwareNumber: "27O901" }, C.INVALID_ACCOUNTING_SOFTWARE_NUMBER],
    ["software number > 12 digits", { accountingSoftwareNumber: "1234567890123" }, C.INVALID_ACCOUNTING_SOFTWARE_NUMBER],
    ["portal id non-digit", { portalApplicationId: "16a50" }, C.INVALID_PORTAL_APPLICATION_ID],
    ["mode unknown", { mode: "upsert" }, C.INVALID_MODE],
  ];
  for (const [name, patch, code] of invalid) {
    const d = fakeDb();
    const r = see(await registerProductionAuthorityApp({ mode: "apply", ...base, ...patch } as never, { db: d }));
    ok(`invalid: ${name} → ${code}, no DB access`, (r as { code?: string }).code === code && d.finds === 0 && d.creates === 0);
  }
  {
    const d = fakeDb();
    const r = see(await registerProductionAuthorityApp({ mode: "dry-run", ...base, portalApplicationId: "" }, { db: d }));
    ok("empty portal id is treated as absent", (r as { ok: boolean }).ok && (r as { summary: { portalApplicationId: unknown } }).summary.portalApplicationId === null);
  }
  {
    const d = fakeDb();
    const r = see(await registerProductionAuthorityApp({ mode: "dry-run", ...base, environment: "SANDBOX" } as never, { db: d }));
    ok("an injected environment field cannot change PRODUCTION", (r as { summary?: { environment: string } }).summary?.environment === "PRODUCTION");
  }

  // ---------------- key unavailable ----------------
  for (const [name, value] of [["missing", undefined], ["blank", "  "], ["wrong length", randomBytes(16).toString("base64")]] as const) {
    if (value === undefined) delete process.env.BILLING_AUTHORITY_ENCRYPTION_KEY;
    else process.env.BILLING_AUTHORITY_ENCRYPTION_KEY = value;
    const d = fakeDb();
    const r = see(await registerProductionAuthorityApp({ mode: "apply", ...base }, { db: d }));
    ok(`key ${name} → ENCRYPTION_KEY_UNAVAILABLE, no DB access`,
      (r as { code?: string }).code === C.ENCRYPTION_KEY_UNAVAILABLE && d.finds === 0 && d.creates === 0);
  }
  process.env.BILLING_AUTHORITY_ENCRYPTION_KEY = KEY;
  {
    const d = fakeDb();
    const r = see(
      await registerProductionAuthorityApp({ mode: "apply", ...base }, {
        db: d,
        crypto: {
          encrypt: () => ({ encrypted: "AA==", iv: "AA==", tag: "AA==" }),
          decrypt: () => "not-the-secret",
        },
      })
    );
    ok("round-trip mismatch → KEY_CHECK_FAILED, no write", (r as { code?: string }).code === C.KEY_CHECK_FAILED && d.creates === 0);
  }

  // ---------------- no leaks ----------------
  const everything = observed.join("\n") + "\n" + logged.join("\n");
  ok("secret never appears in results or logs", !everything.includes(SECRET));
  ok("key never appears in results or logs", !everything.includes(KEY));
  ok("full client id never appears in results or logs", !everything.includes(CLIENT_ID));
  ok("maskTail shape", maskTail("1234567") === "***4567" && maskTail("") === "");

  console.error = origError;
  if (failures > 0) {
    console.error(`${failures} FAILED`);
    process.exit(1);
  }
  console.log("ALL PASS");
}

void main().catch((e) => {
  console.error = origError;
  console.error(e instanceof Error ? e.name : "UnknownError");
  process.exit(1);
});
