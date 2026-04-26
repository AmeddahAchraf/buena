import { NextResponse } from "next/server";
import { buildAll } from "@/lib/build-all";

export const runtime = "nodejs";

export async function POST() {
  const r = await buildAll();
  return NextResponse.json(r);
}
