/**
 * Browser code never reaches server code.
 *
 * A Client Component bundles everything it imports, transitively. The
 * onboarding wizard once imported one constant from verifyConnection.ts,
 * which imports the GitHub client, and the browser bundle pulled in Octokit,
 * GITHUB_PAT's reader and adm-zip — whose use of Node's `fs` failed the build
 * with "Can't resolve 'fs'". Type-checking and every other test passed
 * meanwhile, since neither bundles anything. This follows the same imports
 * the bundler would and fails with the chain that crosses the line.
 *
 * Imports of "use server" files stop the walk: Next.js replaces them with
 * references to server actions instead of bundling them.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const SRC = join(process.cwd(), "src");

// Modules that hold server credentials or need Node built-ins. Reaching any
// of them from browser code is a bug even when the build happens to succeed.
const SERVER_ONLY = ["lib/github.ts", "db/index.ts", "auth.ts", "lib/crypto.ts"].map((p) => join(SRC, p));

const rel = (file: string) => relative(process.cwd(), file).replace(/\\/g, "/");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

function directive(file: string): string | null {
  const first = readFileSync(file, "utf8").replace(/^(\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*/, "");
  return first.match(/^["']use (client|server)["']/)?.[1] ?? null;
}

/** Module specifiers a file imports for their values; type-only imports are erased. */
function valueImports(file: string): string[] {
  const src = readFileSync(file, "utf8");
  const specs: string[] = [];
  for (const m of src.matchAll(/^\s*(?:import|export)\s+(?!type\s)([^;]*?)\s+from\s+["']([^"']+)["']/gm)) {
    const clause = m[1].trim();
    const braces = clause.match(/^\{([\s\S]*)\}$/);
    const typeOnly = braces && braces[1].split(",").map((s) => s.trim()).filter(Boolean).every((s) => s.startsWith("type "));
    if (!typeOnly) specs.push(m[2]);
  }
  for (const m of src.matchAll(/^\s*import\s+["']([^"']+)["']/gm)) specs.push(m[1]);
  return specs;
}

function resolveImport(from: string, spec: string): string | null {
  const base = spec.startsWith("@/") ? join(SRC, spec.slice(2)) : spec.startsWith(".") ? resolve(dirname(from), spec) : null;
  if (!base) return null; // a package; its own boundary is its author's business
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** The import chain from `entry` to a server-only module, or null. */
function chainToServer(entry: string): string[] | null {
  const seen = new Set<string>([entry]);
  const queue: string[][] = [[entry]];
  while (queue.length) {
    const path = queue.shift()!;
    for (const spec of valueImports(path[path.length - 1])) {
      const next = resolveImport(path[path.length - 1], spec);
      if (!next || seen.has(next)) continue;
      seen.add(next);
      if (SERVER_ONLY.includes(next)) return [...path, next];
      if (directive(next) === "server") continue;
      queue.push([...path, next]);
    }
  }
  return null;
}

const clientFiles = sourceFiles(SRC).filter((f) => directive(f) === "client");

describe("client components", () => {
  it("exist, so this check is not passing vacuously", () => {
    expect(clientFiles.length).toBeGreaterThan(0);
  });

  it.each(clientFiles.map((f) => [rel(f), f]))("%s never imports server code", (_name, file) => {
    const chain = chainToServer(file);
    expect(chain?.map(rel).join(" → ") ?? null).toBeNull();
  });
});
