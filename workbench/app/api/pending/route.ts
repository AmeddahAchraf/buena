import { NextResponse } from "next/server";
import { loadPending } from "@/lib/pending-store";
import { loadManifest } from "@/lib/manifest";
import { getAI } from "@/lib/ai-provider";

export const runtime = "nodejs";

export async function GET() {
  const pending = loadPending();
  const manifest = loadManifest();
  const ai = getAI().stats();
  return NextResponse.json({
    items: pending.items,
    metrics: {
      total_files: manifest.metrics.total_files,
      avg_incremental_ms: manifest.metrics.avg_incremental_ms,
      last_incremental_ms: manifest.metrics.last_incremental_ms,
      last_full_build_at: manifest.last_full_build_at,
      last_incremental_at: manifest.last_incremental_at,
      pending_count: pending.items.length,
      pending_review_count: pending.items.filter((i) => i.decision.needs_review).length,
      unresolved_count: pending.items.filter((i) => !i.decision.property_id).length,
    },
    ai,
  });
}
