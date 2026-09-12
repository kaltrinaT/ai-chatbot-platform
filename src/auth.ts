import NextAuth from "next-auth";
import GitHub from "next-auth/providers/github";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { db } from "@/db";
import { accounts, sessions, users, verificationTokens } from "@/db/schema";

const authSecret = process.env.AUTH_SECRET ?? "dev-secret";

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
  auth = nextAuth.auth;
}

export { handlers, signIn, signOut, auth };
