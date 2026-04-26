// AI-only classifier. Every incoming document is fed to Claude (Opus 4.6)
// alongside (a) the canonical analyst skill prompt at lib/skills/ingest-analyst.md
// and (b) the property's current Context.md as comparison material. The model
// returns a structured verdict that maps directly onto PatchDecision.
//
// Pipeline:
//   1. Cheap relevance gate — short-circuit obvious noise without burning AI.
//   2. AI call: skill prompt as system, Context.md + parsed doc as user.
//   3. Hard guardrail: AI cannot weaken needs_review on sensitive markers
//      (IBAN, owner change, legal, termination).

import fs from "node:fs";
import path from "node:path";
import { getAI } from "./ai-provider";
import { sha256 } from "./hash";
import { propertyOutDir } from "./paths";
import { scoreRelevance, type RelevanceVerdict } from "./relevance";
import {
  getCachedVerdict,
  makeVerdictKey,
  setCachedVerdict,
} from "./verdict-cache";
import type {
  Decision,
  ExtractedFact,
  PatchDecision,
  SectionId,
  SourceDocument,
} from "./types";

// Markers that always demand human review even if the AI tries to soften.
const HARD_REVIEW_MARKERS: { re: RegExp; reason: string }[] = [
  { re: /\bDE\d{2}(?:\s?\d{4}){4,5}\s?\d{1,4}\b/, reason: "Mentions an IBAN." },
  { re: /\biban\s*(änderung|wechsel|change|update)/i, reason: "IBAN change requested." },
  { re: /eigentumswechsel|eigentümer.*wechsel|verkauf|verkauft/i, reason: "Owner change / sale." },
  { re: /kündigung|gekündigt|räumung|raeumung|kuendigung/i, reason: "Termination / eviction." },
  { re: /klage|gericht|rechtsanwalt|anwaltlich|einspruch/i, reason: "Legal proceedings." },
];

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

const VALID_DECISIONS: Decision[] = [
  "durable_fact",
  "operational_memory",
  "temporary_note",
  "ignore",
];

// Lazy-load the skill prompt once. The file is small and stable; reading it
// per-call would be wasteful but keeping it in module scope means a fresh edit
// to the markdown is reflected on the next dev-server reload.
let _skillPrompt: string | null = null;
let _skillHash: string | null = null;
function loadSkillPrompt(): string {
  if (_skillPrompt != null) return _skillPrompt;
  const skillPath = path.join(__dirname, "skills", "ingest-analyst.md");
  try {
    _skillPrompt = fs.readFileSync(skillPath, "utf8");
  } catch {
    // Fallback: minimal inline prompt so the classifier never hard-crashes if
    // the skill file is missing in a packaged build.
    _skillPrompt =
      "You are a property-context curator. For each document, return JSON with fields: decision, target_sections, summary, facts, fact_key, confidence, needs_review, review_reason, adds_new_information, why_not_useful, reasoning. Decisions: durable_fact, operational_memory, temporary_note, ignore.";
  }
  _skillHash = sha256(_skillPrompt).slice(0, 16);
  return _skillPrompt;
}

function skillHash(): string {
  if (_skillHash == null) loadSkillPrompt();
  return _skillHash!;
}

export interface ClassifierInput {
  source: SourceDocument;
  parsedText: string;
  parsedStructured: unknown;
  /** Pre-computed relevance (incremental.ts computes once and reuses). */
  relevance?: RelevanceVerdict;
  /** Number of email followups folded into this primary by the thread collapser. */
  collapsedFollowups?: number;
  /** Extra citations from collapsed thread followups. */
  extraCitations?: string[];
}

