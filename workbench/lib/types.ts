// Core data model for the Property Context Workbench.
// Kept intentionally lightweight: nothing escapes the filesystem.

export type EntityType =
  | "property"
  | "building"
  | "unit"
  | "owner"
  | "tenant"
  | "vendor"
  | "invoice"
  | "bank_account"
  | "transaction"
  | "verwalter";

export interface Property {
  id: string; // e.g. LIE-001
  name: string;
  address: string;
  metadata: Record<string, unknown>;
}

export interface Entity {
  id: string;
  type: EntityType;
  property_id: string | null;
  canonical_name: string;
  aliases: string[];
  metadata: Record<string, unknown>;
}

export type SourceType =
  | "stammdaten"
  | "email"
  | "invoice"
  | "bank"
  | "letter"
  | "incremental"
  | "structured";

export interface SourceDocument {
  id: string; // stable id derived from path
  file_path: string; // absolute path
  rel_path: string; // relative to DATASET_ROOT
  source_type: SourceType;
  bucket: "base" | "incremental";
  checksum: string;
  parsed_text: string;
  parsed_structured_data?: unknown;
  property_candidates: string[];
  resolved_property_id: string | null;
  entity_refs: string[];
  meta: Record<string, unknown>;
}

export type Decision =
  | "durable_fact"
  | "operational_memory"
  | "temporary_note"
  | "ignore";

export type SectionId =
  | "identity"
  | "units_and_occupants"
  | "open_issues"
  | "governance_and_owner_matters"
  | "vendors_and_service_references"
  | "finance_and_open_items"
  | "recent_changes"
  | "conflicts_and_needs_review"
  | "source_index";

export interface PatchDecision {
  source_id: string;
  property_id: string | null;
  entity_ids: string[];
  decision: Decision;
  target_sections: SectionId[];
  summary: string;
  proposed_facts: Record<string, unknown>;
  /** Structured facts to write into Context.md as labeled bullets.
   *  Each entry becomes "- **{label}:** {value} _(src: file)_".
   *  When this is empty the patcher falls back to writing summary as a single bullet. */
  facts?: ExtractedFact[];
  confidence: number; // 0..1
  needs_review: boolean;
  review_reason: string | null;
  expires_at: string | null;
  citations: string[];
  reasoning: string;
  source: "rule" | "ai" | "hybrid";
  /** Stable key identifying *what* this fact is about. Two patches with the
   *  same fact_key are versions of the same fact — newer versions supersede
   *  older ones surgically rather than appending duplicate bullets. */
  fact_key?: string | null;
  /** Relevance score 0..1 from the pre-classifier gate. */
  relevance?: number;
  /** Number of email followups that were folded into this decision. */
  collapsed_followups?: number;
}

export interface ExtractedFact {
  /** Stable per-fact key so future updates can supersede this exact line. */
  key: string;
  /** Human-readable label, e.g. "Reserve account IBAN", "Hausgeld balance Q1 2026". */
  label: string;
  /** The actual value, e.g. "DE12 1234 …", "−1.088,85 €", "Open". */
  value: string;
  /** Optional context modifier, e.g. "as of 2026-04-25" or "claim by EIG-028". */
  qualifier?: string;
  /** Section this fact belongs to. */
  section: SectionId;
}

export interface PatchRecord {
  property_id: string;
  fact_key?: string | null;
  superseded_source_ids?: string[];
  conflict?: boolean;
  applied_at: string;
  source_id: string;
  target_sections: SectionId[];
  before_hash: string;
  after_hash: string;
  diff: string;
  decision: Decision;
  summary: string;
}

export interface BuildMetrics {
  total_files: number;
  resolved_files: number;
  unresolved_files: number;
  properties_compiled: number;
  pending_review: number;
  last_build_at: string | null;
  avg_incremental_ms: number | null;
}
