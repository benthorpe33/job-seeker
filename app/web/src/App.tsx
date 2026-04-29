import { Outlet } from "react-router-dom";

import { JobLogPanel } from "./components/JobLogPanel";
import { useJobSubscriptions } from "./lib/jobSubscriptions";

export default function App() {
  useJobSubscriptions();

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
        </header>
        <Outlet />
      </div>
      <JobLogPanel />
    </div>
  );
}
