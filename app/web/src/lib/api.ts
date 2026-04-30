import type {
  ApplicationPatchBody,
  ApplicationRow,
  ApplicationsListQuery,
  ApplicationsListResponse,
  JobStartResponse,
  ReportDetail,
} from "@job-seeker/shared";

async function jsonFetch<T>(input: string, init?: RequestInit): Promise<T> {
  const res = await fetch(input, init);
  if (!res.ok) {
    let body: unknown = undefined;
    try {
      body = await res.json();
    } catch {
      /* ignore */
    }
    const msg =
      body && typeof body === "object" && "error" in body
        ? String((body as { error: string }).error)
        : `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return (await res.json()) as T;
}

export type ApplicationsQueryArgs = Partial<ApplicationsListQuery>;

export function buildApplicationsUrl(args: ApplicationsQueryArgs): string {
  const params = new URLSearchParams();
  if (args.sort) params.set("sort", args.sort);
  if (args.dir) params.set("dir", args.dir);
  if (args.status && args.status.length > 0) params.set("status", args.status.join(","));
  if (args.q) params.set("q", args.q);
  const qs = params.toString();
  return qs.length > 0 ? `/api/applications?${qs}` : `/api/applications`;
}

export async function listApplications(
  args: ApplicationsQueryArgs,
): Promise<ApplicationsListResponse> {
  return jsonFetch<ApplicationsListResponse>(buildApplicationsUrl(args));
}

export async function patchApplication(
  id: number,
  body: ApplicationPatchBody,
): Promise<ApplicationRow> {
  return jsonFetch<ApplicationRow>(`/api/applications/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function getReport(id: string): Promise<ReportDetail> {
  return jsonFetch<ReportDetail>(`/api/reports/${encodeURIComponent(id)}`);
}

export async function startScanJob(): Promise<JobStartResponse> {
  return jsonFetch<JobStartResponse>(`/api/jobs/scan/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ args: [] }),
  });
}

export async function startGenerateCvJob(reportId: string): Promise<JobStartResponse> {
  return jsonFetch<JobStartResponse>(`/api/jobs/generate-cv/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reportId }),
  });
}

export async function cancelJob(jobId: string): Promise<void> {
  await fetch(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, { method: "POST" });
}
