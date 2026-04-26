import { processIncremental } from "../lib/incremental";

const args = process.argv.slice(2);
const autoApply = args.includes("--auto");
const dayArg = args.find((a) => a.startsWith("--day="));
const day = dayArg ? dayArg.split("=")[1] : undefined;

(async () => {
  const r = await processIncremental({ autoApply, onlyNew: true, day });
  console.log(
    JSON.stringify(
      {
        scanned: r.scanned,
        processed: r.processed,
        skipped: r.skipped,
        ai_used: r.ai_used,
        ms: r.ms,
        pending: r.pending.map((p) => ({
          file: p.source.rel_path,
          property: p.decision.property_id,
          decision: p.decision.decision,
          targets: p.decision.target_sections,
          confidence: p.decision.confidence,
          needs_review: p.decision.needs_review,
          summary: p.decision.summary,
          applied: p.alreadyApplied,
        })),
      },
      null,
      2,
    ),
  );
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
