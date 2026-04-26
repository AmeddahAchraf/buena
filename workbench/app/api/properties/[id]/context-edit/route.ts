// POST /api/properties/[id]/context-edit
//
// Section-scoped human edit endpoint. The UI sends:
//   { section: SectionId, body: string, who?: string }
//
// We:
//   1. Read the property's current Context.md.
//   2. Wrap the new body in a fresh @human block (so it survives future AI
//      patches — see lib/human-edits.ts).
//   3. Use the schema-aware replaceSection() to write only that section.
//   4. Update the AI snapshot with the new content so the next AI patch's
//      manual-edit detector treats this as the new baseline.
//
// "Surgical updates without destroying human edits" is the load-bearing
// promise of the challenge — this is the user-facing surface of the
// machinery in lib/patcher.ts and lib/human-edits.ts.

import fs from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { replaceSection } from "@/lib/context-schema";
import { wrapAsHumanBlock, writeAiSnapshot } from "@/lib/human-edits";
import { propertyOutDir } from "@/lib/paths";
import type { SectionId } from "@/lib/types";

export const runtime = "nodejs";

const VALID_SECTIONS: SectionId[] = [
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

interface Body {
  section?: string;
  body?: string;
  who?: string;
  /** When true, the supplied body REPLACES the entire section. Otherwise it
   *  is APPENDED as a new @human block. Default: append. */
  replace?: boolean;
}

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const propertyId = params.id;
  const ctxPath = path.join(propertyOutDir(propertyId), "Context.md");
  if (!fs.existsSync(ctxPath)) {
    return NextResponse.json(
      { error: "Context.md not found — run build:all first." },
      { status: 404 },
    );
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const section = body.section as SectionId;
  if (!section || !(VALID_SECTIONS as string[]).includes(section)) {
    return NextResponse.json(
      { error: `invalid section: ${body.section}` },
      { status: 400 },
    );
  }
  const newBody = (body.body ?? "").trim();
  const who = (body.who ?? "manual").slice(0, 40);
  const replace = Boolean(body.replace);

  const before = fs.readFileSync(ctxPath, "utf8");
  // Build the new section body. Two modes:
  //   - replace: the user has rewritten the whole section, so we wrap their
  //     entire submission as one @human block.
  //   - append: the user added a note; we keep the existing section text
  //     (skeleton bullets + AI bullets) and append the new @human block.
  const wrapped = wrapAsHumanBlock(newBody, who);
  let newSection: string;
  if (replace || newBody.length === 0) {
    newSection = newBody.length === 0 ? "" : wrapped;
  } else {
    // Re-read the existing section body via a permissive regex (mirrors
    // readSection, but inline to avoid a circular import).
    const sectRe = new RegExp(
      `<!--\\s*ctx-section:id=${section}\\s*-->[\\s\\S]*?<!--\\s*/ctx-section\\s*-->`,
      "m",
    );
    const m = before.match(sectRe);
    const existingBody = m
      ? m[0]
          .replace(/^<!--\s*ctx-section:id=[^>]+-->\s*\n/, "")
          .replace(/\n\s*<!--\s*\/ctx-section\s*-->$/, "")
          .replace(/^##\s+[^\n]+\n?/, "")
          .replace(/_\(no information yet\)_/g, "")
          .trim()
      : "";
    newSection = [existingBody, wrapped].filter(Boolean).join("\n\n");
  }

  const after = replaceSection(before, section, newSection);
  fs.writeFileSync(ctxPath, after);
  // Refresh the AI snapshot so the auto-promotion detector treats this edit
  // as the new baseline (it's already protected by @human markers, so this
  // is mostly belt-and-braces).
  writeAiSnapshot(ctxPath, after);

  return NextResponse.json({
    ok: true,
    property_id: propertyId,
    section,
    bytes_before: before.length,
    bytes_after: after.length,
    context_md: after,
  });
}
