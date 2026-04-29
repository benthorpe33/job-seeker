# job_seeker app/

Local React UI + Fastify backend that wraps the existing `job_seeker` pipeline.

This directory is **NOT** part of the upstream `santifer/career-ops` system layer — it is fully owned by Ben's fork. `update-system.mjs` only touches paths in its `SYSTEM_PATHS` allow-list (see `update-system.mjs:31-72`); `app/` is absent from that list and therefore never overwritten by `npm run update`.

## Layout

```
app/
  package.json     # npm workspaces root (server, web, shared)
  shared/          # API DTOs shared by server + web
  server/          # Fastify backend, binds 127.0.0.1:5174
  web/             # Vite + React + Tailwind, dev server on 127.0.0.1:5173
```

## Run locally

```bash
cd app
npm install
npm run dev
```

Open http://127.0.0.1:5173 in your browser. The Vite dev server proxies `/api` and `/sse` to the Fastify server on port 5174.

## Constraints (do not relax)

- **Loopback-only** — server binds to `127.0.0.1`. No auth because nothing reaches the box from outside.
- **Markdown/TSV are canonical** — `data/applications.md`, `reports/*.md`, `data/scan-history.tsv`, `data/pipeline.md` stay the source of truth. The SQLite index at `app/server/.data/index.db` is rebuilt from those files; never the source of truth.
- **No auto-submit** — the UI never submits applications. It drafts, you copy and paste.
