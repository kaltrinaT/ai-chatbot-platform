import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "@/db/schema";

/**
 * A real Postgres for the local security scenarios (src/security-e2e).
 *
 * PGlite is Postgres compiled to WebAssembly and run in-process, so nothing is
 * installed, started or paid for. Unlike src/test/fake-db.ts, which evaluates
 * the SELECTs the code sends, this applies the repository's own migrations and
 * then runs every statement for real: uuid casts, foreign keys, the check
 * that a live tenant has an LLM key, and the partial unique index that allows
 * one active deployment per tenant. Concurrency claims are tested against
 * that index, not against a mock that was told which request wins.
 */
export async function migratedDatabase() {
  const client = new PGlite();
  const root = process.cwd();
  const journal = JSON.parse(readFileSync(path.join(root, "drizzle/meta/_journal.json"), "utf8")) as {
    entries: { tag: string }[];
  };
  for (const { tag } of journal.entries) {
    const migration = readFileSync(path.join(root, "drizzle", `${tag}.sql`), "utf8");
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) await client.exec(statement);
    }
  }
  return { client, db: drizzle(client, { schema }) };
}
