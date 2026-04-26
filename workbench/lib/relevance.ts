// Relevance Gate — a fast, deterministic pre-classifier that decides whether a
// parsed source is even worth showing to the AI. The challenge says ~90% of
// emails are noise; this gate is what lets us *prove* it: every file gets a
// score 0..1 and a list of human-readable signals that drove the score.
//
// The point isn't perfection — it's to skip the irrelevant 70-90% before they
// burn an AI call, while making the decision auditable.

import type { ParsedFile } from "./parsers";
import type { SourceDocument } from "./types";

export interface RelevanceVerdict {
  score: number; // 0..1
  keep: boolean; // score >= threshold
  signals: string[]; // human-readable reasons (positive)
  noise: string[]; // human-readable reasons (negative)
  threshold: number;
}

const NOISE_PATTERNS: Array<{ re: RegExp; weight: number; tag: string }> = [
  { re: /^\s*(danke|vielen dank|merci|thanks|gerne|alles klar|ok|okay|jawohl|verstanden)\b/im, weight: 0.6, tag: "pleasantry" },
  { re: /aus dem büro|out of office|abwesenheit|automatic reply|automatische antwort|urlaub bis|bin im urlaub/i, weight: 0.9, tag: "out-of-office" },
  { re: /newsletter|abmelden|unsubscribe|sich vom newsletter|email-präferenzen/i, weight: 0.9, tag: "newsletter" },
  { re: /^\s*(re:|aw:|fwd:|wg:)\s*$/i, weight: 0.5, tag: "empty-reply" },
  { re: /diese e-?mail enthält vertrauliche|haftungsausschluss|disclaimer|the contents of this email/i, weight: 0.3, tag: "boilerplate" },
  // Read receipts / delivery notifications.
  { re: /eingangsbestätigung|empfangsbestätigung|read receipt|delivery status notification|undeliverable|mail delivery (subsystem|failed)/i, weight: 0.9, tag: "auto-receipt" },
  // Marketing / promotional cues.
  { re: /\b(rabatt|sonderangebot|aktion|gutschein|jetzt sparen|exklusiv für sie|black friday)\b/i, weight: 0.7, tag: "promo" },
  // Calendar / meeting noise.
  { re: /terminbestätigung|meeting accepted|kalender(einladung|eintrag)|outlook-termin/i, weight: 0.5, tag: "calendar" },
];

const SIGNAL_PATTERNS: Array<{ re: RegExp; weight: number; tag: string }> = [
  { re: /\bIBAN\b|\bBIC\b|bankverbindung|kontonummer/i, weight: 0.6, tag: "payment-detail" },
  { re: /eigentumswechsel|verkauf|verkauft|kaufvertrag/i, weight: 0.7, tag: "ownership-change" },
  { re: /kündigung|gekündigt|kuendigung|räumung|raeumung/i, weight: 0.7, tag: "termination" },
  { re: /sonderumlage|hausgeld|nebenkosten|abrechnung/i, weight: 0.5, tag: "finance-event" },
  { re: /klage|anwalt|gericht|einspruch|mahnung/i, weight: 0.7, tag: "legal" },
  { re: /reparatur|defekt|kaputt|leck|wasserschaden|heizung|aufzug|fahrstuhl/i, weight: 0.5, tag: "maintenance" },
  { re: /eigentümerversammlung|versammlung|beschluss/i, weight: 0.6, tag: "governance" },
  { re: /\d{1,3}(?:[.,]\d{3})*[.,]\d{2}\s*(€|EUR)/, weight: 0.4, tag: "amount" },
  { re: /\bRechnung\b|\binvoice\b/i, weight: 0.4, tag: "invoice-mention" },
  { re: /\bWE\s?\d{2}\b/i, weight: 0.3, tag: "unit-ref" },
];

export interface RelevanceInput {
  source: SourceDocument;
  parsed: ParsedFile;
}

const DEFAULT_THRESHOLD = 0.35;

export function scoreRelevance(input: RelevanceInput): RelevanceVerdict {
  const { source, parsed } = input;
  const text = (parsed.text || "").slice(0, 6000);
  const signals: string[] = [];
  const noise: string[] = [];
  let score = 0;

  // Hard keeps — anything with structured data and bound entities is in by default.
  if (source.source_type === "stammdaten") {
    return { score: 1, keep: true, signals: ["stammdaten"], noise: [], threshold: DEFAULT_THRESHOLD };
  }
  if (source.source_type === "invoice") {
    return { score: 1, keep: true, signals: ["invoice-document"], noise: [], threshold: DEFAULT_THRESHOLD };
  }
  if (source.source_type === "bank") {
    return { score: 1, keep: true, signals: ["bank-statement"], noise: [], threshold: DEFAULT_THRESHOLD };
  }

  // Entity binding only — being bound to an entity is mildly positive but
  // NOT enough on its own. Previously a +0.25 baseline for resolved property
  // pushed every doc past the threshold in single-property datasets, so the
  // gate effectively did nothing. Now we require *content* signal too.
  if (source.entity_refs.length > 0) {
    score += Math.min(0.2, 0.06 * source.entity_refs.length);
    signals.push(`linked:${source.entity_refs.length}`);
  }

  // Content signals — these are the load-bearing positive evidence.
  for (const p of SIGNAL_PATTERNS) {
    if (p.re.test(text)) {
      score += p.weight;
      signals.push(p.tag);
    }
  }
  // Noise signals subtract
  for (const p of NOISE_PATTERNS) {
    if (p.re.test(text)) {
      score -= p.weight;
      noise.push(p.tag);
    }
  }

  // Length sanity: tiny emails with no signals are almost always noise.
  const trimmedLen = text.trim().length;
  if (trimmedLen < 200 && signals.length === 0) {
    score -= 0.5;
    noise.push("very-short");
  } else if (trimmedLen < 500 && signals.length === 0) {
    score -= 0.25;
    noise.push("short-no-signal");
  }
  // Massive form letter without entity binding = newsletter-class
  if (text.length > 4000 && !source.resolved_property_id && signals.length <= 1) {
    score -= 0.3;
    noise.push("long-unbound");
  }
  // Hard gate: if any auto-receipt / OOO / newsletter cue fires AND no
  // strong signal is present, this is unambiguous noise.
  const hasStrongSignal = signals.some(
    (s) =>
      s === "payment-detail" ||
      s === "ownership-change" ||
      s === "termination" ||
      s === "legal" ||
      s === "governance",
  );
  if (
    !hasStrongSignal &&
    (noise.includes("out-of-office") ||
      noise.includes("auto-receipt") ||
      noise.includes("newsletter") ||
      noise.includes("promo"))
  ) {
    score = Math.min(score, 0.1);
  }

  // Clamp 0..1
  score = Math.max(0, Math.min(1, score));

  return {
    score,
    keep: score >= DEFAULT_THRESHOLD,
    signals,
    noise,
    threshold: DEFAULT_THRESHOLD,
  };
}
