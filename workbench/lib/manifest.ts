import fs from "node:fs";
import path from "node:path";
import { CACHE_ROOT, ensureDir } from "./paths";

export interface ManifestEntry {
  rel_path: string;
  checksum: string;
  processed_at: string;
  property_id: string | null;
  decision: string;
  source_id: string;
}

export interface Manifest {
  version: 1;
  entries: Record<string, ManifestEntry>; // keyed by source_id
  last_full_build_at: string | null;
  last_incremental_at: string | null;
  metrics: {
    total_files: number;
    incremental_runs: number;
    avg_incremental_ms: number | null;
    last_incremental_ms: number | null;
  };
}

const manifestPath = () => path.join(CACHE_ROOT, "processed_manifest.json");

export function loadManifest(): Manifest {
  ensureDir(CACHE_ROOT);
  const p = manifestPath();
  if (!fs.existsSync(p)) {
    return {
      version: 1,
      entries: {},
      last_full_build_at: null,
      last_incremental_at: null,
      metrics: {
        total_files: 0,
        incremental_runs: 0,
        avg_incremental_ms: null,
        last_incremental_ms: null,
      },
    };
  }
  return JSON.parse(fs.readFileSync(p, "utf8")) as Manifest;
}

export function saveManifest(m: Manifest) {
  ensureDir(CACHE_ROOT);
  fs.writeFileSync(manifestPath(), JSON.stringify(m, null, 2));
}
