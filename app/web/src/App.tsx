import { Link, Outlet } from "react-router-dom";

import { JobLogPanel } from "./components/JobLogPanel";
import { useJobSubscriptions } from "./lib/jobSubscriptions";
import { useActiveJobsCount } from "./lib/jobs";

export default function App() {
  useJobSubscriptions();
  const activeJobsCount = useActiveJobsCount();

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200">
      <div className="mx-auto max-w-7xl px-6 py-6">
        <header className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold tracking-tight text-slate-100">
              <a href="/" className="hover:text-white">
                job_seeker
              </a>
            </h1>
            <p className="text-xs text-slate-500">Local UI · loopback only</p>
          </div>
          <div className="flex items-center gap-2">
            <Link
              to="/rejections"
              className="rounded-full border border-slate-700 px-3 py-1 text-xs text-slate-400 hover:bg-slate-800"
              title="Rejection patterns"
            >
              Rejections
            </Link>
            <Link
              to="/jobs"
              className={
                activeJobsCount > 0
                  ? "rounded-full border border-emerald-500/40 bg-emerald-500/10 px-3 py-1 text-xs text-emerald-300 hover:bg-emerald-500/20"
                  : "rounded-full border border-slate-700 px-3 py-1 text-xs text-slate-400 hover:bg-slate-800"
              }
              title={
                activeJobsCount > 0
                  ? `${activeJobsCount} active job${activeJobsCount === 1 ? "" : "s"}`
                  : "No active jobs"
              }
            >
              {activeJobsCount > 0
                ? `● ${activeJobsCount} ${activeJobsCount === 1 ? "job" : "jobs"} running`
                : "View jobs"}
            </Link>
          </div>
        </header>
        <Outlet />
      </div>
      <JobLogPanel />
    </div>
  );
}
