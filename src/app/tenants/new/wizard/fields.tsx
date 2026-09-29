"use client";

import { useState, type ReactNode } from "react";
import { Check, Copy, Info } from "lucide-react";

/**
 * Presentational primitives for the onboarding wizard.
 *
 * Every input here is CONTROLLED. The wizard renders one step at a time, so
 * an uncontrolled input on a hidden step would lose its value the moment the
 * step unmounts; keeping the answers in the wizard's own state instead is
 * also what lets the Review step and "Save Draft" read them. The <form> is
 * submitted with hidden inputs mirroring that state — see TenantForm.
 *
 * Consequently none of these set `name` or `required`: native validation
 * cannot focus a control that isn't currently rendered, so gating is done by
 * the wizard's own per-step check and, authoritatively, by zod on the server.
 */

/**
 * A value the operator has to get into their cloud console verbatim — a trust
 * policy, a federated subject, a template parameter. Selectable as well as
 * copyable, because clipboard access can be refused and a value that can only
 * be copied by a button would then be unreachable.
 */
export function CopyableValue({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <div>
      <dt className="text-[11px] font-medium uppercase tracking-wide text-gray-500">{label}</dt>
      <dd className="mt-0.5 flex items-start gap-2">
        <code className="min-w-0 flex-1 select-all whitespace-pre-wrap break-all rounded bg-white px-2 py-1 font-mono text-[11px] text-gray-900">
          {value}
        </code>
        <button
          type="button"
          onClick={() => {
            navigator.clipboard
              .writeText(value)
              .then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              })
              .catch(() => {
                // Clipboard access can be refused; the value stays selectable.
              });
          }}
          aria-label={`Copy ${label.toLowerCase()}`}
          className="shrink-0 rounded border bg-white p-1 text-gray-500 hover:text-gray-900"
        >
          {copied ? <Check className="h-3.5 w-3.5 text-green-600" /> : <Copy className="h-3.5 w-3.5" />}
        </button>
      </dd>
    </div>
  );
}

export function InfoTip({ text }: { text: string }) {
  return (
    <span className="group relative inline-flex">
      <span
        tabIndex={0}
        role="img"
        aria-label={text}
        className="flex h-4 w-4 cursor-help items-center justify-center rounded-full border border-gray-300 text-[10px] font-semibold leading-none text-gray-400 hover:border-gray-400 hover:text-gray-600 focus:outline-none focus:ring-1 focus:ring-gray-400"
      >
        i
      </span>
      <span
        role="tooltip"
        className="pointer-events-none absolute left-1/2 top-6 z-20 w-64 -translate-x-1/2 rounded bg-gray-900 px-2 py-1.5 text-xs font-normal leading-snug text-white opacity-0 shadow-lg transition-opacity duration-100 group-hover:opacity-100 group-focus-within:opacity-100"
      >
        {text}
      </span>
    </span>
  );
}

