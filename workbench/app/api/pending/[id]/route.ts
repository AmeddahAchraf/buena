import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { findPending, removePending, loadPending, savePending } from "@/lib/pending-store";
import { applyPatch } from "@/lib/patcher";
import { propertyOutDir } from "@/lib/paths";

export const runtime = "nodejs";

// POST /api/pending/<source_id>?action=apply|reject|temporary
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const action = req.nextUrl.searchParams.get("action") ?? "apply";
  const item = findPending(params.id);
  if (!item) return NextResponse.json({ error: "pending not found" }, { status: 404 });

  if (action === "reject") {
    removePending(params.id);
    return NextResponse.json({ ok: true, action: "reject" });
  }

  if (action === "temporary") {
    // Coerce decision to temporary_note and update the existing item.
    const all = loadPending();
    for (const it of all.items) {
      if (it.source.id === params.id) {
        it.decision.decision = "temporary_note";
        it.decision.target_sections = ["open_issues"];
        it.decision.expires_at = new Date(Date.now() + 7 * 86400_000).toISOString();
      }
    }
    savePending(all.items);
    return NextResponse.json({ ok: true, action: "temporary" });
  }

  if (action === "apply") {
    if (!item.decision.property_id) {
      return NextResponse.json(
        { error: "no resolved property — cannot apply" },
        { status: 400 },
      );
    }
    if (item.decision.decision === "ignore" || item.decision.target_sections.length === 0) {
      removePending(params.id);
      return NextResponse.json({ ok: true, action: "skipped (ignore)" });
    }
    const ctxPath = path.join(propertyOutDir(item.decision.property_id), "Context.md");
    const result = applyPatch({
      propertyId: item.decision.property_id,
      contextMdPath: ctxPath,
      decision: item.decision,
    });
    removePending(params.id);
    return NextResponse.json({ ok: true, action: "apply", record: result.record });
  }

  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}
