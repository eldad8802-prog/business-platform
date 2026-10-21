/**
 * Monthly accountant workflow — the APPLICATION, end to end, on the Production-shaped lab:
 *   tenant plane (DATABASE_URL = app_runtime_prod, NOBYPASSRLS), owner (OWNER_URL) for fixtures and read-back.
 * Storage is the local adapter in a temp directory; the email provider is a fake that records what it was
 * handed. Nothing leaves the machine.
 *
 *   A. Preparation: the 1st-of-month build, idempotency, concurrent runs, a late approval → a new version.
 *   B. The package's contents: sections, the issued PDF by its recorded hash, the pending list, the manifest.
 *   C. Notices: one live notification per month, the exact Hebrew wording, no repeat inside the cooldown;
 *      /attention and the Home status say the same; Daily Tasks carries no accountant source.
 *   D. Approval: every binding (sha256, version, recipient, D2 acknowledgement, one in flight, idempotency).
 *   E. Sending: accepted by the provider ≠ delivered; the link opens exactly the approved object, is counted,
 *      revocable, and dead for another business; provider events; a failure path; a recipient change voids a
 *      waiting approval; a change after sending → a revised version, never a re-send.
 *   F. The sweep: an ineligible business is never read; an eligible one is prepared once.
 *
 * env: OWNER_URL, DATABASE_URL (runtime). Everything else is set below. Synthetic only.
 */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

process.env.STORAGE_PROVIDER = "local";
process.env.LOCAL_STORAGE_ROOT = process.env.ACCT_LAB_STORAGE_ROOT || mkdtempSync(path.join(os.tmpdir(), "acct-lab-"));
process.env.AUTH_TOKEN_SECRET = "acct-lab-synthetic-auth-token-secret-0123456789";
process.env.TRANSACTIONAL_EMAIL_ENABLED = "true";
process.env.RESEND_API_KEY = "re_lab_synthetic";
process.env.TRANSACTIONAL_EMAIL_FROM = "Dubiz <no-reply@example.com>";
process.env.APP_BASE_URL = "https://app.example.com";
process.env.ACCOUNTANT_DELIVERY_ENABLED = "true";

import { PrismaClient } from "@prisma/client";

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { failures.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}
async function throwsCode(fn: () => Promise<unknown>, code: string): Promise<boolean> {
  try {
    await fn();
    return false;
  } catch (e) {
    return (e as { code?: string }).code === code;
  }
}

/** Minimal ZIP central-directory reader (names only). */
function zipNames(buf: Buffer): string[] {
  const names: string[] = [];
  for (let o = 0; o + 46 <= buf.length; o++) {
    if (buf[o] !== 0x50 || buf[o + 1] !== 0x4b || buf[o + 2] !== 0x01 || buf[o + 3] !== 0x02) continue;
    const n = buf.readUInt16LE(o + 28), e = buf.readUInt16LE(o + 30), c = buf.readUInt16LE(o + 32);
    names.push(buf.subarray(o + 46, o + 46 + n).toString("utf8"));
    o += 46 + n + e + c - 1;
  }
  return names;
}

