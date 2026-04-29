import { useEffect, useRef } from "react";

import { useJobStore } from "./store";

const subscriptions: Map<string, EventSource> = new Map();

export function ensureJobSubscription(jobId: string): void {
  if (subscriptions.has(jobId)) return;
  const url = `/sse/jobs/${encodeURIComponent(jobId)}`;
  const es = new EventSource(url);
  subscriptions.set(jobId, es);

  es.addEventListener("line", (ev) => {
    try {
      const data = JSON.parse((ev as MessageEvent).data) as {
        id: number;
        ts: string;
        stream: "stdout" | "stderr";
        line: string;
      };
      useJobStore.getState().appendLine(jobId, data);
    } catch {
      /* ignore */
    }
  });
  es.addEventListener("done", (ev) => {
    try {
      const data = JSON.parse((ev as MessageEvent).data) as {
        code: number | null;
        signal: string | null;
        status: "running" | "completed" | "failed" | "cancelled";
      };
      useJobStore.getState().finishJob(jobId, data.status, data.code);
    } catch {
      /* ignore */
    }
    es.close();
    subscriptions.delete(jobId);
  });
  es.onerror = () => {
    // EventSource auto-reconnects unless server explicitly ends. Once the
    // job sends its `done` event we close above; if the connection drops
    // unexpectedly we let the browser retry.
  };
}

/**
 * Re-attaches subscriptions on mount for any jobs known to the store but
 * lacking a live EventSource. Used at the app shell level so a tab refresh
 * resumes streaming.
 */
export function useJobSubscriptions(): void {
  const activeJobs = useJobStore((s) => s.activeJobs);
  const seenRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const id of activeJobs.keys()) {
      if (seenRef.current.has(id)) continue;
      seenRef.current.add(id);
      ensureJobSubscription(id);
    }
  }, [activeJobs]);
}
