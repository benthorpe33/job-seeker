import { useEffect, useState } from "react";

type Props = {
  open: boolean;
  onClose: () => void;
  onSubmit: (reason: string) => Promise<void> | void;
};

const MIN_LEN = 10;

export function RejectionReasonModal({ open, onClose, onSubmit }: Props) {
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setReason("");
      setErr(null);
      setSubmitting(false);
    }
  }, [open]);

  if (!open) return null;

  const valid = reason.trim().length >= MIN_LEN;

  async function handleSubmit() {
    if (!valid) return;
    setSubmitting(true);
    setErr(null);
    try {
      await onSubmit(reason.trim());
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-lg border border-slate-700 bg-slate-900 p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-2 text-lg font-medium text-slate-100">
          Why are you skipping this role?
        </h2>
        <p className="mb-4 text-sm text-slate-400">
          The reason is logged to <code className="font-mono text-xs">data/rejection-feedback.tsv</code>{" "}
          and feeds future targeting analysis. Min {MIN_LEN} chars.
        </p>
        <textarea
          autoFocus
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={4}
          placeholder="e.g. Off-thesis: pure backend infra role, no AI/ML surface."
          className="mb-3 w-full resize-none rounded border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-slate-500"
        />
        {err && (
          <p className="mb-2 text-xs text-rose-400" role="alert">
            {err}
          </p>
        )}
        <div className="flex items-center justify-between text-xs text-slate-400">
          <span>
            {reason.trim().length}/{MIN_LEN}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded border border-slate-700 px-3 py-1.5 hover:bg-slate-800"
              disabled={submitting}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={!valid || submitting}
              className="rounded border border-rose-500/40 bg-rose-500/20 px-3 py-1.5 text-rose-200 hover:bg-rose-500/30 disabled:opacity-40"
            >
              {submitting ? "Saving…" : "Mark as not going to apply"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
