/**
 * M7-B — commerce reconciliation, run by the intake sweeper (QStash every ~10 minutes) for each business that
 * has a commerce connection, inside that business's tenant job:
 *
 *   WooCommerce  webhooks are never retried and are disabled after consecutive failures, so:
 *                1. webhook health — every Dubiz webhook of the store must exist and be `active`; a disabled one
 *                   is re-activated, a missing set is re-created; the owner sees ERROR + a code only when THEY must
 *                   act (the store revoked Dubiz's keys) — a store that is merely down is retried, never flipped;
 *                2. polling — orders modified after the connection's cursor (dates_are_gmt, oldest first), a few
 *                   pages per run, through the SAME receipt pipeline: a state the webhook already delivered is the
 *                   same receipt (identity = order + modification time + status), a missed one is recovered.
 *   Wix          retries 12 times, but "make periodic API requests to confirm webhooks are being received": orders
 *                updated after the cursor, through the same pipeline (an app-level token per installation).
 *
 * Nothing here bypasses the gate: receipts go through ingestAcquisition (feature enabled, business active).
 * Counts only leave this module.
 */
import { withTenantTransaction } from "@/lib/tenant/transaction";
import { sourceGate } from "@/lib/intake/acquisition/gate";
import { ingestAcquisition } from "@/lib/intake/acquisition/ingest";
import { readConnectionSecrets, setConnectionHealth, updateConnectionSecrets } from "@/lib/intake/acquisition/connection.service";
import type { IntakeReceiptDraft } from "@/lib/intake/core/contract";
import {
  deleteWooWebhook, getWooWebhookStatus, listWooOrdersModifiedAfter, parseWooOrder, reactivateWooWebhook, WOO_SOURCE, WooApiError, type WooCredentials,
} from "./woocommerce";
import { ensureWooWebhooks } from "./woocommerce-connect";
import { mintWixToken, parseWixOrder, searchWixOrdersUpdatedAfter, WixApiError, wixAppConfig, WIX_SOURCE } from "./wix";

export const RECONCILE_PAGES_PER_RUN = 3;
/** Re-read a little behind the cursor: a store's clock and an in-flight change must never fall in a gap. */
const OVERLAP_MS = 2 * 60_000;

export type ReconcileReport = { connections: number; receipts: number; webhooksReactivated: number; failures: number };

function back(iso: string): string {
  const t = new Date(iso).getTime();
  return new Date((Number.isFinite(t) ? t : Date.now()) - OVERLAP_MS).toISOString();
}

