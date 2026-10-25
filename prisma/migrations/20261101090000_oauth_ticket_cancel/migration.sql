-- OAuth signup ticket cancel — "Continue with Google", closing the cancel gap before activation (migration only)
--
-- WHY
--   The completion form's "cancel" forgets the ticket in the browser only: the cookie goes, the row stays
--   open until it expires (30 minutes) or a newer ticket for the same Google subject supersedes it. A copy
--   of the secret could still complete the signup in that window. Cancel must end the ticket on the server,
--   so that no copy of the secret can ever complete with it.
--
-- WHAT THIS ADDS
--   "OAuthSignupTicket_end" admits a third end reason, CANCELLED (beside CONSUMED and SUPERSEDED). The
--   constraint keeps its name and its every other rule; only the vocabulary grows. No row changes.
--
--   auth_oauth_ticket_cancel(secret, purpose) — SECURITY DEFINER, search_path pinned. End the ticket the
--   caller holds: ONE conditional UPDATE under the row lock, the same statement shape as
--   auth_oauth_ticket_consume, so a cancel and a completion of the same ticket cannot both win:
--     * cancel first  → the completion's spend re-reads the row, finds it ended, gets no row: no account;
--     * completion first (committed) → the cancel re-reads the row, finds it CONSUMED and changes nothing;
--       the account the completion created is never touched;
--     * a completion that rolls back leaves the ticket open, and the waiting cancel then ends it.
--   It answers what it found, for the ticket the caller holds only (the caller has the secret):
--     CANCELLED          — this call ended it;
--     ALREADY_CANCELLED  — an earlier cancel did (a second cancel is safe and changes nothing);
--     COMPLETED          — it was spent by a completed signup (nothing changes);
--     SUPERSEDED         — a newer ticket closed it (nothing changes);
--     EXPIRED            — its 30 minutes are over (nothing changes; the sweep removes it);
--     NOT_FOUND          — no ticket of that purpose has that secret (a wrong secret, a wrong purpose, a
--                          purged ticket): nothing changes.
--
-- WHO MAY DO WHAT
--   app_auth    — EXECUTE on the new function, like the six of 20261030090000. Still NOTHING on the table.
--   app_runtime — nothing on the function, nothing on the table (unchanged).
--   PUBLIC      — nothing.
--
-- WHAT IT DELIBERATELY DOES NOT DO
--   no change to the six existing functions, the policies, the grants, the indexes or any other constraint;
--   no change to 20261030090000 itself; no backfill; no route, no flag, no user-visible change (the route
--   that calls it ships in the application PR, after this is applied).
--
-- Additive: one vocabulary widening, one function.

-- ── The end reason ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE "OAuthSignupTicket" DROP CONSTRAINT "OAuthSignupTicket_end";
ALTER TABLE "OAuthSignupTicket" ADD CONSTRAINT "OAuthSignupTicket_end" CHECK (("endedAt" IS NULL) = ("endedReason" IS NULL)
    AND ("endedReason" IS NULL OR "endedReason" IN ('CONSUMED', 'SUPERSEDED', 'CANCELLED')));

-- ── The function ───────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.auth_oauth_ticket_cancel(p_secret text, p_purpose text)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_now timestamp(3) := timezone('UTC', now());
  v_hash text;
  v_tok record;
BEGIN
  IF p_secret IS NULL OR char_length(p_secret) > 200 OR p_purpose IS NULL OR p_purpose NOT IN ('SIGNUP', 'LINK') THEN
    RETURN 'NOT_FOUND';
  END IF;
  v_hash := encode(sha256(convert_to(p_secret, 'UTF8')), 'hex');

  -- The whole guarantee is this one statement. It takes the row lock; a concurrent spend (or cancel) of the
  -- same ticket waits on it and, once this transaction commits, re-reads the row, finds "endedAt" set and
  -- updates nothing. Waiting on a spend that commits, this statement re-reads the row and updates nothing.
  UPDATE public."OAuthSignupTicket" t
     SET "endedAt" = v_now, "endedReason" = 'CANCELLED'
   WHERE t."secretHash" = v_hash
     AND t."purpose" = p_purpose
     AND t."endedAt" IS NULL
     AND t."expiresAt" > v_now;
  IF FOUND THEN
    RETURN 'CANCELLED';
  END IF;

  -- Nothing ended here: say what the ticket already was, and change nothing.
  SELECT t."endedReason", t."expiresAt" INTO v_tok
    FROM public."OAuthSignupTicket" t
   WHERE t."secretHash" = v_hash AND t."purpose" = p_purpose;
  IF NOT FOUND THEN
    RETURN 'NOT_FOUND';
  END IF;
  RETURN CASE v_tok."endedReason"
    WHEN 'CANCELLED' THEN 'ALREADY_CANCELLED'
    WHEN 'CONSUMED' THEN 'COMPLETED'
    WHEN 'SUPERSEDED' THEN 'SUPERSEDED'
    ELSE 'EXPIRED'
  END;
END
$fn$;

REVOKE ALL ON FUNCTION public.auth_oauth_ticket_cancel(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.auth_oauth_ticket_cancel(text, text) FROM app_runtime;
GRANT EXECUTE ON FUNCTION public.auth_oauth_ticket_cancel(text, text) TO app_auth;
