import type { DraftAnswer, ScrapedField } from "@job-seeker/shared";

import { DraftCard } from "./DraftCard";

type Props = {
  fields: ScrapedField[];
  drafts: Record<string, DraftAnswer>;
  regeneratingFieldId: string | null;
  streamingFieldId: string | null;
  onChangeAnswer: (fieldId: string, next: string) => void;
  onRegenerate: (fieldId: string) => void;
  onFocusField?: (fieldId: string | null) => void;
};

export function DraftsList({
  fields,
  drafts,
  regeneratingFieldId,
  streamingFieldId,
  onChangeAnswer,
  onRegenerate,
  onFocusField,
}: Props) {
  if (fields.length === 0) {
    return (
      <p className="rounded border border-slate-800 bg-slate-900/40 p-4 text-xs text-slate-500">
        Drafts appear here once a field list is loaded and "Draft all" runs.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      {fields.map((field) => {
        const draft = drafts[field.id] ?? null;
        return (
          <DraftCard
            key={field.id}
            field={field}
            draft={draft}
            regenerating={regeneratingFieldId === field.id}
            streaming={streamingFieldId === field.id}
            onChange={(v) => onChangeAnswer(field.id, v)}
            onRegenerate={() => onRegenerate(field.id)}
            onFocus={onFocusField ? () => onFocusField(field.id) : undefined}
            onBlur={onFocusField ? () => onFocusField(null) : undefined}
          />
        );
      })}
    </div>
  );
}
