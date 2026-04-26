// Human-edit primitives — the mechanism that lets Context.md be "surgically
// updated without destroying human edits" (the challenge's exact phrase).
//
// Two complementary tracks:
//
//   1. HUMAN BLOCKS — explicit, in-file markers:
//        <!-- @human start 2026-04-26 ah -->
//        ...lines the property manager wrote...
//        <!-- @human end -->
//      The patcher treats these as immutable. AI patches flow around them.
//
//   2. AI SNAPSHOT — Context.md.ai-snapshot is written next to Context.md
//      after every AI patch. Before the next patch, we diff
//      (snapshot vs current) to detect human edits made *outside* the UI
//      (someone editing the file in their text editor). Detected diffs
//      are auto-promoted into @human blocks so they keep their protection.
//
// Together: the file is the source of truth, edits are visible in `git
// blame`, and the rule the patcher must obey is a single regex.

import fs from "node:fs";
import path from "node:path";

// Match a complete human block, including the open/close comments.
// The dotall `[\s\S]*?` is intentional — we want the *minimum* span so two
// adjacent blocks don't merge.
export const HUMAN_BLOCK_RE =
  /<!--\s*@human\s+start(?:\s+[^>]*)?-->[\s\S]*?<!--\s*@human\s+end\s*-->/g;

export interface HumanRegion {
  start: number; // char offset in source string
  end: number; // char offset, exclusive
  body: string; // the full block including markers
  inner: string; // contents between the start/end markers, trimmed
  meta: string; // anything after "start" before ">", e.g. "2026-04-26 ah"
}

/** Collect every human block in a markdown string. Order = file order. */
export function findHumanRegions(md: string): HumanRegion[] {
  const out: HumanRegion[] = [];
  for (const m of md.matchAll(HUMAN_BLOCK_RE)) {
    const start = m.index ?? 0;
    const block = m[0];
    const headerMatch = block.match(
      /<!--\s*@human\s+start(?:\s+([^>]*?))?\s*-->/,
    );
    const meta = (headerMatch?.[1] ?? "").trim();
    const inner = block
      .replace(/^<!--\s*@human\s+start[^>]*-->\s*/, "")
      .replace(/\s*<!--\s*@human\s+end\s*-->$/, "")
      .trim();
    out.push({ start, end: start + block.length, body: block, inner, meta });
  }
  return out;
}

/** True if `[start,end)` overlaps any human region. Used to refuse AI edits
 *  that would touch a protected region. */
export function rangeIntersectsHuman(
  md: string,
  start: number,
  end: number,
): boolean {
  for (const r of findHumanRegions(md)) {
    if (start < r.end && end > r.start) return true;
  }
  return false;
}

/** Wrap the given inner text as a fresh human block with today's date. */
export function wrapAsHumanBlock(
  inner: string,
  who: string = "manual",
): string {
  const date = new Date().toISOString().slice(0, 10);
  return [
    `<!-- @human start ${date} ${who} -->`,
    inner.trim(),
    `<!-- @human end -->`,
  ].join("\n");
}

/** Remove the human-block markers but keep the inner text. Used when the
 *  user explicitly converts a manual note back into AI-managed territory. */
export function unwrapHumanBlocks(md: string): string {
  return md.replace(HUMAN_BLOCK_RE, (block) => {
    return block
      .replace(/^<!--\s*@human\s+start[^>]*-->\s*/, "")
      .replace(/\s*<!--\s*@human\s+end\s*-->$/, "")
      .trim();
  });
}

// ---------- Snapshot mechanism ----------

/** Path of the AI-write snapshot for a given Context.md. */
export function snapshotPathFor(contextMdPath: string): string {
  const dir = path.dirname(contextMdPath);
  const base = path.basename(contextMdPath);
  return path.join(dir, `${base}.ai-snapshot`);
}

/** Persist the current AI-written state of Context.md. Call this immediately
 *  after a successful AI patch write. */
export function writeAiSnapshot(contextMdPath: string, content: string): void {
  fs.writeFileSync(snapshotPathFor(contextMdPath), content);
}

export function readAiSnapshot(contextMdPath: string): string | null {
  const p = snapshotPathFor(contextMdPath);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, "utf8");
}

