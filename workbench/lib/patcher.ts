import fs from "node:fs";
import path from "node:path";
import { createTwoFilesPatch } from "diff";
import {
  preservesHumanSections,
  readSection,
  replaceSection,
} from "./context-schema";
import {
  humanRegionMentions,
  promoteUnmarkedEdits,
  readAiSnapshot,
  writeAiSnapshot,
} from "./human-edits";
import { ensureDir, propertyOutDir } from "./paths";
import { sha256 } from "./hash";
import type {
  ExtractedFact,
  PatchDecision,
  PatchRecord,
  SectionId,
} from "./types";

export interface ApplyResult {
  before: string;
  after: string;
  diff: string;
  record: PatchRecord;
}

// Fact-key marker embedded as an HTML comment so it survives markdown
// rendering without being visible to the human reader.
const FACT_KEY_RE = /<!--\s*fact-key:([^\s>]+)\s*-->/;
function factKeyComment(key: string): string {
  return `<!-- fact-key:${key} -->`;
}

/** Find an existing line carrying the same fact_key. */
function findFactLine(body: string, key: string): string | null {
  for (const line of body.split("\n")) {
    const m = line.match(FACT_KEY_RE);
    if (m && m[1] === key) return line;
  }
  return null;
}

function isContentEquivalent(oldLine: string, newLine: string): boolean {
  const norm = (s: string) =>
    s
      .replace(/<!--[^>]*-->/g, "")
      .replace(/_\(src:[^)]+\)_/g, "")
      .replace(/_\[\d{4}-\d{2}-\d{2}\]_/g, "")
      .replace(/_src:_\s*`[^`]+`/g, "")
      .replace(/~~|⚑/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  return norm(oldLine) === norm(newLine);
}

function basename(p: string): string {
  return p.split("/").pop() || p;
}

/** Render a single ExtractedFact as a clean Context.md bullet:
 *    - **Label:** value _(src: file.eml · 2026-04-25)_  <!-- fact-key:K -->
 */
function renderFactBullet(
  fact: ExtractedFact,
  decision: PatchDecision,
  stamp: string,
): string {
  const cite = decision.citations?.[0] ?? decision.source_id;
  const sensitive = decision.needs_review ? " ⚑" : "";
  const qualifier = fact.qualifier ? ` _(${fact.qualifier})_` : "";
  return `- **${fact.label}:** ${fact.value}${qualifier}${sensitive}  \n  _src: \`${basename(cite)}\` · ${stamp}_ ${factKeyComment(fact.key)}`;
}

/** Fallback when no structured facts are available — used only for
 *  operational_memory entries that genuinely belong as a free-form note. */
function renderSummaryBullet(decision: PatchDecision, stamp: string): string {
  const cite = decision.citations?.[0] ?? decision.source_id;
  const sensitive = decision.needs_review ? " ⚑" : "";
  const headline = decision.summary.replace(/\n+/g, " ").slice(0, 280);
  const keyComment = decision.fact_key
    ? ` ${factKeyComment(decision.fact_key)}`
    : "";
  return `- ${headline}${sensitive}  \n  _src: \`${basename(cite)}\` · ${stamp}_${keyComment}`;
}

interface SectionRenderResult {
  body: string;
  conflict: boolean;
  supersededLines: string[];
}

/** Build the new section body. If the decision carries `facts`, each fact is
 *  rendered (and supersedes prior versions of the same `fact.key`). Otherwise
 *  we fall back to a single summary bullet keyed by `decision.fact_key`. */
export function renderSectionAddition(
  current: string,
  decision: PatchDecision,
  section: SectionId,
): SectionRenderResult {
  const stamp = new Date().toISOString().slice(0, 10);
  const cur = current.includes("_(no information yet)_") ? "" : current;

  // Pull facts targeted at this section. If none, but the decision has a
  // single target section, treat *all* facts as belonging to it (legacy AI
  // payloads may not include section per-fact).
  const factsForSection = (decision.facts ?? []).filter(
    (f) => f.section === section ||
      ((decision.facts ?? []).every((x) => !x.section) && true),
  );

  let body = cur;
  let conflict = false;
  const supersededLines: string[] = [];

  const writeLine = (key: string | null, newLine: string) => {
    if (!key) {
      body = [body, newLine].filter(Boolean).join("\n");
      return;
    }
    const existing = findFactLine(body, key);
    if (!existing) {
      body = [body, newLine].filter(Boolean).join("\n");
      return;
    }
    if (isContentEquivalent(existing, newLine)) {
      // No-op — same fact, same value.
      return;
    }
    // Supersede: strike through the old line, append the new one.
    const supersededMarker = `~~${existing.replace(/^- /, "")}~~  \n  _superseded on [${stamp}]_`;
    body = body
      .split("\n")
      .map((l) => (l === existing ? supersededMarker : l))
      .join("\n");
    body = [body, newLine].filter(Boolean).join("\n");
    conflict = true;
    supersededLines.push(existing);
  };

  if (factsForSection.length > 0) {
    for (const fact of factsForSection) {
      writeLine(fact.key, renderFactBullet(fact, decision, stamp));
    }
  } else {
    writeLine(decision.fact_key ?? null, renderSummaryBullet(decision, stamp));
  }

  return { body, conflict, supersededLines };
}

function renderConflictNote(
  decision: PatchDecision,
  superseded: string | null,
): string {
  const stamp = new Date().toISOString().slice(0, 10);
  const cite = decision.citations?.[0] ?? decision.source_id;
  const supersededClean = superseded
    ? superseded
        .replace(/<!--[^>]*-->/g, "")
        .replace(/^-\s*/, "")
        .trim()
    : "(prior version)";
  return [
    `- _[${stamp}]_ **Fact updated** — ${decision.summary}`,
    `  - **was:** ${supersededClean}`,
    `  - **now:** ${decision.summary} _(src: \`${basename(cite)}\`)_`,
  ].join("\n");
}

