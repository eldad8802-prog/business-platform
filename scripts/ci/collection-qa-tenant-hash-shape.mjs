/**
 * The one definition of "a password hash this tenant may be provisioned with".
 *
 * It lives in its own module because two places need to agree about it: the
 * production workflow, which must refuse a secret of the wrong shape before it
 * reaches the database, and the compatibility test, which proves the shape is
 * the one Production login actually accepts. A regex copied into a shell step
 * would drift from the test that justifies it, and the drift would only show up
 * as an account nobody can log into.
 *
 * $2[aby]$ — the bcrypt variants node-bcrypt emits and verifies.
 * 10        — the cost lib/auth/signup.ts#BCRYPT_ROUNDS uses. Pinned, not
 *             merely allowed: a hash at another cost would still log in, but it
 *             would no longer be what registration produces, and this tenant
 *             exists to behave exactly like a registered one.
 * 53 chars  — 22 of salt plus 31 of digest, in bcrypt's own alphabet.
 */
export const BCRYPT_COST_10_SHAPE = /^\$2[aby]\$10\$[./A-Za-z0-9]{53}$/;
