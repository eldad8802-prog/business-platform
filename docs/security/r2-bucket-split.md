# R2 bucket split (H-4) — owner runbook

Status: code shipped in sec(D). Production keeps working on the legacy single
bucket until the owner performs the steps below. Nothing here has been done to
Cloudflare or Production by an agent.

## Why

One bucket (`R2_BUCKET_NAME`) holds private documents, CRM attachments and
billing PDFs **and** public content/inventory/offer images. R2 public access
(r2.dev subdomain or a custom domain) is a **bucket-wide** switch; the
per-object `visibility` metadata is not enforced by Cloudflare. If the bucket is
publicly reachable, every private object is one guessed/leaked key away.

The code now routes by domain:

| Domain | Bucket | Public URL |
|---|---|---|
| documents, billing, crm | `R2_PRIVATE_BUCKET_NAME` | never (signed URLs / app routes only) |
| content, inventory, offers | `R2_PUBLIC_BUCKET_NAME` | `R2_PUBLIC_BASE_URL/<key>` |

If only `R2_BUCKET_NAME` is set the app runs in `legacy-single` topology and
logs `storage_topology_legacy_single_bucket` (severity `SECURITY_WARNING`) once
per process. A half split (only one of the two new variables) fails closed.

## Step 0 — check the current exposure (read-only, do this first)

Cloudflare dashboard → **R2** → **Overview** → click the current bucket
(the value of `R2_BUCKET_NAME`) → **Settings**:

1. **Public access → R2.dev subdomain**: note whether it says *Allowed* (a
   `pub-….r2.dev` URL is shown) or *Not allowed*.
2. **Public access → Custom Domains**: note every domain listed and its status.
3. Compare with Vercel → Project → Settings → Environment Variables →
   `R2_PUBLIC_BASE_URL` (Production). If that host is one of the domains in (1)
   or (2), the bucket holding private documents is publicly served today.

Unauthenticated probe (owner runs it; pick ONE private object you own, e.g. a
test document you uploaded yourself — its key is `biz/<yourBusinessId>/documents/<fileUrl>`,
readable from your own DB row, never from someone else's):

```bash
curl -sI "https://<R2_PUBLIC_BASE_URL host>/biz/<yourBusinessId>/documents/<doc-….pdf>"
# and, if an r2.dev URL was shown in (1):
curl -sI "https://pub-<id>.r2.dev/biz/<yourBusinessId>/documents/<doc-….pdf>"
```

Expected **403 or 404**. A **200** means private documents are publicly
readable right now → treat as an incident: set *R2.dev subdomain* to *Not
allowed* immediately and continue with the split without delay.

## Step 1 — create the public bucket

R2 → **Create bucket** → name e.g. `dubiz-public` (same location/jurisdiction as
the existing bucket). Settings → **Custom Domains** → connect the domain that
will serve public assets. Do **not** enable r2.dev unless needed.

API token: the existing R2 token must be allowed on **both** buckets (R2 →
Manage API tokens → edit → *Object Read & Write* scoped to both buckets).

## Step 2 — copy public objects (dry run, then execute)

```bash
R2_ACCOUNT_ID=… R2_ACCESS_KEY_ID=… R2_SECRET_ACCESS_KEY=… \
R2_SOURCE_BUCKET=<legacy bucket> R2_PUBLIC_BUCKET_NAME=dubiz-public \
  npx tsx scripts/ops/r2-bucket-split-copy.ts            # dry run: counts only
R2_SPLIT_CONFIRM=COPY_PUBLIC_OBJECTS … npx tsx scripts/ops/r2-bucket-split-copy.ts --execute
```

It copies content/inventory/offers keys only, verifies each copy, never
deletes anything, and is safe to re-run.

## Step 3 — switch the app

Vercel (Production + Preview), then redeploy:

```
R2_PRIVATE_BUCKET_NAME = <legacy bucket name>   # the existing bucket becomes the private one
R2_PUBLIC_BUCKET_NAME  = dubiz-public
R2_PUBLIC_BASE_URL     = https://<custom domain attached to dubiz-public>
```

`R2_BUCKET_NAME` may stay (it is ignored when the split is configured) and can
be removed later. Keys are identical in both buckets, so stored public URLs keep
working **if the same public host now points at `dubiz-public`**: move the custom
domain from the legacy bucket to `dubiz-public` (Custom Domains → remove on the
old bucket, add on the new one). Re-run the copy script once after the switch to
catch uploads made during the cut-over.

## Step 4 — close the private bucket

Legacy (now private) bucket → Settings:
- **R2.dev subdomain** → *Not allowed*.
- **Custom Domains** → none.

Then repeat the Step 0 probe against **every** former public host and the
r2.dev URL: private key → 403/404. And a public key in the new bucket →
`curl -sI https://<public host>/biz/<id>/content/<uuid>.png` → 200 with
`content-type: image/png` (and `content-disposition: inline; …` for objects
uploaded after this release).

## Step 4b — `nosniff` on the public host

R2 stores `Content-Type`, `Content-Disposition` and `Cache-Control` per object
(set by the app from the VERIFIED type), but it cannot attach arbitrary headers
such as `X-Content-Type-Options`. Add it at the edge: Cloudflare → the zone of
the public custom domain → **Rules → Transform Rules → Modify Response Header**
→ *Set static* `X-Content-Type-Options` = `nosniff`, matching
`http.host eq "<public host>"`. Verify with `curl -sI` (header present).

## Step 5 — optional cleanup

After a verification window, public-domain objects may be deleted from the
private bucket (they are unreachable there anyway once public access is off).
This is a destructive step; do it only after Step 4 passes.
