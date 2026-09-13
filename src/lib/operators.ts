/**
 * Who may sign in to the platform.
 *
 * GitHub OAuth proves only that someone has a GitHub account, and the
 * prototype treats that as enough: authenticated means allowed. An invitation
 * step between the two is future work — see Known Limitation #7 in SECURITY.md.
 * AUTH_ALLOWED_EMAILS is the interim narrowing, worth setting wherever the
 * platform is reachable from the internet: only those accounts, matched on the
 * email address of the GitHub account, may hold a session.
 *
 * When a list is configured it is enforced in two places (see src/auth.ts): when a session is
 * created, so an unlisted account never gets one, and again whenever a session
 * is resolved, so striking an address off ends that operator's access on their
 * next request rather than whenever their session row happens to expire.
 */

/** A session as far as this module cares: it only needs the email. */
export type SessionLike = { user?: { email?: string | null } | null } | null | undefined;

/** Parses the configured list. Null means nothing is configured, so no restriction applies. */
export function parseAllowedOperators(raw: string | undefined | null): Set<string> | null {
  if (!raw) return null;
  const entries = raw
    .split(/[,\s]+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  return entries.length > 0 ? new Set(entries) : null;
}

/** The list as configured right now. Read per call, so tests and a restarted process agree. */
export function allowedOperators(): Set<string> | null {
  return parseAllowedOperators(process.env.AUTH_ALLOWED_EMAILS);
}

export function isAllowedOperator(
  email: string | null | undefined,
  allowed: Set<string> | null,
): boolean {
  if (allowed === null) return true;
  // An account with no email cannot be matched against the list, so it is
  // refused rather than waved through.
  if (!email) return false;
  return allowed.has(email.trim().toLowerCase());
}

/**
 * Hands back the session only if its account is still allowed, and null
 * otherwise — the same answer callers already handle for "not signed in".
 */
export function authorizeSession<T extends SessionLike>(
  session: T,
  allowed: Set<string> | null,
): T | null {
  if (!session) return null;
  return isAllowedOperator(session.user?.email, allowed) ? session : null;
}
