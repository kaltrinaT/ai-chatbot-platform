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

const authSecret = process.env.AUTH_SECRET ?? "dev-secret";

// GitHub Actions posts deployment status to this path with an x-webhook-secret
// header and no session, and the route checks that header itself. The
// middleware has to let it past: redirecting the workflow's POST to the
// sign-in page would answer it with HTTP 200 and an HTML body, which the
// workflow reads as a delivered callback.
const WEBHOOK_PATH = /^\/api\/deployments\/[^/]+\/status\/?$/;

const providers = [];
if (process.env.AUTH_GITHUB_ID && process.env.AUTH_GITHUB_SECRET) {
  providers.push(
    GitHub({
      clientId: process.env.AUTH_GITHUB_ID,
      clientSecret: process.env.AUTH_GITHUB_SECRET,
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

    // What the middleware consults, since src/middleware.ts exports `auth`
    // itself. Without this callback next-auth authorizes every request, so
    // this is what makes the middleware a perimeter rather than a no-op.
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
 * that returns null, and `middleware` IS `auth` (see src/middleware.ts), so a
 * middleware that returns nothing waves every request through. Route handlers
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
      "cannot run, and the middleware that protects every route would allow " +
      "all requests through.",
  );
}

/**
 * GitHub OAuth only proves that the visitor has a GitHub account. The
 * allow-list is what separates that from "may onboard tenants into customer
 * cloud accounts", so a served deployment must name its operators. On a
 * developer machine an unset list means no restriction, which the warning
 * below makes visible.
 */
if (
  allowedOperators() === null &&
  process.env.NODE_ENV === "production" &&
  process.env.NEXT_PHASE !== "phase-production-build"
) {
  throw new Error(
    "AUTH_ALLOWED_EMAILS is not set. Refusing to start: sign-in would be open to " +
      "every GitHub account. Set it to the comma-separated email addresses of the " +
      "accounts allowed to operate this platform.",
  );
}

if (allowedOperators() === null) {
  console.warn(
    "[auth] AUTH_ALLOWED_EMAILS is not set — any GitHub account may sign in. " +
      "Development only.",
  );
}

if (!process.env.DATABASE_URL) {
  console.warn(
    "[auth] DATABASE_URL is not set — authentication is DISABLED and the " +
      "middleware will not block anything. Development only.",
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
  // expires. Called with arguments, this is next-auth's middleware wrapper
  // instead, which does its own check through the authorized callback above.
  const resolveSession = nextAuth.auth;
  auth = (...args: unknown[]) =>
    args.length > 0
      ? resolveSession(...args)
      : Promise.resolve(resolveSession()).then((session: SessionLike) =>
          authorizeSession(session, allowedOperators()),
        );
}

export { handlers, signIn, signOut, auth };
