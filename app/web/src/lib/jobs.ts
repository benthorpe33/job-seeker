import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import type { JobListResponse } from "@job-seeker/shared";

import { listJobs } from "./api";

export function useActiveJobsCount(): number {
  const q = useQuery<JobListResponse>({
    queryKey: ["jobs", "active"],
    queryFn: () => listJobs("active"),
    refetchInterval: 5000,
    refetchIntervalInBackground: false,
    staleTime: 1_000,
  });
  return q.data?.jobs.length ?? 0;
}

export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function formatRelative(iso: string, nowMs: number): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const delta = nowMs - t;
  if (delta < 60_000) return "just now";
  const min = Math.floor(delta / 60_000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(t).toISOString().slice(0, 10);
}
