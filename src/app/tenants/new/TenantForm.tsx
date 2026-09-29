"use client";

import { useActionState, useCallback, useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { ArrowLeft, ArrowRight, Check, Loader2, Rocket } from "lucide-react";
import DeploymentProgress from "../[id]/DeploymentProgress";
import {
  checkDeploymentIdentity,
  checkSlugAvailable,
  createTenantAndDeploy,
  saveTenantDraft,
  type FormState,
  type IdentityField,
} from "./actions";
import {
  StepAiConfig,
  StepCloudConfig,
  StepPrerequisites,
  StepReview,
  type Values,
} from "./wizard/StepBodies";
import { useAvailability } from "./wizard/useAvailability";
import {
  FIELDS_BY_STEP,
  LAST_INPUT_STEP,
  REQUIRED_BY_CLOUD,
  REQUIRED_BY_STEP,
  STEPS,
  earliestStepForFields,
} from "./wizard/steps";
import { validateTenantValues } from "@/lib/tenantInput";
import type { GithubRepo } from "@/lib/azureFederation";

const DEFAULTS: Values = {
  cloudProvider: "aws",
  chatbotVersion: "latest",
  vectorStore: "pinecone",
  llmProvider: "openai",
};

export default function TenantForm({
  initialDraft,
  tenantId,
  githubRepo,
  platformAccountId,
  templateBaseUrl,
}: {
  initialDraft?: { id: string; step: number; data: Values };
  /** Freshly generated; a draft's own saved tenantId takes precedence. */
  tenantId: string;
  githubRepo: GithubRepo | null;
  platformAccountId: string | null;
  /** Where the customer bootstrap templates are published; null disables the one-click links. */
  templateBaseUrl: string | null;
}) {
  const [state, formAction, isPending] = useActionState<FormState, FormData>(
    createTenantAndDeploy,
    null,
  );
  const [values, setValues] = useState<Values>({
    ...DEFAULTS,
    tenantId,
    ...(initialDraft?.data ?? {}),
  });
  const [step, setStep] = useState(initialDraft?.step ?? 1);
  const [blocked, setBlocked] = useState<string[]>([]);
  const [draftId, setDraftId] = useState(initialDraft?.id ?? "");
  const [draftNote, setDraftNote] = useState<string | null>(null);
  const [savingDraft, startSavingDraft] = useTransition();

  // Caught here rather than by the server: a slug too long for the names AWS
  // builds from it, or a certificate from another region, otherwise fails
  // minutes into a workflow run, with infrastructure already created.
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const cloud = (values.cloudProvider ?? "aws") as "aws" | "azure";

  // Settled on step 2, before the customer runs any setup in their cloud: the
  // setup names resources after the slug, and a slug refused only at Deploy
  // meant running it all again under another.
  // The cloud decides which names the slug has to be free in, so it is asked
  // with the slug, and switching clouds asks again.
  const slug = (values.slug ?? "").trim();
  const askSlug = useCallback((value: string) => checkSlugAvailable(value, cloud), [cloud]);
  const slugCheck = useAvailability(slug, Boolean(validateTenantValues(values, ["slug"]).slug), askSlug, cloud);

  // Each chatbot's setup creates its own deployment identity, so one another
  // chatbot already used is always a leftover — usually offered by the
  // browser's history of the field — and would only fail at sign-in.
  const identityField: IdentityField = cloud === "azure" ? "azureClientId" : "deploymentRoleArn";
  const identity = (values[identityField] ?? "").trim();
  const askIdentity = useCallback((value: string) => checkDeploymentIdentity(identityField, value), [identityField]);
  const identityCheck = useAvailability(
    identity,
    Boolean(validateTenantValues(values, [identityField])[identityField]),
    askIdentity,
  );

  // Touched but not deployed: a reload or a closed tab starts a new wizard,
  // and with it a new chatbot ID — so a customer who had already run the
  // setup for this one would have to run it again.
  const [unsaved, setUnsaved] = useState(false);

  const errors: Record<string, string> = {
    ...fieldErrors,
    ...(slugCheck.reason ? { slug: slugCheck.reason } : {}),
    ...(identityCheck.reason ? { [identityField]: identityCheck.reason } : {}),
    ...(state?.errors ?? {}),
  };
  const rejectedOnSubmit = Object.keys(state?.errors ?? {}).length > 0;
  const deployed = state?.deployed;

  useEffect(() => {
    if (!unsaved || deployed) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [unsaved, deployed]);

  function set(key: string, value: string) {
    setUnsaved(true);
    setValues((v) => ({ ...v, [key]: value }));
    // Clearing as soon as the field is touched — leaving the marker up while
    // the user types reads as "still wrong" when it no longer is.
    setBlocked((b) => b.filter((f) => f !== key));
    setFieldErrors((e) => {
      if (!(key in e)) return e;
      const next = { ...e };
      delete next[key];
      return next;
    });
  }

  // A rejected submission must not leave the user staring at the review step
  // with an error attached to a field three steps back.
  const handledErrors = useRef<Record<string, string> | null>(null);
  useEffect(() => {
    if (!state?.errors || Object.keys(state.errors).length === 0) return;
    if (handledErrors.current === state.errors) return;
    handledErrors.current = state.errors;
    setStep(earliestStepForFields(Object.keys(state.errors)));
  }, [state]);

  // Derived, not stored: once a deployment exists the wizard is on step 5 by
  // definition, so there is no separate state to keep in sync (and nothing to
  // race with the error-routing effect above).
  const activeStep = deployed ? 5 : step;

  function missingFor(target: number): string[] {
    const required = [
      ...(REQUIRED_BY_STEP[target] ?? []),
      ...(target === 2 ? REQUIRED_BY_CLOUD[cloud] : []),
      ...(target === 3 && (values.vectorStore ?? "pinecone") === "pinecone"
        ? ["pineconeApiKey"]
        : []),
    ];
    return required.filter((f) => !(values[f] ?? "").trim());
  }

  /** What the shared schema objects to among one step's own fields. */
  function invalidFor(target: number): Record<string, string> {
    return validateTenantValues(values, FIELDS_BY_STEP[target] ?? []);
  }

  /**
   * Leaving step 2 needs the server's word that the slug and the deployment
   * identity are this chatbot's own, even if the checks while typing have not
   * answered yet.
   */
  async function step2Settled(): Promise<boolean> {
    return (await slugCheck.settle()) && (await identityCheck.settle());
  }

  async function goNext() {
    const missing = missingFor(step);
    if (missing.length > 0) {
      setBlocked(missing);
      return;
    }
    const invalid = invalidFor(step);
    if (Object.keys(invalid).length > 0) {
      setBlocked([]);
      setFieldErrors(invalid);
      return;
    }
    if (step === 2 && !(await step2Settled())) return;
    setBlocked([]);
    setFieldErrors({});
    setStep((s) => Math.min(s + 1, LAST_INPUT_STEP));
  }

  async function goToStep(target: number) {
    // Backwards is always allowed; forwards still has to pass the gate so the
    // stepper can't be used to skip a step's required fields.
    if (target < step) {
      setBlocked([]);
      setStep(target);
      return;
    }
    for (let s = step; s < target; s++) {
      const missing = missingFor(s);
      if (missing.length > 0) {
        setBlocked(missing);
        setStep(s);
        return;
      }
      const invalid = invalidFor(s);
      if (Object.keys(invalid).length > 0) {
        setBlocked([]);
        setFieldErrors(invalid);
        setStep(s);
        return;
      }
      if (s === 2 && !(await step2Settled())) {
        setStep(2);
        return;
      }
    }
    setBlocked([]);
    setFieldErrors({});
    setStep(target);
  }

  function onSaveDraft() {
    const fd = new FormData();
    for (const [k, v] of Object.entries(values)) fd.set(k, v);
    fd.set("step", String(step));
    if (draftId) fd.set("draftId", draftId);

    startSavingDraft(async () => {
      const result = await saveTenantDraft(null, fd);
      if (result && "draftId" in result) {
        setDraftId(result.draftId);
        setUnsaved(false);
        setDraftNote("Draft saved. API keys are never stored in a draft — re-enter them to deploy.");
      } else if (result && "error" in result) {
        setDraftNote(result.error);
      }
    });
  }

  const onReview = activeStep === LAST_INPUT_STEP;
  const showFooter = activeStep <= LAST_INPUT_STEP;

  // Deploy sits in the same footer position that Continue occupied on the
  // previous step, so a double-click on Continue advances to the review with
  // the first click and submits with the second, landing on a button that
  // appeared under the cursor. That provisions real infrastructure in the
  // customer's account and dispatches a workflow, which is not something a
  // stray click should be able to do.
  //
  // So the button exists as soon as the review renders, but does not accept a
  // click until it has outlived a double-click. Windows defaults to 500ms
  // between clicks, hence the margin. A deliberate press is never affected:
  // reading the review page takes far longer than this.
  // Disarmed on the way out rather than on the way in: leaving the review runs
  // the cleanup, so the button is never armed on arrival.
  const [deployArmed, setDeployArmed] = useState(false);
  useEffect(() => {
    if (activeStep !== LAST_INPUT_STEP) return;
    const timer = setTimeout(() => setDeployArmed(true), 600);
    return () => {
      clearTimeout(timer);
      setDeployArmed(false);
    };
  }, [activeStep]);

  return (
    <form
      action={formAction}
      // The last gate before real infrastructure: the review step can be
      // reached with a draft restored straight into it, so Continue's checks
      // may never have run over these values.
      onSubmit={(e) => {
        const invalid = validateTenantValues(values);
        if (Object.keys(invalid).length === 0) return;
        e.preventDefault();
        setFieldErrors(invalid);
        setStep(earliestStepForFields(Object.keys(invalid)));
      }}
      className="pb-10"
    >
      {/* The wizard renders one step at a time, so its inputs are controlled
          and unnamed; these hidden fields are what the submission actually
          carries. Rendering the whole map (rather than the current step's
          fields) is what makes a step-1 answer survive to submit. */}
      {Object.entries(values).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      {draftId && <input type="hidden" name="draftId" value={draftId} />}

      <Stepper
        current={activeStep}
        furthest={deployed ? 5 : LAST_INPUT_STEP}
        onJump={goToStep}
        locked={Boolean(deployed)}
      />

      <div className="mt-8">
        {activeStep === 1 && <StepPrerequisites values={values} set={set} errors={errors} />}
        {activeStep === 2 && (
          <StepCloudConfig
            values={values}
            set={set}
            errors={errors}
            githubRepo={githubRepo}
            platformAccountId={platformAccountId}
            templateBaseUrl={templateBaseUrl}
            slugStatus={slugCheck.status}
          />
        )}
        {activeStep === 3 && <StepAiConfig values={values} set={set} errors={errors} />}
        {activeStep === 4 && (
          <StepReview
            values={values}
            goToStep={goToStep}
            formError={errors._form ?? errors.tenantId}
            githubRepo={githubRepo}
          />
        )}
        {activeStep === 5 && deployed && (
          <DeployStep
            deploymentId={deployed.deploymentId}
            tenantId={deployed.tenantId}
            startedAt={deployed.startedAt}
          />
        )}
      </div>

      {blocked.length > 0 && (
        <p role="alert" className="mt-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          Fill in the required fields on this step before continuing:{" "}
          <span className="font-medium">{blocked.join(", ")}</span>
        </p>
      )}

      {Object.keys(errors).length > 0 && (
        <p role="alert" className="mt-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {rejectedOnSubmit
            ? "The deployment was not started — please correct the highlighted fields."
            : "Please correct the highlighted fields before continuing."}
        </p>
      )}

      {draftNote && (
        <p className="mt-5 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800">
          {draftNote}
        </p>
      )}

      {showFooter && (
        <div className="mt-8 flex items-center justify-between gap-4 border-t pt-6">
          <button
            type="button"
            onClick={() => setStep((s) => Math.max(1, s - 1))}
            disabled={activeStep === 1 || isPending}
            className="inline-flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <ArrowLeft className="h-4 w-4" /> Back
          </button>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onSaveDraft}
              disabled={savingDraft || isPending}
              className="rounded-lg border px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              {savingDraft ? "Saving…" : "Save Draft"}
            </button>

            {onReview ? (
              <button
                type="submit"
                disabled={isPending || !deployArmed}
                // Deliberately not dimmed while unarmed. The window is shorter
                // than it takes to aim at the button, so showing it disabled
                // would only produce a flicker on arrival at the review step.
                className={`inline-flex items-center gap-2 rounded-lg bg-blue-600 px-5 py-2 text-sm font-medium text-white hover:bg-blue-700 ${
                  isPending ? "opacity-60" : ""
                }`}
              >
                {isPending ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" /> Deploying…
                  </>
                ) : (
                  <>
                    Deploy Chatbot <Rocket className="h-4 w-4" />
                  </>
                )}
              </button>
            ) : (
              <button
                type="button"
                onClick={goNext}
                className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-5 py-2 text-sm font-medium text-white hover:bg-blue-700"
              >
                Continue <ArrowRight className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>
      )}
    </form>
  );
}

function Stepper({
  current,
  furthest,
  onJump,
  locked,
}: {
  current: number;
  furthest: number;
  onJump: (n: number) => void;
  locked: boolean;
}) {
  return (
    <ol className="flex flex-wrap items-center gap-y-3">
      {STEPS.map((s, i) => {
        const done = s.n < current;
        const active = s.n === current;
        return (
          <li key={s.n} className="flex flex-1 items-center gap-3">
            <button
              type="button"
              onClick={() => !locked && s.n <= furthest && onJump(s.n)}
              disabled={locked || s.n > furthest}
              className={`flex items-center gap-2.5 ${locked || s.n > furthest ? "cursor-default" : "cursor-pointer"}`}
            >
              <span
                className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold ${
                  done
                    ? "bg-blue-600 text-white"
                    : active
                      ? "bg-blue-600 text-white ring-4 ring-blue-100"
                      : "border bg-white text-gray-400"
                }`}
              >
                {done ? <Check className="h-4 w-4" strokeWidth={3} /> : s.n}
              </span>
              <span
                className={`whitespace-nowrap text-sm ${
                  active || done ? "font-medium text-blue-700" : "text-gray-500"
                }`}
              >
                {s.title}
              </span>
            </button>
            {i < STEPS.length - 1 && (
              <span className={`hidden h-px flex-1 sm:block ${done ? "bg-blue-300" : "bg-gray-200"}`} />
            )}
          </li>
        );
      })}
    </ol>
  );
}

function DeployStep({
  deploymentId,
  tenantId,
  startedAt,
}: {
  deploymentId: string;
  tenantId: string;
  startedAt: string;
}) {
  return (
    <div className="space-y-6">
      <DeploymentProgress
        deploymentId={deploymentId}
        startedAt={startedAt}
        initialRunUrl={null}
        // The wizard has nothing to refresh into: its step is client state, so
        // the tenant's own page is where a finished deployment belongs.
        finishedHref={`/tenants/${tenantId}`}
      />

      <div className="flex items-start gap-4 rounded-xl border border-blue-100 bg-blue-50/60 p-5">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-gray-900">
            Deployment may take several minutes.
          </h3>
          <p className="mt-1 text-sm leading-relaxed text-gray-600">
            Infrastructure is being provisioned and the chatbot deployed into the client-owned cloud
            environment. No client documents are transferred through the control plane during this
            process — the data stays in the client cloud environment. You can safely leave this page;
            progress continues and is visible on the chatbot&apos;s page.
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-end gap-3 border-t pt-6">
        <Link
          href="/activity"
          className="rounded-lg border px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
        >
          View in Activity
        </Link>
        <Link
          href={`/tenants/${tenantId}`}
          className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-5 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          Go to Chatbot <ArrowRight className="h-4 w-4" />
        </Link>
      </div>
    </div>
  );
}
