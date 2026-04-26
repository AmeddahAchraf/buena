// AI compose pass for Context.md. After build-all renders the deterministic
// skeleton (identity bullets, unit roster, vendor list, etc.) from stammdaten,
// this module asks Claude (Opus 4.6) to add a short narrative *intro* at the
// top of each major section — turning the file from a sterile bullet dump
// into something a property manager actually wants to read.
//
// We never replace the deterministic bullets — they are ground truth. The AI
// only adds 1-3 sentence prose intros that contextualise what follows. This
// keeps the file richer without risking hallucinated facts displacing real
// ones, and it preserves the section markers that the patcher relies on.

import fs from "node:fs";
import path from "node:path";
import { getAI } from "./ai-provider";
import { readSection, replaceSection } from "./context-schema";
import type { MasterIndex } from "./index-store";
import { propertyOutDir } from "./paths";
import type { Property, SectionId, SourceDocument } from "./types";

interface ComposeIntros {
  identity_intro?: string;
  units_intro?: string;
  governance_intro?: string;
  vendors_intro?: string;
  finance_intro?: string;
  observations?: string;
}

const SECTION_FOR_INTRO: Record<keyof ComposeIntros, SectionId> = {
  identity_intro: "identity",
  units_intro: "units_and_occupants",
  governance_intro: "governance_and_owner_matters",
  vendors_intro: "vendors_and_service_references",
  finance_intro: "finance_and_open_items",
  observations: "recent_changes",
};

export async function composePropertyContext(args: {
  property: Property;
  index: MasterIndex;
  sources: SourceDocument[];
}): Promise<{ applied: boolean; ms: number; reason?: string }> {
  const t0 = Date.now();
  const ai = getAI();
  if (!ai.enabled) {
    return { applied: false, ms: 0, reason: "ai disabled" };
  }

  const ctxPath = path.join(propertyOutDir(args.property.id), "Context.md");
  if (!fs.existsSync(ctxPath)) {
    return { applied: false, ms: 0, reason: "no Context.md" };
  }

  const intros = await callComposer(args);
  if (!intros) {
    return {
      applied: false,
      ms: Date.now() - t0,
      reason: "ai returned no intros",
    };
  }

  let doc = fs.readFileSync(ctxPath, "utf8");
  let touched = 0;
  for (const [k, sectionId] of Object.entries(SECTION_FOR_INTRO) as Array<
    [keyof ComposeIntros, SectionId]
  >) {
    const intro = (intros[k] ?? "").trim();
    if (!intro) continue;
    const current = readSection(doc, sectionId) ?? "";
    // Avoid duplicating the intro on re-runs: if the existing body already
    // starts with this exact paragraph, skip.
    if (current.startsWith(intro)) continue;
    // Strip any prior auto-intro paragraph (we mark them with a zero-width
    // tag so re-runs replace cleanly without touching deterministic bullets).
    const TAG = "<!-- ai-intro -->";
    const ENDTAG = "<!-- /ai-intro -->";
    const stripped = current.replace(
      new RegExp(`${TAG}[\\s\\S]*?${ENDTAG}\\s*\\n?`),
      "",
    );
    const newBody = `${TAG}\n${intro}\n${ENDTAG}\n\n${stripped}`.trim();
    doc = replaceSection(doc, sectionId, newBody);
    touched++;
  }

  if (touched > 0) {
    fs.writeFileSync(ctxPath, doc);
  }

  return { applied: touched > 0, ms: Date.now() - t0 };
}

async function callComposer(args: {
  property: Property;
  index: MasterIndex;
  sources: SourceDocument[];
}): Promise<ComposeIntros | null> {
  const ai = getAI();

  // Compact evidence: per-source one-liner with type + filename + first 200 chars
  // of parsed text. Cap the bundle size so we don't blow the context window.
  const evidence = args.sources
    .slice(0, 60)
    .map((s) => {
      const fname = s.rel_path.split("/").pop() ?? s.rel_path;
      const preview = (s.parsed_text || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 220);
      return `- [${s.source_type}] ${fname} — ${preview}`;
    })
    .join("\n");

  const units = args.index.entities.filter(
    (e) => e.type === "unit" && e.property_id === args.property.id,
  );
  const tenants = args.index.entities.filter(
    (e) => e.type === "tenant" && e.property_id === args.property.id,
  );
  const owners = args.index.entities.filter(
    (e) => e.type === "owner" && e.property_id === args.property.id,
  );
  const vendors = args.index.entities.filter(
    (e) => e.type === "vendor" && e.property_id === args.property.id,
  );

  const meta = args.property.metadata as Record<string, string | number>;

  const system = `You compose narrative intros for a German residential property's living Context.md file. The Context.md already has deterministic bullets (master data, unit roster, owners, vendors, IBANs) — your job is to add ONE short paragraph (2-3 sentences max) at the top of each major section that gives a human-readable feel for the property: its character, scale, ownership structure, governance tone, financial posture, and salient open matters.

Write in calm, factual German-aware English. No fluff, no marketing language, no emojis. Be concrete: name the building, the year, the unit count, the verwalter, the salient facts. Where evidence is thin, write less — never invent.

Return strict JSON only. Schema:
{
  "identity_intro": "2-3 sentences introducing the property, its address, the verwalter, the building type and age.",
  "units_intro": "2-3 sentences describing the unit composition (count, occupied vs vacant if known, dominant tenant/owner pattern).",
  "governance_intro": "2-3 sentences on the WEG governance posture: assemblies on file, beirat, owner dynamics if visible from sources.",
  "vendors_intro": "2-3 sentences on the vendor landscape: who handles what, repeat providers, anything notable.",
  "finance_intro": "2-3 sentences on the financial posture: account structure (operating + reserve), any visible balances or open matters from base sources.",
  "observations": "1-2 sentences flagging anything else a property manager should know on first read."
}

Each field is OPTIONAL — omit a field entirely (don't return empty string) when there is no honest substance to write. Never repeat the deterministic bullets verbatim.

Return ONLY the JSON object. First character: "{". Last character: "}".`;

  const user = `Property: ${args.property.name} (${args.property.id})
Address: ${args.property.address}
Verwalter: ${meta.verwalter ?? "(unknown)"} (${meta.verwalter_email ?? ""})
Baujahr: ${meta.baujahr ?? "(unknown)"}${meta.sanierung ? `, Sanierung ${meta.sanierung}` : ""}
WEG-Konto: ${meta.weg_bankkonto_iban ?? "(unknown)"} (${meta.weg_bankkonto_bank ?? ""})
Rücklage: ${meta.ruecklage_iban ?? "(unknown)"}

Counts: ${units.length} units · ${owners.length} owners · ${tenants.length} tenants on file · ${vendors.length} vendors known.

Base sources for this property (${args.sources.length} total, showing up to 60):
${evidence || "(none)"}

Compose the intros per the schema. Be concise. Do not duplicate bullets that will appear below your intros.`;

  return await ai.generateJson<ComposeIntros>({
    system,
    user,
    label: `compose:${args.property.id}`,
    maxTokens: 3000,
  });
}
