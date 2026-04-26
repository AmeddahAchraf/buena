import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { listIncrementalDays, scanIncremental } from "@/lib/scanner";
import { loadManifest } from "@/lib/manifest";
import { fileSha256, shortId } from "@/lib/hash";
import { relFromDataset } from "@/lib/paths";

export const runtime = "nodejs";

// Returns the list of available incremental days, with their per-day stats
// AND a quick "ingested?" probe that compares each file's checksum to the
// manifest. The UI uses this to mark days as ingested / partial / fresh.
export async function GET() {
  const days = listIncrementalDays();
  const manifest = loadManifest();

  const annotated = days.map((d) => {
    const files = scanIncremental(d.day);
    let ingested = 0;
    for (const f of files) {
      try {
        const checksum = fileSha256(f.abs);
        const id = shortId("INC", relFromDataset(f.abs) + checksum);
        const seen = manifest.entries[id];
        if (seen && seen.checksum === checksum) ingested++;
      } catch {}
    }
    return {
      ...d,
      ingested_count: ingested,
      status:
        ingested === 0
          ? "fresh"
          : ingested >= d.total_files
            ? "ingested"
            : "partial",
    };
  });

  return NextResponse.json({ days: annotated });
}
