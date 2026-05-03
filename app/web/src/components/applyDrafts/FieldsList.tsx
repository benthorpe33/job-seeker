import type { ScrapedField } from "@job-seeker/shared";

type Props = {
  fields: ScrapedField[];
  highlightFieldId?: string | null;
};

export function FieldsList({ fields, highlightFieldId }: Props) {
  if (fields.length === 0) {
    return (
      <p className="rounded border border-slate-800 bg-slate-900/40 p-4 text-xs text-slate-500">
        No fields yet. Run a scrape or paste the form to extract questions.
      </p>
    );
  }
  return (
    <ol className="flex flex-col gap-2">
      {fields.map((f, idx) => {
        const highlight = highlightFieldId === f.id;
        return (
          <li
            key={f.id}
            data-field-id={f.id}
            className={
              "rounded border bg-slate-900/40 p-3 text-sm transition-colors " +
              (highlight
                ? "border-sky-400/60 ring-1 ring-sky-400/40"
                : "border-slate-800")
            }
          >
            <div className="mb-1 flex items-baseline gap-2">
              <span className="font-mono text-[11px] text-slate-500">
                {String(idx + 1).padStart(2, "0")}
              </span>
              <span className="text-slate-200">{f.label}</span>
              {f.required && (
                <span className="rounded bg-rose-500/15 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-rose-300">
                  required
                </span>
              )}
            </div>
            <div className="flex flex-wrap gap-2 text-[11px] text-slate-500">
              <span>type: {f.type}</span>
              {f.maxLen !== undefined && <span>max: {f.maxLen} chars</span>}
              <span className="font-mono text-slate-600">id: {f.id}</span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
