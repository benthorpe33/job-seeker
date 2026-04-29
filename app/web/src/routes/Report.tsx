import { useEffect, useMemo } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeHighlight from "rehype-highlight";

import type { ApplicationRow, IndexBusEvent, ReportDetail } from "@job-seeker/shared";

import { getReport } from "../lib/api";
import { useSSE } from "../lib/sse";
import { ScoreBadge } from "../components/ScoreBadge";
import { StatusMenu } from "../components/StatusMenu";

const BLOCK_LABELS: Record<string, string> = {
  A: "Role Summary",
  B: "CV Match",
  C: "Compensation",
  D: "Deep Research",
  E: "Personalization",
  F: "Interview Plan",
  G: "Posting Legitimacy",
};

function DisabledButton({ label, hint }: { label: string; hint: string }) {
  return (
    <button
      type="button"
      disabled
      title={hint}
      className="cursor-not-allowed rounded border border-slate-800 bg-slate-900/50 px-3 py-1.5 text-left text-xs text-slate-500"
    >
      {label}
      <span className="ml-1 text-slate-600">· {hint}</span>
    </button>
  );
}

export function Report() {
  const { id = "" } = useParams<{ id: string }>();
  const qc = useQueryClient();

  const query = useQuery<ReportDetail>({
    queryKey: ["report", id],
    queryFn: () => getReport(id),
    refetchOnWindowFocus: false,
  });

  const num = query.data?.num ?? null;
  const appQuery = useQuery<ApplicationRow>({
    queryKey: ["application", num],
    queryFn: async () => {
      const res = await fetch(`/api/applications/${num}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as ApplicationRow;
    },
    enabled: num !== null && num > 0,
  });

  useSSE(
    "/sse/index",
    (ev) => {
      try {
        const data = JSON.parse(ev.data) as IndexBusEvent;
        if (data.kind === "reports" && data.id === id) {
          void qc.invalidateQueries({ queryKey: ["report", id] });
        }
        if (data.kind === "applications") {
          void qc.invalidateQueries({ queryKey: ["application"] });
        }
      } catch {
        /* ignore */
      }
    },
    "index",
  );

  const tocEntries = useMemo(() => {
    if (!query.data) return [];
    const blocks = Object.keys(query.data.blocks).sort();
    return blocks.map((key) => ({
      key,
      label: BLOCK_LABELS[key] ?? key,
      anchor: `block-${key}`,
    }));
  }, [query.data]);

  // Scroll-spy helper: highlight TOC item for current section.
  useEffect(() => {
    if (!query.data) return;
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            const id = e.target.id;
            document.querySelectorAll("[data-toc-link]").forEach((el) => {
              el.classList.toggle(
                "text-sky-300",
                el.getAttribute("data-toc-link") === id,
              );
            });
          }
        }
      },
      { rootMargin: "-30% 0px -60% 0px" },
    );
    document.querySelectorAll("[data-block-anchor]").forEach((el) => obs.observe(el));
    return () => obs.disconnect();
  }, [query.data]);

  if (query.isLoading) {
    return <p className="p-6 text-slate-400">Loading report…</p>;
  }
  if (query.isError) {
    return <p className="p-6 text-rose-400">Error: {String(query.error)}</p>;
  }
  if (!query.data) return null;
  const r = query.data;

  return (
    <div className="grid grid-cols-[14rem_1fr_16rem] gap-6">
      <aside className="sticky top-4 self-start text-sm">
        <Link to="/" className="mb-3 inline-block text-xs text-slate-400 hover:text-slate-200">
          ← back to tracker
        </Link>
        <h2 className="mb-2 text-xs font-medium uppercase tracking-wider text-slate-500">
          Sections
        </h2>
        <nav className="flex flex-col gap-1">
          <a
            href="#header"
            data-toc-link="header"
            className="text-slate-300 hover:text-sky-300"
          >
            Header
          </a>
          {tocEntries.map((e) => (
            <a
              key={e.key}
              href={`#${e.anchor}`}
              data-toc-link={e.anchor}
              className="text-slate-300 hover:text-sky-300"
            >
              {e.key}) {e.label}
            </a>
          ))}
        </nav>
      </aside>

      <article className="min-w-0 max-w-none">
        <section id="header" className="mb-6 rounded-lg border border-slate-800 bg-slate-900/40 p-5">
          <h1 className="mb-3 text-xl font-semibold text-slate-100">
            #{r.num} · {r.slug}
          </h1>
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-slate-500">Date</dt>
            <dd className="font-mono text-slate-300">{r.date}</dd>
            <dt className="text-slate-500">Score</dt>
            <dd>
              <ScoreBadge score={r.header.score} />
            </dd>
            <dt className="text-slate-500">URL</dt>
            <dd>
              {r.header.url ? (
                <a
                  href={r.header.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="break-all text-sky-400 hover:underline"
                >
                  {r.header.url}
                </a>
              ) : (
                <span className="text-slate-600">—</span>
              )}
            </dd>
            <dt className="text-slate-500">Legitimacy</dt>
            <dd className="text-slate-300">{r.header.legitimacy ?? "—"}</dd>
            {r.header.verification && (
              <>
                <dt className="text-slate-500">Verification</dt>
                <dd className="text-slate-300">{r.header.verification}</dd>
              </>
            )}
          </dl>
        </section>

        {/* Inject anchor divs above each `## A) …` heading so the TOC can target them. */}
        <div className="markdown">
          {/* We render the full body markdown. To make `## A) Role Summary` etc. scrollable
              targets, ReactMarkdown with rehype-raw will leave the existing `## A)` headings
              intact; we add separate empty anchor spans synced to TOC ids using post-render. */}
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeRaw, rehypeHighlight]}
            components={{
              h2: ({ children, ...rest }) => {
                const text = String(
                  Array.isArray(children) ? children.join("") : children ?? "",
                );
                const m = text.match(/^([A-G])\)\s/);
                const id = m && m[1] ? `block-${m[1]}` : undefined;
                return (
                  <h2 {...rest} id={id} data-block-anchor={id ?? undefined}>
                    {children}
                  </h2>
                );
              },
            }}
          >
            {r.bodyMd}
          </ReactMarkdown>
        </div>
      </article>

      <aside className="sticky top-4 flex h-fit flex-col gap-4 self-start">
        <section className="rounded-lg border border-slate-800 bg-slate-900/40 p-4">
          <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-slate-500">
            Status
          </h3>
          <StatusMenu
            applicationId={r.num}
            currentStatus={appQuery.data?.status ?? ""}
            size="sm"
          />
        </section>
        <section className="rounded-lg border border-slate-800 bg-slate-900/40 p-4">
          <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-slate-500">
            Actions
          </h3>
          <div className="flex flex-col gap-2">
            <DisabledButton label="Generate CV" hint="Coming in T6" />
            {r.header.score !== null && r.header.score < 3.5 && (
              <DisabledButton label="Promote to full" hint="Coming in T7" />
            )}
            <DisabledButton label="Draft answers" hint="Coming in T9" />
          </div>
        </section>
      </aside>
    </div>
  );
}