export async function classify(input: ClassifierInput): Promise<PatchDecision> {
  const { source, parsedText: textRaw, parsedStructured } = input;
  const text = (textRaw || "").slice(0, 8000);

  // 1. Relevance gate — short-circuit obvious noise.
  const verdict =
    input.relevance ??
    scoreRelevance({
      source,
      parsed: { text, structured: parsedStructured, meta: source.meta },
    });
  if (!verdict.keep) {
    return finishDecision({
      source,
      decision: "ignore",
      target: [],
      summary: "Filtered as noise (low relevance).",
      reasoning: `relevance ${verdict.score.toFixed(2)} < ${verdict.threshold} · noise: ${verdict.noise.join(", ") || "none"}`,
      confidence: 1 - verdict.score,
      needsReview: false,
      reviewReason: null,
      facts: [],
      factKey: null,
      extraCitations: input.extraCitations,
      collapsedFollowups: input.collapsedFollowups,
      relevance: verdict.score,
      usedAI: false,
    });
  }

  // 2. AI-only classification.
  const ai = getAI();
  if (!ai.enabled) {
    return finishDecision({
      source,
      decision: "ignore",
      target: [],
      summary: "AI provider unavailable — document held without classification.",
      reasoning: "no AI key configured",
      confidence: 0.2,
      needsReview: true,
      reviewReason: "AI unavailable — needs manual classification.",
      facts: [],
      factKey: null,
      extraCitations: input.extraCitations,
      collapsedFollowups: input.collapsedFollowups,
      relevance: verdict.score,
      usedAI: false,
    });
  }

  const contextSnapshot = loadContextSnapshot(source.resolved_property_id);

  // Verdict cache: skip the AI call entirely when (content, skill, context)
  // are unchanged. This is the single biggest win on warm rebuilds — the
  // first build pays full freight, every subsequent build is near-free for
  // unchanged files.
  const cacheKey = makeVerdictKey({
    checksum: source.checksum,
    skillHash: skillHash(),
    contextHash: sha256(contextSnapshot).slice(0, 16),
  });
  let aiOut = getCachedVerdict<AIClassifierResponse>(cacheKey);
  if (aiOut == null) {
    aiOut = await aiClassify({ source, text, parsedStructured, contextSnapshot });
    if (aiOut != null) setCachedVerdict(cacheKey, aiOut);
  }
  // A cache hit still represents an AI verdict (just from a prior run), so
  // we keep source="ai" downstream; cache hit/miss counts come from
  // verdictCacheStats(), not from the per-decision provenance.

  if (!aiOut) {
    return finishDecision({
      source,
      decision: "ignore",
      target: [],
      summary: "AI returned no decision — held for review.",
      reasoning: "ai response unparseable",
      confidence: 0.2,
      needsReview: true,
      reviewReason: "AI did not return a usable decision.",
      facts: [],
      factKey: null,
      extraCitations: input.extraCitations,
      collapsedFollowups: input.collapsedFollowups,
      relevance: verdict.score,
      usedAI: true,
    });
  }

  let decision: Decision = sanitizeDecision(aiOut.decision);
  let target: SectionId[] = sanitizeSections(aiOut.target_sections, decision);
  let summary = (aiOut.summary ?? "").trim() || "(no summary)";
  // Guard against models that return facts as null / object / string instead of
  // an array. ?? only catches null/undefined; this catches the rest too.
  let facts = normalizeAIFacts(
    Array.isArray(aiOut.facts) ? aiOut.facts : [],
    target,
  );
  const confidence =
    typeof aiOut.confidence === "number"
      ? Math.max(0, Math.min(1, aiOut.confidence))
      : 0.6;
  let needsReview = Boolean(aiOut.needs_review);
  let reviewReason = aiOut.review_reason ?? null;
  const factKey = aiOut.fact_key ?? null;
  let reasoning = (aiOut.reasoning ?? "ai-classified").trim();

  // 3. Guardrail: hard markers always force needs_review, even if the AI
  // judged the document benign. The skill already instructs this, but a
  // belt-and-braces server-side check guarantees it.
  for (const m of HARD_REVIEW_MARKERS) {
    if (m.re.test(text)) {
      needsReview = true;
      reviewReason = reviewReason ?? m.reason;
      break;
    }
  }

  // If AI judged the document brings no new fact, downgrade to ignore so the
  // queue doesn't fill with "we received this" noise.
  if (
    decision !== "ignore" &&
    facts.length === 0 &&
    aiOut.adds_new_information === false
  ) {
    decision = "ignore";
    target = [];
    summary = aiOut.why_not_useful?.trim() || summary;
    reasoning = `ai: no new info vs current Context.md — ${reasoning}`;
  }

  return finishDecision({
    source,
    decision,
    target,
    summary,
    reasoning,
    confidence,
    needsReview,
    reviewReason,
    facts,
    factKey,
    extraCitations: input.extraCitations,
    collapsedFollowups: input.collapsedFollowups,
    relevance: verdict.score,
    usedAI: true,
  });
}

interface FinishArgs {
  source: SourceDocument;
  decision: Decision;
  target: SectionId[];
  summary: string;
  reasoning: string;
  confidence: number;
  needsReview: boolean;
  reviewReason: string | null;
  facts: ExtractedFact[];
  factKey: string | null;
  extraCitations?: string[];
  collapsedFollowups?: number;
  relevance: number;
  usedAI: boolean;
}

function finishDecision(a: FinishArgs): PatchDecision {
  const citations = [a.source.rel_path, ...(a.extraCitations ?? [])];
  return {
    source_id: a.source.id,
    property_id: a.source.resolved_property_id,
    entity_ids: a.source.entity_refs,
    decision: a.decision,
    target_sections: a.target,
    summary: a.summary || "(no summary)",
    proposed_facts: {},
    facts: a.facts,
    confidence: a.confidence,
    needs_review: a.needsReview,
    review_reason: a.reviewReason,
    expires_at:
      a.decision === "temporary_note"
        ? new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString()
        : null,
    citations,
    reasoning: a.reasoning,
    source: a.usedAI ? "ai" : "rule",
    fact_key: a.factKey,
    relevance: a.relevance,
    collapsed_followups: a.collapsedFollowups ?? 0,
  };
}

