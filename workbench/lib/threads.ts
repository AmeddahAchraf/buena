// Thread Collapser — emails arrive as threads of 4-12 messages, but the
// property's *durable* state changes only when the thread reaches a decision.
// Classifying every Re:/AW:/Fwd: independently produces ten near-duplicate
// patches per thread. The collapser groups by normalized subject + participants
// and elects one "primary" message (the most recent with content); the others
// become silent followups whose paths are attached as additional citations on
// the primary's patch.

import fs from "node:fs";
import path from "node:path";
import type { ScannedFile } from "./scanner";

export interface EmailMeta {
  file: ScannedFile;
  subject: string;
  normalizedSubject: string;
  participants: string; // sorted, lowercased emails joined
  date: number; // unix ms
  size: number;
}

export interface ThreadCluster {
  key: string;
  primary: ScannedFile;
  followups: ScannedFile[]; // older messages in the same thread
  // for telemetry
  subject: string;
  participantsCount: number;
}

const SUBJ_PREFIX_RE = /^\s*(?:re|aw|fwd|wg|fw|antw)\s*[:\.\-]\s*/i;
const PARTICIPANTS_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;

function normalizeSubject(s: string): string {
  let out = (s || "").trim();
  while (SUBJ_PREFIX_RE.test(out)) out = out.replace(SUBJ_PREFIX_RE, "");
  return out
    .replace(/\s+/g, " ")
    .replace(/^\[[^\]]*\]\s*/, "") // strip [Spam] / [Mailer]
    .toLowerCase()
    .trim();
}

function readEmailMeta(file: ScannedFile): EmailMeta | null {
  try {
    const raw = fs.readFileSync(file.abs, "utf8");
    const head = raw.slice(0, 4000);
    const subject =
      head.match(/^subject:\s*(.+)$/im)?.[1]?.trim() ||
      path.basename(file.abs);
    const dateLine = head.match(/^date:\s*(.+)$/im)?.[1]?.trim();
    const date = dateLine ? Date.parse(dateLine) : NaN;
    const participants = Array.from(head.matchAll(PARTICIPANTS_RE))
      .map((m) => m[0].toLowerCase())
      .filter((v, i, a) => a.indexOf(v) === i)
      .sort()
      .join(",");
    return {
      file,
      subject,
      normalizedSubject: normalizeSubject(subject),
      participants,
      date: Number.isFinite(date) ? date : fs.statSync(file.abs).mtimeMs,
      size: fs.statSync(file.abs).size,
    };
  } catch {
    return null;
  }
}

export interface CollapseResult {
  primaries: ScannedFile[]; // process these
  followupByPrimary: Map<string, ScannedFile[]>; // primary.abs -> [followup paths]
  clusters: ThreadCluster[];
  collapsedCount: number; // followups suppressed
}

// Returns a deduplicated set of files to actually process, plus mapping so the
// classifier can fold the followup citations into the primary's decision.
export function collapseEmailThreads(files: ScannedFile[]): CollapseResult {
  const emails = files.filter((f) => f.abs.toLowerCase().endsWith(".eml"));
  const others = files.filter((f) => !f.abs.toLowerCase().endsWith(".eml"));

  const metas: EmailMeta[] = [];
  for (const f of emails) {
    const m = readEmailMeta(f);
    if (m) metas.push(m);
    else others.push(f); // unreadable header → treat as plain file
  }

  const groups = new Map<string, EmailMeta[]>();
  for (const m of metas) {
    if (!m.normalizedSubject) {
      // no subject → its own group (won't collapse)
      groups.set(m.file.abs, [m]);
      continue;
    }
    // Cluster by normalized subject only. The previous key included the full
    // sorted participant list, but every Re:/AW: typically adds or drops a
    // Cc, so participant sets diverge between messages of the same thread —
    // making the strict key match never fire (we observed 0 threads collapsed
    // on a corpus of ~5k emails). Subject is the load-bearing thread signal;
    // overlap-by-participant is enforced as a sanity check below.
    const key = m.normalizedSubject;
    const arr = groups.get(key) ?? [];
    arr.push(m);
    groups.set(key, arr);
  }

  // Guard against false positives: subjects like "Rechnung" or "Angebot" can
  // collide across unrelated threads. Within a same-subject group, split into
  // sub-clusters where every member shares ≥1 participant with the cluster's
  // accumulated participant set. This means coincidentally-identical subjects
  // from disjoint sender pairs stay separate, while genuine threads (where
  // each message overlaps the prior set) merge.
  function splitByParticipantOverlap(arr: EmailMeta[]): EmailMeta[][] {
    if (arr.length <= 1) return [arr];
    const sorted = [...arr].sort((a, b) => a.date - b.date); // oldest first
    const clusters: { members: EmailMeta[]; participants: Set<string> }[] = [];
    for (const m of sorted) {
      const myParts = new Set(m.participants.split(",").filter(Boolean));
      let placed = false;
      for (const c of clusters) {
        let overlap = false;
        for (const p of myParts) {
          if (c.participants.has(p)) {
            overlap = true;
            break;
          }
        }
        if (overlap) {
          c.members.push(m);
          for (const p of myParts) c.participants.add(p);
          placed = true;
          break;
        }
      }
      if (!placed) clusters.push({ members: [m], participants: myParts });
    }
    return clusters.map((c) => c.members);
  }

  const splitGroups = new Map<string, EmailMeta[]>();
  let splitIdx = 0;
  for (const [key, arr] of groups.entries()) {
    const subClusters = splitByParticipantOverlap(arr);
    if (subClusters.length === 1) {
      splitGroups.set(key, subClusters[0]);
    } else {
      for (const sc of subClusters) {
        splitGroups.set(`${key}#${splitIdx++}`, sc);
      }
    }
  }

  const primaries: ScannedFile[] = [...others];
  const followupByPrimary = new Map<string, ScannedFile[]>();
  const clusters: ThreadCluster[] = [];
  let collapsed = 0;

  for (const [key, arr] of splitGroups.entries()) {
    arr.sort((a, b) => b.date - a.date); // newest first
    const primary = arr[0];
    const followups = arr.slice(1);
    primaries.push(primary.file);
    if (followups.length > 0) {
      followupByPrimary.set(
        primary.file.abs,
        followups.map((f) => f.file),
      );
      collapsed += followups.length;
    }
    clusters.push({
      key,
      primary: primary.file,
      followups: followups.map((f) => f.file),
      subject: primary.subject,
      participantsCount: primary.participants.split(",").filter(Boolean).length,
    });
  }

  return { primaries, followupByPrimary, clusters, collapsedCount: collapsed };
}
