import fs from "node:fs";
import path from "node:path";
import { classify } from "./classifier";
import { pMap } from "./concurrency";
import { fileSha256, shortId } from "./hash";
import { loadIndex } from "./index-store";
import { loadManifest, saveManifest } from "./manifest";
import { mergePending } from "./pending-store";
import { propertyOutDir, relFromDataset } from "./paths";
import { parseFile } from "./parsers";
import { applyPatch, previewPatch } from "./patcher";
import { inferSourceType, resolveSource } from "./resolver";
import { scanIncremental, type ScannedFile } from "./scanner";
import { collapseEmailThreads } from "./threads";
import { scoreRelevance } from "./relevance";
import type { PatchDecision, SourceDocument } from "./types";

export interface PendingUpdate {
  source: SourceDocument;
  decision: PatchDecision;
  diff_preview: string; // unified diff, truncated
  before: string;
  after: string;
  parsedTextPreview: string;
  alreadyApplied: boolean;
}

export interface ProcessIncrementalOptions {
  autoApply?: boolean;
  onlyNew?: boolean;
  day?: string; // restrict to a specific day-XX folder
  files?: string[]; // explicit file paths (absolute or relative to DATASET_ROOT)
  concurrency?: number;
}

export interface ProcessIncrementalResult {
  pending: PendingUpdate[];
  ms: number;
  processed: number;
  ai_used: number;
  scanned: number;
  skipped: number;
  /** Email followups folded into a primary thread message. */
  collapsed_threads: number;
  /** Files filtered as noise by the relevance gate before classification. */
  filtered_noise: number;
  /** Patches that superseded an existing fact (same fact_key). */
  superseded: number;
}

