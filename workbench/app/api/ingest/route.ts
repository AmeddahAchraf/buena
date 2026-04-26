import { NextRequest, NextResponse } from "next/server";
import { processIncremental } from "@/lib/incremental";

export const runtime = "nodejs";
export const maxDuration = 300;

// POST /api/ingest
//   { day?: "day-03", autoApply?: boolean, files?: string[], concurrency?: number }
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const r = await processIncremental({
    autoApply: Boolean(body.autoApply),
    onlyNew: body.onlyNew ?? true,
    day: body.day,
    files: body.files,
    concurrency: body.concurrency ?? 8,
  });
  return NextResponse.json(r);
}
