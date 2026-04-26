import type { SectionId } from "./types";

export const SECTION_TITLES: Record<SectionId, string> = {
  identity: "Identity",
  units_and_occupants: "Units and Occupants",
  open_issues: "Open Issues",
  governance_and_owner_matters: "Governance / Owner Matters",
  vendors_and_service_references: "Vendors and Service References",
  finance_and_open_items: "Finance and Open Items",
  recent_changes: "Recent Changes",
  conflicts_and_needs_review: "Conflicts / Needs Review",
  source_index: "Source Index",
};

export const SECTION_ORDER: SectionId[] = [
  "identity",
  "units_and_occupants",
  "open_issues",
  "governance_and_owner_matters",
  "vendors_and_service_references",
  "finance_and_open_items",
  "recent_changes",
  "conflicts_and_needs_review",
  "source_index",
];

export const HUMAN_SECTION_ID = "human_notes";
export const HUMAN_SECTION_TITLE = "Human Notes";

// Build an empty document skeleton with all stable markers in place.
// The human section sits between conflicts and source_index by convention.
export function emptyContextDoc(propertyName: string): string {
  const lines: string[] = [];
  lines.push(`# Context: ${propertyName}`);
  lines.push("");
  for (const id of SECTION_ORDER) {
    if (id === "source_index") {
      lines.push(humanBlock(""));
      lines.push("");
    }
    lines.push(sectionBlock(id, ""));
    lines.push("");
  }
  return lines.join("\n");
}

export function sectionBlock(id: SectionId, body: string): string {
  const title = SECTION_TITLES[id];
  return [
    `<!-- ctx-section:id=${id} -->`,
    `## ${title}`,
    body.trim().length ? body.trim() : "_(no information yet)_",
    `<!-- /ctx-section -->`,
  ].join("\n");
}

export function humanBlock(body: string): string {
  return [
    `<!-- human-section:id=${HUMAN_SECTION_ID} -->`,
    `## ${HUMAN_SECTION_TITLE}`,
    body.trim().length
      ? body.trim()
      : "_Manual notes by the property manager. Never overwritten by the workbench._",
    `<!-- /human-section -->`,
  ].join("\n");
}

const SECTION_RE_CACHE = new Map<SectionId, RegExp>();
function sectionRe(id: SectionId): RegExp {
  if (!SECTION_RE_CACHE.has(id)) {
    SECTION_RE_CACHE.set(
      id,
      new RegExp(
        `<!--\\s*ctx-section:id=${id}\\s*-->[\\s\\S]*?<!--\\s*/ctx-section\\s*-->`,
        "m",
      ),
    );
  }
  return SECTION_RE_CACHE.get(id)!;
}

export function readSection(doc: string, id: SectionId): string | null {
  const m = doc.match(sectionRe(id));
  if (!m) return null;
  // strip markers and the H2 line
  return m[0]
    .replace(/^<!--\s*ctx-section:id=[^>]+-->\s*\n/, "")
    .replace(/\n\s*<!--\s*\/ctx-section\s*-->$/, "")
    .replace(/^##\s+[^\n]+\n?/, "")
    .trim();
}

export function replaceSection(
  doc: string,
  id: SectionId,
  newBody: string,
): string {
  const block = sectionBlock(id, newBody);
  if (sectionRe(id).test(doc)) {
    return doc.replace(sectionRe(id), block);
  }
  // append at end if not present
  return doc.trimEnd() + "\n\n" + block + "\n";
}

// Strict guard: never touch human-section blocks.
const HUMAN_RE =
  /<!--\s*human-section:id=[^>]+-->[\s\S]*?<!--\s*\/human-section\s*-->/g;

export function preservesHumanSections(before: string, after: string): boolean {
  const a = before.match(HUMAN_RE) ?? [];
  const b = after.match(HUMAN_RE) ?? [];
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
