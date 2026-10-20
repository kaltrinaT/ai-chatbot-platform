import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";

/**
 * Runs one step of a workflow in this repository the way a GitHub-hosted
 * runner would, on this machine, with nothing reaching a cloud.
 *
 * What is real: the step's `run:` script exactly as committed, bash invoked
 * with the runner's flags, the environment GitHub would build from the
 * workflow's and the step's `env:` mappings, and a $GITHUB_OUTPUT file read
 * back with GitHub's own rules (a later line for a key overrides an earlier
 * one; `key<<DELIM` opens a multi-line value).
 *
 * What is not: commands that would reach a cloud or a registry (aws, docker,
 * az, terraform, curl) are stubs that record every argument they are given
 * and succeed, unless a test scripts what one prints and how it exits. The
 * harness evaluates only `${{ inputs.* }}`, `${{ steps.<id>.outputs.* }}`,
 * `${{ secrets.* }}`, `${{ vars.* }}` (as unset) and `${{ github.* }}`, and
 * throws on any other expression rather than guessing. It also refuses to run
 * a step whose script — not its env: — contains an input or a step output,
 * because GitHub would paste that value into the source before bash parsed it,
 * and no harness could then tell data from code.
 */

type Workflow = {
  env?: Record<string, string>;
  defaults?: { run?: { shell?: string } };
  jobs: Record<string, { env?: Record<string, string>; defaults?: { run?: { shell?: string } }; steps: Step[] }>;
};
type Step = { name?: string; id?: string; run?: string; env?: Record<string, string>; shell?: string };

export type StepContext = {
  inputs?: Record<string, string>;
  steps?: Record<string, Record<string, string>>;
  /** What a stubbed command prints and how it exits; by default it prints nothing and succeeds. */
  stubs?: Partial<Record<(typeof STUBBED)[number], { stdout?: string; stderr?: string; exitCode?: number }>>;
  /** Files to create in $RUNNER_TEMP before the step runs, by name. */
  files?: Record<string, string>;
};

export type StepRun = {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Outputs as GitHub would resolve them. */
  outputs: Record<string, string>;
  /** $GITHUB_OUTPUT as written, one entry per line. */
  outputLines: string[];
  /** Every stubbed command, with its arguments exactly as received. */
  calls: string[][];
};

const EXPRESSION = /\$\{\{\s*([^}]*?)\s*\}\}/g;
const STUBBED = ["aws", "docker", "az", "terraform", "curl"] as const;
const GITHUB = { run_id: "1234567890", run_attempt: "1", server_url: "https://github.com", repository: "acme/platform" };

export function loadWorkflow(file: string): Workflow {
  return YAML.parse(readFileSync(file, "utf8")) as Workflow;
}

export function stepNames(file: string): string[] {
  const wf = loadWorkflow(file);
  return Object.values(wf.jobs).flatMap((j) => j.steps.map((s) => s.name ?? s.id ?? "(unnamed)"));
}

/** Every `run:` script in the repository's workflows, for the static half of the check. */
export function allRunScripts(dir = ".github/workflows"): { file: string; step: string; run: string }[] {
  return ["deploy-tenant.yml", "destroy-tenant.yml", "deploy-tenant-azure.yml", "destroy-tenant-azure.yml", "verify-tenant-aws.yml", "verify-tenant-azure.yml"]
    .flatMap((f) => {
      const wf = loadWorkflow(path.join(dir, f));
      return Object.values(wf.jobs).flatMap((j) =>
        j.steps.filter((s) => s.run).map((s) => ({ file: f, step: s.name ?? s.id ?? "(unnamed)", run: s.run! })),
      );
    });
}

/** Input and step-output expressions pasted into a script's source. */
export function pastedExpressions(run: string): string[] {
  return [...run.matchAll(EXPRESSION)].map((m) => m[1]).filter((e) => /^(inputs|steps|github\.event)\b/.test(e));
}

function evaluate(value: unknown, ctx: StepContext): string {
  return String(value ?? "").replace(EXPRESSION, (_, expr: string) => resolve(expr, ctx));
}

function resolve(expr: string, ctx: StepContext): string {
  let m: RegExpExecArray | null;
  // `a || 'literal'`: the literal when a is empty, as GitHub evaluates it.
  if ((m = /^(.+?)\s*\|\|\s*'([^']*)'$/.exec(expr))) return resolve(m[1], ctx) || m[2];
  if ((m = /^inputs\.(\w+)$/.exec(expr))) return ctx.inputs?.[m[1]] ?? "";
  if ((m = /^steps\.(\w+)\.outputs\.(\w+)$/.exec(expr))) return ctx.steps?.[m[1]]?.[m[2]] ?? "";
  if ((m = /^secrets\.(\w+)$/.exec(expr))) return `https://platform.invalid/${m[1].toLowerCase()}`;
  // A repository variable that is not set reads as empty, as on GitHub.
  if (/^vars\.\w+$/.test(expr)) return "";
  if ((m = /^github\.(\w+)$/.exec(expr)) && m[1] in GITHUB) return GITHUB[m[1] as keyof typeof GITHUB];
  throw new Error(`The harness does not model the expression \${{ ${expr} }}`);
}

function bash(): string {
  const git = "C:\\Program Files\\Git\\bin\\bash.exe";
  return process.platform === "win32" && existsSync(git) ? git : "bash";
}

const posix = (p: string) => p.replace(/\\/g, "/");

let jqPath: string | undefined;
function windowsJq(): string {
  jqPath ??= spawnSync(bash(), ["-c", "command -v jq"], { encoding: "utf8" }).stdout.trim();
  if (!jqPath) throw new Error("jq is not installed");
  return jqPath;
}

