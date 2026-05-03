import type {
  ApplicationPatchBody,
  ApplicationRow,
  ApplicationsListQuery,
  ApplicationsListResponse,
  CancelAllResponse,
  DraftAnswer,
  DraftFile,
  DraftStartResponse,
  JobListResponse,
  JobLogResponse,
  JobsFilterStatus,
  JobStartResponse,
  PasteResponse,
  PipelineRecord,
  PipelineStartRequest,
  PipelineStartResponse,
  ReportDetail,
  ScrapedField,
  ScrapeResponse,
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

export async function startFullReportJob(reportId: string): Promise<JobStartResponse> {
  return jsonFetch<JobStartResponse>(`/api/jobs/full-report/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reportId }),
  });
}

export async function cancelJob(jobId: string): Promise<void> {
  await fetch(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, { method: "POST" });
}

export async function getJobLog(
  jobId: string,
  opts?: { tail?: number; stream?: "stdout" | "stderr" },
): Promise<JobLogResponse> {
  const params = new URLSearchParams();
  if (opts?.tail !== undefined) params.set("tail", String(opts.tail));
  if (opts?.stream) params.set("stream", opts.stream);
  const qs = params.toString();
  return jsonFetch<JobLogResponse>(
    `/api/jobs/${encodeURIComponent(jobId)}/log${qs ? `?${qs}` : ""}`,
  );
}

export async function listJobs(
  filter?: JobsFilterStatus,
): Promise<JobListResponse> {
  const qs = filter ? `?status=${encodeURIComponent(filter)}` : "";
  return jsonFetch<JobListResponse>(`/api/jobs${qs}`);
}

export async function cancelAllJobs(): Promise<CancelAllResponse> {
  return jsonFetch<CancelAllResponse>(`/api/jobs/cancel-all`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ confirm: true }),
  });
}

export async function startLinkedinPipeline(
  body: PipelineStartRequest,
): Promise<PipelineStartResponse> {
  return jsonFetch<PipelineStartResponse>(`/api/jobs/linkedin/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function resumeLinkedinPipeline(
  pipelineId: string,
  fromStage?: number,
): Promise<PipelineStartResponse> {
  return jsonFetch<PipelineStartResponse>(
    `/api/jobs/linkedin/${encodeURIComponent(pipelineId)}/resume`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fromStage !== undefined ? { fromStage } : {}),
    },
  );
}

export async function getLinkedinPipeline(pipelineId: string): Promise<PipelineRecord> {
  return jsonFetch<PipelineRecord>(
    `/api/jobs/linkedin/${encodeURIComponent(pipelineId)}`,
  );
}

export async function scanForm(applyUrl: string): Promise<ScrapeResponse> {
  return jsonFetch<ScrapeResponse>(`/api/scraper/scan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ applyUrl }),
  });
}

export async function pasteForm(input: {
  html?: string;
  plainText?: string;
}): Promise<PasteResponse> {
  return jsonFetch<PasteResponse>(`/api/scraper/paste`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function getDrafts(reportId: string): Promise<DraftFile | null> {
  const res = await fetch(`/api/scraper/drafts/${encodeURIComponent(reportId)}`);
  if (res.status === 404) return null;
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
  return (await res.json()) as DraftFile;
}

export async function patchDrafts(
  reportId: string,
  drafts: DraftAnswer[],
): Promise<DraftFile> {
  return jsonFetch<DraftFile>(
    `/api/scraper/drafts/${encodeURIComponent(reportId)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ drafts }),
    },
  );
}

export async function startDraftJob(args: {
  reportId: string;
  fields: ScrapedField[];
  applyUrl?: string | null;
}): Promise<DraftStartResponse> {
  const body: Record<string, unknown> = {
    reportId: args.reportId,
    fields: args.fields,
  };
  if (args.applyUrl) body.applyUrl = args.applyUrl;
  return jsonFetch<DraftStartResponse>(`/api/scraper/draft`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
