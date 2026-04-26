# Buena — Property Context Workbench

A local-first **file-native context compiler** for property management.

This repo ingests a raw property-management dataset (master data, invoices,
emails, bank statements, letters) and compiles a single, human-readable
`Context.md` per property. New files dropped into `incremental/` produce
section-level patches that you review and apply from a small Next.js UI.

There is no database. There is no chatbot. The dataset folder is never
modified — everything compiled goes to `out/`.

---

## TL;DR — get it running in 3 minutes

```bash
# 1. clone
git clone <this-repo> buena
cd buena/workbench

# 2. install
npm install

# 3. configure (optional — works without an API key)
cp .env.example .env.local
# then edit .env.local and add GOOGLE_API_KEY=... if you have one

# 4. run the UI
npm run dev
# open http://localhost:3000
```

In the UI:

1. Click **Build All** → produces `out/LIE-001/Context.md`.
2. Click **Process Incremental** → queues pending updates from `incremental/day-*`.
3. Click any pending card → bottom drawer shows source / extracted JSON / diff.
4. Click **apply** → the section is patched, recorded in `patch_history.jsonl`.

---

## Repository layout

```
buena/
├── stammdaten/        master data (CSV + JSON: owners, tenants, units, vendors)
├── rechnungen/        invoices (PDF), grouped by month
├── emails/            emails (.eml), grouped by month
├── bank/              bank statements (CSV + CAMT.053 XML)
├── briefe/            letters (PDF), grouped by month
├── incremental/       new files dropped over time (day-01 … day-10)
├── out/               COMPILED OUTPUT — one folder per property
│   └── LIE-001/
│       ├── Context.md
│       ├── state.json
│       ├── sources.jsonl
│       └── patch_history.jsonl
└── workbench/         the Next.js app (UI + ingest pipeline)
    ├── app/           App Router pages + API routes
    ├── components/    UI components
    ├── lib/           parsers, resolver, classifier, patcher, skills
    └── scripts/       CLI entrypoints (build-all, process-incremental)
```

`.workbench-cache/` and `.workbench-verdict-cache/` are local caches that can
be safely deleted at any time — they are regenerated on the next run.

---

## Prerequisites

| Tool       | Version  | Notes                                            |
| ---------- | -------- | ------------------------------------------------ |
| **Node**   | ≥ 18.17  | Required by Next.js 14. Recommended: Node 20 LTS |
| **npm**    | ≥ 9      | Ships with Node                                  |
| **Disk**   | ~500 MB  | Mostly the input dataset (`emails/`, `briefe/`)  |
| **OS**     | macOS / Linux / Windows | Tested on macOS 14 + Ubuntu 22.04 |

Optional:

- **Google AI Studio API key** — only used to classify ambiguous emails and
  free-text letters. Without it, the pipeline falls back to deterministic
  rules and still works end-to-end.