/** A titled white panel — the wizard's main content container. */
export function Card({
  title,
  subtitle,
  icon,
  action,
  children,
  className = "",
}: {
  title: string;
  subtitle?: string;
  icon?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-xl border bg-white p-6 ${className}`}>
      <div className="mb-5 flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          {icon && (
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-blue-50 text-blue-600">
              {icon}
            </span>
          )}
          <div>
            <h2 className="text-base font-semibold text-gray-900">{title}</h2>
            {subtitle && <p className="mt-0.5 text-sm text-gray-500">{subtitle}</p>}
          </div>
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

/** Blue "secure by design" style callout. */
export function InfoBanner({
  title,
  children,
  badge,
  icon,
}: {
  title: string;
  children: ReactNode;
  badge?: string;
  icon?: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-blue-100 bg-blue-50/60 p-5">
      <div className="flex items-start gap-4">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-blue-100 text-blue-600">
          {icon ?? <Info className="h-5 w-5" />}
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
          <p className="mt-1 text-sm leading-relaxed text-gray-600">{children}</p>
        </div>
        {badge && (
          <span className="hidden shrink-0 items-center gap-1.5 rounded-lg bg-white px-3 py-1.5 text-xs font-medium text-blue-700 shadow-sm sm:inline-flex">
            {badge}
          </span>
        )}
      </div>
    </div>
  );
}

function labelRow(label: string, required?: boolean, tooltip?: string) {
  return (
    <span className="flex items-center gap-1 text-sm font-medium text-gray-800">
      {label}
      {required && <span className="text-red-500">*</span>}
      {tooltip && <InfoTip text={tooltip} />}
    </span>
  );
}

function hintOrError(hint?: string, error?: string) {
  if (error) return <span className="mt-1 block text-xs text-red-600">{error}</span>;
  if (hint) return <span className="mt-1 block text-xs text-gray-500">{hint}</span>;
  return null;
}

const inputBase =
  "mt-1 block w-full rounded-lg border px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100";

export function Field({
  label,
  value,
  onChange,
  placeholder,
  hint,
  error,
  tooltip,
  required,
  type = "text",
  inputMode,
  maxLength,
  autoComplete,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  hint?: string;
  error?: string;
  tooltip?: string;
  required?: boolean;
  type?: string;
  inputMode?: "numeric" | "decimal";
  maxLength?: number;
  /**
   * "off" for values that belong to one chatbot, such as its deployment
   * identity: the browser's history of earlier entries offers exactly the
   * value that is wrong here.
   */
  autoComplete?: "off";
}) {
  return (
    <label className="block">
      {labelRow(label, required, tooltip)}
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        inputMode={inputMode}
        maxLength={maxLength}
        // "off" is ignored by Chrome on password inputs — it deliberately
        // overrides it for password managers. "new-password" is the value
        // that actually suppresses autofill, which matters here because a
        // saved key filled into the wrong box silently would only fail
        // minutes into a deploy.
        autoComplete={type === "password" ? "new-password" : autoComplete}
        className={`${inputBase} ${error ? "border-red-400" : ""}`}
      />
      {hintOrError(hint, error)}
    </label>
  );
}

export function TextArea({
  label,
  value,
  onChange,
  placeholder,
  hint,
  error,
  rows = 3,
  maxLength,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  hint?: string;
  error?: string;
  rows?: number;
  maxLength?: number;
}) {
  return (
    <label className="block">
      {labelRow(label)}
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={rows}
        maxLength={maxLength}
        className={`${inputBase} resize-y ${error ? "border-red-400" : ""}`}
      />
      {hintOrError(hint, error)}
    </label>
  );
}

export function Select({
  label,
  value,
  onChange,
  options,
  hint,
  error,
  tooltip,
  required,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  hint?: string;
  error?: string;
  tooltip?: string;
  required?: boolean;
}) {
  return (
    <label className="block">
      {labelRow(label, required, tooltip)}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`${inputBase} bg-white ${error ? "border-red-400" : ""}`}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {hintOrError(hint, error)}
    </label>
  );
}

/**
 * A large selectable card (cloud provider, LLM provider, vector store).
 * Rendered as a real radio so arrow keys move between options and the choice
 * is announced, rather than a div with a click handler.
 */
export function ChoiceCard({
  name,
  checked,
  onSelect,
  logo,
  title,
  subtitle,
  badge,
  children,
}: {
  name: string;
  checked: boolean;
  onSelect: () => void;
  logo?: ReactNode;
  title: string;
  subtitle?: string;
  badge?: string;
  children?: ReactNode;
}) {
  return (
    <label
      className={`flex cursor-pointer flex-col rounded-xl border p-4 transition-colors ${
        checked ? "border-blue-500 bg-blue-50/40 ring-1 ring-blue-500" : "border-gray-200 hover:border-gray-300"
      }`}
    >
      <span className="flex items-start gap-3">
        <input
          type="radio"
          name={name}
          checked={checked}
          onChange={onSelect}
          className="mt-0.5 h-4 w-4 shrink-0 accent-blue-600"
        />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            {logo}
            <span className="text-sm font-semibold text-gray-900">{title}</span>
          </span>
          {subtitle && <span className="mt-0.5 block text-xs text-gray-500">{subtitle}</span>}
          {badge && (
            <span className="mt-2 inline-block rounded-md bg-blue-100 px-2 py-0.5 text-[11px] font-medium text-blue-700">
              {badge}
            </span>
          )}
          {children && <span className="mt-2 block text-xs text-gray-600">{children}</span>}
        </span>
      </span>
    </label>
  );
}

/** Numbered prerequisite / summary row. */
export function NumberedItem({
  n,
  title,
  children,
}: {
  n: number;
  title: string;
  children: ReactNode;
}) {
  return (
    <li className="flex gap-3">
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-gray-100 text-xs font-semibold text-gray-600">
        {n}
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium text-gray-900">{title}</span>
        <span className="mt-0.5 block text-xs text-gray-500">{children}</span>
      </span>
    </li>
  );
}

/** Green-check row used by the Review step's security summary. */
export function CheckItem({ title, children }: { title: string; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-green-100 text-green-600">
        <Check className="h-3 w-3" strokeWidth={3} />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium text-gray-900">{title}</span>
        <span className="mt-0.5 block text-xs text-gray-500">{children}</span>
      </span>
    </li>
  );
}

/** Label/value row for the Review step's summary cards. */
export function SummaryRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-4 py-1.5 text-sm">
      <dt className="w-40 shrink-0 text-gray-500">{label}</dt>
      <dd className="min-w-0 flex-1 break-words text-gray-900">{children}</dd>
    </div>
  );
}
