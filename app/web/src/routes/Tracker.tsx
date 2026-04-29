import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
} from "@tanstack/react-table";

import type {
  ApplicationRow,
  ApplicationsListResponse,
  IndexBusEvent,
} from "@job-seeker/shared";

import { listApplications, startScanJob } from "../lib/api";
import { useSSE } from "../lib/sse";
import { useJobStore } from "../lib/store";
import { ensureJobSubscription } from "../lib/jobSubscriptions";
import { ScoreBadge } from "../components/ScoreBadge";
import { StatusChip } from "../components/StatusChip";

const STATUS_OPTIONS = [
  "Evaluated",
  "Applied",
  "Interview",
  "Responded",
  "Offer",
  "Rejected",
  "Discarded",
  "SKIP",
];

function reportIdFromPath(p: string | null): string | null {
  if (!p) return null;
  const m = p.match(/reports\/(.+)\.md$/);
  return m && m[1] ? m[1] : null;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
}

export function Tracker() {
  const [params, setParams] = useSearchParams();
  const sort = params.get("sort") ?? "score";
  const dir = (params.get("dir") ?? "desc") as "asc" | "desc";
  const status = params.get("status") ?? "";
  const q = params.get("q") ?? "";

  const [qInput, setQInput] = useState(q);
  // Debounce search input → URL params.
  useEffect(() => {
    const t = setTimeout(() => {
      const next = new URLSearchParams(params);
      if (qInput.trim().length > 0) next.set("q", qInput.trim());
      else next.delete("q");
      if (next.toString() !== params.toString()) setParams(next, { replace: true });
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qInput]);

  const statusList = useMemo(
    () => status.split(",").map((s) => s.trim()).filter(Boolean),
    [status],
  );

  const qc = useQueryClient();
  const query = useQuery<ApplicationsListResponse>({
    queryKey: ["applications", { sort, dir, status, q }],
    queryFn: () =>
      listApplications({
        sort: sort as "score" | "date" | "company" | "role" | "num",
        dir,
        status: statusList,
        q,
      }),
    refetchOnWindowFocus: false,
    staleTime: 1_000,
  });

  // Listen to /sse/index for live updates.
  useSSE(
    "/sse/index",
    (ev) => {
      try {
        const data = JSON.parse(ev.data) as IndexBusEvent;
        if (data.kind === "applications" || data.kind === "scan_history") {
          void qc.invalidateQueries({ queryKey: ["applications"] });
        }
        if (data.kind === "reports") {
          void qc.invalidateQueries({ queryKey: ["report"] });
        }
      } catch {
        /* ignore non-json */
      }
    },
    "index",
  );

  const registerJob = useJobStore((s) => s.registerJob);

  function toggleStatus(s: string) {
    const cur = new Set(statusList);
    if (cur.has(s)) cur.delete(s);
    else cur.add(s);
    const next = new URLSearchParams(params);
    if (cur.size === 0) next.delete("status");
    else next.set("status", Array.from(cur).join(","));
    setParams(next, { replace: true });
  }

  function setSort(newSort: string) {
    const next = new URLSearchParams(params);
    if (newSort === sort) {
      next.set("dir", dir === "asc" ? "desc" : "asc");
    } else {
      next.set("sort", newSort);
      // Sensible defaults: numeric/date desc, text asc.
      next.set("dir", newSort === "company" || newSort === "role" ? "asc" : "desc");
    }
    setParams(next, { replace: true });
  }

  async function handleRunScan() {
    try {
      const res = await startScanJob();
      registerJob({ jobId: res.jobId, kind: res.kind, startedAt: res.startedAt });
      ensureJobSubscription(res.jobId);
    } catch (err) {
      alert(`Failed to start scan: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const columns = useMemo<ColumnDef<ApplicationRow>[]>(
    () => [
      {
        id: "id",
        accessorKey: "id",
        header: () => (
          <button onClick={() => setSort("num")} className="hover:underline">
            #{sort === "num" ? (dir === "asc" ? " ▲" : " ▼") : ""}
          </button>
        ),
        cell: (ctx) => (
          <span className="font-mono tabular-nums text-slate-400">{ctx.getValue<number>()}</span>
        ),
      },
      {
        id: "date",
        accessorKey: "date",
        header: () => (
          <button onClick={() => setSort("date")} className="hover:underline">
            Date{sort === "date" ? (dir === "asc" ? " ▲" : " ▼") : ""}
          </button>
        ),
        cell: (ctx) => <span className="font-mono text-xs text-slate-400">{ctx.getValue<string>()}</span>,
      },
      {
        id: "company",
        accessorKey: "company",
        header: () => (
          <button onClick={() => setSort("company")} className="hover:underline">
            Company{sort === "company" ? (dir === "asc" ? " ▲" : " ▼") : ""}
          </button>
        ),
        cell: (ctx) => {
          const v = ctx.getValue<string>();
          return (
            <span title={v} className="font-medium text-slate-100">
              {truncate(v, 24)}
            </span>
          );
        },
      },
      {
        id: "role",
        accessorKey: "role",
        header: () => (
          <button onClick={() => setSort("role")} className="hover:underline">
            Role{sort === "role" ? (dir === "asc" ? " ▲" : " ▼") : ""}
          </button>
        ),
        cell: (ctx) => {
          const v = ctx.getValue<string>();
          return (
            <span title={v} className="text-slate-300">
              {truncate(v, 60)}
            </span>
          );
        },
      },
      {
        id: "score",
        accessorKey: "score",
        header: () => (
          <button onClick={() => setSort("score")} className="hover:underline">
            Score{sort === "score" ? (dir === "asc" ? " ▲" : " ▼") : ""}
          </button>
        ),
        cell: (ctx) => <ScoreBadge score={ctx.getValue<number | null>()} />,
      },
      {
        id: "status",
        accessorKey: "status",
        header: "Status",
        cell: (ctx) => <StatusChip status={ctx.getValue<string>()} />,
      },
      {
        id: "pdf",
        accessorKey: "hasPdf",
        header: "PDF",
        cell: (ctx) => (
          <span>{ctx.getValue<boolean>() ? "✅" : "❌"}</span>
        ),
      },
      {
        id: "report",
        accessorKey: "reportPath",
        header: "Report",
        cell: (ctx) => {
          const id = reportIdFromPath(ctx.getValue<string | null>());
          if (!id) return <span className="text-slate-600">—</span>;
          return (
            <Link
              to={`/reports/${encodeURIComponent(id)}`}
              className="text-sky-400 hover:underline"
            >
              open →
            </Link>
          );
        },
      },
      {
        id: "notes",
        accessorKey: "notes",
        header: "Notes",
        cell: (ctx) => {
          const v = ctx.getValue<string>();
          return (
            <span title={v} className="text-xs text-slate-400">
              {truncate(v, 80)}
            </span>
          );
        },
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sort, dir],
  );

  const data = query.data?.rows ?? [];
  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
    manualSorting: true,
  });

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-100">Tracker</h1>
          <p className="text-xs text-slate-500">
            {query.data ? `${query.data.total} rows` : "loading…"}
          </p>
        </div>
        <button
          type="button"
          onClick={handleRunScan}
          className="rounded border border-emerald-500/40 bg-emerald-500/15 px-3 py-1.5 text-sm text-emerald-200 hover:bg-emerald-500/25"
        >
          Run scan
        </button>
      </header>

      <div className="sticky top-0 z-10 -mx-2 flex flex-wrap items-center gap-3 border-b border-slate-800 bg-slate-950/95 px-2 py-2 backdrop-blur">
        <input
          type="text"
          placeholder="Search company, role, or report body…"
          value={qInput}
          onChange={(e) => setQInput(e.target.value)}
          className="w-64 rounded border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-100 outline-none focus:border-slate-500"
        />
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          {STATUS_OPTIONS.map((s) => {
            const active = statusList.includes(s);
            return (
              <button
                key={s}
                type="button"
                onClick={() => toggleStatus(s)}
                className={`rounded border px-2 py-1 ${
                  active
                    ? "border-sky-500/40 bg-sky-500/15 text-sky-200"
                    : "border-slate-700 bg-slate-900 text-slate-400 hover:bg-slate-800"
                }`}
              >
                {s}
              </button>
            );
          })}
          {statusList.length > 0 && (
            <button
              type="button"
              onClick={() => {
                const next = new URLSearchParams(params);
                next.delete("status");
                setParams(next, { replace: true });
              }}
              className="rounded border border-slate-700 px-2 py-1 text-slate-500 hover:text-slate-300"
            >
              clear
            </button>
          )}
        </div>
      </div>

      {query.isLoading && <p className="text-slate-400">Loading…</p>}
      {query.isError && (
        <p className="text-rose-400">Error: {String(query.error)}</p>
      )}
      {query.data && (
        <div className="overflow-x-auto rounded border border-slate-800">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-slate-800 bg-slate-900/60 text-xs uppercase text-slate-400">
              {table.getHeaderGroups().map((hg) => (
                <tr key={hg.id}>
                  {hg.headers.map((h) => (
                    <th key={h.id} className="px-3 py-2 font-medium">
                      {h.isPlaceholder
                        ? null
                        : flexRender(h.column.columnDef.header, h.getContext())}
                    </th>
                  ))}
                </tr>
              ))}
            </thead>
            <tbody>
              {table.getRowModel().rows.map((row) => (
                <tr
                  key={row.id}
                  className="border-b border-slate-800/60 hover:bg-slate-900/40"
                >
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id} className="whitespace-nowrap px-3 py-2 align-middle">
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                </tr>
              ))}
              {table.getRowModel().rows.length === 0 && (
                <tr>
                  <td
                    colSpan={columns.length}
                    className="px-3 py-8 text-center text-slate-500"
                  >
                    No rows match.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
