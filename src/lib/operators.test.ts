import { describe, it, expect, afterEach } from "vitest";
import {
  parseAllowedOperators,
  allowedOperators,
  isAllowedOperator,
  authorizeSession,
} from "./operators";

describe("parseAllowedOperators", () => {
  it("splits on commas and whitespace, trims, and lowercases", () => {
    const allowed = parseAllowedOperators(" Ada@Example.com, grace@example.com\n hopper@example.com ");
    expect(allowed).toEqual(new Set(["ada@example.com", "grace@example.com", "hopper@example.com"]));
  });

  it("reports an unset variable as no list rather than an empty one", () => {
    expect(parseAllowedOperators(undefined)).toBeNull();
    expect(parseAllowedOperators(null)).toBeNull();
  });

  // Someone who sets the variable to nothing means "not configured", not
  // "nobody may sign in", which would lock every operator out.
  it("treats a blank or separator-only value as no list", () => {
    expect(parseAllowedOperators("")).toBeNull();
    expect(parseAllowedOperators("   ")).toBeNull();
    expect(parseAllowedOperators(" , , ")).toBeNull();
  });
});

describe("allowedOperators", () => {
  const original = process.env.AUTH_ALLOWED_EMAILS;

  afterEach(() => {
    if (original === undefined) delete process.env.AUTH_ALLOWED_EMAILS;
    else process.env.AUTH_ALLOWED_EMAILS = original;
  });

  it("reads the environment on every call", () => {
    delete process.env.AUTH_ALLOWED_EMAILS;
    expect(allowedOperators()).toBeNull();

    process.env.AUTH_ALLOWED_EMAILS = "ada@example.com";
    expect(allowedOperators()).toEqual(new Set(["ada@example.com"]));
  });
});

describe("isAllowedOperator", () => {
  const allowed = new Set(["ada@example.com"]);

  it("matches regardless of case or surrounding space", () => {
    expect(isAllowedOperator("Ada@Example.com", allowed)).toBe(true);
    expect(isAllowedOperator("  ada@example.com ", allowed)).toBe(true);
  });

  it("refuses an account that is not listed", () => {
    expect(isAllowedOperator("stranger@example.com", allowed)).toBe(false);
  });

  it("refuses an account with no email, which cannot be matched", () => {
    expect(isAllowedOperator(null, allowed)).toBe(false);
    expect(isAllowedOperator("", allowed)).toBe(false);
  });

  it("imposes no restriction when no list is configured", () => {
    expect(isAllowedOperator("stranger@example.com", null)).toBe(true);
    expect(isAllowedOperator(null, null)).toBe(true);
  });
});

describe("authorizeSession", () => {
  const allowed = new Set(["ada@example.com"]);

  it("passes a session whose account is listed through unchanged", () => {
    const session = { user: { id: "u1", email: "ada@example.com" } };
    expect(authorizeSession(session, allowed)).toBe(session);
  });

  // The point of checking on every request: an operator removed from the list
  // loses access immediately, without waiting for their session row to expire.
  it("drops a session whose account was removed from the list", () => {
    const session = { user: { id: "u1", email: "stranger@example.com" } };
    expect(authorizeSession(session, allowed)).toBeNull();
  });

  it("drops a session whose account has no email to match", () => {
    const session = { user: { id: "u1", email: null } };
    expect(authorizeSession(session, allowed)).toBeNull();
  });

  it("reports no session as no session", () => {
    expect(authorizeSession(null, allowed)).toBeNull();
    expect(authorizeSession(undefined, allowed)).toBeNull();
  });

  it("leaves sessions alone when no list is configured", () => {
    const session = { user: { id: "u1", email: "anyone@example.com" } };
    expect(authorizeSession(session, null)).toBe(session);
  });
});