export function applyPatch(opts: {
  propertyId: string;
  contextMdPath: string;
  decision: PatchDecision;
}): ApplyResult {
  const onDisk = fs.existsSync(opts.contextMdPath)
    ? fs.readFileSync(opts.contextMdPath, "utf8")
    : "";

  // Step 1 — protect unmarked human edits. If the user touched Context.md
  // directly in their text editor since the last AI write, promote those
  // diffs into @human blocks BEFORE we apply the new patch. The AI snapshot
  // is the diff baseline.
  const snapshot = readAiSnapshot(opts.contextMdPath);
  const promoted = promoteUnmarkedEdits(onDisk, snapshot, "auto-detected");
  const before = promoted.md;

  // Step 2 — fuzzy conflict probe: if the AI patch wants to write a fact
  // about something a human already noted, route it to needs_review instead
  // of overwriting silently. The needles are the AI's own summary words +
  // any fact values, lowercased.
  const probeNeedles: string[] = [
    ...(opts.decision.summary?.split(/\s+/) ?? []),
    ...(opts.decision.facts ?? []).flatMap((f) => [f.label, String(f.value)]),
  ];
  const humanHit = humanRegionMentions(before, probeNeedles);

  let after = before;
  let conflict = false;
  let firstSuperseded: string | null = null;
  for (const section of opts.decision.target_sections) {
    const current = readSection(after, section) ?? "";
    const r = renderSectionAddition(current, opts.decision, section);
    if (r.conflict) {
      conflict = true;
      if (!firstSuperseded && r.supersededLines.length) {
        firstSuperseded = r.supersededLines[0];
      }
    }
    after = replaceSection(after, section, r.body);
  }

  // If the AI patch effectively re-asserts a fact already inside a @human
  // block, we still write the new section body (the AI's evidence is real
  // — e.g. an updated bank statement) but flag a conflict so the human
  // reviews the divergence rather than getting silently overwritten.
  if (humanHit.hit) {
    conflict = true;
    if (!firstSuperseded && humanHit.matchedRegion) {
      firstSuperseded = `[manual note] ${humanHit.matchedRegion.inner.slice(0, 200)}`;
    }
  }

  if (conflict) {
    const cur = readSection(after, "conflicts_and_needs_review") ?? "";
    const note = renderConflictNote(opts.decision, firstSuperseded);
    const merged = [
      cur.includes("_(no information yet)_") ? "" : cur,
      note,
    ]
      .filter(Boolean)
      .join("\n");
    after = replaceSection(after, "conflicts_and_needs_review", merged);
  }

  if (!preservesHumanSections(before, after)) {
    throw new Error(
      "Patcher attempted to modify a human section — refusing to write.",
    );
  }

  const diff = createTwoFilesPatch(
    "Context.md (before)",
    "Context.md (after)",
    before,
    after,
    "",
    "",
    { context: 2 },
  );

  ensureDir(path.dirname(opts.contextMdPath));
  fs.writeFileSync(opts.contextMdPath, after);
  // Update the AI-write snapshot so the next patch can detect manual edits
  // made between now and then. This is the second half of the "surgical
  // updates" mechanism — see lib/human-edits.ts.
  writeAiSnapshot(opts.contextMdPath, after);

  const record: PatchRecord = {
    property_id: opts.propertyId,
    applied_at: new Date().toISOString(),
    source_id: opts.decision.source_id,
    target_sections: opts.decision.target_sections,
    before_hash: sha256(before),
    after_hash: sha256(after),
    diff,
    decision: opts.decision.decision,
    summary: opts.decision.summary,
    fact_key: opts.decision.fact_key ?? null,
    conflict,
  };
  appendPatchRecord(opts.propertyId, record);
  return { before, after, diff, record };
}

export function appendPatchRecord(propertyId: string, rec: PatchRecord) {
  const dir = propertyOutDir(propertyId);
  ensureDir(dir);
  fs.appendFileSync(
    path.join(dir, "patch_history.jsonl"),
    JSON.stringify(rec) + "\n",
  );
}

export function previewPatch(opts: {
  contextMdPath: string;
  decision: PatchDecision;
}): { before: string; after: string; diff: string; conflict: boolean } {
  const before = fs.existsSync(opts.contextMdPath)
    ? fs.readFileSync(opts.contextMdPath, "utf8")
    : "";
  let after = before;
  let conflict = false;
  let firstSuperseded: string | null = null;
  for (const section of opts.decision.target_sections) {
    const current = readSection(after, section) ?? "";
    const r = renderSectionAddition(current, opts.decision, section);
    if (r.conflict) {
      conflict = true;
      if (!firstSuperseded && r.supersededLines.length) {
        firstSuperseded = r.supersededLines[0];
      }
    }
    after = replaceSection(after, section, r.body);
  }
  if (conflict) {
    const cur = readSection(after, "conflicts_and_needs_review") ?? "";
    const note = renderConflictNote(opts.decision, firstSuperseded);
    const merged = [
      cur.includes("_(no information yet)_") ? "" : cur,
      note,
    ]
      .filter(Boolean)
      .join("\n");
    after = replaceSection(after, "conflicts_and_needs_review", merged);
  }
  const diff = createTwoFilesPatch(
    "Context.md (before)",
    "Context.md (after)",
    before,
    after,
    "",
    "",
    { context: 2 },
  );
  return { before, after, diff, conflict };
}

