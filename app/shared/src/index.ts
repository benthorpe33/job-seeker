export type HealthResponse = {
  ok: true;
  version: string;
  repoRoot: string;
  startedAt: string;
};

export type ApplicationRow = {
  id: number;
  date: string;
  company: string;
  role: string;
  score: number | null;
  status: string;
  hasPdf: boolean;
  reportPath: string | null;
  notes: string;
};

export type ReportHeader = {
  url: string | null;
  score: number | null;
  legitimacy: string | null;
  verification: string | null;
};

export type ReportDetail = {
  id: string;
  num: number;
  slug: string;
  date: string;
  header: ReportHeader;
  blocks: Record<string, string>;
  bodyMd: string;
  filePath: string;
};

export type JobKind =
  | "scan"
  | "batch"
  | "linkedin-saved-jobs"
  | "linkedin-build-input"
  | "merge-tracker"
  | "verify-pipeline"
  | "pdf"
  | "full-report"
  | "liveness";

export type JobLogLine = {
  ts: string;
  stream: "stdout" | "stderr";
  line: string;
};

export type IndexStats = {
  applications: number;
  reports: number;
  scanHistory: number;
  pipelineEntries: number;
  durationMs: number;
};

export type JobStatus = "running" | "completed" | "failed" | "cancelled";

export type JobRecord = {
  jobId: string;
  kind: JobKind;
  startedAt: string;
  status: JobStatus;
  exitCode: number | null;
  signal: string | null;
};

export type JobLogEvent = JobLogLine & { id: number };

export type JobDoneEvent = {
  code: number | null;
  signal: string | null;
  status: JobStatus;
};

export type JobStartRequest = {
  args?: string[];
};

export type JobStartResponse = {
  jobId: string;
  kind: JobKind;
  startedAt: string;
};

export type JobListResponse = {
  jobs: JobRecord[];
};

export type ApplicationsListQuery = {
  sort: "score" | "date" | "company" | "role" | "num";
  dir: "asc" | "desc";
  status: string[];
  q: string;
};

export type ApplicationsListResponse = {
  rows: ApplicationRow[];
  total: number;
  query: ApplicationsListQuery;
};

export type IndexBusEvent = {
  kind:
    | "applications"
    | "reports"
    | "scan_history"
    | "pipeline"
    | "rejections";
  op: "upsert" | "delete";
  path: string;
  id?: string | number;
};

export type ApplicationPatchBody = {
  status?: string;
  notes?: string;
  rejection_reason?: string;
};

export type JobLogPanelEntry = {
  jobId: string;
  kind: JobKind;
  startedAt: string;
  status: JobStatus;
};
