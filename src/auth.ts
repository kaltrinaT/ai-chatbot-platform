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
  session: { strategy: "database" },
  pages: { signIn: "/signin" },
  secret: authSecret,
};

let handlers: any;
let signIn: any;
let signOut: any;
let auth: any;

if (!process.env.DATABASE_URL) {
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
