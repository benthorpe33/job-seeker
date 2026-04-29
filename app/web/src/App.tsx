import { useEffect, useState } from "react";
import type { HealthResponse } from "@job-seeker/shared";

type ProbeState =
  | { status: "loading" }
  | { status: "ok"; data: HealthResponse }
  | { status: "error"; message: string };

export default function App() {
  const [probe, setProbe] = useState<ProbeState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    fetch("/api/health")
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<HealthResponse>;
      })
      .then((data) => {
        if (!cancelled) setProbe({ status: "ok", data });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setProbe({
            status: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="min-h-screen p-8">
      <header className="mb-8">
        <h1 className="text-3xl font-semibold tracking-tight">job_seeker</h1>
        <p className="text-sm text-slate-400">
          Local UI for the career-ops pipeline. Loopback only.
        </p>
      </header>
      <section className="rounded-lg border border-slate-800 bg-slate-900/50 p-6">
        <h2 className="mb-3 text-lg font-medium">Server probe</h2>
        {probe.status === "loading" && (
          <p className="text-slate-400">Checking /api/health…</p>
        )}
        {probe.status === "ok" && (
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-slate-400">version</dt>
            <dd className="font-mono">{probe.data.version}</dd>
            <dt className="text-slate-400">repoRoot</dt>
            <dd className="font-mono">{probe.data.repoRoot}</dd>
            <dt className="text-slate-400">startedAt</dt>
            <dd className="font-mono">{probe.data.startedAt}</dd>
          </dl>
        )}
        {probe.status === "error" && (
          <p className="text-rose-400">
            Server unreachable: <span className="font-mono">{probe.message}</span>
          </p>
        )}
      </section>
    </div>
  );
}
