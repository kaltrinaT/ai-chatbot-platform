import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

// src/auth.ts configures NextAuth when it is imported, so the configuration
// it hands over is captured here and its callbacks are exercised directly.
const h = vi.hoisted(() => ({
  config: null as null | Record<string, unknown>,
  github: null as null | { account?: (tokens: Record<string, unknown>) => unknown },
}));

vi.mock("next-auth", () => ({
  default: vi.fn((config: Record<string, unknown>) => {
    h.config = config;
    return { handlers: {}, signIn: vi.fn(), signOut: vi.fn(), auth: vi.fn() };
  }),
}));
vi.mock("next-auth/providers/github", () => ({
  default: vi.fn((options: typeof h.github) => {
    h.github = options;
    return { id: "github", options };
  }),
}));
vi.mock("@auth/drizzle-adapter", () => ({ DrizzleAdapter: vi.fn(() => ({})) }));
vi.mock("@/db", () => ({ db: {} }));

type Callbacks = {
  signIn: (args: { user?: { email?: string | null } | null; profile?: { email?: string | null } | null }) => boolean;
  authorized: (args: { request: { nextUrl: { pathname: string } }; auth: unknown }) => boolean;
};
let callbacks: Callbacks;

beforeAll(async () => {
  process.env.DATABASE_URL = "postgres://test";
  process.env.AUTH_GITHUB_ID = "client-id";
  process.env.AUTH_GITHUB_SECRET = "client-secret";
  await import("./auth");
  callbacks = h.config!.callbacks as Callbacks;
});

beforeEach(() => {
  process.env.AUTH_ALLOWED_EMAILS = "operator@example.com";
});

// Attack matrix — secret storage, new OAuth login. Auth.js would otherwise
// write GitHub's access, refresh and ID tokens to the accounts table in
// plaintext on every sign-in.
describe("a new GitHub sign-in", () => {
  it("stores no token GitHub hands back", () => {
    const stored = h.github!.account!({
      access_token: "gho_live_access",
      refresh_token: "ghr_live_refresh",
      id_token: "eyJ.live.id",
      token_type: "bearer",
      scope: "read:user user:email",
    });

    expect(stored).toBeUndefined();
  });

  it("is refused for an account that is not on the operator list", () => {
    expect(callbacks.signIn({ user: { email: "stranger@example.com" } })).toBe(false);
  });

  it("is refused for an account with no email, rather than waved through", () => {
    expect(callbacks.signIn({ user: { email: null }, profile: { email: null } })).toBe(false);
  });

  it("control: a listed operator signs in, whatever the case of the address", () => {
    expect(callbacks.signIn({ user: { email: "Operator@Example.com" } })).toBe(true);
  });
});

// The proxy lets exactly two kinds of request through without a session: a
// run's status callback and its secrets request, which authenticate
// themselves. Anything that only resembles those paths must not get the same
// pass.
describe("the proxy's exception for workflow callbacks", () => {
  const passes = (pathname: string, auth: unknown = null) =>
    callbacks.authorized({ request: { nextUrl: { pathname } }, auth });

  it.each(["/api/deployments/dep-1/status", "/api/deployments/dep-1/secrets", "/api/deployments/dep-1/status/"])(
    "lets %s through without a session",
    (path) => {
      expect(passes(path)).toBe(true);
    },
  );

  it.each([
    "/api/deployments/dep-1/progress",
    "/api/deployments/dep-1/status/extra",
    "/api/deployments/dep-1/statusx",
    "/api/deployments/dep-1/secrets-all",
    "/api/deployments/a/b/status",
    "/api/deployments//status",
    "/tenants/t-1",
    "/",
  ])("does not let %s through without a session", (path) => {
    expect(passes(path)).toBe(false);
  });

  it("does not let a signed-in account through once it is struck off the list", () => {
    expect(passes("/tenants/t-1", { user: { email: "former@example.com" } })).toBe(false);
    expect(passes("/tenants/t-1", { user: { email: "operator@example.com" } })).toBe(true);
  });
});

// A production server must not come up in a state where the proxy waves every
// request through, sessions cannot be signed, or nobody can sign in. Each case
// leaves one value out; the control has them all. Last in the file, since each
// case imports src/auth.ts afresh.
describe("starting in production", () => {
  const complete = {
    DATABASE_URL: "postgres://test",
    AUTH_SECRET: "a-session-signing-secret",
    AUTH_GITHUB_ID: "client-id",
    AUTH_GITHUB_SECRET: "client-secret",
  };
  async function boot(missing?: keyof typeof complete): Promise<string | null> {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PHASE", undefined);
    for (const [name, value] of Object.entries(complete)) vi.stubEnv(name, name === missing ? undefined : value);
    try {
      await import("./auth");
      return null;
    } catch (err) {
      return (err as Error).message;
    } finally {
      vi.unstubAllEnvs();
    }
  }

  it.each([
    ["DATABASE_URL", /DATABASE_URL is not set/],
    ["AUTH_SECRET", /AUTH_SECRET is not set/],
    ["AUTH_GITHUB_ID", /AUTH_GITHUB_ID and AUTH_GITHUB_SECRET are not both set/],
  ] as const)("refuses to start without %s", async (name, message) => {
    expect(await boot(name)).toMatch(message);
  });

  it("control: starts with all of them set", async () => {
    expect(await boot()).toBeNull();
  });
});
