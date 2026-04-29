import { useState } from "react";

import { useMutation, useQueryClient } from "@tanstack/react-query";

import type { ApplicationRow } from "@job-seeker/shared";

import { patchApplication } from "../lib/api";
import { RejectionReasonModal } from "./RejectionReasonModal";

type Props = {
  applicationId: number;
  currentStatus: string;
  size?: "sm" | "md";
};

type Action = {
  label: string;
  status: "Applied" | "Interview" | "Evaluated" | "Discarded";
  needsReason?: boolean;
  tone: string;
};

const ACTIONS: Action[] = [
  {
    label: "Applied",
    status: "Applied",
    tone: "border-blue-500/40 bg-blue-500/15 text-blue-200 hover:bg-blue-500/25",
  },
  {
    label: "In progress",
    status: "Interview",
    tone: "border-violet-500/40 bg-violet-500/15 text-violet-200 hover:bg-violet-500/25",
  },
  {
    label: "Not yet applied",
    status: "Evaluated",
    tone: "border-slate-600/40 bg-slate-600/15 text-slate-200 hover:bg-slate-600/25",
  },
  {
    label: "Not going to apply",
    status: "Discarded",
    needsReason: true,
    tone: "border-rose-500/40 bg-rose-500/15 text-rose-200 hover:bg-rose-500/25",
  },
];

export function StatusMenu({ applicationId, currentStatus, size = "md" }: Props) {
  const qc = useQueryClient();
  const [modalOpen, setModalOpen] = useState(false);
  const [pendingError, setPendingError] = useState<string | null>(null);

  const mutation = useMutation<ApplicationRow, Error, { status: string; reason?: string }>({
    mutationFn: async ({ status, reason }) => {
      return patchApplication(applicationId, {
        status,
        rejection_reason: reason,
      });
    },
    onMutate: async ({ status }) => {
      setPendingError(null);
      // Optimistic: update the applications list query data.
      const previous = qc.getQueriesData({ queryKey: ["applications"] });
      qc.setQueriesData<{ rows: ApplicationRow[]; total: number }>(
        { queryKey: ["applications"] },
        (old) => {
          if (!old) return old;
          return {
            ...old,
            rows: old.rows.map((r) =>
              r.id === applicationId ? { ...r, status } : r,
            ),
          };
        },
      );
      return { previous };
    },
    onError: (err, _vars, context) => {
      // Roll back.
      const ctx = context as { previous?: Array<[unknown, unknown]> } | undefined;
      if (ctx?.previous) {
        for (const [key, data] of ctx.previous) {
          qc.setQueryData(key as readonly unknown[], data);
        }
      }
      setPendingError(err.message);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["applications"] });
      void qc.invalidateQueries({ queryKey: ["application", applicationId] });
    },
  });

  function handleClick(action: Action) {
    if (action.needsReason) {
      setModalOpen(true);
      return;
    }
    mutation.mutate({ status: action.status });
  }

  async function handleReasonSubmit(reason: string) {
    await mutation.mutateAsync({ status: "Discarded", reason });
  }

  const padding = size === "sm" ? "px-2 py-0.5 text-xs" : "px-3 py-1 text-sm";

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {ACTIONS.map((a) => {
          const isCurrent =
            currentStatus === a.status ||
            (a.status === "Evaluated" && currentStatus === "SKIP");
          return (
            <button
              key={a.label}
              type="button"
              onClick={() => handleClick(a)}
              disabled={mutation.isPending}
              className={`rounded border ${padding} ${a.tone} disabled:opacity-50 ${
                isCurrent ? "ring-2 ring-offset-1 ring-offset-slate-950 ring-slate-500" : ""
              }`}
            >
              {a.label}
            </button>
          );
        })}
      </div>
      {pendingError && (
        <p className="text-xs text-rose-400">Error: {pendingError}</p>
      )}
      <RejectionReasonModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onSubmit={handleReasonSubmit}
      />
    </div>
  );
}
