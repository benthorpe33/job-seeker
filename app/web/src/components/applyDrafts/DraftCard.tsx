import { useEffect, useRef, useState } from "react";

import type { DraftAnswer, ScrapedField } from "@job-seeker/shared";

type Props = {
  field: ScrapedField | null;
  draft: DraftAnswer | null;
  ordinal?: number;
  regenerating: boolean;
  streaming: boolean;
  onChange: (next: string) => void;
  onRegenerate: () => void;
  onFocus?: () => void;
  onBlur?: () => void;
};

const HARD_CHAR_CEILING = 2000;

function autosize(el: HTMLTextAreaElement | null) {
  if (!el) return;
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 480) + "px";
}

export function DraftCard({
  field,
  draft,
  ordinal,
  regenerating,
  streaming,
  onChange,
  onRegenerate,
  onFocus,
  onBlur,
}: Props) {
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const [copyLabel, setCopyLabel] = useState<"Copy" | "Copied!" | "Select & copy">(
    "Copy",
  );

  const value = draft?.answer ?? "";
  const charCount = draft?.charCount ?? value.length;
  const maxLen = field?.maxLen;
  const overSoftLimit = maxLen !== undefined && charCount > maxLen;
  const overHardCeiling = charCount > HARD_CHAR_CEILING;

  useEffect(() => {
    autosize(taRef.current);
  }, [value]);

  async function handleCopy() {
    const text = taRef.current?.value ?? value;
    try {
      await navigator.clipboard.writeText(text);
      setCopyLabel("Copied!");
      setTimeout(() => setCopyLabel("Copy"), 1500);
    } catch {
      const ta = taRef.current;
      if (ta) {
        ta.focus();
        ta.select();
      }
      setCopyLabel("Select & copy");
      setTimeout(() => setCopyLabel("Copy"), 2500);
    }
  }

  const placeholderLabel = field?.label ?? draft?.fieldId ?? "(unknown field)";

  return (
    <div
      data-field-id={draft?.fieldId ?? field?.id}
      className="rounded border border-slate-800 bg-slate-900/40 p-4"
    >
      <header className="mb-2 flex items-baseline justify-between gap-2">
        <h3 className="flex flex-wrap items-baseline gap-2 text-sm font-medium text-slate-200">
          {ordinal !== undefined && (
            <span className="font-mono text-[11px] text-slate-500">
              {String(ordinal).padStart(2, "0")}
            </span>
          )}
          <span>{placeholderLabel}</span>
          {field?.required && (
            <span className="rounded bg-rose-500/15 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-rose-300">
              required
            </span>
          )}
          {field?.type && (
            <span className="text-[11px] font-normal text-slate-500">
              {field.type}
            </span>
          )}
        </h3>
        <div className="flex items-center gap-2">
          {streaming && (
            <span className="rounded border border-sky-500/40 bg-sky-500/10 px-2 py-0.5 text-[10px] uppercase tracking-wide text-sky-300">
              streaming
            </span>
          )}
          {regenerating && !streaming && (
            <span className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] uppercase tracking-wide text-amber-300">
              {draft ? "regenerating" : "generating"}
            </span>
          )}
        </div>
      </header>

      {!draft ? (
        <p className="rounded bg-slate-950/40 px-3 py-2 text-xs italic text-slate-500">
          {regenerating ? "Generating…" : "Click Generate to draft an answer."}
        </p>
      ) : (
        <textarea
          ref={taRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onFocus={onFocus}
          onBlur={onBlur}
          rows={4}
          className="w-full resize-none rounded border border-slate-700 bg-slate-950 px-3 py-2 text-sm leading-relaxed text-slate-100 focus:border-sky-500 focus:outline-none"
        />
      )}

      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[11px]">
        <div
          className={
            overHardCeiling || overSoftLimit
              ? "text-rose-300"
              : "text-slate-500"
          }
        >
          {charCount.toLocaleString()} chars
          {maxLen !== undefined && ` / ${maxLen.toLocaleString()} max`}
          {overHardCeiling && " · over 2,000-char ceiling"}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void handleCopy()}
            disabled={!draft || streaming}
            className="rounded border border-slate-700 bg-slate-800/40 px-2 py-1 text-[11px] text-slate-200 hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {copyLabel}
          </button>
          <button
            type="button"
            onClick={onRegenerate}
            disabled={!field || regenerating || streaming}
            className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-200 hover:bg-amber-500/20 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {draft ? "Regenerate" : "Generate"}
          </button>
        </div>
      </div>

      {draft && draft.warnings.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {draft.warnings.map((w, i) => (
            <span
              key={i}
              className="rounded bg-amber-500/15 px-2 py-0.5 text-[10px] uppercase tracking-wide text-amber-300"
            >
              {w}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