function modifiedGmt(o: unknown): string | null {
  const v = (o as { date_modified_gmt?: unknown } | null)?.date_modified_gmt;
  if (typeof v !== "string") return null;
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(v) ? v : `${v}Z`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

async function ingest(sourceKey: typeof WOO_SOURCE | typeof WIX_SOURCE, businessId: number, connectionId: number, accountRef: string, receipts: IntakeReceiptDraft[]) {
  if (!receipts.length) return 0;
  const r = await ingestAcquisition({ sourceKey, businessId, connectionId, accountRef, receipts, processInline: true });
  // Refused (the source switched off, the connection not live): the cursor must not pass these orders.
  if (r.status !== "accepted") throw new Error(`ingest_refused:${r.reason}`);
  return r.newCount;
}

async function reconcileWoo(businessId: number, c: { id: number; publicId: string }, report: ReconcileReport) {
  const s = await readConnectionSecrets(businessId, c.id, { anyLiveStatus: true });
  if (!s?.siteUrl || !s.consumerKey || !s.consumerSecret) return;
  const creds: WooCredentials = { siteUrl: s.siteUrl, consumerKey: s.consumerKey, consumerSecret: s.consumerSecret };
  try {
    // 1. webhook health
    let hooksOk = true;
    const ids = (s.webhookIds ?? "").split(",").filter(Boolean);
    if (!ids.length) {
      if (s.origin && (await ensureWooWebhooks(businessId, c.id, c.publicId, s.origin)) === "failed") {
        report.failures += 1;
        hooksOk = false;
      }
    } else {
      for (const id of ids) {
        const status = await getWooWebhookStatus(creds, id).catch((e) => (e instanceof WooApiError && e.code === "not_found" ? "missing" : Promise.reject(e)));
        if (status === "missing") {
          // Someone deleted a Dubiz webhook in the store: replace the whole set (the survivors are removed
          // first, so the store never sends the same order twice).
          if (s.origin) {
            for (const other of ids) if (other !== id) await deleteWooWebhook(creds, other);
            hooksOk = (await ensureWooWebhooks(businessId, c.id, c.publicId, s.origin)) === "ok";
          }
          break;
        }
        if (status !== "active") {
          await reactivateWooWebhook(creds, id);
          report.webhooksReactivated += 1;
        }
      }
    }
    // The store answered with these keys: a store the owner had to fix is live again BEFORE its orders are
    // polled (a connection in ERROR accepts nothing). One whose webhooks could not be set up stays visible.
    if (hooksOk) await setConnectionHealth(c.id, null);
    // 2. polling
    let cursor = s.cursor ?? new Date().toISOString();
    let newest = cursor;
    for (let page = 1; page <= RECONCILE_PAGES_PER_RUN; page++) {
      const { orders, totalPages } = await listWooOrdersModifiedAfter(creds, back(cursor), page);
      const receipts: IntakeReceiptDraft[] = [];
      for (const o of orders) {
        const p = parseWooOrder(o, "order.updated", c.publicId);
        if (p.ok && "receipt" in p) receipts.push(p.receipt);
        // The cursor passes every order seen — drafts and unreadable ones too, or a page of them would stall it.
        const m = modifiedGmt(o);
        if (m && m > newest) newest = m;
      }
      report.receipts += await ingest(WOO_SOURCE, businessId, c.id, c.publicId, receipts);
      if (page >= totalPages) break;
    }
    if (newest !== cursor) {
      cursor = newest;
      await updateConnectionSecrets(businessId, c.id, { cursor });
    }
  } catch (e) {
    report.failures += 1;
    // Only what the OWNER must fix turns the store to ERROR: the store's webhooks keep delivering through an ACTIVE
    // connection while the store is merely down (an ERROR endpoint refuses them, and WooCommerce disables a webhook
    // after consecutive failures). A passing outage is retried by the next run.
    if (e instanceof WooApiError && e.code === "unauthorized") await setConnectionHealth(c.id, "WOO_KEYS_REVOKED");
  }
}

async function reconcileWix(businessId: number, c: { id: number; externalResourceId: string | null }, report: ReconcileReport) {
  if (!wixAppConfig() || !c.externalResourceId) return;
  const s = await readConnectionSecrets(businessId, c.id, { anyLiveStatus: true });
  if (!s) return;
  try {
    const token = await mintWixToken(c.externalResourceId);
    let cursor: string | undefined;
    let newest = s.cursor ?? new Date().toISOString();
    const after = back(newest);
    for (let page = 1; page <= RECONCILE_PAGES_PER_RUN; page++) {
      const { orders, next } = await searchWixOrdersUpdatedAfter(token, after, cursor);
      const receipts: IntakeReceiptDraft[] = [];
      for (const o of orders) {
        const p = parseWixOrder(o, { slug: "updated", sequence: null }, c.externalResourceId);
        if (p.ok && "receipt" in p) receipts.push(p.receipt);
        const u = (o as { updatedDate?: unknown } | null)?.updatedDate;
        if (typeof u === "string" && u > newest) newest = u;
      }
      report.receipts += await ingest(WIX_SOURCE, businessId, c.id, c.externalResourceId, receipts);
      if (!next) break;
      cursor = next;
    }
    if (newest !== s.cursor) await updateConnectionSecrets(businessId, c.id, { cursor: newest });
    await setConnectionHealth(c.id, null);
  } catch (e) {
    report.failures += 1;
    if (e instanceof WixApiError && e.code === "not_installed") await setConnectionHealth(c.id, "WIX_APP_UNINSTALLED");
  }
}

/** Reconcile every live commerce connection of ONE business (tenant job). */
export async function reconcileCommerce(businessId: number): Promise<ReconcileReport> {
  const report: ReconcileReport = { connections: 0, receipts: 0, webhooksReactivated: 0, failures: 0 };
  const conns = await withTenantTransaction((tx) =>
    tx.acquisitionConnection.findMany({
      where: { sourceKey: { in: [WOO_SOURCE, WIX_SOURCE] }, status: { in: ["ACTIVE", "ERROR"] } },
      select: { id: true, sourceKey: true, publicId: true, externalResourceId: true },
      orderBy: { id: "asc" },
    })
  );
  for (const c of conns) {
    // A source the business no longer has enabled is not polled (and talks to no store).
    if (!(await sourceGate(businessId, c.sourceKey as typeof WOO_SOURCE | typeof WIX_SOURCE)).ok) continue;
    report.connections += 1;
    if (c.sourceKey === WOO_SOURCE) await reconcileWoo(businessId, c, report);
    else await reconcileWix(businessId, c, report);
  }
  return report;
}
