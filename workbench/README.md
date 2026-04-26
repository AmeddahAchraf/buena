# Property Context Workbench

A local-first **file-native context compiler** for property management. It reads
your raw dataset (`stammdaten/`, `rechnungen/`, `emails/`, `bank/`, `briefe/`,
`incremental/`), produces one `Context.md` per property, and surgically patches
only the affected sections of that file when new files arrive in `incremental/`.

This is **not** a chatbot and **not** a database app. It is a small control room
for keeping a long-lived, human-readable memory file per property up to date.

---

## What it does

1. **Build All** — parses the base dataset once and writes
   `out/<property_id>/Context.md` (+ `state.json`, `sources.jsonl`,
   `patch_history.jsonl`).
2. **Process Incremental** — for every new file in `incremental/`, resolves the
   property, classifies the update (`durable_fact` / `operational_memory` /
   `temporary_note` / `ignore`) and proposes a section-level patch.
3. **Search / Resolve** — by property UUID, tenant/owner/vendor UUID, unit
   number (`WE 04`), email, invoice number, or filename — all roads lead back to
   the property workbench page.
4. **Show current context** — renders `Context.md`, with toggle to raw markdown
   and grouped source references.
5. **Show pending updates** — every incremental patch is queued with full
   resolution metadata, classification reasoning, confidence and review flags.
6. **Show a diff** — bottom drawer with source preview, extracted JSON, and a
   colored before/after diff of the exact section change.

Manual edits in `<!-- human-section -->` blocks are **never** overwritten.

---

## Folder layout

```
buena/                       <- DATASET_ROOT (defaults to ../ from this folder)
├── stammdaten/              <- master data (json + csv)
├── rechnungen/              <- invoices (pdf)
├── emails/                  <- emails (eml)
├── bank/                    <- bank statements (csv, camt053 xml)
├── briefe/                  <- letters (pdf)
├── incremental/             <- new files dropped over time
└── workbench/               <- this app
    ├── app/                 <- Next.js App Router pages + API
    ├── components/          <- UI components
    ├── lib/                 <- parsers, resolver, classifier, patcher
    └── scripts/             <- CLI entrypoints
```

After a build:

```
out/<property_id>/
  Context.md            <- the compiled context
  state.json            <- compact metadata snapshot
  sources.jsonl         <- one line per source file used
  patch_history.jsonl   <- one line per applied patch (incl. unified diff)

.workbench-cache/
  processed_manifest.json   <- "have I seen this checksum before?"
  pending.json              <- pending updates awaiting review/apply
```

---

## Required env

Create `.env` in `workbench/` (copy from `.env.example`):

```bash
# Optional - if missing, the classifier falls back to deterministic rules
GOOGLE_API_KEY=ya29...
GOOGLE_MODEL=gemini-2.0-flash

# Optional overrides; defaults are auto-detected from ../
DATASET_ROOT=../
OUT_ROOT=../out
CACHE_ROOT=../.workbench-cache
```

The app works without an API key — AI is only used to classify ambiguous emails
and free-text letters. Everything else is deterministic.

---

## Run locally

```bash
cd workbench
npm install
cp .env.example .env       # then optionally add your GOOGLE_API_KEY

npm run dev                # http://localhost:3000
```

Inside the UI:

1. Click **Build All** — produces `out/LIE-001/Context.md`.
2. Click **Process Incremental** — generates pending updates from
   `incremental/day-*` files.
3. Click any pending card → opens the bottom drawer with source / JSON / diff.
4. Click **apply** — the patch is written, recorded to `patch_history.jsonl`.

### CLI

```bash
npm run build:all
npm run process:incremental             # preview only
npm run process:incremental -- --auto   # auto-apply non-sensitive, high-conf
```

### Other scripts

```bash
npm run dev          # Next.js dev server
npm run build        # next build
npm run start        # next start
npm run lint
npm run typecheck
```

---

## How the patching model works

Every `Context.md` has stable, machine-owned section markers:

```markdown
<!-- ctx-section:id=open_issues -->
## Open Issues
…content…
<!-- /ctx-section -->

<!-- human-section:id=human_notes -->
## Human Notes
…manual notes by you…
<!-- /human-section -->
```

The patcher:

1. resolves which property the new file belongs to,
2. classifies the meaningful update,
3. reads the **current** body of the affected `ctx-section` block,
4. renders a new body (default: append a dated bullet citing the source),
5. replaces **only that section** in the file,
6. verifies that no `human-section` block was touched (refuses otherwise),
7. writes a unified-diff record to `patch_history.jsonl`.

Sensitive content (IBAN changes, ownership changes, lease termination, legal
disputes) is automatically flagged `needs_review = true` regardless of model
confidence — those never auto-apply.

---

## Classification policy

| Decision             | When                                               | Stored in                |
| -------------------- | -------------------------------------------------- | ------------------------ |
| `durable_fact`       | Long-term truth (invoices, IBANs, ownership, etc.) | Permanent ctx sections   |
| `operational_memory` | Useful long-term reference, softer than fact       | recent_changes / vendors |
| `temporary_note`     | Active handling only (this week / today / etc.)    | open_issues, expires     |
| `ignore`             | Pleasantries, OOO, scheduling noise                | not stored               |

`needs_review` is forced on for: IBAN/payment detail changes, owner identity
changes, legal disputes, lease termination/move-in/-out. Everything that
changes money movement or legal rights waits for a human.

---

## Outputs

```
out/LIE-001/Context.md            <- the property's compiled context
out/LIE-001/state.json
out/LIE-001/sources.jsonl
out/LIE-001/patch_history.jsonl
.workbench-cache/processed_manifest.json
.workbench-cache/pending.json
```

The dataset folder is never modified. All writes go to `out/` and
`.workbench-cache/`.