export async function processIncremental(
  opts: ProcessIncrementalOptions = {},
): Promise<ProcessIncrementalResult> {
  const t0 = Date.now();
  const onlyNew = opts.onlyNew ?? true;
  const autoApply = opts.autoApply ?? false;
  const concurrency = opts.concurrency ?? 8;

  await loadIndex();
  const manifest = loadManifest();

  let files: ScannedFile[];
  if (opts.files && opts.files.length) {
    files = opts.files.map((f) => {
      const abs = path.isAbsolute(f) ? f : path.resolve(process.cwd(), f);
      return {
        abs,
        rel: relFromDataset(abs),
        bucket: "incremental" as const,
        bucketSubfolder: "explicit",
      };
    });
  } else {
    files = scanIncremental(opts.day);
  }

  // STEP A — Thread collapsing. Email .eml files in a thread (Re:/AW:/Fwd:)
  // share the same normalized subject + participants; the latest message is
  // elected as the *primary* and earlier messages become silent followups
  // attached to its citations. Without this, a 10-message thread produces
  // 10 near-identical patches.
  const collapse = collapseEmailThreads(files);
  files = collapse.primaries;
  if (collapse.collapsedCount > 0) {
    console.log(
      `[ingest] thread-collapse · ${collapse.collapsedCount} email(s) folded into ${collapse.clusters.filter((c) => c.followups.length > 0).length} thread(s)`,
    );
  }

  console.log(
    `[ingest] starting · ${files.length} file(s)${opts.day ? ` from ${opts.day}` : ""} · concurrency=${concurrency} · collapsed=${collapse.collapsedCount}`,
  );

  let processed = 0;
  let skipped = 0;
  let filteredNoise = 0;
  let superseded = 0;
  const aiBefore = (await import("./ai-provider")).getAI().stats().success;

  const items = await pMap(
    files,
    async (f) => {
      try {
        const parsed = await parseFile(f.abs);
        const checksum = fileSha256(f.abs);
        const sourceId = shortId("INC", f.rel + checksum);
        const seen = manifest.entries[sourceId];
        if (
          onlyNew &&
          seen &&
          seen.checksum === checksum &&
          seen.decision !== "pending"
        ) {
          skipped++;
          return null;
        }

        const res = await resolveSource(f.abs, parsed);
        const sourceDoc: SourceDocument = {
          id: sourceId,
          file_path: f.abs,
          rel_path: relFromDataset(f.abs),
          source_type: inferSourceType(f.abs),
          bucket: "incremental",
          checksum,
          parsed_text: parsed.text.slice(0, 10000),
          parsed_structured_data: parsed.structured,
          property_candidates: res.candidates,
          resolved_property_id: res.property_id,
          entity_refs: res.entity_refs,
          meta: { ...parsed.meta, resolution_reason: res.reason },
        };

        // Compute relevance once and pass to the classifier so it doesn't
        // repeat the work. Collect collapsed thread followups as citations.
        const relevance = scoreRelevance({ source: sourceDoc, parsed });
        const followups = collapse.followupByPrimary.get(f.abs) ?? [];
        const extraCitations = followups.map((x) => x.rel);

        const decision = await classify({
          source: sourceDoc,
          parsedText: parsed.text,
          parsedStructured: parsed.structured,
          relevance,
          extraCitations,
          collapsedFollowups: followups.length,
        });

        if (decision.decision === "ignore") {
          // Track noise for the metrics card; record manifest entries for the
          // followups too so they don't reappear next run.
          if (relevance && relevance.score < relevance.threshold) {
            filteredNoise++;
          }
          for (const fu of followups) {
            const fuId = shortId("INC", fu.rel + fileSha256(fu.abs));
            manifest.entries[fuId] = {
              rel_path: fu.rel,
              checksum: fileSha256(fu.abs),
              processed_at: new Date().toISOString(),
              property_id: decision.property_id,
              decision: "thread-followup",
              source_id: fuId,
            };
          }
        }

        processed++;

        let diffPreview = "";
        let before = "";
        let after = "";
        let alreadyApplied = false;

        if (
          decision.property_id &&
          decision.decision !== "ignore" &&
          decision.target_sections.length
        ) {
          const ctxPath = path.join(
            propertyOutDir(decision.property_id),
            "Context.md",
          );
          const preview = previewPatch({ contextMdPath: ctxPath, decision });
          before = preview.before;
          after = preview.after;
          diffPreview = preview.diff.slice(0, 4000);
          if (preview.conflict) superseded++;

          if (
            autoApply &&
            !decision.needs_review &&
            decision.confidence >= 0.7 &&
            decision.decision !== "temporary_note"
          ) {
            applyPatch({
              propertyId: decision.property_id,
              contextMdPath: ctxPath,
              decision,
            });
            alreadyApplied = true;
          }
        }

        manifest.entries[sourceId] = {
          rel_path: sourceDoc.rel_path,
          checksum,
          processed_at: new Date().toISOString(),
          property_id: decision.property_id,
          decision: alreadyApplied ? decision.decision : "pending",
          source_id: sourceId,
        };

        if (decision.property_id) {
          const dir = propertyOutDir(decision.property_id);
          fs.appendFileSync(
            path.join(dir, "sources.jsonl"),
            JSON.stringify({
              ...stripParsedText(sourceDoc),
              classification_summary: decision.summary,
              classification_decision: decision.decision,
              classification_target_sections: decision.target_sections,
            }) + "\n",
          );
        }

        const pending: PendingUpdate = {
          source: sourceDoc,
          decision,
          diff_preview: diffPreview,
          before,
          after,
          parsedTextPreview: parsed.text.slice(0, 1500),
          alreadyApplied,
        };
        return pending;
      } catch (err) {
        console.warn("[incremental] failed", f.rel, (err as Error).message);
        return null;
      }
    },
    concurrency,
  );

  const pending = items.filter((x): x is PendingUpdate => x !== null);
  mergePending(pending.filter((p) => !p.alreadyApplied));

  const ms = Date.now() - t0;
  manifest.last_incremental_at = new Date().toISOString();
  manifest.metrics.incremental_runs += 1;
  manifest.metrics.last_incremental_ms =
    processed > 0 ? Math.round(ms / Math.max(processed, 1)) : null;
  if (manifest.metrics.last_incremental_ms != null) {
    const prev = manifest.metrics.avg_incremental_ms;
    manifest.metrics.avg_incremental_ms =
      prev == null
        ? manifest.metrics.last_incremental_ms
        : Math.round((prev + manifest.metrics.last_incremental_ms) / 2);
  }
  saveManifest(manifest);

  const ai_used =
    (await import("./ai-provider")).getAI().stats().success - aiBefore;
  console.log(
    `[ingest] done · ${processed} processed · ${skipped} skipped · ${ai_used} ai calls · ${ms}ms`,
  );

  return {
    pending,
    ms,
    processed,
    ai_used,
    scanned: files.length,
    skipped,
    collapsed_threads: collapse.collapsedCount,
    filtered_noise: filteredNoise,
    superseded,
  };
}

function stripParsedText(d: SourceDocument) {
  const { parsed_text, parsed_structured_data, ...rest } = d;
  return {
    ...rest,
    parsed_preview: parsed_text.slice(0, 400),
    has_structured: Boolean(parsed_structured_data),
  };
}
