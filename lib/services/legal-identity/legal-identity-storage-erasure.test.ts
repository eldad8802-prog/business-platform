/**
 * The object stage of an account erasure for correction attachments (./legal-identity-storage-erasure.ts), with an
 * in-memory storage double. No DB, no network.
 *   node_modules/.bin/tsx lib/services/legal-identity/legal-identity-storage-erasure.test.ts
 */
import assert from "node:assert/strict";

import { continueLegalIdentityStorageErasure } from "./legal-identity-storage-erasure";

let n = 0;
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); n++; } catch (e) { console.error(`FAIL - ${name}`); throw e; }
}
function store(keys: string[]) {
  const objects = new Set(keys);
  const deletedKeys: string[] = [];
  return {
    objects,
    deletedKeys,
    storage: {
      listObjects: async (prefix: string) => [...objects].filter((k) => k.startsWith(prefix)).map((key) => ({ key, size: 1 })),
      deleteObject: async (key: string) => { deletedKeys.push(key); objects.delete(key); },
    },
  };
}
const deleting = async () => true;

async function main() {
  await check("a live business: nothing listed, nothing deleted", async () => {
    const s = store(["biz/7/legal-identity/1/a.pdf"]);
    const r = await continueLegalIdentityStorageErasure(7, { storage: s.storage, isDeleting: async () => false });
    assert.equal(r.state, "NOT_DELETING");
    assert.equal(s.objects.size, 1);
  });
  await check("a deleting business: its prefix is emptied and verified; other businesses and domains untouched", async () => {
    const s = store(["biz/7/legal-identity/1/a.pdf", "biz/7/legal-identity/2/b.png", "biz/70/legal-identity/1/c.pdf", "biz/7/trust/x.pdf"]);
    const r = await continueLegalIdentityStorageErasure(7, { storage: s.storage, isDeleting: deleting });
    assert.deepEqual(r, { state: "PASS", deleted: 2, remaining: 0, error: null, done: true });
    assert.deepEqual([...s.objects].sort(), ["biz/7/trust/x.pdf", "biz/70/legal-identity/1/c.pdf"]);
  });
  await check("idempotent: a second pass finds nothing and is done", async () => {
    const s = store([]);
    const r = await continueLegalIdentityStorageErasure(7, { storage: s.storage, isDeleting: deleting });
    assert.equal(r.done, true);
    assert.equal(r.deleted, 0);
  });
  await check("a delete failure keeps it open (DELETE_FAILED), with the fresh remaining count", async () => {
    const s = store(["biz/7/legal-identity/1/a.pdf", "biz/7/legal-identity/1/b.pdf"]);
    let first = true;
    const storage = { ...s.storage, deleteObject: async (k: string) => { if (first) { first = false; throw new Error("down biz/7/x"); } await s.storage.deleteObject(k); } };
    const r = await continueLegalIdentityStorageErasure(7, { storage, isDeleting: deleting });
    assert.equal(r.error, "DELETE_FAILED");
    assert.equal(r.remaining, 1);
    assert.equal(r.done, false);
  });
  await check("a listing failure keeps it open (LIST_FAILED) and deletes nothing", async () => {
    const s = store(["biz/7/legal-identity/1/a.pdf"]);
    const r = await continueLegalIdentityStorageErasure(7, { storage: { ...s.storage, listObjects: async () => { throw new Error("x"); } }, isDeleting: deleting });
    assert.equal(r.error, "LIST_FAILED");
    assert.equal(s.objects.size, 1);
  });
  await check("a listed key outside the prefix is never deleted (FOREIGN_KEY_LISTED)", async () => {
    const s = store(["biz/7/legal-identity/1/a.pdf"]);
    const storage = { ...s.storage, listObjects: async () => [{ key: "biz/8/legal-identity/1/z.pdf", size: 1 }] };
    const r = await continueLegalIdentityStorageErasure(7, { storage, isDeleting: deleting });
    assert.equal(r.error, "FOREIGN_KEY_LISTED");
    assert.equal(s.deletedKeys.length, 0);
  });
  await check("progress never carries a key or a message", async () => {
    const s = store(["biz/7/legal-identity/1/a.pdf"]);
    const r = await continueLegalIdentityStorageErasure(7, { storage: { ...s.storage, deleteObject: async () => { throw new Error("biz/7/legal-identity/1/a.pdf"); } }, isDeleting: deleting });
    assert.ok(!JSON.stringify(r).includes("biz/"));
  });
  console.log(`legal-identity-storage-erasure.test.ts: ok (${n} checks)`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
