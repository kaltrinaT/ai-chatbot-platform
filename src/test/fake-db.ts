import { drizzle } from "drizzle-orm/pg-proxy";
import * as schema from "@/db/schema";

/**
 * A stand-in Postgres for authorization tests. Drizzle builds the real SQL
 * the code sends, and this evaluates it against in-memory rows.
 *
 * The db-chains mocks return whatever a test tells them to, so they cannot
 * tell an ownership check in a WHERE clause from a missing one: "the query
 * returned nothing" passes either way. Here the query's own conditions decide
 * which rows come back, so dropping `owner_user_id = $n` from the code hands
 * the other operator's row to the test, and the test fails.
 *
 * It understands the SELECT shapes the control plane uses — one table, or one
 * inner join; conditions joined by `and`; `=`, `is null`, `in (...)`; `limit`
 * — and throws on anything else, so a query change cannot pass a test by
 * slipping past the evaluator. Writes are recorded, not applied.
 */

/** Rows per table, keyed by column name as it appears in SQL. */
export type Tables = Record<string, Record<string, unknown>[]>;

type Joined = Record<string, Record<string, unknown>>;

export function fakeDb(tables: Tables) {
  const writes: string[] = [];
  const db = drizzle(
    async (sql, params) => {
      if (/^(insert|update|delete)\b/i.test(sql)) {
        writes.push(sql);
        return { rows: [] };
      }
      return { rows: select(sql, params, tables) };
    },
    { schema },
  );
  return { db, writes };
}

function unsupported(what: string, sql: string): never {
  throw new Error(`fake-db does not model ${what}: ${sql}`);
}

function select(sql: string, params: unknown[], tables: Tables): unknown[][] {
  const m = /^select ([\s\S]+?) from "(\w+)"(?: inner join "(\w+)" on ([\s\S]+?))?(?: where ([\s\S]+?))?(?: limit \$(\d+))?$/.exec(sql);
  if (!m) unsupported("this query", sql);
  const [, list, from, join, on, where, limit] = m;

  let rows: Joined[] = (tables[from] ?? []).map((r) => ({ [from]: r }));
  if (join) {
    rows = rows.flatMap((left) => (tables[join] ?? []).map((right) => ({ ...left, [join]: right })));
    rows = rows.filter((row) => holds(on, row, params, from, sql));
  }
  if (where) rows = rows.filter((row) => holds(where, row, params, from, sql));
  if (limit) rows = rows.slice(0, Number(params[Number(limit) - 1]));

  const columns = splitTopLevel(list, ", ").map((c) => column(c, from, sql));
  return rows.map((row) => columns.map(([table, name]) => row[table]?.[name] ?? null));
}

function column(ref: string, from: string, sql: string): [string, string] {
  const m = /^"(\w+)"(?:\."(\w+)")?$/.exec(ref.trim());
  if (!m) unsupported(`the column ${ref}`, sql);
  return m[2] ? [m[1], m[2]] : [from, m[1]];
}

function holds(condition: string, row: Joined, params: unknown[], from: string, sql: string): boolean {
  let c = condition.trim();
  while (wrapped(c)) c = c.slice(1, -1).trim();
  const parts = splitTopLevel(c, " and ");
  if (parts.length > 1) return parts.every((p) => holds(p, row, params, from, sql));
  if (/\s(or|not)\s/i.test(` ${c} `)) unsupported("or / not", sql);

  const value = (ref: string) => {
    const [table, name] = column(ref, from, sql);
    return row[table]?.[name] ?? null;
  };
  const param = (p: string) => params[Number(p.slice(1)) - 1];
  const same = (a: unknown, b: unknown) => a !== null && b !== null && a !== undefined && b !== undefined && String(a) === String(b);

  let m;
  if ((m = /^("[^"]+"(?:\."[^"]+")?) = (\$\d+)$/.exec(c))) return same(value(m[1]), param(m[2]));
  if ((m = /^("[^"]+"(?:\."[^"]+")?) = ("[^"]+"(?:\."[^"]+")?)$/.exec(c))) return same(value(m[1]), value(m[2]));
  if ((m = /^("[^"]+"(?:\."[^"]+")?) is null$/.exec(c))) return value(m[1]) === null;
  if ((m = /^("[^"]+"(?:\."[^"]+")?) in \(([$\d, ]+)\)$/.exec(c))) {
    const v = value(m[1]);
    return m[2].split(",").some((p) => same(v, param(p.trim())));
  }
  return unsupported(`the condition ${c}`, sql);
}

/** Whether the whole text sits inside one pair of parentheses: "(a and b)", not "(a) and (b)". */
function wrapped(text: string): boolean {
  if (!text.startsWith("(") || !text.endsWith(")")) return false;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")") depth--;
    if (depth === 0 && i < text.length - 1) return false;
  }
  return true;
}

/** Splits on a separator only where it is not inside parentheses. */
function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")") depth--;
    else if (depth === 0 && text.startsWith(separator, i)) {
      parts.push(text.slice(start, i));
      start = i + separator.length;
      i += separator.length - 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}
