-- Provider routing learns a second way in: an opaque callback secret.
--
-- WHY
--
-- The routing index exists because a provider callback arrives with no session
-- and no tenant. Until now the only thing such a callback could name was the
-- provider's own session id, so the table keyed on that. SUMIT breaks the
-- assumption: its BeginRedirect returns a payment page URL and NOTHING else, no
-- session id, no token. Proven against their sandbox, and their published schema
-- agrees — the response object declares `additionalProperties: false` around a
-- single `RedirectURL`.
--
-- What ties a SUMIT callback to a Dubiz request is therefore a high-entropy
-- secret WE generate and embed in the callback URL we hand the provider. The
-- callback authenticates by possessing it. That is the same pattern SUMIT's own
-- WooCommerce plugin uses, and it is a general shape, not a SUMIT special case:
-- any provider that authenticates by URL rather than by signature fits here.
--
-- WHY ONLY A HASH
--
-- The column stores SHA-256 of the secret, never the secret. The live value
-- exists in exactly one place — the URL held by the provider — so a database
-- leak yields nothing a caller could replay. Lookup is by hashing what arrived
-- and matching, which is an equality test on a unique index rather than a scan.
--
-- WHY providerRequestId BECOMES NULLABLE
--
-- A provider may genuinely have no session id to give. Forcing one would mean
-- inventing a synthetic value, which would make the column's name untrue and
-- corrupt the very index that callbacks resolve against. NULL is distinct in
-- Postgres, so the existing `(provider, providerRequestId)` unique constraint
-- keeps working and any number of id-less rows coexist beneath it.
--
-- Dropping NOT NULL is expand-only: every existing row still satisfies the
-- column, and every existing reader still compiles. Nothing is backfilled and
-- no existing row is touched.
--
-- WHY NO GRANT DELTA
--
-- `PaymentProviderRouting` is a bootstrap surface created by
-- 20260830120000_d2_p7_w4ea_payments_tenant_rls with table-level privileges and
-- no column-level grants, so ADD COLUMN is covered by what the runtime already
-- holds. Contrast 20260913120000_authsession_user_agent, where `app_auth` held
-- column-level INSERT and a new column therefore needed an explicit grant.
--
-- The table deliberately carries no tenant RLS — that is the whole point of a
-- bootstrap surface — and this change does not alter that. It adds routing
-- columns only: still no amount, no customer, no description, no payload.
--
-- IF NOT EXISTS so the file is safely re-runnable in a lab. Prisma applies it
-- exactly once in Production.
--
-- NOT applied to Production by this change. Production application goes through
-- the repository's gated release-migrate flow.

ALTER TABLE public."PaymentProviderRouting"
  ALTER COLUMN "providerRequestId" DROP NOT NULL;

ALTER TABLE public."PaymentProviderRouting"
  ADD COLUMN IF NOT EXISTS "callbackSecretHash" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "PaymentProviderRouting_callbackSecretHash_key"
  ON public."PaymentProviderRouting"("callbackSecretHash");