async function main() {
  const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });
  const { runWithTenantContext } = await import("@/lib/tenant/context");
  const { tenantTx } = await import("@/lib/tenant/tenant-tx");
  const { getStorageService } = await import("@/lib/storage");
  const { putDocumentObject } = await import("@/lib/services/documents/document-storage.service");
  const { writeAtomic } = await import("@/lib/services/billing/pdf/billing-pdf-storage");
  const prep = await import("@/lib/accountant/prepare.service");
  const { syncPeriodNotice } = await import("@/lib/accountant/notify");
  const { loadAccountantAttention } = await import("@/lib/accountant/attention");
  const { getBusinessStatusSnapshot } = await import("@/lib/business-status/business-status.service");
  const { setRecipient } = await import("@/lib/accountant/recipient.service");
  const del = await import("@/lib/accountant/delivery.service");
  const { hashAccountantLinkSecret } = await import("@/lib/accountant/link");
  const { getPeriodView } = await import("@/lib/accountant/view.service");
  const { noteDocumentChangeForAccountant } = await import("@/lib/accountant/change-hooks");
  const { runAccountantSweep, defaultSweepDeps } = await import("@/lib/accountant/sweep");
  const { prisma } = await import("@/lib/prisma");

  // The 2nd of October 2026, 09:00 Israel time: September is closed.
  let clock = new Date("2026-10-02T06:00:00Z");
  const deps = { ...prep.defaultPrepareDeps, now: () => clock };
  const KEY = "2026-09";

  // ── Tenant RLS on every table the workflow READS ───────────────────────────────────────────────
  // The base lab builds the schema with `db push` and only records the historical migrations, so the tables
  // the workflow reads carry no RLS here. They are put under tenant-only FORCE RLS (the semantics Production's
  // policies enforce), so this battery proves every read goes through the tenant context — a context-less or
  // cross-business read would see nothing and a test below would fail.
  for (const t of ["FinancialRecord", "Document", "BillingDocument", "BillingAuthoritySubmission", "Notification", "NotificationDelivery", "BusinessProfile", "BusinessFeatureAccess"]) {
    const on = (await owner.$queryRawUnsafe(`SELECT relforcerowsecurity AS f FROM pg_class WHERE relname = $1`, t)) as { f: boolean }[];
    if (on[0]?.f) continue;
    await owner.$executeRawUnsafe(`ALTER TABLE "${t}" ENABLE ROW LEVEL SECURITY`);
    await owner.$executeRawUnsafe(`ALTER TABLE "${t}" FORCE ROW LEVEL SECURITY`);
    await owner.$executeRawUnsafe(`CREATE POLICY acct_lab_tenant ON "${t}" FOR ALL
      USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
      WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)`);
  }
  // ExtractedData has no businessId: it is reached through its Document (whose RLS now applies).

  // ── Fixtures (owner) ───────────────────────────────────────────────────────────────────────────
  const one = async (sql: string, ...a: unknown[]) => Number(((await owner.$queryRawUnsafe(sql, ...a)) as { id: number }[])[0].id);
  const bizA = await one(`INSERT INTO "Business" ("name", "updatedAt") VALUES ('מאפיית הלב', now()) RETURNING "id"`);
  const bizB = await one(`INSERT INTO "Business" ("name", "updatedAt") VALUES ('acct-app-B', now()) RETURNING "id"`);
  const userA = await one(`INSERT INTO "User" ("email", "password", "businessId", "updatedAt") VALUES ('owner-a@acct.lab', 'x', $1, now()) RETURNING "id"`, bizA);
  await owner.$executeRawUnsafe(`INSERT INTO "BusinessFeatureAccess" ("businessId", "featureKey", "state", "updatedAt") VALUES ($1, 'accountant_month_close', 'ENABLED', now())`, bizA);
  await owner.$executeRawUnsafe(`INSERT INTO "BusinessProfile" ("businessId", "billingLegalName", "billingTaxId", "updatedAt") VALUES ($1, 'מאפיית הלב בע"מ', '515151515', now()) ON CONFLICT DO NOTHING`, bizA);

  const doc = async (b: number, status: string, createdAt: string, n: number) => {
    const basename = `doc-${Date.now()}${n}-lab${n}.pdf`;
    await putDocumentObject({ businessId: b, basename, body: Buffer.from(`%PDF-lab-${n}`), contentType: "application/pdf", source: "file" });
    return one(`INSERT INTO "Document" ("businessId", "fileUrl", "source", "mimeType", "status", "createdAt") VALUES ($1, $2, 'file', 'application/pdf', $3, $4::timestamp) RETURNING "id"`, b, basename, status, createdAt);
  };
  const record = (b: number, d: number, amount: number, date: string, direction: string, vendor: string) =>
    owner.$executeRawUnsafe(`INSERT INTO "FinancialRecord" ("documentId", "businessId", "amount", "date", "vendorName", "direction", "category") VALUES ($1, $2, $3, $4::timestamp, $5, $6, 'general')`, d, b, amount, date, vendor, direction);
  const d1 = await doc(bizA, "approved", "2026-09-05T08:00:00", 1);
  await record(bizA, d1, 250.5, "2026-09-04T00:00:00", "expense", "ספק חשמל");
  const d2 = await doc(bizA, "approved", "2026-09-12T08:00:00", 2);
  await record(bizA, d2, 1180, "2026-09-12T00:00:00", "income", "מאפיית הלב בע\"מ");
  const dPending = await doc(bizA, "needs_review", "2026-09-28T08:00:00", 3);
  // October's record must never appear in September.
  const dOct = await doc(bizA, "approved", "2026-10-01T08:00:00", 4);
  await record(bizA, dOct, 99, "2026-09-30T21:30:00", "expense", "אוקטובר");
  // An issued receipt with its rendered PDF stored under its own hash.
  const pdf = Buffer.from("%PDF-issued-receipt-lab");
  const pdfHash = createHash("sha256").update(pdf).digest("hex");
  const rcpt = await one(`INSERT INTO "BillingDocument" ("businessId", "documentType", "status", "documentNumber", "documentNumberFormatted", "issuedAt", "subtotalAmount", "vatAmount", "totalAmount", "customerNameSnapshot", "pdfRenderStatus", "updatedAt")
    VALUES ($1, 'RECEIPT', 'ISSUED', 1, 'R-0001', '2026-09-12T09:00:00', 1180, 0, 1180, 'לקוח', 'RENDERED', now()) RETURNING "id"`, bizA);
  const pdfKey = `biz/${bizA}/billing/${rcpt}/${pdfHash}.pdf`;
  await writeAtomic(pdfKey, pdf);
  await owner.$executeRawUnsafe(`UPDATE "BillingDocument" SET "pdfStorageKey" = $1, "pdfHash" = $2 WHERE "id" = $3`, pdfKey, pdfHash, rcpt);

  const inA = <T>(fn: () => Promise<T>) => runWithTenantContext({ businessId: bizA }, fn);
  const prepare = (trigger: "SCHEDULE" | "CHANGE" | "OWNER" = "SCHEDULE") =>
    inA(() => prep.preparePeriod({ businessId: bizA, periodKey: KEY, trigger, actor: trigger === "OWNER" ? { type: "OWNER_USER", userId: userA } : { type: "SYSTEM" } }, deps));
  const period = () => owner.accountantPeriod.findUniqueOrThrow({ where: { businessId_periodKey: { businessId: bizA, periodKey: KEY } } });

  // ── A. Preparation ─────────────────────────────────────────────────────────────────────────────
  console.log("A. preparation");
  ok("an open month is not prepared", (await inA(() => prep.preparePeriod({ businessId: bizA, periodKey: "2026-10", trigger: "SCHEDULE", actor: { type: "SYSTEM" } }, deps))).outcome === "not_closed");
  const first = await prepare();
  ok("the first run builds version 1", first.outcome === "built" && first.packageVersion === 1, JSON.stringify(first));
  ok("with a document still waiting, the month NEEDS_ATTENTION (not 'ready')", "status" in first && first.status === "NEEDS_ATTENTION");
  const again = await prepare();
  ok("the same data again builds nothing new", again.outcome === "evaluated" && again.packageVersion === 1, JSON.stringify(again));
  const [c1, c2] = await Promise.all([prepare(), prepare()]);
  ok("two overlapping runs never build a second version of the same content",
    (await owner.accountantPackage.count({ where: { businessId: bizA } })) === 1 && [c1.outcome, c2.outcome].every((o) => o === "evaluated" || o === "busy"), `${c1.outcome}/${c2.outcome}`);
  // A live lease (another run mid-evaluation) makes this run back off without touching anything.
  await owner.$executeRawUnsafe(`UPDATE "AccountantPeriod" SET "leaseUntil" = $1::timestamp WHERE "businessId" = $2`, new Date(clock.getTime() + 60_000).toISOString(), bizA);
  const held = await prepare();
  ok("while another run holds the lease, this one backs off", held.outcome === "busy", JSON.stringify(held));
  await owner.$executeRawUnsafe(`UPDATE "AccountantPeriod" SET "leaseUntil" = NULL WHERE "businessId" = $1`, bizA);

  // ── B. Contents ────────────────────────────────────────────────────────────────────────────────
  console.log("B. contents");
  const p1 = await owner.accountantPackage.findFirstOrThrow({ where: { businessId: bizA, version: 1 } });
  ok("the object lives under the business's private exports prefix", p1.storageKey!.startsWith(`biz/${bizA}/exports/accountant/2026-09/`), p1.storageKey!);
  const obj = await getStorageService().getObject(p1.storageKey!);
  ok("the stored object's sha256 is the recorded one", createHash("sha256").update(obj.body).digest("hex") === p1.sha256);
  ok("storage metadata: private, this business, exports", obj.metadata.visibility === "private" && obj.metadata.businessId === bizA && obj.metadata.domain === "exports");
  const names = zipNames(obj.body);
  ok("the ZIP has the report, the summary, the manifest", names.includes(`דוח_${KEY}.xlsx`) && names.includes("סיכום.txt") && names.includes("_meta/manifest.json"), names.join(","));
  ok("the issued receipt's final PDF is included", names.includes("issued/receipt-R-0001.pdf"), names.join(","));
  ok("both approved September originals are included", names.includes(`approved/doc-${d1}.pdf`) && names.includes(`approved/doc-${d2}.pdf`));
  ok("October's record is not in September (Israeli boundary)", !names.includes(`approved/doc-${dOct}.pdf`));
  ok("the pending document is not a file in the package", !names.some((n) => n.includes(`doc-${dPending}`)));
  const m1 = p1.manifest as Record<string, unknown>;
  ok("manifest: 2 records, 1 issued, 1 pending, nothing missing", m1.recordCount === 2 && m1.issuedCount === 1 && m1.pendingCount === 1 && m1.missingFiles === 0, JSON.stringify(m1));
  const pr = await period();
  const rd = pr.readiness as { warnings: { kind: string }[]; blockers: { kind: string }[] };
  ok("the scanned income that matches the issued receipt is flagged (warning, not removed)", rd.warnings.some((w) => w.kind === "POSSIBLE_DUPLICATE_INCOME"), JSON.stringify(rd));
  ok("the pending document is the open item", rd.blockers.length === 1 && rd.blockers[0].kind === "DOCUMENTS_PENDING_REVIEW");

  // ── D (part 1). D2 on an incomplete package ────────────────────────────────────────────────────
  console.log("D. approval (incomplete package)");
  const setR = (email: string, expectedVersion: number | null) =>
    inA(() => setRecipient({ businessId: bizA, userId: userA, name: "רו\"ח דנה", email, expectedVersion, confirm: true, now: clock }));
  ok("a recipient change without confirmation is refused", await throwsCode(() => inA(() => setRecipient({ businessId: bizA, userId: userA, name: "x", email: "a@b.co", expectedVersion: null, confirm: false, now: clock })), "CONFIRMATION_REQUIRED"));
  ok("an invalid address is refused", await throwsCode(() => setR("not-an-email", null), "INVALID_EMAIL"));
  const r1 = await setR("  Dana@Example.COM ", null);
  ok("the recipient is stored normalised, version 1", r1.email === "dana@example.com" && r1.version === 1);
  ok("a stale screen cannot overwrite it", await throwsCode(() => setR("x@example.com", null), "RECIPIENT_CHANGED_ELSEWHERE"));
  const approve = (o: Partial<{ packageId: number; sha: string; rv: number; email: string; ack: boolean; idem: string }> = {}) =>
    inA(async () => {
      const pkg = await owner.accountantPackage.findFirstOrThrow({ where: { businessId: bizA, status: "READY" } });
      return del.approveDelivery({
        businessId: bizA, userId: userA, periodKey: KEY,
        packageId: o.packageId ?? pkg.id, packageSha256: o.sha ?? pkg.sha256, recipientVersion: o.rv ?? 1,
        recipientEmail: o.email ?? "dana@example.com", acknowledgeIncomplete: o.ack ?? false,
        idempotencyKey: o.idem ?? `send:${Math.random().toString(36).slice(2)}abc`, now: clock,
      });
    });
  ok("D2: an incomplete package cannot be approved without the explicit acknowledgement", await throwsCode(() => approve(), "INCOMPLETE_NOT_ACKNOWLEDGED"));
  const incompleteSend = await approve({ ack: true });
  ok("D2: with the acknowledgement it is approved", incompleteSend.created);
  const ev = await owner.accountantWorkflowEvent.findFirst({ where: { businessId: bizA, deliveryId: incompleteSend.deliveryId, eventType: "DELIVERY_APPROVED" } });
  ok("D2: the trail records that an incomplete package was knowingly approved", (ev?.payload as Record<string, unknown>)?.incompleteAcknowledged === true && ev?.actorUserId === userA, JSON.stringify(ev?.payload));
  await inA(() => del.cancelDelivery(bizA, userA, incompleteSend.deliveryId, clock));
  ok("the waiting approval can be withdrawn", (await owner.accountantDelivery.findUniqueOrThrow({ where: { id: incompleteSend.deliveryId } })).status === "CANCELED");

  // ── A (cont.). A late approval makes a new version ─────────────────────────────────────────────
  console.log("A. a late approval");
  clock = new Date("2026-10-03T06:00:00Z");
  await owner.$executeRawUnsafe(`UPDATE "Document" SET "status" = 'approved' WHERE "id" = $1`, dPending);
  await record(bizA, dPending, 75, "2026-09-27T00:00:00", "expense", "ספק מאוחר");
  const marked = await inA(() => noteDocumentChangeForAccountant(bizA, dPending, clock));
  ok("the late approval marks September dirty", marked === 1 && (await period()).dirtyAt !== null);
  const second = await prepare("CHANGE");
  ok("it builds version 2 and the month is READY_FOR_REVIEW", second.outcome === "built" && second.packageVersion === 2 && "status" in second && second.status === "READY_FOR_REVIEW", JSON.stringify(second));
  ok("version 1 is SUPERSEDED, its object kept", (await owner.accountantPackage.findUniqueOrThrow({ where: { id: p1.id } })).status === "SUPERSEDED");
  ok("dirtyAt is cleared", (await period()).dirtyAt === null);

  // ── C. Notices ─────────────────────────────────────────────────────────────────────────────────
  console.log("C. notices");
  const n1 = await inA(async () => syncPeriodNotice(await period(), clock));
  const notes = await owner.notification.findMany({ where: { businessId: bizA, resolvedAt: null } });
  ok("one live notification for September", notes.length === 1 && n1.notice === "READY" && n1.surfaced, JSON.stringify(n1));
  ok("its wording is the owner's", notes[0]?.title === "הקובץ לרואה החשבון עבור חודש ספטמבר מוכן לבדיקה ולשליחה.", notes[0]?.title);
  ok("it opens the exact month", notes[0]?.href === "/documents/accountant-pack?period=2026-09", notes[0]?.href);
  const n2 = await inA(async () => syncPeriodNotice(await period(), clock));
  ok("a second sync surfaces nothing new", !n2.surfaced && !n2.reminded);
  const att = await inA(() => loadAccountantAttention(bizA, clock));
  ok("/attention carries the same fact and words", att.length === 1 && att[0].title === notes[0]?.title);
  ok("/attention links to the exact month", att[0]?.primaryAction.href === "/documents/accountant-pack?period=2026-09", att[0]?.primaryAction.href);
  const home = await inA(() => getBusinessStatusSnapshot(bizA));
  const homeAcct = home.items.filter((it) => it.primaryAction.href.startsWith("/documents/accountant-pack"));
  ok("the Home status carries the same fact and words", homeAcct.length === 1 && homeAcct[0].title === notes[0]?.title, JSON.stringify(homeAcct.map((it) => it.title)));
  const { readFileSync, readdirSync } = await import("node:fs");
  const tasksSrc = ["lib/services/tasks", "features/tasks"].flatMap((d) =>
    readdirSync(d, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => readFileSync(`${e.parentPath}/${e.name}`, "utf8")));
  ok("Daily Tasks has no accountant source (the feature stands alone)", tasksSrc.length > 0 && !tasksSrc.some((t) => /accountant/i.test(t)));
  ok("a business without the feature has no attention items", (await runWithTenantContext({ businessId: bizB }, () => loadAccountantAttention(bizB, clock))).length === 0);

  // ── D. Approval bindings ───────────────────────────────────────────────────────────────────────
  console.log("D. approval bindings");
  const p2 = await owner.accountantPackage.findFirstOrThrow({ where: { businessId: bizA, version: 2 } });
  ok("a superseded package cannot be approved", await throwsCode(() => approve({ packageId: p1.id, sha: p1.sha256! }), "PACKAGE_OUTDATED"));
  ok("a wrong sha256 cannot be approved", await throwsCode(() => approve({ sha: "0".repeat(64) }), "PACKAGE_OUTDATED"));
  ok("a stale recipient version cannot be approved", await throwsCode(() => approve({ rv: 2 }), "RECIPIENT_CHANGED"));
  ok("a different address than the stored one cannot be approved", await throwsCode(() => approve({ email: "other@example.com" }), "RECIPIENT_CHANGED"));
  const idem = "send:lab-idempotent-0001";
  const a1 = await approve({ idem });
  const a1b = await approve({ idem });
  ok("the same Idempotency-Key is the same approval", a1.created && !a1b.created && a1.deliveryId === a1b.deliveryId);
  ok("a second approval while one waits is refused", await throwsCode(() => approve(), "SEND_IN_PROGRESS"));
  ok("the month shows SENDING", (await period()).status === "SENDING");

  // ── E. Sending ─────────────────────────────────────────────────────────────────────────────────
  console.log("E. sending");
  const sent: { to: string; subject: string; html: string; text: string; idempotencyKey: string }[] = [];
  const fake = (outcome: "sent" | "permanent") => ({
    provider: () => ({
      name: "resend",
      async send(m: { to: string; subject: string; html: string; text: string; idempotencyKey: string }) {
        sent.push(m);
        return outcome === "sent" ? { outcome: "sent" as const, providerMessageId: `msg_lab_${sent.length}` } : { outcome: "permanent" as const, code: "rejected_422" };
      },
    }),
  });
  const r = await inA(() => del.attemptDelivery(bizA, a1.deliveryId, clock, fake("sent")));
  ok("the provider accepted the message", r === "accepted");
  const d = await owner.accountantDelivery.findUniqueOrThrow({ where: { id: a1.deliveryId } });
  ok("ACCEPTED is recorded as accepted — not delivered", d.status === "ACCEPTED" && d.deliveredAt === null && d.providerMessageId === "msg_lab_1");
  const pS = await period();
  ok("the month is SENT and completed by this delivery's package", pS.status === "SENT" && pS.completionKind === "DELIVERY" && pS.completedPackageId === p2.id);
  ok("a second attempt sends nothing (already accepted)", (await inA(() => del.attemptDelivery(bizA, a1.deliveryId, clock, fake("sent")))) === "not_claimable" && sent.length === 1);
  const mail = sent[0];
  ok("sent to the approved recipient", mail.to === "dana@example.com");
  ok("with the provider idempotency key of this delivery", mail.idempotencyKey === `acct:${a1.deliveryId}`);
  ok("the email carries no amount and no vendor", !/1180|250|ספק|לקוח/.test(mail.html + mail.text));
  const linkMatch = /https:\/\/app\.example\.com\/a\/([A-Za-z0-9_-]{32})#t=([A-Za-z0-9_-]{43})/.exec(mail.text);
  ok("the link is /a/<publicId>#t=<secret> (secret in the fragment)", !!linkMatch && linkMatch[1] === d.linkPublicId);
  ok("the secret itself is stored nowhere", !!linkMatch && !JSON.stringify(d).includes(linkMatch[2]));
  const resolve = async (pid: string, secret: string) =>
    (await prisma.$queryRaw<{ businessId: number; deliveryId: number }[]>`SELECT "businessId", "deliveryId" FROM public.accountant_link_resolve(${pid}, ${hashAccountantLinkSecret(secret)})`)[0];
  const hit = await resolve(linkMatch![1], linkMatch![2]);
  ok("the link resolves to this business and delivery", hit?.businessId === bizA && hit?.deliveryId === a1.deliveryId);
  ok("a forged secret resolves nothing", !(await resolve(linkMatch![1], "A".repeat(43))));
  const open1 = await runWithTenantContext({ businessId: bizA }, () => del.openLink(bizA, a1.deliveryId, clock, true));
  ok("opening serves exactly the approved object", open1.ok && open1.storageKey === p2.storageKey);
  ok("the download is counted", (await owner.accountantDelivery.findUniqueOrThrow({ where: { id: a1.deliveryId } })).downloadCount === 1);
  const cross = await runWithTenantContext({ businessId: bizB }, () => del.openLink(bizB, a1.deliveryId, clock, true));
  ok("the same delivery id read as another business is unavailable (RLS)", !cross.ok);
  ok("a delivered event marks DELIVERED", await inA(() => del.applyProviderEvent(bizA, a1.deliveryId, "delivered", clock)));
  ok("a replayed delivered event changes nothing", !(await inA(() => del.applyProviderEvent(bizA, a1.deliveryId, "delivered", clock))));
  await inA(() => del.revokeLink(bizA, userA, a1.deliveryId, clock));
  const openR = await runWithTenantContext({ businessId: bizA }, () => del.openLink(bizA, a1.deliveryId, clock, true));
  ok("a revoked link is refused, and the refusal is recorded", !openR.ok && openR.reason === "revoked" &&
    (await owner.accountantWorkflowEvent.count({ where: { deliveryId: a1.deliveryId, eventType: "LINK_REFUSED" } })) === 1);
  clock = new Date("2026-10-20T06:00:00Z");
  const a1Expired = await runWithTenantContext({ businessId: bizA }, () => del.openLink(bizA, a1.deliveryId, clock, false));
  ok("after 14 days the link is refused (revoked or expired)", !a1Expired.ok);

  // A change after sending → a revised version for review, never a re-send.
  const dLate = await doc(bizA, "approved", "2026-10-15T08:00:00", 5);
  await record(bizA, dLate, 40, "2026-09-29T00:00:00", "expense", "חשבונית שהגיעה מאוחר");
  await inA(() => noteDocumentChangeForAccountant(bizA, dLate, clock));
  const third = await prepare("CHANGE");
  ok("a change after sending builds version 3 and flags the month, status stays SENT", third.outcome === "built" && third.packageVersion === 3 && "status" in third && third.status === "SENT" && third.changedSinceSent === true, JSON.stringify(third));
  ok("nothing was re-sent", sent.length === 1 && (await owner.accountantDelivery.count({ where: { businessId: bizA, status: { in: ["APPROVED", "SENDING"] } } })) === 0);
  const nC = await inA(async () => syncPeriodNotice(await period(), clock));
  ok("the owner is told a revised version waits for review", nC.notice === "CHANGED" && nC.surfaced);

  // A recipient change voids a waiting approval.
  const a3 = await approve({ idem: "send:lab-v3-0000001" });
  const r2 = await setR("dana.new@example.com", 1);
  ok("changing the recipient voids the waiting approval", r2.version === 2 && r2.canceledApprovals === 1 &&
    (await owner.accountantDelivery.findUniqueOrThrow({ where: { id: a3.deliveryId } })).status === "CANCELED");
  ok("the voided approval can never be sent", (await inA(() => del.attemptDelivery(bizA, a3.deliveryId, clock, fake("sent")))) === "not_claimable" && sent.length === 1);

  // A provider failure.
  const a4 = await approve({ rv: 2, email: "dana.new@example.com", idem: "send:lab-v3-0000002" });
  const rf = await inA(() => del.attemptDelivery(bizA, a4.deliveryId, clock, fake("permanent")));
  ok("a permanent provider refusal is FAILED, and the month SEND_FAILED", rf === "failed" && (await period()).status === "SEND_FAILED");
  const nF = await inA(async () => syncPeriodNotice(await period(), clock));
  const failNote = await owner.notification.findFirst({ where: { businessId: bizA, resolvedAt: null } });
  ok("the failure reaches the owner as a FAILURE_EVENT, and it is the only live notice", nF.notice === "SEND_FAILED" && failNote?.semanticCategory === "FAILURE_EVENT" &&
    (await owner.notification.count({ where: { businessId: bizA, resolvedAt: null } })) === 1);
  const failedLink = await runWithTenantContext({ businessId: bizA }, () => del.openLink(bizA, a4.deliveryId, clock, false));
  ok("a link of a failed send opens nothing", !failedLink.ok);

  // The provider hands back a message id another delivery already holds: the acceptance must still be recorded
  // (the email went out) — never an aborted update that leaves the row SENDING to be sent again.
  const a5 = await approve({ rv: 2, email: "dana.new@example.com", idem: "send:lab-v3-0000003" });
  const dupProvider = { provider: () => ({ name: "resend", async send(m: { to: string; subject: string; html: string; text: string; idempotencyKey: string }) { sent.push(m); return { outcome: "sent" as const, providerMessageId: "msg_lab_1" }; } }) };
  const r5 = await inA(() => del.attemptDelivery(bizA, a5.deliveryId, clock, dupProvider));
  const d5 = await owner.accountantDelivery.findUniqueOrThrow({ where: { id: a5.deliveryId } });
  ok("a clashing provider id still records the acceptance, without the id", r5 === "accepted" && d5.status === "ACCEPTED" && d5.providerMessageId === null && d5.failureCode === "provider_id_conflict", JSON.stringify({ r5, s: d5.status, f: d5.failureCode }));
  ok("…and the month is SENT again (the retry after a failure, with a fresh approval)", (await period()).status === "SENT");

  // ── F. Isolation of views and the sweep ────────────────────────────────────────────────────────
  console.log("F. views and the sweep");
  const viewB = await runWithTenantContext({ businessId: bizB }, () => getPeriodView(bizB, KEY, clock));
  ok("business B sees no period, package, send or recipient of A", !!viewB && !viewB.prepared && viewB.deliveries.length === 0 && viewB.recipient === null);
  clock = new Date("2026-11-01T01:00:00Z");
  const sweepIds = [bizA, bizB];
  const read: number[] = [];
  const summary = await runAccountantSweep({
    ...defaultSweepDeps,
    now: () => clock,
    listBusinessIds: async () => sweepIds,
    isEnabled: async (b) => { read.push(b); return defaultSweepDeps.isEnabled(b); },
    prepare: (args) => prep.preparePeriod(args, { ...deps, now: () => clock }),
    shuffle: (a) => a,
  });
  ok("the sweep checked both businesses and prepared only the eligible one", read.length === 2 && summary.eligible === 1 && summary.built === 1 && summary.businessErrors === 0, JSON.stringify(summary));
  ok("on the 1st of November, October is created and prepared for A only",
    (await owner.accountantPeriod.count({ where: { periodKey: "2026-10", businessId: bizA } })) === 1 &&
    (await owner.accountantPeriod.count({ where: { businessId: bizB } })) === 0);
  ok("October holds the 30 Sep 21:30Z (00:30 IL, 1 Oct) record", ((await owner.accountantPackage.findFirstOrThrow({ where: { businessId: bizA, version: 1, NOT: { periodId: pS.id } } })).manifest as Record<string, unknown>).recordCount === 1);
  const summary2 = await runAccountantSweep({ ...defaultSweepDeps, now: () => clock, listBusinessIds: async () => sweepIds, prepare: (args) => prep.preparePeriod(args, { ...deps, now: () => clock }), shuffle: (a) => a });
  ok("a second sweep run the same hour builds nothing", summary2.built === 0, JSON.stringify(summary2));

  await owner.$disconnect();
  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    for (const f of failures) console.log(`  FAILED: ${f}`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
}).finally(() => process.exit());
