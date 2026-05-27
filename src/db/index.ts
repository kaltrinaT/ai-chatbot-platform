import { Pool, neonConfig } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import ws from "ws";
import * as schema from "./schema";

neonConfig.webSocketConstructor = ws;

let _db: any;

if (process.env.DATABASE_URL) {
	const pool = new Pool({ connectionString: process.env.DATABASE_URL });
	_db = drizzle(pool, { schema });
} else {
	// Development fallback: provide a minimal no-op DB so the app doesn't
	// crash during server startup when DATABASE_URL is not set. This avoids
	// a hard 500 while developing UI without a database.
	// NOTE: This returns empty results for selects and harmless responses
	// for insert/update/delete operations.
	// For real usage, set DATABASE_URL in .env.local.
	// eslint-disable-next-line no-console
	console.warn("No DATABASE_URL found — using empty fallback DB for local development.");

	const thenableEmpty = (arr: any) => ({ then: (resolve: any) => resolve(arr) });

	_db = {
		select: () => ({
			from: () => ({
				where: () => ({
					orderBy: () => thenableEmpty([]),
					limit: async () => [],
					then: async (resolve: any) => resolve([]),
				}),
				orderBy: () => thenableEmpty([]),
				limit: async () => [],
				then: async (resolve: any) => resolve([]),
			}),
		}),
		insert: () => ({ into: () => ({ values: async () => ({ rowCount: 0 }) }) }),
		update: () => ({ set: async () => ({ rowCount: 0 }) }),
		delete: () => ({ from: () => ({ where: async () => ({ rowCount: 0 }) }) }),
	} as any;
}
export const db = _db;
