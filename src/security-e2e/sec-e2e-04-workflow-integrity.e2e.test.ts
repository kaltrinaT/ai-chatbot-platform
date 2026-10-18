/**
 * SEC-E2E-04 — Workflow integrity.
 *
 * Claim: values a dispatch carries — every tenant field the platform sends —
 * are only ever data to the workflow. They cannot run a command, and they
 * cannot rewrite another step's output.
 *
 * Executed, not inspected: the deploy and teardown workflows' own step
 * scripts run in bash on this machine through src/test/workflow-runner.ts,
 * with cloud and registry CLIs replaced by stubs that record their arguments.
 * Code execution is detected by a canary file each payload tries to create;
 * output injection by reading $GITHUB_OUTPUT back the way GitHub does.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { allRunScripts, pastedExpressions, runStep, stepNames, type StepRun } from "@/test/workflow-runner";
import { evidence } from "@/test/evidence";

const record = evidence("SEC-E2E-04");

// Each case starts real bash processes; on Windows a Git Bash start alone
// takes about a second, and the config step calls jq a dozen times.
vi.setConfig({ testTimeout: 60_000 });

const AZURE_DEPLOY = ".github/workflows/deploy-tenant-azure.yml";
const AZURE_DESTROY = ".github/workflows/destroy-tenant-azure.yml";
const AWS_DEPLOY = ".github/workflows/deploy-tenant.yml";
const AWS_DESTROY = ".github/workflows/destroy-tenant.yml";
const GUARD = "Refuse inputs containing line breaks";

const canary = path.join(os.tmpdir(), `sec-e2e-canary-${randomUUID()}`).replace(/\\/g, "/");
afterEach(() => rmSync(canary, { force: true }));

/** Shell payloads that create the canary if bash ever evaluates them as code. */
const codePayloads: [string, string][] = [
  ["command substitution", `$(touch ${canary})`],
  ["backticks", `\`touch ${canary}\``],
  ["breaking out of double quotes", `"; touch ${canary}; echo "`],
  ["breaking out of single quotes", `'; touch ${canary}; echo '`],
  ["a command list", `x && touch ${canary}`],
  ["a pipe", `x | touch ${canary}`],
  ["IFS word splitting", `$(IFS=_;c=touch_${canary};$c)`],
];

const config = {
  azure_subscription_id: "11111111-1111-4111-8111-111111111111",
  azure_tenant_id: "22222222-2222-4222-8222-222222222222",
  azure_client_id: "33333333-3333-4333-8333-333333333333",
  azure_region: "swedencentral",
  llm_provider: "openai",
  llm_model: "gpt-4o-mini",
  chatbot_version: "latest",
  domain: "",
  vector_store: "pgvector",
};
const azureInputs = (cfg: Record<string, string> = config) => ({
  deployment_id: "dep-1",
  tenant_id: "a0000000-0000-4000-8000-00000000000a",
  tenant_slug: "alpha",
  config: JSON.stringify(cfg),
  your_ecr_image: "111111111111.dkr.ecr.eu-central-1.amazonaws.com/chatbot-backend:latest",
  your_frontend_ecr_image: "111111111111.dkr.ecr.eu-central-1.amazonaws.com/chatbot-frontend:latest",
});
const awsInputs = {
  deployment_id: "dep-1",
  tenant_id: "a0000000-0000-4000-8000-00000000000a",
  tenant_slug: "alpha",
  aws_account_id: "111122223333",
  aws_region: "eu-central-1",
  chatbot_version: "latest",
  your_ecr_image: "111111111111.dkr.ecr.eu-central-1.amazonaws.com/chatbot-backend:latest",
  your_frontend_ecr_image: "111111111111.dkr.ecr.eu-central-1.amazonaws.com/chatbot-frontend:latest",
};

const summary = (r: StepRun) => ({ exitCode: r.exitCode, outputLines: r.outputLines.length, canaryCreated: existsSync(canary) });

