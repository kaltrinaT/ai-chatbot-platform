import NextAuth from "next-auth";
import GitHub from "next-auth/providers/github";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { db } from "@/db";
import { accounts, sessions, users, verificationTokens } from "@/db/schema";
import {
  allowedOperators,
  authorizeSession,
  isAllowedOperator,
  type SessionLike,
} from "@/lib/operators";

// An environment variable added with no value is not the same as an unset one,
// and only the second would fall through to the development default. An empty
// string reaches NextAuth, which then answers every auth route with "there was
// a problem with the server configuration" and says no more.
const configuredAuthSecret = process.env.AUTH_SECRET?.trim();
const authSecret = configuredAuthSecret || "dev-secret";

// GitHub Actions posts deployment status to this path with an x-webhook-secret
// header and no session, and the route checks that header itself. The proxy has
// to let it past: redirecting the workflow's POST to the sign-in page would
// answer it with HTTP 200 and an HTML body, which the workflow reads as a
// delivered callback.
//
// The secrets path is let past for the same reason: an Azure run calls it with
// its GitHub OIDC token and no session, and the route verifies that token.
const WEBHOOK_PATH = /^\/api\/deployments\/[^/]+\/(status|secrets)\/?$/;

// Trimmed for the same reason as the secret above: a value pasted into a
// hosting dashboard with a stray newline is not a credential OAuth can use.
const githubId = process.env.AUTH_GITHUB_ID?.trim();
const githubSecret = process.env.AUTH_GITHUB_SECRET?.trim();

const providers = [];
if (githubId && githubSecret) {
  providers.push(
    GitHub({
      clientId: githubId,
      clientSecret: githubSecret,
    })
  );
}

const authOptions = {
  providers,
  session: { strategy: "database" as const },
  pages: { signIn: "/signin" },
  secret: authSecret,
  callbacks: {
    // Refused here, the sign-in never reaches the adapter, so an account that
    // is not an operator leaves no user row behind either.
    signIn({
      user,
      profile,
    }: {
      user?: { email?: string | null } | null;
      profile?: { email?: string | null } | null;
    }) {
      return isAllowedOperator(user?.email ?? profile?.email, allowedOperators());
    },

    // What the proxy consults, since src/proxy.ts exports `auth` itself.
    // Without this callback next-auth authorizes every request, so this is
    // what makes the proxy a perimeter rather than a no-op.
    authorized({
      request,
      auth: session,
    }: {
      request: { nextUrl: { pathname: string } };
      auth: SessionLike;
    }) {
      if (WEBHOOK_PATH.test(request.nextUrl.pathname)) return true;
      return Boolean(authorizeSession(session, allowedOperators())?.user);
    },
  },
};

let handlers: any;
let signIn: any;
let signOut: any;
let auth: any;

/**
 * The no-database branch below exists so the app can be started locally
 * without Postgres. It is not safe anywhere else: `auth` becomes a function
 * that returns null, and the proxy IS `auth` (see src/proxy.ts), so a guard
 * that returns nothing waves every request through. Route handlers
 * and pages still check the session individually, but the one control that is
 * supposed to cover everything by default would be silently absent.
 *
 * Failing at startup is the honest behaviour: a production deployment missing
 * DATABASE_URL is misconfigured, and a loud boot failure is far better than an
 * app that serves with its perimeter quietly disabled.
 */
// Deliberately not enforced during `next build`, which runs with NODE_ENV
// production but never serves a request. A build box legitimately may not hold
// the database URL; a running server must.
if (
  !process.env.DATABASE_URL &&
  process.env.NODE_ENV === "production" &&
  process.env.NEXT_PHASE !== "phase-production-build"
) {
  throw new Error(
    "DATABASE_URL is not set. Refusing to start: without it the auth adapter " +
      "cannot run, and the proxy that protects every route would allow " +
      "all requests through.",
  );
}

if (
  !configuredAuthSecret &&
  process.env.NODE_ENV === "production" &&
  process.env.NEXT_PHASE !== "phase-production-build"
) {
  throw new Error(
    "AUTH_SECRET is not set, or is set to an empty value. Refusing to start: " +
      "sessions could not be signed, and NextAuth would answer every auth route " +
      "with an opaque configuration error instead of naming the cause.",
  );
}

if (
  providers.length === 0 &&
  process.env.NODE_ENV === "production" &&
  process.env.NEXT_PHASE !== "phase-production-build"
) {
  throw new Error(
    "AUTH_GITHUB_ID and AUTH_GITHUB_SECRET are not both set. Refusing to start: " +
      "with no provider configured nobody can sign in, and the auth routes answer " +
      "with a configuration error rather than saying which value is missing.",
  );
}

// Access stops at authentication on purpose: a completed GitHub sign-in
// reaches the platform. AUTH_ALLOWED_EMAILS narrows that to named accounts
// when it is set, and an invitation step is future work — see Known
// Limitation #7 in SECURITY.md.

if (!process.env.DATABASE_URL) {
  console.warn(
    "[auth] DATABASE_URL is not set — authentication is DISABLED and the " +
      "proxy will not block anything. Development only.",
  );
  handlers = {
    GET: async () => new Response("Auth not configured", { status: 404 }),
    POST: async () => new Response("Auth not configured", { status: 404 }),
  };

  signIn = async () => {
    // no-op in dev
  };

  signOut = async () => {
    // no-op in dev
  };

  auth = async () => null;
} else {
  const nextAuth = NextAuth({
    adapter: DrizzleAdapter(db, {
      usersTable: users,
      accountsTable: accounts,
      sessionsTable: sessions,
      verificationTokensTable: verificationTokens,
    }),
    ...authOptions,
  }) as any;

  handlers = nextAuth.handlers;
  signIn = nextAuth.signIn;
  signOut = nextAuth.signOut;

  // Every page, server action and route handler resolves its session through
  // auth(), so the allow-list is applied once here and covers all of them.
  // That is also what makes striking an address off the list take effect on
  // the operator's next request, rather than whenever their session row
  // expires. Called with arguments, this is next-auth's proxy wrapper instead,
  // which does its own check through the authorized callback above.
  const resolveSession = nextAuth.auth;
  auth = (...args: unknown[]) =>
    args.length > 0
      ? resolveSession(...args)
      : Promise.resolve(resolveSession()).then((session: SessionLike) =>
          authorizeSession(session, allowedOperators()),
        );
}

export { handlers, signIn, signOut, auth };
