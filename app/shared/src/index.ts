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
  // Tracker application num for the row whose report_path points at this
  // report. May differ from `num` (which is the report-file number) — e.g.
  // application #111 can link to report #154. Null if no tracker row links here.
  applicationNum: number | null;
};

export type JobKind =
  | "scan"
  | "batch"
  | "linkedin-saved-jobs"
  | "resolve-ats-urls"
  | "append-to-pipeline"
  | "linkedin-build-input"
  | "filter-batch-input"
  | "prefetch-jds"
  | "merge-tracker"
  | "verify-pipeline"
  | "pdf"
  | "generate-cv"
  | "full-report"
  | "liveness"
  | "draft-answers"
  | "profile-diff-draft";

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
  finishedAt: string | null;
  durationMs: number | null;
  status: JobStatus;
  exitCode: number | null;
  signal: string | null;
};

export type JobsFilterStatus = "active" | "completed" | "all";

export type CancelAllResponse = {
  requested: number;
  jobIds: string[];
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

export type JobLogResponse = {
  jobId: string;
  kind: JobKind;
  status: JobStatus;
  exitCode: number | null;
  ringSize: number;
  ringTruncated: boolean;
  events: JobLogEvent[];
};

export type PersistedJob = {
  jobId: string;
  kind: JobKind;
  startedAt: string;
  startedAtMs: number;
  finishedAtMs: number | null;
  status: JobStatus;
  exitCode: number | null;
  signal: string | null;
  nextLineId: number;
  ring: JobLogEvent[];
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

export type PipelineStageStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "skipped";

export type PipelineStage = {
  stageNum: number;
  name: string;
  kind: JobKind | null;
  status: PipelineStageStatus;
  jobId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  errorMessage: string | null;
};

export type PipelineRecord = {
  pipelineId: string;
  startedAt: string;
  finishedAt: string | null;
  status: "running" | "completed" | "failed";
  failedAtStage: number | null;
  prefetchJds: boolean;
  stages: PipelineStage[];
};

export type PipelineStartRequest = {
  prefetchJds?: boolean;
};

export type PipelineStartResponse = {
  pipelineId: string;
  startedAt: string;
  stages: PipelineStage[];
};

export type PipelineEvent =
  | { type: "stage:start"; stage: PipelineStage }
  | { type: "stage:done"; stage: PipelineStage }
  | { type: "pipeline:done"; pipeline: PipelineRecord };

export type AtsKind = "greenhouse" | "ashby" | "lever" | "workday" | "paste" | "unknown";

export type ScrapedField = {
  id: string;
  label: string;
  type: "text" | "textarea";
  required: boolean;
  maxLen?: number;
};

export type ScrapeResult = {
  ats: AtsKind;
  source: "api" | "dom" | "paste";
  fields: ScrapedField[];
  rawHtml?: string;
  message?: string;
  error?: string;
};

export type ScrapeRequest = {
  applyUrl: string;
};

export type ScrapeResponse = ScrapeResult;

export type PasteRequest = {
  html?: string;
  plainText?: string;
};

export type PasteResponse = ScrapeResult;

export type DraftAnswer = {
  fieldId: string;
  answer: string;
  charCount: number;
  warnings: string[];
};

export type DraftFile = {
  reportId: string;
  applyUrl: string | null;
  generatedAt: string;
  drafts: DraftAnswer[];
};

export type DraftRequest = {
  reportId: string;
  fields: ScrapedField[];
  applyUrl?: string;
};

export type DraftStartResponse = {
  jobId: string;
  kind: JobKind;
  startedAt: string;
};

// Custom SSE event types layered on top of /sse/jobs/:jobId. The transport
// continues to emit `line` events; the frontend can either parse `DRAFT:` /
// `DRAFT_ANSWERS_DONE:` / `DRAFT_ANSWERS_FAILED:` markers itself, or use the
// helpers in app/web/src/lib that produce these typed events.
export type DraftEvent =
  | { type: "draft"; draft: DraftAnswer }
  | { type: "draft:done"; count: number }
  | { type: "draft:failed"; reason: string };

// --- Rejection patterns + profile-diff drafter (T10 / js-70e) -------------

export type RejectionScoreBand = "3.5-3.9" | "4.0-4.4" | ">=4.5" | "unscored";

export type RejectionReasonCategory =
  | "seniority"
  | "comp"
  | "location"
  | "domain-fit"
  | "skills"
  | "culture"
  | "other";

export type RejectionPatternKeyword = { keyword: string; count: number };

export type RejectionPatternCompany = { company: string; count: number };

export type RejectionPatternCategory = {
  reasonCategory: RejectionReasonCategory;
  companies: RejectionPatternCompany[];
};

export type RejectionRecentReason = {
  ts: string;
  company: string;
  role: string;
  score: number | null;
  reason: string;
};

export type RejectionPatterns = {
  totalRejections: number;
  topReasonKeywords: RejectionPatternKeyword[];
  topCompaniesByReason: RejectionPatternCategory[];
  scoreBands: { band: RejectionScoreBand; count: number }[];
  recentReasons: RejectionRecentReason[];
  generatedAt: string;
};

export type ProfileDiffDraftStartResponse = {
  jobId: string;
  kind: JobKind;
  startedAt: string;
};

export type ProfileDiffResult = {
  diff: string;
  rationale: string;
  sections: string[];
};

export type ApplyProfileDiffRequest = { diff: string };

export type ApplyProfileDiffResponse = {
  ok: true;
  bytesWritten: number;
  sharedMtimeUnchanged: true;
};