- **Gradium API key** ([studio.gradium.ai](https://studio.gradium.ai/)) —
  enables the **voice search** mic button next to the search field. Click the
  mic, speak, click again to stop; the spoken query is transcribed by
  Gradium's streaming STT and pasted into the search input. The free tier
  (~4 hours of STT/month) is more than enough for a demo.

---

## Step-by-step setup

### 1. Install dependencies

```bash
cd workbench
npm install
```

This installs `next`, `react`, `openai` (used for Gemini-compatible calls),
`pdf-parse`, `mailparser`, `papaparse`, `fast-xml-parser`, plus dev tooling.

### 2. Configure environment

Copy the example env file and edit it:

```bash
cp .env.example .env.local
```

Open `workbench/.env.local`:

```bash
# Optional — enables AI classification for ambiguous text
GOOGLE_API_KEY=AIza...
GOOGLE_MODEL=gemini-2.0-flash

# Optional — enables the voice-search mic button (Gradium STT)
GRADIUM_API_KEY=

# Path overrides (auto-detected from ../ by default)
DATASET_ROOT=../
OUT_ROOT=../out
CACHE_ROOT=../.workbench-cache
```

You can leave the file empty — defaults work for this repo layout. The app
detects the dataset relative to the `workbench/` folder.

### 3. First build

From `workbench/`:

```bash
npm run build:all
```

This:
- scans `stammdaten/`, `rechnungen/`, `emails/`, `bank/`, `briefe/`
- composes `out/LIE-001/Context.md`
- writes `state.json`, `sources.jsonl`
- caches file checksums in `.workbench-cache/processed_manifest.json`

Expected runtime on a modern laptop: **~30–60 seconds** for the full dataset
(no API key) or **~2–5 minutes** with AI classification enabled.

### 4. Start the UI

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). You should see:

- A property list (one entry: `LIE-001`)
- The current `Context.md` rendered as Markdown
- An empty pending-updates panel

### 5. Process incremental updates

From the UI click **Process Incremental**, or from the CLI:

```bash
# preview only (writes to .workbench-cache/pending.json)
npm run process:incremental

# auto-apply non-sensitive, high-confidence updates
npm run process:incremental -- --auto
```

Each `incremental/day-NN/` batch represents one day of new files. Pending
items appear in the UI. Click **apply** on the cards you want committed —
each application is recorded with a unified diff in
`out/LIE-001/patch_history.jsonl`.

---

## Common tasks

### Reset everything

```bash
cd workbench
npm run clean         # removes ../out and ../.workbench-cache
npm run build:all     # rebuild from scratch
```

### Rebuild a single property after editing inputs

```bash
npm run build:all
```

The manifest skips files whose checksum hasn't changed, so subsequent
builds are fast.

### Inspect what was applied

```bash
cat out/LIE-001/patch_history.jsonl | jq .   # one JSON object per patch
```

Each entry contains the source file, classification, confidence,
`needs_review` flag, the section ID that changed, and the unified diff.

### Edit `Context.md` by hand

Edits inside `<!-- human-section:id=... -->` blocks are **never** overwritten
by the patcher. Anything inside `<!-- ctx-section:id=... -->` blocks may be
rewritten on the next patch — keep your manual notes inside the human
sections.

---

## How it works (one paragraph)

A scanner walks the dataset and produces typed records via parsers
(PDF/EML/XML/CSV). A resolver maps each record to one property using
deterministic rules (UUIDs > unit numbers > tenant matches > vendor matches).
A classifier decides whether the record is a `durable_fact`,
`operational_memory`, `temporary_note`, or `ignore`. A composer renders or
patches the relevant `ctx-section` block in `Context.md`. Patches that touch
money flow or legal status are flagged `needs_review` and never auto-apply.
Cached LLM verdicts and processed checksums make re-runs incremental.

For deeper detail (section markers, classification policy, patch model) see
[workbench/README.md](workbench/README.md).

---

## Troubleshooting

| Symptom                                              | Fix                                                                                  |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `Error: Cannot find module 'next'`                   | You forgot `npm install`. Run it inside `workbench/`.                                |
| Port 3000 already in use                             | `PORT=3001 npm run dev` or kill the other process.                                   |
| `out/` is empty after Build All                      | Check the dev console / terminal — usually a path issue. Confirm `DATASET_ROOT`.     |
| AI classification errors / 401                       | Your `GOOGLE_API_KEY` is invalid. Remove it — the deterministic fallback works.      |
| PDF parsing warnings (`pdf-parse: ...`)              | Harmless. Some PDFs have non-standard fonts; text extraction still succeeds.         |
| `Context.md` looks stale                             | Run `npm run clean && npm run build:all`.                                            |
| Pending updates panel is empty                       | Either no new checksums in `incremental/`, or all files already processed. Check `.workbench-cache/processed_manifest.json`. |
| Want to re-process a file                            | Delete its entry from `processed_manifest.json` (or the whole file) and re-run.       |

---

## Available npm scripts (in `workbench/`)

| Command                            | What it does                                                |
| ---------------------------------- | ----------------------------------------------------------- |
| `npm run dev`                      | Next.js dev server on port 3000                             |
| `npm run build`                    | Production build of the Next.js app                         |
| `npm run start`                    | Run the production build                                    |
| `npm run lint`                     | Next.js linter                                              |
| `npm run typecheck`                | `tsc --noEmit`                                              |
| `npm run build:all`                | CLI: compile all properties from the base dataset           |
| `npm run process:incremental`      | CLI: queue pending updates from `incremental/`              |
| `npm run process:incremental -- --auto` | Same, plus auto-apply safe updates                     |
| `npm run clean`                    | Delete `../out` and `../.workbench-cache`                   |

---

## Safety guarantees

- The dataset folders (`stammdaten/`, `rechnungen/`, `emails/`, `bank/`,
  `briefe/`, `incremental/`) are **never written to**.
- All output goes to `out/` and `.workbench-cache/`.
- `human-section` blocks in `Context.md` are protected — the patcher refuses
  to write if it would touch one.
- Sensitive changes (IBAN, ownership, lease termination, legal disputes) are
  forced to `needs_review = true` regardless of model confidence.

---

## Tool Used 

- Loveble 
- Deepmind
- Gradium

## License

Private submission — not for redistribution.
