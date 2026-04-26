import { NextRequest, NextResponse } from "next/server";
import { loadPropertyState } from "@/lib/search";

export const runtime = "nodejs";

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const r = await loadPropertyState(params.id);
  if (!r) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(r);
}
