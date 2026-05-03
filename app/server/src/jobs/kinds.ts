import type { JobKind } from "@job-seeker/shared";

export type ResolvedCommand = {
  cmd: string;
  args: string[];
  needsBash: boolean;
};

type KindSpec = {
  needsBash: boolean;
  build: (userArgs: string[]) => { cmd: string; args: string[] };
  validate?: (userArgs: string[]) => string | null;
};

function rejectShellMetachars(args: string[]): string | null {
  for (const a of args) {
    if (typeof a !== "string") return "args must be strings";
    if (/[\r\n\0]/.test(a)) return "args must not contain newlines or null bytes";
  }
  return null;
}

const SPECS: Record<JobKind, KindSpec> = {
  scan: {
    needsBash: false,
    build: (userArgs) => ({ cmd: "node", args: ["scan.mjs", ...userArgs] }),
    validate: rejectShellMetachars,
  },
  batch: {
    needsBash: true,
    build: (userArgs) => ({
      cmd: "bash",
      args: ["batch/batch-runner.sh", ...userArgs],
    }),
    validate: rejectShellMetachars,
  },
  "linkedin-saved-jobs": {
    needsBash: false,
    build: (userArgs) => ({
      cmd: "node",
      args: ["scripts/linkedin-saved-jobs.mjs", ...userArgs],
    }),
    validate: rejectShellMetachars,
  },
  "resolve-ats-urls": {
    needsBash: false,
    build: (userArgs) => ({
      cmd: "node",
      args: ["scripts/resolve-ats-urls.mjs", ...userArgs],
    }),
    validate: rejectShellMetachars,
  },
  "append-to-pipeline": {
    needsBash: false,
    build: (userArgs) => ({
      cmd: "node",
      args: ["scripts/append-to-pipeline.mjs", ...userArgs],
    }),
    validate: rejectShellMetachars,
  },
  "linkedin-build-input": {
    needsBash: false,
    build: (userArgs) => ({
      cmd: "node",
      args: ["scripts/linkedin-build-batch-input.mjs", ...userArgs],
    }),
    validate: rejectShellMetachars,
  },
  "filter-batch-input": {
    needsBash: false,
    build: (userArgs) => ({
      cmd: "node",
      args: ["scripts/filter-batch-input.mjs", ...userArgs],
    }),
    validate: rejectShellMetachars,
  },
  "prefetch-jds": {
    needsBash: false,
    build: (userArgs) => ({
      cmd: "node",
      args: ["scripts/prefetch-jds.mjs", ...userArgs],
    }),
    validate: rejectShellMetachars,
  },
  "merge-tracker": {
    needsBash: false,
    build: () => ({ cmd: "node", args: ["merge-tracker.mjs"] }),
  },
  "verify-pipeline": {
    needsBash: false,
    build: () => ({ cmd: "node", args: ["verify-pipeline.mjs"] }),
  },
  pdf: {
    needsBash: false,
    build: (userArgs) => ({
      cmd: "node",
      args: ["generate-pdf.mjs", ...userArgs],
    }),
    validate: (userArgs) => {
      const err = rejectShellMetachars(userArgs);
      if (err) return err;
      // generate-pdf.mjs requires <input.html> <output.pdf> [--format=...]
      if (userArgs.length < 2) {
        return "pdf kind requires at least 2 args: <input.html> <output.pdf>";
      }
      return null;
    },
  },
  "full-report": {
    needsBash: true,
    build: (userArgs) => ({
      cmd: "bash",
      args: ["batch/run-full-report.sh", ...userArgs],
    }),
    validate: rejectShellMetachars,
  },
  "generate-cv": {
    needsBash: true,
    build: (userArgs) => ({
      cmd: "bash",
      args: ["batch/run-generate-cv.sh", ...userArgs],
    }),
    validate: (userArgs) => {
      const err = rejectShellMetachars(userArgs);
      if (err) return err;
      // run-generate-cv.sh requires <reportNum> <slug> <date> <url>
      if (userArgs.length < 4) {
        return "generate-cv kind requires 4 args: <reportNum> <slug> <date> <url>";
      }
      return null;
    },
  },
  liveness: {
    needsBash: false,
    build: (userArgs) => ({
      cmd: "node",
      args: ["check-liveness.mjs", ...userArgs],
    }),
    validate: rejectShellMetachars,
  },
  "draft-answers": {
    needsBash: true,
    build: (userArgs) => ({
      cmd: "bash",
      args: ["batch/run-draft-answers.sh", ...userArgs],
    }),
    validate: (userArgs) => {
      const err = rejectShellMetachars(userArgs);
      if (err) return err;
      // run-draft-answers.sh requires <report-num> <slug> <date> <fields-file>
      if (userArgs.length < 4) {
        return "draft-answers kind requires 4 args: <report-num> <slug> <date> <fields-file>";
      }
      return null;
    },
  },
  "profile-diff-draft": {
    needsBash: true,
    build: (userArgs) => ({
      cmd: "bash",
      args: ["batch/run-profile-diff.sh", ...userArgs],
    }),
    validate: (userArgs) => {
      const err = rejectShellMetachars(userArgs);
      if (err) return err;
      if (userArgs.length < 1) {
        return "profile-diff-draft kind requires 1 arg: <patterns-file>";
      }
      return null;
    },
  },
};

export function isJobKind(s: string): s is JobKind {
  return Object.prototype.hasOwnProperty.call(SPECS, s);
}

export function listJobKinds(): JobKind[] {
  return Object.keys(SPECS) as JobKind[];
}

export type ResolveError =
  | { ok: false; status: 400; message: string }
  | { ok: false; status: 503; message: string };

export function resolveKind(
  kind: JobKind,
  userArgs: string[],
  bashAvailable: boolean,
): ResolvedCommand | ResolveError {
  const spec = SPECS[kind];
  if (!spec) {
    return { ok: false, status: 400, message: `Unknown job kind: ${kind}` };
  }
  if (spec.validate) {
    const err = spec.validate(userArgs);
    if (err) return { ok: false, status: 400, message: err };
  }
  if (spec.needsBash && !bashAvailable) {
    return {
      ok: false,
      status: 503,
      message: `Job kind '${kind}' requires bash, but no bash binary was found on PATH at server startup.`,
    };
  }
  const built = spec.build(userArgs);
  return { cmd: built.cmd, args: built.args, needsBash: spec.needsBash };
}
