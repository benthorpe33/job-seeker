import { useEffect, useState } from "react";

import type { ScrapeResult } from "@job-seeker/shared";

import { pasteForm, scanForm } from "../../lib/api";

type Props = {
  applyUrl: string | null;
  onResult: (result: ScrapeResult) => void;
};

type Mode = "idle" | "scanning" | "paste";
type PasteFormat = "html" | "plain";

export function ScrapePanel({ applyUrl, onResult }: Props) {
  const [mode, setMode] = useState<Mode>("idle");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [pasteFormat, setPasteFormat] = useState<PasteFormat>("plain");
  const [pasteText, setPasteText] = useState("");
  const [busy, setBusy] = useState(false);
  const [urlInput, setUrlInput] = useState(applyUrl ?? "");

  // Hydrate the input when the parent's applyUrl prop arrives later (the
  // report query resolves after this component first mounts).
  useEffect(() => {
    if (applyUrl && !urlInput) setUrlInput(applyUrl);
  }, [applyUrl, urlInput]);

  async function handleAutoScrape() {
    const trimmed = urlInput.trim();
    if (!trimmed) {
      setError("Apply URL is required to auto-scrape.");
      return;
    }
    setBusy(true);
    setMode("scanning");
    setError(null);
    setInfo(null);
    try {
      const result = await scanForm(trimmed);
      if (result.ats === "unknown" || result.fields.length === 0) {
        setInfo(
          result.message ||
            "ATS not auto-supported. Use 'Paste manually' to provide form HTML or text.",
        );
        setMode("paste");
      } else {
        onResult(result);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      setMode("idle");
    } finally {
      setBusy(false);
    }
  }

  async function handlePaste() {
    const txt = pasteText.trim();
    if (!txt) {
      setError("Paste content is empty.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const body =
        pasteFormat === "html" ? { html: pasteText } : { plainText: pasteText };
      const result = await pasteForm(body);
      if (result.fields.length === 0) {
        setInfo(
          result.message ||
            "No form fields could be extracted from the paste. Try the other format or copy more of the page.",
        );
      } else {
        onResult(result);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-lg border border-slate-800 bg-slate-900/40 p-5">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-slate-300">
        Scrape application form
      </h2>

      <div className="mb-4 flex flex-col gap-2">
        <label className="text-xs text-slate-400" htmlFor="apply-url">
          Apply URL
        </label>
        <input
          id="apply-url"
          type="url"
          value={urlInput}
          onChange={(e) => setUrlInput(e.target.value)}
          placeholder="https://boards.greenhouse.io/..."
          className="w-full rounded border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 focus:border-sky-500 focus:outline-none"
        />
      </div>

      <div className="mb-3 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => void handleAutoScrape()}
          className="rounded border border-sky-500/40 bg-sky-500/15 px-3 py-1.5 text-xs text-sky-200 hover:bg-sky-500/25 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy && mode === "scanning" ? "Scanning…" : "Auto-scrape"}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setMode("paste");
            setError(null);
          }}
          className="rounded border border-slate-700 bg-slate-800/40 px-3 py-1.5 text-xs text-slate-200 hover:bg-slate-700"
        >
          Paste manually
        </button>
      </div>

      {error && (
        <p className="mb-3 rounded border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
          {error}
        </p>
      )}
      {info && !error && (
        <p className="mb-3 rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          {info}
        </p>
      )}

      {mode === "paste" && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-3 text-xs text-slate-400">
            <span>Format:</span>
            <label className="flex items-center gap-1">
              <input
                type="radio"
                name="paste-format"
                checked={pasteFormat === "plain"}
                onChange={() => setPasteFormat("plain")}
              />
              Plain text
            </label>
            <label className="flex items-center gap-1">
              <input
                type="radio"
                name="paste-format"
                checked={pasteFormat === "html"}
                onChange={() => setPasteFormat("html")}
              />
              HTML
            </label>
          </div>
          <textarea
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            placeholder={
              pasteFormat === "html"
                ? "Paste copied page HTML here…"
                : "Paste application form text here (one question per paragraph)…"
            }
            className="min-h-[160px] w-full rounded border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-xs text-slate-200 focus:border-sky-500 focus:outline-none"
          />
          <div>
            <button
              type="button"
              disabled={busy}
              onClick={() => void handlePaste()}
              className="rounded border border-emerald-500/40 bg-emerald-500/15 px-3 py-1.5 text-xs text-emerald-200 hover:bg-emerald-500/25 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? "Extracting…" : "Extract fields"}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
