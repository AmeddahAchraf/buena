import { NextResponse } from "next/server";
import { listProperties } from "@/lib/search";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({ properties: await listProperties() });
}