describe("SEC-E2E-04 · Azure deploy: Parse tenant config → Compute resource names", () => {
  it("control: a well-formed config flows through both steps", () => {
    const cfg = runStep(AZURE_DEPLOY, "Parse tenant config", { inputs: azureInputs() });
    const names = runStep(AZURE_DEPLOY, "Compute resource names", { inputs: azureInputs(), steps: { cfg: cfg.outputs } });
    const ok = cfg.exitCode === 0 && cfg.outputs.azure_region === "swedencentral" && names.outputs.image_uri === "chatbotalpha.azurecr.io/chatbot-backend:latest";
    record.control("Azure deploy with a well-formed config", {
      expected: "both steps succeed; outputs carry the config's values",
      actual: { cfg: summary(cfg), region: cfg.outputs.azure_region, imageUri: names.outputs.image_uri },
      allowed: ok,
    });
    expect(cfg.exitCode).toBe(0);
    expect(cfg.outputs).toMatchObject({ azure_subscription_id: config.azure_subscription_id, azure_region: "swedencentral" });
    expect(names.outputs.image_uri).toBe("chatbotalpha.azurecr.io/chatbot-backend:latest");
  });

  describe.each(["azure_region", "llm_model", "chatbot_version", "domain"])("a shell payload in config.%s", (field) => {
    it.each(codePayloads)("%s stays data", (_label, payload) => {
      const inputs = azureInputs({ ...config, [field]: payload });
      const cfg = runStep(AZURE_DEPLOY, "Parse tenant config", { inputs });
      const names = runStep(AZURE_DEPLOY, "Compute resource names", { inputs, steps: { cfg: cfg.outputs } });
      const intact = cfg.outputs[field] === payload;
      record.attack(`config.${field} = ${_label}`, {
        expected: "no command runs; the value reaches the output byte for byte",
        actual: { ...summary(cfg), valueIntact: intact, namesExit: names.exitCode },
        refused: !existsSync(canary) && intact,
      });
      expect(existsSync(canary)).toBe(false);
      expect(cfg.outputs[field]).toBe(payload);
      expect(cfg.outputs.azure_subscription_id).toBe(config.azure_subscription_id);
    });
  });

  // The integrity half: jq -r decodes \n, and each value is written as one
  // line of $GITHUB_OUTPUT, so a line break would add a line of its own.
  describe.each(["azure_region", "llm_model", "chatbot_version", "domain"])("a line break in config.%s", (field) => {
    it.each([
      ["a new line overriding the subscription", `x\nazure_subscription_id=99999999-9999-4999-8999-999999999999`],
      ["a carriage return", `x\razure_client_id=attacker`],
      ["a heredoc opener", `x\nazure_tenant_id<<EOF\nattacker\nEOF`],
    ])("with %s is refused before any output is written", (label, value) => {
      const cfg = runStep(AZURE_DEPLOY, "Parse tenant config", { inputs: azureInputs({ ...config, [field]: value }) });
      record.attack(`config.${field} carries ${label}`, {
        expected: "the step fails and writes no output",
        actual: { ...summary(cfg), subscription: cfg.outputs.azure_subscription_id ?? null },
        refused: cfg.exitCode !== 0 && cfg.outputLines.length === 0,
      });
      expect(cfg.exitCode).not.toBe(0);
      expect(cfg.outputLines).toEqual([]);
    });
  });

  it("the teardown's config parser refuses the same line break", () => {
    const cfg = runStep(AZURE_DESTROY, "Parse tenant config", {
      inputs: azureInputs({ ...config, azure_region: "x\nazure_subscription_id=99999999-9999-4999-8999-999999999999" }),
    });
    const control = runStep(AZURE_DESTROY, "Parse tenant config", { inputs: azureInputs() });
    record.attack("Azure teardown config with a line break", {
      expected: "fails, no output",
      actual: summary(cfg),
      refused: cfg.exitCode !== 0 && cfg.outputLines.length === 0,
    });
    record.control("Azure teardown with a well-formed config", {
      expected: "succeeds",
      actual: { ...summary(control), subscription: control.outputs.azure_subscription_id },
      allowed: control.exitCode === 0 && control.outputs.azure_subscription_id === config.azure_subscription_id,
    });
    expect(cfg.exitCode).not.toBe(0);
    expect(control.exitCode).toBe(0);
  });
});

