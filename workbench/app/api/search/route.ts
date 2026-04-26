import { NextRequest, NextResponse } from "next/server";
import { search } from "@/lib/search";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get("q") ?? "";
  const hits = await search(q);
  return NextResponse.json({ q, hits });
}