/** GitHub's reading of $GITHUB_OUTPUT. */
function parseOutputs(text: string): { outputs: Record<string, string>; lines: string[] } {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const outputs: Record<string, string> = {};
  for (let i = 0; i < lines.length; i++) {
    const heredoc = /^([^=<]+)<<(.+)$/.exec(lines[i]);
    if (heredoc) {
      const end = lines.indexOf(heredoc[2], i + 1);
      if (end < 0) throw new Error(`Unterminated ${heredoc[1]}<<${heredoc[2]} in $GITHUB_OUTPUT`);
      outputs[heredoc[1]] = lines.slice(i + 1, end).join("\n");
      i = end;
      continue;
    }
    const eq = lines[i].indexOf("=");
    if (eq < 0) throw new Error(`GitHub would reject this $GITHUB_OUTPUT line: ${JSON.stringify(lines[i])}`);
    outputs[lines[i].slice(0, eq)] = lines[i].slice(eq + 1);
  }
  return { outputs, lines };
}

export function runStep(file: string, stepName: string, ctx: StepContext = {}): StepRun {
  const wf = loadWorkflow(file);
  const [job] = Object.values(wf.jobs);
  const step = job.steps.find((s) => s.name === stepName);
  if (!step?.run) throw new Error(`${file}: no run: step named ${stepName}`);

  const pasted = pastedExpressions(step.run);
  if (pasted.length) throw new Error(`${file} › ${stepName} pastes ${pasted.join(", ")} into its script; refusing to run it`);

  const work = mkdtempSync(path.join(os.tmpdir(), "sec-e2e-step-"));
  try {
    const stubs = path.join(work, "bin");
    const calls = path.join(work, "calls");
    const outputFile = path.join(work, "github_output");
    writeFileSync(outputFile, "");
    writeFileSync(path.join(work, "github_env"), "");
    mkdirSync(stubs);

    // Each call is one record (\x1e-terminated) of \x1f-separated fields, so
    // an argument holding a newline is recorded as the one argument it was.
    // A stub reads a piped stdin to the end, as `docker login --password-stdin`
    // does: one that exited without reading would SIGPIPE the command feeding
    // it, and under pipefail fail the step at random.
    for (const name of STUBBED) {
      let reply = name === "aws" ? `[ "$1 $2" = "ecr get-login-password" ] && echo stub-password` : "";
      let exit = 0;
      // A scripted reply is read from files, so its text reaches the step byte for byte.
      const scripted = ctx.stubs?.[name];
      if (scripted) {
        writeFileSync(path.join(work, `${name}.stdout`), scripted.stdout ?? "");
        writeFileSync(path.join(work, `${name}.stderr`), scripted.stderr ?? "");
        reply = `cat "${posix(path.join(work, `${name}.stdout`))}"; cat "${posix(path.join(work, `${name}.stderr`))}" >&2`;
        exit = scripted.exitCode ?? 0;
      }
      writeFileSync(
        path.join(stubs, name),
        `#!/usr/bin/env bash\n{ printf '%s' "${name}"; for a in "$@"; do printf '\\x1f%s' "$a"; done; printf '\\x1e'; } >> "$HARNESS_CALLS"\n[ -p /dev/stdin ] && cat > /dev/null\n${reply}\nexit ${exit}\n`,
        { mode: 0o755 },
      );
    }
    for (const [name, body] of Object.entries(ctx.files ?? {})) writeFileSync(path.join(work, name), body);
    // Native jq on Windows ends lines with CRLF; -b makes it write what jq on
    // the Linux runner writes. Elsewhere jq is used as installed.
    if (process.platform === "win32") {
      writeFileSync(path.join(stubs, "jq"), `#!/usr/bin/env bash\nexec "${windowsJq()}" -b "$@"\n`, { mode: 0o755 });
    }

    const script = path.join(work, "step.sh");
    writeFileSync(script, evaluate(step.run, ctx).replace(/\r\n/g, "\n"));

    const inherited = ["SYSTEMROOT", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "HOME", "USERPROFILE", "LANG"];
    const env: Record<string, string> = Object.fromEntries(
      inherited.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]!]),
    );
    env.PATH = `${stubs}${path.delimiter}${process.env.PATH ?? ""}`;
    Object.assign(env, {
      GITHUB_OUTPUT: posix(outputFile),
      GITHUB_ENV: posix(path.join(work, "github_env")),
      RUNNER_TEMP: posix(work),
      // The checkout, as on a runner: steps call scripts under .github/scripts.
      GITHUB_WORKSPACE: posix(process.cwd()),
      HARNESS_CALLS: posix(calls),
    });
    for (const scope of [wf.env, job.env, step.env]) {
      for (const [k, v] of Object.entries(scope ?? {})) env[k] = evaluate(v, ctx);
    }

    const shell = step.shell ?? job.defaults?.run?.shell ?? wf.defaults?.run?.shell;
    const flags = shell === "bash" ? ["--noprofile", "--norc", "-eo", "pipefail"] : ["-e"];
    const run = spawnSync(bash(), [...flags, posix(script)], {
      cwd: work,
      env: env as NodeJS.ProcessEnv,
      encoding: "utf8",
      timeout: 60_000,
    });

    const recorded = existsSync(calls) ? readFileSync(calls, "utf8") : "";
    const { outputs, lines } = parseOutputs(readFileSync(outputFile, "utf8"));
    return {
      exitCode: run.status ?? -1,
      stdout: run.stdout,
      stderr: run.stderr,
      outputs,
      outputLines: lines,
      calls: recorded.split("\x1e").filter(Boolean).map((r) => r.split("\x1f")),
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