function loadContextSnapshot(propertyId: string | null | undefined): string {
  if (!propertyId) return "";
  try {
    const p = path.join(propertyOutDir(propertyId), "Context.md");
    if (!fs.existsSync(p)) return "";
    const raw = fs.readFileSync(p, "utf8");
    const cleaned = raw
      .replace(/<!--[^>]*-->/g, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return cleaned.slice(0, 12000);
  } catch {
    return "";
  }
}

interface AIClassifierResponse {
  decision?: Decision;
  target_sections?: string[];
  summary?: string;
  facts?: Array<{
    key?: string;
    label?: string;
    value?: string | number;
    qualifier?: string;
    section?: string;
  }>;
  confidence?: number;
  needs_review?: boolean;
  review_reason?: string | null;
  reasoning?: string;
  expires_at?: string | null;
  fact_key?: string | null;
  adds_new_information?: boolean;
  why_not_useful?: string;
}

function sanitizeDecision(raw: unknown): Decision {
  if (typeof raw === "string" && (VALID_DECISIONS as string[]).includes(raw)) {
    return raw as Decision;
  }
  return "operational_memory";
}

function sanitizeSections(raw: unknown, decision: Decision): SectionId[] {
  if (decision === "ignore") return [];
  if (!Array.isArray(raw)) return ["recent_changes"];
  const out: SectionId[] = [];
  for (const s of raw) {
    if (typeof s !== "string") continue;
    if ((VALID_SECTIONS as string[]).includes(s)) out.push(s as SectionId);
  }
  return out.length ? out : ["recent_changes"];
}

function normalizeAIFacts(
  raw: NonNullable<AIClassifierResponse["facts"]>,
  defaultTargets: SectionId[],
): ExtractedFact[] {
  const out: ExtractedFact[] = [];
  const fallbackSection = defaultTargets[0] ?? "recent_changes";
  for (const f of raw) {
    if (!f || !f.label || f.value == null) continue;
    const label = String(f.label).trim();
    const value = String(f.value).trim();
    if (!label || !value) continue;
    // Drop facts that are just the source filename echoed back.
    if (/\.(pdf|eml|csv|json|xml)$/i.test(value) && value.length < 60) continue;
    const section: SectionId =
      typeof f.section === "string" &&
      (VALID_SECTIONS as string[]).includes(f.section)
        ? (f.section as SectionId)
        : fallbackSection;
    const key =
      (f.key && String(f.key).trim()) ||
      `ai:${label.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
    out.push({
      key,
      label,
      value,
      qualifier: f.qualifier ? String(f.qualifier) : undefined,
      section,
    });
  }
  return out;
}

async function aiClassify(args: {
  source: SourceDocument;
  text: string;
  parsedStructured: unknown;
  contextSnapshot: string;
}): Promise<AIClassifierResponse | null> {
  const ai = getAI();
  const system = loadSkillPrompt();

  // Order matters for xAI's prefix cache: everything that is *constant across
  // calls* must come first, then per-document variables last. The skill (in
  // the system prompt) and the property's Context.md are the long, stable
  // prefix; the per-doc fields and incoming text are the short, variable
  // suffix. Reordering here gave us cache_read_tokens > 0 on every call after
  // the first, dropping per-call latency by ~2-3x.
  const ctxBlock = args.contextSnapshot
    ? `CURRENT CONTEXT.md (the source of truth — only propose facts that ADD or CHANGE something here):\n"""\n${args.contextSnapshot}\n"""`
    : "(No existing Context.md yet — first ingestion for this property.)";

  const propertyAnchor = args.source.resolved_property_id
    ? `Resolved property: ${args.source.resolved_property_id}`
    : "Resolved property: (none)";

  const structuredPreview = args.parsedStructured
    ? `Parsed structured fields: ${JSON.stringify(args.parsedStructured).slice(0, 1500)}`
    : "Parsed structured fields: (none)";

  const user = `${ctxBlock}

${propertyAnchor}

--- DOCUMENT-SPECIFIC FIELDS BELOW (this is the per-call portion) ---

Source file: ${args.source.rel_path}
Source type: ${args.source.source_type}
Resolved entities: ${args.source.entity_refs.join(", ") || "(none)"}
${structuredPreview}

INCOMING DOCUMENT:
"""
${args.text}
"""

Respond with the JSON object specified by the skill — no prose, no fences.`;

  return await ai.generateJson<AIClassifierResponse>({
    system,
    user,
    label: `${args.source.source_type}:${args.source.rel_path.split("/").pop()}`,
  });
}
