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
        No questions loaded yet. Run a scrape or paste the form to extract questions.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      {fields.map((field, idx) => {
        const draft = drafts[field.id] ?? null;
        return (
          <DraftCard
            key={field.id}
            field={field}
            draft={draft}
            ordinal={idx + 1}
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