describe("SEC-E2E-04 · AWS deploy: Replicate images to client ECR", () => {
  const run = (overrides: Record<string, string>) =>
    runStep(AWS_DEPLOY, "Replicate images to client ECR", { inputs: { ...awsInputs, ...overrides } });

  it("control: well-formed inputs tag and push the tenant's images", () => {
    const r = run({});
    const tags = r.calls.filter((c) => c[0] === "docker" && c[1] === "tag").map((c) => c[3]);
    record.control("AWS image replication with well-formed inputs", {
      expected: "succeeds; images tagged into the tenant's registry",
      actual: { ...summary(r), tags },
      allowed: r.exitCode === 0 && tags[0] === "111122223333.dkr.ecr.eu-central-1.amazonaws.com/alpha/chatbot:latest",
    });
    expect(r.exitCode).toBe(0);
    expect(r.outputs.uri).toBe("111122223333.dkr.ecr.eu-central-1.amazonaws.com/alpha/chatbot:latest");
  });

  describe.each(["chatbot_version", "tenant_slug", "your_ecr_image", "aws_region"])("a shell payload in %s", (input) => {
    it.each(codePayloads)("%s reaches docker and aws as one argument, never as code", (_label, payload) => {
      const r = run({ [input]: payload });
      const carried = r.calls.some((c) => c.some((arg) => arg.includes(payload)));
      record.attack(`${input} = ${_label}`, {
        expected: "no command runs; the payload is passed whole as an argument",
        actual: { ...summary(r), carriedAsArgument: carried },
        refused: !existsSync(canary) && carried,
      });
      expect(existsSync(canary)).toBe(false);
      expect(carried).toBe(true);
    });
  });

  it("an oversized value is passed whole, not truncated or split", () => {
    const big = `v${"9".repeat(30_000)}`;
    const r = run({ chatbot_version: big });
    const whole = r.outputs.uri?.endsWith(`:${big}`) ?? false;
    record.attack("chatbot_version of 30,001 characters", {
      expected: "no command runs; the value arrives intact",
      actual: { ...summary(r), intact: whole },
      refused: !existsSync(canary) && whole,
    });
    expect(whole).toBe(true);
  });
});

describe("SEC-E2E-04 · the line-break guard on every deploy and teardown", () => {
  const cases: [string, Record<string, string>][] = [
    [AWS_DEPLOY, awsInputs],
    [AWS_DESTROY, awsInputs],
    [AZURE_DEPLOY, azureInputs()],
    [AZURE_DESTROY, azureInputs()],
  ];

  it.each(cases)("%s refuses an input with a line break, and passes a clean one", (file, inputs) => {
    const attack = runStep(file, GUARD, { inputs: { ...inputs, tenant_slug: "alpha\nuri=attacker.example/backdoor:latest" } });
    const control = runStep(file, GUARD, { inputs });
    record.attack(`${path.basename(file)}: tenant_slug with a line break`, {
      expected: "the guard fails the run",
      actual: { exitCode: attack.exitCode },
      refused: attack.exitCode !== 0,
    });
    record.control(`${path.basename(file)}: clean inputs`, {
      expected: "the guard passes",
      actual: { exitCode: control.exitCode },
      allowed: control.exitCode === 0,
    });
    expect(attack.exitCode).not.toBe(0);
    expect(control.exitCode).toBe(0);
  });

  it.each(cases.map(([f]) => f))("%s runs the guard before any step writes $GITHUB_OUTPUT from an input", (file) => {
    const names = stepNames(file);
    const writers = allRunScripts()
      .filter((s) => file.endsWith(s.file) && /GITHUB_OUTPUT/.test(s.run) && /\$\{?(IN_|CONFIG_JSON|CHATBOT_VERSION)/.test(s.run))
      .map((s) => s.step);
    const guard = names.indexOf(GUARD);
    const first = Math.min(...writers.map((w) => names.indexOf(w)));
    record.attack(`${path.basename(file)}: an input reaches $GITHUB_OUTPUT before the guard`, {
      expected: "the guard comes first",
      actual: { guardAt: guard, firstWriterAt: first, writers },
      refused: guard >= 0 && guard < first,
    });
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(guard).toBeLessThan(first);
  });
});

describe("SEC-E2E-04 · no script is built from an input", () => {
  it("no run: script in any workflow pastes an input, a step output or the event payload", () => {
    const scripts = allRunScripts();
    const pasted = scripts.flatMap((s) => pastedExpressions(s.run).map((e) => `${s.file} › ${s.step}: ${e}`));
    record.attack("An input expanded into a script's source", {
      expected: "none, across every step of every workflow",
      actual: { stepsScanned: scripts.length, pasted },
      refused: pasted.length === 0,
    });
    expect(scripts.length).toBeGreaterThan(20);
    expect(pasted).toEqual([]);
  });
});