/** Detect human edits made outside the UI (someone editing the .md file
 *  directly). Compares the current Context.md to the last AI snapshot — any
 *  line present in current but not in snapshot, AND not already inside a
 *  human block, is a candidate for promotion. Returns ranges of lines to
 *  wrap.
 *
 *  Implementation note: line-level diff is good enough — Context.md is a
 *  bullet list, and renaming/reordering a bullet is rare enough that false
 *  positives (over-protecting) are preferable to false negatives (losing a
 *  manual note to the next AI patch). */
export interface DetectedManualEdit {
  /** Line indices (0-based, inclusive) that look human-authored but are
   *  not yet inside a human block. */
  lineRanges: Array<{ startLine: number; endLine: number }>;
}

export function detectUnmarkedHumanEdits(
  current: string,
  snapshot: string | null,
): DetectedManualEdit {
  if (!snapshot) return { lineRanges: [] };
  const curLines = current.split("\n");
  const snapSet = new Set(snapshot.split("\n").map((l) => l.trim()));
  const protectedRanges = findHumanRegions(current).map((r) => {
    const before = current.slice(0, r.start);
    const startLine = before.split("\n").length - 1;
    const inner = current.slice(r.start, r.end);
    const endLine = startLine + inner.split("\n").length - 1;
    return { startLine, endLine };
  });
  function inProtected(i: number): boolean {
    return protectedRanges.some((p) => i >= p.startLine && i <= p.endLine);
  }

  // Walk lines, gather contiguous runs of "new and unprotected" lines.
  const ranges: Array<{ startLine: number; endLine: number }> = [];
  let runStart: number | null = null;
  for (let i = 0; i < curLines.length; i++) {
    const line = curLines[i];
    const trimmed = line.trim();
    const looksStructural =
      trimmed === "" ||
      trimmed.startsWith("<!--") ||
      trimmed.startsWith("#") ||
      trimmed.startsWith("---");
    const novel = !snapSet.has(trimmed) && trimmed.length > 0;
    if (novel && !inProtected(i) && !looksStructural) {
      if (runStart == null) runStart = i;
    } else {
      if (runStart != null) {
        ranges.push({ startLine: runStart, endLine: i - 1 });
        runStart = null;
      }
    }
  }
  if (runStart != null) {
    ranges.push({ startLine: runStart, endLine: curLines.length - 1 });
  }
  return { lineRanges: ranges };
}

/** Auto-promote unmarked human edits into @human blocks. Idempotent: running
 *  twice in a row is a no-op. Returns the new markdown plus how many ranges
 *  were wrapped. */
export function promoteUnmarkedEdits(
  current: string,
  snapshot: string | null,
  who = "manual",
): { md: string; promoted: number } {
  const { lineRanges } = detectUnmarkedHumanEdits(current, snapshot);
  if (lineRanges.length === 0) return { md: current, promoted: 0 };
  const lines = current.split("\n");
  // Walk ranges back-to-front so insertions don't shift later indices.
  const sorted = [...lineRanges].sort((a, b) => b.startLine - a.startLine);
  for (const r of sorted) {
    const slice = lines.slice(r.startLine, r.endLine + 1).join("\n");
    const wrapped = wrapAsHumanBlock(slice, who).split("\n");
    lines.splice(r.startLine, r.endLine - r.startLine + 1, ...wrapped);
  }
  return { md: lines.join("\n"), promoted: lineRanges.length };
}

// ---------- Conflict detection ----------

/** Lower-cased word set, used to test whether an AI patch's payload would
 *  effectively rewrite something already asserted by the human. We're not
 *  doing semantic similarity here — just "does the AI's value mention the
 *  same nouns the human already wrote about". The classifier produces a
 *  fact_key when it has structured facts; that's the precise signal. This
 *  function is the fuzzy fallback for free-form summary patches. */
export function humanRegionMentions(
  md: string,
  needles: string[],
): { hit: boolean; matchedRegion?: HumanRegion } {
  const tokens = needles
    .map((n) => n.toLowerCase().trim())
    .filter((n) => n.length >= 4);
  if (tokens.length === 0) return { hit: false };
  for (const r of findHumanRegions(md)) {
    const hay = r.inner.toLowerCase();
    if (tokens.some((t) => hay.includes(t))) {
      return { hit: true, matchedRegion: r };
    }
  }
  return { hit: false };
}
