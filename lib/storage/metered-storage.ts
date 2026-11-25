/**
 * Metered storage — the storage service as every caller receives it from getStorageService() (subscriptions stage C).
 * SERVER-ONLY. One choke point, so no upload route can bypass the storage quota (decision 21):
 *
 *   customer domains (documents, crm, content, inventory, offers, trust, service — what the business uploads):
 *     storage_customer_bytes — RESERVED before the write; refused in ENFORCE for a customer over its quota
 *     (QuotaExhaustedError, nothing written); COUNTED after a successful write; RELEASED when the write failed, when
 *     a create-once write found the object already there, and when the object is deleted.
 *   system domains (billing PDFs, accountant exports, business documents the system renders):
 *     storage_system_bytes — measured after the write, released on delete, NEVER refused (an issued tax document or a
 *     prepared package must always be stored).
 * The unit is the storage key (obj:<key>): writing the same key again is not counted twice. Reads, lists and signed
 * URLs are untouched. A failure of the meter never fails the storage operation (usage-meter.ts is fail-open).
 */
import { parseStorageKey } from "./key-validation";
import type { PutIfAbsentResult, PutObjectInput, PutObjectResult, StorageDomain, StorageService } from "./types";

import { consumeUsage, QuotaExhaustedError, settleUsage } from "@/lib/services/subscriptions/usage/usage-meter";
import type { UsageMetric } from "@/lib/services/subscriptions/usage/usage-metrics";

export const CUSTOMER_STORAGE_DOMAINS: readonly StorageDomain[] = ["documents", "crm", "content", "inventory", "offers", "trust", "service"];
export const SYSTEM_STORAGE_DOMAINS: readonly StorageDomain[] = ["billing", "exports", "business-docs"];

export function storageMetricFor(domain: StorageDomain): UsageMetric {
  return CUSTOMER_STORAGE_DOMAINS.includes(domain) ? "storage_customer_bytes" : "storage_system_bytes";
}

const unitKeyOf = (key: string) => `obj:${key}`.slice(0, 200);

export class MeteredStorageService implements StorageService {
  constructor(private readonly inner: StorageService) {}

  private async reserve(input: PutObjectInput): Promise<{ metric: UsageMetric; reserved: boolean }> {
    const metric = storageMetricFor(input.metadata.domain);
    // Inside an open tenant transaction the meter runs in that same transaction (usage-meter.ts): still atomic.
    if (metric !== "storage_customer_bytes") return { metric, reserved: false };
    const d = await consumeUsage({
      businessId: input.metadata.businessId,
      metric,
      unitKey: unitKeyOf(input.key),
      amount: Math.max(1, input.body.length),
      source: `storage.${input.metadata.domain}`,
      reserve: true,
    });
    if (!d.allowed) throw new QuotaExhaustedError(d);
    return { metric, reserved: d.outcome === "COUNTED" };
  }

  private async settle(input: PutObjectInput, metric: UsageMetric, reserved: boolean, stored: boolean): Promise<void> {
    const businessId = input.metadata.businessId;
    if (metric === "storage_customer_bytes") {
      // Not reserved: the reservation answered DUPLICATE (the same key again) / UNAVAILABLE / SKIPPED — nothing to settle.
      if (reserved) await settleUsage({ businessId, metric, unitKey: unitKeyOf(input.key), state: stored ? "COUNTED" : "RELEASED" });
      return;
    }
    if (stored) {
      await consumeUsage({ businessId, metric, unitKey: unitKeyOf(input.key), amount: Math.max(1, input.body.length), source: `storage.${input.metadata.domain}` });
    }
  }

  async putObject(input: PutObjectInput): Promise<PutObjectResult> {
    const { metric, reserved } = await this.reserve(input);
    let result: PutObjectResult;
    try {
      result = await this.inner.putObject(input);
    } catch (error) {
      await this.settle(input, metric, reserved, false);
      throw error;
    }
    await this.settle(input, metric, reserved, true);
    return result;
  }

  async putObjectIfAbsent(input: PutObjectInput): Promise<PutIfAbsentResult> {
    const { metric, reserved } = await this.reserve(input);
    let result: PutIfAbsentResult;
    try {
      result = await this.inner.putObjectIfAbsent(input);
    } catch (error) {
      await this.settle(input, metric, reserved, false);
      throw error;
    }
    await this.settle(input, metric, reserved, result.status === "CREATED");
    return result;
  }

  async deleteObject(key: string): Promise<void> {
    await this.inner.deleteObject(key);
    try {
      const parsed = parseStorageKey(key);
      await settleUsage({ businessId: parsed.businessId, metric: storageMetricFor(parsed.domain), unitKey: unitKeyOf(key), state: "RELEASED" });
    } catch {
      /* a key outside biz/{id}/{domain}/… carries no usage */
    }
  }

  getObject: StorageService["getObject"] = (key) => this.inner.getObject(key);
  headObject: StorageService["headObject"] = (key) => this.inner.headObject(key);
  getMetadata: StorageService["getMetadata"] = (key) => this.inner.getMetadata(key);
  getSignedDownloadUrl: StorageService["getSignedDownloadUrl"] = (key, ttl, response) => this.inner.getSignedDownloadUrl(key, ttl, response);
  getPublicUrl: StorageService["getPublicUrl"] = (key) => this.inner.getPublicUrl(key);
  listObjects: StorageService["listObjects"] = (prefix) => this.inner.listObjects(prefix);
}
