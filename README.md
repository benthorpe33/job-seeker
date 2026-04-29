# job-seeker

A personal AI job-search agent built on top of [santifer/career-ops](https://github.com/santifer/career-ops).

This repo is the working tree of one person's customization layer — the original
career-ops system underneath does the heavy lifting (portal scanning, offer
evaluation, CV generation, batch processing, application tracking). The files
in this repo that describe *whose* search this is (CV, profile, archetypes,
target companies, scoring weights, task-tracker state) are gitignored so anyone
can clone this repo and configure it for their own search.

## Attribution

The full system — the multi-agent pipeline, the scoring rubric, the report
templates, the CV-rendering scripts, the dashboard — is the work of
[santifer](https://santifer.io). The upstream lives at
**https://github.com/santifer/career-ops** and is MIT-licensed. Read the
upstream README there for the complete feature tour, philosophy, and changelog.

This fork tracks `santifer/career-ops` as the `upstream` git remote and pulls
updates with `node update-system.mjs apply`. Customizations are kept in
user-layer files (see [`DATA_CONTRACT.md`](DATA_CONTRACT.md)) so upstream
updates don't clobber them.

## Quick start (for someone cloning this fork)

1. **Clone and install:**
   ```bash
   git clone git@github.com:benthorpe33/job-seeker.git
   cd job-seeker
   npm install
   ```

2. **Copy the example configs and fill them in:**
   ```bash
   cp config/profile.example.yml config/profile.yml        # name, links, comp
   cp templates/portals.example.yml portals.yml            # ATS targets
   cp modes/_profile.template.md modes/_profile.md         # archetypes, scoring
   cp interview-prep/story-bank.example.md \
      interview-prep/story-bank.md                         # STAR+R bank
   # Then write your own:
   #   cv.md                — single-source-of-truth CV in markdown
   #   article-digest.md    — proof points the evaluator can cite
   ```

   `CLAUDE.md` (the agent's system rules) is already committed and works out of
   the box. To layer your own preferences on top — profile, hard rules,
   archetype priorities, target compensation, location policy, drafting tone —
   create a `CLAUDE.local.md` in the repo root. It's gitignored, and the
   committed `CLAUDE.md` ends with `@CLAUDE.local.md` so your overrides load
   automatically when the file exists.

3. **Initialize task tracking (optional, recommended):**
   ```bash
   bd init                 # https://github.com/steveyegge/beads
   ```

4. **Use it.** Open the repo in Claude Code (or another supported AI CLI — see
   upstream README) and try:
   - `/career-ops scan` — pull fresh job postings from the portals you listed
   - `/career-ops oferta` — evaluate a JD URL
   - `/career-ops pdf` — render a tailored CV PDF for a specific role
   - `/career-ops batch` — evaluate many roles in parallel

## What's gitignored

So this repo can be safely shared, the following are excluded from version
control. Each user maintains their own local copy:

- **Identity / portfolio:** `CLAUDE.local.md`, `cv.md`, `article-digest.md`,
  `config/profile.yml`, `modes/_profile.md`, `portals.yml`,
  `interview-prep/story-bank.md`
- **Search state:** `data/applications.md`, `data/pipeline.md`,
  `data/scan-history.tsv`, `data/outcomes.tsv`, `data/linkedin-*`,
  `reports/*.md`, `output/*`, `jds/*`, `batch/jd-*`, `batch/*-board.json`,
  `batch/batch-{input,state}.tsv*`
- **Task tracker:** `.beads/issues.jsonl`, `.beads/metadata.json`
- **Local tooling:** `.claude/settings.local.json`, `.vscode/`, `.env`,
  `node_modules/`

See [`.gitignore`](.gitignore) for the full list.

## Repo layout

| Path | What it is | User-editable? |
|------|------------|----------------|
| `*.mjs` (root) | Pipeline scripts (scan, evaluate, generate PDF, etc.) | No — system layer |
| `modes/` | Skill-mode prompts the AI agent loads | `_profile.md` only |
| `templates/` | CV templates (HTML + LaTeX), state schema | No |
| `dashboard/` | Optional Go-based TUI dashboard | No |
| `batch/` | Batch evaluation harness | Prompt + scripts only |
| `CLAUDE.local.md`, `cv.md`, `article-digest.md`, `config/profile.yml`, `portals.yml`, `modes/_profile.md` | **Your** identity and search config | Yes — gitignored |
| `data/` | Pipeline inbox + application tracker | Yes — gitignored |
| `reports/` | Evaluation outputs (`{###}-{slug}-{date}.md`) | Generated |
| `output/` | Tailored CV PDFs | Generated |
| `interview-prep/` | Per-company prep + your story bank | Yes — gitignored |

## License

MIT, matching the upstream `santifer/career-ops` license.
