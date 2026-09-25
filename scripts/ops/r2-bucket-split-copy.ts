/**
 * H-4 one-off: copy PUBLIC-domain objects (content / inventory / offers) from
 * the legacy single bucket to the new PUBLIC bucket. OWNER-RUN ONLY — never run
 * by CI or by an agent. Dry run by default.
 *
 *   # 1. dry run (lists, counts, copies nothing)
 *   R2_ACCOUNT_ID=… R2_ACCESS_KEY_ID=… R2_SECRET_ACCESS_KEY=… \
 *   R2_SOURCE_BUCKET=<legacy bucket> R2_PUBLIC_BUCKET_NAME=<new public bucket> \
 *     npx tsx scripts/ops/r2-bucket-split-copy.ts
 *
 *   # 2. copy (idempotent: an object already present with the same size+ETag is skipped)
 *   R2_SPLIT_CONFIRM=COPY_PUBLIC_OBJECTS … npx tsx scripts/ops/r2-bucket-split-copy.ts --execute
 *
 * What it does:
 *   - lists the source bucket page by page; keys are biz/{id}/{domain}/…;
 *   - PUBLIC domains are copied server-side (CopyObject, MetadataDirective COPY,
 *     so Content-Type / custom metadata travel with the object) and verified
 *     with HeadObject (ContentLength + ETag);
 *   - PRIVATE domains (documents / billing / crm) are only COUNTED — they stay
 *     where they are: the legacy bucket becomes the PRIVATE bucket;
 *   - unknown keys are reported, never copied;
 *   - NOTHING is deleted. Removing public objects from the (now private) bucket
 *     is a later, separate owner step after the verification in
 *     docs/security/r2-bucket-split.md.
 *
 * Keys are identical in both buckets, so every stored public URL
 * (R2_PUBLIC_BASE_URL/<key>) keeps working once the custom domain is attached
 * to the public bucket instead of the legacy one.
 */

import {
  CopyObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";

const PUBLIC_DOMAINS = new Set(["content", "inventory", "offers"]);
const PRIVATE_DOMAINS = new Set(["documents", "billing", "crm"]);
const KEY_RE = /^biz\/\d+\/([a-z]+)\//;

function env(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    console.error(`missing ${name}`);
    process.exit(64);
  }
  return v;
}

async function main(): Promise<void> {
  const execute = process.argv.includes("--execute");
  if (execute && process.env.R2_SPLIT_CONFIRM !== "COPY_PUBLIC_OBJECTS") {
    console.error("refusing --execute without R2_SPLIT_CONFIRM=COPY_PUBLIC_OBJECTS");
    process.exit(64);
  }
  const source = env("R2_SOURCE_BUCKET");
  const target = env("R2_PUBLIC_BUCKET_NAME");
  if (source === target) {
    console.error("source and target bucket must differ");
    process.exit(64);
  }
  const client = new S3Client({
    region: "auto",
    endpoint: `https://${env("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: env("R2_ACCESS_KEY_ID"), secretAccessKey: env("R2_SECRET_ACCESS_KEY") },
  });

  const counts = { public: 0, private: 0, unknown: 0, copied: 0, skipped: 0, failed: 0 };
  let token: string | undefined;
  do {
    const page = await client.send(new ListObjectsV2Command({ Bucket: source, ContinuationToken: token }));
    for (const obj of page.Contents ?? []) {
      const key = obj.Key ?? "";
      const domain = KEY_RE.exec(key)?.[1] ?? "";
      if (PRIVATE_DOMAINS.has(domain)) {
        counts.private += 1;
        continue;
      }
      if (!PUBLIC_DOMAINS.has(domain)) {
        counts.unknown += 1;
        console.log(`UNKNOWN (not copied): ${key}`);
        continue;
      }
      counts.public += 1;
      if (!execute) continue;

      const existing = await client
        .send(new HeadObjectCommand({ Bucket: target, Key: key }))
        .catch(() => null);
      if (existing && existing.ContentLength === obj.Size && existing.ETag === obj.ETag) {
        counts.skipped += 1;
        continue;
      }
      try {
        await client.send(
          new CopyObjectCommand({
            Bucket: target,
            Key: key,
            CopySource: `${source}/${encodeURIComponent(key).replace(/%2F/g, "/")}`,
            MetadataDirective: "COPY",
          })
        );
        const head = await client.send(new HeadObjectCommand({ Bucket: target, Key: key }));
        if (head.ContentLength !== obj.Size) throw new Error("size mismatch after copy");
        counts.copied += 1;
      } catch (error) {
        counts.failed += 1;
        console.error(`FAILED ${key}: ${(error as Error).message}`);
      }
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);

  console.log(JSON.stringify({ mode: execute ? "execute" : "dry-run", source, target, ...counts }, null, 2));
  process.exit(counts.failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
