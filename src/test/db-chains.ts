import { vi } from "vitest";

type AnyMock = ReturnType<typeof vi.fn>;

/**
 * These mirror the drizzle-orm fluent-query shapes used across this repo's
 * db mocks (`db.select().from().where()`, etc). Each helper wires up the
 * chain structure only — callers own the leaf mock (`where`/`returning`/…)
 * so they can control resolved values and assert on call args per test.
 */

/** `db.select().from().where()` */
export function selectWhereChain(where: AnyMock) {
  return { from: vi.fn(() => ({ where })) };
}

/** `db.select({...}).from().innerJoin().where()` */
export function selectJoinChain(where: AnyMock) {
  return { from: vi.fn(() => ({ innerJoin: vi.fn(() => ({ where })) })) };
}

/** `db.update(table).set(values).where(cond)` */
export function updateSetWhereChain(where: AnyMock) {
  return { set: vi.fn(() => ({ where })) };
}

/** `db.insert(table).values(v).returning()` */
export function insertValuesReturningChain(returning: AnyMock) {
  return { values: vi.fn(() => ({ returning })) };
}

/**
 * A resolved `Promise<undefined>` that also exposes `.returning()` — for
 * `update().set().where()` call sites where some callers `await` the
 * `where()` result directly (no row needed back) and others chain
 * `.returning()` to get the updated row(s), e.g. the two `db.update()` calls
 * in `api/deployments/[id]/status/route.ts` (deployments row vs. tenant row).
 */
export function thenableWithReturning(returning: AnyMock) {
  const promise = Promise.resolve(undefined) as Promise<undefined> & { returning: AnyMock };
  promise.returning = returning;
  return promise;
}
